import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { FLASH_SYSTEM_PROMPT } from "./flashPrompt.js";
import type { MarketOverview } from "./marketOverview.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { PreviousCall } from "./scanners.js";
import type { AlertHistoryEntry } from "./state.js";
import type { Candidate } from "./types.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface DiscoveryFunnel {
  rawCount: number;
  floorSurvivorCount: number;
  shortlistCount: number;
  deepAnalyzeCount: number;
}

function buildUserMessage(
  candidates: Candidate[],
  recentHistory: AlertHistoryEntry[],
  historyLabel: string,
  context?: { funnel: DiscoveryFunnel; marketOverview: MarketOverview; previousCalls?: PreviousCall[] }
): string {
  const payload = candidates.map((c) => ({
    symbol: c.symbol,
    tokenAddress: c.tokenAddress,
    poolAddress: c.poolAddress,
    dexUrl: c.dexUrl,
    previouslyCalled: c.tracked === true,
    ageHours: c.ageHours !== null ? Number(c.ageHours.toFixed(1)) : null,
    marketCapUsd: Math.round(c.marketCapUsd),
    // null = the data source didn't report liquidity (common for pump.fun pools), NOT an
    // empty pool — the tradeability quote below is the real signal in that case.
    liquidityUsd: c.liquidityUnknown ? null : Math.round(c.liquidityUsd),
    volume24hUsd: Math.round(c.volume24hUsd),
    volumeH1Usd: Math.round(c.volumeH1Usd),
    volumeH6Usd: Math.round(c.volumeH6Usd),
    priceChangeM5: c.priceChangeM5,
    priceChangeH1: c.priceChangeH1,
    priceChangeH6: c.priceChangeH6,
    priceChangeH24: c.priceChangeH24,
    txnsH1: c.txnsH1,
    txnsH6: c.txnsH6,
    holderCount: c.holderCount ?? null,
    organicScore: c.organicScore != null ? Math.round(c.organicScore) : null,
    chartStructureRank: c.chartRank ? `#${c.chartRank.rank} of ${c.chartRank.of}` : null,
    marketQualityRank: c.qualityRank ? `#${c.qualityRank.rank} of ${c.qualityRank.of}` : null,
    candles: c.candles,
    tradeability: c.tradeability
      ? { priceImpactPctFor0_5Sol: Number(c.tradeability.priceImpactPct.toFixed(2)), routeHops: c.tradeability.hops }
      : null,
    rugCheck: c.rugCheck
      ? {
          creatorBalance: c.rugCheck.creatorBalance,
          riskScoreNormalised: c.rugCheck.score_normalised,
          lpLockedPct: c.rugCheck.lpLockedPct ?? null,
          risks: c.rugCheck.risks.map((r) => ({ name: r.name, level: r.level })),
          mintAuthority: c.rugCheck.token.mintAuthority,
          freezeAuthority: c.rugCheck.token.freezeAuthority,
          topHolders: c.rugCheck.topHolders.slice(0, 10).map((h) => ({ pct: h.pct, insider: h.insider })),
        }
      : null,
  }));

  const historyPayload = recentHistory.map((h) => ({
    symbol: h.symbol,
    tokenAddress: h.tokenAddress,
    verdict: h.verdict,
    hoursAgo: Number(((Date.now() - h.alertedAt) / (1000 * 60 * 60)).toFixed(1)),
    mcAtAlertUsd: h.marketCapUsdAtAlert !== undefined ? Math.round(h.marketCapUsdAtAlert) : null,
  }));

  const parts: string[] = [
    // Claude has no clock — without this the report header gets a confidently invented time.
    `Current UTC time: ${new Date().toISOString().slice(11, 16)} UTC`,
  ];

  if (context) {
    parts.push(
      `Discovery funnel: rawCount=${context.funnel.rawCount}, floorSurvivorCount=${context.funnel.floorSurvivorCount}, shortlistCount=${context.funnel.shortlistCount}, deepAnalyzeCount=${context.funnel.deepAnalyzeCount}`,
      `Market overview: ${JSON.stringify(context.marketOverview)}`,
      ""
    );
    if (context.previousCalls && context.previousCalls.length > 0) {
      parts.push(
        `Previous calls being followed (for the PREVIOUS CALLS UPDATE section — real recorded data, cite it rather than recomputing):`,
        JSON.stringify(context.previousCalls, null, 2),
        ""
      );
    }
  }

  parts.push(
    `Candidates (${candidates.length}):`,
    JSON.stringify(payload, null, 2),
    "",
    `${historyLabel} (${historyPayload.length}):`,
    JSON.stringify(historyPayload, null, 2)
  );

  return parts.join("\n");
}

export interface WatchCondition {
  symbol: string;
  tokenAddress: string;
  poolAddress: string;
  condition: { mcMin: number | null; mcMax: number | null; requireRisingVolume: boolean; description: string };
  validUntilHours: number;
}

export interface TradePlan {
  symbol: string;
  tokenAddress: string;
  poolAddress: string;
  tier: "RECOMMENDATION" | "SPECULATIVE PUNT" | "WATCH" | "FLASH";
  entrySnapshot: { priceUsd: number; marketCapUsd: number; liquidityUsd: number };
  entryCondition: {
    type: "IMMEDIATE" | "PULLBACK" | "BREAKOUT" | "RECLAIM";
    triggerPrice: number | null;
    description: string;
    validityWindowMinutes: number;
  };
  structuralInvalidation: { price: number; description: string };
  targets: { label: "TP1" | "TP2"; price: number; note: string }[];
  thesis: string;
}

export interface AnalysisResult {
  report: string;
  verdicts: { symbol: string; tokenAddress: string; poolAddress: string; verdict: string }[];
  watchConditions: WatchCondition[];
  tradePlans: TradePlan[];
  /** Set when the response was truncated or its data markers were missing — the report
   *  text may still be fine to send, but the structured outputs are unreliable/lost. */
  parseWarning: string | null;
}

async function runAnalysis(
  systemPrompt: string,
  candidates: Candidate[],
  recentHistory: AlertHistoryEntry[],
  historyLabel: string,
  effort: "medium" | "high",
  context?: { funnel: DiscoveryFunnel; marketOverview: MarketOverview; previousCalls?: PreviousCall[] }
): Promise<AnalysisResult> {
  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    // 16k, not 8k: a full 10-candidate batch produces the prose report PLUS three
    // trailing JSON blocks, and those blocks come LAST — at 8k two consecutive live
    // runs truncated mid-report, silently losing every verdict/watch-condition/trade
    // plan and mangling the report structure the user sees.
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort },
    system: systemPrompt,
    messages: [{ role: "user", content: buildUserMessage(candidates, recentHistory, historyLabel, context) }],
  });

  const finalMessage = await stream.finalMessage();
  const truncated = finalMessage.stop_reason === "max_tokens";
  if (truncated) {
    console.warn("Analysis hit max_tokens — trailing data blocks are likely truncated.");
  }
  const textBlock = finalMessage.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const fullText = textBlock?.text ?? "";

  const dataMarker = "---DATA---";
  const watchlistMarker = "---WATCHLIST---";
  const tradePlanMarker = "---TRADEPLAN---";

  const dataMarkerIndex = fullText.indexOf(dataMarker);
  if (dataMarkerIndex === -1) {
    return {
      report: fullText.trim(),
      verdicts: [],
      watchConditions: [],
      tradePlans: [],
      parseWarning: truncated
        ? "response truncated at max_tokens before the data blocks — verdicts/watch conditions/trade plans lost this run"
        : "---DATA--- marker missing from the response — verdicts/watch conditions/trade plans lost this run",
    };
  }

  const report = fullText.slice(0, dataMarkerIndex).trim();
  const afterData = fullText.slice(dataMarkerIndex + dataMarker.length);

  // Flash's prompt has neither block at all — only the deep-scan prompt emits them, so
  // both stay absent (and their arrays stay []) for flash results.
  const watchlistMarkerIndex = afterData.indexOf(watchlistMarker);
  const dataBlock = (watchlistMarkerIndex === -1 ? afterData : afterData.slice(0, watchlistMarkerIndex)).trim();
  const afterWatchlist =
    watchlistMarkerIndex === -1 ? null : afterData.slice(watchlistMarkerIndex + watchlistMarker.length);

  let watchlistBlock: string | null = null;
  let tradePlanBlock: string | null = null;
  if (afterWatchlist !== null) {
    const tradePlanMarkerIndex = afterWatchlist.indexOf(tradePlanMarker);
    watchlistBlock = (tradePlanMarkerIndex === -1 ? afterWatchlist : afterWatchlist.slice(0, tradePlanMarkerIndex)).trim();
    tradePlanBlock =
      tradePlanMarkerIndex === -1 ? null : afterWatchlist.slice(tradePlanMarkerIndex + tradePlanMarker.length).trim();
  }

  let verdicts: AnalysisResult["verdicts"] = [];
  try {
    const parsed = JSON.parse(dataBlock);
    verdicts = Array.isArray(parsed) ? parsed : [];
  } catch {
    verdicts = [];
  }

  let watchConditions: WatchCondition[] = [];
  if (watchlistBlock) {
    try {
      const parsed = JSON.parse(watchlistBlock);
      watchConditions = Array.isArray(parsed) ? parsed : [];
    } catch {
      watchConditions = [];
    }
  }

  let tradePlans: TradePlan[] = [];
  if (tradePlanBlock) {
    try {
      const parsed = JSON.parse(tradePlanBlock);
      tradePlans = Array.isArray(parsed) ? parsed : [];
    } catch {
      tradePlans = [];
    }
  }

  return {
    report,
    verdicts,
    watchConditions,
    tradePlans,
    parseWarning: truncated ? "response truncated at max_tokens — later data blocks may be incomplete" : null,
  };
}

export function analyzeCandidates(
  candidates: Candidate[],
  recentHistory: AlertHistoryEntry[],
  funnel: DiscoveryFunnel,
  marketOverview: MarketOverview,
  previousCalls: PreviousCall[]
): Promise<AnalysisResult> {
  // "high" effort deliberately: the report's prose IS the product, and composition
  // quality degraded visibly at medium once the batch grew to ~10 candidates.
  return runAnalysis(SYSTEM_PROMPT, candidates, recentHistory, "Tokens alerted in the last 48 hours", "high", {
    funnel,
    marketOverview,
    previousCalls,
  });
}

export function analyzeFlash(candidates: Candidate[], recentHistory: AlertHistoryEntry[]): Promise<AnalysisResult> {
  return runAnalysis(FLASH_SYSTEM_PROMPT, candidates, recentHistory, "Tokens flash-alerted in the last 6 hours", "medium");
}

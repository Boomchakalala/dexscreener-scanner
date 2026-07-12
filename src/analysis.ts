import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { FLASH_SYSTEM_PROMPT } from "./flashPrompt.js";
import type { MarketOverview } from "./marketOverview.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { AlertHistoryEntry } from "./state.js";
import type { Candidate } from "./types.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface DiscoveryFunnel {
  rawCount: number;
  survivorCount: number;
  deepAnalyzeCount: number;
}

function buildUserMessage(
  candidates: Candidate[],
  recentHistory: AlertHistoryEntry[],
  historyLabel: string,
  context?: { funnel: DiscoveryFunnel; marketOverview: MarketOverview }
): string {
  const payload = candidates.map((c) => ({
    symbol: c.symbol,
    tokenAddress: c.tokenAddress,
    poolAddress: c.poolAddress,
    dexUrl: c.dexUrl,
    ageHours: c.ageHours !== null ? Number(c.ageHours.toFixed(1)) : null,
    marketCapUsd: Math.round(c.marketCapUsd),
    liquidityUsd: Math.round(c.liquidityUsd),
    volume24hUsd: Math.round(c.volume24hUsd),
    volumeH1Usd: Math.round(c.volumeH1Usd),
    volumeH6Usd: Math.round(c.volumeH6Usd),
    priceChangeM5: c.priceChangeM5,
    priceChangeH1: c.priceChangeH1,
    priceChangeH6: c.priceChangeH6,
    priceChangeH24: c.priceChangeH24,
    txnsH1: c.txnsH1,
    txnsH6: c.txnsH6,
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
  }));

  const parts: string[] = [];

  if (context) {
    parts.push(
      `Discovery funnel: rawCount=${context.funnel.rawCount}, survivorCount=${context.funnel.survivorCount}, deepAnalyzeCount=${context.funnel.deepAnalyzeCount}`,
      `Market overview: ${JSON.stringify(context.marketOverview)}`,
      ""
    );
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

export interface AnalysisResult {
  report: string;
  verdicts: { symbol: string; tokenAddress: string; poolAddress: string; verdict: string }[];
}

async function runAnalysis(
  systemPrompt: string,
  candidates: Candidate[],
  recentHistory: AlertHistoryEntry[],
  historyLabel: string,
  effort: "medium" | "high",
  context?: { funnel: DiscoveryFunnel; marketOverview: MarketOverview }
): Promise<AnalysisResult> {
  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort },
    system: systemPrompt,
    messages: [{ role: "user", content: buildUserMessage(candidates, recentHistory, historyLabel, context) }],
  });

  const finalMessage = await stream.finalMessage();
  const textBlock = finalMessage.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const fullText = textBlock?.text ?? "";

  const marker = "---DATA---";
  const markerIndex = fullText.indexOf(marker);
  if (markerIndex === -1) {
    return { report: fullText.trim(), verdicts: [] };
  }

  const report = fullText.slice(0, markerIndex).trim();
  const dataBlock = fullText.slice(markerIndex + marker.length).trim();
  try {
    const verdicts = JSON.parse(dataBlock);
    return { report, verdicts: Array.isArray(verdicts) ? verdicts : [] };
  } catch {
    return { report, verdicts: [] };
  }
}

export function analyzeCandidates(
  candidates: Candidate[],
  recentHistory: AlertHistoryEntry[],
  funnel: DiscoveryFunnel,
  marketOverview: MarketOverview
): Promise<AnalysisResult> {
  return runAnalysis(SYSTEM_PROMPT, candidates, recentHistory, "Tokens alerted in the last 48 hours", "medium", {
    funnel,
    marketOverview,
  });
}

export function analyzeFlash(candidates: Candidate[], recentHistory: AlertHistoryEntry[]): Promise<AnalysisResult> {
  return runAnalysis(FLASH_SYSTEM_PROMPT, candidates, recentHistory, "Tokens flash-alerted in the last 6 hours", "medium");
}

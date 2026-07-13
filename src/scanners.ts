import { analyzeCandidates, analyzeFlash, type DiscoveryFunnel } from "./analysis.js";
import { config } from "./config.js";
import {
  addTradeability,
  discoverCandidates,
  enrichCandidatesForFlash,
  enrichWithCandles,
  enrichWithRugCheck,
  excludeDangerRisks,
} from "./discovery.js";
import { getGeckoStats, resetGeckoStats } from "./gecko.js";
import { openPositionsFromTradePlans } from "./ledger.js";
import { getMarketOverview } from "./marketOverview.js";
import { rankByQuality } from "./scoring.js";
import { getRecentAlertHistory, recordAlerts } from "./state.js";
import { sendTelegramMessage } from "./telegram.js";
import { mergeWatchConditions } from "./watchlist.js";

function now(): number {
  return Date.now();
}

function logStage(stage: string, startedAt: number): void {
  console.log(`  [timing] ${stage}: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

function logGeckoStats(): void {
  const s = getGeckoStats();
  const avgMs = s.requestCount > 0 ? Math.round(s.totalTimeMs / s.requestCount) : 0;
  console.log(
    `  [gecko] requests=${s.requestCount} (sequential, ${s.spacingMs}ms min spacing) ` +
      `totalTime=${(s.totalTimeMs / 1000).toFixed(1)}s avg=${avgMs}ms ` +
      `retries=${s.retryCount} rateLimited=${s.rateLimitCount} timeouts=${s.timeoutCount} ` +
      `slowest=${s.slowest ? `${s.slowest.path} (${s.slowest.ms}ms)` : "n/a"}`
  );
}

export async function runDeepScan(triggeredManually = false): Promise<void> {
  const runStart = now();
  console.log(`[${new Date().toISOString()}] Deep scan: ${config.chains.join(", ")}`);
  const label = triggeredManually ? "**Deep scan** (manual)" : "**Deep scan**";
  resetGeckoStats();

  let t = now();
  const { rawCount, floorSurvivorCount, shortlist } = await discoverCandidates();
  logStage("Discovery + universe filtering", t);
  console.log(
    `Discovered ${rawCount} raw pairs, ${floorSurvivorCount} passed hard floors, ${shortlist.length} chart-shortlisted.`
  );

  if (shortlist.length === 0) {
    await sendTelegramMessage(`${label} — scanned ${rawCount} pairs, none survived the hard filters this run.`);
    logStage("TOTAL", runStart);
    return;
  }

  t = now();
  const withCandles = await enrichWithCandles(shortlist);
  logStage("Enrichment (candles)", t);

  const quality = rankByQuality(withCandles, config.floors.maxDeepAnalyze);
  console.log(`Chart + quality ranking narrowed to top ${quality.length} for RugCheck + deep analysis.`);

  t = now();
  const withRugCheck = await enrichWithRugCheck(quality);
  logStage("Enrichment (rug check, final gate only)", t);
  logGeckoStats();

  const safe = excludeDangerRisks(withRugCheck);
  if (safe.length < withRugCheck.length) {
    console.log(`Excluded ${withRugCheck.length - safe.length} candidates with a RugCheck danger-level (material) risk.`);
  }

  t = now();
  let topCandidates = await addTradeability(safe);
  logStage("Tradeability check (Jupiter, final shortlist only)", t);

  const funnel: DiscoveryFunnel = {
    rawCount,
    floorSurvivorCount,
    shortlistCount: shortlist.length,
    deepAnalyzeCount: topCandidates.length,
  };
  const marketOverview = await getMarketOverview();

  t = now();
  const recentHistory = await getRecentAlertHistory("deep");
  const { report, verdicts, watchConditions, tradePlans } = await analyzeCandidates(
    topCandidates,
    recentHistory,
    funnel,
    marketOverview
  );
  logStage("Deep analysis (Claude)", t);

  t = now();
  await sendTelegramMessage(`${label}\n\n${report || "NO HIGH-QUALITY SETUPS FOUND."}`);
  logStage("Report generation (Telegram send)", t);
  console.log("Sent analysis to Telegram.");

  if (verdicts.length > 0) {
    await recordAlerts("deep", verdicts);
  }

  // Always run this, even with zero new conditions this run — it's also responsible for
  // pruning expired entries, which should happen every run, not just ones that add new ones.
  await mergeWatchConditions(watchConditions, topCandidates);
  console.log(`Merged ${watchConditions.length} new watch condition(s) into data/watchlist.json.`);

  await openPositionsFromTradePlans(tradePlans, topCandidates);
  console.log(`Opened ${tradePlans.length} new PENDING_ENTRY position(s) (subject to sizing/dedup rules) in data/ledger.json.`);

  logStage("TOTAL", runStart);
}

export async function runFlashScan(triggeredManually = false): Promise<void> {
  const runStart = now();
  console.log(`[${new Date().toISOString()}] Flash check: ${config.chains.join(", ")}`);
  resetGeckoStats();

  let t = now();
  const { shortlist: chartShortlist } = await discoverCandidates();
  logStage("Discovery + universe filtering", t);

  if (chartShortlist.length === 0) {
    if (triggeredManually) await sendTelegramMessage("⚡ **Flash check** (manual) — no candidates in range right now.");
    console.log("No candidates in range this pass.");
    logStage("TOTAL", runStart);
    return;
  }

  // Flash is speed-first: skip the quality re-rank and just take the top of the
  // chart-proxy-ranked shortlist discoverCandidates already produced.
  const shortlist = chartShortlist.slice(0, 15);

  t = now();
  const candidates = await enrichCandidatesForFlash(shortlist);
  logStage("Enrichment (candles only)", t);
  logGeckoStats();

  const recentHistory = await getRecentAlertHistory("flash");

  t = now();
  const { report, verdicts } = await analyzeFlash(candidates, recentHistory);
  logStage("Deep analysis (Claude)", t);

  const nothingFound = !report || report.trim().toUpperCase() === "NOTHING";
  if (nothingFound) {
    if (triggeredManually) await sendTelegramMessage("⚡ **Flash check** (manual) — nothing flashing right now.");
    console.log("Nothing flashing this pass.");
    logStage("TOTAL", runStart);
    return;
  }

  const label = triggeredManually ? "⚡ **FLASH ALERT** (manual)" : "⚡ **FLASH ALERT**";

  t = now();
  await sendTelegramMessage(`${label}\n\n${report}`);
  logStage("Report generation (Telegram send)", t);
  console.log("Sent flash alert to Telegram.");

  if (verdicts.length > 0) {
    await recordAlerts("flash", verdicts);
  }

  logStage("TOTAL", runStart);
}

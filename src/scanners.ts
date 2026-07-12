import { analyzeCandidates, analyzeFlash, type DiscoveryFunnel } from "./analysis.js";
import { config } from "./config.js";
import { discoverCandidates, enrichCandidates, enrichCandidatesForFlash, excludeDangerRisks } from "./discovery.js";
import { getGeckoStats, resetGeckoStats } from "./gecko.js";
import { getMarketOverview } from "./marketOverview.js";
import { rankAndCut } from "./scoring.js";
import { getRecentAlertHistory, recordAlerts } from "./state.js";
import { sendTelegramMessage } from "./telegram.js";

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
    `  [gecko] requests=${s.requestCount} (sequential, ${1200}ms min spacing) ` +
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
  const { rawCount, survivors } = await discoverCandidates();
  logStage("Discovery + universe filtering", t);
  console.log(`Discovered ${rawCount} raw pairs, ${survivors.length} survived hard filters.`);

  if (survivors.length === 0) {
    await sendTelegramMessage(`${label} — scanned ${rawCount} pairs, none survived the hard filters this run.`);
    logStage("TOTAL", runStart);
    return;
  }

  t = now();
  const enriched = await enrichCandidates(survivors);
  logStage("Enrichment (candles + rug check)", t);
  console.log(`Enriched ${enriched.length} candidates with candles + rug check data.`);
  logGeckoStats();

  const safe = excludeDangerRisks(enriched);
  if (safe.length < enriched.length) {
    console.log(`Excluded ${enriched.length - safe.length} candidates with a RugCheck danger-level risk.`);
  }

  const ranked = rankAndCut(safe, config.floors.maxDeepAnalyze);
  const topCandidates = ranked.map((r) => r.candidate);
  console.log(`Quantitative pre-score narrowed to top ${topCandidates.length} for deep analysis.`);

  const funnel: DiscoveryFunnel = {
    rawCount,
    survivorCount: survivors.length,
    deepAnalyzeCount: topCandidates.length,
  };
  const marketOverview = await getMarketOverview();

  t = now();
  const recentHistory = await getRecentAlertHistory("deep");
  const { report, verdicts } = await analyzeCandidates(topCandidates, recentHistory, funnel, marketOverview);
  logStage("Deep analysis (Claude)", t);

  t = now();
  await sendTelegramMessage(`${label}\n\n${report || "NO HIGH-QUALITY SETUPS FOUND."}`);
  logStage("Report generation (Telegram send)", t);
  console.log("Sent analysis to Telegram.");

  if (verdicts.length > 0) {
    await recordAlerts("deep", verdicts);
  }

  logStage("TOTAL", runStart);
}

export async function runFlashScan(triggeredManually = false): Promise<void> {
  const runStart = now();
  console.log(`[${new Date().toISOString()}] Flash check: ${config.chains.join(", ")}`);
  resetGeckoStats();

  let t = now();
  const { survivors } = await discoverCandidates();
  logStage("Discovery + universe filtering", t);

  if (survivors.length === 0) {
    if (triggeredManually) await sendTelegramMessage("⚡ **Flash check** (manual) — no candidates in range right now.");
    console.log("No candidates in range this pass.");
    logStage("TOTAL", runStart);
    return;
  }

  // Flash is speed-first: skip the full rug-check-informed pre-score and just take the
  // most liquid subset (discoverCandidates already sorts survivors by liquidity).
  const shortlist = survivors.slice(0, 15);

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

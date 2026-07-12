import { analyzeCandidates, analyzeFlash, type DiscoveryFunnel } from "./analysis.js";
import { config } from "./config.js";
import { discoverCandidates, enrichCandidates, enrichCandidatesForFlash } from "./discovery.js";
import { getMarketOverview } from "./marketOverview.js";
import { rankAndCut } from "./scoring.js";
import { getRecentAlertHistory, recordAlerts } from "./state.js";
import { sendTelegramMessage } from "./telegram.js";

export async function runDeepScan(triggeredManually = false): Promise<void> {
  console.log(`[${new Date().toISOString()}] Deep scan: ${config.chains.join(", ")}`);
  const label = triggeredManually ? "**Deep scan** (manual)" : "**Deep scan**";

  const { rawCount, survivors } = await discoverCandidates();
  console.log(`Discovered ${rawCount} raw pairs, ${survivors.length} survived hard filters.`);

  if (survivors.length === 0) {
    await sendTelegramMessage(`${label} — scanned ${rawCount} pairs, none survived the hard filters this run.`);
    return;
  }

  const enriched = await enrichCandidates(survivors);
  console.log(`Enriched ${enriched.length} candidates with candles + rug check data.`);

  const ranked = rankAndCut(enriched, config.floors.maxDeepAnalyze);
  const topCandidates = ranked.map((r) => r.candidate);
  console.log(`Quantitative pre-score narrowed to top ${topCandidates.length} for deep analysis.`);

  const funnel: DiscoveryFunnel = {
    rawCount,
    survivorCount: survivors.length,
    deepAnalyzeCount: topCandidates.length,
  };
  const marketOverview = await getMarketOverview();

  const recentHistory = await getRecentAlertHistory("deep");
  const { report, verdicts } = await analyzeCandidates(topCandidates, recentHistory, funnel, marketOverview);

  await sendTelegramMessage(`${label}\n\n${report || "NO HIGH-QUALITY SETUPS FOUND."}`);
  console.log("Sent analysis to Telegram.");

  if (verdicts.length > 0) {
    await recordAlerts("deep", verdicts);
  }
}

export async function runFlashScan(triggeredManually = false): Promise<void> {
  console.log(`[${new Date().toISOString()}] Flash check: ${config.chains.join(", ")}`);

  const { survivors } = await discoverCandidates();
  if (survivors.length === 0) {
    if (triggeredManually) await sendTelegramMessage("⚡ **Flash check** (manual) — no candidates in range right now.");
    console.log("No candidates in range this pass.");
    return;
  }

  // Flash is speed-first: skip the full rug-check-informed pre-score and just take the
  // most liquid subset (discoverCandidates already sorts survivors by liquidity).
  const shortlist = survivors.slice(0, 15);
  const candidates = await enrichCandidatesForFlash(shortlist);
  const recentHistory = await getRecentAlertHistory("flash");
  const { report, verdicts } = await analyzeFlash(candidates, recentHistory);

  const nothingFound = !report || report.trim().toUpperCase() === "NOTHING";
  if (nothingFound) {
    if (triggeredManually) await sendTelegramMessage("⚡ **Flash check** (manual) — nothing flashing right now.");
    console.log("Nothing flashing this pass.");
    return;
  }

  const label = triggeredManually ? "⚡ **FLASH ALERT** (manual)" : "⚡ **FLASH ALERT**";
  await sendTelegramMessage(`${label}\n\n${report}`);
  console.log("Sent flash alert to Telegram.");

  if (verdicts.length > 0) {
    await recordAlerts("flash", verdicts);
  }
}

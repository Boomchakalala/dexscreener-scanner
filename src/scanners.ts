import { analyzeCandidates, analyzeFlash } from "./analysis.js";
import { config } from "./config.js";
import { discoverCandidates, enrichCandidates, enrichCandidatesForFlash } from "./discovery.js";
import { getRecentAlertHistory, recordAlerts } from "./state.js";
import { sendTelegramMessage } from "./telegram.js";

export async function runDeepScan(triggeredManually = false): Promise<void> {
  console.log(`[${new Date().toISOString()}] Deep scan: ${config.chains.join(", ")}`);
  const label = triggeredManually ? "**Deep scan** (manual)" : "**Deep scan**";

  const discovered = await discoverCandidates();
  console.log(`${discovered.length} candidates passed market cap / liquidity floors.`);

  if (discovered.length === 0) {
    await sendTelegramMessage(`${label} — no candidates found in the $150K-$1.5M market cap band this run.`);
    return;
  }

  const candidates = await enrichCandidates(discovered);
  console.log(`Enriched ${candidates.length} candidates with candles + rug check data.`);

  const recentHistory = await getRecentAlertHistory("deep");
  const { report, verdicts } = await analyzeCandidates(candidates, recentHistory);

  await sendTelegramMessage(`${label}\n\n${report || "NO HIGH-QUALITY SETUPS FOUND."}`);
  console.log("Sent analysis to Telegram.");

  if (verdicts.length > 0) {
    await recordAlerts("deep", verdicts);
  }
}

export async function runFlashScan(triggeredManually = false): Promise<void> {
  console.log(`[${new Date().toISOString()}] Flash check: ${config.chains.join(", ")}`);

  const discovered = await discoverCandidates();
  if (discovered.length === 0) {
    if (triggeredManually) await sendTelegramMessage("⚡ **Flash check** (manual) — no candidates in range right now.");
    console.log("No candidates in range this pass.");
    return;
  }

  const candidates = await enrichCandidatesForFlash(discovered);
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

import { analyzeFlash } from "./analysis.js";
import { config } from "./config.js";
import { discoverCandidates, enrichCandidatesForFlash } from "./discovery.js";
import { getRecentAlertHistory, recordAlerts } from "./state.js";
import { sendTelegramMessage } from "./telegram.js";

async function main() {
  console.log(`[${new Date().toISOString()}] Flash check: ${config.chains.join(", ")}`);

  const discovered = await discoverCandidates();
  if (discovered.length === 0) {
    console.log("No candidates in range this pass.");
    return;
  }

  const candidates = await enrichCandidatesForFlash(discovered);
  const recentHistory = await getRecentAlertHistory("flash");
  const { report, verdicts } = await analyzeFlash(candidates, recentHistory);

  if (!report || report.trim().toUpperCase() === "NOTHING") {
    console.log("Nothing flashing this pass.");
    return;
  }

  await sendTelegramMessage(`⚡ **FLASH ALERT**\n\n${report}`);
  console.log("Sent flash alert to Telegram.");

  if (verdicts.length > 0) {
    await recordAlerts("flash", verdicts);
  }
}

main().catch((err) => {
  console.error("Flash check failed:", err);
  process.exitCode = 1;
});

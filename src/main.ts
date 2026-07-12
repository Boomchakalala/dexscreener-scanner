import { analyzeCandidates } from "./analysis.js";
import { config } from "./config.js";
import { discoverCandidates, enrichCandidates } from "./discovery.js";
import { getRecentAlertHistory, recordAlerts } from "./state.js";
import { sendTelegramMessage } from "./telegram.js";

async function main() {
  console.log(`[${new Date().toISOString()}] Scanning chains: ${config.chains.join(", ")}`);

  const discovered = await discoverCandidates();
  console.log(`${discovered.length} candidates passed market cap / liquidity floors.`);

  if (discovered.length === 0) {
    await sendTelegramMessage("No candidates found in the $150K-$1.5M market cap band this run.");
    return;
  }

  const candidates = await enrichCandidates(discovered);
  console.log(`Enriched ${candidates.length} candidates with candles + rug check data.`);

  const recentHistory = await getRecentAlertHistory("deep");
  const { report, verdicts } = await analyzeCandidates(candidates, recentHistory);

  await sendTelegramMessage(report || "NO HIGH-QUALITY SETUPS FOUND.");
  console.log("Sent analysis to Telegram.");

  if (verdicts.length > 0) {
    await recordAlerts("deep", verdicts);
  }
}

main().catch((err) => {
  console.error("Scan failed:", err);
  process.exitCode = 1;
});

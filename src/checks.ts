import { runLedgerCheck } from "./ledgerChecker.js";
import { runWatchlistCheck } from "./watchlistChecker.js";

// One process, one GitHub Actions job for both frequent checks — Actions bills each job's
// runtime rounded UP to a full minute, so two separate sub-minute jobs every 5 minutes
// cost exactly double what one combined job does (~8,640 vs ~4,320 min/month).
async function main() {
  let failed = false;
  try {
    await runWatchlistCheck();
  } catch (err) {
    console.error("Watchlist check failed:", err);
    failed = true;
  }
  try {
    await runLedgerCheck();
  } catch (err) {
    console.error("Ledger check failed:", err);
    failed = true;
  }
  if (failed) process.exitCode = 1;
}

main();

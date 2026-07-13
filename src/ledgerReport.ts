import { runLedgerReport } from "./ledgerReporter.js";

runLedgerReport().catch((err) => {
  console.error("Ledger report failed:", err);
  process.exitCode = 1;
});

import { runLedgerCheck } from "./ledgerChecker.js";

runLedgerCheck().catch((err) => {
  console.error("Ledger check failed:", err);
  process.exitCode = 1;
});

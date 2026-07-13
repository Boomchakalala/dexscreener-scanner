import { runDeepScan } from "./scanners.js";

runDeepScan(process.env.TRIGGERED_MANUALLY === "true").catch((err) => {
  console.error("Scan failed:", err);
  process.exitCode = 1;
});

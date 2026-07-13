import { runFlashScan } from "./scanners.js";

runFlashScan(process.env.TRIGGERED_MANUALLY === "true").catch((err) => {
  console.error("Flash check failed:", err);
  process.exitCode = 1;
});

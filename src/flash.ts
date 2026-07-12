import { runFlashScan } from "./scanners.js";

runFlashScan().catch((err) => {
  console.error("Flash check failed:", err);
  process.exitCode = 1;
});

import { runDeepScan } from "./scanners.js";

runDeepScan().catch((err) => {
  console.error("Scan failed:", err);
  process.exitCode = 1;
});

import { runWatchlistCheck } from "./watchlistChecker.js";

runWatchlistCheck().catch((err) => {
  console.error("Watchlist check failed:", err);
  process.exitCode = 1;
});

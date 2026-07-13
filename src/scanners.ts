import { analyzeCandidates, analyzeFlash, type DiscoveryFunnel } from "./analysis.js";
import { config } from "./config.js";
import {
  addTradeability,
  discoverCandidates,
  enrichCandidatesForFlash,
  enrichWithCandles,
  enrichWithRugCheck,
  excludeDangerRisks,
} from "./discovery.js";
import { getGeckoStats, resetGeckoStats } from "./gecko.js";
import { openPositionsFromTradePlans } from "./ledger.js";
import { getMarketOverview } from "./marketOverview.js";
import { rankByQuality } from "./scoring.js";
import { getRecentAlertHistory, recordAlerts } from "./state.js";
import { sendTelegramMessage } from "./telegram.js";
import { mergeWatchConditions } from "./watchlist.js";

function now(): number {
  return Date.now();
}

function logStage(stage: string, startedAt: number): void {
  console.log(`  [timing] ${stage}: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

/** Which discovery universe (per the prompt's definitions) each deep-analyze candidate
 *  falls into — the tell for input starvation. If "off-window" dominates run after run,
 *  Claude is being fed filler that no universe playbook applies to, and dry reports are
 *  a discovery problem, not a judgment problem. */
function logUniverseDistribution(candidates: { ageHours: number | null; marketCapUsd: number }[]): void {
  const counts = { U1: 0, U2: 0, U3: 0, "off-window": 0 };
  for (const c of candidates) {
    const age = c.ageHours;
    const mc = c.marketCapUsd;
    if (age !== null && age <= 2 && mc >= 30_000 && mc <= 300_000) counts.U1++;
    else if (age !== null && age > 2 && age <= 8 && mc >= 100_000 && mc <= 1_000_000) counts.U2++;
    else if (age !== null && age > 8 && age <= 24 && mc >= 250_000 && mc <= 3_000_000) counts.U3++;
    else counts["off-window"]++;
  }
  console.log(
    `  [universes] deep-analyze batch: U1 fresh=${counts.U1}, U2 survivors=${counts.U2}, U3 momentum=${counts.U3}, off-window=${counts["off-window"]}`
  );
}

function logGeckoStats(): void {
  const s = getGeckoStats();
  const avgMs = s.requestCount > 0 ? Math.round(s.totalTimeMs / s.requestCount) : 0;
  console.log(
    `  [gecko] requests=${s.requestCount} (sequential, ${s.spacingMs}ms min spacing) ` +
      `totalTime=${(s.totalTimeMs / 1000).toFixed(1)}s avg=${avgMs}ms ` +
      `retries=${s.retryCount} rateLimited=${s.rateLimitCount} timeouts=${s.timeoutCount} ` +
      `slowest=${s.slowest ? `${s.slowest.path} (${s.slowest.ms}ms)` : "n/a"}`
  );
}

export async function runDeepScan(triggeredManually = false): Promise<void> {
  const runStart = now();
  console.log(`[${new Date().toISOString()}] Deep scan: ${config.chains.join(", ")}`);
  const label = triggeredManually ? "**Deep scan** (manual)" : "**Deep scan**";
  resetGeckoStats();

  let t = now();
  const { rawCount, floorSurvivorCount, shortlist } = await discoverCandidates();
  logStage("Discovery + universe filtering", t);
  console.log(
    `Discovered ${rawCount} raw pairs, ${floorSurvivorCount} passed hard floors, ${shortlist.length} chart-shortlisted.`
  );

  if (shortlist.length === 0) {
    await sendTelegramMessage(`${label} — scanned ${rawCount} pairs, none survived the hard filters this run.`);
    logStage("TOTAL", runStart);
    return;
  }

  t = now();
  const withCandles = await enrichWithCandles(shortlist);
  logStage("Enrichment (candles)", t);

  // RugCheck a batch with headroom BEFORE the final cut: danger flags kill 40-50% of a
  // typical pump.fun-era batch, and excluding after the cut was handing Claude a 5-6
  // token batch while clean candidates ranked just below never got their slot.
  const RUGCHECK_HEADROOM = 6;
  const quality = rankByQuality(withCandles, config.floors.maxDeepAnalyze + RUGCHECK_HEADROOM);
  console.log(`Chart + quality ranking narrowed to top ${quality.length} for RugCheck (with backfill headroom).`);

  t = now();
  const withRugCheck = await enrichWithRugCheck(quality);
  logStage("Enrichment (rug check, final gate only)", t);
  logGeckoStats();

  const safe = excludeDangerRisks(withRugCheck);
  if (safe.length < withRugCheck.length) {
    console.log(`Excluded ${withRugCheck.length - safe.length} of ${withRugCheck.length} on RugCheck danger-level risks (see lines above).`);
  }

  t = now();
  let topCandidates = await addTradeability(safe.slice(0, config.floors.maxDeepAnalyze));
  logStage("Tradeability check (Jupiter, final shortlist only)", t);
  logUniverseDistribution(topCandidates);

  const funnel: DiscoveryFunnel = {
    rawCount,
    floorSurvivorCount,
    shortlistCount: shortlist.length,
    deepAnalyzeCount: topCandidates.length,
  };
  const marketOverview = await getMarketOverview();

  t = now();
  const recentHistory = await getRecentAlertHistory("deep");
  const { report, verdicts, watchConditions, tradePlans } = await analyzeCandidates(
    topCandidates,
    recentHistory,
    funnel,
    marketOverview
  );
  logStage("Deep analysis (Claude)", t);

  t = now();
  await sendTelegramMessage(`${label}\n\n${report || "NO HIGH-QUALITY SETUPS FOUND."}`);
  logStage("Report generation (Telegram send)", t);
  console.log("Sent analysis to Telegram.");

  if (verdicts.length > 0) {
    await recordAlerts("deep", verdicts);
  }

  // Always run this, even with zero new conditions this run — it's also responsible for
  // pruning expired entries, which should happen every run, not just ones that add new ones.
  await mergeWatchConditions(watchConditions, topCandidates);
  console.log(`Merged ${watchConditions.length} new watch condition(s) into data/watchlist.json.`);

  await openPositionsFromTradePlans(tradePlans, topCandidates);
  console.log(`Opened ${tradePlans.length} new PENDING_ENTRY position(s) (subject to sizing/dedup rules) in data/ledger.json.`);

  await warnIfPlansMissing(verdicts, tradePlans.length, "deep scan");

  logStage("TOTAL", runStart);
}

/** A malformed ---TRADEPLAN--- block parses silently to [] — without this, trade plans
 *  could stop flowing to the paper ledger for weeks with no visible symptom. */
async function warnIfPlansMissing(
  verdicts: { verdict: string }[],
  planCount: number,
  source: string
): Promise<void> {
  const actionable = verdicts.filter((v) => v.verdict === "RECOMMENDATION" || v.verdict === "SPECULATIVE PUNT" || v.verdict === "FLASH ALERT");
  if (actionable.length > 0 && planCount === 0) {
    console.warn(`${source}: ${actionable.length} actionable verdict(s) but zero parseable trade plans — likely a ---TRADEPLAN--- format break.`);
    await sendTelegramMessage(
      `⚠️ The last ${source} produced recommendations but no machine-readable trade plans (likely a format/parse issue) — the paper ledger did not open positions for it.`
    );
  }
}

export async function runFlashScan(triggeredManually = false): Promise<void> {
  const runStart = now();
  console.log(`[${new Date().toISOString()}] Flash check: ${config.chains.join(", ")}`);
  resetGeckoStats();

  let t = now();
  const { shortlist: chartShortlist } = await discoverCandidates();
  logStage("Discovery + universe filtering", t);

  if (chartShortlist.length === 0) {
    if (triggeredManually) await sendTelegramMessage("⚡ **Flash check** (manual) — no candidates in range right now.");
    console.log("No candidates in range this pass.");
    logStage("TOTAL", runStart);
    return;
  }

  // Flash is speed-first: skip the quality re-rank and just take the top of the
  // chart-proxy-ranked shortlist discoverCandidates already produced.
  const shortlist = chartShortlist.slice(0, 15);

  t = now();
  const candidates = await enrichCandidatesForFlash(shortlist);
  logStage("Enrichment (candles only)", t);
  logGeckoStats();

  const recentHistory = await getRecentAlertHistory("flash");

  t = now();
  const { report, verdicts, tradePlans } = await analyzeFlash(candidates, recentHistory);
  logStage("Deep analysis (Claude)", t);

  const nothingFound = !report || report.trim().toUpperCase() === "NOTHING";
  if (nothingFound) {
    if (triggeredManually) await sendTelegramMessage("⚡ **Flash check** (manual) — nothing flashing right now.");
    console.log("Nothing flashing this pass.");
    logStage("TOTAL", runStart);
    return;
  }

  const label = triggeredManually ? "⚡ **FLASH ALERT** (manual)" : "⚡ **FLASH ALERT**";

  t = now();
  await sendTelegramMessage(`${label}\n\n${report}`);
  logStage("Report generation (Telegram send)", t);
  console.log("Sent flash alert to Telegram.");

  if (verdicts.length > 0) {
    await recordAlerts("flash", verdicts);
  }

  // Flash's speed-first enrichment skips RugCheck for the broad shortlist, but a token
  // about to get real (paper) capital deserves the same danger-flag gate the deep scan
  // applies — it's only 1-3 extra lookups on the actually-flagged tokens.
  if (tradePlans.length > 0) {
    const flagged = candidates.filter((c) => tradePlans.some((p) => p.tokenAddress === c.tokenAddress));
    const safeTokens = new Set(excludeDangerRisks(await enrichWithRugCheck(flagged)).map((c) => c.tokenAddress));
    const safePlans = tradePlans.filter((p) => safeTokens.has(p.tokenAddress));
    if (safePlans.length < tradePlans.length) {
      console.log(`Excluded ${tradePlans.length - safePlans.length} flash trade plan(s) with a RugCheck danger-level risk.`);
    }
    await openPositionsFromTradePlans(safePlans, candidates);
    console.log(`Opened ${safePlans.length} new PENDING_ENTRY position(s) from flash (subject to sizing/dedup rules) in data/ledger.json.`);
  }

  await warnIfPlansMissing(verdicts, tradePlans.length, "flash scan");

  logStage("TOTAL", runStart);
}

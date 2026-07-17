import { analyzeCandidates, analyzeFlash, type DiscoveryFunnel, type WatchCondition } from "./analysis.js";
import { config } from "./config.js";
import {
  addTradeability,
  discoverCandidates,
  enrichCandidatesForFlash,
  enrichWithCandles,
  enrichWithRugCheck,
  enrichWithTokenMeta,
  excludeDangerRisks,
  toCandidate,
} from "./discovery.js";
import { getGeckoStats, getPool, resetGeckoStats } from "./gecko.js";
import { attemptImmediateFills } from "./ledgerChecker.js";
import { cancelDeadPendingEntries, loadLedger, openPositionsFromTradePlans } from "./ledger.js";
import { getMarketOverview } from "./marketOverview.js";
import { rankByQuality } from "./scoring.js";
import { getRecentAlertHistory, recordAlerts, type AlertHistoryEntry } from "./state.js";
import { sendTelegramMessage } from "./telegram.js";
import { loadWatchlistEntries, mergeWatchConditions } from "./watchlist.js";
import type { Candidate } from "./types.js";

function now(): number {
  return Date.now();
}

/** Tokens we recently called are followed to conclusion regardless of what current
 *  discovery filters think of them — the suffix-only pump.fun gate famously excluded
 *  PCAT, the user's own favorite live call, one scan after it was made. Grandfathered
 *  tokens get force-fetched, flagged `tracked`, and take ADDITIONAL batch slots on top
 *  of fresh discovery. Scope tightened per the compact-report redesign: ONLY a currently
 *  live paper position or an active watch condition counts — "we said something nice
 *  about it yesterday" is no longer enough. A token merely mentioned in an old report
 *  should not keep dragging every future report back to it. */
const MAX_TRACKED = 3;

async function getTrackedTokens(): Promise<{ tokenAddress: string; poolAddress: string }[]> {
  const nowMs = Date.now();
  const out = new Map<string, string>();

  const ledger = await loadLedger();
  for (const p of ledger.positions) {
    const live = p.status === "PENDING_ENTRY" || p.status === "OPEN" || p.status === "TP1_TAKEN";
    if (live) out.set(p.tokenAddress, p.poolAddress);
  }
  for (const w of await loadWatchlistEntries()) {
    if (w.expiresAt > nowMs) out.set(w.tokenAddress, w.poolAddress);
  }

  return [...out].slice(0, MAX_TRACKED).map(([tokenAddress, poolAddress]) => ({ tokenAddress, poolAddress }));
}

/** Marks in-shortlist tracked tokens and force-fetches the ones discovery dropped. */
async function withTrackedTokens(shortlist: Candidate[]): Promise<Candidate[]> {
  const tracked = await getTrackedTokens();
  if (tracked.length === 0) return shortlist;
  const trackedSet = new Set(tracked.map((t) => t.tokenAddress));
  const present = new Set(shortlist.map((c) => c.tokenAddress));

  const marked = shortlist.map((c) => (trackedSet.has(c.tokenAddress) ? { ...c, tracked: true } : c));
  const missing = tracked.filter((t) => !present.has(t.tokenAddress));
  const fetched: Candidate[] = [];
  for (const t of missing) {
    const pool = await getPool("solana", t.poolAddress);
    const candidate = pool ? toCandidate("solana", pool) : null;
    if (candidate) fetched.push({ ...candidate, tracked: true });
  }
  if (fetched.length > 0) {
    console.log(`  [tracked] force-included ${fetched.length} previously-called token(s) discovery had dropped: ${fetched.map((c) => c.symbol).join(", ")}`);
  }
  return [...marked, ...fetched];
}

/** A WATCH verdict doesn't guarantee a structured, checkable watchlist condition — the
 *  ---WATCHLIST--- block only includes a token when Claude stated a genuinely specific
 *  level, so a real WATCH call with vaguer language got ZERO tracking at all, silently
 *  falling off the radar the moment the report aged out (confirmed live: BlackBear got
 *  one WATCH call, never a concrete condition, and was invisible to every report since —
 *  its move continued but nothing was watching). This is the safety net: any WATCH-tier
 *  verdict without its own structured condition gets a loose fallback band around its
 *  call-time market cap instead of nothing. */
function withFallbackWatchConditions(
  watchConditions: WatchCondition[],
  verdicts: { symbol: string; tokenAddress: string; poolAddress: string; verdict: string }[],
  candidates: Candidate[]
): WatchCondition[] {
  const covered = new Set(watchConditions.map((w) => w.tokenAddress));
  const candidateByToken = new Map(candidates.map((c) => [c.tokenAddress, c]));
  const fallbacks: WatchCondition[] = [];

  for (const v of verdicts) {
    if (v.verdict !== "WATCH" || covered.has(v.tokenAddress)) continue;
    const candidate = candidateByToken.get(v.tokenAddress);
    if (!candidate) continue;
    fallbacks.push({
      symbol: v.symbol,
      tokenAddress: v.tokenAddress,
      poolAddress: v.poolAddress,
      condition: {
        mcMin: Math.round(candidate.marketCapUsd * 0.75),
        mcMax: Math.round(candidate.marketCapUsd * 1.5),
        requireRisingVolume: true,
        description: "fallback watch (no precise condition stated this run) — loose band around its call-time market cap",
      },
      validUntilHours: 24,
    });
  }
  return [...watchConditions, ...fallbacks];
}

export interface PreviousCall {
  symbol: string;
  tokenAddress: string;
  firstCalledHoursAgo: number;
  callTrajectory: string;
  mcAtFirstCallUsd: number | null;
  paperStatus: string | null;
}

/** Deterministic then-vs-now context, scoped to the SAME set as getTrackedTokens (live
 *  paper position or active watch condition only — no more "anything called in the last
 *  24h"). The old broader version kept every REC/PUNT call around for a full day, which
 *  is exactly what turned OPEN POSITIONS into a wall of "no signal, leave it" lines even
 *  when there was nothing new to report on a token. */
async function buildPreviousCalls(): Promise<PreviousCall[]> {
  const nowMs = Date.now();
  const ledger = await loadLedger();

  const calls: PreviousCall[] = [];
  for (const p of ledger.positions) {
    if (p.status !== "PENDING_ENTRY" && p.status !== "OPEN" && p.status !== "TP1_TAKEN") continue;
    let status: string;
    if (p.status === "PENDING_ENTRY") {
      const minutesLeft = Math.max(0, Math.round((p.createdAt + p.entryCondition.validityWindowMinutes * 60_000 - nowMs) / 60_000));
      status = `waiting for entry trigger (${minutesLeft}m left)`;
    } else if (p.status === "OPEN") {
      status = `position OPEN from $${p.entryPrice}`;
    } else {
      status = `runner after TP1, realized ${p.realizedPnlSol.toFixed(3)} SOL`;
    }
    calls.push({
      symbol: p.symbol,
      tokenAddress: p.tokenAddress,
      firstCalledHoursAgo: Number(((nowMs - p.createdAt) / 3_600_000).toFixed(1)),
      callTrajectory: p.tier,
      mcAtFirstCallUsd: p.entrySnapshot.marketCapUsd ?? null,
      paperStatus: status,
    });
  }

  for (const w of await loadWatchlistEntries()) {
    if (w.expiresAt <= nowMs) continue;
    if (calls.some((c) => c.tokenAddress === w.tokenAddress)) continue;
    calls.push({
      symbol: w.symbol,
      tokenAddress: w.tokenAddress,
      firstCalledHoursAgo: Number(((nowMs - w.addedAt) / 3_600_000).toFixed(1)),
      callTrajectory: "WATCH",
      mcAtFirstCallUsd: null,
      paperStatus: `watching: ${w.condition.description}`,
    });
  }

  return calls.slice(0, MAX_TRACKED);
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

  const recentHistory = await getRecentAlertHistory("deep");
  const workset = await withTrackedTokens(shortlist);

  if (workset.length === 0) {
    await sendTelegramMessage(`${label} — scanned ${rawCount} pairs, none survived the hard filters this run.`);
    logStage("TOTAL", runStart);
    return;
  }

  t = now();
  const withCandles = await enrichWithCandles(workset);
  logStage("Enrichment (candles)", t);

  // RugCheck a batch with headroom BEFORE the final cut: danger flags kill 40-50% of a
  // typical pump.fun-era batch, and excluding after the cut was handing Claude a 5-6
  // token batch while clean candidates ranked just below never got their slot.
  const RUGCHECK_HEADROOM = 6;
  const quality = rankByQuality(withCandles, config.floors.maxDeepAnalyze + RUGCHECK_HEADROOM);
  console.log(`Chart + quality ranking narrowed to top ${quality.length} for RugCheck (with backfill headroom).`);

  // Tracked (previously-called) tokens are guaranteed a batch slot: rescue any the
  // quality cut dropped — the whole point is that Claude re-reads them every run.
  const qualityIds = new Set(quality.map((c) => c.tokenAddress));
  const trackedRescuedAtQuality = withCandles.filter((c) => c.tracked && !qualityIds.has(c.tokenAddress));

  t = now();
  const withRugCheck = await enrichWithRugCheck([...quality, ...trackedRescuedAtQuality]);
  logStage("Enrichment (rug check, final gate only)", t);
  logGeckoStats();

  const safe = excludeDangerRisks(withRugCheck);
  if (safe.length < withRugCheck.length) {
    console.log(`Excluded ${withRugCheck.length - safe.length} of ${withRugCheck.length} on RugCheck danger-level risks (see lines above).`);
  }

  // Tracked tokens take ADDITIONAL slots — the fresh-discovery cut is computed over
  // non-tracked candidates only, so previous calls can never crowd out new finds.
  const freshCut = safe.filter((c) => !c.tracked).slice(0, config.floors.maxDeepAnalyze);
  const trackedInBatch = safe.filter((c) => c.tracked);

  t = now();
  let topCandidates = await enrichWithTokenMeta(await addTradeability([...freshCut, ...trackedInBatch]));
  logStage("Tradeability + holder/organic enrichment (Jupiter, final batch only)", t);
  logUniverseDistribution(topCandidates);

  const funnel: DiscoveryFunnel = {
    rawCount,
    floorSurvivorCount,
    shortlistCount: shortlist.length,
    deepAnalyzeCount: topCandidates.length,
  };
  const marketOverview = await getMarketOverview();

  t = now();
  const previousCalls = await buildPreviousCalls();
  const { report, verdicts, watchConditions, tradePlans, cancelTokenAddresses, parseWarning } = await analyzeCandidates(
    topCandidates,
    recentHistory,
    funnel,
    marketOverview,
    previousCalls
  );
  logStage("Deep analysis (Claude)", t);

  if (parseWarning) {
    console.warn(`Deep scan parse warning: ${parseWarning}`);
    await sendTelegramMessage(`⚠️ Deep scan output issue: ${parseWarning}.`);
  }

  // Full report into the Actions log — Telegram is otherwise the only place reports
  // exist, which made "the report quality dropped" undebuggable after the fact.
  console.log(`--- report ---\n${report}\n--- end report ---`);

  t = now();
  await sendTelegramMessage(`${label}\n\n${report || "NO HIGH-QUALITY SETUPS FOUND."}`);
  logStage("Report generation (Telegram send)", t);
  console.log("Sent analysis to Telegram.");

  if (verdicts.length > 0) {
    const mcByToken = new Map(topCandidates.map((c) => [c.tokenAddress, c.marketCapUsd]));
    await recordAlerts(
      "deep",
      verdicts.map((v) => ({ ...v, marketCapUsdAtAlert: mcByToken.get(v.tokenAddress) }))
    );
  }

  // Always run this, even with zero new conditions this run — it's also responsible for
  // pruning expired entries, which should happen every run, not just ones that add new ones.
  const watchConditionsWithFallback = withFallbackWatchConditions(watchConditions, verdicts, topCandidates);
  await mergeWatchConditions(watchConditionsWithFallback, topCandidates);
  console.log(
    `Merged ${watchConditionsWithFallback.length} watch condition(s) into data/watchlist.json (${watchConditionsWithFallback.length - watchConditions.length} fallback).`
  );

  const openResult = await openPositionsFromTradePlans(tradePlans, topCandidates);
  console.log(`Opened ${openResult.opened.length} of ${tradePlans.length} proposed trade plan(s) in data/ledger.json.`);
  for (const skip of openResult.skipped) {
    console.log(`  [ledger] skipped ${skip.symbol}: ${skip.reason}`);
  }
  // Rare on deep scan (almost all IMMEDIATE entries come from flash), but a true ACTIONABLE
  // NOW pick deserves the same instant-fill attempt rather than waiting on the next cron tick.
  await attemptImmediateFills(tradePlans.map((p) => p.tokenAddress));

  const cancelled = await cancelDeadPendingEntries(cancelTokenAddresses);
  if (cancelled.length > 0) {
    console.log(`Auto-cancelled ${cancelled.length} dead pending entr${cancelled.length === 1 ? "y" : "ies"}, freeing their reserved capital: ${cancelled.join(", ")}`);
  }

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
  const { report, verdicts, tradePlans, parseWarning } = await analyzeFlash(candidates, recentHistory);
  logStage("Deep analysis (Claude)", t);

  if (parseWarning) {
    console.warn(`Flash scan parse warning: ${parseWarning}`);
  }

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
    const mcByToken = new Map(candidates.map((c) => [c.tokenAddress, c.marketCapUsd]));
    await recordAlerts(
      "flash",
      verdicts.map((v) => ({ ...v, marketCapUsdAtAlert: mcByToken.get(v.tokenAddress) }))
    );
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
    const openResult = await openPositionsFromTradePlans(safePlans, candidates);
    console.log(`Opened ${openResult.opened.length} of ${safePlans.length} proposed flash trade plan(s) in data/ledger.json.`);
    for (const skip of openResult.skipped) {
      console.log(`  [ledger] skipped ${skip.symbol}: ${skip.reason}`);
    }
    // Flash is speed-first: try the fill right now rather than leaving an IMMEDIATE entry
    // to wait up to 5-10 minutes for the next independent Checks cron tick, by which point
    // the move it's meant to catch may already be over.
    await attemptImmediateFills(safePlans.map((p) => p.tokenAddress));
  }

  await warnIfPlansMissing(verdicts, tradePlans.length, "flash scan");

  logStage("TOTAL", runStart);
}

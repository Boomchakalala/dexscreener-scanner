import { analyzeCandidates, analyzeFlash, type DiscoveryFunnel } from "./analysis.js";
import { config } from "./config.js";
import {
  addTradeability,
  discoverCandidates,
  enrichCandidatesForFlash,
  enrichWithCandles,
  enrichWithRugCheck,
  excludeDangerRisks,
  toCandidate,
} from "./discovery.js";
import { getGeckoStats, getPool, resetGeckoStats } from "./gecko.js";
import { loadLedger, openPositionsFromTradePlans } from "./ledger.js";
import { getMarketOverview } from "./marketOverview.js";
import { rankByQuality } from "./scoring.js";
import { getRecentAlertHistory, recordAlerts, type AlertHistoryEntry } from "./state.js";
import { sendTelegramMessage } from "./telegram.js";
import { mergeWatchConditions } from "./watchlist.js";
import type { Candidate } from "./types.js";

function now(): number {
  return Date.now();
}

/** Tokens we recently called are followed to conclusion regardless of what current
 *  discovery filters think of them — the suffix-only pump.fun gate famously excluded
 *  PCAT, the user's own favorite live call, one scan after it was made. Grandfathered
 *  tokens get force-fetched, flagged `tracked`, and take ADDITIONAL batch slots on top
 *  of fresh discovery (an earlier version let 10 tracked tokens crowd fresh candidates
 *  down to 2 slots, which read as "nothing qualifies tonight"). Scope, per the user:
 *  live paper positions + the last 2-3 REC/PUNT calls, hard-capped at 4 total. */
const MAX_TRACKED = 4;

async function getTrackedTokens(recentHistory: AlertHistoryEntry[]): Promise<{ tokenAddress: string; poolAddress: string }[]> {
  const nowMs = Date.now();
  const DAY = 24 * 3600 * 1000;
  const out = new Map<string, string>();

  const ledger = await loadLedger();
  for (const p of ledger.positions) {
    const live = p.status === "PENDING_ENTRY" || p.status === "OPEN" || p.status === "TP1_TAKEN";
    if (live) out.set(p.tokenAddress, p.poolAddress);
  }

  // Most recent REC/PUNT calls fill the remaining slots (newest first).
  const calls = recentHistory
    .filter((h) => nowMs - h.alertedAt < DAY && (h.verdict === "RECOMMENDATION" || h.verdict === "SPECULATIVE PUNT"))
    .sort((a, b) => b.alertedAt - a.alertedAt);
  for (const h of calls) {
    if (out.size >= MAX_TRACKED) break;
    if (!out.has(h.tokenAddress)) out.set(h.tokenAddress, h.poolAddress);
  }

  return [...out].slice(0, MAX_TRACKED).map(([tokenAddress, poolAddress]) => ({ tokenAddress, poolAddress }));
}

/** Marks in-shortlist tracked tokens and force-fetches the ones discovery dropped. */
async function withTrackedTokens(shortlist: Candidate[], recentHistory: AlertHistoryEntry[]): Promise<Candidate[]> {
  const tracked = await getTrackedTokens(recentHistory);
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

export interface PreviousCall {
  symbol: string;
  tokenAddress: string;
  firstCalledHoursAgo: number;
  callTrajectory: string;
  mcAtFirstCallUsd: number | null;
  paperStatus: string | null;
}

/** Deterministic then-vs-now context for every recent call — fed to Claude so IT writes
 *  the "PREVIOUS CALLS UPDATE" report section from real numbers (paper status, MC at
 *  call, verdict trajectory) instead of us bolting a stats block onto its prose. Covers
 *  tokens with a paper position or a REC/PUNT verdict from the last 24h. */
async function buildPreviousCalls(recentHistory: AlertHistoryEntry[]): Promise<PreviousCall[]> {
  const nowMs = Date.now();
  const DAY = 24 * 3600 * 1000;

  const paperStatusByToken = new Map<string, { status: string; createdAt: number }>();
  const ledger = await loadLedger();
  for (const p of ledger.positions) {
    if (nowMs - p.createdAt > DAY) continue;
    const prev = paperStatusByToken.get(p.tokenAddress);
    if (prev && prev.createdAt >= p.createdAt) continue;
    let status: string;
    if (p.status === "PENDING_ENTRY") {
      const minutesLeft = Math.max(0, Math.round((p.createdAt + p.entryCondition.validityWindowMinutes * 60_000 - nowMs) / 60_000));
      status = `waiting for entry trigger (${minutesLeft}m left)`;
    } else if (p.status === "MISSED") {
      status = "entry never triggered (missed)";
    } else if (p.status === "OPEN") {
      status = `position OPEN from $${p.entryPrice}`;
    } else if (p.status === "TP1_TAKEN") {
      status = `runner after TP1, realized ${p.realizedPnlSol.toFixed(3)} SOL`;
    } else {
      status = `closed, P&L ${p.realizedPnlSol.toFixed(3)} SOL`;
    }
    paperStatusByToken.set(p.tokenAddress, { status, createdAt: p.createdAt });
  }

  // A token that earned a REC/PUNT call stays on the radar even after a later downgrade —
  // "you told me to punt this, what happened next" is the question this answers, and
  // hiding a pick the moment it turned AVOID was how PCAT vanished right when it mattered.
  const byToken = new Map<string, AlertHistoryEntry[]>();
  for (const h of recentHistory) {
    if (nowMs - h.alertedAt > DAY) continue;
    (byToken.get(h.tokenAddress) ?? byToken.set(h.tokenAddress, []).get(h.tokenAddress)!).push(h);
  }

  const calls: PreviousCall[] = [];
  for (const [tokenAddress, entries] of byToken) {
    entries.sort((a, b) => a.alertedAt - b.alertedAt);
    const firstCall = entries.find((h) => h.verdict === "RECOMMENDATION" || h.verdict === "SPECULATIVE PUNT");
    const paper = paperStatusByToken.get(tokenAddress);
    if (!firstCall && !paper) continue;
    const anchor = firstCall ?? entries[0]!;
    const trajectory = entries.map((h) => h.verdict).join(" -> ");
    calls.push({
      symbol: anchor.symbol,
      tokenAddress,
      firstCalledHoursAgo: Number(((nowMs - anchor.alertedAt) / 3_600_000).toFixed(1)),
      callTrajectory: trajectory,
      mcAtFirstCallUsd: anchor.marketCapUsdAtAlert ?? null,
      paperStatus: paper?.status ?? null,
    });
  }

  // Paper positions whose token never got a history entry (e.g. history commit lost).
  for (const [tokenAddress, paper] of paperStatusByToken) {
    if (calls.some((c) => c.tokenAddress === tokenAddress)) continue;
    const position = ledger.positions.find((p) => p.tokenAddress === tokenAddress)!;
    calls.push({
      symbol: position.symbol,
      tokenAddress,
      firstCalledHoursAgo: Number(((nowMs - position.createdAt) / 3_600_000).toFixed(1)),
      callTrajectory: position.tier,
      mcAtFirstCallUsd: position.entrySnapshot.marketCapUsd ?? null,
      paperStatus: paper.status,
    });
  }

  // Same scope as tracked-in-batch: the reader wants the last few calls followed, not a
  // ten-line ledger dump — live-position tokens first, then most recent calls, cap 4.
  const liveTokens = new Set(
    ledger.positions
      .filter((p) => p.status === "PENDING_ENTRY" || p.status === "OPEN" || p.status === "TP1_TAKEN")
      .map((p) => p.tokenAddress)
  );
  return calls
    .sort((a, b) => {
      const aLive = liveTokens.has(a.tokenAddress) ? 0 : 1;
      const bLive = liveTokens.has(b.tokenAddress) ? 0 : 1;
      return aLive - bLive || a.firstCalledHoursAgo - b.firstCalledHoursAgo;
    })
    .slice(0, MAX_TRACKED);
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
  const workset = await withTrackedTokens(shortlist, recentHistory);

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
  let topCandidates = await addTradeability([...freshCut, ...trackedInBatch]);
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
  const previousCalls = await buildPreviousCalls(recentHistory);
  const { report, verdicts, watchConditions, tradePlans, parseWarning } = await analyzeCandidates(
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
    await openPositionsFromTradePlans(safePlans, candidates);
    console.log(`Opened ${safePlans.length} new PENDING_ENTRY position(s) from flash (subject to sizing/dedup rules) in data/ledger.json.`);
  }

  await warnIfPlansMissing(verdicts, tradePlans.length, "flash scan");

  logStage("TOTAL", runStart);
}

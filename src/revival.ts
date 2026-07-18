import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import type { Candidate } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, "..", "data", "token-history.json");

// The one thing no discovery API hands you: a memory of tokens that used to be relevant
// and have since aged out of trending/new-pool feeds. GeckoTerminal/Jupiter only tell you
// what's hot RIGHT NOW — a token that quietly rebuilds for a week is invisible to every
// feed this scanner queries unless it happens to re-trend on its own. This module persists
// a lightweight census of every token discovery has ever floor-passed, so it can be
// re-checked later instead of being forgotten the moment it's no longer fresh.
export interface TokenHistoryEntry {
  tokenAddress: string;
  poolAddress: string;
  chainId: string;
  symbol: string;
  firstSeenAt: number;
  lastCheckedAt: number;
  /** Lowest market cap ever observed for this token — its own genuine base, used as the
   *  "price above recent base" reference instead of an arbitrary fixed level. */
  lowestMarketCapUsd: number;
  timesChecked: number;
}

async function loadHistory(): Promise<TokenHistoryEntry[]> {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, "utf-8")) as TokenHistoryEntry[];
  } catch {
    return [];
  }
}

async function saveHistory(entries: TokenHistoryEntry[]): Promise<void> {
  await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(entries, null, 2));
}

const REVIVAL_RECHECK_AFTER_HOURS = 12; // don't re-check something looked at this recently
const MAX_REVIVAL_CHECKS_PER_RUN = 15; // bounds the extra GeckoTerminal calls this adds —
// this project has already hit a real 429 wall pushing raw-scan pagination too far, so
// revival re-checks are capped and rotate through the backlog rather than checking everything

/** Upserts every floor-surviving candidate from this run into the persisted history — no
 *  extra API calls, just bookkeeping on data discovery already fetched. Prunes entries past
 *  config.floors.maxAgeHours (the same ceiling passesFloors enforces on a re-fetched revival
 *  candidate) — no point retaining, or spending a re-check API call on, an entry that could
 *  never pass the floor again regardless of how it's performing. */
export async function recordSeenCandidates(candidates: Candidate[]): Promise<void> {
  const now = Date.now();
  const history = await loadHistory();
  const byToken = new Map(history.map((e) => [e.tokenAddress, e]));

  for (const c of candidates) {
    const existing = byToken.get(c.tokenAddress);
    if (existing) {
      existing.lastCheckedAt = now;
      existing.symbol = c.symbol;
      existing.poolAddress = c.poolAddress;
      existing.timesChecked += 1;
      if (c.marketCapUsd > 0 && c.marketCapUsd < existing.lowestMarketCapUsd) {
        existing.lowestMarketCapUsd = c.marketCapUsd;
      }
    } else {
      byToken.set(c.tokenAddress, {
        tokenAddress: c.tokenAddress,
        poolAddress: c.poolAddress,
        chainId: c.chainId,
        symbol: c.symbol,
        firstSeenAt: now,
        lastCheckedAt: now,
        lowestMarketCapUsd: c.marketCapUsd,
        timesChecked: 1,
      });
    }
  }

  const cutoff = now - config.floors.maxAgeHours * 60 * 60 * 1000;
  const pruned = [...byToken.values()].filter((e) => e.firstSeenAt >= cutoff);
  await saveHistory(pruned);
}

/** Picks a small, bounded batch of aged history entries due for a revival re-check —
 *  oldest-checked first, so coverage rotates through the backlog instead of always
 *  re-checking the same handful. Excludes anything already in today's fresh discovery
 *  (no point re-fetching what's already in hand) and anything still inside the FRESH/ACTIVE
 *  window (that's discovery's own job, not revival's). */
export async function getRevivalRecheckBatch(excludeTokens: Set<string>): Promise<TokenHistoryEntry[]> {
  const now = Date.now();
  const history = await loadHistory();
  const due = history.filter((e) => {
    if (excludeTokens.has(e.tokenAddress)) return false;
    const ageHours = (now - e.firstSeenAt) / 3_600_000;
    if (ageHours < 12) return false;
    const hoursSinceCheck = (now - e.lastCheckedAt) / 3_600_000;
    return hoursSinceCheck >= REVIVAL_RECHECK_AFTER_HOURS;
  });
  return due.sort((a, b) => a.lastCheckedAt - b.lastCheckedAt).slice(0, MAX_REVIVAL_CHECKS_PER_RUN);
}

/** The actual revival signal: real volume acceleration (not just "still exists"), buyers
 *  genuinely growing (not the same wallets churning), and market cap meaningfully above the
 *  lowest point this token has ever shown — its own base, not an arbitrary fixed %.
 *  Liquidity/MC/age/liveliness floors are still enforced separately by discovery's normal
 *  passesFloors on the resulting candidate. */
export function looksLikeRevival(candidate: Candidate, history: TokenHistoryEntry): boolean {
  const h6HourlyAvg = candidate.volumeH6Usd / 6;
  const volumeAccelerating = h6HourlyAvg > 0 && candidate.volumeH1Usd / h6HourlyAvg >= 2.5;

  const h6HourlyBuyers = candidate.txnsH6.buyers / 6;
  const buyersGrowing = h6HourlyBuyers > 0 && candidate.txnsH1.buyers / h6HourlyBuyers >= 1.2;

  const aboveOwnBase = history.lowestMarketCapUsd > 0 && candidate.marketCapUsd >= history.lowestMarketCapUsd * 1.3;

  return volumeAccelerating && buyersGrowing && aboveOwnBase;
}

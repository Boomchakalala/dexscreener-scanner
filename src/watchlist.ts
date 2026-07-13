import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WatchCondition } from "./analysis.js";
import type { Candidate } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST_DIR = path.join(__dirname, "..", "data");
const WATCHLIST_FILE = path.join(WATCHLIST_DIR, "watchlist.json");

/** Pure condition data — written ONLY by the deep scan. The checker's runtime progress
 *  (prior volume reading, already-fired flag) lives in data/watchlist-state.json instead,
 *  written only by the checks run, so the two writers never touch the same file. */
export interface WatchlistEntry {
  symbol: string;
  tokenAddress: string;
  poolAddress: string;
  chainId: string;
  dexUrl: string;
  condition: WatchCondition["condition"];
  addedAt: number; // ms epoch
  expiresAt: number; // ms epoch
}

interface WatchlistState {
  entries: WatchlistEntry[];
}

async function loadWatchlist(): Promise<WatchlistState> {
  try {
    const raw = await readFile(WATCHLIST_FILE, "utf-8");
    return JSON.parse(raw) as WatchlistState;
  } catch {
    return { entries: [] };
  }
}

async function saveWatchlist(state: WatchlistState): Promise<void> {
  await mkdir(WATCHLIST_DIR, { recursive: true });
  await writeFile(WATCHLIST_FILE, JSON.stringify(state, null, 2));
}

export async function loadWatchlistEntries(): Promise<WatchlistEntry[]> {
  return (await loadWatchlist()).entries;
}

/** Merges newly-emitted watch conditions from a deep scan into data/watchlist.json —
 *  drops expired entries, and replaces any existing entry for the same token (a fresh
 *  scan's condition supersedes a stale one) rather than accumulating duplicates. Only
 *  conditions for tokens that were actually analyzed this run are kept, guarding against
 *  a mismatched/hallucinated address that never appeared in this run's candidates. */
export async function mergeWatchConditions(conditions: WatchCondition[], candidates: Candidate[]): Promise<void> {
  const now = Date.now();
  const state = await loadWatchlist();

  const stillValid = state.entries.filter((entry) => entry.expiresAt > now);

  const candidateByToken = new Map(candidates.map((c) => [c.tokenAddress, c]));
  const fresh: WatchlistEntry[] = [];
  for (const cond of conditions) {
    const candidate = candidateByToken.get(cond.tokenAddress);
    if (!candidate) continue;
    fresh.push({
      symbol: cond.symbol,
      tokenAddress: cond.tokenAddress,
      poolAddress: cond.poolAddress,
      chainId: candidate.chainId,
      dexUrl: candidate.dexUrl,
      condition: cond.condition,
      addedAt: now,
      expiresAt: now + Math.max(1, cond.validUntilHours) * 60 * 60 * 1000,
    });
  }

  const freshTokens = new Set(fresh.map((e) => e.tokenAddress));
  const carried = stillValid.filter((entry) => !freshTokens.has(entry.tokenAddress));

  await saveWatchlist({ entries: [...carried, ...fresh] });
}

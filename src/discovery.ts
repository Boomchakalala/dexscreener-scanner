import { config } from "./config.js";
import { getHourlyCandles, getMinuteCandles, getNewPools, getPoolsByVolume, getTrendingPools } from "./gecko.js";
import { getTradeability } from "./jupiter.js";
import { getJupiterCandidates, getLaunchpad } from "./jupiterTokens.js";
import { getRugCheckReport } from "./rugcheck.js";
import { rankByChartProxy } from "./scoring.js";
import type { Candidate, GeckoPool } from "./types.js";

function extractTokenAddress(relationshipId: string): string {
  const idx = relationshipId.indexOf("_");
  return idx === -1 ? relationshipId : relationshipId.slice(idx + 1);
}

function ageHours(pool: GeckoPool): number | null {
  if (!pool.attributes.pool_created_at) return null;
  return (Date.now() - new Date(pool.attributes.pool_created_at).getTime()) / (1000 * 60 * 60);
}

export function toCandidate(network: string, pool: GeckoPool): Candidate | null {
  const attrs = pool.attributes;
  const marketCapUsd = Number(attrs.market_cap_usd ?? attrs.fdv_usd ?? 0);
  const liquidityUsd = Number(attrs.reserve_in_usd ?? 0);
  if (!marketCapUsd || !liquidityUsd) return null;

  const symbol = pool.attributes.name.split("/")[0]?.trim() || pool.attributes.name;
  const txnsH1 = attrs.transactions.h1 ?? { buys: 0, sells: 0, buyers: 0, sellers: 0 };
  const txnsH6 = attrs.transactions.h6 ?? { buys: 0, sells: 0, buyers: 0, sellers: 0 };

  return {
    chainId: network,
    poolAddress: attrs.address,
    tokenAddress: extractTokenAddress(pool.relationships.base_token.data.id),
    symbol,
    dexUrl: `https://dexscreener.com/${network}/${attrs.address}`,
    ageHours: ageHours(pool),
    marketCapUsd,
    liquidityUsd,
    volume24hUsd: Number(attrs.volume_usd.h24 ?? 0),
    volumeH1Usd: Number(attrs.volume_usd.h1 ?? 0),
    volumeH6Usd: Number(attrs.volume_usd.h6 ?? 0),
    priceChangeM5: attrs.price_change_percentage.m5 ? Number(attrs.price_change_percentage.m5) : null,
    priceChangeH1: attrs.price_change_percentage.h1 ? Number(attrs.price_change_percentage.h1) : null,
    priceChangeH6: attrs.price_change_percentage.h6 ? Number(attrs.price_change_percentage.h6) : null,
    priceChangeH24: attrs.price_change_percentage.h24 ? Number(attrs.price_change_percentage.h24) : null,
    txnsH1,
    txnsH6,
    candles: [],
    rugCheck: null,
    tradeability: null,
    chartRank: null,
    qualityRank: null,
  };
}

function passesFloors(candidate: Candidate): boolean {
  const { floors } = config;
  return (
    candidate.marketCapUsd >= floors.minMarketCapUsd &&
    candidate.marketCapUsd <= floors.maxMarketCapUsd &&
    candidate.liquidityUsd >= floors.minLiquidityUsd &&
    (candidate.ageHours === null || candidate.ageHours <= floors.maxAgeHours) &&
    // Broad discovery (esp. "sorted by 24h volume") surfaces tokens whose entire
    // volume happened hours ago and have since gone dead. Require some actual
    // trading in the last hour so we're not analyzing (and reporting on) corpses.
    candidate.txnsH1.buys + candidate.txnsH1.sells >= 3
  );
}

export interface DiscoveryResult {
  rawCount: number;
  floorSurvivorCount: number;
  shortlist: Candidate[];
}

/** STAGE 1 (raw scan) + STAGE 1b (hard floors) + STAGE 2 (chart-proxy shortlist).
 *  Scans the widest reasonable universe first — trending, brand-new, and by-volume
 *  pools, several hundred raw pairs, not just the first ~100 — then applies only the
 *  hard sanity floors (market cap, liquidity, age, liveliness), then cuts to a
 *  shortlist using the chart-structure proxy (see scoring.ts). RugCheck plays no part
 *  in this function at all — that's a later, final gate, not a discovery filter. */
export async function discoverCandidates(): Promise<DiscoveryResult> {
  const seen = new Map<string, Candidate>();
  let rawCount = 0;

  for (const network of config.chains) {
    // new_pools goes FIRST and alone: it's the only source that reliably produces
    // in-window (0-24h) tokens — trending/by-volume are dominated by older pools the
    // age floor kills anyway — and GeckoTerminal's burst budget empties partway
    // through a run, so whatever queues last eats the 429s. Observed before this
    // ordering: the lost pages were new_pools ones, i.e. the losses were landing on
    // exactly the universe (Fresh Launches) the whole strategy prioritizes.
    const fresh = await getNewPools(network);
    const [trending, byVolume] = await Promise.all([getTrendingPools(network), getPoolsByVolume(network)]);

    const allPools = [...trending, ...fresh, ...byVolume];
    rawCount += allPools.length;

    for (const pool of allPools) {
      const candidate = toCandidate(network, pool);
      if (!candidate || !passesFloors(candidate)) continue;
      const existing = seen.get(candidate.poolAddress);
      if (!existing || candidate.volume24hUsd > existing.volume24hUsd) {
        seen.set(candidate.poolAddress, candidate);
      }
    }
  }

  // Second source: Jupiter's token API (keyless, entirely separate provider and rate
  // budget) — its top-traded/trending 1h lists surface hot small caps GeckoTerminal's
  // three lists miss. Same floors, same dedup; on collisions the higher-volume record wins.
  if (config.chains.includes("solana")) {
    const jupiterCandidates = await getJupiterCandidates();
    rawCount += jupiterCandidates.length;
    for (const candidate of jupiterCandidates) {
      if (!passesFloors(candidate)) continue;
      const existing = seen.get(candidate.poolAddress);
      if (!existing || candidate.volume24hUsd > existing.volume24hUsd) {
        seen.set(candidate.poolAddress, candidate);
      }
    }
  }

  // Cross-source dedup by token too: the same token can surface under different pool
  // addresses from different providers (Jupiter reports the token's first pool, Gecko
  // whatever pool made its list) — keep whichever record shows more recent trading.
  const byToken = new Map<string, Candidate>();
  for (const candidate of seen.values()) {
    const existing = byToken.get(candidate.tokenAddress);
    if (!existing || candidate.volumeH1Usd > existing.volumeH1Usd) {
      byToken.set(candidate.tokenAddress, candidate);
    }
  }

  let floorSurvivors = [...byToken.values()];
  if (config.pumpFunOnly) {
    floorSurvivors = await filterPumpFunOnly(floorSurvivors);
  }
  const shortlist = rankByChartProxy(floorSurvivors, config.floors.maxShortlist);

  return { rawCount, floorSurvivorCount: floorSurvivors.length, shortlist };
}

/** pump.fun-only launchpad gate. The "pump" address suffix is sufficient but NOT
 *  necessary — PCAT is a genuine pump.fun mint without it (verified live), and the
 *  suffix-only version of this gate excluded it one scan after it was the user's best
 *  call. Non-suffix tokens get an authoritative launchpad lookup from Jupiter (own
 *  cache, separate rate budget); only confirmed pump.fun survives. */
async function filterPumpFunOnly(candidates: Candidate[]): Promise<Candidate[]> {
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.tokenAddress.endsWith("pump") || candidate.launchpad === "pump.fun") {
      kept.push(candidate);
      continue;
    }
    const launchpad = candidate.launchpad ?? (await getLaunchpad(candidate.tokenAddress));
    if (launchpad === "pump.fun") {
      kept.push(candidate);
    } else {
      console.log(`  [launchpad] dropping ${candidate.symbol} (${launchpad ?? "unknown"} launchpad, pump.fun-only mode)`);
    }
  }
  return kept;
}

/** STAGE 3 enrichment — real hourly candles only, for the chart-shortlisted batch.
 *  Deliberately no RugCheck here: quality ranking (scoring.rankByQuality) runs on this
 *  before RugCheck is ever fetched, so safety data can't influence which candidates
 *  reach the deep-review batch. */
export async function enrichWithCandles(candidates: Candidate[]): Promise<Candidate[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      const candles = await getHourlyCandles(candidate.chainId, candidate.poolAddress).catch(() => []);
      return { ...candidate, candles };
    })
  );
}

/** STAGE 4 — RugCheck as the FINAL filter, fetched only for the small deep-analyze
 *  batch that already has an attractive chart and healthy trading behaviour behind it. */
export async function enrichWithRugCheck(candidates: Candidate[]): Promise<Candidate[]> {
  return Promise.all(
    candidates.map(async (candidate) => ({ ...candidate, rugCheck: await getRugCheckReport(candidate.tokenAddress) }))
  );
}

/** Hard code-level exclusion for RugCheck danger-level risks (LP unlocked, honeypot-style
 *  authority flags, etc.) — not a prompt instruction Claude could get talked out of, a
 *  token with a real material risk is physically removed before the LLM ever sees it.
 *  Applied only after chart + quality ranking, per the "RugCheck is the final filter,
 *  reject only for material risks" rule — never used to eliminate candidates earlier. */
/** Danger-level RugCheck flags Claude is allowed to weigh (with the flag in front of it)
 *  instead of the token being auto-excluded before any judgment. Chosen from the first
 *  day of named-exclusion logs, where these killed most of every batch:
 *  - "Low Liquidity": we already gate liquidity ourselves with a hard floor AND a real
 *    Jupiter route quote — RugCheck's cruder version shouldn't hold a veto over both.
 *  - "Large Amount of LP Unlocked": endemic on pump.fun-era pools; a real risk worth
 *    naming and sizing down for, not an automatic death sentence for the whole class.
 *  - Ownership-concentration flags: Claude already receives the top-holder table and the
 *    prompt's pump.fun bonding-curve caveats — it can judge concentration in context.
 *  Anything NOT on this list (creator rug history, mint/freeze authority, honeypot-style
 *  flags, and any flag we haven't seen yet) still hard-excludes — unknown stays unsafe. */
const ADVISORY_DANGER_RISKS = new Set([
  "Low Liquidity",
  "Large Amount of LP Unlocked",
  "High ownership",
  "Top 10 holders high ownership",
]);

export function excludeDangerRisks(candidates: Candidate[]): Candidate[] {
  return candidates.filter((c) => {
    const dangers = c.rugCheck?.risks.filter((r) => r.level === "danger") ?? [];
    const material = dangers.filter((r) => !ADVISORY_DANGER_RISKS.has(r.name));
    if (material.length > 0) {
      console.log(`  [rugcheck] excluding ${c.symbol} (${c.tokenAddress}): ${material.map((r) => r.name).join(", ")}`);
      return false;
    }
    if (dangers.length > 0) {
      console.log(`  [rugcheck] keeping ${c.symbol} despite advisory flag(s): ${dangers.map((r) => r.name).join(", ")} — Claude weighs these`);
    }
    return true;
  });
}

/** Real Jupiter route quote (price impact, hop count) for a ~0.5 SOL buy — only worth the
 *  extra calls on the final shortlist that's actually going to Claude, not every survivor. */
export async function addTradeability(candidates: Candidate[]): Promise<Candidate[]> {
  return Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      tradeability: await getTradeability(candidate.tokenAddress),
    }))
  );
}

/** Lighter enrichment for the flash check: short-window candles only, no rug check (speed over full vetting). */
export async function enrichCandidatesForFlash(candidates: Candidate[]): Promise<Candidate[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      const candles = await getMinuteCandles(candidate.chainId, candidate.poolAddress).catch(() => []);
      return { ...candidate, candles, rugCheck: null };
    })
  );
}

import { config } from "./config.js";
import { getHourlyCandles, getMinuteCandles, getNewPools, getPoolsByVolume, getTrendingPools } from "./gecko.js";
import { getTradeability } from "./jupiter.js";
import { getRugCheckReport } from "./rugcheck.js";
import type { Candidate, GeckoPool } from "./types.js";

function extractTokenAddress(relationshipId: string): string {
  const idx = relationshipId.indexOf("_");
  return idx === -1 ? relationshipId : relationshipId.slice(idx + 1);
}

function ageHours(pool: GeckoPool): number | null {
  if (!pool.attributes.pool_created_at) return null;
  return (Date.now() - new Date(pool.attributes.pool_created_at).getTime()) / (1000 * 60 * 60);
}

function toCandidate(network: string, pool: GeckoPool): Candidate | null {
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
  survivors: Candidate[];
}

export async function discoverCandidates(): Promise<DiscoveryResult> {
  const seen = new Map<string, Candidate>();
  let rawCount = 0;

  for (const network of config.chains) {
    const [trending, fresh, byVolume] = await Promise.all([
      getTrendingPools(network),
      getNewPools(network),
      getPoolsByVolume(network),
    ]);

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

  // Sort by recent (1h) volume, not liquidity — a liquidity-sort systematically
  // excludes exactly the thin-but-hot tokens this scanner exists to catch (a fresh
  // pump.fun-style token can do $500K+ in 1h volume on $30-40K of liquidity).
  const survivors = [...seen.values()]
    .sort((a, b) => b.volumeH1Usd - a.volumeH1Usd)
    .slice(0, config.floors.maxSurvivors);

  return { rawCount, survivors };
}

export async function enrichCandidates(candidates: Candidate[]): Promise<Candidate[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      const [candles, rugCheck] = await Promise.all([
        getHourlyCandles(candidate.chainId, candidate.poolAddress).catch(() => []),
        getRugCheckReport(candidate.tokenAddress),
      ]);
      return { ...candidate, candles, rugCheck };
    })
  );
}

/** Hard code-level exclusion for RugCheck danger-level risks (LP unlocked, etc.) —
 *  not a prompt instruction Claude could get talked out of, a token with a real
 *  danger flag is physically removed before the LLM ever sees it. */
export function excludeDangerRisks(candidates: Candidate[]): Candidate[] {
  return candidates.filter((c) => !c.rugCheck?.risks.some((r) => r.level === "danger"));
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

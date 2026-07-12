import { config } from "./config.js";
import { getHourlyCandles, getMinuteCandles, getNewPools, getPoolsByVolume, getTrendingPools } from "./gecko.js";
import { getRugCheckReport } from "./rugcheck.js";
import type { Candidate, GeckoPool } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    priceChangeH6: attrs.price_change_percentage.h6 ? Number(attrs.price_change_percentage.h6) : null,
    priceChangeH24: attrs.price_change_percentage.h24 ? Number(attrs.price_change_percentage.h24) : null,
    txnsH1,
    txnsH6,
    candles: [],
    rugCheck: null,
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

export async function discoverCandidates(): Promise<Candidate[]> {
  const seen = new Map<string, Candidate>();

  for (const network of config.chains) {
    const [trending, fresh, byVolume] = await Promise.all([
      getTrendingPools(network),
      getNewPools(network),
      getPoolsByVolume(network),
    ]);

    for (const pool of [...trending, ...fresh, ...byVolume]) {
      const candidate = toCandidate(network, pool);
      if (!candidate || !passesFloors(candidate)) continue;
      const existing = seen.get(candidate.poolAddress);
      if (!existing || candidate.volume24hUsd > existing.volume24hUsd) {
        seen.set(candidate.poolAddress, candidate);
      }
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    .slice(0, config.floors.maxCandidates);
}

export async function enrichCandidates(candidates: Candidate[]): Promise<Candidate[]> {
  const enriched: Candidate[] = [];
  for (const candidate of candidates) {
    const [candles, rugCheck] = await Promise.all([
      getHourlyCandles(candidate.chainId, candidate.poolAddress).catch(() => []),
      getRugCheckReport(candidate.tokenAddress),
    ]);
    enriched.push({ ...candidate, candles, rugCheck });
    await sleep(300);
  }
  return enriched;
}

/** Lighter enrichment for the flash check: short-window candles only, no rug check (speed over full vetting). */
export async function enrichCandidatesForFlash(candidates: Candidate[]): Promise<Candidate[]> {
  const enriched: Candidate[] = [];
  for (const candidate of candidates) {
    const candles = await getMinuteCandles(candidate.chainId, candidate.poolAddress).catch(() => []);
    enriched.push({ ...candidate, candles, rugCheck: null });
  }
  return enriched;
}

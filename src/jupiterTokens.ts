import type { Candidate } from "./types.js";

// Jupiter's token API (lite tier: keyless, separate provider and rate budget from
// GeckoTerminal entirely) — the second discovery source. toptraded/1h and toptrending/1h
// surface exactly the hot-right-now small caps the universes hunt; a live probe on a
// quiet night found 4 in-window tokens here when GeckoTerminal's entire floor-surviving
// universe was 11. (DexScreener was considered first but has no public new-pairs feed —
// only paid-promotion profile/boost endpoints, which this project deliberately avoids.)
const BASE_URL = "https://lite-api.jup.ag/tokens/v2";
const REQUEST_TIMEOUT_MS = 8_000;

interface JupiterTokenStats {
  priceChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
}

export interface JupiterToken {
  id: string;
  symbol?: string;
  name?: string;
  mcap?: number;
  fdv?: number;
  liquidity?: number;
  launchpad?: string;
  holderCount?: number;
  /** Jupiter's 0-100 activity-quality metric — low with big volume smells like wash/bots. */
  organicScore?: number;
  firstPool?: { id?: string; createdAt?: string };
  stats5m?: JupiterTokenStats;
  stats1h?: JupiterTokenStats;
  stats6h?: JupiterTokenStats;
  stats24h?: JupiterTokenStats;
}

function toCandidate(t: JupiterToken): Candidate | null {
  const poolAddress = t.firstPool?.id;
  const marketCapUsd = t.mcap ?? t.fdv ?? 0;
  const liquidityUsd = t.liquidity ?? 0;
  if (!poolAddress || !marketCapUsd || !liquidityUsd) return null;

  const createdAt = t.firstPool?.createdAt;
  const ageHours = createdAt ? (Date.now() - new Date(createdAt).getTime()) / 3_600_000 : null;

  const s5 = t.stats5m ?? {};
  const s1 = t.stats1h ?? {};
  const s6 = t.stats6h ?? {};
  const s24 = t.stats24h ?? {};
  const vol = (s: JupiterTokenStats) => (s.buyVolume ?? 0) + (s.sellVolume ?? 0);
  const txns = (s: JupiterTokenStats) => ({
    buys: s.numBuys ?? 0,
    sells: s.numSells ?? 0,
    // Jupiter exposes total unique traders, not a buyer/seller split — report the total on
    // both sides so ratio-based heuristics see a neutral 1:1 rather than a fake imbalance.
    buyers: s.numTraders ?? 0,
    sellers: s.numTraders ?? 0,
  });

  return {
    chainId: "solana",
    poolAddress,
    tokenAddress: t.id,
    launchpad: t.launchpad,
    holderCount: t.holderCount ?? null,
    organicScore: t.organicScore ?? null,
    symbol: t.symbol || t.name || t.id.slice(0, 6),
    dexUrl: `https://dexscreener.com/solana/${poolAddress}`,
    ageHours,
    marketCapUsd,
    liquidityUsd,
    volume24hUsd: vol(s24),
    volumeH1Usd: vol(s1),
    volumeH6Usd: vol(s6),
    priceChangeM5: s5.priceChange ?? null,
    priceChangeH1: s1.priceChange ?? null,
    priceChangeH6: s6.priceChange ?? null,
    priceChangeH24: s24.priceChange ?? null,
    txnsH1: txns(s1),
    txnsH6: txns(s6),
    candles: [],
    rugCheck: null,
    tradeability: null,
    chartRank: null,
    qualityRank: null,
  };
}

async function fetchCategory(category: string): Promise<JupiterToken[]> {
  try {
    const res = await fetch(`${BASE_URL}/${category}?limit=100`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`  [jupiter] ${category} fetch failed: ${res.status} ${res.statusText}`);
      return [];
    }
    const data = (await res.json()) as JupiterToken[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`  [jupiter] ${category} fetch failed: ${(err as Error).message}`);
    return [];
  }
}

/** Best-effort: discovery must never crash because one source is down. */
export async function getJupiterCandidates(): Promise<Candidate[]> {
  const [trending, traded] = await Promise.all([fetchCategory("toptrending/1h"), fetchCategory("toptraded/1h")]);
  const candidates = [...trending, ...traded].map(toCandidate).filter((c): c is Candidate => c !== null);
  console.log(`  [jupiter] second-source discovery: ${trending.length + traded.length} tokens fetched, ${candidates.length} mappable.`);
  return candidates;
}

const tokenMetaCache = new Map<string, Promise<JupiterToken | null>>();

/** Cached single-token metadata lookup (launchpad, holderCount, organicScore, ...). */
export function searchToken(mintAddress: string): Promise<JupiterToken | null> {
  let pending = tokenMetaCache.get(mintAddress);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch(`${BASE_URL}/search?query=${mintAddress}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!res.ok) return null;
        const data = (await res.json()) as JupiterToken[];
        return data[0] ?? null;
      } catch {
        return null;
      }
    })();
    tokenMetaCache.set(mintAddress, pending);
  }
  return pending;
}

/** Authoritative launchpad lookup — the address vanity suffix alone is NOT reliable
 *  (PCAT is a genuine pump.fun mint without the "pump" suffix, verified live). */
export async function getLaunchpad(mintAddress: string): Promise<string | null> {
  return (await searchToken(mintAddress))?.launchpad ?? null;
}

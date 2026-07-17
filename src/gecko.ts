import type { GeckoPool, GeckoPoolAttributes, OhlcvCandle } from "./types.js";

const BASE_URL = "https://api.geckoterminal.com/api/v2";
// A bounded-concurrency pool (no fixed delay) hit 429s reliably, even on a fresh
// GitHub Actions IP — GeckoTerminal's real sustained free-tier limit is tighter than
// that can safely exploit. Back to a serialized queue (the pattern that ran reliably
// all session), just with a shorter interval than the original 2.5s.
// A 24-page-per-run discovery test measured 91/110 requests hitting 429 even at this
// spacing — the limit reads as a short burst bucket, not a steady per-request rate, so
// total requests per run matters as much as spacing. Nudged up from 1800 for margin;
// the real fix was cutting total page count back down (see getTrendingPools etc below).
const REQUEST_SPACING_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let requestQueue: Promise<void> = Promise.resolve();

function throttle(): Promise<void> {
  const slot = requestQueue.then(() => sleep(REQUEST_SPACING_MS));
  requestQueue = slot;
  return slot;
}

interface GeckoStats {
  requestCount: number;
  totalTimeMs: number;
  retryCount: number;
  rateLimitCount: number;
  timeoutCount: number;
  slowest: { path: string; ms: number } | null;
}

let stats: GeckoStats = { requestCount: 0, totalTimeMs: 0, retryCount: 0, rateLimitCount: 0, timeoutCount: 0, slowest: null };

export function resetGeckoStats(): void {
  stats = { requestCount: 0, totalTimeMs: 0, retryCount: 0, rateLimitCount: 0, timeoutCount: 0, slowest: null };
}

export function getGeckoStats(): Readonly<GeckoStats & { spacingMs: number }> {
  return { ...stats, spacingMs: REQUEST_SPACING_MS };
}

async function get<T>(path: string, attempt = 0): Promise<T> {
  await throttle();
  const start = Date.now();
  stats.requestCount++;
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") stats.timeoutCount++;
    throw err;
  } finally {
    const elapsed = Date.now() - start;
    stats.totalTimeMs += elapsed;
    if (!stats.slowest || elapsed > stats.slowest.ms) stats.slowest = { path, ms: elapsed };
  }
  if (res.status === 429) {
    stats.rateLimitCount++;
    // Discovery pages degrade gracefully on failure now, so don't burn a minute-plus
    // retrying a single doomed page - a couple of quick attempts, then move on.
    if (attempt < 3) {
      stats.retryCount++;
      await sleep(1500 * 2 ** attempt);
      return get<T>(path, attempt + 1);
    }
  }
  if (!res.ok) {
    throw new Error(`GeckoTerminal request failed: ${path} -> ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function getPoolsPaginated(network: string, path: string, pages: number): Promise<GeckoPool[]> {
  const separator = path.includes("?") ? "&" : "?";
  const pageNumbers = Array.from({ length: pages }, (_, i) => i + 1);
  const results = await Promise.all(
    pageNumbers.map(async (page) => {
      try {
        const result = await get<{ data: GeckoPool[] }>(`/networks/${network}/${path}${separator}page=${page}`);
        return result.data;
      } catch (err) {
        // Discovery is best-effort — a single page failing (rate limit exhausted its
        // retries, pagination-depth cap, timeout, whatever) should never crash the whole
        // scan. Log it and move on with however many other pages did come through.
        console.warn(`  [gecko] page fetch failed, skipping: ${path}&page=${page} -> ${(err as Error).message}`);
        return [];
      }
    })
  );
  return results.flat();
}

// Discovery should scan wider than just "trending", but a live test at 24 total pages
// (4+10+10) lost most of its requests to 429s — the free tier's real burst budget is
// well short of that. 15 total pages is the compromise, weighted toward new_pools:
// it's the only source that reliably yields in-window (0-24h) tokens, while trending
// and by-volume mostly return older pools the age floor discards anyway. Candle
// enrichment downstream adds one more request per shortlisted candidate on the same
// limiter, so total requests-per-run (~15 + shortlist size) is what has to stay under
// budget, not any single stage's page count.

export async function getTrendingPools(network: string, pages = 3): Promise<GeckoPool[]> {
  return getPoolsPaginated(network, "trending_pools", pages);
}

export async function getNewPools(network: string, pages = 6): Promise<GeckoPool[]> {
  return getPoolsPaginated(network, "new_pools", pages);
}

/** Volume-sorted pools of ONE dex — used to feed directly from pump.fun's bonding-curve
 *  pools and pumpswap's fresh graduates, the exact universe this scanner hunts, instead
 *  of scanning the whole market and filtering 95% of it away. */
export async function getDexPools(network: string, dex: string, pages = 2): Promise<GeckoPool[]> {
  return getPoolsPaginated(network, `dexes/${dex}/pools?sort=h24_volume_usd_desc`, pages);
}

function parseOhlcv(result: { data: { attributes: { ohlcv_list: number[][] } } }): OhlcvCandle[] {
  return result.data.attributes.ohlcv_list
    .map(([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

export async function getHourlyCandles(network: string, poolAddress: string, limit = 48): Promise<OhlcvCandle[]> {
  const result = await get<{ data: { attributes: { ohlcv_list: number[][] } } }>(
    `/networks/${network}/pools/${poolAddress}/ohlcv/hour?limit=${limit}`
  );
  return parseOhlcv(result);
}

/** Short-window candles for catching momentum the hourly chart can't resolve. */
export async function getMinuteCandles(
  network: string,
  poolAddress: string,
  aggregate = 5,
  limit = 48
): Promise<OhlcvCandle[]> {
  const result = await get<{ data: { attributes: { ohlcv_list: number[][] } } }>(
    `/networks/${network}/pools/${poolAddress}/ohlcv/minute?aggregate=${aggregate}&limit=${limit}`
  );
  return parseOhlcv(result);
}

/** Full single-pool fetch (same shape as list results, so discovery's toCandidate can
 *  reuse it) — used to force-fetch previously-called tokens that current discovery
 *  filters would exclude, so they can be followed to conclusion. */
export async function getPool(network: string, poolAddress: string): Promise<GeckoPool | null> {
  try {
    const result = await get<{ data: GeckoPool }>(`/networks/${network}/pools/${poolAddress}`);
    return result.data;
  } catch (err) {
    console.warn(`  [gecko] single pool fetch failed: ${poolAddress} -> ${(err as Error).message}`);
    return null;
  }
}

export interface PoolStats {
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volumeH1Usd: number;
  volumeH6Usd: number;
  txnsH1: { buys: number; sells: number; buyers: number; sellers: number };
}

/** Single-pool lookup for the watchlist checker — a handful of specific pools every
 *  few minutes, not a broad scan. Runs from GitHub Actions' IPs (via the shared
 *  throttled queue above), deliberately not from Cloudflare Workers: GeckoTerminal's
 *  free tier 429'd every single request from Cloudflare's shared egress IPs even at
 *  this trivial volume, while GitHub Actions' IPs have run this scanner reliably all
 *  day at much higher volume. */
export async function getPoolStats(network: string, poolAddress: string): Promise<PoolStats | null> {
  try {
    const result = await get<{ data: { attributes: GeckoPoolAttributes } }>(`/networks/${network}/pools/${poolAddress}`);
    const attrs = result.data.attributes;
    const priceUsd = Number(attrs.base_token_price_usd ?? 0);
    const marketCapUsd = Number(attrs.market_cap_usd ?? attrs.fdv_usd ?? 0);
    // Do NOT gate on liquidityUsd here — GeckoTerminal routinely reports reserve_in_usd
    // as 0 for perfectly healthy pump.fun/pumpswap pools (same quirk discovery.ts works
    // around with `liquidityUnknown`). Nulling the whole stats object out over a bad
    // liquidity read was silently no-opping every entry/stop/TP/watchlist check for that
    // position on that tick — confirmed live: WATCH-tier positions sat with triggerHits
    // stuck at 0 across 6-10h validity windows (dozens of checks) despite plenty of price
    // movement, because a single 0-liquidity read makes this function bail out entirely.
    // Price and market cap are what every caller actually gates decisions on; liquidity is
    // informational here.
    const liquidityUsd = Number(attrs.reserve_in_usd ?? 0);
    if (!priceUsd || !marketCapUsd) return null;
    return {
      priceUsd,
      marketCapUsd,
      liquidityUsd,
      volumeH1Usd: Number(attrs.volume_usd.h1 ?? 0),
      volumeH6Usd: Number(attrs.volume_usd.h6 ?? 0),
      txnsH1: attrs.transactions.h1 ?? { buys: 0, sells: 0, buyers: 0, sellers: 0 },
    };
  } catch (err) {
    console.warn(`  [gecko] pool stats fetch failed, skipping: ${poolAddress} -> ${(err as Error).message}`);
    return null;
  }
}

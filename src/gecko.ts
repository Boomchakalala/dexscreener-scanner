import type { GeckoPool, OhlcvCandle } from "./types.js";

const BASE_URL = "https://api.geckoterminal.com/api/v2";
// A bounded-concurrency pool (no fixed delay) hit 429s reliably, even on a fresh
// GitHub Actions IP — GeckoTerminal's real sustained free-tier limit is tighter than
// that can safely exploit. Back to a serialized queue (the pattern that ran reliably
// all session), just with a shorter interval than the original 2.5s.
const REQUEST_SPACING_MS = 1200;
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

export function getGeckoStats(): Readonly<GeckoStats> {
  return stats;
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

export async function getTrendingPools(network: string, pages = 2): Promise<GeckoPool[]> {
  return getPoolsPaginated(network, "trending_pools", pages);
}

export async function getNewPools(network: string, pages = 6): Promise<GeckoPool[]> {
  return getPoolsPaginated(network, "new_pools", pages);
}

/** All active pools ranked by 24h volume — the broad net that catches tokens sitting in a
 *  market-cap band regardless of whether they're currently "trending" or brand new.
 *  GeckoTerminal's free tier caps this endpoint's pagination around page 10. */
export async function getPoolsByVolume(network: string, pages = 7): Promise<GeckoPool[]> {
  return getPoolsPaginated(network, "pools?sort=h24_volume_usd_desc", pages);
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

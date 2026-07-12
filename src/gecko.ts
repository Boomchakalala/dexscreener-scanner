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

async function get<T>(path: string, attempt = 0): Promise<T> {
  await throttle();
  const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 429 && attempt < 6) {
    await sleep(2000 * 2 ** attempt);
    return get<T>(path, attempt + 1);
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
        // GeckoTerminal's free tier hard-caps some endpoints' pagination depth (401 past
        // the limit, not a rate limit) - treat that page as empty rather than fail the run.
        if (err instanceof Error && err.message.includes("401")) return [];
        if (err instanceof Error && err.name === "TimeoutError") return [];
        throw err;
      }
    })
  );
  return results.flat();
}

export async function getTrendingPools(network: string, pages = 2): Promise<GeckoPool[]> {
  return getPoolsPaginated(network, "trending_pools", pages);
}

export async function getNewPools(network: string, pages = 10): Promise<GeckoPool[]> {
  return getPoolsPaginated(network, "new_pools", pages);
}

/** All active pools ranked by 24h volume — the broad net that catches tokens sitting in a
 *  market-cap band regardless of whether they're currently "trending" or brand new.
 *  GeckoTerminal's free tier caps this endpoint's pagination around page 10. */
export async function getPoolsByVolume(network: string, pages = 10): Promise<GeckoPool[]> {
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

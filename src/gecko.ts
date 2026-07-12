import type { GeckoPool, OhlcvCandle } from "./types.js";

const BASE_URL = "https://api.geckoterminal.com/api/v2";
const REQUEST_SPACING_MS = 2500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Serializes every request through a single chained queue so concurrent callers
// (e.g. Promise.all) can't race past the naive "check last timestamp" throttle.
let requestQueue: Promise<void> = Promise.resolve();

function throttle(): Promise<void> {
  const slot = requestQueue.then(() => sleep(REQUEST_SPACING_MS));
  requestQueue = slot;
  return slot;
}

async function get<T>(path: string, attempt = 0): Promise<T> {
  await throttle();
  const res = await fetch(`${BASE_URL}${path}`);
  if (res.status === 429 && attempt < 5) {
    await sleep(8000 * (attempt + 1));
    return get<T>(path, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`GeckoTerminal request failed: ${path} -> ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function getPoolsPaginated(network: string, path: string, pages: number): Promise<GeckoPool[]> {
  const pools: GeckoPool[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= pages; page++) {
    const result = await get<{ data: GeckoPool[] }>(`/networks/${network}/${path}${separator}page=${page}`);
    if (result.data.length === 0) break;
    pools.push(...result.data);
  }
  return pools;
}

export async function getTrendingPools(network: string, pages = 2): Promise<GeckoPool[]> {
  return getPoolsPaginated(network, "trending_pools", pages);
}

export async function getNewPools(network: string, pages = 3): Promise<GeckoPool[]> {
  return getPoolsPaginated(network, "new_pools", pages);
}

/** All active pools ranked by 24h volume — the broad net that catches tokens sitting in a
 *  market-cap band regardless of whether they're currently "trending" or brand new. */
export async function getPoolsByVolume(network: string, pages = 8): Promise<GeckoPool[]> {
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

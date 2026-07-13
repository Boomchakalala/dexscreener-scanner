import type { Candidate } from "./types.js";

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
}

// Deterministic, cheap pre-scores computed purely from data already fetched (no extra
// API calls beyond what each stage needed anyway). None of this is the final grade —
// Claude does the real qualitative judgment on the small batch this narrows things down
// to. The job here is purely to get from "several hundred raw pairs" to "a shortlist"
// to "a deep-review batch" without burning the candle/RugCheck API budget on candidates
// that were never going to make the cut.
//
// Chart structure is deliberately scored BEFORE market quality, and RugCheck/safety is
// scored nowhere in here at all — it's applied as a separate final gate in discovery.ts,
// after quality ranking, so a dangerous-but-nonexistent-yet risk flag can never keep a
// good chart from being considered in the first place.

/** STAGE 2 — cheap chart-structure proxy from summary stats GeckoTerminal already gave
 *  us during discovery (no candle fetch yet). Approximates higher-low / consolidation /
 *  healthy-pullback / volume-expansion-on-advance shape well enough to cut a raw
 *  several-hundred-pair pool down to a shortlist worth spending real candle fetches on. */
export function scoreChartProxy(c: Candidate): number {
  const m5 = c.priceChangeM5 ?? 0;
  const h1 = c.priceChangeH1 ?? 0;
  const h6 = c.priceChangeH6 ?? 0;

  let pts = 0;

  // A real up-move on the h6 window, but 150%+ is already extended for this stage,
  // not "more bullish" — and a negative h6 gets a little credit only if it's shallow.
  if (h6 > 0 && h6 <= 150) pts += Math.min(30, h6 * 0.6);
  else if (h6 > 150 && h6 <= 400) pts += 30 - ((h6 - 150) / 250) * 20;
  else if (h6 < 0) pts += Math.max(0, 10 + h6 / 5);

  // Penalize an apparent vertical one-candle chase: most of the hour's move packed
  // into the last 5 minutes reads as a spike, not structure.
  if (Math.abs(m5) > 15 && Math.abs(h1) > 0 && Math.abs(m5) > Math.abs(h1) * 0.6) pts -= 10;

  // Volume shape: compare the last hour's volume to the h6 window's hourly average.
  const h6HourlyAvg = c.volumeH6Usd / 6;
  const volRatio = h6HourlyAvg > 0 ? c.volumeH1Usd / h6HourlyAvg : 1;

  if (h1 < 0 && h1 > -15 && volRatio < 0.8) {
    pts += 20; // gentle pullback on drying volume — the healthy-retrace pattern
  } else if (h1 >= 0 && volRatio > 1.2) {
    pts += 20; // fresh volume returning while price holds or advances
  } else if (h1 < -10 && volRatio > 1.5) {
    pts -= 15; // heavy volume on a red move — reads as distribution, not a base
  }

  // Lower market cap preferred between comparable setups (more room to run) — a modest
  // thumb on the scale, never enough to carry a weak chart past a strong one.
  if (c.marketCapUsd <= 150_000) pts += 6;
  else if (c.marketCapUsd <= 400_000) pts += 3;

  return Math.max(0, Math.min(66, pts));
}

function scoreLiquidity(c: Candidate): number {
  // Liquidity data is frequently missing for pump.fun/pumpswap pools — score neutral
  // rather than punishing the data gap; the Jupiter route quote is the real check.
  if (c.liquidityUnknown) return 10;
  const pts = ((c.liquidityUsd - 8_000) / (150_000 - 8_000)) * 25;
  return Math.max(0, Math.min(25, pts));
}

function scoreFlow(c: Candidate): number {
  const { buys, sells, buyers, sellers } = c.txnsH1;
  const total = buys + sells;
  if (total === 0) return 0;
  const buyRatio = buys / total;

  let pts: number;
  if (buyRatio <= 0.5) {
    pts = buyRatio * 30;
  } else if (buyRatio <= 0.8) {
    pts = 15 + ((buyRatio - 0.5) / 0.3) * 10;
  } else {
    // Beyond 80% buys, taper back down — an extreme ratio (very few sells relative to
    // buys) is suspicious, not "even more bullish"; it can be a can't-sell signature.
    pts = 25 - ((buyRatio - 0.8) / 0.2) * 12;
  }

  if (buyers > sellers * 1.2 && buyers < sellers * 5) pts += 2;

  return Math.max(0, Math.min(25, pts));
}

/** Rough holder-growth proxy: no time-series holder count is available from these APIs,
 *  so approximate it from unique-buyer rate — this hour's buyer count vs. the h6 window's
 *  hourly average buyer count. Rising means fresh wallets are actually entering, not just
 *  the same few wallets trading back and forth. */
function scoreHolderGrowth(c: Candidate): number {
  const h6HourlyBuyers = c.txnsH6.buyers / 6;
  if (h6HourlyBuyers <= 0) return c.txnsH1.buyers > 0 ? 10 : 0;
  const ratio = c.txnsH1.buyers / h6HourlyBuyers;
  if (ratio >= 2) return 20;
  if (ratio >= 1) return 10 + (ratio - 1) * 10;
  return Math.max(0, ratio * 10);
}

/** Light real-candle check: does the most recent low sit above the low from a few
 *  candles back (an actual higher low, not just the proxy's guess), and did volume
 *  contract into that low before the current candle? Small bonus only — full chart
 *  judgment is Claude's job on the final batch, not this pre-score's. */
function scoreCandleStructure(c: Candidate): number {
  const candles = c.candles;
  if (candles.length < 4) return 0;

  const recent = candles.slice(-4);
  const lastLow = recent[recent.length - 1]!.low;
  const priorSwingLow = Math.min(...recent.slice(0, -1).map((k) => k.low));
  let pts = 0;
  if (lastLow >= priorSwingLow) pts += 10;

  const lastVolume = recent[recent.length - 1]!.volume;
  const priorAvgVolume = recent.slice(0, -1).reduce((sum, k) => sum + k.volume, 0) / (recent.length - 1);
  if (priorAvgVolume > 0 && lastVolume < priorAvgVolume) pts += 5; // contraction into the low

  return pts;
}

/** STAGE 3 — market-quality re-rank, run only on the chart-shortlisted batch once real
 *  hourly candles have been fetched for it. Liquidity, buy/sell pressure, holder growth,
 *  and volume/candle structure — deliberately no RugCheck/safety input here; that's a
 *  separate final gate applied after this ranking picks the deep-review batch. */
export function scoreQuality(c: Candidate): number {
  return scoreLiquidity(c) + scoreFlow(c) + scoreHolderGrowth(c) + scoreCandleStructure(c);
}

function rank<T>(items: T[], scoreFn: (item: T) => number): { item: T; score: number; rank: number }[] {
  return items
    .map((item) => ({ item, score: Math.round(scoreFn(item)) }))
    .sort((a, b) => b.score - a.score)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));
}

/** Ranks every candidate by the chart-structure proxy and cuts to topN, stamping each
 *  survivor with its standing among the full pool it was ranked against (so later stages —
 *  and ultimately Claude's report — can cite a real "#3 of 214" instead of inventing one). */
export function rankByChartProxy(candidates: Candidate[], topN: number): Candidate[] {
  const ranked = rank(candidates, scoreChartProxy);
  const of = candidates.length;
  return ranked.slice(0, topN).map(({ item, rank: r }) => ({ ...item, chartRank: { rank: r, of } }));
}

/** Ranks the chart-shortlisted, candle-enriched batch by market quality and cuts to topN,
 *  stamping standing the same way as rankByChartProxy. */
export function rankByQuality(candidates: Candidate[], topN: number): Candidate[] {
  const ranked = rank(candidates, scoreQuality);
  const of = candidates.length;
  return ranked.slice(0, topN).map(({ item, rank: r }) => ({ ...item, qualityRank: { rank: r, of } }));
}

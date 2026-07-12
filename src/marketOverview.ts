export interface MarketOverview {
  solanaDexVolume24hUsd: number | null;
  changePct1d: number | null;
}

/** Real Solana-wide 24h DEX volume from DeFiLlama. Returns nulls (never fabricated numbers) on failure. */
export async function getMarketOverview(): Promise<MarketOverview> {
  try {
    const res = await fetch(
      "https://api.llama.fi/overview/dexs/solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true"
    );
    if (!res.ok) return { solanaDexVolume24hUsd: null, changePct1d: null };
    const data = (await res.json()) as { total24h?: number; change_1d?: number };
    return {
      solanaDexVolume24hUsd: typeof data.total24h === "number" ? data.total24h : null,
      changePct1d: typeof data.change_1d === "number" ? data.change_1d : null,
    };
  } catch {
    return { solanaDexVolume24hUsd: null, changePct1d: null };
  }
}

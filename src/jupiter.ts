const BASE_URL = "https://lite-api.jup.ag/swap/v1";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const REQUEST_TIMEOUT_MS = 6_000;

export interface Tradeability {
  priceImpactPct: number;
  hops: number;
}

/** Free, keyless Jupiter quote for a representative buy size — real tradeability signal
 *  (can you actually get filled, and how much does the market move) beyond raw pool TVL. */
export async function getTradeability(tokenAddress: string, solAmount = 0.5): Promise<Tradeability | null> {
  const lamports = Math.round(solAmount * 1_000_000_000);
  const url = `${BASE_URL}/quote?inputMint=${SOL_MINT}&outputMint=${tokenAddress}&amount=${lamports}&slippageBps=100`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as { priceImpactPct?: string; routePlan?: unknown[] };
    if (data.priceImpactPct === undefined || !data.routePlan) return null;
    return { priceImpactPct: Number(data.priceImpactPct) * 100, hops: data.routePlan.length };
  } catch {
    return null;
  }
}

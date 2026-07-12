import type { RugCheckReport } from "./types.js";

const BASE_URL = "https://api.rugcheck.xyz/v1";

export async function getRugCheckReport(tokenAddress: string): Promise<RugCheckReport | null> {
  try {
    const res = await fetch(`${BASE_URL}/tokens/${tokenAddress}/report`);
    if (!res.ok) return null;
    return (await res.json()) as RugCheckReport;
  } catch {
    return null;
  }
}

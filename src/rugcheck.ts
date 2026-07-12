import type { RugCheckReport } from "./types.js";

const BASE_URL = "https://api.rugcheck.xyz/v1";
const REQUEST_TIMEOUT_MS = 8_000;

// Dedupe repeated lookups for the same token within one scan run (a token can have
// multiple pools, which would otherwise trigger the same RugCheck call twice).
const cache = new Map<string, Promise<RugCheckReport | null>>();

async function fetchReport(tokenAddress: string): Promise<RugCheckReport | null> {
  try {
    const res = await fetch(`${BASE_URL}/tokens/${tokenAddress}/report`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as RugCheckReport;
  } catch {
    return null;
  }
}

export function getRugCheckReport(tokenAddress: string): Promise<RugCheckReport | null> {
  let pending = cache.get(tokenAddress);
  if (!pending) {
    pending = fetchReport(tokenAddress);
    cache.set(tokenAddress, pending);
  }
  return pending;
}

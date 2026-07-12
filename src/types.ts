export interface GeckoPoolAttributes {
  address: string;
  name: string;
  pool_created_at: string | null;
  fdv_usd: string | null;
  market_cap_usd: string | null;
  price_change_percentage: Record<string, string>;
  transactions: Record<string, { buys: number; sells: number; buyers: number; sellers: number }>;
  volume_usd: Record<string, string>;
  reserve_in_usd: string | null;
}

export interface GeckoPool {
  id: string;
  type: "pool";
  attributes: GeckoPoolAttributes;
  relationships: {
    base_token: { data: { id: string; type: "token" } };
    quote_token: { data: { id: string; type: "token" } };
    dex: { data: { id: string; type: "dex" } };
  };
}

export interface OhlcvCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RugCheckReport {
  mint: string;
  creator: string;
  creatorBalance: number;
  score_normalised: number;
  lpLockedPct?: number;
  risks: { name: string; description: string; level: string }[];
  token: { mintAuthority: string | null; freezeAuthority: string | null };
  topHolders: { address: string; pct: number; insider: boolean }[];
}

export interface Candidate {
  chainId: string;
  poolAddress: string;
  tokenAddress: string;
  symbol: string;
  dexUrl: string;
  ageHours: number | null;
  marketCapUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChangeH6: number | null;
  priceChangeH24: number | null;
  txnsH1: { buys: number; sells: number; buyers: number; sellers: number };
  txnsH6: { buys: number; sells: number; buyers: number; sellers: number };
  candles: OhlcvCandle[];
  rugCheck: RugCheckReport | null;
}

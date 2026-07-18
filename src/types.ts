export interface GeckoPoolAttributes {
  address: string;
  name: string;
  pool_created_at: string | null;
  fdv_usd: string | null;
  market_cap_usd: string | null;
  base_token_price_usd: string | null;
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
  volumeH1Usd: number;
  volumeH6Usd: number;
  priceChangeM5: number | null;
  priceChangeH1: number | null;
  priceChangeH6: number | null;
  priceChangeH24: number | null;
  txnsH1: { buys: number; sells: number; buyers: number; sellers: number };
  txnsH6: { buys: number; sells: number; buyers: number; sellers: number };
  candles: OhlcvCandle[];
  rugCheck: RugCheckReport | null;
  /** Real Jupiter route quote for a ~0.5 SOL buy — null means no route found (a red flag on
   *  its own) or the lookup failed. Only populated for the final shortlist sent to Claude. */
  tradeability: { priceImpactPct: number; hops: number } | null;
  /** Where this candidate ranked at each discovery stage, out of how many were still in play
   *  at that stage — so Claude can cite a real standing ("#3 of 214 on chart structure")
   *  instead of inventing one. Null until that stage has run. */
  chartRank: { rank: number; of: number } | null;
  qualityRank: { rank: number; of: number } | null;
  /** True for a token we recently called (paper position / watchlist entry in the last
   *  48h) that's being deliberately followed to conclusion — it bypasses discovery
   *  filters (may be off-window or non-pump.fun) and is guaranteed a slot in the batch. */
  tracked?: boolean;
  /** True for a candidate resurfaced from revival.ts's persisted token history — an aged
   *  (12h-30d) token discovery's own trending/new-pool feeds no longer surface naturally,
   *  re-checked and re-admitted because it's now showing genuine renewed volume/buyers. */
  revival?: boolean;
  /** Launchpad per Jupiter's metadata ("pump.fun", "met-dbc", ...) when known — the
   *  address vanity suffix alone is NOT reliable (PCAT is pump.fun without the suffix). */
  launchpad?: string;
  /** DEX the pool lives on per GeckoTerminal ("pump-fun", "pumpswap", "raydium", ...) —
   *  pump-fun/pumpswap pools are definitionally pump.fun ecosystem, a free third gate
   *  signal for fresh tokens Jupiter hasn't indexed a launchpad for yet. */
  dexId?: string;
  /** GeckoTerminal frequently reports no liquidity at all for pump.fun/pumpswap pools
   *  (observed: $1M+ MC tokens showing reserve 0) — when set, liquidityUsd is 0 because
   *  the DATA is missing, not because the pool is empty. The real tradeability check is
   *  the live Jupiter route quote on the final batch. */
  liquidityUnknown?: boolean;
  /** Current unique holders + Jupiter's 0-100 organic-activity score — the "holder
   *  growth" analysis factor finally has real data behind it (null = lookup failed,
   *  undefined = not yet enriched). */
  holderCount?: number | null;
  organicScore?: number | null;
  /** How many tokens/migrations the SAME deploying wallet has produced (Jupiter audit
   *  data) — a handful is a normal active pump.fun deployer, but hundreds-to-thousands is
   *  a mass-production/factory signature. Confirmed live: "Dilemma" (devMints: 4862,
   *  devMigrations: 19) got called "cleanest structure in the batch" while actively
   *  dumping — this signal existed in data we already fetch but was never surfaced. */
  devMints?: number | null;
  devMigrations?: number | null;
}

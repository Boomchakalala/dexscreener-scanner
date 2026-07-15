import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? Number(value) : fallback;
}

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramChatId: required("TELEGRAM_CHAT_ID"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  chains: (process.env.CHAINS ?? "solana").split(",").map((c) => c.trim()).filter(Boolean),
  // pump.fun mints carry a vanity "pump" address suffix (kept through the pumpswap/Raydium
  // migration), so this is a reliable launchpad filter. Non-pump.fun contracts proved to be
  // where the garbage came from (W26 etc.) — "only focus on pump.fun tokens, rest is shit".
  pumpFunOnly: (process.env.PUMPFUN_ONLY ?? "true") !== "false",
  floors: {
    // Hard code-level OUTER bounds — Claude never sees anything outside these, but they
    // are deliberately wider than the three priority universes (FRESH ~5min-6h,
    // ACTIVE ~2-24h, REVIVALS ~12h-7d): the preference for fresh + lower MC lives in
    // scoring and the prompt, not a hard cutoff. The $8K liquidity floor matters:
    // pump.fun tokens graduate at ~$69K MC with only ~$12-17K of migrated liquidity, so
    // the old $15K floor structurally blanked out the entire sub-$70K segment. 168h (7d)
    // age ceiling admits REVIVALS (12h-7d retracement-then-rebase tokens).
    minMarketCapUsd: numberEnv("MIN_MARKET_CAP_USD", 30_000),
    maxMarketCapUsd: numberEnv("MAX_MARKET_CAP_USD", 10_000_000),
    minLiquidityUsd: numberEnv("MIN_LIQUIDITY_USD", 8_000),
    maxAgeHours: numberEnv("MAX_AGE_HOURS", 168),
    // Four-stage pipeline: raw discovery -> hard floors -> cheap chart-proxy shortlist
    // (maxShortlist) -> real-candle quality re-rank (maxDeepAnalyze) -> RugCheck as the
    // final gate on that small batch -> LLM. See discovery.ts for the stage order.
    maxShortlist: numberEnv("MAX_SHORTLIST", 32),
    maxDeepAnalyze: numberEnv("MAX_DEEP_ANALYZE", 10),
  },
};

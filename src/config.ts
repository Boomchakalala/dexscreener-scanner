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
  floors: {
    // Hard code-level bounds — Claude never even sees anything outside these. Span the
    // full three-universe window (Fresh 0-2h/$30K-$300K, Survivors 2-8h/$100K-$1M,
    // Momentum 8-24h/$250K-$3M) rather than one blended range; which universe a given
    // candidate falls into is inferred from ageHours/marketCapUsd, not filtered here.
    minMarketCapUsd: numberEnv("MIN_MARKET_CAP_USD", 30_000),
    maxMarketCapUsd: numberEnv("MAX_MARKET_CAP_USD", 3_000_000),
    minLiquidityUsd: numberEnv("MIN_LIQUIDITY_USD", 15_000),
    maxAgeHours: numberEnv("MAX_AGE_HOURS", 24),
    // Four-stage pipeline: raw discovery -> hard floors -> cheap chart-proxy shortlist
    // (maxShortlist) -> real-candle quality re-rank (maxDeepAnalyze) -> RugCheck as the
    // final gate on that small batch -> LLM. See discovery.ts for the stage order.
    maxShortlist: numberEnv("MAX_SHORTLIST", 32),
    maxDeepAnalyze: numberEnv("MAX_DEEP_ANALYZE", 10),
  },
};

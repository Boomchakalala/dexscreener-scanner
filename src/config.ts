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
    // Hard code-level bounds — Claude never even sees anything outside these.
    // Primary preference (100K-2M, 0-12h) vs. the exceptions (up to these
    // outer bounds, only for a token that's still genuinely flashing) is a
    // judgment call handled in the prompt, not here.
    minMarketCapUsd: numberEnv("MIN_MARKET_CAP_USD", 75_000),
    maxMarketCapUsd: numberEnv("MAX_MARKET_CAP_USD", 5_000_000),
    minLiquidityUsd: numberEnv("MIN_LIQUIDITY_USD", 50_000),
    maxAgeHours: numberEnv("MAX_AGE_HOURS", 72),
    // Two-stage cap matching the discover -> filter -> top30 -> score -> top10 -> LLM pipeline.
    maxSurvivors: numberEnv("MAX_SURVIVORS", 30),
    maxDeepAnalyze: numberEnv("MAX_DEEP_ANALYZE", 10),
  },
};

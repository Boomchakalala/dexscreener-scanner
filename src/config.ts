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
    minMarketCapUsd: numberEnv("MIN_MARKET_CAP_USD", 150_000),
    maxMarketCapUsd: numberEnv("MAX_MARKET_CAP_USD", 1_500_000),
    minLiquidityUsd: numberEnv("MIN_LIQUIDITY_USD", 40_000),
    maxCandidates: numberEnv("MAX_CANDIDATES_TO_ANALYZE", 20),
  },
};

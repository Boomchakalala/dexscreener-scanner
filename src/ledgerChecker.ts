import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { getPoolStats, type PoolStats } from "./gecko.js";
import { getTradeability } from "./jupiter.js";
import {
  currentlyDeployedSol,
  loadLedger,
  saveLedger,
  type Ledger,
  type Position,
  type TradeLogEntry,
} from "./ledger.js";
import { sendTelegramMessage } from "./telegram.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// Don't chase a BREAKOUT/RECLAIM entry that already ran well past its trigger before we
// ever got to check it — wait for the window to expire (-> MISSED) instead of buying high.
const CHASE_GUARD_PCT = 0.15;

const TP1_CLASSIFY_PROMPT = `You are classifying how a Solana memecoin arrived at its first take-profit target — WEAK, NORMAL, or STRONG — based only on the price/volume/flow data given (no candle chart or wallet data available at this stage).

WEAK: volume fading into the target, sellers dominant in the flow, buy count present but price barely advancing relative to it, liquidity thinning.
NORMAL: healthy volume, buyers still slightly dominant, price reaching the target without being excessively vertical.
STRONG: volume accelerating, buy flow materially exceeds sell flow, price advancing efficiently, liquidity holding up.

Respond with EXACTLY one word and nothing else: WEAK, NORMAL, or STRONG.`;

async function classifyTp1Arrival(position: Position, stats: PoolStats): Promise<"WEAK" | "NORMAL" | "STRONG"> {
  const volRatio = stats.volumeH6Usd > 0 ? (stats.volumeH1Usd / (stats.volumeH6Usd / 6)).toFixed(2) : "n/a";
  const buyRatio =
    stats.txnsH1.buys + stats.txnsH1.sells > 0
      ? (stats.txnsH1.buys / (stats.txnsH1.buys + stats.txnsH1.sells)).toFixed(2)
      : "n/a";
  const userMessage = `Token: ${position.symbol}
Entry price: $${position.entryPrice}
Current price: $${stats.priceUsd}
TP1 target: $${position.targets.find((t) => t.label === "TP1")?.price}
Current market cap: $${Math.round(stats.marketCapUsd)}
Current liquidity: $${Math.round(stats.liquidityUsd)}
1h volume vs h6-hourly-average ratio: ${volRatio} (>1 means volume accelerating)
1h buy ratio: ${buyRatio} (buys / (buys+sells))

Classify this TP1 arrival.`;

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 8,
      system: TP1_CLASSIFY_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const answer = (textBlock?.text ?? "").trim().toUpperCase();
    if (answer.startsWith("WEAK")) return "WEAK";
    if (answer.startsWith("STRONG")) return "STRONG";
    return "NORMAL";
  } catch {
    // Claude unavailable — fall back to the conservative middle tier rather than inventing
    // a decision pretending to be Claude's, consistent with the rest of this project's
    // "never fabricate a judgment call" rule.
    return "NORMAL";
  }
}

const TP1_SELL_FRACTION: Record<"WEAK" | "NORMAL" | "STRONG", number> = {
  WEAK: 0.82,
  NORMAL: 0.62,
  STRONG: 0.4,
};

function logTrade(ledger: Ledger, entry: Omit<TradeLogEntry, "timestamp">): void {
  ledger.tradeLog.push({ ...entry, timestamp: Date.now() });
}

function fmtMc(marketCapUsd: number): string {
  if (marketCapUsd >= 1_000_000) return `$${(marketCapUsd / 1_000_000).toFixed(2)}M`;
  return `$${Math.round(marketCapUsd / 1000)}K`;
}

/** Realistic fill: a real Jupiter route quote for this position's size gives real
 *  price-impact/slippage; falls back to raw pool price (flagged in the log reason) if no
 *  route was found rather than blocking the fill entirely. */
async function simulateFillPrice(tokenAddress: string, sizeSol: number, rawPriceUsd: number): Promise<{ price: number; note: string }> {
  const quote = await getTradeability(tokenAddress, sizeSol);
  if (!quote) return { price: rawPriceUsd, note: "no Jupiter route found — filled at raw pool price" };
  return { price: rawPriceUsd * (1 + quote.priceImpactPct / 100), note: `filled with ${quote.priceImpactPct.toFixed(2)}% price impact` };
}

async function checkPendingEntry(position: Position, ledger: Ledger): Promise<void> {
  const now = Date.now();
  const deadline = position.createdAt + position.entryCondition.validityWindowMinutes * 60_000;
  if (now > deadline) {
    position.status = "MISSED";
    logTrade(ledger, {
      positionId: position.id,
      symbol: position.symbol,
      action: "MISSED",
      price: null,
      sizeSol: 0,
      pnlSol: 0,
      reason: "entry condition never triggered within its validity window",
    });
    await sendTelegramMessage(`**${position.symbol}** — MISSED\nEntry condition never triggered: ${position.entryCondition.description}`);
    return;
  }

  const stats = await getPoolStats(position.chainId, position.poolAddress);
  if (!stats) return;

  const { type, triggerPrice } = position.entryCondition;
  let triggered = type === "IMMEDIATE";
  if (!triggered && triggerPrice !== null) {
    if (type === "PULLBACK") {
      triggered = stats.priceUsd <= triggerPrice;
    } else {
      // BREAKOUT / RECLAIM — waiting for price to reach or clear the trigger level, but
      // don't chase if it already ran well past it before this check ever happened.
      const alreadyRanTooFar = stats.priceUsd >= triggerPrice * (1 + CHASE_GUARD_PCT);
      triggered = stats.priceUsd >= triggerPrice && !alreadyRanTooFar;
    }
  }
  if (!triggered) return;

  const fill = await simulateFillPrice(position.tokenAddress, position.sizeSol, stats.priceUsd);
  position.status = "OPEN";
  position.entryPrice = fill.price;
  position.entryMarketCapUsd = stats.marketCapUsd;
  position.openedAt = now;
  ledger.balanceSol -= position.sizeSol;

  logTrade(ledger, {
    positionId: position.id,
    symbol: position.symbol,
    action: "ENTRY",
    price: fill.price,
    sizeSol: position.sizeSol,
    pnlSol: 0,
    reason: fill.note,
  });
  await sendTelegramMessage(
    `**${position.symbol}** — ENTRY filled\n${position.entryCondition.description}\nSize: ${position.sizeSol.toFixed(3)} SOL @ $${fill.price} (~${fmtMc(stats.marketCapUsd)} MC)\n${fill.note}\n[READ](${position.dexUrl})`
  );
}

function closePosition(position: Position, ledger: Ledger, exitPrice: number, reason: string): void {
  const proceeds = position.remainingSizeSol * (exitPrice / (position.entryPrice as number));
  const pnl = proceeds - position.remainingSizeSol;
  ledger.balanceSol += proceeds;
  position.realizedPnlSol += pnl;
  position.status = "CLOSED";
  position.closedAt = Date.now();
  logTrade(ledger, {
    positionId: position.id,
    symbol: position.symbol,
    action: "EXIT",
    price: exitPrice,
    sizeSol: position.remainingSizeSol,
    pnlSol: pnl,
    reason,
  });
  position.remainingSizeSol = 0;
}

async function checkOpenPosition(position: Position, ledger: Ledger): Promise<void> {
  const stats = await getPoolStats(position.chainId, position.poolAddress);
  if (!stats) return;
  const entryPrice = position.entryPrice as number;

  if (stats.priceUsd <= position.structuralInvalidation.price) {
    closePosition(position, ledger, stats.priceUsd, `structural invalidation hit: ${position.structuralInvalidation.description}`);
    await sendTelegramMessage(
      `**${position.symbol}** — EXIT (stop)\n${position.structuralInvalidation.description}\nExit: $${stats.priceUsd} (~${fmtMc(stats.marketCapUsd)} MC)\nP&L: ${position.realizedPnlSol.toFixed(4)} SOL`
    );
    return;
  }

  const tp1 = position.targets.find((t) => t.label === "TP1");
  if (tp1 && stats.priceUsd >= tp1.price) {
    const classification = await classifyTp1Arrival(position, stats);
    const sellFraction = TP1_SELL_FRACTION[classification];
    const soldSol = position.remainingSizeSol * sellFraction;
    const proceeds = soldSol * (stats.priceUsd / entryPrice);
    const pnl = proceeds - soldSol;

    ledger.balanceSol += proceeds;
    position.realizedPnlSol += pnl;
    position.remainingSizeSol -= soldSol;
    position.status = "TP1_TAKEN";
    position.tp1TakenAt = Date.now();
    position.tp1Classification = classification;

    if (classification === "NORMAL") {
      position.structuralInvalidation = { price: entryPrice, description: "moved to breakeven after TP1 (normal arrival)" };
    } else if (classification === "WEAK") {
      const tightened = entryPrice + (tp1.price - entryPrice) * 0.5;
      position.structuralInvalidation = { price: tightened, description: "tightened after a weak TP1 arrival" };
    }
    // STRONG keeps the original stop — "do not use a tight trailing stop immediately".

    logTrade(ledger, {
      positionId: position.id,
      symbol: position.symbol,
      action: "TP1_PARTIAL",
      price: stats.priceUsd,
      sizeSol: soldSol,
      pnlSol: pnl,
      reason: `TP1 arrival classified ${classification}, sold ${(sellFraction * 100).toFixed(0)}%`,
    });
    await sendTelegramMessage(
      `**${position.symbol}** — TP1 hit (${classification})\nSold ${(sellFraction * 100).toFixed(0)}% @ $${stats.priceUsd} (~${fmtMc(stats.marketCapUsd)} MC), keeping ${(100 - sellFraction * 100).toFixed(0)}% as runner\nP&L on this slice: ${pnl.toFixed(4)} SOL`
    );
  }
}

async function checkTp1TakenPosition(position: Position, ledger: Ledger): Promise<void> {
  const stats = await getPoolStats(position.chainId, position.poolAddress);
  if (!stats) return;

  if (stats.priceUsd <= position.structuralInvalidation.price) {
    closePosition(position, ledger, stats.priceUsd, `runner stopped out: ${position.structuralInvalidation.description}`);
    await sendTelegramMessage(
      `**${position.symbol}** — EXIT (runner stopped)\nExit: $${stats.priceUsd} (~${fmtMc(stats.marketCapUsd)} MC)\nP&L: ${position.realizedPnlSol.toFixed(4)} SOL`
    );
    return;
  }

  const tp2 = position.targets.find((t) => t.label === "TP2");
  if (tp2 && stats.priceUsd >= tp2.price) {
    closePosition(position, ledger, stats.priceUsd, `final target reached: ${tp2.note}`);
    await sendTelegramMessage(
      `**${position.symbol}** — EXIT (final target)\nExit: $${stats.priceUsd} (~${fmtMc(stats.marketCapUsd)} MC)\nP&L: ${position.realizedPnlSol.toFixed(4)} SOL`
    );
  }
}

export async function runLedgerCheck(): Promise<void> {
  const ledger = await loadLedger();
  console.log(
    `Ledger check: balance=${ledger.balanceSol.toFixed(4)} SOL, deployed=${currentlyDeployedSol(ledger).toFixed(4)} SOL, ${ledger.positions.length} total positions.`
  );

  for (const position of ledger.positions) {
    if (position.status === "PENDING_ENTRY") await checkPendingEntry(position, ledger);
    else if (position.status === "OPEN") await checkOpenPosition(position, ledger);
    else if (position.status === "TP1_TAKEN") await checkTp1TakenPosition(position, ledger);
  }

  await saveLedger(ledger);
  console.log(`Ledger check complete. Balance now ${ledger.balanceSol.toFixed(4)} SOL.`);
}

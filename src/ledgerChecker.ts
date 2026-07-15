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
import { getRugCheckReport } from "./rugcheck.js";
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

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/** Realistic fill: a real Jupiter route quote for this position's size gives real
 *  price-impact/slippage; falls back to raw pool price (flagged in the log reason) if no
 *  route was found rather than blocking the fill entirely. */
async function simulateFillPrice(tokenAddress: string, sizeSol: number, rawPriceUsd: number): Promise<{ price: number; note: string }> {
  const quote = await getTradeability(tokenAddress, sizeSol);
  if (!quote) return { price: rawPriceUsd, note: "no Jupiter route found — filled at raw pool price" };
  return { price: rawPriceUsd * (1 + quote.priceImpactPct / 100), note: `filled with ${quote.priceImpactPct.toFixed(2)}% price impact` };
}

/** Sell-side counterpart: exits must model slippage too, or the paper results are
 *  systematically flattered (entries paid impact, exits didn't). Jupiter's quote is for a
 *  buy of this size; using its impact magnitude downward is an approximation, but far
 *  closer to reality on thin liquidity than a frictionless exit at raw pool price. */
async function simulateExitPrice(tokenAddress: string, sellValueSol: number, rawPriceUsd: number): Promise<number> {
  const quote = await getTradeability(tokenAddress, Math.max(sellValueSol, 0.01));
  if (!quote) return rawPriceUsd;
  return rawPriceUsd * (1 - quote.priceImpactPct / 100);
}

/** MFE/MAE watermarks — updated on every check while capital is at risk, because the
 *  end-of-experiment strategy comparison ("would a fixed 80/20 have beaten the adaptive
 *  exits?") is impossible to reconstruct without them. */
function updateWatermarks(position: Position, priceUsd: number): void {
  if (position.highWaterPriceUsd == null || priceUsd > position.highWaterPriceUsd) {
    position.highWaterPriceUsd = priceUsd;
  }
  if (position.lowWaterPriceUsd == null || priceUsd < position.lowWaterPriceUsd) {
    position.lowWaterPriceUsd = priceUsd;
  }
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
  let triggered = false;

  if (type === "IMMEDIATE") {
    // A flash "enter now" gets filled by the NEXT check tick, 5-10 minutes after the
    // snapshot — an eternity on a spiking memecoin. If it already ran past the chase
    // guard, the momentum entry is gone: mark MISSED rather than buying the top.
    if (stats.priceUsd >= position.entrySnapshot.priceUsd * (1 + CHASE_GUARD_PCT)) {
      position.status = "MISSED";
      logTrade(ledger, {
        positionId: position.id,
        symbol: position.symbol,
        action: "MISSED",
        price: stats.priceUsd,
        sizeSol: 0,
        pnlSol: 0,
        reason: `price ran >${(CHASE_GUARD_PCT * 100).toFixed(0)}% past the alert snapshot before fill — not chasing`,
      });
      await sendTelegramMessage(
        `**${position.symbol}** — MISSED (not chasing)\nPrice ran from $${position.entrySnapshot.priceUsd} to $${stats.priceUsd} before the fill window.`
      );
      return;
    }
    triggered = true;
  } else if (triggerPrice !== null) {
    if (type === "PULLBACK") {
      // Single touch fills — a lower fill is a better fill for a buyer, and the
      // structural stop just below handles the catching-a-knife case.
      triggered = stats.priceUsd <= triggerPrice;
    } else {
      // BREAKOUT / RECLAIM — "reclaim and hold" must actually hold: require the level
      // across two consecutive checks (~5 min apart), so a single wick through it
      // between checks doesn't count. Chase guard still applies on top.
      const alreadyRanTooFar = stats.priceUsd >= triggerPrice * (1 + CHASE_GUARD_PCT);
      const atLevel = stats.priceUsd >= triggerPrice && !alreadyRanTooFar;
      if (atLevel) {
        position.triggerHits = (position.triggerHits ?? 0) + 1;
        triggered = position.triggerHits >= 2;
        if (!triggered) {
          console.log(`  ${position.symbol}: trigger touched (hit 1 of 2) — waiting for it to hold next check.`);
        }
      } else {
        position.triggerHits = 0;
      }
    }
  }
  if (!triggered) return;

  const fill = await simulateFillPrice(position.tokenAddress, position.sizeSol, stats.priceUsd);
  position.status = "OPEN";
  position.entryPrice = fill.price;
  position.entryMarketCapUsd = stats.marketCapUsd;
  position.openedAt = now;
  position.highWaterPriceUsd = fill.price;
  position.lowWaterPriceUsd = fill.price;
  position.entryTxnsH1 = { buys: stats.txnsH1.buys, sells: stats.txnsH1.sells };
  ledger.balanceSol -= position.sizeSol;

  // Baseline for the live wallet-distribution check below: the largest holder BY ADDRESS
  // at fill time, so a later check can tell whether that specific wallet shrank or exited
  // rather than just noticing a different wallet is now largest.
  const rugCheck = await getRugCheckReport(position.tokenAddress);
  const topHolder = rugCheck?.topHolders?.[0] ?? null;
  position.entryTopHolderAddress = topHolder?.address ?? null;
  position.entryTopHolderPct = topHolder?.pct ?? null;

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
    `**${position.symbol}** — ENTRY filled\n${position.entryCondition.description}\nSize: ${position.sizeSol.toFixed(3)} SOL @ $${fill.price} (MC in: ~${fmtMc(stats.marketCapUsd)})\n${fill.note}\n[READ](${position.dexUrl})`
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

// Two independent, non-exiting early-warning checks for "I bought and a large wallet
// started dumping right after" — the thing the price-only stop-loss can't see until it's
// already too late. Both fire at most once per position (distributionWarned latches).
const SELL_SPIKE_THRESHOLD_PTS = 20; // percentage-point jump in sell fraction vs entry
const SELL_SPIKE_MIN_TXNS = 10; // ignore tiny samples — noise, not signal
const TOP_HOLDER_RELATIVE_DROP = 0.4; // holder's stake shrank by 40%+ vs entry
const TOP_HOLDER_MC_GROWTH_CEILING = 1.3; // ...and it's not just organic dilution from MC growth

async function checkDistributionHealth(position: Position, stats: PoolStats): Promise<void> {
  if (position.distributionWarned) return;

  const warnings: string[] = [];

  if (position.entryTxnsH1) {
    const entryTotal = position.entryTxnsH1.buys + position.entryTxnsH1.sells;
    const nowTotal = stats.txnsH1.buys + stats.txnsH1.sells;
    if (entryTotal > 0 && nowTotal >= SELL_SPIKE_MIN_TXNS) {
      const entrySellPct = (position.entryTxnsH1.sells / entryTotal) * 100;
      const nowSellPct = (stats.txnsH1.sells / nowTotal) * 100;
      if (nowSellPct - entrySellPct >= SELL_SPIKE_THRESHOLD_PTS) {
        warnings.push(`sell pressure jumped from ${entrySellPct.toFixed(0)}% to ${nowSellPct.toFixed(0)}% of h1 flow`);
      }
    }
  }

  if (position.entryTopHolderAddress && position.entryTopHolderPct) {
    const mcGrowth = position.entryMarketCapUsd ? stats.marketCapUsd / position.entryMarketCapUsd : 1;
    if (mcGrowth < TOP_HOLDER_MC_GROWTH_CEILING) {
      const rugCheck = await getRugCheckReport(position.tokenAddress);
      const stillHolds = rugCheck?.topHolders?.find((h) => h.address === position.entryTopHolderAddress);
      const currentPct = stillHolds?.pct ?? 0;
      if (currentPct <= position.entryTopHolderPct * (1 - TOP_HOLDER_RELATIVE_DROP)) {
        warnings.push(
          stillHolds
            ? `entry's top holder shrank from ${position.entryTopHolderPct.toFixed(1)}% to ${currentPct.toFixed(1)}%`
            : `entry's top holder (was ${position.entryTopHolderPct.toFixed(1)}%) appears to have fully exited`
        );
      }
    }
  }

  if (warnings.length === 0) return;
  position.distributionWarned = true;
  await sendTelegramMessage(`⚠️ **${position.symbol}** — possible distribution\n${warnings.join("; ")}. Not auto-exiting — your call.`);
}

async function checkOpenPosition(position: Position, ledger: Ledger): Promise<void> {
  const stats = await getPoolStats(position.chainId, position.poolAddress);
  if (!stats) return;
  const entryPrice = position.entryPrice as number;
  updateWatermarks(position, stats.priceUsd);
  await checkDistributionHealth(position, stats);

  if (stats.priceUsd <= position.structuralInvalidation.price) {
    const sellValueSol = position.remainingSizeSol * (stats.priceUsd / entryPrice);
    const exitPrice = await simulateExitPrice(position.tokenAddress, sellValueSol, stats.priceUsd);
    const pctMove = (exitPrice / entryPrice - 1) * 100;
    closePosition(position, ledger, exitPrice, `structural invalidation hit: ${position.structuralInvalidation.description}`);
    await sendTelegramMessage(
      `**${position.symbol}** — EXIT (stop)\n${position.structuralInvalidation.description}\nEntry: $${entryPrice} (MC in: ~${fmtMc(position.entryMarketCapUsd as number)}) → Exit: $${exitPrice} (MC out: ~${fmtMc(stats.marketCapUsd)}), ${fmtPct(pctMove)}\nP&L: ${position.realizedPnlSol.toFixed(4)} SOL`
    );
    return;
  }

  const tp1 = position.targets.find((t) => t.label === "TP1");
  if (tp1 && stats.priceUsd >= tp1.price) {
    const classification = await classifyTp1Arrival(position, stats);
    const sellFraction = TP1_SELL_FRACTION[classification];
    const soldSol = position.remainingSizeSol * sellFraction;
    const sellPrice = await simulateExitPrice(position.tokenAddress, soldSol * (stats.priceUsd / entryPrice), stats.priceUsd);
    const proceeds = soldSol * (sellPrice / entryPrice);
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
      price: sellPrice,
      sizeSol: soldSol,
      pnlSol: pnl,
      reason: `TP1 arrival classified ${classification}, sold ${(sellFraction * 100).toFixed(0)}%`,
    });
    const pctMove = (sellPrice / entryPrice - 1) * 100;
    await sendTelegramMessage(
      `**${position.symbol}** — TP1 hit (${classification})\nSold ${(sellFraction * 100).toFixed(0)}% @ $${sellPrice} (MC out: ~${fmtMc(stats.marketCapUsd)}), keeping ${(100 - sellFraction * 100).toFixed(0)}% as runner\nEntry: $${entryPrice} (MC in: ~${fmtMc(position.entryMarketCapUsd as number)}), ${fmtPct(pctMove)}\nP&L on this slice: ${pnl.toFixed(4)} SOL`
    );
  }
}

async function checkTp1TakenPosition(position: Position, ledger: Ledger): Promise<void> {
  const stats = await getPoolStats(position.chainId, position.poolAddress);
  if (!stats) return;
  const entryPrice = position.entryPrice as number;
  const entryMc = position.entryMarketCapUsd as number;
  updateWatermarks(position, stats.priceUsd);
  await checkDistributionHealth(position, stats);

  if (stats.priceUsd <= position.structuralInvalidation.price) {
    const sellValueSol = position.remainingSizeSol * (stats.priceUsd / entryPrice);
    const exitPrice = await simulateExitPrice(position.tokenAddress, sellValueSol, stats.priceUsd);
    const pctMove = (exitPrice / entryPrice - 1) * 100;
    closePosition(position, ledger, exitPrice, `runner stopped out: ${position.structuralInvalidation.description}`);
    await sendTelegramMessage(
      `**${position.symbol}** — EXIT (runner stopped)\nEntry: $${entryPrice} (MC in: ~${fmtMc(entryMc)}) → Exit: $${exitPrice} (MC out: ~${fmtMc(stats.marketCapUsd)}), ${fmtPct(pctMove)}\nP&L: ${position.realizedPnlSol.toFixed(4)} SOL`
    );
    return;
  }

  const tp2 = position.targets.find((t) => t.label === "TP2");
  if (tp2 && stats.priceUsd >= tp2.price) {
    const sellValueSol = position.remainingSizeSol * (stats.priceUsd / entryPrice);
    const exitPrice = await simulateExitPrice(position.tokenAddress, sellValueSol, stats.priceUsd);
    const pctMove = (exitPrice / entryPrice - 1) * 100;
    closePosition(position, ledger, exitPrice, `final target reached: ${tp2.note}`);
    await sendTelegramMessage(
      `**${position.symbol}** — EXIT (final target)\nEntry: $${entryPrice} (MC in: ~${fmtMc(entryMc)}) → Exit: $${exitPrice} (MC out: ~${fmtMc(stats.marketCapUsd)}), ${fmtPct(pctMove)}\nP&L: ${position.realizedPnlSol.toFixed(4)} SOL`
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

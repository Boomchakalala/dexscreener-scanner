import { getPoolStats } from "./gecko.js";
import { loadLedger, type Position } from "./ledger.js";
import { sendTelegramMessage } from "./telegram.js";

function fmtSol(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
}

function fmtMc(marketCapUsd: number): string {
  if (marketCapUsd >= 1_000_000) return `$${(marketCapUsd / 1_000_000).toFixed(2)}M`;
  return `$${Math.round(marketCapUsd / 1000)}K`;
}

async function unrealizedFor(position: Position): Promise<{ line: string; pnl: number }> {
  const stats = await getPoolStats(position.chainId, position.poolAddress);
  if (!stats || position.entryPrice === null) {
    return { line: `- **${position.symbol}** (${position.status}): size ${position.remainingSizeSol.toFixed(3)} SOL, current price unavailable`, pnl: 0 };
  }
  const currentValue = position.remainingSizeSol * (stats.priceUsd / position.entryPrice);
  const pnl = currentValue - position.remainingSizeSol;
  const entryMc = position.entryMarketCapUsd !== null ? fmtMc(position.entryMarketCapUsd) : "n/a";
  return {
    line: `- **${position.symbol}** (${position.status}): size ${position.remainingSizeSol.toFixed(3)} SOL, entry $${position.entryPrice} (${entryMc} MC), current $${stats.priceUsd} (${fmtMc(stats.marketCapUsd)} MC), unrealized ${fmtSol(pnl)} SOL [READ](${position.dexUrl})`,
    pnl,
  };
}

function pendingLine(position: Position): string {
  const deadline = position.createdAt + position.entryCondition.validityWindowMinutes * 60_000;
  const minutesLeft = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
  return `- **${position.symbol}**: waiting for ${position.entryCondition.description} (${minutesLeft}m left) [READ](${position.dexUrl})`;
}

function closedLine(position: Position): string {
  const outcome = position.realizedPnlSol >= 0 ? "WIN" : "LOSS";
  return `- **${position.symbol}** (${position.tier}, ${outcome}): P&L ${fmtSol(position.realizedPnlSol)} SOL`;
}

export async function runLedgerReport(): Promise<void> {
  const ledger = await loadLedger();
  const pending = ledger.positions.filter((p) => p.status === "PENDING_ENTRY");
  const open = ledger.positions.filter((p) => p.status === "OPEN" || p.status === "TP1_TAKEN");
  const closed = ledger.positions
    .filter((p) => p.status === "CLOSED")
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const missedCount = ledger.positions.filter((p) => p.status === "MISSED").length;

  const unrealizedResults = await Promise.all(open.map(unrealizedFor));
  const totalUnrealized = unrealizedResults.reduce((sum, r) => sum + r.pnl, 0);
  const totalRealized = ledger.positions.reduce((sum, p) => sum + p.realizedPnlSol, 0);
  const equity = ledger.balanceSol + totalUnrealized;
  const overallPnl = equity - 2; // starting balance
  const overallPnlPct = (overallPnl / 2) * 100;

  const wins = closed.filter((p) => p.realizedPnlSol >= 0).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
  const avgPnl = closed.length > 0 ? totalRealized / closed.length : 0;

  const parts: string[] = [
    "📊 **Paper Trading Ledger**",
    "",
    `Balance: ${ledger.balanceSol.toFixed(4)} SOL | Equity (incl. open positions): ${equity.toFixed(4)} SOL`,
    `Overall P&L: ${fmtSol(overallPnl)} SOL (${overallPnlPct >= 0 ? "+" : ""}${overallPnlPct.toFixed(1)}%) since starting at 2 SOL`,
  ];

  if (open.length > 0) {
    parts.push("", `Open positions (${open.length}):`, ...unrealizedResults.map((r) => r.line));
  }
  if (pending.length > 0) {
    parts.push("", `Pending entries (${pending.length}):`, ...pending.map(pendingLine));
  }
  if (closed.length > 0) {
    parts.push("", `Recent closed trades (last 10 of ${closed.length}):`, ...closed.slice(0, 10).map(closedLine));
  }

  parts.push(
    "",
    `Stats: ${closed.length} closed trade${closed.length === 1 ? "" : "s"}, ${winRate.toFixed(0)}% win rate, avg P&L ${fmtSol(avgPnl)} SOL/trade, ${missedCount} missed entr${missedCount === 1 ? "y" : "ies"}.`
  );

  await sendTelegramMessage(parts.join("\n"));
}

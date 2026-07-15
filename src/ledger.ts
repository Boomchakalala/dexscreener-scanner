import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TradePlan } from "./analysis.js";
import type { Candidate } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_DIR = path.join(__dirname, "..", "data");
const LEDGER_FILE = path.join(LEDGER_DIR, "ledger.json");

const STARTING_BALANCE_SOL = 2;
const MAX_SIZE_SOL = 0.5;
const MAX_DEPLOYED_PCT = 0.4;
// Phase 1+ sizing tiers.
const SIZE_PCT_BY_TIER: Record<TradePlan["tier"], number> = {
  "SPECULATIVE PUNT": 0.08,
  WATCH: 0.12,
  RECOMMENDATION: 0.18,
  FLASH: 0.22,
};

export type PositionStatus = "PENDING_ENTRY" | "OPEN" | "TP1_TAKEN" | "CLOSED" | "MISSED";

export interface Position {
  id: string;
  symbol: string;
  tokenAddress: string;
  poolAddress: string;
  chainId: string;
  dexUrl: string;
  tier: TradePlan["tier"];
  status: PositionStatus;
  sizeSol: number;
  remainingSizeSol: number;
  entryCondition: TradePlan["entryCondition"];
  entrySnapshot: TradePlan["entrySnapshot"];
  structuralInvalidation: TradePlan["structuralInvalidation"];
  targets: TradePlan["targets"];
  thesis: string;
  createdAt: number;
  entryPrice: number | null;
  entryMarketCapUsd: number | null;
  openedAt: number | null;
  tp1TakenAt: number | null;
  tp1Classification: "WEAK" | "NORMAL" | "STRONG" | null;
  closedAt: number | null;
  realizedPnlSol: number;
  /** Consecutive checks where a RECLAIM/BREAKOUT trigger held — a fill needs 2, so a
   *  single wick through the level between checks doesn't count as "reclaim and hold". */
  triggerHits?: number;
  /** Max favorable / adverse excursion watermarks, updated every check while the position
   *  is open — without these, "would a different exit strategy have done better" can never
   *  be reconstructed afterward, which is the whole point of paper trading. */
  highWaterPriceUsd?: number | null;
  lowWaterPriceUsd?: number | null;
  /** Buy/sell transaction counts at fill time — the baseline a live sell-pressure-spike
   *  check compares each subsequent check against, to catch "bought, then the wallets
   *  immediately started dumping" the same day it happens instead of only after price
   *  itself breaks the stop. */
  entryTxnsH1?: { buys: number; sells: number } | null;
  /** The largest RugCheck-reported holder's address + percentage at fill time — tracked
   *  by address (not just "current largest") so re-checks detect the SAME wallet
   *  shrinking or exiting, not a different wallet becoming largest. */
  entryTopHolderAddress?: string | null;
  entryTopHolderPct?: number | null;
  /** Set once a distribution/sell-pressure alert has fired for this position, so the
   *  5-minute checker doesn't spam the same warning every cycle. */
  distributionWarned?: boolean;
}

export interface TradeLogEntry {
  timestamp: number;
  positionId: string;
  symbol: string;
  action: "ENTRY" | "TP1_PARTIAL" | "EXIT" | "MISSED";
  price: number | null;
  sizeSol: number;
  pnlSol: number;
  reason: string;
}

export interface Ledger {
  balanceSol: number;
  positions: Position[];
  tradeLog: TradeLogEntry[];
}

const TERMINAL_STATUSES: PositionStatus[] = ["CLOSED", "MISSED"];

export async function loadLedger(): Promise<Ledger> {
  try {
    const raw = await readFile(LEDGER_FILE, "utf-8");
    return JSON.parse(raw) as Ledger;
  } catch {
    return { balanceSol: STARTING_BALANCE_SOL, positions: [], tradeLog: [] };
  }
}

export async function saveLedger(ledger: Ledger): Promise<void> {
  await mkdir(LEDGER_DIR, { recursive: true });
  await writeFile(LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

/** Sum of remaining size across every position that's still tying up capital
 *  (pending an entry that hasn't triggered yet, or already open). */
export function currentlyDeployedSol(ledger: Ledger): number {
  return ledger.positions
    .filter((p) => !TERMINAL_STATUSES.includes(p.status))
    .reduce((sum, p) => sum + p.remainingSizeSol, 0);
}

/** Opens new PENDING_ENTRY positions from a deep scan's trade plans. Skips a token that
 *  already has a non-terminal position (never average down / never double up on the same
 *  token automatically), and skips anything that would push total deployed capital past
 *  the 40% cap. Sizing is tiered % of current balance, hard-capped at 0.5 SOL/trade. Only
 *  plans for tokens that were actually analyzed this run are kept, guarding against a
 *  mismatched/hallucinated address that never appeared in this run's candidates. */
export async function openPositionsFromTradePlans(tradePlans: TradePlan[], candidates: Candidate[]): Promise<void> {
  const ledger = await loadLedger();
  const activeTokens = new Set(
    ledger.positions.filter((p) => !TERMINAL_STATUSES.includes(p.status)).map((p) => p.tokenAddress)
  );
  const candidateByToken = new Map(candidates.map((c) => [c.tokenAddress, c]));

  const now = Date.now();
  let deployed = currentlyDeployedSol(ledger);
  const maxDeployed = ledger.balanceSol * MAX_DEPLOYED_PCT;

  for (const plan of tradePlans) {
    if (activeTokens.has(plan.tokenAddress)) continue;
    const candidate = candidateByToken.get(plan.tokenAddress);
    if (!candidate) continue;

    const pct = SIZE_PCT_BY_TIER[plan.tier];
    if (pct === undefined) continue;
    const sizeSol = Math.min(ledger.balanceSol * pct, MAX_SIZE_SOL);

    if (deployed + sizeSol > maxDeployed) continue;

    // WATCH-tier plans are conditional setups ("hold ~1h then reclaim") whose confirmation
    // legitimately takes hours — a 20-45min fuse makes them structurally un-fillable, so
    // enforce a 6h floor regardless of what the prompt emitted.
    const entryCondition =
      plan.tier === "WATCH"
        ? { ...plan.entryCondition, validityWindowMinutes: Math.max(plan.entryCondition.validityWindowMinutes, 360) }
        : plan.entryCondition;

    ledger.positions.push({
      id: `${plan.tokenAddress}-${now}`,
      symbol: plan.symbol,
      tokenAddress: plan.tokenAddress,
      poolAddress: plan.poolAddress,
      chainId: candidate.chainId,
      dexUrl: candidate.dexUrl,
      tier: plan.tier,
      status: "PENDING_ENTRY",
      sizeSol,
      remainingSizeSol: sizeSol,
      entryCondition,
      entrySnapshot: plan.entrySnapshot,
      structuralInvalidation: plan.structuralInvalidation,
      targets: plan.targets,
      thesis: plan.thesis,
      createdAt: now,
      entryPrice: null,
      entryMarketCapUsd: null,
      openedAt: null,
      tp1TakenAt: null,
      tp1Classification: null,
      closedAt: null,
      realizedPnlSol: 0,
    });

    activeTokens.add(plan.tokenAddress);
    deployed += sizeSol;
  }

  await saveLedger(ledger);
}

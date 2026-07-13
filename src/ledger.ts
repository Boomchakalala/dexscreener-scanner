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
// Phase 1+ sizing tiers — Flash alerts don't emit trade plans yet (flashPrompt.ts is
// untouched), so FLASH_SIZE_PCT (0.22) is reserved but unused until that's wired up.
const SIZE_PCT_BY_TIER: Record<TradePlan["tier"], number> = {
  "SPECULATIVE PUNT": 0.08,
  WATCH: 0.12,
  RECOMMENDATION: 0.18,
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
      entryCondition: plan.entryCondition,
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

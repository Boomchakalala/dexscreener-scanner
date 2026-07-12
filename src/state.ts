import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(STATE_DIR, "state.json");

const HISTORY_RETENTION_HOURS = 48;
const FLASH_RETENTION_HOURS = 6;

export type AlertKind = "deep" | "flash";

export interface AlertHistoryEntry {
  kind: AlertKind;
  symbol: string;
  tokenAddress: string;
  poolAddress: string;
  verdict: string;
  alertedAt: number; // ms epoch
}

interface State {
  history: AlertHistoryEntry[];
}

async function loadState(): Promise<State> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw) as State;
  } catch {
    return { history: [] };
  }
}

async function saveState(state: State): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function retentionHoursFor(kind: AlertKind): number {
  return kind === "flash" ? FLASH_RETENTION_HOURS : HISTORY_RETENTION_HOURS;
}

function isRetained(entry: AlertHistoryEntry, now: number): boolean {
  return entry.alertedAt >= now - retentionHoursFor(entry.kind) * 60 * 60 * 1000;
}

/** Returns tokens alerted within the retention window for that kind, for the model to judge whether a repeat still qualifies. */
export async function getRecentAlertHistory(kind: AlertKind): Promise<AlertHistoryEntry[]> {
  const state = await loadState();
  const now = Date.now();
  return state.history.filter((entry) => entry.kind === kind && isRetained(entry, now));
}

export async function recordAlerts(kind: AlertKind, entries: Omit<AlertHistoryEntry, "alertedAt" | "kind">[]): Promise<void> {
  const state = await loadState();
  const now = Date.now();
  const retained = state.history.filter((entry) => isRetained(entry, now));
  state.history = [...retained, ...entries.map((entry) => ({ ...entry, kind, alertedAt: now }))];
  await saveState(state);
}

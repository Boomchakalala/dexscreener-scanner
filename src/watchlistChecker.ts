import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getPoolStats, type PoolStats } from "./gecko.js";
import { sendTelegramMessage } from "./telegram.js";
import { loadWatchlistEntries, type WatchlistEntry } from "./watchlist.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(STATE_DIR, "watchlist-state.json");

/** Runtime checking state, deliberately in its OWN file: data/watchlist.json is written
 *  only by the deep scan (the conditions), this file only by the checks run (the progress
 *  checking them). When both lived in watchlist.json, the every-5-min priorVolume updates
 *  guaranteed a rebase conflict against every deep-scan push while the watchlist was
 *  non-empty — silently dropping the scan's freshly-emitted watch conditions. */
interface WatchlistRuntimeState {
  [tokenAddress: string]: { priorVolumeH1Usd: number; fired: boolean };
}

async function loadState(): Promise<WatchlistRuntimeState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf-8")) as WatchlistRuntimeState;
  } catch {
    return {};
  }
}

async function saveState(state: WatchlistRuntimeState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

const CONFIRM_SYSTEM_PROMPT = `You are confirming whether a specific, previously-stated watch condition for a Solana token has genuinely triggered right now, or whether this is a coincidental/false match on the deterministic pre-check. Be conservative — false positives erode trust in this alert. Only confirm if the current data genuinely supports the stated condition being met right now.

Respond with EXACTLY one word and nothing else: CONFIRM or REJECT.`;

function conditionMet(entry: WatchlistEntry, stats: PoolStats, priorVolumeH1Usd: number | undefined): boolean {
  const { mcMin, mcMax, requireRisingVolume } = entry.condition;
  if (mcMin !== null && stats.marketCapUsd < mcMin) return false;
  if (mcMax !== null && stats.marketCapUsd > mcMax) return false;
  if (requireRisingVolume) {
    // No baseline yet — this check just establishes one, it can't confirm a "rise" yet.
    if (priorVolumeH1Usd === undefined) return false;
    if (!(stats.volumeH1Usd > priorVolumeH1Usd)) return false;
  }
  return true;
}

/** Narrow, cheap confirm call — only made after the deterministic check above already
 *  looks like a hit, mirroring the rest of this project's "code filters cheaply, Claude
 *  judges the nuance" pattern. Not a full re-analysis, just a sanity check on one condition. */
async function confirmCondition(entry: WatchlistEntry, stats: PoolStats, priorVolumeH1Usd: number | undefined): Promise<boolean> {
  const userMessage = `Token: ${entry.symbol} (${entry.tokenAddress})
Original condition: ${entry.condition.description}
MC range: ${entry.condition.mcMin ?? "no min"} - ${entry.condition.mcMax ?? "no max"}
Requires rising 1h volume: ${entry.condition.requireRisingVolume}

Current market cap: $${Math.round(stats.marketCapUsd)}
Current liquidity: $${Math.round(stats.liquidityUsd)}
Current 1h volume: $${Math.round(stats.volumeH1Usd)}
Prior 1h volume reading: ${priorVolumeH1Usd === undefined ? "none yet (first check)" : `$${Math.round(priorVolumeH1Usd)}`}

Does this genuinely satisfy the original condition right now?`;

  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16,
    system: CONFIRM_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return (textBlock?.text ?? "").trim().toUpperCase().startsWith("CONFIRM");
}

/** Runs from GitHub Actions (via workflow_dispatch, fired every few minutes by a
 *  Cloudflare Cron Trigger) rather than from a Cloudflare Worker directly — GeckoTerminal's
 *  free tier 429'd every request from Cloudflare's shared egress IPs even at this trivial
 *  volume, while GitHub Actions' IPs run this scanner reliably all day at much higher volume. */
export async function runWatchlistCheck(): Promise<void> {
  const now = Date.now();
  const entries = await loadWatchlistEntries();
  const state = await loadState();
  const active = entries.filter((e) => e.expiresAt > now && !state[e.tokenAddress]?.fired);
  console.log(`Watchlist check: ${entries.length} total entries, ${active.length} active.`);

  for (const entry of active) {
    const stats = await getPoolStats(entry.chainId, entry.poolAddress);
    if (!stats) continue;

    const prior = state[entry.tokenAddress]?.priorVolumeH1Usd;
    const hit = conditionMet(entry, stats, prior);
    let fired = false;

    if (hit && (await confirmCondition(entry, stats, prior))) {
      await sendTelegramMessage(
        `🔔 **${entry.symbol}** — watch condition triggered\n${entry.condition.description}\nMC: ~$${Math.round(stats.marketCapUsd)} | 1h vol: ~$${Math.round(stats.volumeH1Usd)}\n[READ](${entry.dexUrl})`
      );
      console.log(`  -> ${entry.symbol}: CONFIRMED, alert sent.`);
      fired = true;
    }

    state[entry.tokenAddress] = { priorVolumeH1Usd: stats.volumeH1Usd, fired };
  }

  // Drop state for tokens no longer on the watchlist so the file doesn't grow forever.
  const watchedTokens = new Set(entries.map((e) => e.tokenAddress));
  for (const token of Object.keys(state)) {
    if (!watchedTokens.has(token)) delete state[token];
  }

  await saveState(state);
  console.log("Watchlist check complete.");
}

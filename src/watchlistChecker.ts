import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { getPoolStats, type PoolStats } from "./gecko.js";
import { sendTelegramMessage } from "./telegram.js";
import { loadWatchlistEntries, saveWatchlistEntries, type WatchlistEntry } from "./watchlist.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const CONFIRM_SYSTEM_PROMPT = `You are confirming whether a specific, previously-stated watch condition for a Solana token has genuinely triggered right now, or whether this is a coincidental/false match on the deterministic pre-check. Be conservative — false positives erode trust in this alert. Only confirm if the current data genuinely supports the stated condition being met right now.

Respond with EXACTLY one word and nothing else: CONFIRM or REJECT.`;

function conditionMet(entry: WatchlistEntry, stats: PoolStats): boolean {
  const { mcMin, mcMax, requireRisingVolume } = entry.condition;
  if (mcMin !== null && stats.marketCapUsd < mcMin) return false;
  if (mcMax !== null && stats.marketCapUsd > mcMax) return false;
  if (requireRisingVolume) {
    // No baseline yet — this check just establishes one, it can't confirm a "rise" yet.
    if (entry.priorVolumeH1Usd === undefined) return false;
    if (!(stats.volumeH1Usd > entry.priorVolumeH1Usd)) return false;
  }
  return true;
}

/** Narrow, cheap confirm call — only made after the deterministic check above already
 *  looks like a hit, mirroring the rest of this project's "code filters cheaply, Claude
 *  judges the nuance" pattern. Not a full re-analysis, just a sanity check on one condition. */
async function confirmCondition(entry: WatchlistEntry, stats: PoolStats): Promise<boolean> {
  const userMessage = `Token: ${entry.symbol} (${entry.tokenAddress})
Original condition: ${entry.condition.description}
MC range: ${entry.condition.mcMin ?? "no min"} - ${entry.condition.mcMax ?? "no max"}
Requires rising 1h volume: ${entry.condition.requireRisingVolume}

Current market cap: $${Math.round(stats.marketCapUsd)}
Current liquidity: $${Math.round(stats.liquidityUsd)}
Current 1h volume: $${Math.round(stats.volumeH1Usd)}
Prior 1h volume reading: ${entry.priorVolumeH1Usd === undefined ? "none yet (first check)" : `$${Math.round(entry.priorVolumeH1Usd)}`}

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
  const active = entries.filter((e) => e.expiresAt > now && !e.fired);
  console.log(`Watchlist check: ${entries.length} total entries, ${active.length} active.`);

  const updated = new Map<string, WatchlistEntry>();

  for (const entry of active) {
    const stats = await getPoolStats(entry.chainId, entry.poolAddress);
    if (!stats) continue;

    const hit = conditionMet(entry, stats);
    if (hit) {
      const confirmed = await confirmCondition(entry, stats);
      if (confirmed) {
        await sendTelegramMessage(
          `🔔 **${entry.symbol}** — watch condition triggered\n${entry.condition.description}\nMC: ~$${Math.round(stats.marketCapUsd)} | 1h vol: ~$${Math.round(stats.volumeH1Usd)}\n[READ](${entry.dexUrl})`
        );
        updated.set(entry.tokenAddress, { ...entry, priorVolumeH1Usd: stats.volumeH1Usd, fired: true });
        console.log(`  -> ${entry.symbol}: CONFIRMED, alert sent.`);
        continue;
      }
    }

    updated.set(entry.tokenAddress, { ...entry, priorVolumeH1Usd: stats.volumeH1Usd });
  }

  if (updated.size === 0) {
    console.log("No entries updated this check.");
    return;
  }

  const finalEntries = entries.map((e) => updated.get(e.tokenAddress) ?? e);
  await saveWatchlistEntries(finalEntries);
  console.log(`Updated ${updated.size} entr${updated.size === 1 ? "y" : "ies"} in data/watchlist.json.`);
}

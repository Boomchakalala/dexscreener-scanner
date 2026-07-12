# dexscreener-scanner

Scans the Solana memecoin market for early-stage "second move" setups —
tokens around $150K-$1.5M market cap showing chart structure, volume behavior,
and buyer/seller flow that suggests another leg up, while screening out rug risk.
Sends a Telegram report of the best 1-3 setups (or nothing, if nothing qualifies).
This does **not** trade anything — it's a read-only scanner/alerter. You decide
what to do with the alerts.

Runs on a schedule in GitHub Actions (not on your PC), so it fires every 4h —
plus a faster flash-alert pass every 20 min — regardless of whether your
machine is on. Repo: `github.com/Boomchakalala/dexscreener-scanner` (private).

## How it works

There are two scheduled jobs (`.github/workflows/`):

- **Deep scan** (`deep-scan.yml`, every 4h) — the full analysis below.
- **Flash scan** (`flash-scan.yml`, every 20 min) — a fast, narrow check for a
  sharp buy-side spike happening *right now* (5-minute candles, no rug check,
  cheaper Claude call). Completely silent when nothing qualifies — it does not
  message you every 20 minutes, only when something's actually flashing.

Both share the same pipeline shape:

1. **Discovery** — pulls trending + newly created Solana pools from GeckoTerminal
   (not DexScreener's boosted/paid-promotion lists — those bias toward marketing,
   not organic setups) and filters to the $150K-$1.5M market cap / $40K+ liquidity
   band. This is pure arithmetic filtering, not judgment.
2. **Enrichment** — deep scan pulls hourly OHLCV candles + a RugCheck wallet/rug
   report (mint/freeze authority, top-holder concentration, insider wallets, LP
   lock %). Flash scan pulls 5-minute candles only, skipping RugCheck for speed.
3. **Analysis** — Claude (Opus 4.8) does the actual judgment call. Deep scan
   follows your full criteria in `src/prompt.ts` (chart structure, volume
   behavior, buy/sell flow, rug risk → STRONG SETUP / NEEDS CONFIRMATION /
   AVOID). Flash scan follows the narrower `src/flashPrompt.ts` (is this
   exploding *right now*, yes or no). Both are real API calls with a small
   per-run cost.
4. **Alerting** — sends the report to Telegram. Tokens alerted recently (48h
   for deep, 6h for flash) are given to Claude as context so it can decide
   whether a repeat is still genuinely strong rather than being hard-suppressed
   by a timer.

Note: narrative/social signals (X mentions, Telegram community activity) are
**not** analyzed automatically — there's no reliable free API for that. Claude
skips that factor entirely; eyeball socials yourself before entering.

## Local development

```
npm install
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ANTHROPIC_API_KEY
npm run dev             # deep scan, once
npm run dev:flash       # flash scan, once
```

See `.env.example` for how to get each credential (Telegram bot via
@BotFather, chat ID via `getUpdates`, Anthropic key via the Console).

## Cloud deployment (already set up)

The GitHub repo has three secrets configured under **Settings → Secrets and
variables → Actions**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`ANTHROPIC_API_KEY`. The two workflows run on those schedules automatically —
nothing further to do. To change cadence, edit the `cron:` line in the
relevant workflow file. To run a scan manually (e.g. to test after a change):

```
gh workflow run deep-scan.yml
gh workflow run flash-scan.yml
gh run watch <run-id>
```

Alert history (`data/state.json`) is committed back to the repo by the
workflow after each run that produces a new verdict, so re-alert judgment
persists across runs even though each GitHub Actions run starts from a fresh
checkout.

## Tuning the criteria

The actual trading-setup logic lives entirely in `src/prompt.ts` (deep scan)
and `src/flashPrompt.ts` (flash scan) as instructions to Claude, not as code.
Edit those files to change what counts as a good setup — push to `master` and
the next scheduled run picks it up.

## Project layout

```
src/
  config.ts        env var loading + validation
  types.ts         GeckoTerminal / RugCheck / candidate data shapes
  gecko.ts         GeckoTerminal client (discovery + hourly/5-min candles)
  rugcheck.ts      RugCheck client (wallet/rug risk)
  discovery.ts     combines sources, applies hard floors, enriches survivors
  prompt.ts        deep-scan system prompt (edit to retune the main criteria)
  flashPrompt.ts   flash-scan system prompt (edit to retune the flash trigger)
  analysis.ts      calls Claude for either mode, splits report from tracking data
  telegram.ts      sends the report (chunked for Telegram's 4096-char limit)
  state.ts         recent-alert history (context for re-alert judgment, not a hard cooldown)
  main.ts          deep-scan entry point
  flash.ts         flash-scan entry point
.github/workflows/
  deep-scan.yml    runs main.ts every 4h
  flash-scan.yml   runs flash.ts every 20 min
```

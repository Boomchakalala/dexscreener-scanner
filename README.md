# dexscreener-scanner

Scans the Solana memecoin market across three age/market-cap "universes" —
Fresh Launches (0-2h, $30K-$300K), Survivors (2-8h, $100K-$1M), and Momentum
(8-24h, $250K-$3M) — for setups showing chart structure, volume behavior, and
buyer/seller flow that suggest another leg up, while screening out rug risk.
Sends a Telegram report of the best 1-3 setups plus a runners-overview of a
few more (or nothing, if nothing qualifies). This does **not** trade anything —
it's a read-only scanner/alerter. You decide what to do with the alerts.

Runs on a schedule in GitHub Actions (not on your PC), so it fires every 4h —
plus a faster flash-alert pass every hour — regardless of whether your
machine is on. Repo: `github.com/Boomchakalala/dexscreener-scanner` (private).

## How it works

There are two scheduled jobs (`.github/workflows/`):

- **Deep scan** (`deep-scan.yml`, every 4h) — the full analysis below.
- **Flash scan** (`flash-scan.yml`, every hour) — a fast, narrow check for a
  sharp buy-side spike happening *right now* (5-minute candles, no rug check,
  cheaper Claude call). Completely silent when nothing qualifies — it does not
  message you every hour, only when something's actually flashing.

Deep scan runs a four-stage discovery funnel before Claude ever sees a candidate
(`src/discovery.ts`, `src/scoring.ts`):

1. **Wide raw scan** — trending + newly created + by-24h-volume Solana pools
   from GeckoTerminal (not DexScreener's boosted/paid-promotion lists — those
   bias toward marketing, not organic setups), paginated wider than just the
   first ~100 (15 pages across the three sources — GeckoTerminal's free-tier
   burst limit is the ceiling here, not ambition).
2. **Hard floors** — market cap ($30K-$3M), liquidity, age (0-24h), and a
   liveliness check. Pure arithmetic, not judgment — this is the outer bound
   spanning all three universes, not per-universe filtering.
3. **Chart structure, then market quality** — a cheap chart-structure proxy
   (from price-change/volume shape, no extra API calls) cuts the floor-survivors
   to a shortlist; real hourly candles are then fetched for that shortlist and a
   market-quality re-rank (liquidity, buy/sell pressure, holder-growth proxy,
   candle structure — deliberately no rug-check input) narrows it to the small
   batch that goes to deep analysis. Chart structure is filtered first,
   deliberately, before any rug/safety signal.
4. **RugCheck — the final filter, not the first one** — fetched only for that
   already chart-and-quality-vetted batch (mint/freeze authority, top-holder
   concentration, insider wallets, LP lock %). A good chart never gets cut for
   RugCheck reasons before it was ever considered; only material risks
   (honeypot-style flags, danger-level authority/concentration risk) exclude a
   candidate here.

Flash scan skips stages 3-4's quality re-rank and RugCheck (speed over full
vetting) and just deep-analyzes the top of the chart-shortlisted batch with
5-minute candles.

Then, both modes:

- **Analysis** — Claude (Opus 4.8) does the actual judgment call. Deep scan
  follows your full criteria in `src/prompt.ts` (chart structure, volume
  behavior, buy/sell flow, rug risk → RECOMMENDATION / SPECULATIVE PUNT /
  WATCH / AVOID, each candidate's real chart/quality rank standing cited, not
  invented). Flash scan follows the narrower `src/flashPrompt.ts` (is this
  exploding *right now*, yes or no). Both are real API calls with a small
  per-run cost.
- **Alerting** — sends the report to Telegram. Tokens alerted recently (48h
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
  discovery.ts     wide raw scan -> hard floors -> chart shortlist -> candle/rugcheck enrichment
  scoring.ts       cheap chart-proxy + market-quality pre-scores (RugCheck-blind by design)
  prompt.ts        deep-scan system prompt (edit to retune the main criteria)
  flashPrompt.ts   flash-scan system prompt (edit to retune the flash trigger)
  analysis.ts      calls Claude for either mode, splits report from tracking data
  telegram.ts      sends the report (chunked for Telegram's 4096-char limit)
  state.ts         recent-alert history (context for re-alert judgment, not a hard cooldown)
  main.ts          deep-scan entry point
  flash.ts         flash-scan entry point
.github/workflows/
  deep-scan.yml    runs main.ts every 4h
  flash-scan.yml   runs flash.ts every hour
```

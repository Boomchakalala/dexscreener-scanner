# dexscreener-scanner

Scans the Solana memecoin market every run for early-stage "second move" setups —
tokens around $150K-$1.5M market cap showing chart structure, volume behavior,
and buyer/seller flow that suggests another leg up, while screening out rug risk.
Sends a Telegram report of the best 1-3 setups (or nothing, if nothing qualifies).
This does **not** trade anything — it's a read-only scanner/alerter. You decide
what to do with the alerts.

Meant to be run on a schedule (every 4h) via Windows Task Scheduler, not as a
long-running process.

## How it works

1. **Discovery** — pulls trending + newly created Solana pools from GeckoTerminal
   (not DexScreener's boosted/paid-promotion lists — those bias toward marketing,
   not organic setups) and filters to the $150K-$1.5M market cap / $40K+ liquidity
   band. This is pure arithmetic filtering, not judgment.
2. **Enrichment** — for surviving candidates, pulls hourly OHLCV candles
   (GeckoTerminal) and a wallet/rug-risk report (RugCheck: mint/freeze authority,
   top-holder concentration, insider wallets, LP lock %).
3. **Analysis** — Claude (Opus 4.8) does the actual judgment call: chart structure,
   volume behavior, buy/sell flow, rug risk, and a STRONG SETUP / NEEDS
   CONFIRMATION / AVOID verdict per your exact criteria (see `src/prompt.ts`).
   This step costs a small amount per run — it's a real API call, not a free
   heuristic.
4. **Alerting** — sends Claude's report to Telegram. Tokens alerted in the last
   48h are given to Claude as context so it can decide whether a repeat is still
   genuinely strong (per your "don't keep recommending the same old tokens"
   rule) rather than being hard-suppressed by a timer.

Note: narrative/social signals (X mentions, Telegram community activity) are
**not** analyzed automatically — there's no reliable free API for that. Claude
skips that factor entirely; eyeball socials yourself for the 1-3 shortlisted
tokens before entering.

## 1. Set up

```
npm install
npm run build
```

## 2. Create a Telegram bot and get your chat ID

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts. You'll get
   a **bot token** that looks like `123456789:AAExampleTokenAbCdEfGhIjKlMnOpQrStUvWx`.
2. Start a chat with your new bot (search for its username and hit "Start"), or add
   it to a group/channel you want alerts posted to.
3. Get your **chat ID**:
   - Send any message to the bot first.
   - Then visit (in a browser): `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Look for `"chat":{"id":...}` in the response — that number (may be negative for
     groups/channels) is your `TELEGRAM_CHAT_ID`.

## 3. Get an Anthropic API key

Create one at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).
This is what actually reads the charts and makes the call — budget for a small
per-run cost (roughly a few cents, depending on how many candidates pass the
market-cap/liquidity floors each run).

## 4. Configure

Copy `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
and `ANTHROPIC_API_KEY`. Tune the hard floors if you want a different market cap
band or candidate cap — but the actual "is this a good setup" judgment lives in
`src/prompt.ts`, not in config.

## 5. Run once manually to test

```
npm run dev
```

This scans, enriches, runs the analysis, and sends the report to Telegram.

## 6. Schedule it every 4 hours (Windows Task Scheduler)

1. Build the compiled version once: `npm run build` (produces `dist/main.js`).
2. Open **Task Scheduler** → **Create Task...**
3. **General** tab: name it `dexscreener-scanner`, "Run whether user is logged on or not" if you want it to fire even when locked.
4. **Triggers** tab → **New...** → "Daily", check **Repeat task every** → `4 hours`, **for a duration of** → `Indefinitely`.
5. **Actions** tab → **New...**:
   - Program/script: `node`
   - Add arguments: `dist/main.js`
   - Start in: `C:\Users\kevin\projects\dexscreener-scanner`
6. Save. Test it by right-clicking the task → **Run**, then check your Telegram chat.

## Tuning the criteria

The actual trading-setup logic — chart structure, volume behavior, wallet risk,
verdict classification — lives entirely in `src/prompt.ts` as instructions to
Claude, not as code. Edit that file to change what counts as a good setup.

## Project layout

```
src/
  config.ts       env var loading + validation
  types.ts        GeckoTerminal / RugCheck / candidate data shapes
  gecko.ts        GeckoTerminal client (discovery + OHLCV candles)
  rugcheck.ts      RugCheck client (wallet/rug risk)
  discovery.ts    combines sources, applies hard floors, enriches survivors
  prompt.ts       the trading-analyst system prompt (edit this to retune criteria)
  analysis.ts     calls Claude, splits human report from tracking data
  telegram.ts     sends the report (chunked for Telegram's 4096-char limit)
  state.ts        recent-alert history (context for re-alert judgment, not a hard cooldown)
  main.ts         ties it all together — entry point run each scan
```

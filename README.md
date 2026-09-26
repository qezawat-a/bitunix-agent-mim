# J-ROCK — AI Agent Futures Trader (Bitunix USDT-M)

This project is a JavaScript (Node 20+, ESM) AI Agent futures trader on Bitunix.
It combines a real-time signal scanner, an autonomous LLM agent, Telegram chat,
Neon long-memory, skills, soul/style prompts, MCP tools, and a Bitunix futures
trading engine.

## Quick start

```bash
npm install
cp .env.example .env
# fill your keys in .env
npm start
```

This bot has no dry-run mode. It talks to the live Bitunix account, and every
order is a decision the agent makes on its own judgement — there is no scripted
auto-trader. Use the Telegram chat to talk to it.

## Model selection (`AI_MODEL=AUTO`)

You give the bot a key and a base URL. It asks **that provider** which models the
key can see, and uses them:

1. `AI_PROVIDER=auto` treats every provider that has a key as a candidate.
2. A model written in `AI_MODEL` is used exactly as given — no probing.
3. With `AUTO` the agent calls `GET <AI_BASE_URL>/models` and probes the returned
   models **in the order the provider listed them**: first for a real tool call,
   then for any text reply.
4. If no probe answers, the first usable model from that list is used anyway — a
   failed probe is not proof the model is broken.
5. A model the key is not allowed to use (402/403, 404, quota) is skipped and the
   next model from the provider's list is tried. A model that answers **429 rate
   limited on that key** is skipped too, and remembered as rate-limited — not as
   denied — so a later re-resolution tries it again. A rejected *key* (401 invalid
   key) fails fast with the provider's own message.
6. Nothing is written to disk and there is no fallback list: after a restart the
   provider is asked again.

There is no hardcoded model ID, family list, ranking, or default model anywhere in
the code. `/models` shows what the provider returned plus which model is active.

## Main features

- Bitunix USDT-M futures REST + WebSocket client, including documented
  pagination, TP/SL, batch-order, copy-trading, and private push channels
- A committee of 10 weighted strategies, each voting +1/-1/0 with a stated
  reason: EMA, RSI, MACD, Bollinger, Momentum, Super Trend, ATR Breakout, Volume,
  ADX and Funding Rate. Confidence is the real weighted consensus, and
  `min_agreeing_strategies` counts strategies that back the direction — not
  timeframes.
- Multi-timeframe signal gate (`1m`, `3m`, `5m`, `15m`, `1h`): min confidence,
  tf confidence, strategy agreement, confirm scans, cooldown
- Dynamic ATR-based TP/SL sized from the live signal's own strength, with
  breakeven, trailing, and a liquidation-room guard
- Reversal: a hard opposite read closes the position and reports it to the agent
- Bitunix order units: `cost` (Cost Value), `qty` (Quantity Value), and
  `position_size` (Nominal Value); leverage affects Cost Value sizing only
- Autonomous agent loop (nudged once per *new* signal, not once per tick) with
  thinking levels, model auto-refresh on rate limit, and session resume
- Telegram bot: `/status`, `/start`, `/stop`, `/settings`, `/set`, `/get`,
  `/signal`, `/balance`, `/positions`, `/trades`, `/pnl`, `/close`, `/close_all`,
  `/scan`, `/report`, `/autonomous`, `/leverage`, `/symbol`, `/marginmode`,
  `/positionmode`, `/models`, `/setmodels`, `/connect`, `/harness`, `/skill`,
  `/soul`, `/mcp`, `/thinking`, `/memory`, `/resume`, `/ask`, `/diag`
- Telegram Web App control panel served at `/app` locally; set `MINI_APP_URL`
  to its public HTTPS deployment to enable the Telegram menu button
- JSONL harness via `npm run harness` and `/harness {"id":1,"message":"status"}`
- Built-in/custom skills, editable SOUL prompt, and reloadable MCP tools
- Neon Postgres persistence for validated settings and long-term memory

## Structure

```
src/
├── main.js
├── config.js
├── telegram-bot.js
├── telegram-trader.js
├── prompt.js
├── agent/
│   ├── loop.js
│   ├── brain.js
│   ├── auto-model.js
│   ├── thinking.js
│   ├── config.js
│   ├── memory.js
│   ├── skills.js
│   ├── mcp.js
│   ├── tools.js
│   ├── basic-tools.js
│   └── tui.js
├── bitunix/
│   ├── client.js
│   ├── ws.js
│   ├── indicators.js
│   ├── scanner.js
│   └── futures-tools.js
├── trader/
│   ├── trader.js
│   ├── position-manager.js
│   └── agent-tools.js
├── store/
│   ├── memory.js
│   └── persist.js
└── ui/
    └── tui.js

skills/
soul/
mini-app/
tests/
```

## Safety

Never commit `.env`. Bitunix API keys are mandatory: the bot refuses to start
without them, because it has no dry-run mode to fall back to.

The scanner never places an order. It produces a confirmed signal, and the agent
decides what to do with it — so a strategy bug cannot open a position on its own.
`/stop` halts the scan and autonomous loops; the agent still answers chat.
Position-level safety (TP/SL, breakeven, trailing, the liquidation guard) is
applied to whatever is open, however it got there.

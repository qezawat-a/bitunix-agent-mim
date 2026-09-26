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

Default safety: `DRY_RUN=1`. Real Bitunix orders are sent only after you
explicitly switch with `/dryrun 0` and enable `/autotrade on` in Telegram.

## Model selection (`AI_MODEL=AUTO`)

Ported from the CRAG agent, so the bot keeps talking instead of going quiet:

1. Every provider that has a key is a candidate (`AI_PROVIDER=auto`).
2. An explicitly configured model is used as-is — no probing.
3. With `AUTO` the catalog is read from `<base>/models`, ranked
   (free → cheap → rest, best family first, non-chat models filtered out) and
   each candidate is probed: first for a real tool call, then for any text reply.
4. If **no** probe passes, the best-ranked candidate is still used — a failed
   probe is not proof the model is broken. A rejected model (402/403 access
   denied, 404 unknown model, quota) automatically advances to the next one, and
   models the key may not use are skipped instead of retried.
5. A rejected *key* (401 invalid key) fails fast with the provider's own message.
6. The winning model is remembered in `data/model-cache.json`, so restarts do not
   re-probe. There are no hardcoded fallback model IDs anywhere.

`/models` shows the catalog plus the resolved model; `/diag` shows the provider,
base URL, configured and resolved model, and the last real error.

## Main features

- Bitunix USDT-M futures REST + WebSocket client, including documented
  pagination, TP/SL, batch-order, copy-trading, and private push channels
- 10 strategies: EMA trend, RSI momentum, MACD cross, volume confirmation,
  price momentum, ADX strength, Bollinger, funding-rate, Super Trend, ATR breakout
- Multi-timeframe signal gate (`1m`, `3m`, `5m`, `15m`, `1h`): min confidence, tf confidence, agreement,
  confirm scans, cooldown
- Dynamic ATR-based TP/SL, breakeven, trailing, liquidation-distance guard
- Bitunix order units: `cost` (Cost Value), `qty` (Quantity Value), and
  `position_size` (Nominal Value); leverage affects Cost Value sizing only
- Autonomous agent loop with thinking levels, model auto-refresh, sessions
- Telegram bot: `/status`, `/start`, `/stop`, `/settings`, `/dryrun`,
  `/autotrade`, `/memory`, `/resume`, `/models`, `/setModels`, `/harness`,
  `/skills` (or `/skils`), `/soul` (or `/sould`), `/mcp`, and `/ask`
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
│   ├── risk.js
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

Never commit `.env`. Use `DRY_RUN=1` for demo trading. Real orders require
`DRY_RUN=0` and valid Bitunix API keys.

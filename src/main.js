import 'dotenv/config';
import http from 'http';
import { CONFIG, validate } from './config.js';
import { BitunixClient } from './bitunix/client.js';
import { BitunixWs } from './bitunix/ws.js';
import Scanner from './bitunix/scanner.js';
import { Trader } from './trader/trader.js';
import { setTraderInstances, setPositionManager } from './trader/agent-tools.js';
import { setBitunixClient } from './bitunix/futures-tools.js';
import { createTraderCommands } from './telegram-trader.js';
import { sendMessage, isOwner, setCommands, esc } from './telegram-bot.js';
import { createAgent } from './agent/loop.js';
import { buildSystemPrompt } from './prompt.js';
import { basicTools } from './agent/basic-tools.js';
import { traderTools } from './trader/agent-tools.js';
import { bitunixTools } from './bitunix/futures-tools.js';
import { Memory } from './agent/memory.js';
import { listSkills } from './agent/skills.js';
import { loadStore, saveStore } from './store/persist.js';

async function main() {
  const missing = validate();
  if (missing.length) console.warn('[warn] missing env:', missing.join(', '));

  const stored = await loadStore();
  Object.assign(CONFIG, stored.settings || {});
  await saveStore({ settings: { ...CONFIG } });

  const client = new BitunixClient();
  const scanner = new Scanner(client);
  const trader = new Trader(client);
  setTraderInstances(trader, client);
  setPositionManager(trader.positionManager);
  setBitunixClient(client);

  const memory = new Memory();
  await memory.load();
  const skills = await listSkills();
  const tools = [...basicTools, ...traderTools, ...bitunixTools];
  const system = await buildSystemPrompt({ skills, tools, memory: memory.all() });
  const agent = createAgent({ system, tools, memory, maxRounds: CONFIG.AGENT_MAX_STEP, history: [], autoCompact: true, thinkingLevel: 'mid' });

  const { handleCommand, scanState, reportState } = createTraderCommands({ client, scanner, trader, agent });

  const ws = new BitunixWs({
    onPublic: () => {},
    onPrivate: () => {},
  });
  try { ws.connectPublic(['tickers']); } catch {}
  if (CONFIG.BITUNIX_API_KEY) { try { ws.connectPrivate(['balance', 'order', 'position', 'tp_sl']); } catch {} }

  await setCommands().catch(() => {});

  let offset = 0;
  async function poll() {
    try {
      const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`;
      const res = await fetch(url);
      const data = await res.json();
      for (const upd of data.result || []) {
        offset = upd.update_id + 1;
        const msg = upd.message;
        if (!msg?.text) continue;
        const text = msg.text.trim();
        if (!isOwner(msg)) continue;
        if (text.startsWith('/')) {
          const handled = await handleCommand(msg, text);
          if (!handled) {
            const reply = await agent.say(text);
            await sendMessage(msg.chat.id, esc(reply?.content || 'ok'));
          }
        } else {
          const reply = await agent.say(text);
          await sendMessage(msg.chat.id, esc(reply?.content || 'ok'));
        }
      }
    } catch (e) {
      console.error('poll error:', e.message);
    }
    setTimeout(poll, 1000);
  }
  if (CONFIG.TELEGRAM_BOT_TOKEN) poll();
  else console.warn('[warn] TELEGRAM_BOT_TOKEN missing — telegram disabled');

  setInterval(async () => {
    try {
      if (!scanState.scanOn) return;
      const sig = await trader.scanCycle();
      if (sig && reportState.reportOn && CONFIG.ALLOWED_USER_ID) {
        await sendMessage(CONFIG.ALLOWED_USER_ID, `<b>${esc(CONFIG.AGENT_NAME)}</b> signal <b>${esc(sig.signal)}</b> <code>${esc(sig.symbol)}</code> @ <code>${esc(String(sig.price))}</code>`);
      }
    } catch (e) {
      console.error('loop error:', e.message);
    }
  }, CONFIG.scan_interval_sec * 1000);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: CONFIG.AGENT_NAME, dry_run: CONFIG.dry_run, auto_trade: CONFIG.auto_trade }));
  });
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`[health] :${port}`));

  const shutdown = async () => {
    console.log('shutting down...');
    try { await saveStore({ settings: { ...CONFIG } }); } catch {}
    try { ws.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[${CONFIG.AGENT_NAME}] started. DRY_RUN=${CONFIG.dry_run ? 1 : 0} AUTO_TRADE=${CONFIG.auto_trade ? 'on' : 'off'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

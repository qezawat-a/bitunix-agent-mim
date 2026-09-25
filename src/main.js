import 'dotenv/config';
import http from 'http';
import fs from 'fs/promises';
import { CONFIG, validate, readSettingsFile, applySettingsFile } from './config.js';
import { BitunixClient } from './bitunix/client.js';
import { BitunixWs } from './bitunix/ws.js';
import Scanner from './bitunix/scanner.js';
import { Trader } from './trader/trader.js';
import { setTraderInstances, setPositionManager } from './trader/agent-tools.js';
import { setBitunixClient } from './bitunix/futures-tools.js';
import { createTraderCommands } from './telegram-trader.js';
import { sendMessage, isOwner, setCommands, setMenuButton, esc } from './telegram-bot.js';
import { createAgent } from './agent/loop.js';
import { buildSystemPrompt } from './prompt.js';
import { basicTools, setBasicMemory } from './agent/basic-tools.js';
import { traderTools } from './trader/agent-tools.js';
import { bitunixTools } from './bitunix/futures-tools.js';
import { Memory } from './agent/memory.js';
import { listSkills } from './agent/skills.js';
import { loadMcpTools, disposeMcpTools } from './agent/mcp.js';
import { loadStore, saveStore, closePersist } from './store/persist.js';
import { loadSession, saveSession } from './session-store.js';
import { applyPersistedSettings, getPersistentSettings, getTraderSettings, validateSettings } from './trader/settings.js';

async function main() {
  let fileSettings = {};
  try {
    fileSettings = await readSettingsFile();
    applySettingsFile(CONFIG, fileSettings);
  } catch (error) {
    console.warn('[warn] ignoring settings.json:', error.message);
  }
  const missing = validate();
  if (missing.length) console.warn('[warn] missing env:', missing.join(', '));
  const configErrors = validateSettings(getTraderSettings(CONFIG));
  if (configErrors.length) throw new Error(`invalid configuration: ${configErrors.join('; ')}`);
  if (!CONFIG.dry_run && (!CONFIG.BITUNIX_API_KEY || !CONFIG.BITUNIX_API_SECRET)) {
    CONFIG.dry_run = true;
    CONFIG.auto_trade = false;
    console.warn('[safety] live mode requires both BITUNIX_API_KEY and BITUNIX_API_SECRET; forced dry-run');
  }

  const stored = await loadStore();
  if (stored.settings) {
    try {
      applyPersistedSettings(CONFIG, stored.settings);
    } catch (error) {
      console.warn('[warn] ignoring invalid persisted settings:', error.message);
    }
  }
  await saveStore({ settings: getPersistentSettings(CONFIG) });

  const client = new BitunixClient();
  const scanner = new Scanner(client);
  const trader = new Trader(client);
  setTraderInstances(trader, client);
  setPositionManager(trader.positionManager);
  setBitunixClient(client);

  const memory = new Memory();
  await memory.load();
  const mcpServers = Array.isArray(fileSettings.mcp?.servers) ? fileSettings.mcp.servers : [];
  let mcpTools = await loadMcpTools(mcpServers);
  setBasicMemory(memory);
  let tools = [...basicTools, ...traderTools, ...bitunixTools, ...mcpTools];
  async function reloadMcpTools() {
    disposeMcpTools();
    mcpTools = await loadMcpTools(mcpServers);
    tools.splice(0, tools.length, ...basicTools, ...traderTools, ...bitunixTools, ...mcpTools);
    return mcpTools;
  }
  const getSystem = async () => buildSystemPrompt({ skills: await listSkills(), tools, memory: memory.all() });
  const agent = createAgent({ system: getSystem, tools, memory, maxRounds: CONFIG.AGENT_MAX_STEP, history: [], autoCompact: true, thinkingLevel: CONFIG.AGENT_THINKING_LEVEL });

  const { handleCommand, scanState, reportState } = createTraderCommands({
    client,
    scanner,
    trader,
    agent,
    loadSession,
    saveSession,
    mcpServers,
    getMcpTools: () => mcpTools,
    reloadMcpTools,
  });

  if (!CONFIG.dry_run && CONFIG.BITUNIX_API_KEY && CONFIG.BITUNIX_API_SECRET) {
    try {
      await trader.syncAccountSettings({ apply: CONFIG.auto_trade });
    } catch (error) {
      CONFIG.auto_trade = false;
      scanState.scanOn = false;
      console.error('[safety] account settings verification failed:', error.message);
    }
  }

  const ws = new BitunixWs({
    onPublic: () => {},
    onPrivate: event => { trader.handlePrivateEvent(event).catch(error => console.error('private state refresh error:', error.message)); },
  });
  try { ws.connectPublic(['tickers']); } catch {}
  if (CONFIG.BITUNIX_API_KEY && CONFIG.BITUNIX_API_SECRET) {
    try { ws.connectPrivate(['balance', 'order', 'position', 'tpsl']); } catch {}
  }

  await setCommands().catch(() => {});
  await setMenuButton().catch(error => console.warn('[warn] Telegram mini-app menu:', error.message));

  let offset = 0;
  let pollTimer = null;
  async function persistAgentSession(chatId) {
    try { await saveSession(String(chatId), { history: agent.history }); } catch (error) { console.error('session save error:', error.message); }
  }
  async function poll() {
    if (!CONFIG.TELEGRAM_BOT_TOKEN) return;
    try {
      const allowedUpdates = encodeURIComponent(JSON.stringify(['message', 'web_app_data']));
      const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}&allowed_updates=${allowedUpdates}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
      if (!res.ok) throw new Error(`Telegram poll ${res.status}`);
      const data = await res.json();
      for (const upd of data.result || []) {
        const webData = upd.web_app_data;
        const msg = webData
          ? { from: webData.from, chat: { id: CONFIG.ALLOWED_USER_ID } }
          : upd.message;
        try {
          const text = String(webData?.data || msg?.text || '').trim();
          if (text) {
            if (isOwner(msg)) {
              if (text.startsWith('/')) {
                const handled = await handleCommand(msg, text);
                if (!handled) {
                  const reply = await agent.say(text);
                  await sendMessage(msg.chat.id, esc(reply?.content || 'ok'));
                  await persistAgentSession(msg.chat.id);
                }
              } else {
                const reply = await agent.say(text);
                await sendMessage(msg.chat.id, esc(reply?.content || 'ok'));
                await persistAgentSession(msg.chat.id);
              }
            }
          }
        } catch (error) {
          console.error('telegram update error:', error.message);
        } finally {
          offset = Math.max(offset, upd.update_id + 1);
        }
      }
    } catch (error) {
      console.error('poll error:', error.message);
    }
    if (!stopping) pollTimer = setTimeout(poll, 1000);
  }

  let stopping = false;
  let scanTimer = null;
  async function runScanCycle() {
    if (stopping) return;
    try {
      if (scanState.scanOn) {
        const signal = await trader.scanCycle();
        if (signal && reportState.reportOn && CONFIG.ALLOWED_USER_ID) {
          await sendMessage(CONFIG.ALLOWED_USER_ID, `<b>${esc(CONFIG.AGENT_NAME)}</b> signal <b>${esc(signal.signal)}</b> <code>${esc(signal.symbol)}</code> @ <code>${esc(String(signal.price ?? signal.lastPrice ?? '-'))}</code>`);
        }
      } else {
        await Promise.allSettled([trader.guard(), trader.midManage(), trader.report()]);
      }
    } catch (error) {
      console.error('loop error:', error.message);
    } finally {
      if (!stopping) scanTimer = setTimeout(runScanCycle, Math.max(1000, CONFIG.scan_interval_sec * 1000));
    }
  }

  if (CONFIG.TELEGRAM_BOT_TOKEN) poll();
  else console.warn('[warn] TELEGRAM_BOT_TOKEN missing — telegram disabled');
  runScanCycle();

  const miniAppFile = new URL('../mini-app/index.html', import.meta.url);
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.pathname === '/app' || requestUrl.pathname === '/app/') {
      try {
        const html = await fs.readFile(miniAppFile);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Mini app not found');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: CONFIG.AGENT_NAME, dry_run: CONFIG.dry_run, auto_trade: CONFIG.auto_trade }));
  });
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`[health] :${port}`));

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (scanTimer) clearTimeout(scanTimer);
    try { await saveStore({ settings: getPersistentSettings(CONFIG) }); } catch (error) { console.error('shutdown save error:', error.message); }
    try { ws.close(); } catch {}
    try { disposeMcpTools(); } catch {}
    try { await closePersist(); } catch {}
    try { server.close(); } catch {}
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[${CONFIG.AGENT_NAME}] started. DRY_RUN=${CONFIG.dry_run ? 1 : 0} AUTO_TRADE=${CONFIG.auto_trade ? 'on' : 'off'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

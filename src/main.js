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
  if (!CONFIG.BITUNIX_API_KEY || !CONFIG.BITUNIX_API_SECRET) {
    throw new Error('BITUNIX_API_KEY and BITUNIX_API_SECRET are required: this bot has no dry-run mode and trades the live account');
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

  const agentState = { autonomous: Boolean(CONFIG.AGENT_AUTONOMOUS), lastNudge: null };
  const { handleCommand, scanState, reportState } = createTraderCommands({
    client,
    scanner,
    trader,
    agent,
    agentState,
    loadSession,
    saveSession,
    mcpServers,
    getMcpTools: () => mcpTools,
    reloadMcpTools,
  });

  try {
    await trader.syncAccountSettings({ apply: true });
  } catch (error) {
    scanState.scanOn = false;
    console.error('[safety] account settings verification failed, scanning stopped:', error.message);
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

  function describeSignalForAgent(signal) {
  const lines = [
    `New ${signal.signal} signal on ${signal.symbol} at ${signal.price ?? signal.lastPrice} (confidence ${signal.confidence}%).`,
  ];
  if (signal.agreeingStrategies?.length) lines.push(`Strategies behind it: ${signal.agreeingStrategies.join(', ')}.`);
  const timeframe = CONFIG.timeframes[0];
  const detail = signal.tfSignals?.[timeframe];
  if (detail) {
    lines.push(`${timeframe} votes:`);
    for (const item of detail.votes) lines.push(`  ${item.name}: ${item.detail}`);
  }
  if (signal.reversals?.length) {
    lines.push(`Reversal closed: ${signal.reversals.map(item => item.positionId).join(', ')} at confidence ${signal.reversals[0].confidence}%.`);
  }
  if (signal.reason && signal.reason !== 'awaiting_agent') lines.push(`Not actionable: ${signal.reason}.`);
  lines.push('This is your call. Act, or say why you are leaving it alone. Do not trade without a reason you can state.');
  return lines.join('\n');
}

  let stopping = false;
  let scanTimer = null;
  let lastSignal = null;
  async function runScanCycle() {
    if (stopping) return;
    try {
      const signal = scanState.scanOn ? await trader.scanCycle() : null;
      if (signal) lastSignal = signal;
      await trader.guard();
      await trader.midManage();
      if (reportState.reportOn) {
        const report = await trader.report({ lastSignal });
        if (report && CONFIG.ALLOWED_USER_ID) await sendMessage(CONFIG.ALLOWED_USER_ID, report);
      }
    } catch (error) {
      console.error('loop error:', error.message);
    } finally {
      if (!stopping) scanTimer = setTimeout(runScanCycle, Math.max(1000, CONFIG.scan_interval_sec * 1000));
    }
  }

  // The agent looks at a new signal once, not every tick. Waking an LLM every
  // 15 seconds for a market that has not changed costs thousands of calls a day
  // and teaches the agent to act on noise, so it is nudged only when the read
  // it has not seen yet, or when a reversal just closed a position.
  let agentTimer = null;
  let agentBusy = false;
  let lastNudgedSignal = null;
  function signalKey(signal) {
    return `${signal.symbol}|${signal.signal}|${signal.confidence}|${signal.confirmations ?? 0}|${signal.strategyAgreement ?? ''}`;
  }
  async function runAgentCycle() {
    if (stopping) return;
    try {
      if (agentState.autonomous && lastSignal && !agentBusy) {
        const key = signalKey(lastSignal);
        const isNew = key !== lastNudgedSignal;
        const reversed = Array.isArray(lastSignal.reversals) && lastSignal.reversals.length > 0;
        if (isNew && (lastSignal.reason === 'awaiting_agent' || reversed)) {
          lastNudgedSignal = key;
          agentBusy = true;
          try {
            const reply = await agent.say(describeSignalForAgent(lastSignal));
            agentState.lastNudge = new Date().toISOString();
            if (CONFIG.ALLOWED_USER_ID) await sendMessage(CONFIG.ALLOWED_USER_ID, esc(reply.content || reply.reply || ''));
          } catch (error) {
            console.error('agent cycle error:', error.message);
          } finally {
            agentBusy = false;
          }
        }
      }
    } finally {
      if (!stopping) agentTimer = setTimeout(runAgentCycle, Math.max(1000, Number(CONFIG.AGENT_AUTONOMOUS_INTERVAL_SEC || 15) * 1000));
    }
  }

  if (CONFIG.TELEGRAM_BOT_TOKEN) poll();
  else console.warn('[warn] TELEGRAM_BOT_TOKEN missing — telegram disabled');
  runScanCycle();
  if (agentState.autonomous) runAgentCycle();

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
    res.end(JSON.stringify({ ok: true, name: CONFIG.AGENT_NAME, symbol: CONFIG.symbol, positions: trader.state.positions.length }));
  });
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`[health] :${port}`));

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (scanTimer) clearTimeout(scanTimer);
    if (agentTimer) clearTimeout(agentTimer);
    try { await saveStore({ settings: getPersistentSettings(CONFIG) }); } catch (error) { console.error('shutdown save error:', error.message); }
    try { ws.close(); } catch {}
    try { disposeMcpTools(); } catch {}
    try { await closePersist(); } catch {}
    try { server.close(); } catch {}
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[${CONFIG.AGENT_NAME}] started. LIVE account, symbol=${CONFIG.symbol}, agent decides every trade`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

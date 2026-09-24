import { CONFIG } from './config.js';
import { sendMessage, isOwner, esc, formatSignalReport } from './telegram-bot.js';

export function createTraderCommands({ client, scanner, trader, agent }) {
  const scanState = { scanOn: true };
  const reportState = { reportOn: true };

  async function handleCommand(msg, text) {
    const chatId = msg.chat.id;
    if (!isOwner(msg)) {
      await sendMessage(chatId, 'Not authorized.');
      return true;
    }
    const [cmdRaw, ...rest] = text.trim().split(/\s+/);
    const cmd = cmdRaw.replace(/^\//, '').split('@')[0];
    const arg = rest.join(' ');

    switch (cmd) {
      case 'start': {
        await sendMessage(chatId, `<b>${esc(CONFIG.AGENT_NAME)}</b> started. DRY_RUN=<code>${CONFIG.dry_run ? 1 : 0}</code> AUTO_TRADE=<code>${CONFIG.auto_trade ? 'on' : 'off'}</code>`);
        return true;
      }
      case 'stop': {
        CONFIG.auto_trade = false;
        await sendMessage(chatId, 'Auto-trade stopped. Loops halted.');
        return true;
      }
      case 'help': {
        await sendMessage(chatId, `<b>Commands</b>\n/start /stop /status /help /settings /set /get /signal /balance /positions /trades /pnl /close /close_all /dryrun /autotrade /scan /report /leverage /symbol /models /thinking /memory /resume /ask /diag`);
        return true;
      }
      case 'status': {
        await sendMessage(chatId, `<b>Status</b>\nsymbol <code>${esc(CONFIG.symbol)}</code>\nlev <code>${CONFIG.leverage}</code> ${esc(CONFIG.position_type)}/${esc(CONFIG.position_mode)}\ndry_run <code>${CONFIG.dry_run ? 1 : 0}</code> auto_trade <code>${CONFIG.auto_trade ? 'on' : 'off'}</code>\nscan <code>${scanState.scanOn ? 'on' : 'off'}</code> report <code>${reportState.reportOn ? 'on' : 'off'}</code>\nopen <code>${trader?.state?.positions?.length ?? 0}</code>`);
        return true;
      }
      case 'settings': {
        const rows = Object.entries(CONFIG).map(([k, v]) => `${esc(k)}: <code>${esc(Array.isArray(v) ? v.join(',') : String(v))}</code>`).join('\n');
        await sendMessage(chatId, `<b>Settings</b>\n${rows}`);
        return true;
      }
      case 'set': {
        const [k, ...vParts] = arg.split(/\s+/);
        const v = vParts.join(' ');
        if (!k) { await sendMessage(chatId, 'Usage: /set key value'); return true; }
        const key = k === 'margin_mode' ? 'position_type' : k;
        let val = v;
        if (v === 'true') val = true;
        else if (v === 'false') val = false;
        else if (!isNaN(Number(v)) && v !== '') val = Number(v);
        CONFIG[key] = val;
        await sendMessage(chatId, `Set <code>${esc(key)}</code> = <code>${esc(String(val))}</code>`);
        return true;
      }
      case 'get': {
        await sendMessage(chatId, `<code>${esc(arg)}</code> = <code>${esc(String(CONFIG[arg] ?? '-'))}</code>`);
        return true;
      }
      case 'signal': {
        const sym = arg || CONFIG.symbol;
        const res = await scanner.scan(sym);
        await sendMessage(chatId, formatSignalReport(res));
        return true;
      }
      case 'balance': {
        const acc = await client.getAccount('USDT');
        await sendMessage(chatId, `<b>Balance</b>\n<code>${esc(JSON.stringify(acc, null, 1))}</code>`);
        return true;
      }
      case 'positions': {
        const pos = await client.getPendingPositions(CONFIG.symbol);
        await sendMessage(chatId, `<b>Positions</b>\n<code>${esc(JSON.stringify(pos, null, 1))}</code>`);
        return true;
      }
      case 'trades': {
        const [o, p] = await Promise.all([
          client.getHistoryOrders(CONFIG.symbol),
          client.getHistoryPositions(CONFIG.symbol),
        ]);
        await sendMessage(chatId, `<b>Orders</b>\n<code>${esc(JSON.stringify(o, null, 1).slice(0, 2000))}</code>\n<b>Positions</b>\n<code>${esc(JSON.stringify(p, null, 1).slice(0, 1500))}</code>`);
        return true;
      }
      case 'pnl': {
        const pos = await client.getPendingPositions(CONFIG.symbol);
        await sendMessage(chatId, `<b>PnL</b>\n<code>${esc(JSON.stringify(pos, null, 1))}</code>`);
        return true;
      }
      case 'close':
      case 'close_all': {
        if (CONFIG.dry_run) { await sendMessage(chatId, 'DRY_RUN=1 — simulated close.'); return true; }
        const res = await client.closeAllPosition(arg || CONFIG.symbol);
        await sendMessage(chatId, `Closed: <code>${esc(JSON.stringify(res))}</code>`);
        return true;
      }
      case 'dryrun': {
        CONFIG.dry_run = arg !== '0';
        await sendMessage(chatId, `DRY_RUN=<code>${CONFIG.dry_run ? 1 : 0}</code>`);
        return true;
      }
      case 'autotrade': {
        CONFIG.auto_trade = /on|1|true/i.test(arg);
        await sendMessage(chatId, `AUTO_TRADE=<code>${CONFIG.auto_trade ? 'on' : 'off'}</code>`);
        return true;
      }
      case 'scan': {
        scanState.scanOn = !/off|0/.test(arg);
        await sendMessage(chatId, `scan <code>${scanState.scanOn ? 'on' : 'off'}</code>`);
        return true;
      }
      case 'report': {
        reportState.reportOn = !/off|0/.test(arg);
        await sendMessage(chatId, `report <code>${reportState.reportOn ? 'on' : 'off'}</code>`);
        return true;
      }
      case 'leverage': {
        const lev = Number(arg);
        if (!lev) { await sendMessage(chatId, 'Usage: /leverage 10'); return true; }
        CONFIG.leverage = lev;
        if (!CONFIG.dry_run) await client.changeLeverage(CONFIG.symbol, lev);
        await sendMessage(chatId, `leverage <code>${lev}</code>`);
        return true;
      }
      case 'symbol': {
        if (!arg) { await sendMessage(chatId, 'Usage: /symbol BTCUSDT'); return true; }
        CONFIG.symbol = arg.toUpperCase();
        await sendMessage(chatId, `symbol <code>${esc(CONFIG.symbol)}</code>`);
        return true;
      }
      case 'models': {
        await sendMessage(chatId, `openai: <code>${esc(CONFIG.AI_MODEL)}</code>\nanthropic: <code>${esc(CONFIG.ANTHROPIC_MODEL)}</code>\ngoogle: <code>${esc(CONFIG.GEMINI_MODEL)}</code>`);
        return true;
      }
      case 'thinking': {
        CONFIG.AGENT_THINKING_ENABLED = arg !== 'off';
        await sendMessage(chatId, `thinking <code>${esc(arg || 'mid')}</code>`);
        return true;
      }
      case 'memory': {
        await sendMessage(chatId, `memory keys: <code>${esc(Object.keys(agent?.memory?.all?.() || {}).join(', ') || '-')}</code>`);
        return true;
      }
      case 'resume': {
        await sendMessage(chatId, `session resumed: <code>${esc(arg || 'latest')}</code>`);
        return true;
      }
      case 'ask': {
        const reply = await agent.say(arg || 'status?');
        await sendMessage(chatId, esc(reply?.content || 'ok'));
        return true;
      }
      case 'diag': {
        await sendMessage(chatId, `<b>Diag</b>\napi <code>${client ? 'ready' : 'missing'}</code>\ndb <code>${CONFIG.DATABASE_URL ? 'neon' : 'file'}</code>\nws <code>public+private</code>`);
        return true;
      }
      default:
        return false;
    }
  }

  return { handleCommand, scanState, reportState };
}

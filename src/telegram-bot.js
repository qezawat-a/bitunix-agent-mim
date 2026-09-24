import { CONFIG } from './config.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendMessage(chatId, html) {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const chunks = [];
  let text = String(html);
  while (text.length > 3500) {
    let cut = text.lastIndexOf('\n', 3500);
    if (cut < 0) cut = 3500;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut);
  }
  chunks.push(text);
  for (const part of chunks) {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  }
}

export function isOwner(msg) {
  const id = msg?.from?.id ?? msg?.chat?.id;
  return String(id) === String(CONFIG.ALLOWED_USER_ID);
}

export async function setCommands() {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const commands = [
    { command: 'start', description: 'Start bot' },
    { command: 'stop', description: 'Stop loops' },
    { command: 'status', description: 'Status' },
    { command: 'help', description: 'Help' },
    { command: 'settings', description: 'All settings' },
    { command: 'set', description: 'Set key value' },
    { command: 'get', description: 'Get key' },
    { command: 'signal', description: 'Live signal' },
    { command: 'balance', description: 'Balance' },
    { command: 'positions', description: 'Open positions' },
    { command: 'trades', description: 'Recent trades' },
    { command: 'pnl', description: 'PnL report' },
    { command: 'close', description: 'Close position' },
    { command: 'close_all', description: 'Close all' },
    { command: 'dryrun', description: 'dryrun 1|0' },
    { command: 'autotrade', description: 'autotrade on|off' },
    { command: 'scan', description: 'scan on|off' },
    { command: 'report', description: 'report on|off' },
    { command: 'leverage', description: 'Set leverage' },
    { command: 'symbol', description: 'Set symbol' },
    { command: 'models', description: 'LLM models' },
    { command: 'thinking', description: 'thinking off|low|mid|high|max' },
    { command: 'memory', description: 'Memory show' },
    { command: 'resume', description: 'Resume session' },
    { command: 'ask', description: 'Ask the agent' },
    { command: 'diag', description: 'Diagnostics' },
  ];
  await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  });
}

export function formatSignalReport(res) {
  const tfRows = Object.entries(res.tfSignals || {})
    .map(([tf, s]) => `${esc(tf)}: ${esc(s.direction)} <code>${s.confidence}</code>`)
    .join('\n');
  return `<b>SIGNAL ${esc(res.symbol)}</b>\nDirection: <b>${esc(res.signal)}</b> | Confidence: <b>${esc(String(res.confidence))}</b>\nPrice: <code>${esc(String(res.lastPrice ?? '-'))}</code>\n${tfRows}`;
}

export { esc };

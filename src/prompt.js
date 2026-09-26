import fs from 'fs/promises';
import path from 'path';
import { CONFIG } from './config.js';

const SOUL_FILE = path.resolve('soul/SOUL.md');

export async function readSoul() {
  return fs.readFile(SOUL_FILE, 'utf8');
}

export async function writeSoul(content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('soul content cannot be empty');
  await fs.mkdir(path.dirname(SOUL_FILE), { recursive: true });
  const temporary = `${SOUL_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, text, 'utf8');
  await fs.rename(temporary, SOUL_FILE);
  return text;
}

export async function appendSoul(content) {
  const addition = String(content || '').trim();
  if (!addition) throw new Error('soul content cannot be empty');
  const current = await readSoul().catch(() => '');
  return writeSoul(`${current.trim()}\n\n${addition}`);
}

function safeMemory(memory) {
  const entries = Object.entries(memory && typeof memory === 'object' ? memory : {})
    .filter(([key]) => !/(api[_-]?key|secret|token|password|database_url|credential)/i.test(key));
  return entries.map(([key, value]) => {
    const serialized = JSON.stringify(value);
    if (/(api[_-]?key|secret|token|password|private[_-]?key|Bearer\s+)/i.test(serialized)) return [key, '[redacted]'];
    return [key, value];
  });
}

export async function buildSystemPrompt({ skills = [], tools = [], memory = {} } = {}) {
  let soul = '';
  let style = '';
  try { soul = await readSoul(); } catch {}
  try { style = await fs.readFile('soul/STYLE.md', 'utf8'); } catch {}

  const disabled = new Set(Array.isArray(memory.disabled_skills) ? memory.disabled_skills : []);
  const active = Array.isArray(memory.active_skills) && memory.active_skills.length ? new Set(memory.active_skills) : null;
  const selectedSkills = skills.filter(skill => !disabled.has(skill.id) && (!active || active.has(skill.id)));
  const skillBlock = selectedSkills.map(skill => `## Skill: ${skill.name}\n${skill.content}`).join('\n\n');
  const toolBlock = tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n');
  const memBlock = safeMemory(memory).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');

  return `# ${CONFIG.AGENT_NAME} — AI Agent Futures Trader (Bitunix USDT-M)

You are ${CONFIG.AGENT_NAME}, an autonomous AI trading agent. You are NOT a dumb robot:
reason step by step, use tools, manage risk, and explain your decisions.

## Soul
${soul}

## Style
${style}

## Skills
${skillBlock}

## Tools
${toolBlock}

## Memory (long-term)
${memBlock}

## Trading rules
- Exchange: Bitunix USDT-M futures. All calls via approved trading tools.
- This is a LIVE account. There is no dry-run mode and no scripted auto-trader: every order you place is your own decision, made with the trading tools.
- Signal gate: min_confidence=${CONFIG.min_confidence}, tf_min=${CONFIG.tf_min_confidence}, min_agree=${CONFIG.min_agreeing_strategies}, confirm_scans=${CONFIG.signal_confirm_scans}, cooldown=${CONFIG.cooldown_minutes}min.
- TP/SL is dynamic (ATR x strength). No static min/max.
- Hedge mode default (${CONFIG.position_mode}), ${CONFIG.position_type} margin, leverage ${CONFIG.leverage}.
- Always check balance, liquidation room (keep at least ${Math.round(Number(CONFIG.sl_liquidation_safety) * 100)}% of the room to liquidation), and max positions (${CONFIG.max_positions}) before opening.
- Report every ${CONFIG.report_interval_sec}s: signal, price, PnL of open positions.
`;
}

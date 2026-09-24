import { CONFIG } from '../config.js';
import { parseThinkingLevel } from './thinking.js';

export function createAgent({ system, tools, memory, maxRounds = 8, history = [], autoCompact = true, thinkingLevel = 'mid' }) {
  const level = parseThinkingLevel(thinkingLevel);
  const budget = CONFIG.AGENT_THINKING_BUDGET || 5000;
  const compactHistory = (tokens) => tokens > 8000;
  let turns = 0;
  for (const m of history) { turns += m.tokens || 0; }
  const shouldCompact = compactHistory(turns);
  return {
    system,
    tools,
    memory,
    maxRounds,
    history,
    autoCompact,
    thinkingLevel: level,
    thinkingBudget: budget,
    compact: shouldCompact,
    compactHistory: (h) => h,
    say: async (text) => ({ role: 'assistant', content: text }),
    replaceHistory: (h) => h,
    compactHistory: async (h) => h,
    maybeCompact: () => compactHistory(turns),
    isAutoCompact: () => autoCompact,
  };
}

export async function say(agent, text) {
  return { role: 'assistant', content: text };
}

export function replaceHistory(history, newHistory) {
  return newHistory;
}

export async function compactHistory(history) {
  const summary = history.reduce((acc, m) => acc + (m.content || '').slice(0, 200), '');
  return summary.slice(0, 1000);
}

export function maybeCompact(memory, budget) {
  return budget > (CONFIG.AGENT_THINKING_BUDGET || 5000);
}

export function isAutoCompact() {
  return true;
}
import { CONFIG } from '../config.js';
import { parseThinkingLevel } from './thinking.js';
import { chat } from './brain.js';
import { detectProviders } from './config.js';
import { withTimeout } from './tools.js';

export function createAgent({ system, tools, memory, maxRounds = 8, history = [], autoCompact = true, thinkingLevel = 'mid' }) {
  const agent = {
    system,
    tools: tools || [],
    memory,
    maxRounds,
    history: [...history],
    autoCompact,
    thinkingLevel: parseThinkingLevel(thinkingLevel),
    thinkingBudget: CONFIG.AGENT_THINKING_BUDGET || 5000,
  };
  agent.say = (text) => say(agent, text);
  agent.replaceHistory = (h) => { agent.history = h; return h; };
  agent.compactHistory = async (h) => (h || agent.history).slice(-10);
  agent.maybeCompact = () => agent.history.length > 40;
  agent.isAutoCompact = () => autoCompact;
  return agent;
}

function buildMessages(agent, provider) {
  const sys = { role: 'system', content: agent.system };
  const hist = agent.history.slice(-20);
  if (provider === 'openai') {
    return [sys, ...hist];
  }
  const clean = hist
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  return [sys, ...clean];
}

export async function say(agent, text) {
  const input = String(text ?? '');
  agent.history.push({ role: 'user', content: input });
  if (agent.history.length > 40) agent.history = agent.history.slice(-40);

  const hasKey = CONFIG.AI_API_KEY || CONFIG.ANTHROPIC_API_KEY || CONFIG.GEMINI_API_KEY;
  if (!hasKey) {
    const reply = `AI key set nist — man hanuz be LLM vasl nistam, pas nemitunam javab vaghei bedam.\n\nDar .env yekio por kon:\n- AI_API_KEY (+ AI_BASE_URL, AI_MODEL)\n- ya ANTHROPIC_API_KEY\n- ya GEMINI_API_KEY\n\nBad restart kon (npm start) va dobare bepors.`;
    agent.history.push({ role: 'assistant', content: reply });
    return { role: 'assistant', content: reply };
  }

  const provider = detectProviders();
  const useTools = provider === 'openai' && agent.tools.length > 0;
  let finalText = '';

  try {
    for (let round = 0; round < (agent.maxRounds || 8); round++) {
      const messages = buildMessages(agent, provider);
      const res = await withTimeout(chat(messages, provider, useTools ? agent.tools : []), 60000);
      if (res.text) finalText = res.text;
      const toolCalls = res.toolCalls || [];
      if (!toolCalls.length) break;

      if (provider === 'openai') {
        agent.history.push({
          role: 'assistant',
          content: res.text || null,
          tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: tc.function })),
        });
      }
      for (const tc of toolCalls) {
        const name = tc.function?.name || tc.name;
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        const tool = agent.tools.find((t) => t.name === name);
        let result;
        try {
          result = tool ? await withTimeout(tool.handler(args), 20000) : { error: `unknown tool: ${name}` };
        } catch (e) {
          result = { error: String(e?.message || e) };
        }
        const content = JSON.stringify(result).slice(0, 4000);
        if (provider === 'openai') {
          agent.history.push({ role: 'tool', tool_call_id: tc.id, content });
        } else {
          agent.history.push({ role: 'user', content: `[tool ${name} result]\n${content}` });
        }
      }
    }
  } catch (e) {
    finalText = `LLM error: ${e.message}. (AI key/model o check kon — /models ro bebin)`;
  }

  if (!finalText) finalText = 'Hichi bar nagasht — dobare bepors.';
  agent.history.push({ role: 'assistant', content: finalText });
  return { role: 'assistant', content: finalText };
}

export function replaceHistory(history, newHistory) {
  return newHistory;
}

export async function compactHistory(history) {
  const summary = (history || []).reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content : '').slice(0, 200), '');
  return summary.slice(0, 1000);
}

export function maybeCompact(memory, budget) {
  return budget > (CONFIG.AGENT_THINKING_BUDGET || 5000);
}

export function isAutoCompact() {
  return true;
}

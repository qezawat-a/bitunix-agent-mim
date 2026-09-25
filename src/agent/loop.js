import { CONFIG } from '../config.js';
import { parseThinkingLevel } from './thinking.js';
import { chat } from './brain.js';
import { detectProviders } from './config.js';
import { withTimeout, validateToolArguments, stringifyToolResult } from './tools.js';

function resolveSystem(agent) {
  return typeof agent.system === 'function' ? agent.system() : Promise.resolve(agent.system);
}

function cleanHistory(history) {
  return history
    .filter(message => message && typeof message === 'object' && ['user', 'assistant', 'tool'].includes(message.role))
    .map(message => ({ ...message }));
}

function buildMessages(agent, _provider, system) {
  const hist = cleanHistory(agent.history.slice(-20));
  return [{ role: 'system', content: system }, ...hist];
}

function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  const parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('tool arguments must be an object');
  return parsed;
}

export function createAgent({ system, tools, memory, maxRounds = 8, history = [], autoCompact = true, thinkingLevel = 'mid' }) {
  const agent = {
    system,
    tools: tools || [],
    memory,
    maxRounds,
    history: Array.isArray(history) ? [...history] : [],
    autoCompact,
    thinkingLevel: parseThinkingLevel(thinkingLevel),
    thinkingBudget: CONFIG.AGENT_THINKING_BUDGET || 5000,
    lastProvider: null,
    lastModel: null,
    lastError: null,
    lastResponse: null,
  };
  agent.say = (text) => say(agent, text);
  agent.replaceHistory = (next) => {
    if (!Array.isArray(next)) throw new Error('history must be an array');
    agent.history = [...next];
    return agent.history;
  };
  agent.compactHistory = async (input) => compactHistory(input || agent.history);
  agent.maybeCompact = () => agent.autoCompact && agent.history.length > 40;
  agent.isAutoCompact = () => agent.autoCompact;
  return agent;
}

function responseText(response) {
  return typeof response?.text === 'string' ? response.text.trim() : '';
}

function retryableModelError(error) {
  return /network|fetch failed|timeout|timed out|econnreset|eai_again|socket|429|50\d|502|503|504/i.test(String(error?.message || error));
}

async function callModel(agent, messages, provider, tools) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await withTimeout(signal => chat(messages, provider, tools, { signal }), 60000);
      agent.lastResponse = response;
      if (response?.model) agent.lastModel = response.model;
      agent.lastError = null;
      return response;
    } catch (error) {
      lastError = error;
      agent.lastError = error.message || String(error);
      if (attempt === 0 && retryableModelError(error)) {
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function say(agent, text) {
  const input = String(text ?? '');
  agent.history.push({ role: 'user', content: input });
  if (agent.autoCompact && agent.history.length > 40) agent.history = await agent.compactHistory(agent.history);
  agent.lastError = null;

  let provider;
  try {
    provider = detectProviders();
    agent.lastProvider = provider;
  } catch (error) {
    agent.lastError = error.message;
    const reply = `Agent configuration error: ${error.message}`;
    agent.history.push({ role: 'assistant', content: reply });
    return { role: 'assistant', content: reply };
  }

  const hasKey = provider === 'openai'
    ? Boolean(CONFIG.AI_API_KEY)
    : provider === 'anthropic'
      ? Boolean(CONFIG.ANTHROPIC_API_KEY)
      : Boolean(CONFIG.GEMINI_API_KEY);
  if (!hasKey) {
    agent.lastError = `No API key configured for ${provider}`;
    const reply = `AI key is not configured for ${provider}. Add the matching key to .env, restart, and send /diag.\n\nهیچ کلید LLM تنظیم نشده است.`;
    agent.history.push({ role: 'assistant', content: reply });
    return { role: 'assistant', content: reply };
  }

  const useTools = agent.tools.length > 0;
  let finalText = '';
  let hadToolCalls = false;
  let lastFinishReason = null;

  try {
    const system = await resolveSystem(agent);
    for (let round = 0; round < (agent.maxRounds || 8); round++) {
      const messages = buildMessages(agent, provider, system);
      const res = await callModel(agent, messages, provider, useTools ? agent.tools : []);
      const text = responseText(res);
      if (text) finalText = text;
      lastFinishReason = res?.finishReason || lastFinishReason;
      const toolCalls = Array.isArray(res?.toolCalls) ? res.toolCalls : [];
      if (!toolCalls.length) break;
      hadToolCalls = true;

      agent.history.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: call.function })),
      });
      for (const call of toolCalls) {
        const name = call.function?.name || call.name;
        let result;
        try {
          const args = parseToolArguments(call.function?.arguments);
          const tool = agent.tools.find(candidate => candidate.name === name);
          if (!tool) throw new Error(`unknown tool: ${name}`);
          validateToolArguments(tool.parameters || {}, args);
          result = await withTimeout(signal => tool.handler(args, { signal }), 20000);
        } catch (error) {
          result = { error: error.message || String(error) };
        }
        const content = stringifyToolResult(result);
        agent.history.push({ role: 'tool', tool_call_id: call.id, name, content });
      }
    }

    if (!finalText) {
      const finalMessages = [...buildMessages(agent, provider, system), {
        role: 'user',
        content: 'Answer the user now with a concise natural-language response. Do not call tools.',
      }];
      const finalResponse = await callModel(agent, finalMessages, provider, []);
      finalText = responseText(finalResponse);
    }
  } catch (error) {
    agent.lastError = error.message || String(error);
    finalText = `LLM error: ${agent.lastError}. Check /diag and /models.`;
  }

  if (!finalText) {
    const detail = agent.lastError || (lastFinishReason ? `finish_reason=${lastFinishReason}` : hadToolCalls ? 'tool loop ended without a final answer' : 'empty provider response');
    agent.lastError = detail;
    finalText = `The LLM returned no text (${detail}). Check /diag and /models, then try again.`;
  }
  agent.history.push({ role: 'assistant', content: finalText });
  return { role: 'assistant', content: finalText };
}

export function replaceHistory(history, newHistory) {
  if (!Array.isArray(newHistory)) throw new Error('history must be an array');
  return [...newHistory];
}

export async function compactHistory(history) {
  const messages = Array.isArray(history) ? history : [];
  const recent = messages.slice(-10);
  const older = messages.slice(0, -10);
  const summary = older
    .filter(message => message?.role === 'user' || message?.role === 'assistant')
    .map(message => `${message.role}: ${typeof message.content === 'string' ? message.content.slice(0, 200) : ''}`)
    .join('\n')
    .slice(0, 1000);
  return summary ? [{ role: 'user', content: `Conversation summary:\n${summary}` }, ...recent] : recent;
}

export function maybeCompact(memory, budget) {
  return budget > (CONFIG.AGENT_THINKING_BUDGET || 5000);
}

export function isAutoCompact() {
  return true;
}

import { CONFIG } from '../config.js';

export async function chat(messages, provider = 'openai', tools = [], options = {}) {
  const key = provider === 'openai'
    ? CONFIG.AI_API_KEY
    : provider === 'anthropic' ? CONFIG.ANTHROPIC_API_KEY : CONFIG.GEMINI_API_KEY;
  if (!key) throw new Error(`No API key for ${provider}`);
  if (provider === 'openai') return chatOpenAI(messages, key, tools, options);
  if (provider === 'anthropic') return chatAnthropic(messages, key, options);
  return chatGemini(messages, key, options);
}

function toToolDefs(tools) {
  return (tools || [])
    .filter(tool => tool && tool.name)
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: (tool.description || '').slice(0, 500),
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }));
}

function splitMessages(messages) {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  const conversation = messages.filter(message => message.role === 'user' || message.role === 'assistant');
  return { system, conversation };
}

async function chatOpenAI(messages, key, tools, options) {
  const url = CONFIG.AI_BASE_URL || 'https://api.openai.com/v1/chat/completions';
  const model = CONFIG.AI_MODEL && CONFIG.AI_MODEL !== 'AUTO' ? CONFIG.AI_MODEL : 'gpt-4o-mini';
  const body = { model, messages, max_tokens: 2048, temperature: 0.7 };
  const definitions = toToolDefs(tools);
  if (definitions.length) {
    body.tools = definitions;
    body.tool_choice = 'auto';
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  return {
    text: message.content || '',
    toolCalls: (message.tool_calls || []).map(call => ({ id: call.id, function: call.function })),
  };
}

async function chatAnthropic(messages, key, options) {
  const url = CONFIG.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages';
  const model = CONFIG.ANTHROPIC_MODEL && CONFIG.ANTHROPIC_MODEL !== 'AUTO' ? CONFIG.ANTHROPIC_MODEL : 'claude-3-haiku-20240307';
  const { system, conversation } = splitMessages(messages);
  const body = { model, messages: conversation, max_tokens: 2048, temperature: 0.7 };
  if (system) body.system = system;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { text: data.content?.filter(item => item.type === 'text').map(item => item.text || '').join('') || '', toolCalls: [] };
}

async function chatGemini(messages, key, options) {
  const base = (CONFIG.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const model = CONFIG.GEMINI_MODEL && CONFIG.GEMINI_MODEL !== 'AUTO' ? CONFIG.GEMINI_MODEL : 'gemini-1.5-flash';
  const { system, conversation } = splitMessages(messages);
  const contents = conversation.map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetch(`${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { text: data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '', toolCalls: [] };
}

export function buildOpenAIReq(messages) {
  return { model: CONFIG.AI_MODEL, messages, max_tokens: 4096, temperature: 0.7 };
}

export function buildAnthropicReq(messages) {
  const { system, conversation } = splitMessages(messages);
  return { model: CONFIG.ANTHROPIC_MODEL, system, messages: conversation, max_tokens: 4096, temperature: 0.7 };
}

export function buildGeminiReq(messages) {
  const { system, conversation } = splitMessages(messages);
  const contents = conversation.map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));
  return { model: CONFIG.GEMINI_MODEL, systemInstruction: { parts: [{ text: system }] }, contents };
}

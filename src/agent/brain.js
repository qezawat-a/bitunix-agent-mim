import { CONFIG } from '../config.js';

export async function chat(messages, provider = 'openai', tools = []) {
  const key = provider === 'openai'
    ? CONFIG.AI_API_KEY
    : (provider === 'anthropic' ? CONFIG.ANTHROPIC_API_KEY : CONFIG.GEMINI_API_KEY);
  if (!key) throw new Error(`No API key for ${provider}`);

  if (provider === 'openai') return chatOpenAI(messages, key, tools);
  if (provider === 'anthropic') return chatAnthropic(messages, key);
  return chatGemini(messages, key);
}

function toToolDefs(tools) {
  return (tools || [])
    .filter((t) => t && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: (t.description || '').slice(0, 500),
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
}

async function chatOpenAI(messages, key, tools) {
  const url = CONFIG.AI_BASE_URL || 'https://api.openai.com/v1/chat/completions';
  const model = CONFIG.AI_MODEL && CONFIG.AI_MODEL !== 'AUTO' ? CONFIG.AI_MODEL : 'gpt-4o-mini';
  const body = { model, messages, max_tokens: 2048, temperature: 0.7 };
  const defs = toToolDefs(tools);
  if (defs.length) { body.tools = defs; body.tool_choice = 'auto'; }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  return {
    text: msg.content || '',
    toolCalls: (msg.tool_calls || []).map((tc) => ({ id: tc.id, function: tc.function })),
  };
}

async function chatAnthropic(messages, key) {
  const url = CONFIG.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages';
  const model = CONFIG.ANTHROPIC_MODEL && CONFIG.ANTHROPIC_MODEL !== 'AUTO' ? CONFIG.ANTHROPIC_MODEL : 'claude-3-haiku-20240307';
  const clean = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, messages: clean, max_tokens: 2048, temperature: 0.7 }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { text: data.content?.[0]?.text || '', toolCalls: [] };
}

async function chatGemini(messages, key) {
  const base = (CONFIG.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const model = CONFIG.GEMINI_MODEL && CONFIG.GEMINI_MODEL !== 'AUTO' ? CONFIG.GEMINI_MODEL : 'gemini-1.5-flash';
  const prompt = messages.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n');
  const res = await fetch(`${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { text: data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '', toolCalls: [] };
}

export function buildOpenAIReq(messages) {
  return { model: CONFIG.AI_MODEL, messages, max_tokens: 4096, temperature: 0.7 };
}

export function buildAnthropicReq(messages) {
  return { model: CONFIG.ANTHROPIC_MODEL, messages, max_tokens: 4096, temperature: 0.7 };
}

export function buildGeminiReq(messages) {
  const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  return { model: CONFIG.GEMINI_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }] };
}

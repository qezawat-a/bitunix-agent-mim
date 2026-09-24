import { CONFIG } from '../config.js';

export async function chat(messages, provider = 'openai') {
  const openai = provider === 'openai';
  const url = openai
    ? CONFIG.AI_BASE_URL || 'https://api.openai.com/v1/chat/completions'
    : (provider === 'anthropic'
        ? CONFIG.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages'
        : CONFIG.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent');
  const key = openai
    ? CONFIG.AI_API_KEY
    : (provider === 'anthropic' ? CONFIG.ANTHROPIC_API_KEY : CONFIG.GEMINI_API_KEY);
  const model = openai ? CONFIG.AI_MODEL : (provider === 'anthropic' ? CONFIG.ANTHROPIC_MODEL : CONFIG.GEMINI_MODEL);

  if (!key) throw new Error(`No API key for ${provider}`);

  const headers = { 'Content-Type': 'application/json' };
  if (openai) headers['Authorization'] = `Bearer ${key}`;
  else headers['x-api-key'] = key;

  const isClaude = provider === 'anthropic';
  const body = isClaude
    ? { model, messages, max_tokens: 4096, temperature: 0.7 }
    : { model, messages, max_tokens: 4096, temperature: 0.7 };

  if (provider === 'google') {
    const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    body.contents = [{ role: 'user', parts: [{ text: prompt }] }];
    delete body.messages;
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${provider} error: ${res.status} ${err}`);
  }
  const data = await res.json();
  const reply = isClaude
    ? data.content[0]?.text
    : (data.choices?.[0]?.message?.content || '');
  return reply;
}

export function buildOpenAIReq(messages) {
  return { model: CONFIG.AI_MODEL, messages, max_tokens: 4096, temperature: 0.7 };
}

export function buildAnthropicReq(messages) {
  return { model: CONFIG.ANTHROPIC_MODEL, messages, max_tokens: 4096, temperature: 0.7 };
}

export function buildGeminiReq(messages) {
  const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  return { model: CONFIG.GEMINI_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }] };
}
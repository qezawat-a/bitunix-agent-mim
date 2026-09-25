import { CONFIG } from '../config.js';

export async function chat(messages, provider = 'openai', tools = [], options = {}) {
  const key = provider === 'openai'
    ? CONFIG.AI_API_KEY
    : provider === 'anthropic' ? CONFIG.ANTHROPIC_API_KEY : CONFIG.GEMINI_API_KEY;
  if (!key) throw new Error(`No API key for ${provider}`);
  if (provider === 'openai') return chatOpenAI(messages, key, tools, options);
  if (provider === 'anthropic') return chatAnthropic(messages, key, tools, options);
  return chatGemini(messages, key, tools, options);
}

function toolDefinitions(tools) {
  return (tools || []).filter(tool => tool && tool.name);
}

function toOpenAIToolDefs(tools) {
  return toolDefinitions(tools).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: (tool.description || '').slice(0, 500),
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  }));
}

function toAnthropicToolDefs(tools) {
  return toolDefinitions(tools).map(tool => ({
    name: tool.name,
    description: (tool.description || '').slice(0, 500),
    input_schema: tool.parameters || { type: 'object', properties: {} },
  }));
}

function toGeminiToolDefs(tools) {
  return [{
    functionDeclarations: toolDefinitions(tools).map(tool => ({
      name: tool.name,
      description: (tool.description || '').slice(0, 500),
      parameters: tool.parameters || { type: 'object', properties: {} },
    })),
  }];
}

function splitSystem(messages) {
  return {
    system: messages.filter(message => message.role === 'system').map(message => String(message.content || '')).join('\n'),
    history: messages.filter(message => message.role !== 'system'),
  };
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function anthropicMessages(messages) {
  const output = [];
  let toolResults = [];
  const flush = () => {
    if (!toolResults.length) return;
    output.push({ role: 'user', content: toolResults });
    toolResults = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      toolResults.push({ type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content || '') });
      continue;
    }
    flush();
    if (message.role === 'user') {
      output.push({ role: 'user', content: String(message.content || '') });
    } else if (message.role === 'assistant') {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: String(message.content) });
      for (const call of message.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: parseArguments(call.function?.arguments) });
      }
      if (blocks.length) output.push({ role: 'assistant', content: blocks });
    }
  }
  flush();
  return output;
}

function geminiMessages(messages) {
  const output = [];
  const toolNames = new Map();
  let functionResponses = [];
  const flush = () => {
    if (!functionResponses.length) return;
    output.push({ role: 'user', parts: functionResponses });
    functionResponses = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      const name = message.name || toolNames.get(message.tool_call_id) || 'tool';
      functionResponses.push({ functionResponse: { name, response: { result: String(message.content || '') } } });
      continue;
    }
    flush();
    if (message.role === 'user') {
      output.push({ role: 'user', parts: [{ text: String(message.content || '') }] });
    } else if (message.role === 'assistant') {
      const parts = [];
      if (message.content) parts.push({ text: String(message.content) });
      for (const call of message.tool_calls || []) {
        const name = call.function?.name;
        if (name) toolNames.set(call.id, name);
        parts.push({ functionCall: { name, args: parseArguments(call.function?.arguments) } });
      }
      if (parts.length) output.push({ role: 'model', parts });
    }
  }
  flush();
  return output;
}

async function chatOpenAI(messages, key, tools, options) {
  const url = CONFIG.AI_BASE_URL || 'https://api.openai.com/v1/chat/completions';
  const model = CONFIG.AI_MODEL && CONFIG.AI_MODEL !== 'AUTO' ? CONFIG.AI_MODEL : 'gpt-4o-mini';
  const body = { model, messages, max_tokens: 2048, temperature: 0.7 };
  const definitions = toOpenAIToolDefs(tools);
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

async function chatAnthropic(messages, key, tools, options) {
  const url = CONFIG.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages';
  const model = CONFIG.ANTHROPIC_MODEL && CONFIG.ANTHROPIC_MODEL !== 'AUTO' ? CONFIG.ANTHROPIC_MODEL : 'claude-3-haiku-20240307';
  const { system, history } = splitSystem(messages);
  const body = { model, messages: anthropicMessages(history), max_tokens: 2048, temperature: 0.7 };
  if (system) body.system = system;
  if (tools?.length) body.tools = toAnthropicToolDefs(tools);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = Array.isArray(data.content) ? data.content : [];
  return {
    text: content.filter(item => item.type === 'text').map(item => item.text || '').join(''),
    toolCalls: content.filter(item => item.type === 'tool_use').map(item => ({ id: item.id, function: { name: item.name, arguments: JSON.stringify(item.input || {}) } })),
  };
}

async function chatGemini(messages, key, tools, options) {
  const base = (CONFIG.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const model = CONFIG.GEMINI_MODEL && CONFIG.GEMINI_MODEL !== 'AUTO' ? CONFIG.GEMINI_MODEL : 'gemini-1.5-flash';
  const { system, history } = splitSystem(messages);
  const body = { contents: geminiMessages(history) };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) body.tools = toGeminiToolDefs(tools);
  const res = await fetch(`${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return {
    text: parts.filter(part => typeof part.text === 'string').map(part => part.text).join(''),
    toolCalls: parts.filter(part => part.functionCall).map((part, index) => ({ id: part.functionCall.id || `gemini-${index}`, function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } })),
  };
}

export function buildOpenAIReq(messages) {
  return { model: CONFIG.AI_MODEL, messages, max_tokens: 4096, temperature: 0.7 };
}

export function buildAnthropicReq(messages) {
  const { system, history } = splitSystem(messages);
  return { model: CONFIG.ANTHROPIC_MODEL, system, messages: anthropicMessages(history), max_tokens: 4096, temperature: 0.7 };
}

export function buildGeminiReq(messages) {
  const { system, history } = splitSystem(messages);
  return { model: CONFIG.GEMINI_MODEL, systemInstruction: { parts: [{ text: system }] }, contents: geminiMessages(history) };
}

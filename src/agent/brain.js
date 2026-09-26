// brain.js — talking to the LLM (all providers) + tool calling.
// ---------------------------------------------------------------------------
// Ported from the CRAG agent (qezawat-a/CRAG) src/agent/brain.js.
//
// This file is only the "phone": it sends messages/tools to the provider and
// normalizes what comes back. The agent loop lives in loop.js.
//
// Internal message format is OpenAI-shaped:
//   { role: 'system'|'user'|'assistant'|'tool', content, tool_calls?, tool_call_id? }
//
// MODEL SELECTION (the CRAG "auto" policy, kept intact):
//   1. detectProviders() lists every provider that has a key.
//   2. An explicitly configured model is used as-is (no probing).
//   3. With AI_MODEL=AUTO the catalog is read from <base>/models, ranked
//      (free → cheap → rest, best family first) and each candidate is probed:
//        Tier 1: does the model emit a real tool call?  (best for an agent)
//        Tier 2: does the model answer plain text at all?
//   4. If NO candidate answers the probe we still use the best-ranked
//      candidate — a probe failure is not proof the model is unusable.
//   5. During the real request, a per-model failure (402/403 access denied,
//      404 unknown model, quota) automatically advances to the next candidate.
//   6. The winner is persisted to data/model-cache.json so restarts are cheap.
//
// There are NO hardcoded fallback model names anywhere in this file.
import {
  detectProviders,
  geminiOpenAiBaseUrl,
  stripVersion,
  primaryProvider,
  providerBaseUrl,
} from './config.js';
import {
  listProviderModels,
  rankModels,
  isBalanceError,
  isAuthError,
  shouldAdvanceModel,
  loadModelCache,
  saveModelCache,
  clearModelCache,
  resetModelCatalogCache,
  getLastCatalogError,
} from './auto-model.js';
import { openaiReasoning, anthropicThinking } from './thinking.js';

const MAX_TOKENS = 2048;        // required by Anthropic
const TIMEOUT_MS = 60000;      // per request
const PROBE_TIMEOUT_MS = 12000; // per probe — keeps startup fast
const PROBE_MAX_MODELS = 10;    // at most this many candidates are probed

// item 15 — auto refresh of the model catalog
//   AI_AUTO_REFRESH=1|0   AI_MODEL_TTL=<ms>
function autoRefreshEnabled() {
  const v = String(process.env.AI_AUTO_REFRESH || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function modelTtlMs() {
  const n = parseInt(process.env.AI_MODEL_TTL || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 600000;
}

// A malformed JSON argument from the model must not crash the agent.
function safeParse(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

function describeProviderError(error, provider, model) {
  const message = String(error?.message || error || 'unknown error');
  const cause = error?.cause;
  const causeCode = cause?.code ? ` [${cause.code}]` : '';
  const lower = message.toLowerCase();
  let hint = 'provider, model, base URL و API key را بررسی کن.';
  if (lower.includes('fetch failed') || lower.includes('timeout') || lower.includes('timed out') || causeCode) {
    hint = 'اتصال شبکه، DNS، فایروال و base URL را بررسی کن؛ این پیام به‌تنهایی ثابت نمی‌کند API key اشتباه است.';
  } else if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
    hint = 'API key یا دسترسی این provider را بررسی کن.';
  } else if (lower.includes('429') || lower.includes('rate limit')) {
    hint = 'rate limit یا سهمیه provider پر شده است؛ کمی بعد دوباره امتحان کن.';
  } else if (lower.includes('404') || (lower.includes('model') && (lower.includes('not found') || lower.includes('invalid')))) {
    hint = 'نام model و base URL با مستندات provider مطابقت ندارد.';
  }
  return `${provider}/${model}: ${message}${causeCode} — ${hint}`;
}

// ---------------------------------------------------------------------------
// 1) OpenAI-compatible (OpenAI / DeepSeek / Groq / Ollama / aggregators / ...)
// ---------------------------------------------------------------------------
export function resolveOpenAiUrl(base = providerBaseUrl('openai')) {
  const configured = String(base || '').trim().replace(/\/+$/, '');
  if (!configured) return 'https://api.openai.com/v1/chat/completions';
  if (/\/chat\/completions$/i.test(configured)) return configured;
  if (/\/v\d+$/i.test(configured)) return `${configured}/chat/completions`;
  return `${configured}/v1/chat/completions`;
}

export function resolveOpenAiModelsUrl(base = providerBaseUrl('openai')) {
  let endpoint = resolveOpenAiUrl(base).replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(endpoint)) endpoint = endpoint.replace(/\/chat\/completions$/i, '');
  return `${endpoint}/models`;
}

export function resolveAnthropicUrl(base = providerBaseUrl('anthropic')) {
  const configured = String(base || '').trim().replace(/\/+$/, '');
  if (!configured) return 'https://api.anthropic.com/v1/messages';
  if (/\/messages$/i.test(configured)) return configured;
  if (/\/v\d+$/i.test(configured)) return `${configured}/messages`;
  return `${configured}/v1/messages`;
}

export function resolveGeminiBase(base = providerBaseUrl('google')) {
  const configured = String(base || '').trim().replace(/\/+$/, '');
  if (!configured) return 'https://generativelanguage.googleapis.com/v1beta';
  return /\/v\d+(?:beta\d+)?$/i.test(configured) ? configured : `${configured}/v1beta`;
}

export function resolveGeminiModelsUrl(base = providerBaseUrl('google')) {
  return `${resolveGeminiBase(base)}/models`;
}

function buildOpenAIReq(provider, { system, messages, tools, thinking }) {
  const body = { model: provider.model, messages: [] };
  if (system) body.messages.push({ role: 'system', content: system });
  body.messages.push(...messages);
  if (tools && tools.length) {
    body.tools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: (tool.description || '').slice(0, 500),
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }));
  }
  // thinking is only sent to models we know support it (never blindly)
  if (thinking) {
    const reasoning = openaiReasoning(thinking.level, provider.model);
    if (reasoning) Object.assign(body, reasoning);
  }
  return {
    url: `${provider.baseUrl}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body,
  };
}

function parseOpenAIResp(data) {
  const message = data?.choices?.[0]?.message;
  if (!message) return { content: null, toolCalls: [], finishReason: data?.choices?.[0]?.finish_reason || null };
  const toolCalls = (message.tool_calls || [])
    .filter(call => call.type === 'function' || call.function)
    .map(call => ({ id: call.id, function: { name: call.function?.name, arguments: call.function?.arguments ?? '{}' } }));
  const legacy = message.function_call;
  if (!toolCalls.length && legacy) {
    toolCalls.push({ id: legacy.id || 'legacy-call', function: { name: legacy.name, arguments: legacy.arguments ?? '{}' } });
  }
  return { content: message.content ?? null, toolCalls, finishReason: data?.choices?.[0]?.finish_reason || null };
}

// ---------------------------------------------------------------------------
// 2) Anthropic (Claude) — different message format
// ---------------------------------------------------------------------------
function toAnthropicMessages(messages) {
  const out = [];
  let pending = [];

  const flush = () => {
    if (!pending.length) return;
    const blocks = pending.map(result => ({
      type: 'tool_result',
      tool_use_id: result.tool_call_id,
      content: String(result.content ?? ''),
    }));
    const last = out[out.length - 1];
    if (last && last.role === 'user') last.content.push(...blocks);
    else out.push({ role: 'user', content: blocks });
    pending = [];
  };

  for (const msg of messages) {
    if (msg.role === 'tool') { pending.push(msg); continue; }
    flush();

    if (msg.role === 'assistant') {
      const content = [];
      if (msg.content) content.push({ type: 'text', text: String(msg.content) });
      for (const call of msg.tool_calls || []) {
        content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: safeParse(call.function?.arguments) });
      }
      if (!content.length) continue;
      const last = out[out.length - 1];
      if (last && last.role === 'assistant') last.content.push(...content);
      else out.push({ role: 'assistant', content });
    }

    if (msg.role === 'user') {
      const last = out[out.length - 1];
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (last && last.role === 'user') last.content.push({ type: 'text', text });
      else out.push({ role: 'user', content: [{ type: 'text', text }] });
    }
  }
  flush();
  return out;
}

function buildAnthropicReq(provider, { system, messages, tools, thinking }) {
  const body = { model: provider.model, max_tokens: MAX_TOKENS };
  if (thinking) {
    const extended = anthropicThinking(thinking.level, provider.model);
    if (extended) {
      body.thinking = extended.thinking;
      body.max_tokens = extended.budget + 4096; // max_tokens must exceed the budget
    }
  }
  if (system) body.system = system;
  const msgs = toAnthropicMessages(messages);
  if (!msgs.length) msgs.push({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
  body.messages = msgs;
  if (tools && tools.length) {
    body.tools = tools.map(tool => ({
      name: tool.name,
      description: (tool.description || '').slice(0, 500),
      input_schema: tool.parameters || { type: 'object', properties: {} },
    }));
  }
  const base = stripVersion(provider.baseUrl);
  return {
    url: `${base}/v1/messages`,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body,
  };
}

function parseAnthropicResp(data) {
  const content = data?.content || [];
  const text = content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
  const toolCalls = content
    .filter(block => block?.type === 'tool_use')
    .map(block => ({ id: block.id, function: { name: block.name, arguments: JSON.stringify(block.input || {}) } }));
  return { content: text || null, toolCalls, finishReason: data?.stop_reason || null };
}

function buildGeminiReq(provider, { system, messages, tools }) {
  const base = geminiOpenAiBaseUrl(provider.baseUrl);
  return buildOpenAIReq({ ...provider, baseUrl: base }, { system, messages, tools });
}

// ---------------------------------------------------------------------------
// 3) AUTO MODEL
// ---------------------------------------------------------------------------
const probeTool = {
  name: 'get_status',
  description: 'Return the current status.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

const modelState = new Map(); // "name|baseUrl" => { source, candidates, index, chosen, at }
const lastProbeFailure = new Map();
const lastCatalogErrors = getLastCatalogError;

// Forget everything held in memory (catalog + resolved model + probe log).
// The on-disk winner in data/model-cache.json is kept, which is what happens on a
// restart: the agent comes back on the last known-good model even if the gateway
// is briefly unreachable.
export function resetModelState() {
  modelState.clear();
  lastProbeFailure.clear();
  resetModelCatalogCache();
}

// Full reset, including the persisted winner. Used by `/setmodels` so the next
// message performs a completely fresh discovery.
export function resetOpenAiModelCache() {
  resetModelState();
  clearModelCache();
}

export function getModelState() {
  return [...modelState.entries()].map(([key, state]) => ({ key, ...state }));
}

export function getLastProbeFailure() {
  return [...lastProbeFailure.values()].slice(-5);
}

async function postJson(url, headers, body, timeoutMs, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Resolve (and cache) the model for one provider descriptor.
async function ensureModelState(p, signal) {
  const key = `${p.name}|${p.baseUrl}`;
  const refresh = autoRefreshEnabled();
  const ttl = modelTtlMs();

  const cached = modelState.get(key);
  if (cached) {
    if (!refresh || Date.now() - cached.at < ttl) {
      p.model = cached.chosen;
      return cached;
    }
    modelState.delete(key); // TTL expired — list + probe again
  }

  if (!p.model) {
    // Persisted winner from a previous run: no probing needed.
    const persisted = loadModelCache(key);
    if (persisted && (!refresh || Date.now() - (persisted.at || 0) < ttl)) {
      const state = {
        source: 'cache',
        candidates: persisted.candidates || [persisted.chosen],
        index: persisted.index || 0,
        chosen: persisted.chosen,
      };
      state.at = Date.now();
      modelState.set(key, state);
      p.model = state.chosen;
      console.log(`[auto-model] ${p.name}: model from cache = '${state.chosen}'`);
      return state;
    }
  }

  let state;
  if (p.model) {
    // User pinned the model in .env — trusted, never probed.
    state = { source: 'explicit', candidates: [p.model], index: 0, chosen: p.model };
  } else {
    // A local gateway may briefly refuse or answer empty while it starts, so the
    // catalog is read twice before giving up. Failures are never cached, so this
    // recovers by itself on the next message.
    let ids = await listProviderModels(p, { ttlMs: refresh ? ttl : 0, signal });
    if (!ids.length) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      ids = await listProviderModels(p, { ttlMs: 0, signal });
    }
    const ranked = ids.length ? rankModels(ids) : [];
    if (!ranked.length) {
      throw new Error(
        `${p.name}: no models came back from GET ${p.baseUrl}/models` +
        `${catalogErrorHint()}. Check that the LLM gateway is running and that the key is accepted, or set the model explicitly.`,
      );
    }
    const probed = await probeModels(p, ranked, signal);
    // No probe passed → still try the best-ranked candidate. A failed probe is
    // not proof that the model is unusable, and the request path below advances
    // to the next candidate if this one is rejected.
    const chosen = probed.chosen || firstUsable(ranked, probed.denied);
    state = {
      source: 'auto',
      candidates: ranked,
      // The probe already told us which models this key may not use, so the
      // request path skips them instead of discovering them one 401 at a time.
      denied: [...probed.denied],
      index: ranked.indexOf(chosen) >= 0 ? ranked.indexOf(chosen) : 0,
      chosen,
    };
    console.log(
      `[auto-model] ${p.name}: chosen '${chosen}' (from ${ranked.length} candidates, ` +
      `${ids.length ? 'catalog OK' : 'catalog empty'}` +
      `${probed.chosen ? '' : ', no probe passed — trying best-ranked'}` +
      `${probed.denied.size ? `, ${probed.denied.size} denied by this key` : ''})`,
    );
    if (chosen) saveModelCache(key, { chosen, candidates: ranked, index: state.index });
  }

  state.at = Date.now();
  modelState.set(key, state);
  p.model = state.chosen;
  return state;
}

// Two-tier probe:
//   Tier 1 — native tool call (best for an agent that needs tools)
//   Tier 2 — plain text answer (usable, just weaker)
//
// Returns { chosen, denied }. `denied` holds the models this key is not allowed
// to use, so the real request can skip them without paying for a 401 each.
async function probeModels(p, candidates, signal) {
  const cap = candidates.slice(0, PROBE_MAX_MODELS);
  const denied = new Set();
  const reachable = [];
  const messages = [{ role: 'user', content: 'What is the bot status? Use the get_status function to check.' }];
  const plain = [{ role: 'user', content: 'ping' }];

  for (const mid of cap) {
    try {
      const provider = { ...p, model: mid };
      const req = p.name === 'anthropic'
        ? buildAnthropicReq(provider, { system: '', messages, tools: [probeTool] })
        : buildOpenAIReq(provider, { system: '', messages, tools: [probeTool] });
      const res = await postJson(req.url, req.headers, req.body, PROBE_TIMEOUT_MS, signal);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const bodyText = JSON.stringify(data);
        if (isBalanceError(res.status, bodyText) || shouldAdvanceModel(res.status, bodyText)) denied.add(mid);
        lastProbeFailure.set(mid, `HTTP ${res.status} ${bodyText.slice(0, 160)}`);
        console.log(`[auto-model] probe ${mid}: HTTP ${res.status} — rejected`);
        continue;
      }
      const parsed = p.name === 'anthropic' ? parseAnthropicResp(data) : parseOpenAIResp(data);
      if (parsed.toolCalls.length) return { chosen: mid, denied }; // native tool calling — best choice
      // Reachable, but it did not use the tool.
      reachable.push(mid);
    } catch (e) {
      lastProbeFailure.set(mid, String(e.message || e).slice(0, 160));
      console.log(`[auto-model] probe ${mid}: ${String(e.message || e).slice(0, 80)}`);
    }
  }

  // Tier 2 only helps for models that actually answered without a tool call.
  // When every probe was rejected outright, re-asking the same models would just
  // repeat the same errors, so it is skipped.
  for (const mid of reachable) {
    try {
      const provider = { ...p, model: mid };
      const req = p.name === 'anthropic'
        ? buildAnthropicReq(provider, { system: '', messages: plain, tools: [] })
        : buildOpenAIReq(provider, { system: '', messages: plain, tools: [] });
      const res = await postJson(req.url, req.headers, req.body, PROBE_TIMEOUT_MS, signal);
      if (!res.ok) {
        denied.add(mid);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      const parsed = p.name === 'anthropic' ? parseAnthropicResp(data) : parseOpenAIResp(data);
      if (parsed.content && String(parsed.content).trim()) {
        console.log(`[auto-model] probe ${mid}: answers text (Tier 2 — accepted)`);
        return { chosen: mid, denied };
      }
    } catch { /* try the next candidate */ }
  }

  return { chosen: '', denied };
}

// The best-ranked candidate this key is allowed to try.
function firstUsable(candidates, denied) {
  return candidates.find(mid => !denied.has(mid)) || candidates[0];
}

// " (last read: HTTP 503 from http://127.0.0.1:20128/v1/models)" — the actual
// reason the catalog came back empty, so /diag is not a dead end.
function catalogErrorHint() {
  const errors = Object.values(lastCatalogErrors());
  return errors.length ? ` (last read: ${errors[errors.length - 1]})` : '';
}

// The next candidate after `from` that this key is allowed to try.
function nextCandidate(candidates, denied, from) {
  for (let i = from + 1; i < candidates.length; i++) {
    if (!denied.has(candidates[i])) return candidates[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4) The main request path: try providers, and inside a provider walk the
//    ranked candidates when a model is rejected (access denied, 404, quota).
// ---------------------------------------------------------------------------
function buildRequest(p, ctx) {
  if (p.name === 'anthropic') return buildAnthropicReq(p, ctx);
  if (p.name === 'google') return buildGeminiReq(p, ctx);
  return buildOpenAIReq(p, ctx);
}

function parseResp(p, data) {
  if (p.name === 'anthropic') return parseAnthropicResp(data);
  return parseOpenAIResp(data); // openai + google (both OpenAI-compatible)
}

async function chatWithProviders({ system = '', messages = [], tools = [], thinkingLevel = null, signal, only = null }) {
  const candidates = detectProviders().filter(p => !only || p.name === only);
  if (candidates.length === 0) {
    if (only) throw new Error(`no API key configured for provider '${only}'`);
    throw new Error('No LLM provider is configured. Add a key to .env and send /diag.');
  }

  const errors = [];
  const ctx = { system, messages, tools, thinking: thinkingLevel ? { level: thinkingLevel } : null };

  for (const p of candidates) {
    const st = await ensureModelState(p, signal);
    p.model = st.chosen;

    let attempts = 0;
    const maxAttempts = st.source === 'auto' ? st.candidates.length + 1 : 1;
    const denied = new Set(st.denied || []);
    while (attempts < maxAttempts) {
      attempts++;
      try {
        const req = buildRequest(p, ctx);
        const res = await postJson(req.url, req.headers, req.body, TIMEOUT_MS, signal);
        const data = await res.json().catch(() => ({}));
        const bodyText = JSON.stringify(data);

        if (!res.ok) {
          // Broken key: fail fast, walking every model cannot help.
          if (isAuthError(res.status, bodyText)) {
            errors.push(`${p.name}: ${res.status} — ${bodyText.slice(0, 300)} (key rejected by provider)`);
            break;
          }
          // This model is unusable for this key → try the next candidate.
          if ((isBalanceError(res.status, bodyText) || shouldAdvanceModel(res.status, bodyText))
              && st.source === 'auto') {
            const prev = st.chosen;
            if (isBalanceError(res.status, bodyText)) denied.add(prev);
            const next = nextCandidate(st.candidates, denied, st.index);
            if (next) {
              st.index = st.candidates.indexOf(next);
              st.chosen = next;
              p.model = next;
              errors.push(`${p.name}: model '${prev}' rejected (HTTP ${res.status}) — moving to '${next}'`);
              continue;
            }
          }
          errors.push(`${p.name}/${p.model}: HTTP ${res.status} — ${bodyText.slice(0, 300)}`);
          break;
        }

        const parsed = parseResp(p, data);
        return { ...parsed, provider: p.name, model: p.model, state: st.source };
      } catch (e) {
        const msg = String(e.message || e);
        if ((isBalanceError(0, msg) || shouldAdvanceModel(0, msg)) && st.source === 'auto') {
          const prev = st.chosen;
          const next = nextCandidate(st.candidates, denied, st.index);
          if (next) {
            if (isBalanceError(0, msg)) denied.add(prev);
            st.index = st.candidates.indexOf(next);
            st.chosen = next;
            p.model = next;
            errors.push(`${p.name}: model '${prev}' unusable (${msg.slice(0, 120)}) — moving to '${next}'`);
            continue;
          }
        }
        errors.push(describeProviderError(e, p.name, p.model));
        break;
      }
    }
  }

  throw new Error(
    'AI request failed after trying every configured provider/model:\n  - ' +
    errors.join('\n  - ') +
    '\nThese are the real failures. Send /diag for the resolved provider and model, and /models for the catalog.',
  );
}

// ---------------------------------------------------------------------------
// Public entry point used by loop.js.
//   messages: OpenAI-shaped array (a 'system' entry is allowed and is split out)
// ---------------------------------------------------------------------------
export async function chat(messages, provider = null, tools = [], options = {}) {
  const system = messages
    .filter(message => message.role === 'system')
    .map(message => String(message.content || ''))
    .join('\n');
  const history = messages.filter(message => message.role !== 'system');

  const res = await chatWithProviders({
    system,
    messages: history,
    tools: tools || [],
    thinkingLevel: options.thinkingLevel || null,
    signal: options.signal,
    only: provider || null,
  });

  const text = typeof res.content === 'string' ? res.content : String(res.content ?? '');
  return {
    text,
    content: text,
    toolCalls: res.toolCalls || [],
    model: res.model,
    provider: res.provider,
    finishReason: res.finishReason || null,
    state: res.state,
  };
}

// ---------------------------------------------------------------------------
// Catalog helpers (used by /models, /setmodels, the agent_models tool and the
// TUI). These read the provider catalog directly — no probing.
// ---------------------------------------------------------------------------
export async function listOpenAiModels(signal) {
  const provider = detectProviders().find(p => p.name === 'openai');
  if (!provider) throw new Error('OpenAI API key is not configured');
  return listProviderModels(provider, { ttlMs: 0, signal });
}

export async function listAnthropicModels(signal) {
  const provider = detectProviders().find(p => p.name === 'anthropic');
  if (!provider) throw new Error('Anthropic API key is not configured');
  return listProviderModels(provider, { ttlMs: 0, signal });
}

export async function listGeminiModels(signal) {
  const provider = detectProviders().find(p => p.name === 'google');
  if (!provider) throw new Error('Gemini API key is not configured');
  const ids = await listProviderModels(provider, { ttlMs: 0, signal });
  return ids.map(id => String(id).replace(/^models\//, ''));
}

// Catalog + ranking for whichever provider is active (what /models shows).
export async function listModelsForActiveProvider(signal) {
  const provider = primaryProvider();
  const ids = await listProviderModels(provider, { ttlMs: 0, signal });
  return { provider: provider.name, models: ids, ranked: rankModels(ids) };
}

// Force the next request to re-discover + re-probe (used by /setmodels).
export function invalidateModelCache() {
  resetOpenAiModelCache();
}

export function describeModelConfig() {
  let configured = null;
  try { configured = primaryProvider(); } catch {}
  const state = modelState.get(configured ? `${configured.name}|${configured.baseUrl}` : '');
  return {
    provider: configured ? configured.name : null,
    baseUrl: configured ? configured.baseUrl : null,
    configuredModel: configured ? configured.model : null,
    resolvedModel: state ? state.chosen : null,
    source: state ? state.source : null,
    candidateCount: state && state.candidates ? state.candidates.length : 0,
    catalogError: getLastCatalogError()[configured ? `${configured.name}|${configured.baseUrl}` : ''] || null,
  };
}

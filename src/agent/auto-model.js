// auto-model.js — pick a model that the key can ACTUALLY use (CRAG port)
// ---------------------------------------------------------------------------
// Ported from the CRAG agent (qezawat-a/CRAG) src/agent/auto-model.js, with one
// deliberate change: no hardcoded model names anywhere. Discovery always comes
// from the provider's live `/models` catalog.
//
//   1) listProviderModels() : GET <base>/models (cached, refreshed on TTL)
//   2) rankModels()         : free (:free) → cheap (flash/mini/lite/...) → rest,
//                             ordered inside each bucket by PREFERRED_FAMILIES
//   3) isBalanceError()     : "this key/account cannot use THIS model" → try next
//   4) shouldAdvanceModel() : balance/access/404/model-not-found → try next
//   5) load/saveModelCache(): chosen model persisted in data/model-cache.json so
//                             a restart does not re-probe everything
import fs from 'node:fs';
import path from 'node:path';
import { stripVersion, geminiOpenAiBaseUrl } from './config.js';

// Families we prefer, best-first.
export const PREFERRED_FAMILIES = [
  'gpt-4o', 'gpt-4.1', 'gpt-4', 'o1', 'o3', 'claude',
  'llama-3.1', 'llama-3', 'llama-4', 'mistral', 'mixtral',
  'gemma', 'deepseek-chat', 'deepseek', 'qwen', 'gemini', 'yi-',
];

// Non-chat models (embedding/audio/image/moderation/...).
export const NON_CHAT_MARKERS = [
  'embed', 'whisper', 'tts', 'audio', 'dall', 'image',
  'moderation', 'rerank', 're-rank', 'realtime', 'omni',
  'ft:', 'fine-tune', 'guard', 'vl-',
];

// Cheaper/faster markers — tried before the expensive ones.
export const CHEAP_MARKERS = [
  'flash', 'mini', 'lite', 'nano', 'small', 'distil',
  '-8b', '-7b', '-4b', '-3b', '-2b', '-1b', '-0.5b',
];

// ---------------------------------------------------------------------------
// 0) persistent cache
// ---------------------------------------------------------------------------
// AI_MODEL_CACHE_FILE lets deployments (and tests) relocate the cache file.
function cacheFile() {
  const configured = String(process.env.AI_MODEL_CACHE_FILE || '').trim();
  return configured ? path.resolve(configured) : path.resolve('data', 'model-cache.json');
}

export function loadModelCache(key) {
  try {
    const all = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    const entry = all[key];
    if (entry && entry.chosen) return entry;
  } catch {}
  return null;
}

export function saveModelCache(key, entry) {
  try {
    const file = cacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    all[key] = { ...entry, at: Date.now() };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, file);
  } catch {}
}

export function clearModelCache() {
  try { fs.rmSync(cacheFile(), { force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// 1) listProviderModels(): GET /models, cached per "name|baseUrl".
// ttlMs = 0 means cache forever (per process); a positive ttl re-fetches.
// ---------------------------------------------------------------------------
const listCache = new Map();
const lastCatalogError = new Map(); // "name|baseUrl" -> why the last read failed

// Drop the in-process catalog cache. Called when the model is re-selected (e.g.
// `/setmodels AUTO`) so a fresh catalog is read instead of a stale one.
export function resetModelCatalogCache() {
  listCache.clear();
  lastCatalogError.clear();
}

// Why the most recent catalog read failed (for /diag). Empty object = all good.
export function getLastCatalogError() {
  return Object.fromEntries(lastCatalogError);
}

export async function listProviderModels(provider, { ttlMs = 0, signal } = {}) {
  const key = `${provider.name}|${provider.baseUrl}`;
  const prev = listCache.get(key);
  if (prev && !(ttlMs > 0 && Date.now() - prev.at > ttlMs)) return prev.ids;

  try {
    let modelsUrl;
    if (provider.name === 'anthropic') modelsUrl = `${stripVersion(provider.baseUrl)}/v1/models`;
    else if (provider.name === 'google') modelsUrl = `${geminiOpenAiBaseUrl(provider.baseUrl)}/models`;
    else modelsUrl = `${provider.baseUrl}/models`;

    const headers = { 'Content-Type': 'application/json' };
    if (provider.name === 'anthropic') {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${provider.apiKey}`;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let res;
    try {
      res = await fetch(modelsUrl, { headers, signal: signal || ctrl.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // A failed read is NOT cached. A local gateway that is still starting (or
      // briefly down) must not leave the agent stuck with an empty catalog until
      // the process restarts.
      lastCatalogError.set(key, `HTTP ${res.status} from ${modelsUrl}`);
      return prev ? prev.ids : [];
    }

    const data = await res.json().catch(() => ({}));
    const ids = (data?.data || []).map(model => model?.id).filter(Boolean);
    if (!ids.length) {
      lastCatalogError.set(key, `${modelsUrl} answered with no models`);
      return prev ? prev.ids : [];
    }
    lastCatalogError.delete(key);
    listCache.set(key, { ids, at: Date.now() });
    return ids;
  } catch (error) {
    lastCatalogError.set(key, `${key}: ${String(error?.message || error).slice(0, 160)}`);
    return prev ? prev.ids : [];
  }
}

// ---------------------------------------------------------------------------
// 2) rankModels(): chat-only models, free → cheap → rest.
// ---------------------------------------------------------------------------
function byFamily(models) {
  const familyIndex = id => {
    const low = id.toLowerCase();
    for (let i = 0; i < PREFERRED_FAMILIES.length; i++) {
      if (low.includes(PREFERRED_FAMILIES[i])) return i;
    }
    return PREFERRED_FAMILIES.length;
  };
  return [...models].sort((a, b) => familyIndex(a) - familyIndex(b));
}

export function rankModels(ids) {
  const chatModels = (ids || []).filter(id => !NON_CHAT_MARKERS.some(marker => String(id).toLowerCase().includes(marker)));
  const pool = chatModels.length ? chatModels : (ids || []);

  const isFree = low => low.endsWith(':free');
  const isCheap = low => !isFree(low) && CHEAP_MARKERS.some(marker => low.includes(marker));
  const lower = pool.map(id => String(id).toLowerCase());

  const free = pool.filter((_, i) => isFree(lower[i]));
  const cheap = pool.filter((_, i) => isCheap(lower[i]));
  const rest = pool.filter((_, i) => !isFree(lower[i]) && !isCheap(lower[i]));

  return [...byFamily(free), ...byFamily(cheap), ...byFamily(rest)];
}

// ---------------------------------------------------------------------------
// 3) isBalanceError(): "this key/account may not use THIS model" → try the next
//    candidate. Covers gateways (OpenRouter, sea-lion, aggregators) where access
//    is granted per model rather than per key.
//
//    NOT included on purpose: 429 rate-limit (retry later, do not switch models)
//    and 401 invalid-key (the key itself is broken — switching is pointless).
// ---------------------------------------------------------------------------
export function isBalanceError(status, text) {
  const low = String(text || '').toLowerCase();
  return (
    status === 402 ||
    status === 403 ||
    low.includes('insufficient_quota') ||
    low.includes('insufficient_balance') ||
    low.includes('balance is positive') ||
    low.includes('not enough') ||
    low.includes('payment required') ||
    low.includes('exceeded your current quota') ||
    low.includes('add credits') ||
    low.includes('credits required') ||
    low.includes('usage_limit_exceeded') ||
    low.includes('key_model_access_denied') ||
    low.includes('model_access_denied') ||
    low.includes('access denied') ||
    low.includes('not allowed to access') ||
    low.includes('no access to') ||
    low.includes('permission') ||
    low.includes('forbidden')
  );
}

// Is the key itself broken (fail fast instead of walking every candidate)?
export function isAuthError(status, text) {
  const low = String(text || '').toLowerCase();
  if (low.includes('key_model_access_denied') || low.includes('model_access_denied')) return false;
  return (
    (status === 401 && !low.includes('model')) ||
    low.includes('invalid api key') ||
    low.includes('incorrect api key') ||
    low.includes('invalid_api_key') ||
    low.includes('unauthorized')
  );
}

// ---------------------------------------------------------------------------
// 4) shouldAdvanceModel(): the current model is unusable → move to the next one.
//    429 (rate limit) is explicitly NOT an advance reason.
// ---------------------------------------------------------------------------
export function shouldAdvanceModel(status, text) {
  if (isBalanceError(status, text)) return true;
  if (status === 404) return true;
  const low = String(text || '').toLowerCase();
  return (
    low.includes('model_not_found') ||
    low.includes('no such model') ||
    low.includes('not a valid model') ||
    low.includes('unknown model') ||
    low.includes('model does not exist') ||
    low.includes('invalid model') ||
    low.includes('no endpoints found') ||
    low.includes('is not available') ||
    low.includes('unsupported model') ||
    low.includes('model is not enabled')
  );
}

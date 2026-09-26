// auto-model.js — model discovery straight from the provider (CRAG port)
// ---------------------------------------------------------------------------
// Ported from the CRAG agent (qezawat-a/CRAG) src/agent/auto-model.js and then
// stripped down on purpose.
//
// There is NO model list in this file. Not a preferred-family list, not a
// free/cheap ranking, not a fallback list, not a cached list. The only source of
// models is the provider itself:
//
//     GET <base URL>/models      -> the models this key can see
//
// brain.js then probes those, in the order the provider returned them, and keeps
// the first one that actually answers with this key. Whatever the provider says
// the key can use is what the agent uses — nothing is invented here.
import { stripVersion, geminiOpenAiBaseUrl } from './config.js';

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
const listCache = new Map();
const lastCatalogError = new Map(); // "name|baseUrl" -> why the last read failed

// Drop the in-process catalog cache. Called when the model is re-selected (e.g.
// `/setmodels AUTO`) so the provider is asked again instead of a stale list
// being reused.
export function resetModelCatalogCache() {
  listCache.clear();
  lastCatalogError.clear();
}

// Why the most recent catalog read failed (shown by /diag).
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
      // A failed read is NOT remembered as an empty catalog: a gateway that is
      // briefly down must not leave the agent stuck until the process restarts.
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
// Which failures mean "this model is not usable with this key", so the next model
// from the provider's own list should be tried. These are error-message patterns,
// not model names.
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

// The key itself is broken, so trying other models cannot help.
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

// A per-model rejection: move on to the next model from the provider's list.
// 429 (rate limit) is deliberately not an advance reason.
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

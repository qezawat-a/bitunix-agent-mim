import { CONFIG } from '../config.js';
import { listAnthropicModels, listGeminiModels, listOpenAiModels } from './brain.js';

const cache = new Map();
let lastRefresh = 0;

export async function listProviderModels(provider) {
  if (cache.has(provider)) return cache.get(provider);
  const models = provider === 'openai'
    ? await listOpenAiModels()
    : provider === 'anthropic'
      ? await listAnthropicModels()
      : provider === 'google'
        ? await listGeminiModels()
        : [];
  cache.set(provider, models);
  lastRefresh = Date.now();
  return models;
}

export async function rankModels(provider, freePrefer = true) {
  const models = await listProviderModels(provider);
  if (!freePrefer) return [...models];
  const preferred = /flash|mini|lite|nano|small|distil|haiku|sonnet|free/i;
  return [...models].sort((a, b) => Number(preferred.test(b)) - Number(preferred.test(a)));
}

// Kept for callers that used the old experimental helper. There are deliberately
// no baked-in model names: AUTO must use the provider's live catalog.
export function fallbackCandidates() {
  return [];
}

export function isBalanceError(err) {
  const s = String(err?.message || err);
  return /402|quota|insufficient|balance|payment/i.test(s);
}

export function shouldAdvanceModel(err) {
  const s = String(err?.message || err);
  if (/429/.test(s)) return false;
  return /402|404|quota|not.?found|model/i.test(s);
}

export async function loadModelCache() {
  try {
    const fs = await import('fs/promises');
    const raw = await fs.readFile('data/model-cache.json', 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

export async function saveModelCache(data) {
  try {
    const fs = await import('fs/promises');
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile('data/model-cache.json', JSON.stringify(data, null, 2));
  } catch {}
}

export function needsRefresh() {
  if (!CONFIG.AI_AUTO_REFRESH) return false;
  return Date.now() - lastRefresh > (CONFIG.AI_MODEL_TTL || 600000);
}

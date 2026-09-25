import { CONFIG } from '../config.js';
import { listAnthropicModels, listGeminiModels, listOpenAiModels } from './brain.js';

export function detectProviders() {
  const provider = String(CONFIG.AI_PROVIDER || 'auto').trim().toLowerCase();
  if (['anthropic', 'google', 'openai'].includes(provider)) return provider;
  if (provider !== 'auto') throw new Error(`unsupported AI_PROVIDER: ${provider}`);
  if (CONFIG.AI_API_KEY) return 'openai';
  if (CONFIG.ANTHROPIC_API_KEY) return 'anthropic';
  if (CONFIG.GEMINI_API_KEY) return 'google';
  return 'openai';
}

export async function listProviderModels(provider) {
  if (provider === 'openai') return listOpenAiModels();
  if (provider === 'anthropic') return listAnthropicModels();
  if (provider === 'google') return listGeminiModels();
  throw new Error(`unsupported model provider: ${provider}`);
}

export async function rankModels(provider, freePrefer = true) {
  const models = await listProviderModels(provider);
  if (!freePrefer) return [...models];
  const preferred = /flash|mini|lite|nano|small|distil|haiku|sonnet|free/i;
  return [...models].sort((a, b) => Number(preferred.test(b)) - Number(preferred.test(a)));
}

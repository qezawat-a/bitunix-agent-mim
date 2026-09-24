import { CONFIG } from '../config.js';

export function detectProviders() {
  if (CONFIG.AI_PROVIDER === 'anthropic') return 'anthropic';
  if (CONFIG.AI_PROVIDER === 'google') return 'google';
  return 'openai';
}

export async function listProviderModels(provider) {
  // basic model list lookup
  const lists = {
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-3.5-turbo'],
    anthropic: ['claude-3-5-sonnet-20240620', 'claude-3-haiku-20240307'],
    google: ['gemini-1.5-pro', 'gemini-1.5-flash'],
  };
  return lists[provider] || [];
}

export async function rankModels(provider, freePrefer = true) {
  const models = await listProviderModels(provider);
  if (freePrefer) {
    const order = ['claude-3-5-sonnet', 'gpt-4o-mini', 'gemini-1.5-flash'];
    return order.filter(m => models.includes(m)) || models;
  }
  return models;
}
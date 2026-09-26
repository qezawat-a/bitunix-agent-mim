// config.js — the single place where LLM provider configuration is resolved.
// ---------------------------------------------------------------------------
// Ported from the CRAG agent (qezawat-a/CRAG) src/agent/config.js.
//
// Rule that is never broken here: NO HARDCODED MODEL NAMES. When a model is not
// set explicitly, `model` stays null and brain.js + auto-model.js discover it
// from the provider's live `/models` catalog and probe the candidates.
//
//   AI_PROVIDER=auto|openai|anthropic|google
//   AI_API_KEY / AI_BASE_URL / AI_MODEL            (OpenAI-compatible: OpenAI,
//                                                   DeepSeek, Groq, Ollama, ...)
//   ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL
//   GEMINI_API_KEY / GEMINI_BASE_URL / GEMINI_MODEL
import { CONFIG } from '../config.js';

// Order matters for `AI_PROVIDER=auto`.
const PRIORITY = ['openai', 'anthropic', 'google'];

const KEY_VAR = {
  openai: 'AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
};

const MODEL_VAR = {
  openai: 'AI_MODEL',
  anthropic: 'ANTHROPIC_MODEL',
  google: 'GEMINI_MODEL',
};

const BASE_VAR = {
  openai: 'AI_BASE_URL',
  anthropic: 'ANTHROPIC_BASE_URL',
  google: 'GEMINI_BASE_URL',
};

const BASE_DEFAULT = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1',
};

// ---------------------------------------------------------------------------
// detectProviders(): every provider whose key is present, as descriptors.
// Synchronous, no network. Returns [] when nothing is configured.
// ---------------------------------------------------------------------------
export function detectProviders() {
  const wanted = String(CONFIG.AI_PROVIDER || 'auto').trim().toLowerCase();
  if (wanted && wanted !== 'auto' && !PRIORITY.includes(wanted)) {
    throw new Error(`unsupported AI_PROVIDER: ${wanted} (use auto|openai|anthropic|google)`);
  }

  const list = [];
  for (const name of PRIORITY) {
    if (wanted !== 'auto' && wanted !== name) continue;
    const apiKey = String(CONFIG[KEY_VAR[name]] || '').trim();
    if (!apiKey) continue;

    const baseUrl = String(CONFIG[BASE_VAR[name]] || '').trim().replace(/\/+$/, '') || BASE_DEFAULT[name];
    const provider = { name, apiKey, baseUrl, model: null };

    // An explicitly configured model is trusted as-is (no probing).
    const configured = String(CONFIG[MODEL_VAR[name]] || '').trim();
    if (configured && configured.toUpperCase() !== 'AUTO') provider.model = configured;
    // Otherwise model stays null → auto-model.js discovers + probes it.

    list.push(provider);
  }
  return list;
}

// The provider that will be tried first (model may still be null).
export function primaryProvider() {
  const list = detectProviders();
  if (list.length === 0) {
    throw new Error(
      'No LLM provider is configured. Add a key to .env:\n' +
      '  - AI_API_KEY (OpenAI / DeepSeek / Groq / any OpenAI-compatible gateway)\n' +
      '  - ANTHROPIC_API_KEY (Claude)\n' +
      '  - GEMINI_API_KEY (Gemini)\n' +
      'then restart and send /diag.',
    );
  }
  return list[0];
}

// Convenience for call sites that only need the provider name.
export function primaryProviderName() {
  return primaryProvider().name;
}

export function providerKeyVar(name) {
  return KEY_VAR[name] || null;
}

export function providerModelVar(name) {
  return MODEL_VAR[name] || null;
}

export function providerBaseUrl(name) {
  const configured = String(CONFIG[BASE_VAR[name]] || '').trim().replace(/\/+$/, '');
  return configured || BASE_DEFAULT[name] || '';
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
export function stripVersion(baseUrl) {
  return String(baseUrl || '').replace(/\/v\d+(beta)?$/, '');
}

// Gemini also exposes an OpenAI-compatible route: .../v1beta/openai
export function geminiOpenAiBaseUrl(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (b.endsWith('/openai')) return b;
  return `${stripVersion(b)}/v1beta/openai`;
}

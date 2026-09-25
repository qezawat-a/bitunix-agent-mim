import { CONFIG } from '../config.js';
import { detectProviders } from './config.js';
import { listAnthropicModels, listGeminiModels, listOpenAiModels } from './brain.js';
import { listSkills } from './skills.js';
import { readSoul } from '../prompt.js';

let sharedMemory = null;

export function setBasicMemory(memory) {
  sharedMemory = memory;
}

export const basicTools = [
  {
    name: 'agent_help',
    description: 'Show list of available agent commands',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return {
        commands: ['/help', '/think [level]', '/models', '/setModels [model|AUTO]', '/ask <text>', '/harness <jsonl>', '/soul', '/skills', '/memory [key]', '/resume', '/start', '/stop', '/settings', '/dryrun', '/autotrade', '/scan', '/trades', '/balance', '/pnl', '/close', '/diag'],
        tools: ['trader_xxxx', 'bitunix_xxxx', 'agent_xxxx'],
      };
    },
  },
  {
    name: 'agent_say',
    description: 'Respond in agent style',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    async handler({ text }) {
      return { ok: true, text };
    },
  },
  {
    name: 'agent_settings',
    description: 'Get agent settings',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return {
        name: CONFIG.AGENT_NAME,
        autonomous: CONFIG.AGENT_AUTONOMOUS,
        thinking: CONFIG.AGENT_THINKING_ENABLED,
        maxStep: CONFIG.AGENT_MAX_STEP,
        thinkingBudget: CONFIG.AGENT_THINKING_BUDGET,
      };
    },
  },
  {
    name: 'agent_start',
    description: 'Start agent with new task',
    parameters: { type: 'object', properties: { task: { type: 'string' } } },
    async handler({ task }) {
      return { ok: true, task, started: new Date().toISOString() };
    },
  },
  {
    name: 'agent_stop',
    description: 'Stop agent execution',
    parameters: { type: 'object', properties: {} },
    async handler() {
      CONFIG.auto_trade = false;
      return { ok: true, stopped: new Date().toISOString(), auto_trade: false };
    },
  },
  {
    name: 'agent_soul',
    description: 'Load soul prompt',
    parameters: { type: 'object', properties: {} },
    async handler() {
      try {
        return { soul: await readSoul() };
      } catch { return { soul: 'SOUL.md not found' }; }
    },
  },
  {
    name: 'agent_skills',
    description: 'List skills',
    parameters: { type: 'object', properties: {} },
    async handler() {
      const skills = await listSkills();
      return { skills: skills.map(skill => ({ id: skill.id, description: skill.description, custom: skill.custom })) };
    },
  },
  {
    name: 'agent_memory',
    description: 'Get/set memory',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: ['string', 'object', 'boolean', 'number'] },
      },
    },
    async handler({ key, value }) {
      if (!sharedMemory) return { ok: false, message: 'memory is not ready' };
      if (value !== undefined) {
        await sharedMemory.remember(key, value);
        return { ok: true, key, value };
      }
      return { ok: true, key, value: await sharedMemory.recall(key) };
    },
  },
  {
    name: 'agent_models',
    description: 'List models discovered from the configured provider',
    parameters: { type: 'object', properties: {} },
    async handler() {
      const provider = detectProviders();
      try {
        const models = provider === 'openai'
          ? await listOpenAiModels()
          : provider === 'anthropic'
            ? await listAnthropicModels()
            : await listGeminiModels();
        return { provider, models, configured: provider === 'openai' ? CONFIG.AI_MODEL : provider === 'anthropic' ? CONFIG.ANTHROPIC_MODEL : CONFIG.GEMINI_MODEL };
      } catch (error) {
        return { provider, models: [], error: error.message };
      }
    },
  },
];

export default basicTools;
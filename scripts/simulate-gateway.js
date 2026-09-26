// Simulation of the reported production failure:
//   AI_MODEL=AUTO, a gateway that lists 38 models, and a key whose access is
//   denied per model (401 key_model_access_denied) for most of them.
// Before the port this produced: "No discovered model passed the availability probe".
import { CONFIG } from '../src/config.js';
import { createAgent } from '../src/agent/loop.js';
import { describeModelConfig } from '../src/agent/brain.js';

process.env.AI_MODEL_CACHE_FILE = '/tmp/opencode/sim-model-cache.json';

const CATALOG = [
  'ag/gemini-3.8-flash-high', 'ag/gemini-3.8-flash-medium', 'ag/gemini-3.8-flash-low',
  'ag/gemini-3.8-flash', 'ag/gemini-3.7-flash-high', 'ag/gemini-3.7-flash-medium',
  'ag/gemini-3.7-flash-low', 'ag/gemini-3.6-flash-high', 'ag/gemini-3.6-flash-medium',
  'ag/gemini-3.6-flash-low', 'ag/gemini-3.5-flash-high', 'ag/gemini-3-flash-agent',
  'ag/gemini-3.5-flash-low', 'ag/gemini-3.5-flash-extra-low', 'ag/gemini-pro-agent',
  'ag/gemini-3.1-pro-low', 'ag/claude-sonnet-4-6', 'ag/claude-opus-4-6-thinking',
  'ag/gpt-oss-120b-medium', 'ag/gemini-3-flash',
  'kc/anthropic/claude-sonnet-4-20250514', 'kc/anthropic/claude-opus-4-20250514',
  'kc/google/gemini-2.5-pro', 'kc/google/gemini-2.5-flash', 'kc/openai/gpt-4.1', 'kc/openai/o3',
  'kc/deepseek/deepseek-chat', 'kc/deepseek/deepseek-reasoner',
  'kc/thinkingmachines/inkling-small:free', 'kc/nvidia/nemotron-3-ultra-550b-a55b:free',
  'kc/nvidia/nemotron-3.5-lightning:free', 'kc/poolside/laguna-s-2.1:free',
  'kc/inclusionai/ling-3.0-flash-vl:free', 'kc/nex-agi/nex-n2.5-mini:free',
  'kc/inclusionai/ling-3.0-flash-sante:free', 'kc/dots-studio/dots-3-note-preview:free',
  'kc/nex-agi/nex-n2.5-pro:free', 'kc/google/lyria-3-pro-preview',
  'kc/inclusionai/ling-3.0-flash-fin:free', 'kc/google/lyria-3-clip-preview',
];

const WORKING = 'kc/openai/gpt-4.1';
let chatRequests = 0;
let deniedRequests = 0;

Object.assign(CONFIG, {
  AI_PROVIDER: 'openai',
  AI_BASE_URL: 'https://api.sea-lion.ai/v1',
  AI_API_KEY: 'sk-simulated',
  AI_MODEL: 'AUTO',
});

globalThis.fetch = async (url, options) => {
  if (String(url).endsWith('/models')) {
    return { ok: true, json: async () => ({ data: CATALOG.map(id => ({ id })) }) };
  }
  const model = JSON.parse(options.body).model;
  if (model !== WORKING) {
    deniedRequests += 1;
    return {
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'key_model_access_denied' } }),
      text: async () => JSON.stringify({ error: { message: 'key_model_access_denied' } }),
    };
  }
  chatRequests += 1;
  const text = model === WORKING && String(JSON.parse(options.body).messages.at(-1).content).includes('BTC')
    ? 'BTCUSDT: buy pressure is rising, no setup yet.'
    : 'سلام! آماده‌ام — بگو چه کار کنم؟';
  return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) };
};

const agent = createAgent({ system: 'You are the Bitunix trading agent.', tools: [] });
const first = await agent.say('سلام');
const afterFirst = { denied: deniedRequests, ok: chatRequests };
const second = await agent.say('BTC رو اسکن کن');

console.log('reply 1     :', first.content);
console.log('model       :', first.model);
console.log('provider    :', first.provider);
console.log('error       :', first.error);
console.log('state       :', JSON.stringify(describeModelConfig()));
console.log('reply 2     :', second.content);
console.log('calls after 1st:', JSON.stringify(afterFirst), '-> after 2nd:', JSON.stringify({ denied: deniedRequests, ok: chatRequests }));

if (!/سلام/.test(first.content) || first.model !== WORKING) {
  console.log('RESULT: FAILED (first message)');
  process.exit(1);
}
if (!/BTC/.test(second.content) || deniedRequests !== afterFirst.denied) {
  console.log('RESULT: FAILED (the resolved model was not reused)');
  process.exit(1);
}
console.log('RESULT: agent answered instead of going silent, and reused the resolved model');

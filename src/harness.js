import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { CONFIG, applySettingsFile, readSettingsFile } from './config.js';
import { createAgent } from './agent/loop.js';
import { buildSystemPrompt } from './prompt.js';
import { basicTools, setBasicMemory } from './agent/basic-tools.js';
import { traderTools, setPositionManager, setTraderInstances } from './trader/agent-tools.js';
import { bitunixTools, setBitunixClient } from './bitunix/futures-tools.js';
import { BitunixClient } from './bitunix/client.js';
import { Trader } from './trader/trader.js';
import { Memory } from './agent/memory.js';
import { listSkills } from './agent/skills.js';
import { loadMcpTools, disposeMcpTools } from './agent/mcp.js';

export function startHarness({ say, input = process.stdin, output = process.stdout, log = console.error }) {
  const rl = readline.createInterface({ input });
  const send = value => output.write(`${JSON.stringify(value)}\n`);
  let queue = Promise.resolve();

  async function handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let message = text;
    let id = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        id = parsed.id ?? null;
        message = String(parsed.message ?? parsed.text ?? '');
      }
    } catch {}
    if (!message) {
      send({ id, ok: false, error: 'message is empty' });
      return;
    }
    try {
      const result = await say(message);
      send({ id, ok: true, reply: result?.content ?? result?.reply ?? '', model: CONFIG.AI_MODEL, rounds: result?.rounds });
    } catch (error) {
      send({ id, ok: false, error: error.message });
    }
  }

  rl.on('line', line => {
    queue = queue.then(() => handleLine(line)).catch(error => send({ id: null, ok: false, error: error.message }));
  });
  rl.on('close', () => { queue.catch(() => {}); });
  log('[harness] JSONL ready');
  return { stop() { rl.close(); }, whenIdle() { return queue; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fileSettings = await readSettingsFile().catch(() => ({}));
  try { applySettingsFile(CONFIG, fileSettings); } catch {}
  const client = new BitunixClient();
  const trader = new Trader(client);
  setTraderInstances(trader, client);
  setPositionManager(trader.positionManager);
  setBitunixClient(client);
  const memory = new Memory();
  await memory.load();
  setBasicMemory(memory);
  const mcpTools = await loadMcpTools(Array.isArray(fileSettings.mcp?.servers) ? fileSettings.mcp.servers : []);
  const tools = [...basicTools, ...traderTools, ...bitunixTools, ...mcpTools];
  const getSystem = async () => buildSystemPrompt({ skills: await listSkills(), tools, memory: memory.all() });
  const agent = createAgent({ system: getSystem, tools, memory, maxRounds: CONFIG.AGENT_MAX_STEP, autoCompact: true, thinkingLevel: CONFIG.AGENT_THINKING_LEVEL });
  const harness = startHarness({ say: text => agent.say(text) });
  const shutdown = () => { harness.stop(); disposeMcpTools(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

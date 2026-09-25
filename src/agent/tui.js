import { createAgent } from './loop.js';
import { CONFIG, readSettingsFile, applySettingsFile } from '../config.js';
import { basicTools, setBasicMemory } from './basic-tools.js';
import { traderTools, setPositionManager, setTraderInstances } from '../trader/agent-tools.js';
import { bitunixTools, setBitunixClient } from '../bitunix/futures-tools.js';
import { BitunixClient } from '../bitunix/client.js';
import { Trader } from '../trader/trader.js';
import { Memory } from './memory.js';
import { listSkills, loadSkill, saveSkill, removeSkill } from './skills.js';
import { buildSystemPrompt, readSoul, writeSoul, appendSoul } from '../prompt.js';
import { loadMcpTools, disposeMcpTools } from './mcp.js';
import { detectProviders } from './config.js';
import { listAnthropicModels, listGeminiModels, listOpenAiModels, resetOpenAiModelCache } from './brain.js';
import { formatSettings, formatStatus, startTui } from '../ui/tui.js';

try {
  applySettingsFile(CONFIG, await readSettingsFile());
} catch {}

const memory = new Memory();
await memory.load();
setBasicMemory(memory);
const client = new BitunixClient();
const trader = new Trader(client);
setTraderInstances(trader, client);
setPositionManager(trader.positionManager);
setBitunixClient(client);
const fileSettings = await readSettingsFile().catch(() => ({}));
let mcpTools = await loadMcpTools(Array.isArray(fileSettings.mcp?.servers) ? fileSettings.mcp.servers : []);
const tools = [...basicTools, ...traderTools, ...bitunixTools, ...mcpTools];
async function reloadMcpTools() {
  disposeMcpTools();
  mcpTools = await loadMcpTools(Array.isArray(fileSettings.mcp?.servers) ? fileSettings.mcp.servers : []);
  tools.splice(0, tools.length, ...basicTools, ...traderTools, ...bitunixTools, ...mcpTools);
  return mcpTools;
}
const getSystem = async () => buildSystemPrompt({ skills: await listSkills(), tools, memory: memory.all() });
const agent = createAgent({ system: getSystem, tools, memory, maxRounds: CONFIG.AGENT_MAX_STEP, autoCompact: true, thinkingLevel: CONFIG.AGENT_THINKING_LEVEL });

async function modelList() {
  const provider = detectProviders();
  if (provider === 'openai') return listOpenAiModels();
  if (provider === 'anthropic') return listAnthropicModels();
  return listGeminiModels();
}

startTui({
  async handleInput(text) {
    const [rawCommand, ...rest] = text.trim().split(/\s+/);
    const command = rawCommand.replace(/^\//, '').split('@')[0].toLowerCase();
    const arg = rest.join(' ');
    if (command === 'help') return 'Send a message, or use /settings /status /skills /soul /mcp /models /quit.';
    if (command === 'settings' || command === 'tsettings') return formatSettings();
    if (command === 'status' || command === 'tstatus') return formatStatus();
    if (command === 'models') return JSON.stringify(await modelList(), null, 2);
    if (command === 'setmodels') {
      const provider = detectProviders();
      const key = provider === 'openai' ? 'AI_MODEL' : provider === 'anthropic' ? 'ANTHROPIC_MODEL' : 'GEMINI_MODEL';
      const value = arg || 'AUTO';
      if (value.toUpperCase() !== 'AUTO' && !(await modelList()).includes(value)) return `Model is not available: ${value}`;
      CONFIG[key] = value.toUpperCase() === 'AUTO' ? 'AUTO' : value;
      resetOpenAiModelCache();
      return `${key}=${CONFIG[key]}`;
    }
    if (command === 'mcp') {
      if (arg === 'reload') return `MCP reloaded. Tools: ${(await reloadMcpTools()).length}`;
      return JSON.stringify(mcpTools.map(tool => tool.name), null, 2);
    }
    if (command === 'skills' || command === 'skils') {
      if (!arg || arg === 'list') return JSON.stringify(await listSkills(), null, 2);
      const [action, ...parts] = arg.split(/\s+/);
      if (action === 'read' || action === 'use') {
        const skill = await loadSkill(parts[0]);
        if (!skill) return `Skill not found: ${parts[0]}`;
        if (action === 'use') {
          const active = Array.isArray(memory.all().active_skills) ? memory.all().active_skills : [];
          await memory.remember('active_skills', [...new Set([...active, skill.id])]);
        }
        return skill.content;
      }
      if (action === 'remove') return (await removeSkill(parts[0])) ? 'Skill removed.' : 'Skill not found.';
      if (action === 'add') {
        const body = parts.join(' ');
        const separator = body.indexOf('::');
        if (separator < 0) return 'Usage: /skills add name :: markdown content';
        const saved = await saveSkill(parts[0], body.slice(separator + 2).trim());
        return `Skill saved: ${saved.id}`;
      }
      return 'Usage: /skills list|read|use|remove|add';
    }
    if (command === 'soul' || command === 'sould') {
      if (!arg || arg === 'read') return readSoul().catch(() => 'SOUL.md not found');
      const [action, ...parts] = arg.split(/\s+/);
      if (action === 'set') return writeSoul(parts.join(' ')).then(() => 'SOUL updated.');
      if (action === 'append') return appendSoul(parts.join(' ')).then(() => 'SOUL appended.');
      return 'Usage: /soul read|set|append';
    }
    const reply = await agent.say(text);
    return reply.content;
  },
});

process.on('SIGINT', () => disposeMcpTools());

import { CONFIG, parseBoolean } from './config.js';
import { strictListFromData } from './bitunix/client.js';
import { sendMessage, isOwner, esc, formatSignalReport } from './telegram-bot.js';
import { applySettings, getTraderSettings, parseSettingValue, validateSettings } from './trader/settings.js';
import { parseThinkingLevel } from './agent/thinking.js';
import { primaryProviderName, providerKeyVar, providerModelVar } from './agent/config.js';
import { listAnthropicModels, listGeminiModels, listOpenAiModels, resetOpenAiModelCache, describeModelConfig } from './agent/brain.js';
import { listSkills, loadSkill, removeSkill, saveSkill } from './agent/skills.js';
import { appendSoul, readSoul, writeSoul } from './prompt.js';

function listProviderModelsFor(provider) {
  if (provider === 'openai') return listOpenAiModels();
  if (provider === 'anthropic') return listAnthropicModels();
  if (provider === 'google') return listGeminiModels();
  return Promise.resolve([]);
}

function usage(chatId, text) {
  return sendMessage(chatId, text).then(() => true);
}

function parseHarnessInput(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { id: parsed.id ?? null, message: String(parsed.message ?? parsed.text ?? '') };
    }
  } catch {}
  return { id: null, message: text };
}

function markCooldown(trader) {
  if (trader?.state) trader.state.cooldownUntil = Date.now() + Number(CONFIG.cooldown_minutes) * 60000;
}

export function createTraderCommands({ client, scanner, trader, agent, loadSession = null, saveSession = null, mcpServers = [], getMcpTools = () => [], reloadMcpTools = null }) {
  const scanState = { scanOn: true };
  const reportState = { reportOn: true };

  async function handleCommand(msg, text) {
    const chatId = msg.chat.id;
    if (!isOwner(msg)) {
      await sendMessage(chatId, 'Not authorized.');
      return true;
    }
    const [cmdRaw, ...rest] = text.trim().split(/\s+/);
    const cmd = cmdRaw.replace(/^\//, '').split('@')[0].toLowerCase();
    const arg = rest.join(' ');

    try {
      switch (cmd) {
        case 'start': {
          await sendMessage(chatId, `<b>${esc(CONFIG.AGENT_NAME)}</b> started. DRY_RUN=<code>${CONFIG.dry_run ? 1 : 0}</code> AUTO_TRADE=<code>${CONFIG.auto_trade ? 'on' : 'off'}</code>`);
          return true;
        }
        case 'stop': {
          CONFIG.auto_trade = false;
          scanState.scanOn = false;
          await sendMessage(chatId, 'Auto-trade and autonomous scans stopped.');
          return true;
        }
        case 'help': {
          await sendMessage(chatId, '<b>Commands</b>\n/start /stop /status /help /settings /set /get /signal /balance /positions /trades /pnl /close &lt;symbol&gt; &lt;positionId&gt; /close_all &lt;symbol&gt; confirm /dryrun /autotrade /scan /report /leverage /symbol /models /setmodels /harness /skills|/skils /soul|/sould /mcp /thinking /memory /resume /ask /diag');
          return true;
        }
        case 'status': {
          await sendMessage(chatId, `<b>Status</b>\nsymbol <code>${esc(CONFIG.symbol)}</code>\nlev <code>${CONFIG.leverage}</code> ${esc(CONFIG.position_type)}/${esc(CONFIG.position_mode)}\ndry_run <code>${CONFIG.dry_run ? 1 : 0}</code> auto_trade <code>${CONFIG.auto_trade ? 'on' : 'off'}</code>\nscan <code>${scanState.scanOn ? 'on' : 'off'}</code> report <code>${reportState.reportOn ? 'on' : 'off'}</code>\nopen <code>${trader?.state?.positions?.length ?? 0}</code>`);
          return true;
        }
        case 'settings': {
          const settings = getTraderSettings(CONFIG);
          const rows = Object.entries(settings).map(([k, v]) => `${esc(k)}: <code>${esc(Array.isArray(v) ? v.join(',') : String(v))}</code>`).join('\n');
          await sendMessage(chatId, `<b>Settings</b>\n${rows}`);
          return true;
        }
        case 'set': {
          const [key, ...parts] = rest;
          if (!key || !parts.length) return usage(chatId, 'Usage: /set key value');
          if (key === 'dry_run' || key === 'auto_trade') return usage(chatId, 'Use /dryrun or /autotrade for safety switches.');
          if (key === 'order_unit') {
            const requestedUnit = parts.join(' ').trim().toLowerCase().replace(/[ -]+/g, '_').replace(/^by_/, '');
            if (!['cost', 'qty', 'position_size', 'position', 'position_sizing', 'size'].includes(requestedUnit)) {
              return usage(chatId, 'order_unit accepts cost (Cost Value: cost × leverage ÷ price), qty (Quantity Value: explicit quantity), or position_size (Nominal Value: nominal ÷ price, leverage-independent).');
            }
          }
          const value = parseSettingValue(key, parts.join(' '));
          if (key === 'symbol' && String(value).toUpperCase() !== CONFIG.symbol) {
            const positions = await client.getPendingPositions(CONFIG.symbol);
            const positionList = strictListFromData(positions);
            if (!positionList || positionList.length) return usage(chatId, 'Cannot change symbol while positions are open.');
          }
          applySettings(CONFIG, { [key]: value });
          await sendMessage(chatId, `Set <code>${esc(key)}</code> = <code>${esc(String(value))}</code>`);
          return true;
        }
        case 'get': {
          const settings = getTraderSettings(CONFIG);
          const key = rest[0];
          if (!key || !Object.hasOwn(settings, key)) return usage(chatId, 'Unknown setting.');
          await sendMessage(chatId, `<code>${esc(key)}</code> = <code>${esc(String(settings[key]))}</code>`);
          return true;
        }
        case 'signal': {
          const sym = arg || CONFIG.symbol;
          const res = await scanner.scan(sym);
          await sendMessage(chatId, formatSignalReport(res));
          return true;
        }
        case 'balance': {
          const acc = await client.getAccount('USDT');
          await sendMessage(chatId, `<b>Balance</b>\n<code>${esc(JSON.stringify(acc, null, 1))}</code>`);
          return true;
        }
        case 'positions': {
          const pos = await client.getPendingPositions(CONFIG.symbol);
          await sendMessage(chatId, `<b>Positions</b>\n<code>${esc(JSON.stringify(pos, null, 1))}</code>`);
          return true;
        }
        case 'trades': {
          const [o, p] = await Promise.all([client.getHistoryOrders(CONFIG.symbol), client.getHistoryPositions(CONFIG.symbol)]);
          await sendMessage(chatId, `<b>Orders</b>\n<code>${esc(JSON.stringify(o, null, 1).slice(0, 2000))}</code>\n<b>Positions</b>\n<code>${esc(JSON.stringify(p, null, 1).slice(0, 1500))}</code>`);
          return true;
        }
        case 'pnl': {
          const pos = await client.getPendingPositions(CONFIG.symbol);
          await sendMessage(chatId, `<b>PnL</b>\n<code>${esc(JSON.stringify(pos, null, 1))}</code>`);
          return true;
        }
        case 'close': {
          const [symbol, positionId] = rest;
          if (!symbol || !positionId) return usage(chatId, 'Usage: /close SYMBOL POSITION_ID');
          if (CONFIG.dry_run) {
            markCooldown(trader);
            await sendMessage(chatId, `DRY_RUN=1 — simulated close for <code>${esc(symbol)}</code> / <code>${esc(positionId)}</code>.`);
            return true;
          }
          const res = await client.closePosition(symbol.toUpperCase(), positionId);
          markCooldown(trader);
          await sendMessage(chatId, `Closed position: <code>${esc(JSON.stringify(res))}</code>`);
          return true;
        }
        case 'close_all': {
          const [symbol, confirmation] = rest;
          if (!symbol || confirmation?.toLowerCase() !== 'confirm') return usage(chatId, 'Usage: /close_all SYMBOL confirm');
          if (CONFIG.dry_run) {
            markCooldown(trader);
            await sendMessage(chatId, `DRY_RUN=1 — simulated close-all for <code>${esc(symbol)}</code>.`);
            return true;
          }
          const res = await client.closeAllPosition(symbol.toUpperCase());
          markCooldown(trader);
          await sendMessage(chatId, `Closed all positions: <code>${esc(JSON.stringify(res))}</code>`);
          return true;
        }
        case 'dryrun': {
          const next = parseBoolean(arg, !CONFIG.dry_run, 'dryrun');
          if (!next && (!CONFIG.BITUNIX_API_KEY || !CONFIG.BITUNIX_API_SECRET)) return usage(chatId, 'Both Bitunix API credentials are required for live mode.');
          CONFIG.dry_run = next;
          await sendMessage(chatId, `DRY_RUN=<code>${CONFIG.dry_run ? 1 : 0}</code>`);
          return true;
        }
        case 'autotrade': {
          const next = parseBoolean(arg, !CONFIG.auto_trade, 'autotrade');
          if (next && (!CONFIG.BITUNIX_API_KEY || !CONFIG.BITUNIX_API_SECRET)) return usage(chatId, 'Both Bitunix API credentials are required for auto-trade.');
          CONFIG.auto_trade = next;
          if (CONFIG.auto_trade) scanState.scanOn = true;
          await sendMessage(chatId, `AUTO_TRADE=<code>${CONFIG.auto_trade ? 'on' : 'off'}</code>`);
          return true;
        }
        case 'scan': {
          scanState.scanOn = parseBoolean(arg, !scanState.scanOn, 'scan');
          await sendMessage(chatId, `scan <code>${scanState.scanOn ? 'on' : 'off'}</code>`);
          return true;
        }
        case 'report': {
          reportState.reportOn = parseBoolean(arg, !reportState.reportOn, 'report');
          await sendMessage(chatId, `report <code>${reportState.reportOn ? 'on' : 'off'}</code>`);
          return true;
        }
        case 'leverage': {
          const lev = Number(arg);
          if (!Number.isInteger(lev)) return usage(chatId, 'Usage: /leverage 10');
          const next = { ...getTraderSettings(CONFIG), leverage: lev };
          const errors = validateSettings(next);
          if (errors.length) return usage(chatId, `Invalid leverage: ${esc(errors[0])}`);
          if (!CONFIG.dry_run) await client.changeLeverage(CONFIG.symbol, lev);
          applySettings(CONFIG, { leverage: lev });
          await sendMessage(chatId, `leverage <code>${lev}</code>`);
          return true;
        }
        case 'symbol': {
          if (!arg) return usage(chatId, 'Usage: /symbol BTCUSDT');
          const symbol = arg.toUpperCase();
          if (!/^[A-Z0-9]{5,32}$/.test(symbol)) return usage(chatId, 'Invalid symbol.');
          const positions = await client.getPendingPositions(CONFIG.symbol);
          const positionList = strictListFromData(positions);
          if (!positionList || positionList.length) return usage(chatId, 'Cannot change symbol while positions are open.');
          applySettings(CONFIG, { symbol });
          await sendMessage(chatId, `symbol <code>${esc(CONFIG.symbol)}</code>`);
          return true;
        }
        case 'models': {
          let provider;
          try { provider = primaryProviderName(); } catch { provider = 'none'; }
          const models = provider === 'none' ? [] : await listProviderModelsFor(provider);
          const configuredKey = providerModelVar(provider) || 'AI_MODEL';
          const configured = String(CONFIG[configuredKey] || '').toUpperCase() === 'AUTO' || !CONFIG[configuredKey]
            ? 'auto-detect'
            : models.includes(CONFIG[configuredKey]) ? 'configured' : 'not found';
          const modelState = describeModelConfig();
          const active = modelState.resolvedModel ? `\nactive: <code>${esc(modelState.resolvedModel)}</code> (${esc(modelState.source)}, ${modelState.candidateCount} from the provider)` : '';
          const note = models.length ? '' : `\nwarning: no models read from the provider — ${esc(modelState.catalogError || 'check the gateway')}`;
          await sendMessage(chatId, `<b>${esc(provider)} models</b>\nconfigured: <code>${esc(CONFIG[configuredKey] || 'AUTO')}</code> (${configured})${active}${note}\n${models.slice(0, 40).map(model => `<code>${esc(model)}</code>`).join('\n')}`);
          return true;
        }
        case 'setmodels': {
          let provider;
          try { provider = primaryProviderName(); } catch (error) { return usage(chatId, error.message); }
          const value = rest.join(' ').trim() || 'AUTO';
          const key = providerModelVar(provider);
          if (value.toUpperCase() !== 'AUTO') {
            // Any name is accepted. The provider, not this code, decides which
            // models the key may use — a local list here would only get in the way.
            CONFIG[key] = value;
            resetOpenAiModelCache();
            await sendMessage(chatId, `${key} set to <code>${esc(value)}</code>. If the key may not use it, the next message says so and moves on to the next model the provider lists.`);
            return true;
          }
          CONFIG[key] = 'AUTO';
          resetOpenAiModelCache();
          await sendMessage(chatId, `${key} set to <code>AUTO</code> — models are read from the provider for this key.`);
          return true;
        }
        case 'harness': {
          if (!arg) {
            await sendMessage(chatId, '<b>Harness</b>\nUsage: <code>/harness your JSONL message</code>\nExample: <code>/harness {"id":1,"message":"status"}</code>');
            return true;
          }
          const input = parseHarnessInput(arg);
          if (!input.message) return usage(chatId, 'Harness message cannot be empty.');
          const reply = await agent.say(input.message);
          await sendMessage(chatId, `<code>${esc(JSON.stringify({ id: input.id, ok: true, reply: reply?.content || '', model: reply?.model || CONFIG.AI_MODEL, rounds: reply?.rounds }))}</code>`);
          return true;
        }
        case 'skills':
        case 'skils': {
          const action = rest.shift()?.toLowerCase() || 'list';
          if (action === 'list') {
            const skills = await listSkills();
            await sendMessage(chatId, `<b>Skills</b>\n${skills.map(skill => `<code>${esc(skill.id)}</code>${skill.custom ? ' (custom)' : ''}${skill.description ? ` — ${esc(skill.description)}` : ''}`).join('\n') || '-'}`);
            return true;
          }
          const name = rest.shift();
          if (!name) return usage(chatId, 'Usage: /skills read|use|remove|add name');
          if (action === 'read' || action === 'use') {
            const skill = await loadSkill(name);
            if (!skill) return usage(chatId, `Skill not found: ${name}`);
            if (action === 'read') {
              await sendMessage(chatId, `<b>${esc(skill.id)}</b>\n<pre>${esc(skill.content)}</pre>`);
            } else {
              const active = Array.isArray(agent?.memory?.all?.().active_skills) ? agent.memory.all().active_skills : [];
              await agent.memory.remember('active_skills', [...new Set([...active, skill.id])]);
              await sendMessage(chatId, `Skill activated: <code>${esc(skill.id)}</code>`);
            }
            return true;
          }
          if (action === 'remove') {
            const removed = await removeSkill(name);
            if (!removed && agent?.memory) {
              const disabled = Array.isArray(agent.memory.all().disabled_skills) ? agent.memory.all().disabled_skills : [];
              await agent.memory.remember('disabled_skills', [...new Set([...disabled, name.toLowerCase()])]);
            }
            await sendMessage(chatId, removed ? `Skill removed: <code>${esc(name)}</code>` : `Skill disabled: <code>${esc(name)}</code>`);
            return true;
          }
          if (action === 'add') {
            const body = rest.join(' ').trim();
            const separator = body.indexOf('::');
            if (separator < 0) return usage(chatId, 'Usage: /skills add name :: markdown content');
            const skill = await saveSkill(name, body.slice(separator + 2).trim());
            await sendMessage(chatId, `Skill saved: <code>${esc(skill.id)}</code>`);
            return true;
          }
          return usage(chatId, 'Usage: /skills list|read|use|remove|add');
        }
        case 'soul':
        case 'sould': {
          const action = rest.shift()?.toLowerCase() || 'read';
          if (action === 'read' || action === 'show') {
            await sendMessage(chatId, `<b>SOUL</b>\n<pre>${esc(await readSoul())}</pre>`);
          } else if (action === 'set') {
            if (!arg) return usage(chatId, 'Usage: /soul set new prompt text');
            await writeSoul(arg);
            await sendMessage(chatId, 'SOUL updated.');
          } else if (action === 'append') {
            if (!arg) return usage(chatId, 'Usage: /soul append text');
            await appendSoul(arg);
            await sendMessage(chatId, 'SOUL appended.');
          } else {
            return usage(chatId, 'Usage: /soul read|set|append');
          }
          return true;
        }
        case 'mcp': {
          const action = rest.shift()?.toLowerCase() || 'list';
          if (action === 'reload') {
            if (!reloadMcpTools) return usage(chatId, 'MCP reload is not available.');
            const loaded = await reloadMcpTools();
            await sendMessage(chatId, `MCP reloaded. Tools: <code>${loaded.length}</code>`);
          } else {
            const tools = getMcpTools();
            await sendMessage(chatId, `<b>MCP</b>\nservers: <code>${esc(mcpServers.map(server => server.name).join(', ') || '-')}</code>\ntools: <code>${esc(tools.map(tool => tool.name).join(', ') || '-')}</code>`);
          }
          return true;
        }
        case 'thinking': {
          const level = parseThinkingLevel(arg);
          if (!arg || level === 'mid' && arg.toLowerCase() !== 'mid') return usage(chatId, 'Usage: /thinking off|low|mid|high|max');
          CONFIG.AGENT_THINKING_ENABLED = level !== 'off';
          if (agent) agent.thinkingLevel = level;
          await sendMessage(chatId, `thinking <code>${esc(level)}</code>`);
          return true;
        }
        case 'memory': {
          await sendMessage(chatId, `memory keys: <code>${esc(Object.keys(agent?.memory?.all?.() || {}).join(', ') || '-')}</code>`);
          return true;
        }
        case 'resume': {
          if (!loadSession) {
            await sendMessage(chatId, 'Session resume is not available in this runtime.');
            return true;
          }
          const sessionId = arg || String(chatId);
          const session = await loadSession(sessionId);
          if (!session || !Array.isArray(session.history) || !agent?.replaceHistory) {
            await sendMessage(chatId, `No saved session found for <code>${esc(sessionId)}</code>.`);
            return true;
          }
          agent.replaceHistory(session.history);
          await sendMessage(chatId, `Session resumed: <code>${esc(sessionId)}</code> (${session.history.length} messages).`);
          return true;
        }
        case 'ask': {
          const reply = await agent.say(arg || 'status?');
          await sendMessage(chatId, esc(reply?.content || 'ok'));
          if (saveSession) await saveSession(String(chatId), { history: agent.history });
          return true;
        }
        case 'diag': {
          let provider = 'none';
          try { provider = primaryProviderName(); } catch {}
          const modelKey = providerModelVar(provider) || 'AI_MODEL';
          const keyName = providerKeyVar(provider) || 'AI_API_KEY';
          const lastError = agent?.lastError ? String(agent.lastError).slice(0, 600) : 'none';
          const modelState = describeModelConfig();
          const skipped = [
            ...(modelState.deniedModels || []).map(m => `${m} (no access)`),
            ...(modelState.rateLimitedModels || []).map(m => `${m} (rate limited)`),
          ];
          const skippedNote = skipped.length ? `\nskipped <code>${esc(skipped.join(', '))}</code>` : '';
          await sendMessage(chatId, `<b>Diag</b>\napi <code>${client ? 'ready' : 'missing'}</code>\ndb <code>${CONFIG.DATABASE_URL ? 'postgres' : 'file'}</code>\nws <code>configured</code>\nllm <code>${esc(provider)}</code> base <code>${esc(modelState.baseUrl || '-')}</code>\nmodel <code>${esc(CONFIG[modelKey] || 'AUTO')}</code> resolved <code>${esc(agent?.lastModel || modelState.resolvedModel || '-')}</code> key <code>${CONFIG[keyName] ? 'set' : 'missing'}</code>\ncandidates <code>${modelState.candidateCount || 0}</code>${skippedNote}\ncatalog <code>${esc(modelState.catalogError || 'ok')}</code>\nlast_error <code>${esc(lastError)}</code>`);
          return true;
        }
        default:
          return false;
      }
    } catch (error) {
      await sendMessage(chatId, `Error: ${esc(error.message)}`);
      return true;
    }
  }

  return { handleCommand, scanState, reportState };
}

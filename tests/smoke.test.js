import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ema, rsi, bollinger, atr, macd, superTrend, atrBreakout, computeSignal } from '../src/bitunix/indicators.js';
import {
  applyPersistedSettings,
  applySettings,
  getPersistentSettings,
  getTraderSettings,
  normalizeSettings,
  parseSettingValue,
  validateSettings,
} from '../src/trader/settings.js';
import { parseThinkingLevel } from '../src/agent/thinking.js';
import { CONFIG, parseBoolean, applySettingsFile } from '../src/config.js';
import { BitunixClient, canonicalQuery } from '../src/bitunix/client.js';
import Scanner from '../src/bitunix/scanner.js';
import { computeQty, liqDistanceOk } from '../src/bitunix/risk.js';
import { Trader } from '../src/trader/trader.js';
import { PositionManager } from '../src/trader/position-manager.js';
import { setPositionManager, setTraderInstances, traderTools } from '../src/trader/agent-tools.js';
import { bitunixTools, setBitunixClient } from '../src/bitunix/futures-tools.js';
import { detectProviders, primaryProviderName } from '../src/agent/config.js';
import { isAuthError, isBalanceError, isRateLimitError, shouldAdvanceModel } from '../src/agent/auto-model.js';
import {
  chat,
  describeModelConfig,
  listOpenAiModels,
  resetModelState,
  resetOpenAiModelCache,
  resolveOpenAiModelsUrl,
  resolveOpenAiUrl,
} from '../src/agent/brain.js';
import { createAgent } from '../src/agent/loop.js';
import { stringifyToolResult, validateToolArguments } from '../src/agent/tools.js';
import { splitHtml } from '../src/telegram-bot.js';
import { BitunixWs, normalizeChannel, wsLoginSignature } from '../src/bitunix/ws.js';
import { createTraderCommands } from '../src/telegram-trader.js';

const originalConfig = { ...CONFIG, timeframes: [...CONFIG.timeframes] };
const originalFetch = globalThis.fetch;


afterEach(() => {
  Object.assign(CONFIG, originalConfig, { timeframes: [...originalConfig.timeframes] });
  globalThis.fetch = originalFetch;
  setTraderInstances(null, null);
  setPositionManager(null);
  setBitunixClient(null);
  resetOpenAiModelCache();
});

function fakePosition(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    positionId: 'p1',
    side: 'BUY',
    size: '1',
    avgPrice: '100',
    markPrice: '100',
    liqPrice: '50',
    openTime: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('indicators', () => {
  it('ema returns number for enough data', () => {
    const arr = Array.from({ length: 30 }, (_, i) => 100 + i);
    assert.ok(typeof ema(arr, 20) === 'number');
  });

  it('rsi returns 0-100', () => {
    const arr = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5 + i * 0.2);
    const v = rsi(arr);
    assert.ok(v === null || (v >= 0 && v <= 100));
  });

  it('bollinger returns band', () => {
    const arr = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    const bb = bollinger(arr);
    assert.ok(bb && bb.upper > bb.mid && bb.mid > bb.lower);
  });

  it('computeSignal returns direction+confidence', () => {
    const kl = Array.from({ length: 60 }, (_, i) => ({
      open: String(100 + i), high: String(101 + i), low: String(99 + i), close: String(100 + i),
    }));
    const vols = Array.from({ length: 60 }, () => 10);
    const res = computeSignal(kl, vols, 0);
    assert.ok(['bullish', 'bearish', 'neutral'].includes(res.direction));
    assert.ok(res.confidence >= 0 && res.confidence <= 100);
    assert.ok(Object.hasOwn(res.signals, 'supertrend'));
    assert.ok(Object.hasOwn(res.signals, 'atr_breakout'));
  });
});

describe('settings', () => {
  it('normalize fills defaults', () => {
    const s = normalizeSettings({});
    assert.equal(s.symbol, 'BTCUSDT');
    assert.ok(s.timeframes.includes('3m'));
    assert.ok(s.min_confidence === 80);
  });

  it('validate catches bad leverage', () => {
    const errs = validateSettings({ ...normalizeSettings({}), leverage: 999 });
    assert.ok(errs.length > 0);
  });

  it('supports the three official futures order units', () => {
    const settings = normalizeSettings({ order_unit: 'position sizing' });
    assert.equal(settings.order_unit, 'position_size');
    assert.deepEqual(validateSettings(settings), []);
    assert.equal(normalizeSettings({ order_unit: 'qty' }).order_unit, 'qty');
    assert.equal(normalizeSettings({ order_unit: 'cost' }).order_unit, 'cost');
  });
});

describe('thinking', () => {
  it('parses levels', () => {
    assert.equal(parseThinkingLevel('high'), 'high');
    assert.equal(parseThinkingLevel('off'), 'off');
    assert.equal(parseThinkingLevel('zzz'), 'mid');
  });
});

describe('safety configuration', () => {
  it('parses common boolean values and rejects unsafe values', () => {
    assert.equal(parseBoolean('true', false, 'TEST'), true);
    assert.equal(parseBoolean('0', true, 'TEST'), false);
    assert.throws(() => parseBoolean('maybe', true, 'TEST'), /TEST/);
  });

  it('normalizes aliases and rejects invalid persisted values', () => {
    const settings = normalizeSettings({ margin_mode: 'isolated', timeframes: '1m, 5m' });
    assert.equal(settings.position_type, 'isolated');
    assert.deepEqual(settings.timeframes, ['1m', '5m']);
    assert.ok(validateSettings({ ...settings, leverage: NaN }).length > 0);
    assert.ok(validateSettings({ ...settings, max_positions: 0 }).length > 0);
    assert.equal(parseSettingValue('max_positions', '4'), 4);
  });

  it('migrates legacy settings while ignoring secret and unknown fields', () => {
    const target = { ...getTraderSettings(CONFIG), dry_run: true, auto_trade: false };
    applyPersistedSettings(target, { symbol: 'ETHUSDT', leverage: 12, BITUNIX_API_SECRET: 'secret', unknown: 'value', dry_run: false });
    assert.equal(target.symbol, 'BTCUSDT');
    assert.equal(target.leverage, 12);
    assert.equal(target.dry_run, true);
    assert.equal(Object.hasOwn(target, 'BITUNIX_API_SECRET'), false);
  });

  it('exposes only public settings and excludes safety flags from persistence', () => {
    CONFIG.BITUNIX_API_SECRET = 'secret-sentinel';
    CONFIG.dry_run = true;
    CONFIG.auto_trade = false;
    const publicSettings = getTraderSettings(CONFIG);
    assert.equal(Object.hasOwn(publicSettings, 'BITUNIX_API_SECRET'), false);
    const persistent = getPersistentSettings(CONFIG);
    assert.equal(Object.hasOwn(persistent, 'symbol'), false);
    assert.equal(Object.hasOwn(persistent, 'dry_run'), false);
    assert.equal(Object.hasOwn(persistent, 'auto_trade'), false);
    assert.equal(Object.hasOwn(persistent, 'BITUNIX_API_SECRET'), false);
  });
});

describe('indicator correctness', () => {
  it('calculates directional RSI, MACD, Super Trend, and ATR breakout', () => {
    const increasing = Array.from({ length: 80 }, (_, index) => 100 + index * index);
    const highs = increasing.map(value => value + 1);
    const lows = increasing.map(value => value - 1);
    assert.equal(rsi(increasing), 100);
    assert.equal(macd(increasing), 'bullish');
    assert.equal(superTrend(highs, lows, increasing), 'bullish');
    const decreasing = Array.from({ length: 80 }, (_, index) => 1000 - index * index);
    assert.equal(superTrend(decreasing.map(value => value + 1), decreasing.map(value => value - 1), decreasing), 'bearish');
    const flat = Array.from({ length: 60 }, () => 100);
    assert.equal(superTrend(flat.map(value => value + 1), flat.map(value => value - 1), flat), 'neutral');
    const breakout = [...increasing];
    breakout[breakout.length - 2] = breakout[breakout.length - 3];
    breakout[breakout.length - 1] += 10;
    const breakoutHighs = breakout.map(value => value + 1);
    const breakoutLows = breakout.map(value => value - 1);
    assert.equal(atrBreakout(breakoutHighs, breakoutLows, breakout, 5, 5, 0.1), 'bullish');
  });

  it('rejects malformed kline values', () => {
    const klines = Array.from({ length: 60 }, (_, index) => ({ close: String(100 + index), high: 'NaN', low: '1' }));
    const volumes = Array.from({ length: 60 }, () => 1);
    assert.throws(() => computeSignal(klines, volumes, 0), /positive finite/);
  });
});

describe('exchange safety', () => {
  it('matches the official Bitunix query signature format', () => {
    assert.equal(canonicalQuery({ uid: 200, id: 1 }), 'id1uid200');
    assert.equal(canonicalQuery({ symbol: 'BTCUSDT', limit: 200, interval: '15m' }), 'interval15mlimit200symbolBTCUSDT');
  });

  it('rejects Bitunix API error envelopes', async () => {
    const client = new BitunixClient();
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: '1001', msg: 'rejected', data: null }) });
    await assert.rejects(() => client.request('POST', '/test', { a: 1 }), /rejected/);
  });

  it('uses official Bitunix position close and TP/SL contracts', async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, json: async () => ({ code: 0, data: { orderId: 'x' } }) };
    };
    const client = new BitunixClient();
    await client.closePosition('BTCUSDT', 'p1', { symbol: 'BTCUSDT', positionId: 'p1', side: 'LONG', qty: '2' });
    await client.placeTPSL({ symbol: 'BTCUSDT', positionId: 'p1', tpPrice: '110', slPrice: '90' });
    await client.getLeverageAndMarginMode('BTCUSDT');
    await client.getPositionMode();
    assert.match(requests[0].url, /trade\/place_order/);
    assert.equal(requests[0].body.side, 'BUY');
    assert.equal(requests[0].body.tradeSide, 'CLOSE');
    assert.match(requests[1].url, /tpsl\/position\/place_order/);
    assert.equal(Object.hasOwn(requests[1].body, 'tpOrderType'), false);
    assert.match(requests[2].url, /account\/get_leverage_margin_mode\?symbol=BTCUSDT&marginCoin=USDT/);
    assert.match(requests[3].url, /account\/position_mode/);
  });

  it('does not substitute a different margin coin', async () => {
    const client = new BitunixClient();
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: [{ marginCoin: 'USDC', available: '10' }] }) });
    await assert.rejects(() => client.getAccount('USDT'), /USDT not found/);
  });

  it('matches documented market, pagination, and write endpoint contracts', async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ code: 0, data: { orderList: [], positionList: [] } }) };
    };
    const client = new BitunixClient();
    await client.getTickers('BTCUSDT');
    await client.getFundingRateBatch();
    await client.getTradingPairs(['BTCUSDT', 'ETHUSDT']);
    await client.getTradingSettings(['BTCUSDT']);
    await client.getHistoryOrders({ symbol: 'BTCUSDT', limit: 10 });
    await client.getPendingOrders({ symbol: 'BTCUSDT', limit: 10 });
    await client.getOrderDetail({ clientId: 'client-1' });
    await client.getHistoryPositions({ symbol: 'BTCUSDT', skip: 0, limit: 10 });
    await client.getPositionTiers('BTCUSDT');
    await client.cancelOrders('BTCUSDT', [{ orderId: 'o1' }]);
    await client.flashClosePosition('p1');
    await client.adjustPositionMargin('BTCUSDT', '-2', { side: 'LONG' });
    await client.batchOrder('BTCUSDT', [{ side: 'BUY', qty: '1', orderType: 'MARKET' }]);
    await client.placeTPSLOrder({ symbol: 'BTCUSDT', positionId: 'p1', slPrice: '90' });
    await client.transferAssetFromMainAccountToSubAccount({ amount: '10', assetType: 'SPOT' });
    await client.transferAssetFromSubAccountToMainAccount({ amount: '10', assetType: 'FUTURES' });
    const parsed = requests.map(item => ({ path: new URL(item.url).pathname, query: new URL(item.url).searchParams, body: item.options.body ? JSON.parse(item.options.body) : null }));
    assert.equal(parsed[0].path, '/api/v1/futures/market/tickers');
    assert.equal(parsed[0].query.get('symbols'), 'BTCUSDT');
    assert.equal(parsed[1].path, '/api/v1/futures/market/funding_rate/batch');
    assert.equal(parsed[2].query.get('symbols'), 'BTCUSDT,ETHUSDT');
    assert.equal(parsed[3].query.get('symbols'), 'BTCUSDT');
    assert.equal(parsed[4].query.get('limit'), '10');
    assert.equal(parsed[5].query.get('limit'), '10');
    assert.equal(parsed[6].query.get('clientId'), 'client-1');
    assert.equal(parsed[7].path, '/api/v1/futures/position/get_history_positions');
    assert.equal(parsed[7].query.get('skip'), '0');
    assert.equal(parsed[8].path, '/api/v1/futures/position/get_position_tiers');
    assert.equal(parsed[9].path, '/api/v1/futures/trade/cancel_orders');
    assert.deepEqual(parsed[9].body, { symbol: 'BTCUSDT', orderList: [{ orderId: 'o1' }] });
    assert.deepEqual(parsed[10].body, { positionId: 'p1' });
    assert.deepEqual(parsed[11].body, { symbol: 'BTCUSDT', amount: '-2', marginCoin: 'USDT', side: 'LONG' });
    assert.equal(parsed[12].body.orderList[0].tradeSide, 'OPEN');
    assert.equal(Object.hasOwn(parsed[12].body.orderList[0], 'symbol'), false);
    assert.equal(parsed[13].path, '/api/v1/futures/tpsl/place_order');
    assert.equal(parsed[14].path, '/api/v1/cp/asset/transfer-to-sub-account');
    assert.deepEqual(parsed[14].body, { amount: '10', assetType: 'SPOT' });
    assert.equal(parsed[15].path, '/api/v1/cp/asset/transfer-to-main-account');
  });

  it('signs the exact compact query/body representation', async () => {
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ code: 0, data: {} }) };
    };
    const client = new BitunixClient();
    client.apiKey = 'test-key';
    client.secretKey = 'test-secret';
    await client.request('GET', '/signed', { ignored: true }, { z: 2, a: 1 });
    const headers = request.options.headers;
    const expected = BitunixClient.sha256(BitunixClient.sha256(`${headers.nonce}${headers.timestamp}test-keya1z2`) + 'test-secret');
    assert.equal(headers.sign, expected);
    assert.match(headers.timestamp, /^\d{13}$/);
    assert.equal(headers['api-key'], 'test-key');
  });

  it('applies nominal, cost, and quantity order-unit semantics', async () => {
    const client = { getAccount: async () => ({ available: '1000' }) };
    const trader = new Trader(client);
    Object.assign(CONFIG, { order_unit: 'cost', margin_amount_pct: 2, position_sizing_margin_pct: 3, leverage: 10 });
    assert.equal(await trader.computePositionSize(100), 2);
    CONFIG.order_unit = 'position_size';
    assert.equal(await trader.computePositionSize(100), 0.3);
    CONFIG.leverage = 5;
    assert.equal(await trader.computePositionSize(100), 0.3);
    CONFIG.order_unit = 'qty';
    await assert.rejects(() => trader.computePositionSize(100), /explicit quantity/);
    assert.equal(computeQty({ available: 1000, price: 100, unit: 'position_size', leverage: 10 }), 0.3);
    assert.equal(computeQty({ available: 1000, price: 100, unit: 'cost', leverage: 10 }), 2);
  });

  it('never returns a silent generic answer for an empty LLM response', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_API_KEY: 'test-key', AI_BASE_URL: 'https://provider.test/v1', AI_MODEL: 'test-model' });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: null }, finish_reason: 'stop' }] }) });
    const agent = createAgent({ system: 'rules', tools: [] });
    const reply = await agent.say('hello');
    assert.match(reply.content, /LLM error|returned no text/);
    assert.doesNotMatch(reply.content, /Hichi bar nagasht/);
  });

  it('fails closed when liquidation data is missing', () => {
    assert.equal(liqDistanceOk({ markPrice: 100, liqPrice: undefined }), false);
    assert.equal(liqDistanceOk({ markPrice: 0, liqPrice: 50 }), false);
    assert.equal(liqDistanceOk({ markPrice: 100, liqPrice: 0 }), true);
    assert.equal(liqDistanceOk({ markPrice: 100, liqPrice: 50 }), true);
  });

  it('enforces minimum scanner confidence', async () => {
    const klines = Array.from({ length: 60 }, (_, index) => ({ close: String(100 + index * index), high: String(101 + index * index), low: String(99 + index * index), baseVol: '10' }));
    const scanner = new Scanner({ getKlines: async () => klines, getFundingRate: async () => ({ value: 0 }) });
    Object.assign(CONFIG, { timeframes: ['1m'], min_agreeing_strategies: 1, tf_min_confidence: 0, min_confidence: 101 });
    const result = await scanner.scan('BTCUSDT');
    assert.equal(result.signal, 'hold');
  });

  it('does not order when auto-trade is disabled', async () => {
    const calls = [];
    const client = {
      getPendingPositions: async () => [],
      getAccount: async () => ({ available: '100' }),
      placeOrder: async body => { calls.push(body); return { orderId: 'o1' }; },
    };
    const trader = new Trader(client);
    trader.scanner.scan = async symbol => ({ symbol, signal: 'bullish', lastPrice: '100', tfSignals: {} });
    CONFIG.auto_trade = false;
    CONFIG.dry_run = true;
    const result = await trader.scanAndOpen();
    assert.equal(result.executed, false);
    assert.equal(calls.length, 0);
  });

  it('reconciles an order after an ambiguous write failure', async () => {
    let submitted;
    const client = {
      getAccount: async () => ({ available: '100' }),
      placeOrder: async body => { submitted = body; throw Object.assign(new Error('timeout'), { executionUnknown: true }); },
      getPendingOrders: async () => [{ clientId: submitted.clientId, orderId: 'o1', status: 'FILLED' }],
      getHistoryOrders: async () => [],
      getPendingPositions: async () => [],
    };
    const trader = new Trader(client);
    Object.assign(CONFIG, { auto_trade: true, dry_run: false, leverage: 10, margin_amount_pct: 2, cooldown_minutes: 5 });
    const result = await trader.openPosition('BTCUSDT', 100, 'bullish');
    assert.equal(result.orderId, 'o1');
  });

  it('rechecks auto-trade immediately before order submission', async () => {
    let resolveAccount;
    let orders = 0;
    const account = new Promise(resolve => { resolveAccount = resolve; });
    const client = {
      getPendingPositions: async () => [],
      getAccount: async () => account,
      placeOrder: async () => { orders++; return { orderId: 'o1' }; },
    };
    const trader = new Trader(client);
    trader.scanner.scan = async symbol => ({ symbol, signal: 'bullish', lastPrice: '100', tfSignals: {} });
    Object.assign(CONFIG, { auto_trade: true, dry_run: false, signal_confirm_scans: 1, cooldown_minutes: 0 });
    const pending = trader.scanAndOpen();
    await new Promise(resolve => setImmediate(resolve));
    CONFIG.auto_trade = false;
    resolveAccount({ available: '100' });
    await assert.rejects(() => pending, /disabled before order/);
    assert.equal(orders, 0);
  });

  it('rejects a minimum order when available balance is zero', async () => {
    const client = { getAccount: async () => ({ available: '0' }) };
    const trader = new Trader(client);
    await assert.rejects(() => trader.computePositionSize(100), /positive/);
  });

  it('serializes concurrent scan cycles into one entry', async () => {
    let orders = 0;
    let scans = 0;
    const client = {
      getPendingPositions: async () => [],
      getAccount: async () => ({ available: '100' }),
      placeOrder: async () => { orders++; await new Promise(resolve => setTimeout(resolve, 10)); return { orderId: 'o1' }; },
    };
    const trader = new Trader(client);
    trader.scanner.scan = async symbol => {
      scans++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return { symbol, signal: 'bullish', lastPrice: '100', tfSignals: {} };
    };
    Object.assign(CONFIG, { auto_trade: true, dry_run: false, signal_confirm_scans: 1, cooldown_minutes: 0 });
    const results = await Promise.all([trader.scanAndOpen(), trader.scanAndOpen()]);
    assert.equal(scans, 1);
    assert.equal(orders, 1);
    assert.equal(results.filter(Boolean).length, 1);
  });

  it('verifies exchange account settings before live trading', async () => {
    const trader = new Trader({
      getAccount: async () => ({ positionMode: 'HEDGE' }),
      getLeverageAndMarginMode: async () => ({ leverage: CONFIG.leverage, marginMode: 'CROSS' }),
      getPositionMode: async () => ({ positionMode: 'HEDGE' }),
    });
    CONFIG.dry_run = false;
    await trader.verifyAccountSettings();
    const mismatched = new Trader({
      getAccount: async () => ({ positionMode: 'HEDGE' }),
      getLeverageAndMarginMode: async () => ({ leverage: CONFIG.leverage + 1, marginMode: 'CROSS' }),
      getPositionMode: async () => ({ positionMode: 'HEDGE' }),
    });
    await assert.rejects(() => mismatched.verifyAccountSettings(), /does not match/);
  });

  it('does not apply account settings while exposure is open', async () => {
    let changed = 0;
    const client = {
      getPendingPositions: async () => [fakePosition()],
      getPendingOrders: async () => [],
      getAccount: async () => ({ positionMode: 'HEDGE' }),
      getLeverageAndMarginMode: async () => ({ leverage: CONFIG.leverage, marginMode: 'CROSS' }),
      getPositionMode: async () => ({ positionMode: 'HEDGE' }),
      changeLeverage: async () => { changed++; },
    };
    const trader = new Trader(client);
    CONFIG.dry_run = false;
    const result = await trader.syncAccountSettings({ apply: true });
    assert.equal(result.skipped, 'open_exposure');
    assert.equal(changed, 0);
  });

  it('places missing TP/SL protection after a fill', async () => {
    const calls = [];
    const client = { getPendingTPSL: async () => [], placeTPSL: async params => { calls.push(params); return { orderId: 'sl-1' }; } };
    const pm = new PositionManager(client, 'BTCUSDT', { ...getTraderSettings(CONFIG), dry_run: false });
    const result = await pm.ensureProtection(fakePosition({ slPrice: undefined }));
    assert.equal(result.placed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].positionId, 'p1');
  });

  it('targets one position and honors dry-run for management', async () => {
    const calls = [];
    const client = {
      getPendingPositions: async () => [fakePosition()],
      closePosition: async (...args) => { calls.push(['close', ...args]); },
      modifyTPSL: async (...args) => { calls.push(['modify', ...args]); },
    };
    const pm = new PositionManager(client, 'BTCUSDT', { ...getTraderSettings(CONFIG), dry_run: true, sl_liquidation_safety: 0.9 });
    const result = await pm.checkLiquidationGuard(fakePosition({ markPrice: '100', liqPrice: '99.5' }));
    assert.equal(result.dryRun, true);
    assert.equal(calls.length, 0);
  });

  it('normalizes documented LONG positions for management', async () => {
    const client = { getPendingPositions: async () => [{ symbol: 'BTCUSDT', positionId: 'p1', side: 'LONG', qty: '1', avgOpenPrice: '100', liqPrice: '50' }], getTickers: async () => [{ lastPrice: '101' }] };
    const pm = new PositionManager(client, 'BTCUSDT', { ...getTraderSettings(CONFIG), symbol: 'BTCUSDT' });
    const positions = await pm.fetchPositions();
    assert.equal(positions[0].side, 'BUY');
    assert.equal(positions[0].avgPrice, '100');
    assert.equal(positions[0].markPrice, 101);
  });

  it('uses the configured symbol for position reads', async () => {
    const requested = [];
    const client = { getPendingPositions: async symbol => { requested.push(symbol); return []; } };
    const settings = { ...getTraderSettings(CONFIG), symbol: 'ETHUSDT' };
    const pm = new PositionManager(client, 'ETHUSDT', settings);
    await pm.fetchPositions();
    assert.deepEqual(requested, ['ETHUSDT']);
  });
});

describe('tool safety', () => {
  it('redacts configuration from the settings tool', async () => {
    setTraderInstances(null, {});
    CONFIG.BITUNIX_API_SECRET = 'secret-sentinel';
    const tool = traderTools.find(item => item.name === 'trader_get_settings');
    const result = await tool.handler();
    assert.equal(JSON.stringify(result).includes('secret-sentinel'), false);
  });

  it('forwards a specific position ID and never closes all positions', async () => {
    const calls = [];
    setTraderInstances(null, { closePosition: async (...args) => { calls.push(args); return { ok: true }; } });
    CONFIG.dry_run = false;
    const tool = traderTools.find(item => item.name === 'trader_close_position');
    await tool.handler({ symbol: 'BTCUSDT', positionId: 'p1' });
    assert.deepEqual(calls, [['BTCUSDT', 'p1']]);
  });

  it('does not mutate exchange settings in dry-run mode', async () => {
    let calls = 0;
    setBitunixClient({ changeLeverage: async () => { calls++; } });
    CONFIG.dry_run = true;
    const tool = bitunixTools.find(item => item.name === 'bitunix_change_leverage');
    const result = await tool.handler({ symbol: 'BTCUSDT', leverage: 5 });
    assert.equal(result.dry_run, true);
    assert.equal(calls, 0);
  });

  it('validates tool arguments and serializes undefined results', () => {
    assert.throws(() => validateToolArguments({ type: 'object', required: ['symbol'] }, {}), /missing required/);
    assert.equal(stringifyToolResult(undefined), '{"ok":true}');
  });

});

describe('provider and websocket safety', () => {
  it('auto-selects a discovered model without a hardcoded fallback', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://auto-provider.test/v1', AI_API_KEY: 'test-key', AI_MODEL: 'AUTO' });
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'standard' }] }) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    const result = await chat([{ role: 'user', content: 'hello' }], 'openai');
    assert.equal(result.text, 'ok');
    assert.equal(requests[1].body.model, 'standard');
    assert.equal(describeModelConfig().resolvedModel, 'standard');
  });

  it('answers even when every availability probe fails', async () => {
    // This is the reported production failure: /models lists 30+ models but no
    // probe passes. The agent must still answer instead of going silent.
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://gw.test/v1', AI_API_KEY: 'test-key', AI_MODEL: 'AUTO' });
    const asked = [];
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'flash-a' }, { id: 'flash-b' }, { id: 'pro-c' }] }) };
      }
      const body = JSON.parse(options.body);
      asked.push(body.model);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'salam, chetori?' } }] }) };
    };
    const agent = createAgent({ system: 'rules', tools: [] });
    const reply = await agent.say('Hi');
    assert.equal(reply.content, 'salam, chetori?');
    assert.equal(reply.error, null);
    // Probes run first, then the real request — the model is never swapped for a
    // hardcoded name, and the best-ranked catalog entry is used.
    assert.ok(asked.length >= 2);
    assert.equal(asked[0], 'flash-a');
    assert.equal(describeModelConfig().source, 'auto');
  });

  it('advances to the next model when the key is denied for one model', async () => {
    // Sea-lion/OpenRouter style: HTTP 401 key_model_access_denied per model.
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://gw.test/v1', AI_API_KEY: 'test-key', AI_MODEL: 'AUTO' });
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'model-one' }, { id: 'model-two' }] }) };
      const body = JSON.parse(options.body);
      const denied = { ok: false, status: 401, json: async () => ({ error: { message: 'key_model_access_denied' } }), text: async () => 'key_model_access_denied' };
      if (body.model === 'model-one') return denied;
      if (body.tools) return { ok: true, json: async () => ({ choices: [{ message: { content: 'pong' } }] }) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'pong' } }] }) };
    };
    const result = await chat([{ role: 'user', content: 'ping' }], 'openai');
    assert.equal(result.text, 'pong');
    assert.equal(result.model, 'model-two');
  });

  it('fails fast on a rejected key instead of walking every model', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://gw.test/v1', AI_API_KEY: 'bad-key', AI_MODEL: 'AUTO' });
    const realRequests = [];
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }) };
      const body = JSON.parse(options.body);
      // Tier-1 probes ask about the bot status, tier-2 probes say "ping", the
      // real request echoes the user text.
      if (body.messages.at(-1)?.content === 'hi') realRequests.push(body.model);
      return { ok: false, status: 401, json: async () => ({ error: { message: 'invalid api key' } }), text: async () => 'invalid api key' };
    };
    await assert.rejects(() => chat([{ role: 'user', content: 'hi' }], 'openai'), /invalid api key/);
    assert.equal(new Set(realRequests).size, 1, 'the key itself is broken, so no second model is worth trying');
  });

  it('reports an empty catalog instead of guessing a model name', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://gw.test/v1', AI_API_KEY: 'test-key', AI_MODEL: 'AUTO' });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
    await assert.rejects(() => chat([{ role: 'user', content: 'hi' }], 'openai'), /no models came back/);
  });

  it('classifies per-model failures without switching on rate limits', () => {
    assert.equal(isBalanceError(403, 'key_model_access_denied'), true);
    assert.equal(isBalanceError(401, 'key_model_access_denied'), true);
    assert.equal(isBalanceError(402, 'insufficient_quota'), true);
    assert.equal(isBalanceError(429, 'rate limit'), false);
    assert.equal(isAuthError(401, 'invalid api key'), true);
    assert.equal(isAuthError(401, 'key_model_access_denied'), false);
    assert.equal(shouldAdvanceModel(404, 'model_not_found'), true);
    assert.equal(shouldAdvanceModel(429, 'rate limit'), false);
    assert.equal(shouldAdvanceModel(400, 'unsupported model'), true);
    // A 429 is a rate limit, not a balance or access verdict — and it is not a
    // reason to blacklist a model, only to skip it for this resolution.
    assert.equal(isRateLimitError(429, 'rate limit'), true);
    assert.equal(isRateLimitError(429, ''), true);
    assert.equal(isRateLimitError(200, 'Rate limit exceeded'), true);
    assert.equal(isRateLimitError(403, 'key_model_access_denied'), false);
    assert.equal(isRateLimitError(402, 'insufficient_quota'), false);
  });

  it('skips a model this key is rate-limited on and uses the next one', async () => {
    // The reported production failure: the first models in the catalog all answer
    // 429 for this key, so the agent used to pick one and then go silent.
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://gw.test/v1', AI_API_KEY: 'test-key', AI_MODEL: 'AUTO' });
    const asked = [];
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'limited-a' }, { id: 'limited-b' }, { id: 'good-c' }] }) };
      }
      const body = JSON.parse(options.body);
      asked.push(body.model);
      const limited = body.model === 'limited-a' || body.model === 'limited-b';
      if (limited) {
        return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limit exceeded' } }), text: async () => 'rate limit exceeded' };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'pong' } }] }) };
    };
    const result = await chat([{ role: 'user', content: 'ping' }], 'openai');
    assert.equal(result.text, 'pong');
    assert.equal(result.model, 'good-c');
    // The rate-limited models are skipped, not denied: they stay in the catalog
    // so a later re-resolution can try them again.
    const state = describeModelConfig();
    assert.ok(state.rateLimitedModels.includes('limited-a'));
    assert.ok(state.rateLimitedModels.includes('limited-b'));
    assert.equal(state.deniedModels.length, 0);
    assert.ok(!asked.some(model => !['limited-a', 'limited-b', 'good-c'].includes(model)), 'only provider-listed models are ever requested');
  });

  it('does not let a rate-limited model burn every turn', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://gw.test/v1', AI_API_KEY: 'test-key', AI_MODEL: 'AUTO' });
    const realRequests = [];
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'busy-model' }, { id: 'spare-model' }] }) };
      }
      const body = JSON.parse(options.body);
      if (!body.tools) realRequests.push(body.model);
      if (body.model === 'busy-model') {
        return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limit' } }), text: async () => 'rate limit' };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    await chat([{ role: 'user', content: 'hi' }], 'openai');
    // The second turn must go straight to the model that works.
    await chat([{ role: 'user', content: 'hi again' }], 'openai');
    const after = realRequests.slice(realRequests.indexOf('spare-model') + 1);
    assert.ok(after.length >= 1);
    assert.ok(!after.includes('busy-model'), 'the rate-limited model is not retried while the resolution stands');
  });

  it('explains when every listed model is rate-limited', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://gw.test/v1', AI_API_KEY: 'test-key', AI_MODEL: 'AUTO' });
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'only-model' }] }) };
      return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limit exceeded' } }), text: async () => 'rate limit exceeded' };
    };
    await assert.rejects(() => chat([{ role: 'user', content: 'hi' }], 'openai'), /every model the provider listed is unavailable for this key/);
  });

  it('sends a normal reply to a plain chat message', async () => {
    // The exact reported symptom: a plain Persian message must get a reply.
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://gw.test/v1', AI_API_KEY: 'test-key', AI_MODEL: 'AUTO' });
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'chat-model' }] }) };
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'سلام! چطور می‌تونم کمک کنم؟' } }] }) };
    };
    const agent = createAgent({ system: 'rules', tools: [] });
    const reply = await agent.say('سلام');
    assert.match(reply.content, /سلام/);
    assert.doesNotMatch(reply.content, /Hichi bar nagasht/);
    assert.equal(reply.model, 'chat-model');
  });

  it('does not cache a failed catalog read', async () => {
    // A local gateway that refuses once must not leave the agent stuck on an
    // empty catalog until the process restarts.
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:20128/v1', AI_API_KEY: 'k', AI_MODEL: 'AUTO' });
    let down = true;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/models')) {
        if (down) return { ok: false, status: 503, json: async () => ({}), text: async () => 'unavailable' };
        return { ok: true, json: async () => ({ data: [{ id: 'live-model' }] }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'pong' } }] }) };
    };
    await assert.rejects(() => chat([{ role: 'user', content: 'hi' }], 'openai'), /no models came back/);
    // The failure is remembered so /diag can explain it...
    assert.match(describeModelConfig().catalogError, /HTTP 503/);
    // ...but it is not cached, so the very next message recovers on its own.
    down = false;
    const result = await chat([{ role: 'user', content: 'hi' }], 'openai');
    assert.equal(result.text, 'pong');
    assert.equal(result.model, 'live-model');
    assert.equal(describeModelConfig().catalogError, null);
  });

  it('explains an empty catalog instead of saying only "came back empty"', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:20128/v1', AI_API_KEY: 'k', AI_MODEL: 'AUTO' });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [] }), text: async () => '' });
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], 'openai'),
      /no models came back from GET http:\/\/127\.0\.0\.1:20128\/v1\/models/,
    );
  });

  it('keeps the resolved model in memory only, never on disk', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://flaky.test/v1', AI_API_KEY: 'k', AI_MODEL: 'AUTO' });
    let calls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/models')) {
        calls += 1;
        if (calls === 1) return { ok: true, json: async () => ({ data: [{ id: 'good-model' }] }) };
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'pong' } }] }) };
    };
    const first = await chat([{ role: 'user', content: 'hi' }], 'openai');
    assert.equal(first.model, 'good-model');
    // The same process reuses what it resolved — no second catalog read.
    const second = await chat([{ role: 'user', content: 'hi again' }], 'openai');
    assert.equal(second.model, 'good-model');
    assert.equal(calls, 1);
    // A reset means the provider is asked again, not a file on disk.
    resetModelState();
    await assert.rejects(() => chat([{ role: 'user', content: 'again' }], 'openai'), /no models came back/);
  });

  it('ships no model list, ranking, or fallback anywhere in the agent', async () => {
    const files = ['auto-model.js', 'brain.js', 'config.js'];
    for (const name of files) {
      const source = await readFile(new URL(`../src/agent/${name}`, import.meta.url), 'utf8');
      // Hardcoded model ids and family/ranking tables must not exist.
      assert.doesNotMatch(source, /DEFAULT_CANDIDATES|FALLBACK_MODEL|PREFERRED_FAMILIES|NON_CHAT_MARKERS|CHEAP_MARKERS/);
      assert.doesNotMatch(source, /'gpt-[0-9]|'o3'|'claude-|'gemini-|'deepseek-|'llama-|'qwen-/);
      assert.doesNotMatch(source, /model-cache\.json|loadModelCache|saveModelCache|AI_MODEL_CACHE_FILE/);
    }
  });

  it('uses the provider order and never substitutes a model of its own', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://raw.test/v1', AI_API_KEY: 'k', AI_MODEL: 'AUTO' });
    const asked = [];
    // Deliberately unsorted and "unusual" ids: none of them may be reordered,
    // filtered out, or replaced by a name the code knows.
    const catalog = ['zzz-unknown-9', 'aaa-odd-name', 'text-embedding-3-large', 'mmm-third'];
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/models')) return { ok: true, json: async () => ({ data: catalog.map(id => ({ id })) }) };
      asked.push(JSON.parse(options.body).model);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    const result = await chat([{ role: 'user', content: 'hi' }], 'openai');
    assert.equal(result.model, 'zzz-unknown-9', 'the first model the provider reported is used');
    assert.ok(!asked.some(m => !catalog.includes(m)), 'no model outside the provider list is ever requested');
    assert.equal(describeModelConfig().candidateCount, 4);
  });

  it('lists models from an OpenAI-compatible endpoint', async () => {
    Object.assign(CONFIG, { AI_BASE_URL: 'https://example.test/v1', AI_API_KEY: 'test-key' });
    globalThis.fetch = async url => {
      assert.equal(url, 'https://example.test/v1/models');
      return { ok: true, json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }) };
    };
    assert.deepEqual(await listOpenAiModels(), ['model-a', 'model-b']);
    assert.equal(resolveOpenAiModelsUrl('https://example.test/v1'), 'https://example.test/v1/models');
  });

  it('normalizes OpenAI-compatible base URLs', () => {
    assert.equal(resolveOpenAiUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
    assert.equal(resolveOpenAiUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(resolveOpenAiUrl('https://example.test/custom/chat/completions'), 'https://example.test/custom/chat/completions');
  });

  it('auto-selects an available provider', () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'auto', AI_API_KEY: '', ANTHROPIC_API_KEY: 'anthropic-key', GEMINI_API_KEY: '' });
    assert.equal(primaryProviderName(), 'anthropic');
    assert.deepEqual(detectProviders().map(p => p.name), ['anthropic']);
  });

  it('sends system and tool definitions to Anthropic and Gemini', async () => {
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
    };
    Object.assign(CONFIG, { ANTHROPIC_API_KEY: 'anthropic-key', GEMINI_API_KEY: 'gemini-key', ANTHROPIC_MODEL: 'test-anthropic', GEMINI_MODEL: 'test-gemini' });
    const tools = [{ name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }];
    await chat([{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }], 'anthropic', tools);
    await chat([{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }], 'google', tools);
    // Anthropic keeps its native shape.
    assert.equal(bodies[0].system, 'rules');
    assert.equal(bodies[0].tools[0].name, 'probe');
    assert.equal(bodies[0].input_schema, undefined);
    // Google is called over the OpenAI-compatible route, so system is a message.
    assert.equal(bodies[1].messages[0].role, 'system');
    assert.equal(bodies[1].messages[0].content, 'rules');
    assert.equal(bodies[1].tools[0].function.name, 'probe');
  });

  it('executes Anthropic tool calls through the shared loop', async () => {
    let calls = 0;
    let round = 0;
    Object.assign(CONFIG, { AI_PROVIDER: 'anthropic', AI_API_KEY: '', ANTHROPIC_API_KEY: 'anthropic-key', GEMINI_API_KEY: '', ANTHROPIC_MODEL: 'test-anthropic' });
    globalThis.fetch = async () => {
      round += 1;
      return { ok: true, json: async () => round === 1 ? { content: [{ type: 'tool_use', id: 'call-1', name: 'probe', input: { value: 1 } }] } : { content: [{ type: 'text', text: 'done' }] } };
    };
    const agent = createAgent({
      system: 'rules',
      tools: [{ name: 'probe', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }, handler: async () => { calls += 1; return { ok: true }; } }],
      maxRounds: 3,
    });
    const result = await agent.say('run probe');
    assert.equal(calls, 1);
    assert.equal(result.content, 'done');
  });

  it('does not reconnect a socket after close', () => {
    const sockets = [];
    class FakeSocket {
      constructor(url) { this.url = url; this.handlers = {}; sockets.push(this); }
      on(event, handler) { this.handlers[event] = handler; }
      send() {}
      close() { this.handlers.close?.(); }
    }
    const ws = new BitunixWs({}, FakeSocket);
    const socket = ws.connectPublic();
    ws.close();
    socket.handlers.close?.();
    assert.equal(sockets.length, 1);
  });

  it('uses official public and private WebSocket frames', () => {
    const sockets = [];
    class FakeSocket {
      constructor(url) { this.url = url; this.handlers = {}; this.sent = []; sockets.push(this); }
      on(event, handler) { this.handlers[event] = handler; }
      send(value) { this.sent.push(JSON.parse(value)); }
      close() { this.handlers.close?.(); }
    }
    const previous = { key: CONFIG.BITUNIX_API_KEY, secret: CONFIG.BITUNIX_API_SECRET, symbol: CONFIG.symbol };
    CONFIG.BITUNIX_API_KEY = 'ws-key';
    CONFIG.BITUNIX_API_SECRET = 'ws-secret';
    CONFIG.symbol = 'BTCUSDT';
    const ws = new BitunixWs({}, FakeSocket);
    // Bitunix names its kline channels market_kline_<interval> / mark_kline_<interval>
    // (see futures/websocket/public/kline channel) — there is no bare "kline" channel.
    const publicSocket = ws.connectPublic([{ ch: 'market_kline_1min', symbol: 'ETHUSDT' }, 'ticker']);
    publicSocket.handlers.open();
    assert.deepEqual(publicSocket.sent[0], { op: 'subscribe', args: [{ ch: 'market_kline_1min', symbol: 'ETHUSDT' }, { ch: 'ticker', symbol: 'BTCUSDT' }] });
    const privateSocket = ws.connectPrivate(['balance', 'tpsl']);
    privateSocket.handlers.open();
    assert.equal(privateSocket.sent[0].op, 'login');
    const auth = privateSocket.sent[0].args[0];
    assert.equal(typeof auth.timestamp, 'number');
    assert.ok(Math.abs(Date.now() / 1000 - auth.timestamp) < 2);
    assert.equal(auth.sign, wsLoginSignature(auth.nonce, auth.timestamp, 'ws-key', 'ws-secret'));
    assert.deepEqual(privateSocket.sent[1], { op: 'subscribe', args: [{ ch: 'balance' }, { ch: 'tpsl' }] });
    assert.deepEqual(normalizeChannel('trade', true), { ch: 'trade', symbol: 'BTCUSDT' });
    ws.close();
    Object.assign(CONFIG, previous);
  });
});

describe('telegram command routing', () => {
  it('accepts case/alias commands and parses harness JSONL', async () => {
    const telegramRequests = [];
    globalThis.fetch = async (url, options) => {
      telegramRequests.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'model-a' }] }) };
      return { ok: true, json: async () => ({ ok: true }), text: async () => '' };
    };
    Object.assign(CONFIG, {
      ALLOWED_USER_ID: '42',
      TELEGRAM_BOT_TOKEN: 'test-token',
      AI_PROVIDER: 'openai',
      AI_API_KEY: 'test-key',
      AI_BASE_URL: 'https://provider.test/v1',
      AI_MODEL: 'AUTO',
    });
    const messages = [];
    const agent = {
      memory: { all: () => ({}), remember: async () => {} },
      say: async message => { messages.push(message); return { content: `echo:${message}` }; },
    };
    const { handleCommand } = createTraderCommands({ client: {}, scanner: {}, trader: {}, agent });
    const message = { chat: { id: 42 }, from: { id: 42 } };
    assert.equal(await handleCommand(message, '/setModels AUTO'), true);
    assert.equal(CONFIG.AI_MODEL, 'AUTO');
    assert.equal(await handleCommand(message, '/harness {"id":7,"message":"hello"}'), true);
    assert.deepEqual(messages, ['hello']);
    assert.equal(await handleCommand(message, '/skils'), true);
    assert.equal(await handleCommand(message, '/sould'), true);
    assert.equal(await handleCommand(message, '/set order_unit by position size'), true);
    assert.equal(CONFIG.order_unit, 'position_size');
    assert.ok(telegramRequests.some(item => item.url.endsWith('/sendMessage') && String(item.body.text).includes('echo:hello')));
  });

  it('names the real setting when the key is misspelled', async () => {
    Object.assign(CONFIG, { ALLOWED_USER_ID: '42', TELEGRAM_BOT_TOKEN: 'test-token' });
    const sent = [];
    globalThis.fetch = async (url, options) => {
      sent.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, json: async () => ({ ok: true }), text: async () => '' };
    };
    const agent = { memory: { all: () => ({}), remember: async () => {} }, say: async () => ({ content: 'ok' }) };
    const { handleCommand } = createTraderCommands({ client: {}, scanner: {}, trader: {}, agent });
    const message = { chat: { id: 42 }, from: { id: 42 } };

    // "timeframe" is the singular; the setting is "timeframes".
    assert.equal(await handleCommand(message, '/set timeframe 1m,3m,5m,15m'), true);
    assert.deepEqual(CONFIG.timeframes, ['1m', '3m', '5m', '15m']);
    assert.ok(sent.some(item => String(item.body?.text).includes('Set <code>timeframes</code>')));

    // A key with no near match still says what to do instead of just "unknown".
    assert.equal(await handleCommand(message, '/set zzzqqq 1'), true);
    assert.ok(sent.some(item => String(item.body?.text).includes('/settings to see the list')));
  });

  it('tells the truth about a pair Bitunix does not list', async () => {
    Object.assign(CONFIG, { ALLOWED_USER_ID: '42', TELEGRAM_BOT_TOKEN: 'test-token' });
    const sent = [];
    globalThis.fetch = async (url, options) => {
      sent.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, json: async () => ({ ok: true }), text: async () => '' };
    };
    // The real Bitunix list has 762 pairs and no underscore, e.g. RARE_USDT is
    // not one of them, and RARE is not traded at all.
    const client = {
      getTradingPairs: async () => [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }, { symbol: 'RAREISLANDS' }],
      getPendingPositions: async () => [],
    };
    const agent = { memory: { all: () => ({}), remember: async () => {} }, say: async () => ({ content: 'ok' }) };
    const { handleCommand } = createTraderCommands({ client, scanner: {}, trader: {}, agent });
    const message = { chat: { id: 42 }, from: { id: 42 } };

    assert.equal(await handleCommand(message, '/set symbol RARE_USDT'), true);
    assert.equal(CONFIG.symbol, 'BTCUSDT', 'an unlisted pair must not be applied');
    assert.ok(sent.some(item => /RAREUSDT is not traded on Bitunix/.test(String(item.body?.text))), 'the real reason is reported, not a regex complaint');

    // The underscore form of a pair that IS listed is accepted, not rejected.
    assert.equal(await handleCommand(message, '/set symbol BTC_USDT'), true);
    assert.equal(CONFIG.symbol, 'BTCUSDT');
  });
});

describe('telegram formatting', () => {
  it('keeps long HTML messages within safe chunks', () => {
    const chunks = splitHtml(`<b>${'x'.repeat(9000)}</b>`);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 3500);
      assert.equal((chunk.match(/<b>/g) || []).length, (chunk.match(/<\/b>/g) || []).length);
    }
  });
});

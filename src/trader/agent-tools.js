import { CONFIG } from '../config.js';
import { applySettings, getTraderSettings } from './settings.js';

let sharedTrader = null;
let sharedClient = null;
let sharedPositionManager = null;

export function setTraderInstances(trader, client) {
  sharedTrader = trader;
  sharedClient = client;
}

export function setPositionManager(pm) {
  sharedPositionManager = pm;
}

function requireClient() {
  if (!sharedClient) throw new Error('Client not ready');
  return sharedClient;
}

function markCooldown() {
  if (sharedTrader?.state) sharedTrader.state.cooldownUntil = Date.now() + Number(CONFIG.cooldown_minutes) * 60000;
}

export const traderTools = [
  {
    name: 'trader_get_settings',
    description: 'Get non-secret trader settings',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return { settings: getTraderSettings(CONFIG) };
    },
  },
  {
    name: 'trader_set_setting',
    description: 'Update one validated non-safety trader setting',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: ['string', 'number', 'boolean'] },
      },
      required: ['key', 'value'],
    },
    async handler({ key, value }) {
      if (key === 'dry_run' || key === 'auto_trade') throw new Error('safety switches require an authenticated command');
      if (key === 'symbol' && String(value).toUpperCase() !== CONFIG.symbol) {
        const client = requireClient();
        const positions = await client.getPendingPositions(CONFIG.symbol);
        if (!Array.isArray(positions) || positions.length) throw new Error('cannot change symbol while positions are open');
      }
      const settings = applySettings(CONFIG, { [key]: value });
      return { ok: true, key, value: settings[key] };
    },
  },
  {
    name: 'trader_get_positions',
    description: 'Get current open positions',
    parameters: { type: 'object', properties: {} },
    async handler() {
      if (!sharedPositionManager) return { positions: [] };
      const positions = await sharedPositionManager.fetchPositions();
      return { positions };
    },
  },
  {
    name: 'trader_open_position',
    description: 'Manually open a position after explicit live-mode approval',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        qty: { type: 'string' },
        price: { type: 'string' },
      },
      required: ['symbol', 'side', 'qty'],
    },
    async handler({ symbol, side, qty, price }) {
      const client = requireClient();
      const params = {
        symbol: String(symbol).toUpperCase(),
        side,
        qty: String(qty),
        price: price ? String(price) : '',
        orderType: price ? 'LIMIT' : 'MARKET',
        effect: 'GTC',
        tradeSide: 'OPEN',
        reduceOnly: false,
      };
      if (CONFIG.dry_run) {
        markCooldown();
        return { dryRun: true, params };
      }
      const order = await client.placeOrder(params);
      markCooldown();
      if (sharedTrader?.reconcilePositions) await sharedTrader.reconcilePositions();
      return { order };
    },
  },
  {
    name: 'trader_close_position',
    description: 'Close one position by its exact position ID',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        positionId: { type: 'string' },
      },
      required: ['symbol', 'positionId'],
    },
    async handler({ symbol, positionId }) {
      const client = requireClient();
      const normalizedSymbol = String(symbol).toUpperCase();
      if (CONFIG.dry_run) {
        markCooldown();
        return { dryRun: true, symbol: normalizedSymbol, positionId };
      }
      const result = await client.closePosition(normalizedSymbol, positionId);
      markCooldown();
      return { result };
    },
  },
  {
    name: 'trader_close_all',
    description: 'Close every position for one explicitly named symbol',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
    async handler({ symbol }) {
      const client = requireClient();
      const normalizedSymbol = String(symbol).toUpperCase();
      if (CONFIG.dry_run) {
        markCooldown();
        return { dryRun: true, symbol: normalizedSymbol };
      }
      const result = await client.closeAllPosition(normalizedSymbol);
      markCooldown();
      return { result };
    },
  },
  {
    name: 'trader_set_leverage',
    description: 'Change leverage',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, leverage: { type: 'number' } }, required: ['symbol', 'leverage'] },
    async handler({ symbol, leverage }) {
      const client = requireClient();
      const normalizedSymbol = String(symbol).toUpperCase();
      if (CONFIG.dry_run) return { dryRun: true, symbol: normalizedSymbol, leverage };
      const result = await client.changeLeverage(normalizedSymbol, leverage);
      if (normalizedSymbol === CONFIG.symbol) applySettings(CONFIG, { leverage });
      return result;
    },
  },
  {
    name: 'trader_set_margin_mode',
    description: 'Change margin mode',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, marginMode: { type: 'string', enum: ['crossed', 'isolated'] } }, required: ['symbol', 'marginMode'] },
    async handler({ symbol, marginMode }) {
      const client = requireClient();
      const normalizedSymbol = String(symbol).toUpperCase();
      if (CONFIG.dry_run) return { dryRun: true, symbol: normalizedSymbol, marginMode };
      const result = await client.changeMarginMode(normalizedSymbol, marginMode);
      if (normalizedSymbol === CONFIG.symbol) applySettings(CONFIG, { position_type: marginMode });
      return result;
    },
  },
  {
    name: 'trader_set_dry_run',
    description: 'Enable dry-run mode; live mode requires an authenticated Telegram command',
    parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
    async handler({ enabled }) {
      if (!enabled) throw new Error('live mode cannot be enabled through an LLM tool');
      CONFIG.dry_run = true;
      return { ok: true, dry_run: true };
    },
  },
  {
    name: 'trader_set_auto_trade',
    description: 'Disable autonomous trading; enabling requires an authenticated Telegram command',
    parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
    async handler({ enabled }) {
      if (enabled) throw new Error('auto-trade cannot be enabled through an LLM tool');
      CONFIG.auto_trade = false;
      return { ok: true, auto_trade: false };
    },
  },
  {
    name: 'trader_get_balance',
    description: 'Get USDT balance',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return { balance: await requireClient().getAccount('USDT') };
    },
  },
  {
    name: 'trader_get_history',
    description: 'Get order/position history',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
    async handler({ symbol }) {
      const client = requireClient();
      const [orders, positions] = await Promise.all([
        client.getHistoryOrders(symbol || CONFIG.symbol),
        client.getHistoryPositions(symbol || CONFIG.symbol),
      ]);
      return { orders, positions };
    },
  },
];

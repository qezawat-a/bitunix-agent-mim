import { BitunixClient } from '../bitunix/client.js';
import { Trader } from './trader.js';
import { PositionManager } from './position-manager.js';
import { CONFIG } from '../config.js';

let sharedTrader = null;
let sharedClient = null;

export function setTraderInstances(trader, client) {
  sharedTrader = trader;
  sharedClient = client;
}

export const traderTools = [
  {
    name: 'trader_get_settings',
    description: 'Get all trader settings',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return { settings: CONFIG };
    },
  },
  {
    name: 'trader_set_setting',
    description: 'Update a trader setting',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: ['string', 'number', 'boolean'] },
      },
      required: ['key', 'value'],
    },
    async handler({ key, value }) {
      CONFIG[key] = value;
      return { ok: true, key, value };
    },
  },
  {
    name: 'trader_get_positions',
    description: 'Get current open positions',
    parameters: { type: 'object', properties: {} },
    async handler() {
      if (!sharedPositionManager) return { positions: [] };
      await sharedPositionManager.fetchPositions();
      return { positions: sharedPositionManager.state.positions };
    },
  },
  {
    name: 'trader_open_position',
    description: 'Manually open a position',
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
      if (!sharedClient) throw new Error('Client not ready');
      const order = await sharedClient.placeOrder({ symbol, side, qty, price: price || '', orderType: price ? 'LIMIT' : 'MARKET', effect: 'GTC', tradeSide: 'OPEN', reduceOnly: false });
      return { order };
    },
  },
  {
    name: 'trader_close_position',
    description: 'Close a specific position',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        positionId: { type: 'string' },
      },
      required: ['symbol', 'positionId'],
    },
    async handler({ symbol, positionId }) {
      if (!sharedClient) throw new Error('Client not ready');
      const res = await sharedClient.closeAllPosition(symbol);
      return { res };
    },
  },
  {
    name: 'trader_close_all',
    description: 'Close all positions for symbol',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
    async handler({ symbol }) {
      if (!sharedClient) throw new Error('Client not ready');
      const res = await sharedClient.closeAllPosition(symbol);
      return { res };
    },
  },
  {
    name: 'trader_set_leverage',
    description: 'Change leverage',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, leverage: { type: 'number' } }, required: ['symbol', 'leverage'] },
    async handler({ symbol, leverage }) {
      if (!sharedClient) throw new Error('Client not ready');
      return sharedClient.changeLeverage(symbol, leverage);
    },
  },
  {
    name: 'trader_set_margin_mode',
    description: 'Change margin mode',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, marginMode: { type: 'string', enum: ['crossed', 'isolated'] } }, required: ['symbol', 'marginMode'] },
    async handler({ symbol, marginMode }) {
      if (!sharedClient) throw new Error('Client not ready');
      return sharedClient.changeMarginMode(symbol, marginMode);
    },
  },
  {
    name: 'trader_set_dry_run',
    description: 'Toggle dry run mode',
    parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
    async handler({ enabled }) {
      CONFIG.dry_run = enabled;
      return { ok: true, dry_run: enabled };
    },
  },
  {
    name: 'trader_set_auto_trade',
    description: 'Toggle auto trade',
    parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
    async handler({ enabled }) {
      CONFIG.auto_trade = enabled;
      return { ok: true, auto_trade: enabled };
    },
  },
  {
    name: 'trader_get_balance',
    description: 'Get USDT balance',
    parameters: { type: 'object', properties: {} },
    async handler() {
      if (!sharedClient) throw new Error('Client not ready');
      const acc = await sharedClient.getAccount('USDT');
      return { balance: acc };
    },
  },
  {
    name: 'trader_get_history',
    description: 'Get order/position history',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      if (!sharedClient) throw new Error('Client not ready');
      const [orders, positions] = await Promise.all([
        sharedClient.getHistoryOrders(symbol || CONFIG.symbol),
        sharedClient.getHistoryPositions(symbol || CONFIG.symbol),
      ]);
      return { orders, positions };
    },
  },
];

let sharedPositionManager = null;
export function setPositionManager(pm) { sharedPositionManager = pm; }
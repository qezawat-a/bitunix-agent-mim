import { BitunixClient } from './client.js';
import { CONFIG } from '../config.js';

let sharedClient = null;

export function setBitunixClient(c) { sharedClient = c; }

export const bitunixTools = [
  {
    name: 'bitunix_get_tickers',
    description: 'Get current tickers',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return sharedClient.getTickers(symbol || CONFIG.symbol);
    },
  },
  {
    name: 'bitunix_get_kline',
    description: 'Get kline data',
    parameters: {
      type: 'object',
      properties: { symbol: { type: 'string' }, interval: { type: 'string' }, limit: { type: 'number' } },
      required: ['symbol'],
    },
    async handler({ symbol, interval = '15m', limit = 200 }) {
      return sharedClient.getKlines(symbol, interval, limit);
    },
  },
  {
    name: 'bitunix_get_depth',
    description: 'Get order book depth',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
    async handler({ symbol }) {
      return sharedClient.getDepth(symbol);
    },
  },
  {
    name: 'bitunix_get_account',
    description: 'Get account info',
    parameters: { type: 'object', properties: { marginCoin: { type: 'string' } } },
    async handler({ marginCoin = 'USDT' }) {
      return sharedClient.getAccount(marginCoin);
    },
  },
  {
    name: 'bitunix_get_funding_rate',
    description: 'Get funding rate',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol = CONFIG.symbol }) {
      return sharedClient.getFundingRate(symbol);
    },
  },
  {
    name: 'bitunix_get_pending_positions',
    description: 'Get pending positions',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return sharedClient.getPendingPositions(symbol);
    },
  },
  {
    name: 'bitunix_get_history_positions',
    description: 'Get history positions',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return sharedClient.getHistoryPositions(symbol);
    },
  },
  {
    name: 'bitunix_place_order',
    description: 'Place a manual order (dry-run aware)',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        qty: { type: 'string' },
        price: { type: 'string' },
        orderType: { type: 'string', enum: ['LIMIT', 'MARKET'] },
        tradeSide: { type: 'string' },
        reduceOnly: { type: 'boolean' },
      },
      required: ['symbol', 'side', 'qty'],
    },
    async handler(params) {
      if (CONFIG.dry_run) return { dry_run: true, params };
      return sharedClient.placeOrder(params);
    },
  },
  {
    name: 'bitunix_place_tpsl',
    description: 'Place TP/SL order',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, positionId: { type: 'string' }, tpPrice: { type: 'string' }, slPrice: { type: 'string' } } },
    async handler(params) {
      if (CONFIG.dry_run) return { dry_run: true, params };
      return sharedClient.placeTPSL(params);
    },
  },
  {
    name: 'bitunix_cancel_tpsl',
    description: 'Cancel TP/SL order',
    parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
    async handler({ orderId }) {
      if (CONFIG.dry_run) return { dry_run: true, orderId };
      return sharedClient.cancelTPSL(orderId);
    },
  },
  {
    name: 'bitunix_get_pending_tpsl',
    description: 'Get pending TP/SL orders',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return sharedClient.getPendingTPSL(symbol);
    },
  },
  {
    name: 'bitunix_get_history_tpsl',
    description: 'Get history TP/SL orders',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return sharedClient.getHistoryTPSL(symbol);
    },
  },
  {
    name: 'bitunix_change_leverage',
    description: 'Change leverage',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, leverage: { type: 'number' } }, required: ['symbol', 'leverage'] },
    async handler({ symbol, leverage }) {
      return sharedClient.changeLeverage(symbol, leverage);
    },
  },
  {
    name: 'bitunix_change_margin_mode',
    description: 'Change margin mode (crossed/isolated)',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, marginMode: { type: 'string' } }, required: ['symbol', 'marginMode'] },
    async handler({ symbol, marginMode }) {
      return sharedClient.changeMarginMode(symbol, marginMode);
    },
  },
  {
    name: 'bitunix_change_position_mode',
    description: 'Change position mode (ONE_WAY/HEDGE)',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, positionMode: { type: 'string' } }, required: ['symbol', 'positionMode'] },
    async handler({ symbol, positionMode }) {
      return sharedClient.changePositionMode(symbol, positionMode);
    },
  },
  {
    name: 'bitunix_adjust_position_margin',
    description: 'Adjust position margin',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, margin: { type: 'string' } }, required: ['symbol', 'margin'] },
    async handler({ symbol, margin }) {
      return sharedClient.adjustPositionMargin(symbol, margin);
    },
  },
  {
    name: 'bitunix_get_trading_pairs',
    description: 'Get trading pairs list',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return sharedClient.getTradingPairs();
    },
  },
  {
    name: 'bitunix_get_error_code',
    description: 'Get error code info',
    parameters: { type: 'object', properties: { code: { type: 'string' } } },
    async handler({ code }) {
      return sharedClient.getErrorCode(code);
    },
  },
  {
    name: 'bitunix_get_leverage_and_margin_mode',
    description: 'Get leverage and margin mode',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return sharedClient.getLeverageAndMarginMode(symbol);
    },
  },
  {
    name: 'bitunix_get_trades',
    description: 'Get recent trades',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return sharedClient.getHistoryTrades(symbol);
    },
  },
  {
    name: 'bitunix_flash_close',
    description: 'Flash close position',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
    async handler({ symbol }) {
      if (CONFIG.dry_run) return { dry_run: true, symbol };
      return sharedClient.flashClosePosition(symbol);
    },
  },
];

export default bitunixTools;
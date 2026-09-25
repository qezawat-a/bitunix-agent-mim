import { CONFIG } from '../config.js';

let sharedClient = null;

export function setBitunixClient(client) {
  sharedClient = client;
}

function requireClient() {
  if (!sharedClient) throw new Error('Client not ready');
  return sharedClient;
}

function dryRun(value) {
  return Boolean(CONFIG.dry_run) ? { dry_run: true, ...value } : null;
}

const string = { type: 'string' };
const number = { type: 'number' };
const object = { type: 'object' };

export const bitunixTools = [
  {
    name: 'bitunix_get_tickers',
    description: 'Get current futures tickers; use a comma-separated symbols list or omit it for all symbols',
    parameters: { type: 'object', properties: { symbols: string, symbol: string } },
    async handler({ symbols, symbol } = {}) {
      return requireClient().getTickers(symbols ?? symbol ?? CONFIG.symbol);
    },
  },
  {
    name: 'bitunix_get_kline',
    description: 'Get futures candlestick data',
    parameters: {
      type: 'object',
      properties: { symbol: string, interval: string, limit: number, startTime: number, endTime: number, type: string },
      required: ['symbol'],
    },
    async handler({ symbol, interval = '15m', limit = 200, startTime = 0, endTime = 0, type = 'LAST_PRICE' } = {}) {
      return requireClient().getKlines(symbol, interval, limit, startTime, endTime, type);
    },
  },
  {
    name: 'bitunix_get_depth',
    description: 'Get futures order-book depth',
    parameters: { type: 'object', properties: { symbol: string, limit: { type: ['string', 'number'] } }, required: ['symbol'] },
    async handler({ symbol, limit } = {}) {
      return requireClient().getDepth(symbol, limit);
    },
  },
  {
    name: 'bitunix_get_account',
    description: 'Get the account for one settlement coin',
    parameters: { type: 'object', properties: { marginCoin: string } },
    async handler({ marginCoin = 'USDT' } = {}) {
      return requireClient().getAccount(marginCoin);
    },
  },
  {
    name: 'bitunix_get_funding_rate',
    description: 'Get the current funding rate for a contract',
    parameters: { type: 'object', properties: { symbol: string } },
    async handler({ symbol = CONFIG.symbol } = {}) {
      return requireClient().getFundingRate(symbol);
    },
  },
  {
    name: 'bitunix_get_funding_rate_batch',
    description: 'Get current funding rates for all futures contracts',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return requireClient().getFundingRateBatch();
    },
  },
  {
    name: 'bitunix_get_funding_rate_history',
    description: 'Get historical funding rates',
    parameters: { type: 'object', properties: { symbol: string, startTime: number, endTime: number, limit: number }, required: ['symbol'] },
    async handler({ symbol, startTime, endTime, limit } = {}) {
      return requireClient().getFundingRateHistory(symbol, { startTime, endTime, limit });
    },
  },
  {
    name: 'bitunix_get_pending_positions',
    description: 'Get current positions with optional documented filters',
    parameters: { type: 'object', properties: { symbol: string, positionId: string, subAccountId: number, includeSubAccounts: { type: 'boolean' } } },
    async handler(params = {}) {
      return requireClient().getPendingPositions(params);
    },
  },
  {
    name: 'bitunix_get_history_positions',
    description: 'Get historical positions with optional pagination filters',
    parameters: { type: 'object', properties: { symbol: string, positionId: string, startTime: number, endTime: number, skip: number, limit: number, subAccountId: number } },
    async handler(params = {}) {
      return requireClient().getHistoryPositions(params);
    },
  },
  {
    name: 'bitunix_get_position_tiers',
    description: 'Get position leverage tiers for a contract',
    parameters: { type: 'object', properties: { symbol: string }, required: ['symbol'] },
    async handler({ symbol } = {}) {
      return requireClient().getPositionTiers(symbol);
    },
  },
  {
    name: 'bitunix_place_order',
    description: 'Place one manual futures order (dry-run aware)',
    parameters: {
      type: 'object',
      properties: {
        symbol: string,
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        qty: string,
        price: string,
        orderType: { type: 'string', enum: ['LIMIT', 'MARKET'] },
        tradeSide: { type: 'string', enum: ['OPEN', 'CLOSE'] },
        positionId: string,
        effect: { type: 'string', enum: ['IOC', 'FOK', 'GTC', 'POST_ONLY'] },
        reduceOnly: { type: 'boolean' },
        clientId: string,
        tpPrice: string,
        tpStopType: { type: 'string', enum: ['MARK_PRICE', 'LAST_PRICE'] },
        tpOrderType: { type: 'string', enum: ['LIMIT', 'MARKET'] },
        tpOrderPrice: string,
        slPrice: string,
        slStopType: { type: 'string', enum: ['MARK_PRICE', 'LAST_PRICE'] },
        slOrderType: { type: 'string', enum: ['LIMIT', 'MARKET'] },
        slOrderPrice: string,
      },
      required: ['symbol', 'side', 'qty', 'tradeSide', 'orderType'],
    },
    async handler(params) {
      return dryRun({ params }) || requireClient().placeOrder(params);
    },
  },
  {
    name: 'bitunix_batch_order',
    description: 'Place up to five orders in one documented batch request (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string, orderList: { type: 'array', items: object } }, required: ['symbol', 'orderList'] },
    async handler({ symbol, orderList }) {
      return dryRun({ symbol, orderList }) || requireClient().batchOrder(symbol, orderList);
    },
  },
  {
    name: 'bitunix_modify_order',
    description: 'Modify a pending order (dry-run aware)',
    parameters: { type: 'object', properties: { orderId: string, clientId: string, qty: string, price: string, tpPrice: string, tpStopType: string, tpOrderType: string, tpOrderPrice: string, slPrice: string, slStopType: string, slOrderType: string, slOrderPrice: string }, required: ['qty'] },
    async handler(params) {
      return dryRun({ params }) || requireClient().modifyOrder(params);
    },
  },
  {
    name: 'bitunix_cancel_orders',
    description: 'Cancel one or more pending orders (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string, orderList: { type: 'array', items: object } }, required: ['symbol', 'orderList'] },
    async handler({ symbol, orderList }) {
      return dryRun({ symbol, orderList }) || requireClient().cancelOrders(symbol, orderList);
    },
  },
  {
    name: 'bitunix_cancel_order',
    description: 'Cancel one pending order by order ID (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string, orderId: string }, required: ['symbol', 'orderId'] },
    async handler({ symbol, orderId }) {
      return dryRun({ symbol, orderId }) || requireClient().cancelOrder(symbol, orderId);
    },
  },
  {
    name: 'bitunix_cancel_all_orders',
    description: 'Cancel all pending orders, optionally for one symbol (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string } },
    async handler({ symbol } = {}) {
      return dryRun({ symbol }) || requireClient().cancelAllOrders(symbol);
    },
  },
  {
    name: 'bitunix_close_position',
    description: 'Close one exact position with a reduce-only market order (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string, positionId: string }, required: ['symbol', 'positionId'] },
    async handler({ symbol, positionId }) {
      return dryRun({ symbol, positionId }) || requireClient().closePosition(String(symbol).toUpperCase(), positionId);
    },
  },
  {
    name: 'bitunix_close_all_positions',
    description: 'Close all positions for an explicitly supplied symbol (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string }, required: ['symbol'] },
    async handler({ symbol } = {}) {
      return dryRun({ symbol }) || requireClient().closeAllPosition(symbol);
    },
  },
  {
    name: 'bitunix_flash_close',
    description: 'Flash close one exact position ID (dry-run aware)',
    parameters: { type: 'object', properties: { positionId: string }, required: ['positionId'] },
    async handler({ positionId }) {
      return dryRun({ positionId }) || requireClient().flashClosePosition(positionId);
    },
  },
  {
    name: 'bitunix_get_pending_orders',
    description: 'Get pending orders with optional documented filters',
    parameters: { type: 'object', properties: { symbol: string, orderId: string, clientId: string, status: string, startTime: number, endTime: number, skip: number, limit: number } },
    async handler(params = {}) {
      return requireClient().getPendingOrders(params);
    },
  },
  {
    name: 'bitunix_get_order_detail',
    description: 'Get one order by order ID or client ID',
    parameters: { type: 'object', properties: { orderId: string, clientId: string } },
    async handler(params = {}) {
      return requireClient().getOrderDetail(params);
    },
  },
  {
    name: 'bitunix_get_history_orders',
    description: 'Get historical orders with optional documented filters',
    parameters: { type: 'object', properties: { symbol: string, orderId: string, clientId: string, status: string, type: string, startTime: number, endTime: number, skip: number, limit: number, subAccountId: number, queryCanceled: { type: 'boolean' } } },
    async handler(params = {}) {
      return requireClient().getHistoryOrders(params);
    },
  },
  {
    name: 'bitunix_get_history_trades',
    description: 'Get historical fills/trades',
    parameters: { type: 'object', properties: { symbol: string, orderId: string, positionId: string, startTime: number, endTime: number, skip: number, limit: number } },
    async handler(params = {}) {
      return requireClient().getHistoryTrades(params);
    },
  },
  {
    name: 'bitunix_get_trades',
    description: 'Compatibility alias for historical trades',
    parameters: { type: 'object', properties: { symbol: string } },
    async handler({ symbol } = {}) {
      return requireClient().getHistoryTrades(symbol);
    },
  },
  {
    name: 'bitunix_place_tpsl',
    description: 'Place a position-linked TP/SL order (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string, positionId: string, tpPrice: string, tpStopType: string, slPrice: string, slStopType: string }, required: ['symbol', 'positionId'] },
    async handler(params) {
      return dryRun({ params }) || requireClient().placeTPSL(params);
    },
  },
  {
    name: 'bitunix_place_tpsl_order',
    description: 'Place a standalone TP/SL order (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string, positionId: string, tpPrice: string, tpStopType: string, tpOrderType: string, tpOrderPrice: string, tpQty: string, slPrice: string, slStopType: string, slOrderType: string, slOrderPrice: string, slQty: string }, required: ['symbol', 'positionId'] },
    async handler(params) {
      return dryRun({ params }) || requireClient().placeTPSLOrder(params);
    },
  },
  {
    name: 'bitunix_modify_tpsl',
    description: 'Modify a position-linked TP/SL order (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string, positionId: string, tpPrice: string, tpStopType: string, slPrice: string, slStopType: string }, required: ['symbol', 'positionId'] },
    async handler(params) {
      return dryRun({ params }) || requireClient().modifyTPSL(params);
    },
  },
  {
    name: 'bitunix_modify_tpsl_order',
    description: 'Modify a standalone TP/SL order (dry-run aware)',
    parameters: { type: 'object', properties: { orderId: string, tpPrice: string, tpStopType: string, tpOrderType: string, tpOrderPrice: string, tpQty: string, slPrice: string, slStopType: string, slOrderType: string, slOrderPrice: string, slQty: string }, required: ['orderId'] },
    async handler(params) {
      return dryRun({ params }) || requireClient().modifyTPSLOrder(params);
    },
  },
  {
    name: 'bitunix_cancel_tpsl',
    description: 'Cancel one TP/SL order (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string, orderId: string }, required: ['symbol', 'orderId'] },
    async handler({ symbol, orderId }) {
      return dryRun({ symbol, orderId }) || requireClient().cancelTPSL(symbol, orderId);
    },
  },
  {
    name: 'bitunix_get_pending_tpsl',
    description: 'Get pending TP/SL orders',
    parameters: { type: 'object', properties: { symbol: string, positionId: string, side: number, positionMode: number, skip: number, limit: number } },
    async handler(params = {}) {
      return requireClient().getPendingTPSL(params);
    },
  },
  {
    name: 'bitunix_get_history_tpsl',
    description: 'Get historical TP/SL orders',
    parameters: { type: 'object', properties: { symbol: string, side: number, positionMode: number, startTime: number, endTime: number, skip: number, limit: number } },
    async handler(params = {}) {
      return requireClient().getHistoryTPSL(params);
    },
  },
  {
    name: 'bitunix_change_leverage',
    description: 'Change leverage (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string, leverage: number, marginCoin: string }, required: ['symbol', 'leverage'] },
    async handler({ symbol, leverage, marginCoin }) {
      return dryRun({ symbol, leverage, marginCoin }) || requireClient().changeLeverage(symbol, leverage, marginCoin);
    },
  },
  {
    name: 'bitunix_change_margin_mode',
    description: 'Change crossed/isolated margin mode (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string, marginMode: string, marginCoin: string }, required: ['symbol', 'marginMode'] },
    async handler({ symbol, marginMode, marginCoin }) {
      return dryRun({ symbol, marginMode, marginCoin }) || requireClient().changeMarginMode(symbol, marginMode, marginCoin);
    },
  },
  {
    name: 'bitunix_change_position_mode',
    description: 'Change one-way/hedge position mode (dry-run aware)',
    parameters: { type: 'object', properties: { positionMode: string }, required: ['positionMode'] },
    async handler({ positionMode }) {
      return dryRun({ positionMode }) || requireClient().changePositionMode(positionMode);
    },
  },
  {
    name: 'bitunix_adjust_position_margin',
    description: 'Add or reduce isolated position margin (dry-run aware)',
    parameters: { type: 'object', properties: { symbol: string, amount: string, marginCoin: string, side: string, positionId: string }, required: ['symbol', 'amount'] },
    async handler({ symbol, amount, marginCoin, side, positionId }) {
      return dryRun({ symbol, amount, marginCoin, side, positionId }) || requireClient().adjustPositionMargin(symbol, amount, { marginCoin, side, positionId });
    },
  },
  {
    name: 'bitunix_get_position_mode',
    description: 'Get the account position mode',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return requireClient().getPositionMode();
    },
  },
  {
    name: 'bitunix_get_leverage_and_margin_mode',
    description: 'Get leverage and margin mode for a symbol',
    parameters: { type: 'object', properties: { symbol: string, marginCoin: string }, required: ['symbol'] },
    async handler({ symbol, marginCoin } = {}) {
      return requireClient().getLeverageAndMarginMode(symbol, marginCoin);
    },
  },
  {
    name: 'bitunix_get_trading_settings',
    description: 'Get account trading settings, optionally for up to 50 symbols',
    parameters: { type: 'object', properties: { symbols: string } },
    async handler({ symbols } = {}) {
      return requireClient().getTradingSettings(symbols);
    },
  },
  {
    name: 'bitunix_get_trading_pairs',
    description: 'Get futures trading-pair configuration',
    parameters: { type: 'object', properties: { symbols: string } },
    async handler({ symbols } = {}) {
      return requireClient().getTradingPairs(symbols);
    },
  },
  {
    name: 'bitunix_get_asset_query',
    description: 'Get copy-trading asset information',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return requireClient().getAssetQuery();
    },
  },
  {
    name: 'bitunix_transfer_asset_from_main_account_to_sub_account',
    description: 'Transfer copy-trading assets from the main account to a sub-account (dry-run aware)',
    parameters: { type: 'object', properties: { amount: string, assetType: { type: 'string', enum: ['SPOT', 'FUTURES'] } }, required: ['amount', 'assetType'] },
    async handler(params) {
      return dryRun({ params }) || requireClient().transferAssetFromMainAccountToSubAccount(params);
    },
  },
  {
    name: 'bitunix_transfer_asset_from_subaccount_to_main_account',
    description: 'Transfer copy-trading assets from a sub-account to the main account (dry-run aware)',
    parameters: { type: 'object', properties: { amount: string, assetType: { type: 'string', enum: ['SPOT', 'FUTURES'] } }, required: ['amount', 'assetType'] },
    async handler(params) {
      return dryRun({ params }) || requireClient().transferAssetFromSubaccountToMainAccount(params);
    },
  },
  {
    name: 'bitunix_get_error_code',
    description: 'Get a link and hint for a Bitunix error code',
    parameters: { type: 'object', properties: { code: string } },
    async handler({ code } = {}) {
      return requireClient().getErrorCode(code);
    },
  },
];

export default bitunixTools;

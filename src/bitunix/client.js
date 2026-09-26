import crypto from 'crypto';
import { CONFIG } from '../config.js';

function positiveNumber(value) {
  if (value === '' || value === null || value === undefined) return false;
  try {
    const number = Number(value);
    return Number.isFinite(number) && number > 0;
  } catch {
    return false;
  }
}

function nonEmpty(value) {
  return value !== '' && value !== null && value !== undefined;
}

function nonZeroNumber(value) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number !== 0;
  } catch {
    return false;
  }
}

function compactBody(body) {
  if (body === null || body === undefined) return '';
  return JSON.stringify(body).replace(/\s/g, '');
}

function queryValue(value) {
  if (Array.isArray(value)) {
    const joined = value.join(',');
    return joined || undefined;
  }
  if (value && typeof value === 'object') return undefined;
  return nonEmpty(value) ? String(value) : undefined;
}

function cleanParams(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, queryValue(value)]).filter(([, value]) => value !== undefined));
}

function listFromData(data, keys = []) {
  if (Array.isArray(data)) return data;
  for (const key of [...keys, 'positionList', 'orderList', 'tradeList']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function strictListFromData(data, keys = []) {
  if (Array.isArray(data)) return data;
  for (const key of [...keys, 'positionList', 'orderList', 'tradeList']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return null;
}

function normalizeStopType(value) {
  const normalized = String(value || '').toUpperCase();
  if (normalized === 'MARK') return 'MARK_PRICE';
  if (normalized === 'LAST') return 'LAST_PRICE';
  return normalized;
}

function normalizeOrder(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const order = { ...params };
  for (const key of ['tpStopType', 'slStopType']) {
    if (order[key]) order[key] = normalizeStopType(order[key]);
  }
  return order;
}

function validateAssetTransfer(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('asset transfer parameters must be an object');
  if (!positiveNumber(params.amount)) throw new Error('asset transfer amount must be positive');
  if (!['SPOT', 'FUTURES'].includes(String(params.assetType || '').toUpperCase())) throw new Error('assetType must be SPOT or FUTURES');
  return { ...params, amount: String(params.amount), assetType: String(params.assetType).toUpperCase() };
}

function validateOrder(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('order parameters must be an object');
  if (typeof params.symbol !== 'string' || !/^[A-Z0-9]{5,32}$/.test(params.symbol)) throw new Error('invalid order symbol');
  if (!['BUY', 'SELL'].includes(params.side)) throw new Error('order side must be BUY or SELL');
  if (!positiveNumber(params.qty)) throw new Error('order qty must be positive');
  const orderType = params.orderType || 'MARKET';
  if (!['LIMIT', 'MARKET'].includes(orderType)) throw new Error('orderType must be LIMIT or MARKET');
  if (orderType === 'LIMIT' && !positiveNumber(params.price)) throw new Error('LIMIT order price must be positive');
  if (!['OPEN', 'CLOSE'].includes(params.tradeSide)) throw new Error('tradeSide must be OPEN or CLOSE');
  if (params.tradeSide === 'CLOSE') requirePositionId(params.positionId);
  if (params.effect && !['IOC', 'FOK', 'GTC', 'POST_ONLY'].includes(params.effect)) throw new Error('invalid order effect');
  for (const key of ['tpStopType', 'slStopType']) {
    if (params[key] && !['MARK_PRICE', 'LAST_PRICE'].includes(normalizeStopType(params[key]))) throw new Error(`invalid ${key}`);
  }
  for (const key of ['tpOrderType', 'slOrderType']) {
    if (params[key] && !['LIMIT', 'MARKET'].includes(params[key])) throw new Error(`invalid ${key}`);
  }
  if (params.tpOrderType === 'LIMIT' && !positiveNumber(params.tpOrderPrice)) throw new Error('tpOrderPrice is required for LIMIT take-profit orders');
  if (params.slOrderType === 'LIMIT' && !positiveNumber(params.slOrderPrice)) throw new Error('slOrderPrice is required for LIMIT stop-loss orders');
}

function normalizeOptions(value, symbol = '') {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  return symbol ? { symbol } : {};
}

function requirePositionId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('positionId is required');
  const id = String(value).trim();
  if (!id || id === 'undefined' || id === 'null') throw new Error('positionId is required');
  return id;
}

export function canonicalQuery(queryParams = {}) {
  const clean = cleanParams(queryParams);
  return Object.keys(clean).sort().map(key => `${key}${clean[key]}`).join('');
}

export class BitunixClient {
  baseURL = String(CONFIG.BITUNIX_BASE_URL || '').replace(/\/+$/, '');
  apiKey = CONFIG.BITUNIX_API_KEY;
  secretKey = CONFIG.BITUNIX_API_SECRET;

  static sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

  makeSign(path, body, queryParams = {}) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now().toString();
    const digestInput = `${nonce}${timestamp}${this.apiKey}${canonicalQuery(queryParams)}${compactBody(body)}`;
    const digest = BitunixClient.sha256(digestInput);
    const sign = BitunixClient.sha256(digest + this.secretKey);
    return { 'api-key': this.apiKey, nonce, timestamp, sign };
  }

  async request(method, path, body = null, queryParams = {}, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'language': 'en-US',
    };
    const signedBody = method === 'GET' ? null : body;
    if (this.apiKey && this.secretKey) Object.assign(headers, this.makeSign(path, signedBody, queryParams));
    const params = cleanParams(queryParams);
    const query = new URLSearchParams(params).toString();
    const url = `${this.baseURL}${path}${query ? `?${query}` : ''}`;
    const bodyText = compactBody(signedBody);
    const timeoutMs = options.timeoutMs ?? 15000;
    const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyText || undefined,
        signal,
      });
    } catch (error) {
      if (method !== 'GET') error.executionUnknown = true;
      throw error;
    }
    if (!res.ok) {
      const txt = await res.text();
      const error = new Error(`Bitunix ${method} ${path} ${res.status}: ${txt}`);
      if (method !== 'GET') error.executionUnknown = true;
      throw error;
    }
    let payload;
    try {
      payload = await res.json();
    } catch (error) {
      if (method !== 'GET') error.executionUnknown = true;
      throw error;
    }
    if (payload && Object.hasOwn(payload, 'code') && Number(payload.code) !== 0) {
      throw new Error(`Bitunix ${method} ${path} rejected: ${payload.code} ${payload.msg || ''}`.trim());
    }
    if (payload?.data === null || payload?.data === undefined) {
      throw new Error(`Bitunix ${method} ${path} returned no data`);
    }
    return payload.data;
  }

  async getAccount(marginCoin = 'USDT') {
    const requestedCoin = String(marginCoin || 'USDT').toUpperCase();
    const data = await this.request('GET', '/api/v1/futures/account', null, { marginCoin: requestedCoin });
    if (Array.isArray(data)) {
      const account = data.find(item => String(item?.marginCoin || '').toUpperCase() === requestedCoin);
      if (!account) throw new Error(`Bitunix account ${requestedCoin} not found`);
      return account;
    }
    if (!data || String(data.marginCoin || '').toUpperCase() !== requestedCoin) throw new Error(`Bitunix account ${requestedCoin} not found`);
    return data;
  }

  async getTradingSettings(symbols = '') {
    const list = Array.isArray(symbols) ? symbols : symbols ? String(symbols).split(',') : [];
    if (list.length > 50) throw new Error('trading settings support at most 50 symbols');
    const query = list.length ? { symbols: list.join(',') } : {};
    return this.request('GET', '/api/v1/futures/account/trading_settings', null, query);
  }

  async getKlines(symbol, interval = '15m', limit = 200, startTime = 0, endTime = 0, type = 'LAST_PRICE') {
    const query = { symbol, interval, limit, type };
    if (positiveNumber(startTime)) query.startTime = startTime;
    if (positiveNumber(endTime)) query.endTime = endTime;
    return this.request('GET', '/api/v1/futures/market/kline', null, query);
  }

  async getTickers(symbols = '') {
    const query = symbols ? { symbols: Array.isArray(symbols) ? symbols.join(',') : symbols } : {};
    return this.request('GET', '/api/v1/futures/market/tickers', null, query);
  }

  async getDepth(symbol, limit = '') {
    const query = { symbol };
    if (nonEmpty(limit)) query.limit = limit;
    return this.request('GET', '/api/v1/futures/market/depth', null, query);
  }

  async getFundingRate(symbol) {
    return this.request('GET', '/api/v1/futures/market/funding_rate', null, { symbol });
  }

  async getFundingRateBatch() {
    return this.request('GET', '/api/v1/futures/market/funding_rate/batch', null, {});
  }

  async getFundingRateHistory(symbol, { startTime = '', endTime = '', limit = '' } = {}) {
    const query = { symbol };
    if (nonEmpty(startTime)) query.startTime = startTime;
    if (nonEmpty(endTime)) query.endTime = endTime;
    if (nonEmpty(limit)) query.limit = limit;
    return this.request('GET', '/api/v1/futures/market/get_funding_rate_history', null, query);
  }

  async getTradingPairs(symbols = '') {
    const query = symbols ? { symbols: Array.isArray(symbols) ? symbols.join(',') : symbols } : {};
    return this.request('GET', '/api/v1/futures/market/trading_pairs', null, query);
  }

  async placeOrder(params) {
    const order = normalizeOrder(params);
    validateOrder(order);
    return this.request('POST', '/api/v1/futures/trade/place_order', order, {});
  }

  async batchOrder(symbol, orderList) {
    if (typeof symbol !== 'string' || !/^[A-Z0-9]{5,32}$/.test(symbol)) throw new Error('invalid order symbol');
    if (!Array.isArray(orderList) || orderList.length < 1 || orderList.length > 5) throw new Error('orderList must contain 1-5 orders');
    const normalized = orderList.map(order => {
      if (!order || typeof order !== 'object' || Array.isArray(order)) throw new Error('each order must be an object');
      return normalizeOrder({ ...order, symbol, tradeSide: order.tradeSide || 'OPEN' });
    });
    for (const order of normalized) validateOrder(order);
    const payloadOrderList = normalized.map(({ symbol: _outerSymbol, ...order }) => order);
    return this.request('POST', '/api/v1/futures/trade/batch_order', { symbol, orderList: payloadOrderList }, {});
  }

  async modifyOrder(params) {
    if (!params || typeof params !== 'object' || (!params.orderId && !params.clientId)) throw new Error('orderId or clientId is required');
    if (!positiveNumber(params.qty)) throw new Error('qty must be positive');
    if (params.price !== undefined && !positiveNumber(params.price)) throw new Error('price must be positive when supplied');
    const order = normalizeOrder(params);
    for (const key of ['tpStopType', 'slStopType']) {
      if (order[key] && !['MARK_PRICE', 'LAST_PRICE'].includes(order[key])) throw new Error(`invalid ${key}`);
    }
    for (const key of ['tpOrderType', 'slOrderType']) {
      if (order[key] && !['LIMIT', 'MARKET'].includes(order[key])) throw new Error(`invalid ${key}`);
    }
    if (order.tpOrderType === 'LIMIT' && !positiveNumber(order.tpOrderPrice)) throw new Error('tpOrderPrice is required for LIMIT take-profit orders');
    if (order.slOrderType === 'LIMIT' && !positiveNumber(order.slOrderPrice)) throw new Error('slOrderPrice is required for LIMIT stop-loss orders');
    return this.request('POST', '/api/v1/futures/trade/modify_order', order, {});
  }

  async cancelOrders(symbol, orderList) {
    if (typeof symbol !== 'string' || !symbol) throw new Error('symbol is required');
    if (!Array.isArray(orderList) || orderList.length < 1) throw new Error('orderList is required');
    for (const order of orderList) {
      if (!order || typeof order !== 'object' || (!order.orderId && !order.clientId)) throw new Error('each order needs orderId or clientId');
    }
    return this.request('POST', '/api/v1/futures/trade/cancel_orders', { symbol, orderList }, {});
  }

  async cancelOrder(symbol, orderId) {
    return this.cancelOrders(symbol, [{ orderId }]);
  }

  async cancelAllOrders(symbol = '') {
    const body = symbol ? { symbol } : {};
    return this.request('POST', '/api/v1/futures/trade/cancel_all_orders', body, {});
  }

  async closePosition(symbol, positionId, position = null) {
    const normalizedPositionId = requirePositionId(positionId);
    let target = position;
    if (!target) {
      const positions = await this.getPendingPositions({ symbol });
      target = strictListFromData(positions)?.find(item => String(item.positionId) === normalizedPositionId);
    }
    if (!target || String(target.symbol || '').toUpperCase() !== String(symbol).toUpperCase() || String(target.positionId) !== normalizedPositionId) {
      throw new Error(`position ${normalizedPositionId} not found for ${symbol}`);
    }
    const quantity = target.qty ?? target.size ?? target.positionQty ?? target.positionSize;
    if (!positiveNumber(quantity)) throw new Error(`position ${normalizedPositionId} has no valid size`);
    const positionSide = String(target.side || '').toUpperCase();
    const side = positionSide === 'LONG' || positionSide === 'BUY'
      ? 'BUY'
      : positionSide === 'SHORT' || positionSide === 'SELL' ? 'SELL' : null;
    if (!side) throw new Error(`position ${normalizedPositionId} has an invalid side`);
    return this.placeOrder({
      symbol,
      side,
      qty: String(quantity),
      orderType: 'MARKET',
      tradeSide: 'CLOSE',
      reduceOnly: true,
      positionId: normalizedPositionId,
      clientId: `jrock-close-${normalizedPositionId}`,
    });
  }

  async closeAllPosition(symbol = '') {
    const body = symbol ? { symbol } : {};
    return this.request('POST', '/api/v1/futures/trade/close_all_position', body, {});
  }

  async flashClosePosition(positionId) {
    return this.request('POST', '/api/v1/futures/trade/flash_close_position', { positionId: requirePositionId(positionId) }, {});
  }

  async placeTPSL(params) {
    return this.request('POST', '/api/v1/futures/tpsl/position/place_order', params, {});
  }

  async placeTPSLOrder(params) {
    return this.request('POST', '/api/v1/futures/tpsl/place_order', params, {});
  }

  async modifyTPSL(params) {
    return this.request('POST', '/api/v1/futures/tpsl/position/modify_order', params, {});
  }

  async modifyTPSLOrder(params) {
    return this.request('POST', '/api/v1/futures/tpsl/modify_order', params, {});
  }

  async cancelTPSL(symbol, orderId) {
    if (!symbol || !orderId) throw new Error('symbol and orderId are required to cancel TP/SL');
    return this.request('POST', '/api/v1/futures/tpsl/cancel_order', { symbol, orderId }, {});
  }

  async getPendingPositions(symbolOrOptions = '', extra = {}) {
    const options = normalizeOptions(symbolOrOptions, typeof symbolOrOptions === 'string' ? symbolOrOptions : '');
    return this.request('GET', '/api/v1/futures/position/get_pending_positions', null, { ...options, ...extra });
  }

  async getHistoryPositions(symbolOrOptions = '', extra = {}) {
    const options = normalizeOptions(symbolOrOptions, typeof symbolOrOptions === 'string' ? symbolOrOptions : '');
    return this.request('GET', '/api/v1/futures/position/get_history_positions', null, { ...options, ...extra });
  }

  async getPositionTiers(symbol) {
    return this.request('GET', '/api/v1/futures/position/get_position_tiers', null, { symbol });
  }

  async getPendingTPSL(symbolOrOptions = '', extra = {}) {
    const options = normalizeOptions(symbolOrOptions, typeof symbolOrOptions === 'string' ? symbolOrOptions : '');
    return this.request('GET', '/api/v1/futures/tpsl/get_pending_orders', null, { ...options, ...extra });
  }

  async getHistoryTPSL(symbolOrOptions = '', extra = {}) {
    const options = normalizeOptions(symbolOrOptions, typeof symbolOrOptions === 'string' ? symbolOrOptions : '');
    return this.request('GET', '/api/v1/futures/tpsl/get_history_orders', null, { ...options, ...extra });
  }

  async changeLeverage(symbol, leverage, marginCoin = 'USDT') {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error('leverage must be an integer 1-125');
    return this.request('POST', '/api/v1/futures/account/change_leverage', { symbol, leverage, marginCoin }, {});
  }

  async changeMarginMode(symbol, marginMode, marginCoin = 'USDT') {
    const normalized = { crossed: 'CROSS', cross: 'CROSS', isolated: 'ISOLATION', isolation: 'ISOLATION' }[String(marginMode).toLowerCase()];
    if (!normalized) throw new Error('marginMode must be crossed or isolated');
    return this.request('POST', '/api/v1/futures/account/change_margin_mode', { symbol, marginMode: normalized, marginCoin }, {});
  }

  async changePositionMode(positionMode) {
    const normalized = { 'one-way': 'ONE_WAY', one_way: 'ONE_WAY', hedge: 'HEDGE' }[String(positionMode).toLowerCase()];
    if (!normalized) throw new Error('positionMode must be one-way or hedge');
    return this.request('POST', '/api/v1/futures/account/change_position_mode', { positionMode: normalized }, {});
  }

  async adjustPositionMargin(symbol, amount, options = {}) {
    const normalizedOptions = typeof options === 'string' ? { side: options } : (options && typeof options === 'object' ? options : {});
    const { marginCoin = 'USDT', side, positionId } = normalizedOptions;
    if (!nonZeroNumber(amount)) throw new Error('amount must be a non-zero number');
    if (!side && !positionId) throw new Error('side or positionId is required');
    const body = { symbol, amount: String(amount), marginCoin };
    if (side) body.side = String(side).toUpperCase();
    if (positionId) body.positionId = requirePositionId(positionId);
    return this.request('POST', '/api/v1/futures/account/adjust_position_margin', body, {});
  }

  async getLeverageAndMarginMode(symbol, marginCoin = 'USDT') {
    return this.request('GET', '/api/v1/futures/account/get_leverage_margin_mode', null, { symbol, marginCoin });
  }

  // Bitunix has no standalone "get position mode" endpoint. positionMode is
  // returned as a field on the account object from GET /api/v1/futures/account
  // (see https://www.bitunix.com/api-docs/futures/account/get_single_account.html).
  // A prior version of this called a nonexistent
  // /api/v1/futures/account/position_mode endpoint, which always failed.
  async getPositionMode(marginCoin = 'USDT') {
    const account = await this.getAccount(marginCoin);
    return { positionMode: account?.positionMode ?? null };
  }

  async getPendingOrders(symbolOrOptions = '', extra = {}) {
    const options = normalizeOptions(symbolOrOptions, typeof symbolOrOptions === 'string' ? symbolOrOptions : '');
    return this.request('GET', '/api/v1/futures/trade/get_pending_orders', null, { ...options, ...extra });
  }

  async getOrderDetail(orderIdOrOptions = '', clientId = '') {
    const options = typeof orderIdOrOptions === 'object' && orderIdOrOptions !== null
      ? { ...orderIdOrOptions }
      : { orderId: orderIdOrOptions, clientId };
    if (!options.orderId && !options.clientId) throw new Error('orderId or clientId is required');
    return this.request('GET', '/api/v1/futures/trade/get_order_detail', null, options);
  }

  async getHistoryOrders(symbolOrOptions = '', extra = {}) {
    const options = normalizeOptions(symbolOrOptions, typeof symbolOrOptions === 'string' ? symbolOrOptions : '');
    return this.request('GET', '/api/v1/futures/trade/get_history_orders', null, { ...options, ...extra });
  }

  async getHistoryTrades(symbolOrOptions = '', extra = {}) {
    const options = normalizeOptions(symbolOrOptions, typeof symbolOrOptions === 'string' ? symbolOrOptions : '');
    return this.request('GET', '/api/v1/futures/trade/get_history_trades', null, { ...options, ...extra });
  }

  async getAssetQuery() {
    return this.request('GET', '/api/v1/cp/asset/query', null, {});
  }

  async transferAssetFromMainAccountToSubAccount(params = {}) {
    return this.request('POST', '/api/v1/cp/asset/transfer-to-sub-account', validateAssetTransfer(params), {});
  }

  async transferAssetFromSubAccountToMainAccount(params = {}) {
    return this.request('POST', '/api/v1/cp/asset/transfer-to-main-account', validateAssetTransfer(params), {});
  }

  // Names used by the official SDK/demo are kept as small compatibility aliases.
  getKline(...args) {
    return this.getKlines(...args);
  }

  getBatchFundingRate() {
    return this.getFundingRateBatch();
  }

  getCurrentPositions(...args) {
    return this.getPendingPositions(...args);
  }

  async getErrorCode(code) {
    return { code, hint: 'See https://www.bitunix.com/api-docs/futures/errorcode/error_code.html' };
  }
}

export { listFromData, strictListFromData };

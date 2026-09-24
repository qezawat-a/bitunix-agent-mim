import crypto from 'crypto';
import { CONFIG } from '../config.js';

export class BitunixClient {
  baseURL = CONFIG.BITUNIX_BASE_URL;
  apiKey = CONFIG.BITUNIX_API_KEY;
  secretKey = CONFIG.BITUNIX_API_SECRET;

  static sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

  makeSign(path, body, queryParams = {}) {
    const nonce = Math.floor(Math.random() * 1000000000).toString();
    const timestamp = Date.now().toString();
    const qs = Object.keys(queryParams)
      .sort()
      .map(k => `${k}=${queryParams[k]}`)
      .join('');
    const bodyStr = JSON.stringify(body).replace(/\s/g, '');
    const digestInput = `${nonce}${timestamp}${this.apiKey}${qs}${bodyStr}`;
    const digest = BitunixClient.sha256(digestInput);
    const sign = BitunixClient.sha256(digest + this.secretKey);
    return { 'api-key': this.apiKey, nonce, timestamp, sign };
  }

  async request(method, path, body = null, queryParams = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'language': 'en-US',
      ...this.makeSign(path, body, queryParams),
    };
    const url = `${this.baseURL}${path}?${new URLSearchParams(queryParams)}`;
    const opts = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    };
    const res = await fetch(url, opts);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Bitunix ${method} ${path} ${res.status}: ${txt}`);
    }
    const data = await res.json();
    return data?.data ?? null;
  }

  async getAccount(marginCoin = 'USDT') {
    return this.request('GET', '/api/v1/futures/account', null, { marginCoin });
  }

  async getKlines(symbol, interval = '15m', limit = 200, startTime = 0, endTime = 0, type = 'LAST_PRICE') {
    const query = { symbol, interval, limit: String(limit), startTime: startTime || '', endTime: endTime || '', type };
    return this.request('GET', '/api/v1/futures/market/kline', null, query);
  }

  async getTickers(symbol = '') {
    return this.request('GET', '/api/v1/futures/market/tickers', null, { symbol });
  }

  async getDepth(symbol) {
    return this.request('GET', `/api/v1/futures/market/depth?symbol=${symbol}`, null, {});
  }

  async placeOrder(params) {
    return this.request('POST', '/api/v1/futures/trade/place_order', params, {});
  }

  async modifyOrder(params) {
    return this.request('POST', '/api/v1/futures/trade/modify_order', params, {});
  }

  async cancelOrder(symbol, orderId) {
    return this.request('POST', '/api/v1/futures/trade/cancel_orders', { symbol, orderId }, {});
  }

  async closeAllPosition(symbol) {
    return this.request('POST', '/api/v1/futures/trade/close_all_position', { symbol }, {});
  }

  async placeTPSL(params) {
    return this.request('POST', '/api/v1/futures/tp_sl/place_tp_sl_order', params, {});
  }

  async modifyTPSL(params) {
    return this.request('POST', '/api/v1/futures/tp_sl/modify_tp_sl_order', params, {});
  }

  async cancelTPSL(orderId) {
    return this.request('POST', '/api/v1/futures/tp_sl/cancel_tp_sl_order', { orderId }, {});
  }

  async getPendingPositions(symbol) {
    return this.request('GET', '/api/v1/futures/position/get_pending_positions', null, { symbol });
  }

  async getHistoryPositions(symbol) {
    return this.request('GET', '/api/v1/futures/position/get_history_positions', null, { symbol });
 }

  async getPendingTPSL(symbol) {
    return this.request('GET', '/api/v1/futures/tp_sl/get_pending_tp_sl_order', null, { symbol });
 }

  async getHistoryTPSL(symbol) {
    return this.request('GET', '/api/v1/futures/tp_sl/get_history_tp_sl_order', null, { symbol });
 }

  async changeLeverage(symbol, leverage) {
    return this.request('POST', '/api/v1/futures/account/change_leverage', { symbol, leverage }, {});
 }

  async changeMarginMode(symbol, marginMode) {
    return this.request('POST', '/api/v1/futures/account/change_margin_mode', { symbol, marginMode }, {});
 }

  async changePositionMode(symbol, positionMode) {
    return this.request('POST', '/api/v1/futures/account/change_position_mode', { symbol, positionMode }, {});
 }

  async adjustPositionMargin(symbol, margin) {
    return this.request('POST', '/api/v1/futures/account/adjust_position_margin', { symbol, margin }, {});
 }

  async getFundingRate(symbol) {
    return this.request('GET', '/api/v1/futures/market/funding_rate', null, { symbol });
 }

  async getFundingRateBatch(symbols) {
    return this.request('GET', '/api/v1/futures/market/funding_rate_batch', null, { symbols: Array.isArray(symbols) ? symbols.join(',') : symbols });
 }

  async getTradingPairs() {
    return this.request('GET', '/api/v1/futures/market/trading_pairs', null, {});
 }

  async getLeverageAndMarginMode(symbol) {
    return this.request('GET', '/api/v1/futures/account/leverage_and_margin_mode', null, { symbol });
 }

  async getPendingOrders(symbol) {
    return this.request('GET', '/api/v1/futures/trade/get_pending_orders', null, { symbol });
 }

  async getHistoryOrders(symbol) {
    return this.request('GET', '/api/v1/futures/trade/get_history_orders', null, { symbol });
 }

  async getHistoryTrades(symbol) {
    return this.request('GET', '/api/v1/futures/trade/get_history_trades', null, { symbol });
 }

  async flashClosePosition(symbol) {
    return this.request('POST', '/api/v1/futures/trade/flash_close_position', { symbol }, {});
 }

  async getErrorCode(code) {
    return { code, hint: 'See https://www.bitunix.com/api-docs/futures/ErrorCode/error_code.html' };
 }
}

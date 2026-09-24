import { BitunixClient } from '../bitunix/client.js';
import Scanner from '../bitunix/scanner.js';
import { PositionManager } from './position-manager.js';
import { CONFIG } from '../config.js';

export class Trader {
  client;
  scanner;
  positionManager;
  state = { lastScan: 0, lastGuard: 0, lastReport: 0, cooldownUntil: 0, positions: [] };

  constructor(client) {
    this.client = client;
    this.scanner = new Scanner(client);
    this.positionManager = new PositionManager(client, CONFIG.symbol, CONFIG);
  }

  async scanAndOpen() {
    const now = Date.now();
    if (now < this.state.cooldownUntil) return null;

    const scans = CONFIG.min_agreeing_strategies;
    const results = [];
    for (const sym of [CONFIG.symbol]) {
      const res = await this.scanner.scan(sym);
      results.push(res);
      if (res.signal !== 'hold') {
        if (this.state.positions.length < CONFIG.max_positions) {
          const entryPrice = parseFloat(res.lastPrice) || 0;
          if (entryPrice > 0) {
            const positionId = `pos_${sym}_${now}`;
            await this.openPosition(sym, entryPrice, res.signal);
            this.state.cooldownUntil = now + CONFIG.cooldown_minutes * 60 * 1000;
            return { symbol: sym, signal: res.signal, price: entryPrice, positionId };
          }
        }
      }
    }
    return null;
  }

  async openPosition(symbol, entryPrice, direction) {
    const qty = this.computePositionSize(entryPrice);
    const { tpPrice, slPrice, tpStopType, slStopType } = this.positionManager.computeTPSL(
      entryPrice, direction, null, CONFIG.min_confidence
    );
    const body = {
      symbol,
      side: direction === 'bullish' ? 'BUY' : 'SELL',
      price: entryPrice.toFixed(2),
      qty: qty.toString(),
      orderType: 'LIMIT',
      effect: 'GTC',
      tpPrice,
      slPrice,
      tpStopType,
      slStopType,
      tpOrderType: 'MARKET',
      slOrderType: 'MARKET',
      reduceOnly: false,
      tradeSide: 'OPEN',
    };
    const order = await this.client.placeOrder(body);
    this.state.positions.push({ positionId: order.orderId, symbol, side: body.side, entryPrice, direction });
    return order;
  }

  async computePositionSize(entryPrice) {
    const account = await this.client.getAccount('USDT');
    const available = parseFloat(account.available) || 0;
    const notional = (available * CONFIG.margin_amount_pct) / 100;
    const size = (notional / entryPrice) * CONFIG.leverage;
    return Math.max(0.12, Math.floor(size * 100) / 100);
  }

  async guard() {
    const now = Date.now();
    if (now < this.state.lastGuard + CONFIG.guard_interval_sec * 1000) return;
    await this.positionManager.fetchPositions();
    for (const pos of this.state.positions) {
      await this.positionManager.checkLiquidationGuard(pos);
      if (Math.random() < 0.05) {
        await this.positionManager.checkBreakeven(pos);
        await this.positionManager.checkTrailing(pos);
      }
    }
    this.state.lastGuard = now;
  }

  async midManage() {
    const now = Date.now();
    if (now < this.state.lastManage + CONFIG.mid_manage_interval_sec * 1000) return;
    await this.positionManager.midManage();
    this.state.lastManage = now;
    await this.positionManager.fetchPositions();
    this.state.positions = this.state.positions.filter(p => p.positionId);
  }

  async report() {
    const now = Date.now();
    if (now < this.state.lastReport + CONFIG.report_interval_sec * 1000) return;
    console.log(`[Report ${new Date().toISOString()}] symbol=${CONFIG.symbol} positions=${this.state.positions.length} scan=${CONFIG.symbol}`);
    this.state.lastReport = now;
  }

  async scanCycle() {
    const signal = await this.scanAndOpen();
    await this.guard();
    await this.midManage();
    await this.report();
    return signal;
  }
}
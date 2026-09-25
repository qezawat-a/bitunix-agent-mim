import Scanner from '../bitunix/scanner.js';
import { PositionManager } from './position-manager.js';
import { CONFIG } from '../config.js';

function validPositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export class Trader {
  client;
  scanner;
  positionManager;
  state = {
    lastScan: 0,
    lastGuard: 0,
    lastReport: 0,
    lastManage: 0,
    cooldownUntil: 0,
    orderUnknownUntil: 0,
    positions: [],
    confirmations: new Map(),
  };
  entryInFlight = new Set();
  guardInFlight = null;
  manageInFlight = null;
  privateRefreshInFlight = null;

  constructor(client) {
    this.client = client;
    this.scanner = new Scanner(client);
    this.positionManager = new PositionManager(client, CONFIG.symbol, CONFIG);
  }

  async reconcilePositions() {
    const positions = await this.positionManager.fetchPositions();
    this.state.positions = positions.map(position => ({
      positionId: position.positionId,
      symbol: position.symbol,
      side: position.side,
      entryPrice: Number(position.avgPrice),
      markPrice: Number(position.markPrice),
      openedAt: Number(position.openTime) * 1000,
    }));
    return this.state.positions;
  }

  updateConfirmation(symbol, signal) {
    if (!['bullish', 'bearish'].includes(signal)) {
      this.state.confirmations.delete(symbol);
      return 0;
    }
    const current = this.state.confirmations.get(symbol);
    const count = current?.signal === signal ? current.count + 1 : 1;
    this.state.confirmations.set(symbol, { signal, count });
    return count;
  }

  async verifyAccountSettings() {
    if (CONFIG.dry_run) return { skipped: 'dry_run' };
    const [account, leverageData] = await Promise.all([
      this.client.getAccount('USDT'),
      this.client.getLeverageAndMarginMode(CONFIG.symbol),
    ]);
    const leverageRecord = Array.isArray(leverageData) ? leverageData[0] : leverageData;
    const leverageValue = Number(leverageRecord?.leverage ?? leverageRecord?.marginLeverage);
    if (Number.isFinite(leverageValue) && leverageValue !== CONFIG.leverage) {
      throw new Error(`exchange leverage ${leverageValue} does not match configured leverage ${CONFIG.leverage}`);
    }
    const exchangeMode = String(account?.positionMode ?? account?.position_mode ?? '').toUpperCase();
    const configuredMode = CONFIG.position_mode === 'hedge' ? 'HEDGE' : 'ONE_WAY';
    if (exchangeMode && exchangeMode !== configuredMode) {
      throw new Error(`exchange position mode ${exchangeMode} does not match configured mode ${configuredMode}`);
    }
    return { checked: true, leverage: Number.isFinite(leverageValue) ? leverageValue : null, positionMode: exchangeMode || null };
  }

  async scanAndOpen() {
    const now = Date.now();
    if (now < this.state.cooldownUntil || now < this.state.orderUnknownUntil) return null;
    const symbol = CONFIG.symbol;
    if (this.entryInFlight.has(symbol)) return null;
    this.entryInFlight.add(symbol);

    try {
      const result = await this.scanner.scan(symbol);
      if (CONFIG.symbol !== symbol) return null;
      if (!['bullish', 'bearish'].includes(result.signal)) {
        this.updateConfirmation(symbol, result.signal);
        return null;
      }

      const confirmations = this.updateConfirmation(symbol, result.signal);
      const signal = { ...result, executed: false, confirmations };
      if (confirmations < CONFIG.signal_confirm_scans) {
        signal.reason = 'confirmation_pending';
        return signal;
      }
      if (!CONFIG.auto_trade) {
        signal.reason = 'auto_trade_disabled';
        return signal;
      }

      await this.reconcilePositions();
      if (this.state.positions.length >= CONFIG.max_positions) {
        signal.reason = 'max_positions';
        return signal;
      }

      const entryPrice = Number(result.lastPrice);
      if (!validPositive(entryPrice)) throw new Error('scanner returned an invalid entry price');
      const atr = result.tfSignals?.[CONFIG.timeframes[0]]?.atr ?? null;
      const order = await this.openPosition(symbol, entryPrice, result.signal, atr);
      return { ...signal, executed: true, order, price: entryPrice };
    } finally {
      this.entryInFlight.delete(symbol);
    }
  }

  async openPosition(symbol, entryPrice, direction, atr = null) {
    if (!CONFIG.auto_trade) throw new Error('auto_trade is disabled');
    if (!['bullish', 'bearish'].includes(direction)) throw new Error('invalid trade direction');
    if (!validPositive(entryPrice)) throw new Error('entry price must be positive');
    this.state.cooldownUntil = Date.now() + Number(CONFIG.cooldown_minutes) * 60000;
    this.state.confirmations.delete(symbol);

    const qty = await this.computePositionSize(entryPrice);
    const levels = this.positionManager.computeTPSL(entryPrice, direction, atr, CONFIG.min_confidence);
    const body = {
      symbol,
      side: direction === 'bullish' ? 'BUY' : 'SELL',
      price: String(Number(Number(entryPrice).toFixed(8))),
      qty: String(qty),
      orderType: 'LIMIT',
      effect: 'GTC',
      ...levels,
      tpOrderType: 'MARKET',
      slOrderType: 'MARKET',
      reduceOnly: false,
      tradeSide: 'OPEN',
    };

    if (!CONFIG.auto_trade) throw new Error('auto_trade was disabled before order submission');
    if (CONFIG.symbol !== symbol) throw new Error('symbol changed before order submission');
    if (CONFIG.dry_run) return { dryRun: true, body };
    let order;
    try {
      order = await this.client.placeOrder(body);
    } catch (error) {
      this.state.orderUnknownUntil = Date.now() + Math.max(Number(CONFIG.cooldown_minutes) * 60000, 300000);
      throw error;
    }
    const positions = await this.reconcilePositions();
    try {
      for (const position of positions) await this.positionManager.ensureProtection(position);
    } catch (error) {
      this.state.orderUnknownUntil = Date.now() + Math.max(Number(CONFIG.cooldown_minutes) * 60000, 300000);
      throw error;
    }
    return order;
  }

  async computePositionSize(entryPrice) {
    if (!validPositive(entryPrice)) throw new Error('entry price must be positive');
    if (!Number.isInteger(CONFIG.leverage) || CONFIG.leverage < 1 || CONFIG.leverage > 125) {
      throw new Error('leverage must be an integer 1-125');
    }
    const account = await this.client.getAccount('USDT');
    const available = Number(account?.available);
    if (!validPositive(available)) throw new Error('available USDT balance must be positive');
    const notional = available * Number(CONFIG.margin_amount_pct) / 100;
    const size = notional / Number(entryPrice) * CONFIG.leverage;
    if (!validPositive(size)) throw new Error('calculated position size must be positive');
    return Math.floor(size * 100000000) / 100000000;
  }

  async guard() {
    if (this.guardInFlight) return this.guardInFlight;
    const now = Date.now();
    if (now < this.state.lastGuard + CONFIG.guard_interval_sec * 1000) return null;
    this.state.lastGuard = now;
    this.guardInFlight = (async () => {
      const positions = await this.positionManager.fetchPositions();
      const errors = [];
      for (const position of positions) {
        try {
          const result = await this.positionManager.checkLiquidationGuard(position);
          if (result?.dryRun && result.positionId) this.state.cooldownUntil = this.positionManager.state.cooldownUntil;
        } catch (error) {
          errors.push({ positionId: position.positionId, message: error.message });
        }
      }
      this.state.cooldownUntil = Math.max(this.state.cooldownUntil, this.positionManager.state.cooldownUntil);
      this.state.positions = positions.map(position => ({ positionId: position.positionId, symbol: position.symbol, side: position.side }));
      return errors;
    })();
    try {
      return await this.guardInFlight;
    } finally {
      this.guardInFlight = null;
    }
  }

  async midManage() {
    if (this.manageInFlight) return this.manageInFlight;
    const now = Date.now();
    if (now < this.state.lastManage + CONFIG.mid_manage_interval_sec * 1000) return null;
    this.state.lastManage = now;
    this.manageInFlight = this.positionManager.midManage();
    try {
      const errors = await this.manageInFlight;
      this.state.cooldownUntil = Math.max(this.state.cooldownUntil, this.positionManager.state.cooldownUntil);
      this.state.positions = this.positionManager.state.positions.map(position => ({ positionId: position.positionId, symbol: position.symbol, side: position.side }));
      return errors;
    } finally {
      this.manageInFlight = null;
    }
  }

  async handlePrivateEvent() {
    if (this.privateRefreshInFlight) return this.privateRefreshInFlight;
    this.privateRefreshInFlight = this.reconcilePositions();
    try {
      return await this.privateRefreshInFlight;
    } finally {
      this.privateRefreshInFlight = null;
    }
  }

  async report() {
    const now = Date.now();
    if (now < this.state.lastReport + CONFIG.report_interval_sec * 1000) return;
    console.log(`[Report ${new Date().toISOString()}] symbol=${CONFIG.symbol} positions=${this.state.positions.length}`);
    this.state.lastReport = now;
  }

  async scanCycle() {
    let signal = null;
    let scanError = null;
    try {
      signal = await this.scanAndOpen();
    } catch (error) {
      scanError = error;
    }
    try { await this.guard(); } catch (error) { console.error('guard error:', error.message); }
    try { await this.midManage(); } catch (error) { console.error('manage error:', error.message); }
    try { await this.report(); } catch (error) { console.error('report error:', error.message); }
    if (scanError) throw scanError;
    return signal;
  }
}

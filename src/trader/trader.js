import Scanner from '../bitunix/scanner.js';
import { strictListFromData } from '../bitunix/client.js';
import { PositionManager } from './position-manager.js';
import { CONFIG } from '../config.js';
import { esc as escText } from '../telegram-bot.js';

function validPositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export class Trader {
  client;
  scanner;
  positionManager;
  state = {
    lastScan: null,
    lastGuard: 0,
    lastReport: 0,
    lastManage: 0,
    cooldownUntil: 0,
    orderUnknownUntil: 0,
    positions: [],
    lastPrivateEvent: null,
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
    const [account, leverageData, positionModeData] = await Promise.all([
      this.client.getAccount('USDT'),
      this.client.getLeverageAndMarginMode(CONFIG.symbol),
      this.client.getPositionMode(),
    ]);
    const leverageRecord = Array.isArray(leverageData) ? leverageData[0] : leverageData;
    const positionModeRecord = Array.isArray(positionModeData) ? positionModeData[0] : positionModeData;
    const leverageValue = Number(leverageRecord?.leverage ?? leverageRecord?.marginLeverage);
    if (Number.isFinite(leverageValue) && leverageValue !== CONFIG.leverage) {
      throw new Error(`exchange leverage ${leverageValue} does not match configured leverage ${CONFIG.leverage}`);
    }
    const exchangeMode = String(positionModeRecord?.positionMode ?? account?.positionMode ?? account?.position_mode ?? '').toUpperCase();
    const configuredMode = CONFIG.position_mode === 'hedge' ? 'HEDGE' : 'ONE_WAY';
    if (exchangeMode && exchangeMode !== configuredMode) {
      throw new Error(`exchange position mode ${exchangeMode} does not match configured mode ${configuredMode}`);
    }
    const exchangeMarginMode = String(leverageRecord?.marginMode ?? '').toUpperCase();
    const configuredMarginMode = CONFIG.position_type === 'isolated' ? 'ISOLATION' : 'CROSS';
    if (exchangeMarginMode && exchangeMarginMode !== configuredMarginMode) {
      throw new Error(`exchange margin mode ${exchangeMarginMode} does not match configured mode ${configuredMarginMode}`);
    }
    return { checked: true, leverage: Number.isFinite(leverageValue) ? leverageValue : null, positionMode: exchangeMode || null, marginMode: exchangeMarginMode || null };
  }

  async syncAccountSettings({ apply = false } = {}) {
    const [positions, orders] = await Promise.all([
      this.client.getPendingPositions(CONFIG.symbol),
      this.client.getPendingOrders(CONFIG.symbol),
    ]);
    const positionList = strictListFromData(positions);
    const orderList = strictListFromData(orders, ['orderList']);
    if (!Array.isArray(positionList) || !Array.isArray(orderList)) throw new Error('exchange exposure state is invalid');
    const current = await this.verifyAccountSettings();
    if (!apply) return { ...current, applied: false };
    if (positionList.length || orderList.length) return { ...current, applied: false, skipped: 'open_exposure' };

    const [leverageData, positionModeData] = await Promise.all([
      this.client.getLeverageAndMarginMode(CONFIG.symbol),
      this.client.getPositionMode(),
    ]);
    const leverageRecord = Array.isArray(leverageData) ? leverageData[0] : leverageData;
    const leverage = Number(leverageRecord?.leverage);
    if (Number.isFinite(leverage) && leverage !== CONFIG.leverage) await this.client.changeLeverage(CONFIG.symbol, CONFIG.leverage);
    const marginMode = String(leverageRecord?.marginMode || '').toUpperCase();
    const configuredMarginMode = CONFIG.position_type === 'isolated' ? 'ISOLATION' : 'CROSS';
    if (marginMode && marginMode !== configuredMarginMode) await this.client.changeMarginMode(CONFIG.symbol, CONFIG.position_type);
    const positionModeRecord = Array.isArray(positionModeData) ? positionModeData[0] : positionModeData;
    const exchangeMode = String(positionModeRecord?.positionMode || '').toUpperCase();
    const configuredMode = CONFIG.position_mode === 'hedge' ? 'HEDGE' : 'ONE_WAY';
    if (exchangeMode && exchangeMode !== configuredMode) await this.client.changePositionMode(CONFIG.position_mode);
    return { ...(await this.verifyAccountSettings()), applied: true };
  }

  // Produces a confirmed signal and hands it up. Opening a position is the
  // agent's decision, not this layer's, so nothing here places an order.
  async scanSignal() {
    const now = Date.now();
    if (now < this.state.cooldownUntil || now < this.state.orderUnknownUntil) return null;
    const symbol = CONFIG.symbol;
    if (this.entryInFlight.has(symbol)) return null;
    this.entryInFlight.add(symbol);

    try {
      const result = await this.scanner.scan(symbol);
      if (CONFIG.symbol !== symbol) return null;
      this.state.lastScan = `${result.signal} ${Math.round(Number(result.confidence) || 0)}%${result.agreeingStrategies?.length ? ` (${result.agreeingStrategies.join(', ')})` : ''}`;
      const reversals = await this.checkReversal(result);
      if (!['bullish', 'bearish'].includes(result.signal)) {
        this.updateConfirmation(symbol, result.signal);
        return reversals.length ? { symbol, signal: result.signal, confidence: result.confidence, reversals } : null;
      }

      const confirmations = this.updateConfirmation(symbol, result.signal);
      const signal = { ...result, executed: false, confirmations };
      if (confirmations < CONFIG.signal_confirm_scans) {
        signal.reason = 'confirmation_pending';
        return { ...signal, reversals };
      }

      await this.reconcilePositions();
      if (this.state.positions.length >= CONFIG.max_positions) {
        signal.reason = 'max_positions';
        return { ...signal, reversals };
      }

      const entryPrice = Number(result.lastPrice);
      if (!validPositive(entryPrice)) throw new Error('scanner returned an invalid entry price');
      return {
        ...signal,
        reversals,
        reason: 'awaiting_agent',
        price: entryPrice,
        atr: result.tfSignals?.[CONFIG.timeframes[0]]?.atr ?? null,
      };
    } finally {
      this.entryInFlight.delete(symbol);
    }
  }

  // A strong read against an open position is an exit, not a shortcut into the
  // opposite trade: the agent is told the position was closed so it can decide
  // what to do next. Judged on the raw committee direction, so a reversal still
  // fires when the read is too weak to open anything.
  async checkReversal(scan) {
    if (!CONFIG.reversal_enabled || !scan) return [];
    const direction = scan.direction;
    if (!['bullish', 'bearish'].includes(direction)) return [];
    const confidence = Number(scan.rawConfidence);
    if (!Number.isFinite(confidence) || confidence < Number(CONFIG.reversal_confidence)) return [];
    const wanted = direction === 'bullish' ? 'SELL' : 'BUY';
    const positions = await this.positionManager.fetchPositions();
    const closed = [];
    for (const position of positions) {
      if (position.side !== wanted) continue;
      try {
        const result = await this.client.closePosition(CONFIG.symbol, position.positionId, position);
        this.state.cooldownUntil = Date.now() + Number(CONFIG.cooldown_minutes) * 60000;
        closed.push({ positionId: position.positionId, side: position.side, confidence, result });
      } catch (error) {
        this.state.lastReversalError = error.message;
      }
    }
    return closed;
  }

  async reconcileOrder(symbol, clientId) {
    if (typeof this.client.getPendingOrders !== 'function' || typeof this.client.getHistoryOrders !== 'function') return null;
    const results = await Promise.allSettled([
      this.client.getPendingOrders(symbol),
      this.client.getHistoryOrders(symbol),
    ]);
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const orders = strictListFromData(result.value, ['orderList']);
      if (!orders) continue;
      const match = orders.find(order => String(order.clientId || order.client_id || '') === clientId);
      if (match) return match;
    }
    return null;
  }

  async openPosition(symbol, entryPrice, direction, atr = null, confidence = null) {
    if (!['bullish', 'bearish'].includes(direction)) throw new Error('invalid trade direction');
    if (!validPositive(entryPrice)) throw new Error('entry price must be positive');
    this.state.cooldownUntil = Date.now() + Number(CONFIG.cooldown_minutes) * 60000;
    this.state.confirmations.delete(symbol);

    const qty = await this.computePositionSize(entryPrice);
    const clientId = `jrock-open-${symbol}-${Date.now()}`;
    // The live signal's own strength sizes the targets. Falling back to the
    // floor keeps a manual entry from being sized as if it were a strong read.
    const strength = Number.isFinite(Number(confidence)) ? Number(confidence) : CONFIG.min_confidence;
    const levels = this.positionManager.computeTPSL(entryPrice, direction, atr, strength);
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
      clientId,
    };

    if (CONFIG.symbol !== symbol) throw new Error('symbol changed before order submission');
    let order;
    try {
      order = await this.client.placeOrder(body);
    } catch (error) {
      const reconciled = await this.reconcileOrder(symbol, clientId);
      if (!reconciled) {
        this.state.orderUnknownUntil = Date.now() + Math.max(Number(CONFIG.cooldown_minutes) * 60000, 300000);
        throw error;
      }
      order = reconciled;
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
    const unit = String(CONFIG.order_unit || 'cost').trim().toLowerCase().replace(/[ -]+/g, '_');
    if (unit === 'qty') {
      throw new Error('order_unit=qty requires an explicit quantity for this order; autonomous sizing supports cost or position_size');
    }
    if (!['cost', 'position_size'].includes(unit)) throw new Error('order_unit must be cost, qty, or position_size');
    if (!Number.isInteger(CONFIG.leverage) || CONFIG.leverage < 1 || CONFIG.leverage > 125) {
      throw new Error('leverage must be an integer 1-125');
    }
    const account = await this.client.getAccount('USDT');
    const available = Number(account?.available);
    if (!validPositive(available)) throw new Error('available USDT balance must be positive');
    const percentage = unit === 'position_size' ? Number(CONFIG.position_sizing_margin_pct) : Number(CONFIG.margin_amount_pct);
    if (!validPositive(percentage)) throw new Error(`${unit === 'position_size' ? 'position_sizing_margin_pct' : 'margin_amount_pct'} must be positive`);
    const baseNotional = available * percentage / 100;
    // Bitunix order units: position_size is Nominal Value (leverage-independent);
    // cost is Cost Value (margin allocated, so leverage changes the quantity).
    const notional = unit === 'cost' ? baseNotional * CONFIG.leverage : baseNotional;
    const size = notional / Number(entryPrice);
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
          await this.positionManager.checkLiquidationGuard(position);
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

  async handlePrivateEvent(event) {
    const channel = event?.ch;
    const data = event?.data;
    this.state.lastPrivateEvent = { channel: channel || null, event: data?.event || null, at: Date.now() };
    if (channel === 'position' && data) {
      const positionId = String(data.positionId || '');
      if (positionId) {
        this.state.positions = this.state.positions.filter(position => String(position.positionId) !== positionId);
        if (data.event !== 'CLOSE') {
          this.state.positions.push({
            positionId,
            symbol: data.symbol,
            side: data.side === 'LONG' ? 'BUY' : data.side === 'SHORT' ? 'SELL' : data.side,
            qty: data.qty,
            openedAt: data.ctime ? Date.parse(data.ctime) || Date.now() : Date.now(),
          });
        }
      }
    }
    if (channel === 'tpsl' && data?.status === 'FAILED') console.error('TP/SL private event failed:', data.positionId || data.orderId || 'unknown');
    if (!['order', 'position', 'tpsl'].includes(channel)) return null;
    if (this.privateRefreshInFlight) return this.privateRefreshInFlight;
    this.privateRefreshInFlight = this.reconcilePositions();
    try {
      return await this.privateRefreshInFlight;
    } finally {
      this.privateRefreshInFlight = null;
    }
  }

  // Everything option 8 asks for: the read, the price, the PnL of whatever is
  // open, and the open positions themselves. Returns null while it is too early
  // for the next report.
  async report({ lastSignal = null } = {}) {
    const now = Date.now();
    if (now < this.state.lastReport + CONFIG.report_interval_sec * 1000) return null;
    this.state.lastReport = now;
    const lines = [`<b>${now}</b> <code>${CONFIG.symbol}</code>`];
    if (lastSignal) {
      lines.push(`signal <b>${escText(lastSignal.signal)}</b> @ <code>${escText(String(lastSignal.price ?? lastSignal.lastPrice ?? '-'))}</code> (${Math.round(Number(lastSignal.confidence) || 0)}%)`);
      if (lastSignal.agreeingStrategies?.length) lines.push(`backed by ${escText(lastSignal.agreeingStrategies.join(', '))}`);
    }
    if (this.state.lastScan) lines.push(`last scan <b>${escText(this.state.lastScan)}</b>`);

    let positions = [];
    try {
      positions = await this.positionManager.fetchPositions();
    } catch (error) {
      lines.push(`positions unavailable: ${escText(error.message)}`);
    }
    if (!positions.length) {
      lines.push('no open positions');
      return lines.join('\n');
    }

    let totalPnl = 0;
    for (const position of positions) {
      let pnl = null;
      try {
        pnl = this.positionManager.unrealizedPnl(position);
      } catch (error) {
        pnl = null;
      }
      if (pnl !== null) totalPnl += pnl;
      const pnlText = pnl === null ? 'pnl n/a' : `pnl ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}`;
      lines.push(`${escText(position.positionId)} ${escText(position.side)} qty <code>${escText(String(position.size ?? '-'))}</code> mark <code>${escText(String(position.markPrice ?? '-'))}</code> ${pnlText}`);
    }
    lines.push(`total pnl ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} ${CONFIG.margin_coin || 'USDT'}`);
    return lines.join('\n');
  }

  // Scans, then the two position loops. The report is left to the caller so the
  // cycle is not driven twice and the interval is honoured in one place.
  async scanCycle() {
    let signal = null;
    let scanError = null;
    try {
      signal = await this.scanSignal();
    } catch (error) {
      scanError = error;
    }
    try { await this.guard(); } catch (error) { console.error('guard error:', error.message); }
    try { await this.midManage(); } catch (error) { console.error('manage error:', error.message); }
    if (scanError) throw scanError;
    return signal;
  }
}

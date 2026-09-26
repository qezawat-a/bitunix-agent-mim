import { strictListFromData } from '../bitunix/client.js';

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function formatPrice(value) {
  if (!finitePositive(value)) throw new Error('price must be a positive finite number');
  return String(Number(Number(value).toFixed(8)));
}

export class PositionManager {
  client;
  settings;
  state = { positions: [], lastManage: 0, lastGuard: 0, cooldownUntil: 0 };
  fetchInFlight = null;
  protectionAttempts = new Map();

  constructor(client, _symbol, settings) {
    this.client = client;
    this.settings = settings;
  }

  get symbol() {
    return this.settings.symbol;
  }

  async fetchMarkPrice(symbol) {
    if (typeof this.client.getTickers !== 'function') return null;
    try {
      const data = await this.client.getTickers(symbol);
      const ticker = Array.isArray(data) ? data[0] : data;
      const value = Number(ticker?.markPrice ?? ticker?.lastPrice ?? ticker?.price);
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  async fetchPositions() {
    if (this.fetchInFlight) return this.fetchInFlight;
    const symbol = this.symbol;
    this.fetchInFlight = (async () => {
      const data = await this.client.getPendingPositions(symbol);
      const positions = strictListFromData(data, ['positionList']);
      if (!positions) throw new Error('Bitunix positions response must contain an array');
      if (symbol !== this.symbol) throw new Error('symbol changed while positions were being fetched');
      const normalized = positions
        .filter(position => String(position.symbol || '').toUpperCase() === String(symbol).toUpperCase())
        .map(position => ({
          ...position,
          avgPrice: position.avgPrice ?? position.avgOpenPrice,
          openTime: position.openTime ?? position.ctime,
          side: position.side === 'LONG' ? 'BUY' : position.side === 'SHORT' ? 'SELL' : position.side,
          markPrice: position.markPrice ?? position.lastPrice,
        }));
      if (normalized.some(position => !finitePositive(position.markPrice))) {
        const markPrice = await this.fetchMarkPrice(symbol);
        if (markPrice) for (const position of normalized) {
          if (!finitePositive(position.markPrice)) position.markPrice = markPrice;
        }
      }
      this.state.positions = normalized;
      return this.state.positions;
    })();
    try {
      return await this.fetchInFlight;
    } finally {
      this.fetchInFlight = null;
    }
  }

  getAtr(entryPrice, atr) {
    return finitePositive(atr) ? Number(atr) : Number(entryPrice) * 0.01;
  }

  computeTPSL(entryPrice, direction, atr, confidence) {
    if (!finitePositive(entryPrice)) throw new Error('entryPrice must be positive');
    if (!['bullish', 'bearish'].includes(direction)) throw new Error('direction must be bullish or bearish');
    // Signal strength is the committee consensus, 0-100. A weak read takes the
    // bare ATR distance; a unanimous read takes three times it. There are no
    // min/max levels to configure: the exchange pair's own precision trims
    // whatever comes out.
    const strength = Math.min(100, Math.max(0, Number(confidence) || 0)) / 100;
    const mult = 1 + strength * 2;
    const atrDist = this.getAtr(entryPrice, atr) * mult;
    const tpDist = atrDist * 1.5;
    const slDist = atrDist * 1.2;
    if (atrDist <= 0) throw new Error('ATR distance must be positive');

    if (direction === 'bullish') {
      return {
        tpPrice: formatPrice(entryPrice + tpDist),
        slPrice: formatPrice(entryPrice - slDist),
        tpStopType: 'MARK_PRICE',
        slStopType: 'MARK_PRICE',
      };
    }
    return {
      tpPrice: formatPrice(entryPrice - tpDist),
      slPrice: formatPrice(entryPrice + slDist),
      tpStopType: 'MARK_PRICE',
      slStopType: 'MARK_PRICE',
    };
  }

  async placeTPSL(positionId, entryPrice, direction, atr, confidence) {
    const levels = this.computeTPSL(entryPrice, direction, atr, confidence);
    return this.client.placeTPSL({
      symbol: this.symbol,
      positionId,
      ...levels,
    });
  }

  favorableRoiPct(position) {
    const entry = Number(position.avgPrice);
    const mark = Number(position.markPrice);
    if (!finitePositive(entry) || !finitePositive(mark)) throw new Error('position entry and mark prices must be positive');
    const direction = position.side === 'BUY' ? 1 : position.side === 'SELL' ? -1 : 0;
    if (!direction) throw new Error('position side must be BUY or SELL');
    const leverage = finitePositive(this.settings.leverage) ? Number(this.settings.leverage) : 1;
    return ((mark - entry) / entry) * 100 * direction * leverage;
  }

  // Profit or loss in the margin coin, from the position's own entry and mark.
  unrealizedPnl(position) {
    const entry = Number(position.avgPrice);
    const mark = Number(position.markPrice);
    const size = Number(position.size ?? position.qty);
    if (!finitePositive(entry) || !finitePositive(mark) || !finitePositive(size)) return null;
    const direction = position.side === 'BUY' ? 1 : position.side === 'SELL' ? -1 : 0;
    if (!direction) return null;
    return (mark - entry) * size * direction;
  }

  currentStop(position) {
    const value = position.slPrice ?? position.stopPrice ?? position.stopLossPrice;
    const stop = Number(value);
    return finitePositive(stop) ? stop : null;
  }

  currentTakeProfit(position) {
    const value = position.tpPrice ?? position.takeProfitPrice ?? position.tpTriggerPrice;
    const target = Number(value);
    return finitePositive(target) ? target : null;
  }

  // A take-profit counts as protection. Bitunix's position TP/SL endpoint
  // replaces the whole pair, so treating a TP-only position as unprotected
  // overwrote a take-profit that was set by hand.
  hasProtection(position) {
    return Boolean(this.currentStop(position) || this.currentTakeProfit(position));
  }

  shouldTighten(position, candidate) {
    const current = this.currentStop(position);
    if (!current) return true;
    return position.side === 'BUY' ? candidate > current : candidate < current;
  }

  async checkBreakeven(position) {
    const entry = Number(position.avgPrice);
    if (!finitePositive(entry)) throw new Error('position entry price must be positive');
    if (this.favorableRoiPct(position) >= Number(this.settings.breakeven_threshold_pct)) {
      const current = this.currentStop(position);
      if (current && position.side === 'BUY' && entry <= current) return { skipped: 'stop already favorable' };
      if (current && position.side === 'SELL' && entry >= current) return { skipped: 'stop already favorable' };
      const result = await this.moveSLToEntry(position.positionId, entry);
      return { ...result, slPrice: formatPrice(entry) };
    }
    return { skipped: 'threshold not reached' };
  }

  async moveSLToEntry(positionId, entryPrice) {
    return this.client.modifyTPSL({
      symbol: this.symbol,
      positionId,
      slPrice: formatPrice(entryPrice),
      slStopType: 'MARK_PRICE',
      slOrderType: 'MARKET',
    });
  }

  async checkTrailing(position) {
    const entry = Number(position.avgPrice);
    const mark = Number(position.markPrice);
    if (!finitePositive(entry) || !finitePositive(mark)) throw new Error('position entry and mark prices must be positive');
    if (this.favorableRoiPct(position) >= Number(this.settings.trailing_trigger_roi_pct)) {
      const trailDist = entry * Number(this.settings.trailing_distance_pct) / 100;
      const newSL = position.side === 'BUY' ? mark - trailDist : mark + trailDist;
      if (!finitePositive(newSL) || !this.shouldTighten(position, newSL)) return { skipped: 'trailing would loosen stop' };
      const result = await this.updateTrailingSL(position.positionId, newSL);
      return { ...result, slPrice: formatPrice(newSL) };
    }
    return { skipped: 'threshold not reached' };
  }

  async updateTrailingSL(positionId, newSL) {
    return this.client.modifyTPSL({
      symbol: this.symbol,
      positionId,
      slPrice: formatPrice(newSL),
      slStopType: 'MARK_PRICE',
      slOrderType: 'MARKET',
    });
  }

  async checkLiquidationGuard(position) {
    const mark = Number(position.markPrice);
    const entry = Number(position.avgPrice);
    const liq = Number(position.liqPrice);
    if (!finitePositive(mark)) throw new Error('liquidation guard requires a mark price');
    if (position.liqPrice === undefined || position.liqPrice === null || position.liqPrice === '') throw new Error('liquidation guard requires a liquidation price');
    if (!Number.isFinite(liq) || liq <= 0) return { skipped: 'no active liquidation price' };
    if (!finitePositive(entry)) return { skipped: 'liquidation guard requires an entry price' };
    // sl_liquidation_safety is a fraction (0.01-1) of the room to liquidation,
    // not a percentage, so it is compared as-is.
    const room = Math.abs(entry - liq) / entry;
    if (!finitePositive(room)) return { skipped: 'liquidation price sits at entry' };
    const direction = position.side === 'BUY' ? 1 : position.side === 'SELL' ? -1 : 0;
    if (!direction) return { skipped: 'position has no side to judge against' };
    // Negative while the trade is in profit, so only a loss counts against it.
    const adverse = -(((mark - entry) / entry) * direction);
    const givenBack = Math.min(1, Math.max(0, adverse) / room);
    const safety = Number(this.settings.sl_liquidation_safety);
    if (givenBack < safety) {
      return { skipped: `liquidation room intact, ${Math.round(givenBack * 100)}% of ${Math.round(safety * 100)}% given back` };
    }
    this.state.cooldownUntil = Date.now() + Number(this.settings.cooldown_minutes) * 60000;
    return this.client.closePosition(this.symbol, position.positionId, position);
  }

  async ensureProtection(position) {
    if (this.hasProtection(position)) return { skipped: 'protection already present' };
    const key = String(position.positionId);
    const lastAttempt = this.protectionAttempts.get(key) || 0;
    if (Date.now() - lastAttempt < 60000) return { skipped: 'protection retry pending' };
    this.protectionAttempts.set(key, Date.now());
    const direction = position.side === 'BUY' ? 'bullish' : position.side === 'SELL' ? 'bearish' : null;
    if (!direction) throw new Error(`position ${key} has an invalid side for TP/SL`);
    try {
      const pendingData = await this.client.getPendingTPSL(this.symbol);
      const pending = strictListFromData(pendingData, ['orderList']);
      if (!pending) throw new Error('pending TP/SL response must contain an array');
      // Any take-profit or stop already registered against this position is
      // left exactly as it is; the position TP/SL endpoint would replace it.
      const existing = pending.find(item => String(item.positionId) === key
        && (finitePositive(item.tpPrice ?? item.takeProfitPrice) || finitePositive(item.slPrice ?? item.stopPrice)));
      if (existing) return { verified: true, result: existing };
      const result = await this.placeTPSL(position.positionId, Number(position.avgPrice), direction, position.atr, this.settings.min_confidence);
      return { placed: true, result };
    } catch (error) {
      this.state.lastProtectionError = { positionId: key, message: error.message, at: Date.now() };
      if (this.settings.on_tpsl_failure === 'close') {
        const closeResult = await this.client.closePosition(this.symbol, position.positionId, position);
        return { closed: true, result: closeResult, error: error.message };
      }
      // 'cancel' and 'alert' are the same thing here: an unprotected position
      // left in place and reported. Retrying is throttled by protectionAttempts.
      throw new Error(`TP/SL protection failed: ${error.message}`);
    }
  }

  async midManage() {
    await this.fetchPositions();
    const errors = [];
    for (const position of this.state.positions) {
      let protectionFailed = false;
      try {
        const protection = await this.ensureProtection(position);
        if (protection?.closed) {
          this.state.cooldownUntil = Date.now() + Number(this.settings.cooldown_minutes) * 60000;
          continue;
        }
      } catch (error) {
        errors.push({ positionId: position.positionId, message: error.message });
        protectionFailed = true;
      }
      if (protectionFailed) continue;
      try {
        const breakeven = await this.checkBreakeven(position);
        if (breakeven?.slPrice) position.slPrice = breakeven.slPrice;
        const trailing = await this.checkTrailing(position);
        if (trailing?.slPrice) position.slPrice = trailing.slPrice;
        await this.checkLiquidationGuard(position);
      } catch (error) {
        errors.push({ positionId: position.positionId, message: error.message });
      }
    }
    return errors;
  }
}

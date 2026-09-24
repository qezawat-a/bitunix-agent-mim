import { BitunixClient } from '../bitunix/client.js';
import { CONFIG } from '../config.js';

export class PositionManager {
  client;
  symbol;
  settings;
  state = { positions: [], lastManage: 0, lastGuard: 0, cooldownUntil: 0 };

  constructor(client, symbol, settings) {
    this.client = client;
    this.symbol = symbol;
    this.settings = settings;
  }

  async fetchPositions() {
    const data = await this.client.getPendingPositions(this.symbol);
    if (Array.isArray(data)) {
      this.state.positions = data.filter(p => p.symbol === this.symbol);
    }
    return this.state.positions;
  }

  getAtr(entryPrice, atr) {
    return atr || entryPrice * 0.01;
  }

  computeTPSL(entryPrice, direction, atr, confidence) {
    const mult = Math.max(1, Math.min(3, confidence / 40));
    const atrDist = this.getAtr(entryPrice, atr) * mult;
    const tpDist = atrDist * 1.5;
    const slDist = atrDist * 1.2;

    if (direction === 'bullish') {
      return {
        tpPrice: (entryPrice + tpDist).toFixed(2),
        slPrice: (entryPrice - slDist).toFixed(2),
        tpStopType: 'MARK_PRICE',
        slStopType: 'MARK_PRICE',
      };
    } else if (direction === 'bearish') {
      return {
        tpPrice: (entryPrice - tpDist).toFixed(2),
        slPrice: (entryPrice + slDist).toFixed(2),
        tpStopType: 'MARK_PRICE',
        slStopType: 'MARK_PRICE',
      };
    }
    return null;
  }

  async placeTPSL(positionId, entryPrice, direction, atr, confidence) {
    const { tpPrice, slPrice, tpStopType, slStopType } = this.computeTPSL(entryPrice, direction, atr, confidence);
    if (!tpPrice) return null;
    const params = {
      symbol: this.symbol,
      positionId,
      tpPrice,
      slPrice,
      tpStopType,
      slStopType,
      tpOrderType: 'MARKET',
      slOrderType: 'MARKET',
    };
    return this.client.placeTPSL(params);
  }

  async checkBreakeven(position) {
    const entry = parseFloat(position.avgPrice || 0);
    const mark = parseFloat(position.markPrice || 0);
    if (!entry || !mark) return;
    const roi = ((mark - entry) / entry) * 100 * (position.side === 'BUY' ? 1 : -1);
    if (roi >= this.settings.breakeven_threshold_pct) {
      await this.moveSLToEntry(position.positionId, entry);
    }
  }

  async moveSLToEntry(positionId, entryPrice) {
    const params = {
      symbol: this.symbol,
      positionId,
      slPrice: entryPrice.toFixed(2),
      slStopType: 'MARK_PRICE',
      slOrderType: 'MARKET',
    };
    return this.client.modifyTPSL(params);
  }

  async checkTrailing(position) {
    const entry = parseFloat(position.avgPrice || 0);
    const mark = parseFloat(position.markPrice || 0);
    if (!entry || !mark) return;
    const roi = ((mark - entry) / entry) * 100 * (position.side === 'BUY' ? 1 : -1);
    if (roi >= this.settings.trailing_trigger_roi_pct) {
      const trailDist = entry * this.settings.trailing_distance_pct / 100;
      const newSL = position.side === 'BUY' ? mark - trailDist : mark + trailDist;
      await this.updateTrailingSL(position.positionId, newSL);
    }
  }

  async updateTrailingSL(positionId, newSL) {
    const params = {
      symbol: this.symbol,
      positionId,
      slPrice: newSL.toFixed(2),
      slStopType: 'MARK_PRICE',
      slOrderType: 'MARKET',
    };
    return this.client.modifyTPSL(params);
  }

  async checkLiquidationGuard(position) {
    const mark = parseFloat(position.markPrice || 0);
    const liq = parseFloat(position.liqPrice || 0);
    if (!mark || !liq) return;
    const dist = Math.abs(mark - liq) / mark;
    if (dist < this.settings.sl_liquidation_safety / 100) {
      await this.client.closeAllPosition(this.symbol);
    }
  }

  async midManage() {
    await this.fetchPositions();
    for (const pos of this.state.positions) {
      await this.checkBreakeven(pos);
      await this.checkTrailing(pos);
      await this.checkLiquidationGuard(pos);
    }
  }
}
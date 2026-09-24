import { CONFIG } from '../config.js';

export function computeQty({ available, price, leverage }) {
  if (!available || !price) return 0;
  const notional = (available * CONFIG.margin_amount_pct) / 100;
  const size = (notional / price) * (leverage || CONFIG.leverage);
  return Math.max(0, Math.floor(size * 10000) / 10000);
}

export function liqDistanceOk({ markPrice, liqPrice }) {
  if (!markPrice || !liqPrice) return true;
  const dist = Math.abs(markPrice - liqPrice) / markPrice;
  const min = (CONFIG.sl_liquidation_safety || 0.6) / 100;
  return dist >= min;
}

export function positionAllowed({ openCount }) {
  return (openCount || 0) < (CONFIG.max_positions || 3);
}

export function marginOk({ available, requiredMargin }) {
  if (!requiredMargin) return true;
  return (available || 0) >= requiredMargin;
}

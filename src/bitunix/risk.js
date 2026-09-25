import { CONFIG } from '../config.js';

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export function computeQty({ available, price, leverage }) {
  if (!positiveNumber(available) || !positiveNumber(price)) return 0;
  const selectedLeverage = Number.isInteger(leverage) ? leverage : CONFIG.leverage;
  if (!Number.isInteger(selectedLeverage) || selectedLeverage < 1 || selectedLeverage > 125) return 0;
  const notional = Number(available) * Number(CONFIG.margin_amount_pct) / 100;
  const size = notional / Number(price) * selectedLeverage;
  return Number.isFinite(size) && size > 0 ? Math.floor(size * 10000) / 10000 : 0;
}

export function liqDistanceOk({ markPrice, liqPrice }) {
  if (!positiveNumber(markPrice)) return false;
  if (liqPrice === undefined || liqPrice === null || liqPrice === '') return false;
  const liquidation = Number(liqPrice);
  if (!Number.isFinite(liquidation) || liquidation <= 0) return true;
  const distance = Math.abs(Number(markPrice) - liquidation) / Number(markPrice);
  const minimum = Number(CONFIG.sl_liquidation_safety) / 100;
  return Number.isFinite(distance) && Number.isFinite(minimum) && distance >= minimum;
}

export function positionAllowed({ openCount }) {
  const count = Number(openCount);
  const maximum = Number(CONFIG.max_positions);
  return Number.isInteger(count) && count >= 0 && Number.isInteger(maximum) && maximum > 0 && count < maximum;
}

export function marginOk({ available, requiredMargin }) {
  const availableValue = Number(available);
  const requiredValue = Number(requiredMargin);
  return Number.isFinite(availableValue) && Number.isFinite(requiredValue) && requiredValue >= 0 && availableValue >= requiredValue;
}

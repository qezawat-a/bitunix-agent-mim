import { CONFIG } from '../config.js';

export function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let ema = arr[0];
  for (let i = 1; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}

export function rsi(arr, period = 14) {
  if (arr.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < arr.length; i++) changes.push(arr[i] - arr[i - 1]);
  const gains = changes.filter(c => c > 0);
  const losses = changes.filter(c => c < 0).map(c => Math.abs(c));
  if (gains.length === 0 && losses.length === 0) return 50;
  const avgGains = gains.reduce((a, b) => a + b, 0) / period;
  const avgLosses = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLosses === 0) return 100;
  const rs = avgGains / avgLosses;
  return Math.min(100, Math.max(0, 100 - 100 / (1 + rs)));
}

export function macd(arr, fast = 12, slow = 26, signal = 9) {
  if (arr.length < slow) return null;
  const emaFast = ema(arr.slice(-slow), fast);
  const emaSlow = ema(arr.slice(-slow), slow);
  if (emaFast == null || emaSlow == null) return null;
  const dif = emaFast - emaSlow;
  const dea = dif; // simplified: returns raw dif as proxy
  const hist = dif - dea;
  if (hist > 0) return 'bullish';
  if (hist < 0) return 'bearish';
  return 'neutral';
}

export function bollinger(arr, period = 20, mult = 2) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = mid + mult * std;
  const lower = mid - mult * std;
  return { mid, upper, lower };
}

export function atr(highs, lows, closes, period = 14) {
  if (highs.length < period || lows.length < period) return null;
  const trs = [];
  for (let i = highs.length - period; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1] || 0);
    const lc = Math.abs(lows[i] - closes[i - 1] || 0);
    trs.push(Math.max(hl, hc, lc));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

export function adx(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  let plusDM = 0, minusDM = 0;
  for (let i = highs.length - period; i < highs.length; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    if (up > down && up > 0) plusDM += up;
    else if (down > up && down > 0) minusDM += down;
  }
  const atrVal = atr(highs.slice(-period), lows.slice(-period), closes.slice(-period), period) || 1;
  const plusDI = (plusDM / atrVal) * 100;
  const minusDI = (minusDM / atrVal) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  return dx;
}

export function volumeScore(volumes, period = 20) {
  if (volumes.length < period) return null;
  const recent = volumes.slice(-period);
  const avg = recent.reduce((a, b) => a + b, 0) / period;
  const last = volumes[volumes.length - 1];
  if (avg === 0) return 0;
  return (last / avg - 1) * 100;
}

export function momentumScore(closes, period = 10) {
  if (closes.length < period + 1) return null;
  return ((closes[closes.length - 1] - closes[closes.length - 1 - period]) / closes[closes.length - 1 - period]) * 100;
}

export function fundingSignal(fundingRate) {
  if (fundingRate > 0.0005) return 'bearish';
  if (fundingRate < -0.0005) return 'bullish';
  return 'neutral';
}

export function computeSignal(symbolKlines, volumes, fundingRate) {
  const closes = symbolKlines.map(k => parseFloat(k.close));
  const highs = symbolKlines.map(k => parseFloat(k.high));
  const lows = symbolKlines.map(k => parseFloat(k.low));
  const last = closes[closes.length - 1];

  const signals = {};
  const emaVal = ema(closes, 20);
  const emaFast = ema(closes, 50);
  const rsiVal = rsi(closes);
  const macdVal = macd(closes);
  const bb = bollinger(closes);
  const atrVal = atr(highs, lows, closes);
  const adxVal = adx(highs, lows, closes);
  const momVal = momentumScore(closes);
  const volScore = volumeScore(volumes);
  const funding = fundingSignal(fundingRate);

  let score = 0;
  if (emaVal && emaFast && last > emaVal && last > emaFast) { score += 25; signals.ema = 'bullish'; }
  else if (emaVal && emaFast && last < emaVal && last < emaFast) { score -= 25; signals.ema = 'bearish'; }
  else signals.ema = 'neutral';

  if (rsiVal != null) {
    if (rsiVal < 30) { score += 20; signals.rsi = 'oversold'; }
    else if (rsiVal > 70) { score -= 20; signals.rsi = 'overbought'; }
    else { score += 5; signals.rsi = 'neutral'; }
  }

  if (macdVal) {
    if (macdVal === 'bullish') { score += 20; signals.macd = 'bullish'; }
    else if (macdVal === 'bearish') { score -= 20; signals.macd = 'bearish'; }
    else signals.macd = 'neutral';
  }

  if (bb && last < bb.lower) { score += 20; signals.bollinger = 'oversold'; }
  else if (bb && last > bb.upper) { score -= 20; signals.bollinger = 'overbought'; }
  else signals.bollinger = 'neutral';

  if (momVal != null) {
    if (momVal > 1) { score += 15; signals.momentum = 'bullish'; }
    else if (momVal < -1) { score -= 15; signals.momentum = 'bearish'; }
    else signals.momentum = 'neutral';
  }

  if (volScore != null && volScore > 10) { score += 10; signals.volume = 'confirming'; }
  else signals.volume = 'neutral';

  if (adxVal != null && adxVal > 25) { score += 10; signals.adx = 'trending'; }
  else signals.adx = 'neutral';

  if (funding) {
    if (funding === 'bullish') score += 5;
    else if (funding === 'bearish') score -= 5;
  }
  signals.funding = funding;

  const confidence = Math.min(100, Math.max(0, Math.round(Math.abs(score))));
  const direction = score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
  return { confidence, direction, signals, score, atr: atrVal, last };
}

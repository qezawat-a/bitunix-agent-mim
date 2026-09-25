function validSeries(values) {
  return Array.isArray(values) && values.every(value => Number.isFinite(value));
}

function alignedEma(values, period) {
  if (!validSeries(values) || period < 1 || values.length < period) return [];
  const output = new Array(values.length).fill(null);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  output[period - 1] = value;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index++) {
    value = (values[index] - value) * multiplier + value;
    output[index] = value;
  }
  return output;
}

export function ema(arr, period) {
  const series = alignedEma(arr, period);
  return series.length ? series[series.length - 1] : null;
}

export function rsi(arr, period = 14) {
  if (!validSeries(arr) || period < 1 || arr.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index++) {
    const change = arr[index] - arr[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let averageGains = gains / period;
  let averageLosses = losses / period;
  for (let index = period + 1; index < arr.length; index++) {
    const change = arr[index] - arr[index - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    averageGains = ((averageGains * (period - 1)) + gain) / period;
    averageLosses = ((averageLosses * (period - 1)) + loss) / period;
  }
  if (averageGains === 0 && averageLosses === 0) return 50;
  if (averageLosses === 0) return 100;
  if (averageGains === 0) return 0;
  return Math.min(100, Math.max(0, 100 - (100 / (1 + (averageGains / averageLosses)))));
}

export function macd(arr, fast = 12, slow = 26, signal = 9) {
  if (!validSeries(arr) || arr.length < slow + signal - 1 || fast >= slow) return null;
  const fastSeries = alignedEma(arr, fast);
  const slowSeries = alignedEma(arr, slow);
  const differences = [];
  for (let index = slow - 1; index < arr.length; index++) {
    differences.push(fastSeries[index] - slowSeries[index]);
  }
  const signalSeries = alignedEma(differences, signal);
  if (!signalSeries.length) return null;
  const histogram = differences[differences.length - 1] - signalSeries[signalSeries.length - 1];
  if (histogram > 0) return 'bullish';
  if (histogram < 0) return 'bearish';
  return 'neutral';
}

export function superTrend(highs, lows, closes, period = 10, multiplier = 3) {
  if (!validSeries(highs) || !validSeries(lows) || !validSeries(closes) || period < 2 || multiplier <= 0 || highs.length < period + 1 || highs.length !== lows.length || highs.length !== closes.length) return null;
  if (new Set(closes).size === 1) return 'neutral';
  const ranges = [];
  for (let index = 1; index < closes.length; index++) {
    ranges.push(Math.max(
      highs[index] - lows[index],
      Math.abs(highs[index] - closes[index - 1]),
      Math.abs(lows[index] - closes[index - 1])
    ));
  }
  let previousUpper = null;
  let previousLower = null;
  let previousClose = null;
  let trend = 'neutral';
  for (let index = period - 1; index < ranges.length; index++) {
    const slice = ranges.slice(0, index + 1);
    const averageRange = slice.slice(-period).reduce((sum, value) => sum + value, 0) / Math.min(period, slice.length);
    const midpoint = (highs[index + 1] + lows[index + 1]) / 2;
    const basicUpper = midpoint + averageRange * multiplier;
    const basicLower = midpoint - averageRange * multiplier;
    const upper = previousUpper === null || basicUpper < previousUpper || (previousClose !== null && previousClose > previousUpper)
      ? basicUpper
      : previousUpper;
    const lower = previousLower === null || basicLower > previousLower || (previousClose !== null && previousClose < previousLower)
      ? basicLower
      : previousLower;
    const close = closes[index + 1];
    const priorClose = closes[index] ?? close;
    if (previousUpper === null) trend = close > upper || close > priorClose ? 'bullish' : close < lower || close < priorClose ? 'bearish' : 'neutral';
    else if (trend === 'bullish' && close < lower) trend = 'bearish';
    else if (trend === 'bearish' && close > upper) trend = 'bullish';
    else if (trend === 'neutral' && close > lower && close > previousClose) trend = 'bullish';
    else if (trend === 'neutral' && close < upper && close < previousClose) trend = 'bearish';
    previousUpper = upper;
    previousLower = lower;
    previousClose = close;
  }
  return trend;
}

export const supertrend = superTrend;

export function atrBreakout(highs, lows, closes, lookback = 20, atrPeriod = 14, threshold = 0.5) {
  if (!validSeries(highs) || !validSeries(lows) || !validSeries(closes) || lookback < 2 || atrPeriod < 2 || threshold < 0 || highs.length < lookback + atrPeriod + 2 || highs.length !== lows.length || highs.length !== closes.length) return 'neutral';
  const range = atr(highs, lows, closes, atrPeriod);
  if (range === null || range <= 0) return 'neutral';
  const priorHigh = Math.max(...highs.slice(-lookback - 1, -1));
  const priorLow = Math.min(...lows.slice(-lookback - 1, -1));
  const priorClose = closes[closes.length - 2];
  const close = closes[closes.length - 1];
  if (priorClose <= priorHigh && close > priorHigh + range * threshold) return 'bullish';
  if (priorClose >= priorLow && close < priorLow - range * threshold) return 'bearish';
  return 'neutral';
}

export function bollinger(arr, period = 20, mult = 2) {
  if (!validSeries(arr) || arr.length < period || period < 1) return null;
  const slice = arr.slice(-period);
  const mid = slice.reduce((sum, value) => sum + value, 0) / period;
  const variance = slice.reduce((sum, value) => sum + (value - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { mid, upper: mid + mult * std, lower: mid - mult * std };
}

export function atr(highs, lows, closes, period = 14) {
  if (!validSeries(highs) || !validSeries(lows) || !validSeries(closes) || period < 1 || highs.length < period + 1 || highs.length !== lows.length || highs.length !== closes.length) return null;
  const trueRanges = [];
  for (let index = 1; index < highs.length; index++) {
    trueRanges.push(Math.max(
      highs[index] - lows[index],
      Math.abs(highs[index] - closes[index - 1]),
      Math.abs(lows[index] - closes[index - 1])
    ));
  }
  const recent = trueRanges.slice(-period);
  return recent.reduce((sum, value) => sum + value, 0) / period;
}

export function adx(highs, lows, closes, period = 14) {
  if (!validSeries(highs) || !validSeries(lows) || !validSeries(closes) || period < 1 || highs.length < period + 1 || highs.length !== lows.length || highs.length !== closes.length) return null;
  const trueRanges = [];
  const positiveMovement = [];
  const negativeMovement = [];
  for (let index = 1; index < highs.length; index++) {
    const trueRange = Math.max(
      highs[index] - lows[index],
      Math.abs(highs[index] - closes[index - 1]),
      Math.abs(lows[index] - closes[index - 1])
    );
    const up = highs[index] - highs[index - 1];
    const down = lows[index - 1] - lows[index];
    trueRanges.push(trueRange);
    positiveMovement.push(up > down && up > 0 ? up : 0);
    negativeMovement.push(down > up && down > 0 ? down : 0);
  }
  let tr = 0;
  let plus = 0;
  let minus = 0;
  for (let index = 0; index < period; index++) {
    tr += trueRanges[index];
    plus += positiveMovement[index];
    minus += negativeMovement[index];
  }
  const dx = [];
  const pushDx = () => {
    if (tr <= 0) {
      dx.push(0);
      return;
    }
    const plusDi = plus / tr * 100;
    const minusDi = minus / tr * 100;
    dx.push(Math.abs(plusDi - minusDi) / (plusDi + minusDi || 1) * 100);
  };
  pushDx();
  for (let index = period; index < trueRanges.length; index++) {
    tr = tr - tr / period + trueRanges[index];
    plus = plus - plus / period + positiveMovement[index];
    minus = minus - minus / period + negativeMovement[index];
    pushDx();
  }
  if (!dx.length) return null;
  if (dx.length < period) return dx.reduce((sum, value) => sum + value, 0) / dx.length;
  let value = dx.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let index = period; index < dx.length; index++) value = ((value * (period - 1)) + dx[index]) / period;
  return value;
}

export function volumeScore(volumes, period = 20) {
  if (!validSeries(volumes) || volumes.length < period) return null;
  const recent = volumes.slice(-period);
  const average = recent.reduce((sum, value) => sum + value, 0) / period;
  const last = volumes[volumes.length - 1];
  return average === 0 ? 0 : (last / average - 1) * 100;
}

export function momentumScore(closes, period = 10) {
  if (!validSeries(closes) || closes.length < period + 1) return null;
  const start = closes[closes.length - 1 - period];
  return start === 0 ? null : ((closes[closes.length - 1] - start) / start) * 100;
}

export function fundingSignal(fundingRate) {
  if (!Number.isFinite(Number(fundingRate))) return 'neutral';
  const rate = Number(fundingRate);
  if (rate > 0.0005) return 'bearish';
  if (rate < -0.0005) return 'bullish';
  return 'neutral';
}

export function computeSignal(symbolKlines, volumes, fundingRate) {
  if (!Array.isArray(symbolKlines) || symbolKlines.length < 60) throw new Error('at least 60 valid klines are required');
  if (!validSeries(volumes) || volumes.length < 20) throw new Error('at least 20 valid volumes are required');
  const closes = symbolKlines.map(k => parseFloat(k.close));
  const highs = symbolKlines.map(k => parseFloat(k.high));
  const lows = symbolKlines.map(k => parseFloat(k.low));
  if (!validSeries(closes) || !validSeries(highs) || !validSeries(lows) || closes.some(value => value <= 0) || highs.some(value => value <= 0) || lows.some(value => value <= 0)) {
    throw new Error('kline values must be positive finite numbers');
  }
  const last = closes[closes.length - 1];
  const signals = {};
  const emaValue = ema(closes, 20);
  const emaFast = ema(closes, 50);
  const rsiValue = rsi(closes);
  const macdValue = macd(closes);
  const bands = bollinger(closes);
  const atrValue = atr(highs, lows, closes);
  const adxValue = adx(highs, lows, closes);
  const superTrendValue = superTrend(highs, lows, closes);
  const atrBreakoutValue = atrBreakout(highs, lows, closes);
  const momentum = momentumScore(closes);
  const volume = volumeScore(volumes);
  const funding = fundingSignal(fundingRate);

  let score = 0;
  if (emaValue && emaFast && last > emaValue && last > emaFast) { score += 25; signals.ema = 'bullish'; }
  else if (emaValue && emaFast && last < emaValue && last < emaFast) { score -= 25; signals.ema = 'bearish'; }
  else signals.ema = 'neutral';

  if (rsiValue !== null) {
    if (rsiValue < 30) { score += 20; signals.rsi = 'oversold'; }
    else if (rsiValue > 70) { score -= 20; signals.rsi = 'overbought'; }
    else { score += 5; signals.rsi = 'neutral'; }
  }

  if (macdValue === 'bullish') { score += 20; signals.macd = 'bullish'; }
  else if (macdValue === 'bearish') { score -= 20; signals.macd = 'bearish'; }
  else signals.macd = 'neutral';

  if (bands && last < bands.lower) { score += 20; signals.bollinger = 'oversold'; }
  else if (bands && last > bands.upper) { score -= 20; signals.bollinger = 'overbought'; }
  else signals.bollinger = 'neutral';

  if (momentum !== null) {
    if (momentum > 1) { score += 15; signals.momentum = 'bullish'; }
    else if (momentum < -1) { score -= 15; signals.momentum = 'bearish'; }
    else signals.momentum = 'neutral';
  }

  if (volume !== null && volume > 10) { score += 10; signals.volume = 'confirming'; }
  else signals.volume = 'neutral';
  if (adxValue !== null && adxValue > 25) { score += 10; signals.adx = 'trending'; }
  else signals.adx = 'neutral';
  if (superTrendValue === 'bullish') { score += 20; signals.supertrend = 'bullish'; }
  else if (superTrendValue === 'bearish') { score -= 20; signals.supertrend = 'bearish'; }
  else signals.supertrend = 'neutral';
  if (atrBreakoutValue === 'bullish') { score += 25; signals.atr_breakout = 'bullish'; }
  else if (atrBreakoutValue === 'bearish') { score -= 25; signals.atr_breakout = 'bearish'; }
  else signals.atr_breakout = 'neutral';
  if (funding === 'bullish') score += 5;
  else if (funding === 'bearish') score -= 5;
  signals.funding = funding;

  const confidence = Math.min(100, Math.max(0, Math.round(Math.abs(score))));
  const direction = score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
  return { confidence, direction, signals, score, atr: atrValue, last };
}

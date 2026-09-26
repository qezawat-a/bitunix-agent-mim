import { computeSignal } from './indicators.js';
import { CONFIG } from '../config.js';

class Scanner {
  client;

  constructor(client) {
    this.client = client;
  }

  async getKlinesFor(symbol, timeframes) {
    const output = {};
    for (const timeframe of timeframes) {
      const klines = await this.client.getKlines(symbol, timeframe, 200);
      if (!Array.isArray(klines) || klines.length < 60) throw new Error(`invalid ${timeframe} kline response for ${symbol}`);
      output[timeframe] = klines;
    }
    return output;
  }

  async getFunding(symbol) {
    try {
      const data = await this.client.getFundingRate(symbol);
      const record = Array.isArray(data) ? data[0] : data;
      const value = Number(record?.fundingRate ?? record?.value);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  async scan(symbol) {
    const timeframes = CONFIG.timeframes;
    const klinesMap = await this.getKlinesFor(symbol, timeframes);
    const funding = await this.getFunding(symbol);
    const tfSignals = {};
    const directionCounts = { bullish: 0, bearish: 0, neutral: 0 };
    const allDirectionCounts = { bullish: 0, bearish: 0, neutral: 0 };
    let confidenceSum = 0;
    let validCount = 0;
    const agreementByDirection = { bullish: [], bearish: [] };

    for (const timeframe of timeframes) {
      const klines = klinesMap[timeframe];
      const volumes = klines.map(kline => Number(kline.baseVol));
      const result = computeSignal(klines, volumes, funding);
      tfSignals[timeframe] = result;
      allDirectionCounts[result.direction]++;
      if (result.confidence >= CONFIG.tf_min_confidence) {
        validCount++;
        confidenceSum += result.confidence;
        directionCounts[result.direction]++;
        if (result.direction !== 'neutral') agreementByDirection[result.direction].push(result.agreeing);
      }
    }

    const direction = directionCounts.bullish === directionCounts.bearish
      ? 'neutral'
      : directionCounts.bullish > directionCounts.bearish ? 'bullish' : 'bearish';

    // min_agreeing_strategies counts strategies, not timeframes: it is how many
    // of the committee backed the winning direction, averaged over the
    // timeframes that cleared tf_min_confidence.
    const agreements = direction === 'neutral' ? [] : agreementByDirection[direction];
    const strategyAgreement = agreements.length
      ? agreements.reduce((sum, value) => sum + value, 0) / agreements.length
      : 0;

    const averageConfidence = validCount ? confidenceSum / validCount : 0;
    let signal = 'hold';
    let confidence = 0;
    const reasons = [];
    if (!validCount) reasons.push('no_timeframe_above_tf_min');
    if (averageConfidence < CONFIG.min_confidence) reasons.push('confidence_below_min');
    if (strategyAgreement < CONFIG.min_agreeing_strategies) reasons.push('not_enough_strategies_agreeing');
    if (direction === 'neutral') reasons.push('timeframes_disagree');

    if (!reasons.length) {
      signal = direction;
      confidence = Math.min(100, Math.round(averageConfidence));
    }

    const lastPrice = klinesMap[timeframes[0]]?.slice(-1)[0]?.close;
    if (!Number.isFinite(Number(lastPrice)) || Number(lastPrice) <= 0) throw new Error(`invalid latest price for ${symbol}`);
    // Trim to the pair's quotePrecision here, once, so every consumer (report,
    // /signal, the agent prompt, the order path) shows the price the exchange
    // itself quotes instead of the raw kline close.
    let price = Number(lastPrice);
    try {
      const rules = await this.client.getSymbolRules(symbol);
      if (Number.isInteger(rules?.quotePrecision)) {
        price = Number(price.toFixed(rules.quotePrecision));
      }
    } catch {}
    return {
      symbol,
      signal,
      confidence,
      // Raw committee read, ungated: the reversal check must still see a strong
      // opposite direction on a scan that was too weak to open anything.
      direction,
      rawConfidence: Math.round(averageConfidence * 100) / 100,
      lastPrice: price,
      price,
      tfSignals,
      directionCounts,
      allDirectionCounts,
      strategyAgreement: Math.round(strategyAgreement * 100) / 100,
      agreeingStrategies: this.strategiesBehind(symbol, timeframes, tfSignals, direction),
      blockedBy: reasons,
    };
  }

  strategiesBehind(symbol, timeframes, tfSignals, direction) {
    if (direction === 'neutral') return [];
    const wanted = direction === 'bullish' ? 1 : -1;
    const seen = new Set();
    for (const timeframe of timeframes) {
      const result = tfSignals[timeframe];
      if (!result || result.direction !== direction) continue;
      for (const item of result.votes) {
        if (item.direction === wanted) seen.add(item.name);
      }
    }
    return [...seen].sort();
  }
}

export default Scanner;

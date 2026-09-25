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
    let scoreSum = 0;
    let validCount = 0;
    let agree = 0;

    for (const timeframe of timeframes) {
      const klines = klinesMap[timeframe];
      const volumes = klines.map(kline => Number(kline.baseVol));
      const result = computeSignal(klines, volumes, funding);
      tfSignals[timeframe] = result;
      allDirectionCounts[result.direction]++;
      if (result.confidence >= CONFIG.tf_min_confidence) {
        validCount++;
        scoreSum += result.confidence;
        directionCounts[result.direction]++;
        if (result.direction !== 'neutral') agree++;
      }
    }

    const direction = directionCounts.bullish === directionCounts.bearish
      ? 'neutral'
      : directionCounts.bullish > directionCounts.bearish ? 'bullish' : 'bearish';
    const averageConfidence = validCount ? scoreSum / validCount : 0;
    let signal = 'hold';
    let confidence = 0;
    if (averageConfidence >= CONFIG.min_confidence && validCount >= CONFIG.min_agreeing_strategies && agree >= CONFIG.min_agreeing_strategies && direction !== 'neutral') {
      signal = direction;
      confidence = Math.min(100, averageConfidence);
    }

    const lastPrice = klinesMap[timeframes[0]]?.slice(-1)[0]?.close;
    if (!Number.isFinite(Number(lastPrice)) || Number(lastPrice) <= 0) throw new Error(`invalid latest price for ${symbol}`);
    return { symbol, signal, confidence, lastPrice, tfSignals, directionCounts, allDirectionCounts };
  }
}

export default Scanner;

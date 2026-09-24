import { BitunixClient } from './client.js';
import { computeSignal } from './indicators.js';
import { CONFIG } from '../config.js';

class Scanner {
  client;
  constructor(client) { this.client = client; }

  async getKlinesFor(symbol, tfs) {
    const out = {};
    for (const tf of tfs) {
      const kl = await this.client.getKlines(symbol, tf, 200);
      out[tf] = kl || [];
    }
    return out;
  }

  async getVolumes(symbol) {
    const kl = await this.client.getKlines(symbol, '1m', 200);
    return kl.map(k => parseFloat(k.baseVol || 0));
  }

  async getFunding(symbol) {
    try {
      const data = await this.client.getFundingRate(symbol);
      return typeof data?.value === 'number' ? data.value : 0;
    } catch { return 0; }
  }

  async scan(symbol) {
    const tfs = CONFIG.timeframes;
    const klinesMap = await this.getKlinesFor(symbol, tfs);
    const volumes = await this.getVolumes(symbol);
    const funding = await this.getFunding(symbol);

    const tfSignals = {};
    let scoreSum = 0;
    let validCount = 0;
    let agree = 0;
    const lastPrice = klinesMap[tfs[0]]?.slice(-1)[0]?.close;

    for (const tf of tfs) {
      const kl = klinesMap[tf] || [];
      const res = computeSignal(kl, volumes, funding);
      tfSignals[tf] = res;
      if (res.confidence >= CONFIG.tf_min_confidence) {
        validCount += 1;
        scoreSum += res.confidence;
        if (res.direction !== 'neutral') agree += 1;
      }
    }

    const directionCounts = { bullish: 0, bearish: 0, neutral: 0 };
    Object.values(tfSignals).forEach(s => { directionCounts[s.direction]++; });
    const agreedDirection = Object.entries(directionCounts).reduce((a, b) => a[1] > b[1] ? a : b)[0];

    const avgConf = validCount > 0 ? scoreSum / validCount : 0;
    let signal = 'hold';
    let confidence = 0;
    if (validCount >= CONFIG.min_agreeing_strategies && agree >= CONFIG.min_agreeing_strategies) {
      if (agreedDirection === 'bullish' || agreedDirection === 'bearish') {
        signal = agreedDirection;
        confidence = Math.min(100, avgConf);
      }
    } else if (avgConf >= CONFIG.min_confidence) {
      signal = agreedDirection === 'neutral' ? 'hold' : agreedDirection;
      confidence = avgConf;
    }

    return { symbol, signal, confidence, lastPrice, tfSignals, directionCounts };
  }
}
export default Scanner;

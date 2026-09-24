import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, bollinger, atr, computeSignal } from '../src/bitunix/indicators.js';
import { normalizeSettings, validateSettings } from '../src/trader/settings.js';
import { parseThinkingLevel } from '../src/agent/thinking.js';

describe('indicators', () => {
  it('ema returns number for enough data', () => {
    const arr = Array.from({ length: 30 }, (_, i) => 100 + i);
    assert.ok(typeof ema(arr, 20) === 'number');
  });

  it('rsi returns 0-100', () => {
    const arr = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5 + i * 0.2);
    const v = rsi(arr);
    assert.ok(v === null || (v >= 0 && v <= 100));
  });

  it('bollinger returns band', () => {
    const arr = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    const bb = bollinger(arr);
    assert.ok(bb && bb.upper > bb.mid && bb.mid > bb.lower);
  });

  it('computeSignal returns direction+confidence', () => {
    const kl = Array.from({ length: 60 }, (_, i) => ({
      open: String(100 + i), high: String(101 + i), low: String(99 + i), close: String(100 + i),
    }));
    const vols = Array.from({ length: 60 }, () => 10);
    const res = computeSignal(kl, vols, 0);
    assert.ok(['bullish', 'bearish', 'neutral'].includes(res.direction));
    assert.ok(res.confidence >= 0 && res.confidence <= 100);
  });
});

describe('settings', () => {
  it('normalize fills defaults', () => {
    const s = normalizeSettings({});
    assert.equal(s.symbol, 'BTCUSDT');
    assert.ok(s.min_confidence === 80);
  });

  it('validate catches bad leverage', () => {
    const errs = validateSettings({ ...normalizeSettings({}), leverage: 999 });
    assert.ok(errs.length > 0);
  });
});

describe('thinking', () => {
  it('parses levels', () => {
    assert.equal(parseThinkingLevel('high'), 'high');
    assert.equal(parseThinkingLevel('off'), 'off');
    assert.equal(parseThinkingLevel('zzz'), 'mid');
  });
});

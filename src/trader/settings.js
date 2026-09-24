import { CONFIG } from '../config.js';

export const DEFAULTS = {
  symbol: 'BTCUSDT',
  leverage: 10,
  position_type: 'crossed',
  timeframes: ['1m', '5m', '15m', '1h'],
  margin_amount_pct: 2,
  margin_risk_pct: 2,
  min_confidence: 80,
  tf_min_confidence: 60,
  min_agreeing_strategies: 2,
  signal_confirm_scans: 1,
  cooldown_minutes: 5,
  max_positions: 3,
  position_mode: 'hedge',
  scan_interval_sec: 15,
  guard_interval_sec: 15,
  breakeven_threshold_pct: 20,
  trailing_stop_pct: 2,
  trailing_trigger_roi_pct: 25,
  trailing_distance_pct: 1,
  sl_liquidation_safety: 0.60,
  on_tpsl_failure: 'cancel',
  reversal_enabled: true,
  reversal_confidence: 85,
  report_interval_sec: 30,
  mid_manage_interval_sec: 15,
  order_unit: 'cost',
  position_sizing_margin_pct: 2,
  dry_run: true,
  auto_trade: false,
};

export const ALIASES = {
  margin_mode: 'position_type',
  position_type: 'position_type',
  symbol: 'symbol',
  leverage: 'leverage',
};

export function normalizeSettings(s) {
  const out = { ...DEFAULTS, ...s };
  if (Array.isArray(out.timeframes)) out.timeframes = out.timeframes.map(t => String(t).trim());
  return out;
}

export function validateSettings(s) {
  const errors = [];
  if (s.leverage < 1 || s.leverage > 125) errors.push('leverage must be 1-125');
  if (s.min_confidence < 0 || s.min_confidence > 100) errors.push('min_confidence 0-100');
  if (s.tf_min_confidence < 0 || s.tf_min_confidence > 100) errors.push('tf_min_confidence 0-100');
  if (s.scan_interval_sec < 5) errors.push('scan_interval_sec >= 5');
  if (s.guard_interval_sec < 5) errors.push('guard_interval_sec >= 5');
  if (!['crossed', 'isolated'].includes(s.position_type)) errors.push('position_type crossed/isolated');
  if (!['hedge', 'one-way'].includes(s.position_mode)) errors.push('position_mode hedge/one-way');
  if (!['cost', 'qty'].includes(s.order_unit)) errors.push('order_unit cost/qty');
  return errors;
}
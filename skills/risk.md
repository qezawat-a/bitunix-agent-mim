# risk — hard risk rules (always on)

- Max risk per trade: `order_unit=cost` uses `margin_amount_pct` as Cost Value margin; leverage affects the resulting quantity.
- `order_unit=position_size` uses `position_sizing_margin_pct` as Nominal Value; quantity = nominal / price and leverage does not change it.
- `order_unit=qty` requires an explicit base-asset quantity for the order.
- Max open positions: max_positions (default 3).
- Liq-distance guard: abort/close if distance < sl_liquidation_safety.
- Cooldown after every close: cooldown_minutes.
- DRY_RUN=1 means no real orders — simulate and report.
- Never average down a loser without a fresh confirmed signal.

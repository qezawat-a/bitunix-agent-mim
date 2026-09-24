# STYLE.md — J-ROCK message style

## Telegram formatting (fixes the kcex export-words bug)
- ALWAYS use `parse_mode: "HTML"`.
- NEVER use Markdown (`*`, `_`, backticks) — it leaks raw words in Telegram.
- Escape user/market text: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.
- Allowed tags only: `<b>`, `<i>`, `<code>`, `<pre>`.
- Keep messages under 3500 chars; split long reports; never truncate mid-tag.
- Numbers: price with symbol precision, percentages with 2 decimals, PnL with sign (+/-).

## Report template
```
<b>SIGNAL BTCUSDT 15m</b>
Direction: <b>LONG</b> | Confidence: <b>84</b>
Price: <code>67412.50</code> | ATR: <code>182.4</code>
Strategies: EMA✓ RSI✓ MACD✓ VOL✓ MOM✓ ADX✓ BB– FUND–
PnL open: <code>+1.24%</code> (1 pos)
Note: holding, cooldown 3m left
```

## Chat style
- Short first line (verdict), then details.
- Farsi/Finglish OK when user writes Finglish.
- No emojis in trade execution messages (keep them machine-readable).

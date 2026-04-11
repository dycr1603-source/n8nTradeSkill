# DB Schema — trading_bot

## Tablas principales

### trades
```sql
id, symbol, direction, status (OPEN|CLOSED),
entry_price, sl_price, tp_price, qty, leverage,
margin, risk_pct, max_loss, max_gain, rr_ratio,
final_score, scan_score,
ai_regime, ai_bias, ai_reasoning, ai_key_risk, recommended_leverage,
vision_state, vision_approved, vision_reason,
used_fallback, original_symbol,
market_order_id, tp_order_id, sl_monitor,
tf4h_trend, tf4h_status, tf4h_rsi,
macro_bias, macro_fear_greed, macro_btc_change, macro_size_mult,
score_multiplier, effective_risk_pct,
opened_at
```

### trade_closes
```sql
id, trade_id, symbol, exit_price,
pnl_usdt, pnl_pct, r_final,
close_reason ENUM('SL','TP','MANUAL','SYNC','TIME_EXIT'),
trailing_stage ENUM('INITIAL','BREAKEVEN','TIME_LOCK','LOCK','TRAILING'),
duration_minutes, closed_at
```

### trade_rejections
```sql
id, symbol, direction, skip_reason,
final_score, scan_score,
ai_regime, ai_bias,
vision_state, vision_approved,
rsi14, atr_pct, vol_ratio, funding_rate,
tf4h_status, macro_bias, macro_fear_greed,
rejected_at
```

### scan_events
```sql
id, symbol, scan_score, direction, final_score,
long_score, short_score, pass_ai, skip_reason,
rsi14, ema8, ema21, ema50, atr_pct, vol_ratio,
funding_rate, vwap, current_price,
volume24h, price_change_pct, open_interest,
scanned_at
```

## Vistas útiles
```sql
-- PnL diario
SELECT * FROM daily_pnl LIMIT 30;

-- Performance por símbolo
SELECT symbol, total_pnl, win_rate FROM symbol_performance LIMIT 20;

-- Trades recientes con cierre
SELECT t.*, tc.pnl_usdt, tc.r_final, tc.close_reason, tc.trailing_stage
FROM trades t
LEFT JOIN trade_closes tc ON t.id = tc.trade_id
ORDER BY t.opened_at DESC LIMIT 20;

-- Razones de rechazo más comunes
SELECT skip_reason, COUNT(*) as count
FROM trade_rejections
GROUP BY skip_reason
ORDER BY count DESC LIMIT 10;
```

## Comandos útiles
```bash
# Ver trades abiertos sin cierre
mysql -u tradingbot -p'YOUR_DB_PASSWORD' trading_bot -e "
SELECT t.id, t.symbol, t.direction, t.entry_price, t.status, tc.pnl_usdt, tc.close_reason
FROM trades t
LEFT JOIN trade_closes tc ON t.id = tc.trade_id
WHERE t.status = 'CLOSED' AND tc.pnl_usdt IS NULL
ORDER BY t.opened_at DESC LIMIT 10;"

# Rechazos últimas 6 horas
mysql -u tradingbot -p'YOUR_DB_PASSWORD' trading_bot -e "
SELECT direction, skip_reason, COUNT(*) as veces
FROM trade_rejections
WHERE rejected_at >= NOW() - INTERVAL 6 HOUR
GROUP BY direction, skip_reason
ORDER BY veces DESC LIMIT 20;"
```
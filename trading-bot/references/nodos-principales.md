# Nodos Principales — Referencia Técnica

## Agente de Mercado
Consulta F&G, BTC 4h, ETH, intelligenceSignal.
Aplica reglas duras de long_ok/short_ok/size_multiplier EN CÓDIGO (Claude solo escribe reason).
Pasa `intelligenceSignal` dentro de `marketContext`.

## Indicators and Scoring
Paralelo con Promise.all. Calcula 1h + 4h.
scoreSignal devuelve { score, direction, longScore, shortScore }.
Ajuste 4H se suma al score antes de pasar al Aggregate.

## Aggregate Best Setup
- Filtra: !error, direction !== NEUTRAL, score >= 45, !openSymbols, !activeCooldowns, !macroCooldowns
- Rotación top 3 con cycleIndex en Static Data
- NO limpia cooldowns cuando no hay candidatos (bug corregido)
- Registra macroCooldowns cuando símbolo es bloqueado por macro

## AI Market Context (sin imagen)
- Threshold dinámico + volatility bonus
- Bloqueo macro ANTES de filtros
- hasAdjustment para NO OPERAR
- Fallbacks con mismo threshold ajustado
- En catch API error: confidence_adjustment = -50

## AI Market Context Image (con imagen)
- Mismo threshold que sin imagen pero -3 (mín 59)
- lateTrendBlocks: LATE_TREND no bloquea SHORT+BEARISH
- PARABOLIC siempre bloquea
- Volatility bonus: -8pts si condiciones de pánico

## Position Sizer
Multiplica: score × vision × regime × 4h × macro × openPenalty × (1-aiRiskReduction)
Pasa `intelAdjFinal` en return.

## Execute Trade
- Protección re-entrada: verifica posición en Binance antes de ejecutar
- Ajusta qty por margen disponible
- Fetch balance en vivo antes de orden

## Monitor SL Global (después de Execute Trade)
Envía webhook `sl-monitor-set` con todos los campos incluyendo `openedAt: Date.now()`.

## Build Trade Alert (imagen y sin imagen)
Desglose de puntuación:
```
Scoring 1h puro → Ajuste 4H → Ajuste AI → Ajuste Intel → SCORE FINAL
```
Secciones: PUNTUACION, PRECIOS, POSICION, CUENTA, ORDENES, IMAGEN(si aplica),
INTELIGENCIA, AI CONTEXT, MACRO, TIMEFRAME 4H, INDICADORES

## Build AI Skip Message (imagen y sin imagen)
- Aplica cooldown 60min si !isHardBlock
- isHardBlock: Macro bloquea, RSI peligroso, Vol spike, PARABOLIC, Circuit Breaker
- Aplica macro cooldown 15min via dashboard aunque sea hardBlock
- Registra en DB: rejection + scan
- Desglose de puntuación igual que Trade Alert

## Post-Trade Agent
Analiza cada cierre con Claude Haiku.
Solo corre si hay telegramText (cierre real, no monitoring).
Guarda análisis en `/db/post-trade`.

## Guardar Estado (SL Monitor webhook)
Preserva bestPrice existente si no viene en payload:
```javascript
bestPrice: d.bestPrice || state.positions[d.symbol]?.bestPrice || null
```

## Trailing Manager
Orden de operaciones:
1. setSLWithRetry (3 intentos, 2s entre cada uno)
2. Dashboard (solo si SL_SET exitoso)
3. DB (solo si SL_SET exitoso)
4. Telegram

Stages: INITIAL → BREAKEVEN (1R) → TIME_LOCK → LOCK (1.5R) → TRAILING (2R+)
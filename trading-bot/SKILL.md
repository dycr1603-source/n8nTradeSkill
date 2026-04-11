---
name: trading-bot
description: >
  Contexto completo del bot de trading de Binance Futures de Delcon. SIEMPRE usa este skill
  cuando el usuario mencione: n8n, bot de trading, Binance, SL Monitor, Trailing Manager,
  Agente de Mercado, AI Market Context, Risk Guard, Aggregate Best Setup, Market Scanner,
  Indicators and Scoring, αтεгυм, dashboard, cooldowns, scoring, threshold, score,
  LONG/SHORT, posiciones, trades, PnL, ATR, RSI, EMA, 4H, fallbacks, Position Sizer,
  Execute Trade, Build Trade Alert, Build AI Skip Message, Post-Trade Agent,
  o cualquier tema relacionado con el bot de crypto. También usa este skill si el usuario
  pide código JavaScript para n8n, pide revisar un nodo, o menciona el servidor 18.228.14.96.
---

# Bot de Trading Binance Futures — Contexto Completo

Lee este archivo completo antes de responder cualquier pregunta sobre el bot.
Para detalles técnicos de nodos específicos, lee los archivos en `references/`.

---

## Infraestructura

| Componente | Valor |
|-----------|-------|
| Servidor | `18.228.14.96` |
| Dashboard | `:3001` |
| n8n | `:5678` |
| Chart API | `:3000` |
| DB | MariaDB `trading_bot` — user `tradingbot` / pass `TradingBot2024!` |
| PM2 proceso | `dashboard` |
| Codebase | `/home/admin/chart-api/` |
| Telegram | `-1003222176229` |
| Bot scheduler | cada 30 minutos |
| Stack | n8n, MariaDB, PM2, Anthropic claude-haiku-4-5-20251001, Binance Futures API |

**API Keys Binance:**
- `API_KEY: ...`
- `API_SECRET: ...`

**Anthropic Key:** `...`

---

## Arquitectura — Flujo Principal (cada 30 min)

```
Risk Guard
  ↓ passRisk=true
Market Scanner (batch 10 símbolos en paralelo)
  ↓
Indicators and Scoring (1h + 4h, paralelo)
  ↓
Aggregate Best Setup (selecciona top símbolo + fallbacks)
  ↓
DETECTOR DE RSI EXTREMO
  ├── RSI > 75 o ATR > 1.5% → Need Visual Check → AI Market Context Image
  └── Normal → AI Market Context (sin imagen)
  ↓
Position Sizer
  ↓
Execute Trade
  ↓
Monitor SL Global (activa SL Monitor webhook)
  ↓
Build Trade Alert → Telegram
```

**Workflows paralelos:**
- **SL Monitor** — cada 10 segundos — monitorea SL, gestión por tiempo en pérdida
- **Trailing Manager** — cada 1 minuto — mueve SL a BE/LOCK/TRAILING
- **αтεгυм Intelligence** — genera señal via `/intelligence/signal`

---

## Endpoints Dashboard Activos

```
POST /cooldown/set          — registrar cooldown por símbolo
GET  /cooldown/status       — cooldowns activos con minutesLeft
DELETE /cooldown/:symbol    — limpiar cooldown
GET  /intelligence/signal   — señal consolidada pública
POST /db/trade/open         — abrir trade en DB
POST /db/trade/close        — cerrar trade en DB
POST /db/trade/update-sl    — actualizar SL en DB
GET  /db/stats              — estadísticas generales
POST /db/rejection          — registrar rechazo
POST /db/scan               — registrar scan event
GET  /cb/status             — circuit breaker status
POST /cb/sl                 — notificar SL (suma contador)
POST /cb/tp                 — notificar TP
POST /cb/reset              — resetear circuit breaker
POST /trade                 — actualizar trade en dashboard
DELETE /trade/:symbol       — cerrar trade en dashboard
```

---

## Sistema de Scoring

### scoreSignal (Indicators and Scoring)
```
TREND    (40 pts): EMA8 vs EMA21 vs EMA50
RSI      (25 pts): 
  - r > 55 && < 70  → L+20
  - r >= 70         → L+8
  - r > 50 && <=55  → L+10
  - r < 45 && > 30  → S+20
  - r <= 30 && > 20 → S+15  ← fix reciente
  - r <= 20         → S+10  ← fix reciente
  - r < 50 && >=45  → S+10
VOLUME   (20 pts): volRatio vs 20-bar avg
VWAP     (15 pts): precio vs VWAP
FUNDING  (10 pts): fundingRate
OI bonus  (+5):   oiChangePct > 2
ATR penalty:      > 8% → *0.5, > 5% → *0.75

Dirección: L>=50 && L>S → LONG | S>=50 && S>L → SHORT
Fix reciente: S>=35 && S>L*1.5 → SHORT (umbral reducido)
             L>=35 && L>S*1.5 → LONG
```

### Ajuste 4H
```
Signal LONG + trend4hLong → +8 (RSI fuerte) o +4
Signal LONG + trend4hShort → -20 (CONTRADICTS)
Signal SHORT + trend4hShort → +8 o +4 (CONFIRMS)
RSI 4H peligroso (>80 LONG, <20 SHORT) → -15 adicional
```

### Threshold Dinámico (AI Market Context)
```
macro contradice o 4H CONTRADICTS → 80
macro alinea + 4H CONFIRMS        → 62
macro alinea + 4H NEUTRAL         → 64
macro alinea + 4H CONTRADICTS     → 75
macro NEUTRAL + 4H CONFIRMS       → 65
macro NEUTRAL + 4H NEUTRAL        → 70
default                           → 67
+ openCount >= 2 → +8
+ openCount >= 1 → +4
Con imagen: -3 (mín 59)
Volatility bonus: -8 (mín 55) si 0 trades + 5+ cooldowns + ATR>2% + SHORT alineado
```

---

## Agente de Mercado — Reglas Duras

```javascript
F&G < 15 + BTC bajista  → long_ok=false, size=0.6x, bias=BEARISH
F&G < 15 + BTC alcista  → long_ok=true,  size=0.5x, bias=NEUTRAL
F&G 15-25               → size=0.5x
F&G >= 80               → short_ok=false, size=0.7x, bias=BULLISH
F&G >= 65               → size=0.85x
Normal                  → size=1.0x
```

**intelligenceSignal** se consulta al endpoint `/intelligence/signal` y se agrega al `marketContext`.

---

## Sistema de Inteligencia αтεгυм

**Endpoint:** `GET /intelligence/signal`

**Ajustes por señal:**
```
NO OPERAR alta:    -10 ambas
NO OPERAR media:   -6 ambas
NO OPERAR baja:    -2 ambas (confianza baja → 0 en AI Context)
conflict_high:     -12
conflict_medium:   -7
confirm_high:      +6
confirm_medium:    +3
```

**En AI Market Context:** confianza baja → intelAdjFinal=0 (ignorado)

---

## Gestión de Posiciones

### Trailing Manager (cada 1 min)
```
1R  → BREAKEVEN: SL a entry ± 0.1%
1.5R → LOCK: SL a entry ± 0.5R
2R+ → TRAILING: SL a precio ± ATR*1.0
TIME_LOCK: si lleva horas con % ganancia sin llegar a R milestones
```

**Fix crítico:** `setSLWithRetry` — 3 intentos con 2s entre cada uno.
Dashboard y DB solo se actualizan si SL Monitor confirmó el cambio.
`bestPrice` se preserva en `Guardar Estado` aunque Trailing Manager sobreescriba.

### SL Monitor (cada 10 seg)
**Gestión por tiempo en pérdida (solo stage INITIAL, nunca tocó ganancia):**
```
6h  en pérdida → SL 30% más cerca del entry
12h en pérdida → SL 50% más cerca del entry
20h en pérdida → TIME_EXIT (cierre forzado)
```

### Cooldowns tras cierre
```
TP:        30 min
SL real:   15 min
TIME_EXIT: 60 min
Macro block (EDGE/símbolo rechazado): 15 min via dashboard
```

---

## Filtros Importantes

### AI Market Context Image — lateTrendBlocks
```javascript
// LATE_TREND solo bloquea si NO es SHORT alineado con macro BEARISH
const lateTrendBlocks = visionLate && !(direction === 'SHORT' && macroBias === 'BEARISH');
```

### RSI peligroso
```
Sin imagen: SHORT < 30, LONG > 70
Con imagen: SHORT < 25, LONG > 75
```

### Macro cooldown en Aggregate Best Setup
```javascript
state.macroCooldowns[sym] = Date.now(); // 15 min
// Excluye símbolo si fue bloqueado por macro en ciclo anterior
```

---

## Estado del SL Monitor

**Webhook GET:** `http://18.228.14.96:5678/webhook/sl-monitor-get`
**Webhook SET:** `http://18.228.14.96:5678/webhook/sl-monitor-set`
**Reset:** `http://18.228.14.96:5678/webhook/sl-monitor-reset`

Campos importantes en cada posición:
```json
{
  "positionSide": "SHORT|LONG",
  "slPrice": 0,
  "qty": 0,
  "side": "BUY|SELL",
  "entryPrice": 0,
  "initialSL": 0,
  "stage": "INITIAL|BREAKEVEN|TIME_LOCK|LOCK|TRAILING",
  "tp": 0,
  "leverage": 5,
  "finalScore": 0,
  "openedAt": 1234567890000,
  "aiRegime": "TRENDING",
  "bestPrice": 0
}
```

---

## Bugs Conocidos y Fixes Aplicados

| Bug | Fix |
|-----|-----|
| intelligenceSignal N/A | Agente de Mercado consulta endpoint y pasa en marketContext |
| NO OPERAR no ajustaba score | `hasAdjustment` reemplazó condición `!== 'NEUTRAL'` |
| intelAdjFinal no llegaba a Build Trade Alert | Position Sizer ahora lo pasa en return |
| LATE_TREND bloqueaba SHORTs bajistas | `lateTrendBlocks` con excepción SHORT+BEARISH |
| scan_events vacío | INSERT solo en rechazos post-AI, no en bloqueos macro |
| Desync Trailing/SL Monitor | `setSLWithRetry` + dashboard solo si SL_SET exitoso |
| bestPrice se perdía en SET | `Guardar Estado` preserva bestPrice existente |
| EDGE en bucle infinito | Macro cooldown 15min via dashboard + state.macroCooldowns |
| scoreSignal no generaba SHORTs | RSI 20-30 → 15pts (era 8), umbral reducido 35pts con 1.5x |
| AI API error 400 aprobaba trades | confidence_adjustment -50 en catch de error |
| PnL $0 en TIME_EXIT | Posiciones antiguas sin openedAt — próximas funcionan bien |
| ENUM TIME_EXIT no existía | ALTER TABLE trade_closes MODIFY close_reason ENUM(... TIME_EXIT) |

---

## Preferencias de Delcon

- Código completo y listo para pegar — nunca parcial
- Verificar con output real antes de siguiente cambio
- Español en mensajes Telegram
- Hora CR (UTC-6) en cooldowns y mensajes
- Arquitectura modular — cambios en un nodo no deben romper otros

---

## Referencias Adicionales

Para detalles completos de cada nodo, ver:
- `references/nodos-principales.md` — código completo de nodos críticos
- `references/mensajes-telegram.md` — formato de mensajes Build Trade Alert y Skip
- `references/db-schema.md` — estructura de tablas MariaDB
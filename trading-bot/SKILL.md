---
name: trading-bot
description: >
  Sistema completo de contexto del bot de trading Binance Futures de Delcon.
  SIEMPRE usa este skill cuando el usuario mencione: n8n, bot de trading, Binance,
  SL Monitor, Trailing Manager, Agente de Mercado, AI Market Context, Risk Guard,
  Aggregate Best Setup, Market Scanner, Indicators and Scoring, αтεгυм, dashboard,
  cooldowns, scoring, threshold, score, LONG/SHORT, posiciones, trades, PnL, ATR,
  RSI, EMA, 4H, fallbacks, Position Sizer, Execute Trade, Build Trade Alert,
  Build AI Skip Message, Post-Trade Agent, chart-api, workflow, nodo,
  o cualquier código JavaScript para n8n. También activa si el usuario menciona
  el servidor 18.228.14.96 o pide revisar/modificar cualquier nodo del bot.
  Este skill contiene el código COMPLETO de todos los nodos — úsalo siempre.
---

# Bot de Trading Binance Futures — Sistema Brain Completo

Lee las secciones relevantes según lo que necesites.
Para código completo de nodos, ve a `references/workflows/`.

---

## INFRAESTRUCTURA

| Componente | Valor |
|-----------|-------|
| Servidor | `18.228.14.96` |
| Dashboard | `http://18.228.14.96:3001` |
| n8n | `http://18.228.14.96:5678` |
| DB | MariaDB `trading_bot` — user `tradingbot` / pass `YOUR_DB_PASSWORD` |
| Codebase | `/home/admin/chart-api/` |
| Telegram | `-1003222176229` |
| Scheduler | cada 30 minutos |

**Credenciales:**
```
Binance API_KEY:    YOUR_BINANCE_API_KEY
Binance API_SECRET: YOUR_BINANCE_API_SECRET
Anthropic Key:      YOUR_ANTHROPIC_API_KEY
```

---

## WORKFLOWS

### 1. Workflow Principal (cada 30 min)
**Nodos en orden:**
```
Main Schedule → Risk Guard → AGENTE DE MERCADO → If: Risk OK
  ├→ [FAIL] Telegram: Risk Halt
  └→ [OK] Market Scanner → Indicators and Scoring → Aggregate Best Setup
       └→ If: Setup Found
            ├→ [NO] Telegram: No Setup
            └→ [SÍ] DETECTOR DE RSI EXTREMO → Need Visual Check
                 ├→ [CON IMAGEN] Save Image → Claude Code Command
                 │    → Parse Output Of Claude → AI Market Context Image
                 │         → If: AI Approves1
                 │              ├→ Position Sizer1 → Execute Trade1
                 │              │    → Monitor SL Global of Image
                 │              │         → Build Trade Alert of Image
                 │              │              → Telegram: Trade Opened of Image → Delete Image1
                 │              └→ Build AI Skip Message Image
                 │                   → Telegram: AI Skip Image → Delete Image
                 └→ [SIN IMAGEN] AI Market Context → If: AI Approves
                      ├→ Position Sizer → Execute Trade → Monitor SL Global
                      │    → Build Trade Alert → Telegram: Trade Opened
                      └→ Build AI Skip Message → Telegram: AI Skip Image1
```

**Triggers adicionales:**
```
Daily Trigger AI → Daily Analysis Report + Daily PnL Report → Telegram
Weekly Trigger   → Weekly Deep Analysis → Telegram
```

### 2. SL Monitor (cada 10 segundos)
```
Schedule Trigger → SL Monitor Code → If (telegramText?)
                                          ├→ Telegram: SL Updated
                                          └→ Post-Trade Agent → Telegram: Post-Trade Agent
Webhooks:
  GET  /webhook/sl-monitor-get  → Leer Estado
  POST /webhook/sl-monitor-set  → Guardar Estado
  POST /webhook/sl-monitor-reset → Reset Estado
```

### 3. Trailing Manager (cada 1 minuto)
```
Schedule Trigger → Trailing Manager Code → If: SL Updated → Telegram: SL Updated
```

---

## SCORING

### scoreSignal
```javascript
// TREND (40pts): EMA8>EMA21 +15, alineación completa +25, spread>1% +5
// RSI (25pts):
r>55&&<70→L+20 | r>=70→L+8 | r>50&&<=55→L+10
r<45&&>30→S+20 | r<=30&&>20→S+15 | r<=20→S+10 | r<50&&>=45→S+10
// VOLUME (20pts): >=2.0→+15, >=1.5→+10, >=1.2→+6, >=0.8→+2, else→-3
// VWAP (15pts): diff>0.5%→+15, >0.1%→+8, <-0.5%→+15SHORT, <-0.1%→+8SHORT
// FUNDING (10pts): >0.0005→S+10, <-0.0005→L+10
// ATR penalty: >8%→*0.5, >5%→*0.75
// Dirección: L>=50&&L>S→LONG | S>=50&&S>L→SHORT
// Fix: S>=35&&S>L*1.5→SHORT | L>=35&&L>S*1.5→LONG
```

### Threshold Dinámico
```
macroContradict || CONTRADICTS → 80
macroAlign + CONFIRMS          → 62
macroAlign + NEUTRAL           → 64
macroAlign + CONTRADICTS       → 75
NEUTRAL + CONFIRMS             → 65
NEUTRAL + NEUTRAL              → 70
default → 67 | +openCount≥2:+8 | +openCount≥1:+4
Con imagen: -3 (mín 59)
Volatility bonus: -8 (mín 55) si openCount=0+cooldowns≥5+ATR>2%+SHORT alineado
```

---

## AGENTE DE MERCADO

```javascript
// Reglas duras en código — Claude solo escribe 'reason'
F&G<15+BTCbaj → long_ok=false, size=0.6, BEARISH
F&G<15+BTCalc → long_ok=true,  size=0.5, NEUTRAL
F&G 15-25     → size=0.5
F&G>=80       → short_ok=false, size=0.7, BULLISH
F&G>=65       → size=0.85
Normal        → size=1.0
// Consulta GET /intelligence/signal → pasa como intelligenceSignal en marketContext
```

---

## INTELIGENCIA αтεгυм

```
GET http://18.228.14.96:3001/intelligence/signal
Señales: LONG, SHORT, NEUTRAL, NO OPERAR
Ajustes: NO_OPERAR_alta=-10, media=-6, baja=-2(→0 si conf=baja)
         conflict_high=-12, medium=-7, low=-3
         confirm_high=+6, medium=+3, low=+1
confianza media → ajuste*0.6
hasAdjustment = ifLong!==0 || ifShort!==0
```

---

## TRAILING MANAGER — Stages

```
INITIAL   → 0R   — SL original
BREAKEVEN → 1R   — SL = entry ± 0.1%
TIME_LOCK → horas en ganancia sin alcanzar R milestones
LOCK      → 1.5R — SL = entry ± 0.5R
TRAILING  → 2R+  — SL = precio ± ATR*1.0

setSLWithRetry: 3 intentos, 2s entre cada uno
Dashboard/DB: solo si SL_SET exitoso
bestPrice: se preserva en Guardar Estado aunque Trailing sobreescriba
```

---

## SL MONITOR — Gestión por Tiempo

```
Solo: stage=INITIAL + nunca tocó ganancia (bestPrice≈entry)
6h  en pérdida → SL 30% más cerca (slDist*0.70)
12h en pérdida → SL 50% más cerca (slDist*0.50)
20h en pérdida → TIME_EXIT (cierre forzado)

Cooldowns: TP=30min | SL=15min | TIME_EXIT=60min | Macro=15min
```

---

## FILTROS CRÍTICOS

```javascript
// LATE_TREND (AI Market Context Image)
const lateTrendBlocks = visionLate && !(direction==='SHORT' && macroBias==='BEARISH');

// RSI peligroso
// Sin imagen: SHORT<30, LONG>70
// Con imagen: SHORT<25, LONG>75

// isHardBlock (no aplica cooldown)
skipReason.includes('Macro bloquea'||'RSI peligroso'||'Vol spike'||'PARABOLIC'||'Circuit Breaker')

// Aggregate filter
!error && direction!=='NEUTRAL' && score>=45 && !openSymbols && !activeCooldowns && !macroCooldowns

// AI API error → penalizar, no aprobar
catch(e){ aiResult.confidence_adjustment = -50; }
```

---

## UPDATE 2026-04-15 (RE-ENTRY + COOLDOWN)

Parche operativo agregado en `nodos-corregidos-2026-04-15/`:

- Bloqueo duro en AI Market Context (con y sin imagen) para no procesar simbolos en `openSymbols`.
- Guardrail en Execute Trade que verifica `positionRisk` y bloquea si el simbolo ya tiene posicion abierta.
- Cooldown de simbolo unificado a **60 minutos** al cerrar operacion en SL Monitor.

---

## ENDPOINTS DASHBOARD

```
POST   /cooldown/set           {symbol, minutes}
GET    /cooldown/status
DELETE /cooldown/:symbol
GET    /intelligence/signal
POST   /db/trade/open | /close | /update-sl
GET    /db/stats
POST   /db/rejection | /db/scan
GET    /cb/status
POST   /cb/sl | /cb/tp | /cb/reset
POST   /trade
DELETE /trade/:symbol
```

---

## WEBHOOKS SL MONITOR

```
GET  http://18.228.14.96:5678/webhook/sl-monitor-get
POST http://18.228.14.96:5678/webhook/sl-monitor-set
POST http://18.228.14.96:5678/webhook/sl-monitor-reset

Campos: { positionSide, slPrice, qty, side, entryPrice, initialSL,
          stage, tp, leverage, finalScore, openedAt, aiRegime, bestPrice }
```

---

## BUGS CORREGIDOS

| Bug | Fix |
|-----|-----|
| intelligenceSignal N/A | Agente de Mercado consulta endpoint |
| NO OPERAR sin ajuste | hasAdjustment reemplazó `!=='NEUTRAL'` |
| intelAdjFinal sin llegar a Alert | Position Sizer lo pasa en return |
| LATE_TREND bloqueaba SHORTs | lateTrendBlocks con excepción SHORT+BEARISH |
| EDGE en bucle por macro | macroCooldowns 15min state + dashboard |
| Desync Trailing/SL Monitor | setSLWithRetry + dashboard solo si exitoso |
| bestPrice se perdía | Guardar Estado preserva bestPrice |
| Pocos SHORTs generados | RSI fix + umbral 35pts con 1.5x |
| AI error 400 aprobaba | confidence_adjustment=-50 en catch |
| Posiciones fantasma | Health check en Monitor SL Global x3 |
| Cooldowns se limpiaban | Bug corregido Aggregate Best Setup |
| TIME_EXIT no en ENUM | ALTER TABLE trade_closes |
| Position Sizer1 sin intelAdjFinal | Agregado al return |
| Símbolos chinos en scanner | Filtro /^[A-Z0-9]+$/.test(t.symbol) excluye caracteres no-ASCII como 币安人生USDT |

---

## PREFERENCIAS

- Código **completo** listo para pegar — nunca parcial
- Verificar con output real antes de siguiente cambio
- Español en Telegram, hora CR (UTC-6)
- Modular — cambios en un nodo no rompen otros

---

## REFERENCIAS

- `references/workflows/main-nodes.md` — Código JS completo de todos los nodos
- `references/workflows/sl-monitor-code.md` — Código SL Monitor completo
- `references/workflows/trailing-manager-code.md` — Código Trailing Manager completo
- `references/db-schema.md` — Schema DB + queries útiles
- `references/nodos-principales.md` — Resumen lógica por nodo

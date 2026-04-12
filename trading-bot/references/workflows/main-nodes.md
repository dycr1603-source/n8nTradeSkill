# Código Completo — Workflow Principal

Todos los nodos de código del workflow principal extraídos directamente del JSON.

## Risk Guard

```javascript
const crypto = require('crypto');
const API_KEY    = 'YOUR_BINANCE_API_KEY';
const API_SECRET = 'YOUR_BINANCE_API_SECRET';
const BASE       = 'https://fapi.binance.com';
const DASHBOARD  = 'http://18.228.14.96:3001';

function sign(params){
  const query = Object.entries({ ...params, timestamp: Date.now(), recvWindow: 60000 })
    .map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return query + '&signature=' + crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}
async function bget(path, params={}){
  return this.helpers.httpRequest({
    method: 'GET',
    url: `${BASE}${path}?${sign(params)}`,
    headers: { 'X-MBX-APIKEY': API_KEY },
    json: true
  });
}

// ── 1. Circuit Breaker ────────────────────────────────────────────────────────
let cbStatus = { active: false, consecutiveSL: 0, expiresIn: 0, direction: null };
try{
  cbStatus = await this.helpers.httpRequest({
    method: 'GET', url: `${DASHBOARD}/cb/status`, json: true
  });
}catch(e){ console.log('[RG] CB check error:', e.message); }

if(cbStatus.active){
  console.log(`[Risk Guard] CIRCUIT BREAKER ACTIVO — ${cbStatus.direction} pausado ${cbStatus.expiresIn}min más`);
  return [{
    json: {
      passRisk: false, balance: 0, availableBalance: 0,
      dailyPnL: 0, dailyPnLPct: 0, openCount: 0, openSymbols: [],
      haltReason: `⚠️ Circuit Breaker: ${cbStatus.consecutiveSL} SL consecutivos en ${cbStatus.direction} — pausado ${cbStatus.expiresIn}min más`,
      cbActive: true
    }
  }];
}

// ── 2. Filtro de horario — bloquear aperturas de sesión ───────────────────────
const nowUtc     = new Date();
const utcHour    = nowUtc.getUTCHours();
const utcMinute  = nowUtc.getUTCMinutes();
const utcMinutes = utcHour * 60 + utcMinute;

const SESSION_BLOCKS = [
  { name: 'Apertura Asia',   start: 23*60+45, end: 24*60+30 },
  { name: 'Apertura Europa', start:  7*60+45, end:  8*60+30 },
  { name: 'Apertura NY',     start: 13*60+45, end: 14*60+30 },
];

function fmtUTC(totalMins){
  const m = totalMins % (24*60);
  return String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');
}
function fmtCR(totalMins){
  const m = ((totalMins % (24*60)) - 6*60 + 24*60) % (24*60);
  return String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');
}

let sessionBlock = null;
for(const block of SESSION_BLOCKS){
  if(block.end > 24*60){
    if(utcMinutes >= block.start || utcMinutes <= block.end - 24*60){
      sessionBlock = block;
      break;
    }
  } else {
    if(utcMinutes >= block.start && utcMinutes <= block.end){
      sessionBlock = block;
      break;
    }
  }
}

if(sessionBlock){
  const startUTC = fmtUTC(sessionBlock.start);
  const endUTC   = fmtUTC(sessionBlock.end);
  const startCR  = fmtCR(sessionBlock.start);
  const endCR    = fmtCR(sessionBlock.end);

  console.log(`[Risk Guard] SESIÓN BLOQUEADA — ${sessionBlock.name} en progreso`);
  return [{
    json: {
      passRisk: false, balance: 0, availableBalance: 0,
      dailyPnL: 0, dailyPnLPct: 0, openCount: 0, openSymbols: [],
      haltReason: [
        `🕐 ${sessionBlock.name} bloqueada — riesgo de barrido de liquidez`,
        `Ventana: ${startUTC} → ${endUTC} UTC  (${startCR} → ${endCR} CR)`,
        `Bot opera nuevamente desde las ${endUTC} UTC — ${endCR} CR`
      ].join('\n'),
      sessionBlock: sessionBlock.name,
      cbActive: false
    }
  }];
}

// ── 3. Balance y posiciones ───────────────────────────────────────────────────
const balances = await bget.call(this, '/fapi/v2/balance');
const usdt = balances.find(b => b.asset === 'USDT') || {};
const balance          = parseFloat(usdt.balance || 0);
const availableBalance = parseFloat(usdt.availableBalance || 0);

const positions     = await bget.call(this, '/fapi/v2/positionRisk');
const openPositions = positions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
const openSymbols   = openPositions.map(p => p.symbol);
const openCount     = openPositions.length;

// ── 4. PnL del día ────────────────────────────────────────────────────────────
const now        = Date.now();
const startOfDay = new Date(); startOfDay.setUTCHours(0,0,0,0);

const income = await bget.call(this, '/fapi/v1/income', {
  startTime: startOfDay.getTime(), endTime: now, limit: 1000
});
const realizedPnL = income
  .filter(i => i.incomeType === 'REALIZED_PNL')
  .reduce((sum, i) => sum + parseFloat(i.income), 0);

const dailyPnL    = realizedPnL;
const dailyPnLPct = balance > 0 ? (dailyPnL / balance) * 100 : 0;

// ── 5. Cooldown — solo por símbolo, no global ─────────────────────────────────
let cooldownActive  = false;
let cooldownMinLeft = 0;
let lastCloseSymbol = null;
console.log('[Risk Guard] Cooldown global desactivado — cooldowns por símbolo activos en Aggregate Best Setup');

// ── 6. Límites ────────────────────────────────────────────────────────────────
const DAILY_DD_LIMIT = -15;
const MAX_TRADES     = 3;

const ddOk     = dailyPnLPct > DAILY_DD_LIMIT;
const tradesOk = openCount < MAX_TRADES;
const passRisk = ddOk && tradesOk && !cooldownActive;

let haltReason = null;
if(!ddOk){
  haltReason = `Daily drawdown ${dailyPnLPct.toFixed(2)}% — límite ${DAILY_DD_LIMIT}%`;
} else if(!tradesOk){
  haltReason = `Máximo ${MAX_TRADES} posiciones abiertas (${openCount})`;
} else if(cooldownActive){
  haltReason = `⏳ Cooldown activo — último cierre: ${lastCloseSymbol} — faltan ${cooldownMinLeft}min`;
}

console.log(`[Risk Guard] passRisk=${passRisk} CB:off pos:${openCount}/${MAX_TRADES} dailyPnL:$${dailyPnL.toFixed(2)} (${dailyPnLPct.toFixed(2)}%)`);

return [{
  json: {
    passRisk,
    balance:          +balance.toFixed(2),
    availableBalance: +availableBalance.toFixed(2),
    dailyPnL:         +dailyPnL.toFixed(2),
    dailyPnLPct:      +dailyPnLPct.toFixed(2),
    openCount,
    openSymbols,
    haltReason,
    cbActive:         false,
    cooldownActive,
    cooldownMinLeft,
    sessionBlock:     null
  }
}];
```

---

## AGENTE DE MERCADO

```javascript
const ANTHROPIC_KEY = 'YOUR_ANTHROPIC_API_KEY';
const d = $input.first().json;

// ── 1. Fear & Greed Index ─────────────────────────────────────────────────────
let fearGreed = { value: 50, classification: 'Neutral' };
try{
  const fg = await this.helpers.httpRequest({
    method: 'GET',
    url: 'https://api.alternative.me/fng/?limit=1',
    json: true
  });
  fearGreed = {
    value:          parseInt(fg.data?.[0]?.value || 50),
    classification: fg.data?.[0]?.value_classification || 'Neutral'
  };
}catch(e){ console.log('Fear&Greed error:', e.message); }

// ── 2. BTC proxy del mercado ──────────────────────────────────────────────────
const btcKlines = await this.helpers.httpRequest({
  method: 'GET',
  url: 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=50',
  json: true
});
const btcCloses = btcKlines.map(k => parseFloat(k[4]));
const btcEma8   = btcCloses.slice(-8).reduce((a,b) => a+b,0) / 8;
const btcEma21  = btcCloses.slice(-21).reduce((a,b) => a+b,0) / 21;
const btcPrice  = btcCloses[btcCloses.length - 1];
const btcChange = ((btcPrice - btcCloses[btcCloses.length - 13]) / btcCloses[btcCloses.length - 13] * 100).toFixed(2);
const btcBullish = btcEma8 > btcEma21;

// ── 3. ETH confirmación ───────────────────────────────────────────────────────
const ethKlines = await this.helpers.httpRequest({
  method: 'GET',
  url: 'https://fapi.binance.com/fapi/v1/klines?symbol=ETHUSDT&interval=4h&limit=14',
  json: true
});
const ethCloses = ethKlines.map(k => parseFloat(k[4]));
const ethChange = ((ethCloses[ethCloses.length-1] - ethCloses[0]) / ethCloses[0] * 100).toFixed(2);

// ── 4. Señal de inteligencia (noticias + sesiones) ────────────────────────────
let intelligenceSignal = {
  signal: 'NEUTRAL', confidence: 'baja', bias: 'neutral',
  postureScore: 0, scoreAdjustment: { ifLong: 0, ifShort: 0 }, alerts: []
};
try{
  intelligenceSignal = await this.helpers.httpRequest({
    method: 'GET',
    url: 'http://18.228.14.96:3001/intelligence/signal',
    json: true
  });
  console.log(`[Market] Intelligence: ${intelligenceSignal.signal} conf=${intelligenceSignal.confidence} adjLong=${intelligenceSignal.scoreAdjustment?.ifLong} adjShort=${intelligenceSignal.scoreAdjustment?.ifShort}`);
}catch(e){ console.log('[Market] Intelligence error:', e.message); }

// ── 5. Sesgo calculado en código (no depende de Claude) ───────────────────────
const fg = fearGreed.value;

let hardLongOk   = true;
let hardShortOk  = true;
let hardSizeMult = 1.0;
let hardBias     = 'NEUTRAL';

const btcAlcista = btcBullish;

if(fg < 15){
  if(btcAlcista){
    hardLongOk   = true;
    hardSizeMult = 0.5;
    hardBias     = 'NEUTRAL';
    console.log(`[Market] F&G ${fg} extremo PERO BTC alcista — LONG permitido con 50% size`);
  } else {
    hardLongOk   = false;
    hardSizeMult = 0.6;
    hardBias     = 'BEARISH';
    console.log(`[Market] F&G ${fg} extremo + BTC bajista — LONG BLOQUEADO`);
  }
  hardShortOk = true;
} else if(fg <= 25){
  hardLongOk   = true;
  hardShortOk  = true;
  hardSizeMult = 0.5;
  hardBias     = btcBullish ? 'NEUTRAL' : 'BEARISH';
} else if(fg >= 80){
  hardLongOk   = true;
  hardShortOk  = false;
  hardSizeMult = 0.7;
  hardBias     = 'BULLISH';
} else if(fg >= 65){
  hardLongOk   = true;
  hardShortOk  = true;
  hardSizeMult = 0.85;
  hardBias     = btcBullish ? 'BULLISH' : 'NEUTRAL';
} else {
  hardLongOk   = true;
  hardShortOk  = true;
  hardSizeMult = 1.0;
  hardBias     = btcBullish ? 'BULLISH' : !btcBullish && fg < 40 ? 'BEARISH' : 'NEUTRAL';
}

// ── 6. Claude solo para el razonamiento ──────────────────────────────────────
const prompt = `Eres un analista de mercado crypto. Explica en UNA oración el contexto macro actual para un trader.

DATOS:
- Fear & Greed: ${fg}/100 (${fearGreed.classification})
- BTC 12h: ${btcChange}% | Tendencia 4h: ${btcBullish ? 'ALCISTA (EMA8>EMA21)' : 'BAJISTA (EMA8<EMA21)'}
- ETH 12h: ${ethChange}%
- Sesgo calculado: ${hardBias}
- LONG permitido: ${hardLongOk} | SHORT permitido: ${hardShortOk}
- Size multiplier: ${hardSizeMult}
- Señal de inteligencia: ${intelligenceSignal.signal} (confianza ${intelligenceSignal.confidence})

Responde SOLO con este JSON (no cambies long_ok, short_ok ni size_multiplier — ya están calculados):
{
  "market_bias": "${hardBias}",
  "confidence": <número 0-100 según convicción del sesgo>,
  "long_ok": ${hardLongOk},
  "short_ok": ${hardShortOk},
  "size_multiplier": ${hardSizeMult},
  "reason": "<una sola oración explicando el contexto en español>"
}`;

let marketContext = {
  market_bias:     hardBias,
  confidence:      60,
  long_ok:         hardLongOk,
  short_ok:        hardShortOk,
  size_multiplier: hardSizeMult,
  reason:          `F&G ${fg}/100 — ${fg < 15 ? 'miedo extremo' : fg <= 25 ? 'miedo alto, tamaño 50%' : fg >= 80 ? 'codicia extrema' : 'zona normal'}`
};

try{
  const resp = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    }),
    json: false
  });
  const body = typeof resp === 'string' ? JSON.parse(resp) : resp;
  if(!body?.error){
    const match = (body?.content?.[0]?.text || '{}').match(/\{[\s\S]*\}/);
    if(match){
      const parsed = JSON.parse(match[0]);
      if(parsed.reason)     marketContext.reason     = parsed.reason;
      if(parsed.confidence) marketContext.confidence = parsed.confidence;
      marketContext.long_ok        = hardLongOk;
      marketContext.short_ok       = hardShortOk;
      marketContext.size_multiplier = hardSizeMult;
      marketContext.market_bias    = hardBias;
    }
  }
}catch(e){ console.log('Market context AI error:', e.message); }

console.log(`[Market] bias=${marketContext.market_bias} long=${marketContext.long_ok} short=${marketContext.short_ok} FG=${fg} size=${hardSizeMult}x BTC=${btcChange}% intel=${intelligenceSignal.signal}`);

return [{
  json: {
    ...d,
    marketContext: {
      ...marketContext,
      fearGreed,
      btcChange:         +btcChange,
      ethChange:         +ethChange,
      btcBullish,
      btcPrice:          +btcPrice.toFixed(0),
      intelligenceSignal              // ← CLAVE — esto es lo que faltaba
    }
  }
}];
```

---

## Market Scanner

```javascript
const input       = $input.first().json;
const openSymbols = input.openSymbols || [];

const EXCLUDED_SYMBOLS = [
  'RIVERUSDT','XAGUSDT','XAUUSDT','OILUSDT',
  'NASDAQUSDT','LYNUSDT','BARDUSDT'
];

const MIN_VOL        = 200000000;
const MIN_OI         = 10000000;
const MAX_CHANGE_PCT = 35;
const TOP_N          = 5;

function ema(data, period){
  const k = 2 / (period + 1);
  let e = data[0];
  for(let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}

// ── 1. Tickers 24h ────────────────────────────────────────────────────────────
const tickers = await this.helpers.httpRequest({
  method: 'GET',
  url: 'https://fapi.binance.com/fapi/v1/ticker/24hr',
  json: true
});

const base = (Array.isArray(tickers) ? tickers : [])
  .filter(t =>
    t.symbol &&
    t.symbol.endsWith('USDT') &&
    !t.symbol.includes('_') &&
    !t.symbol.includes('1000') &&
    /^[A-Z0-9]+$/.test(t.symbol) &&
    !EXCLUDED_SYMBOLS.includes(t.symbol) &&
    !openSymbols.includes(t.symbol) &&
    parseFloat(t.quoteVolume || 0) >= MIN_VOL &&
    Math.abs(parseFloat(t.priceChangePercent || 0)) < MAX_CHANGE_PCT
  )
  .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
  .slice(0, 40);

// ── 2. Fetch OI + klines + funding en paralelo para todos los símbolos ─────────
const BATCH_SIZE = 10; // procesar de a 10 para no saturar rate limits
const enriched   = [];

for(let i = 0; i < base.length; i += BATCH_SIZE){
  const batch = base.slice(i, i + BATCH_SIZE);

  const batchResults = await Promise.all(batch.map(async t => {
    const symbol = t.symbol;
    try{
      // Fetch OI + klines + funding en paralelo por símbolo
      const [oiData, klines, frData] = await Promise.all([
        this.helpers.httpRequest({
          method: 'GET',
          url: `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`,
          json: true
        }),
        this.helpers.httpRequest({
          method: 'GET',
          url: `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=24`,
          json: true
        }),
        this.helpers.httpRequest({
          method: 'GET',
          url: `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`,
          json: true
        }).catch(() => ({ lastFundingRate: 0 }))
      ]);

      // Filtro OI
      const oi = parseFloat(oiData?.openInterest || 0) * parseFloat(t.lastPrice || 0);
      if(oi < MIN_OI) return null;

      if(!Array.isArray(klines) || klines.length < 10) return null;

      const closes  = klines.map(k => parseFloat(k[4]));
      const volumes = klines.map(k => parseFloat(k[5]));
      const highs   = klines.map(k => parseFloat(k[2]));
      const lows    = klines.map(k => parseFloat(k[3]));

      const ema8  = ema(closes, 8);
      const ema21 = ema(closes, 21);
      const price = closes[closes.length - 1];

      const trendDir      = ema8 > ema21 ? 1 : ema8 < ema21 ? -1 : 0;
      const trendStrength = Math.abs((ema8 - ema21) / ema21) * 100;

      const priceNow   = closes[closes.length - 1];
      const price4hAgo = closes[closes.length - 5] || closes[0];
      const momentum4h = ((priceNow - price4hAgo) / price4hAgo) * 100;

      const momentumCoherent =
        (momentum4h > 0 && parseFloat(t.priceChangePercent) > 0) ||
        (momentum4h < 0 && parseFloat(t.priceChangePercent) < 0);

      const volRecent   = volumes.slice(-4).reduce((a,b)  => a+b, 0) / 4;
      const volOlder    = volumes.slice(-12,-4).reduce((a,b) => a+b, 0) / 8;
      const volRatio    = volOlder > 0 ? volRecent / volOlder : 1;
      const volGrowing  = volRatio > 1.2;

      let atrSum = 0;
      for(let j = 1; j < klines.length; j++){
        const h = highs[j], l = lows[j], pc = closes[j-1];
        atrSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
      const atr    = atrSum / (klines.length - 1);
      const atrPct = (atr / price) * 100;
      const atrScore = atrPct >= 0.5 && atrPct <= 3
        ? 1 - Math.abs(atrPct - 1.5) / 1.5
        : 0;

      const fundingRate    = parseFloat(frData?.lastFundingRate || 0);
      const fundingScore   = Math.min(Math.abs(fundingRate) / 0.003, 1);

      const volNorm      = Math.min(parseFloat(t.quoteVolume) / 3e9, 1);
      const trendNorm    = Math.min(trendStrength / 2, 1);
      const momNorm      = Math.min(Math.abs(momentum4h) / 3, 1);
      const oiNorm       = Math.min(oi / 1e9, 1);
      const cohBonus     = momentumCoherent ? 0.1 : 0;
      const volGrowBonus = volGrowing ? 0.1 : 0;

      const scanScore = +(
        volNorm      * 0.25 +
        trendNorm    * 0.25 +
        momNorm      * 0.20 +
        oiNorm       * 0.15 +
        atrScore     * 0.10 +
        fundingScore * 0.05 +
        cohBonus     +
        volGrowBonus
      ).toFixed(4);

      return {
        symbol,
        scanScore,
        volume24h:       +parseFloat(t.quoteVolume).toFixed(0),
        priceChangePct:  parseFloat(t.priceChangePercent),
        lastPrice:       price,
        openInterest:    +oi.toFixed(0),
        trendDir,
        trendStrength:   +trendStrength.toFixed(3),
        momentum4h:      +momentum4h.toFixed(3),
        atrPct:          +atrPct.toFixed(3),
        fundingRate,
        volRatio:        +volRatio.toFixed(3),
        volGrowing,
        momentumCoherent
      };

    }catch(err){
      console.log(`Scanner error ${symbol}: ${err.message}`);
      return null;
    }
  }));

  // Agregar resultados válidos
  batchResults.filter(Boolean).forEach(r => enriched.push(r));
}

const candidates = enriched
  .sort((a, b) => b.scanScore - a.scanScore)
  .slice(0, TOP_N);

console.log(`Scanner: ${base.length} símbolos → ${enriched.length} válidos → top ${candidates.length}`);

if(candidates.length === 0){
  return [{
    json: {
      noSymbols:     true,
      balance:       input.balance,
      openCount:     input.openCount,
      openSymbols,
      dailyPnL:      input.dailyPnL,
      dailyPnLPct:   input.dailyPnLPct,
      marketContext: input.marketContext || null
    }
  }];
}

return candidates.map(c => ({
  json: {
    ...c,
    balance:          input.balance,
    availableBalance: input.availableBalance,
    dailyPnL:         input.dailyPnL,
    dailyPnLPct:      input.dailyPnLPct,
    openCount:        input.openCount,
    openSymbols,
    marketContext:    input.marketContext || null
  }
}));
```

---

## Indicators and Scoring

```javascript
// === INDICATOR FUNCTIONS ===
function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  return prices.reduce((acc, p, i) => { acc.push(i === 0 ? p : p * k + acc[i - 1] * (1 - k)); return acc; }, []);
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return [50];
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { const d = prices[i] - prices[i - 1]; if (d > 0) ag += d; else al -= d; }
  ag /= period; al /= period;
  const res = [];
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    res.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
  }
  return res.length ? res : [50];
}

function calcATR(highs, lows, closes, period = 14) {
  const tr = [];
  for (let i = 1; i < highs.length; i++)
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  if (tr.length < period) return [tr.reduce((a, b) => a + b, 0) / (tr.length || 1)];
  const res = [tr.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < tr.length; i++) res.push((res[res.length - 1] * (period - 1) + tr[i]) / period);
  return res;
}

function calcVWAP(highs, lows, closes, volumes) {
  let tpv = 0, vol = 0;
  for (let i = 0; i < closes.length; i++) { const tp = (highs[i] + lows[i] + closes[i]) / 3; tpv += tp * volumes[i]; vol += volumes[i]; }
  return vol > 0 ? tpv / vol : closes[closes.length - 1];
}

// === SCORING ALGORITHM ===
function scoreSignal(ind) {
  let L = 0, S = 0;

  // TREND (40 pts)
  if (ind.ema8 > ind.ema21) L += 15; else S += 15;
  if (ind.ema8 > ind.ema21 && ind.ema21 > ind.ema50) L += 25;
  else if (ind.ema8 < ind.ema21 && ind.ema21 < ind.ema50) S += 25;
  const emaSpread = Math.abs(ind.ema8 - ind.ema50) / ind.ema50 * 100;
  if (emaSpread > 1.0) { if (ind.ema8 > ind.ema50) L += 5; else S += 5; }

  // MOMENTUM RSI (25 pts)
  // Fix: RSI extremo bajo en tendencia bajista ahora da más pts SHORT
  const r = ind.rsi14;
  if (r > 55 && r < 70)       { L += 20; }
  else if (r >= 70)            { L += 8;  }
  else if (r > 50 && r <= 55)  { L += 10; }
  else if (r < 45 && r > 30)   { S += 20; }
  else if (r <= 30 && r > 20)  { S += 15; } // oversold en tendencia — momentum bajista fuerte
  else if (r <= 20)            { S += 10; } // extremo absoluto — momentum pero riesgo rebote
  else if (r < 50 && r >= 45)  { S += 10; }

  // VOLUME (20 pts)
  const vr = ind.volRatio;
  if (vr >= 2.0)      { L += 15; S += 15; }
  else if (vr >= 1.5) { L += 10; S += 10; }
  else if (vr >= 1.2) { L += 6;  S += 6;  }
  else if (vr >= 0.8) { L += 2;  S += 2;  }
  else                { L -= 3;  S -= 3;  }

  // VWAP estructura (15 pts)
  const vwapDiff = (ind.currentPrice - ind.vwap) / ind.vwap * 100;
  if (vwapDiff > 0.5)       { L += 15; }
  else if (vwapDiff > 0.1)  { L += 8;  }
  else if (vwapDiff < -0.5) { S += 15; }
  else if (vwapDiff < -0.1) { S += 8;  }
  else                      { L += 3; S += 3; }

  // FUNDING RATE (10 pts)
  const fr = ind.fundingRate;
  if (fr > 0.0005)       { S += 10; }
  else if (fr > 0.0001)  { S += 5;  }
  else if (fr < -0.0005) { L += 10; }
  else if (fr < -0.0001) { L += 5;  }

  // OI bonus
  if (ind.oiChangePct > 2) { L += 5; S += 5; }

  // ATR penalty
  if (ind.atrPct > 8)      { L *= 0.5; S *= 0.5; }
  else if (ind.atrPct > 5) { L *= 0.75; S *= 0.75; }

  L = Math.max(0, Math.min(100, Math.round(L)));
  S = Math.max(0, Math.min(100, Math.round(S)));

  console.log(`scoreSignal: L=${L} S=${S} rsi=${ind.rsi14} vwapDiff=${((ind.currentPrice-ind.vwap)/ind.vwap*100).toFixed(2)}% vol=${ind.volRatio} atr=${ind.atrPct}`);

  // Umbral normal
  if (L >= 50 && L > S) return { score: L, direction: 'LONG',  longScore: L, shortScore: S };
  if (S >= 50 && S > L) return { score: S, direction: 'SHORT', longScore: L, shortScore: S };
  
  // Umbral reducido — señal clara aunque no llegue a 50
  // Aplica cuando una dirección tiene al menos 35pts Y es significativamente mayor que la otra
  if (S >= 35 && S > L * 1.5) return { score: S, direction: 'SHORT', longScore: L, shortScore: S };
  if (L >= 35 && L > S * 1.5) return { score: L, direction: 'LONG',  longScore: L, shortScore: S };

  return { score: Math.max(L, S), direction: 'NEUTRAL', longScore: L, shortScore: S };
}

// === PROCESS ALL SYMBOLS IN PARALLEL ===
const items = $input.all();

const results = await Promise.all(items.map(async item => {
  const { symbol, balance, availableBalance, dailyPnL, dailyPnLPct, openCount, openSymbols, scanScore, volume24h, priceChangePct } = item.json;
  try {
    const [klines1h, klines4h, fundingData, oiData] = await Promise.all([
      this.helpers.httpRequest({ method: 'GET', url: `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=100`, json: true }),
      this.helpers.httpRequest({ method: 'GET', url: `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`,  json: true }),
      this.helpers.httpRequest({ method: 'GET', url: `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=2`, json: true }),
      this.helpers.httpRequest({ method: 'GET', url: `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, json: true })
    ]);

    const closes1h  = klines1h.map(k => parseFloat(k[4]));
    const highs1h   = klines1h.map(k => parseFloat(k[2]));
    const lows1h    = klines1h.map(k => parseFloat(k[3]));
    const volumes1h = klines1h.map(k => parseFloat(k[5]));

    const ema8v  = calcEMA(closes1h, 8);
    const ema21v = calcEMA(closes1h, 21);
    const ema50v = calcEMA(closes1h, 50);
    const rsi14v = calcRSI(closes1h, 14);
    const atr14v = calcATR(highs1h, lows1h, closes1h, 14);
    const vwapV  = calcVWAP(highs1h, lows1h, closes1h, volumes1h);

    const currentPrice = closes1h[closes1h.length - 1];
    const avgVol20     = volumes1h.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currVol      = volumes1h[volumes1h.length - 2];
    const atrVal       = atr14v[atr14v.length - 1] || currentPrice * 0.02;
    const atrPct       = (atrVal / currentPrice) * 100;
    const fundingRate  = parseFloat((Array.isArray(fundingData) ? fundingData : []).slice(-1)[0]?.fundingRate || 0);
    const currentOI    = parseFloat(oiData.openInterest || 0);

    const ind = {
      ema8:         +ema8v[ema8v.length - 1].toFixed(4),
      ema21:        +ema21v[ema21v.length - 1].toFixed(4),
      ema50:        +ema50v[ema50v.length - 1].toFixed(4),
      rsi14:        +rsi14v[rsi14v.length - 1].toFixed(2),
      atr:          +atrVal.toFixed(4),
      atrPct:       +atrPct.toFixed(3),
      vwap:         +vwapV.toFixed(4),
      volRatio:     avgVol20 > 0 ? +(currVol / avgVol20).toFixed(3) : 1,
      fundingRate,
      currentOI,
      oiChangePct:  0,
      currentPrice: +currentPrice.toFixed(4)
    };

    const sig = scoreSignal(ind);

    const closes4h = klines4h.map(k => parseFloat(k[4]));
    const highs4h  = klines4h.map(k => parseFloat(k[2]));
    const lows4h   = klines4h.map(k => parseFloat(k[3]));

    const ema8_4h  = calcEMA(closes4h, 8);
    const ema21_4h = calcEMA(closes4h, 21);
    const ema50_4h = calcEMA(closes4h, 50);
    const rsi_4h   = calcRSI(closes4h, 14);
    const atr_4h   = calcATR(highs4h, lows4h, closes4h, 14);

    const e8_4h    = ema8_4h[ema8_4h.length - 1];
    const e21_4h   = ema21_4h[ema21_4h.length - 1];
    const e50_4h   = ema50_4h[ema50_4h.length - 1];
    const rsi4h    = rsi_4h[rsi_4h.length - 1];
    const atr4h    = atr_4h[atr_4h.length - 1];
    const price4h  = closes4h[closes4h.length - 1];

    const trend4hLong  = e8_4h > e21_4h && e21_4h > e50_4h;
    const trend4hShort = e8_4h < e21_4h && e21_4h < e50_4h;
    const trend4h      = trend4hLong ? 'LONG' : trend4hShort ? 'SHORT' : 'NEUTRAL';

    const rsi4hStrong  = (sig.direction === 'LONG'  && rsi4h > 50 && rsi4h < 75)
                      || (sig.direction === 'SHORT' && rsi4h < 50 && rsi4h > 25);
    const rsi4hDanger  = (sig.direction === 'LONG'  && rsi4h > 80)
                      || (sig.direction === 'SHORT' && rsi4h < 20);

    let tf4hAdjust = 0;
    let tf4hStatus = 'NEUTRAL';

    if(sig.direction === 'LONG'){
      if(trend4hLong){
        tf4hAdjust = rsi4hStrong ? +8 : +4;
        tf4hStatus = 'CONFIRMS';
      } else if(trend4hShort){
        tf4hAdjust = -20;
        tf4hStatus = 'CONTRADICTS';
      } else {
        tf4hAdjust = -5;
        tf4hStatus = 'NEUTRAL';
      }
    } else if(sig.direction === 'SHORT'){
      if(trend4hShort){
        tf4hAdjust = rsi4hStrong ? +8 : +4;
        tf4hStatus = 'CONFIRMS';
      } else if(trend4hLong){
        tf4hAdjust = -20;
        tf4hStatus = 'CONTRADICTS';
      } else {
        tf4hAdjust = -5;
        tf4hStatus = 'NEUTRAL';
      }
    }

    if(rsi4hDanger) tf4hAdjust -= 15;

    const scoreWith4h    = Math.min(100, Math.max(0, Math.round(sig.score + tf4hAdjust)));
    const directionFinal = tf4hStatus === 'CONTRADICTS' && scoreWith4h < 50
      ? 'NEUTRAL'
      : sig.direction;

    console.log(`${symbol}: 1h=${sig.direction}(${sig.score}) 4h=${trend4h}(${tf4hStatus}${tf4hAdjust>=0?'+':''}${tf4hAdjust}) → final=${directionFinal}(${scoreWith4h}) RSI4h=${rsi4h.toFixed(1)}`);

    return {
      json: {
        symbol, scanScore, volume24h, priceChangePct,
        balance, availableBalance, dailyPnL, dailyPnLPct, openCount, openSymbols,
        score:      scoreWith4h,
        direction:  directionFinal,
        longScore:  sig.longScore,
        shortScore: sig.shortScore,
        indicators: ind,
        candles: {
          closes:  closes1h.slice(-5),
          highs:   highs1h.slice(-5),
          lows:    lows1h.slice(-5),
          volumes: volumes1h.slice(-5)
        },
        tf4h: {
          trend:     trend4h,
          status:    tf4hStatus,
          adjust:    tf4hAdjust,
          ema8:      +e8_4h.toFixed(4),
          ema21:     +e21_4h.toFixed(4),
          ema50:     +e50_4h.toFixed(4),
          rsi:       +rsi4h.toFixed(2),
          atr:       +atr4h.toFixed(4),
          price:     +price4h.toFixed(4),
          confirms:  tf4hStatus === 'CONFIRMS'
        },
        marketContext: item.json.marketContext || null
      }
    };
  } catch(e) {
    console.log(`ERROR ${symbol}: ${e.message}`);
    return { json: {
      symbol, score: 0, direction: 'NEUTRAL', error: e.message,
      balance, availableBalance, openCount, openSymbols,
      marketContext: item.json.marketContext || null
    }};
  }
}));

return results;
```

---

## Aggregate Best Setup

```javascript
const items = $input.all().map(i => i.json);

// ── Consultar cooldowns activos desde dashboard ───────────────────────────────
let activeCooldowns = {};
try{
  const cdResp = await this.helpers.httpRequest({
    method: 'GET', url: 'http://18.228.14.96:3001/cooldown/status', json: true
  });
  activeCooldowns = cdResp.active || {};
}catch(e){ console.log('[Cooldown] status error:', e.message); }

// ── Rotación — cycleIndex persiste en Static Data ─────────────────────────────
const state = $getWorkflowStaticData('global');
if(!state.cycleIndex) state.cycleIndex = 0;

const sharedMarketContext = items[0]?.marketContext || null;
const openSyms = items[0]?.openSymbols || [];

const scoreLog = items.map(i => `${i.symbol}:${i.score}(${i.direction})`).join(' | ');
console.log('Scores:', scoreLog);
console.log('Open symbols:', openSyms.join(',') || 'ninguno');
console.log('Cooldowns activos:', Object.keys(activeCooldowns).join(',') || 'ninguno');
console.log('Cycle index:', state.cycleIndex);

// ── Macro cooldown tracking ───────────────────────────────────────────────────
// Si un símbolo fue bloqueado por macro en el ciclo anterior, darle pausa temporal
if(!state.macroCooldowns) state.macroCooldowns = {};
const now = Date.now();

// Limpiar macro cooldowns expirados (15 min)
for(const sym of Object.keys(state.macroCooldowns)){
  if(now - state.macroCooldowns[sym] > 15 * 60 * 1000){
    delete state.macroCooldowns[sym];
    console.log(`[MacroCooldown] ${sym} expirado`);
  }
}

const valid = items
  .filter(d =>
    !d.error &&
    d.direction !== 'NEUTRAL' &&
    d.score >= 45 &&
    !openSyms.includes(d.symbol) &&
    !activeCooldowns[d.symbol] &&
    !state.macroCooldowns[d.symbol]  // ← excluir símbolos en macro cooldown
  )
  .sort((a, b) => b.score - a.score);

if(valid.length === 0){
  // NO limpiar cooldowns — dejar que expiren naturalmente
  const best = items.filter(d => !d.error).sort((a,b) => b.score - a.score)[0];
  console.log(`[Aggregate] Sin candidatos válidos — mejor disponible: ${best?.symbol}=${best?.score}pts`);
  return [{
    json: {
      noSetup:       true,
      reason:        `Sin setup válido — mejor: ${best?.symbol}=${best?.score}pts (${best?.direction}) | ${scoreLog}`,
      balance:       items[0]?.balance,
      openCount:     items[0]?.openCount,
      openSymbols:   openSyms,
      marketContext: sharedMarketContext
    }
  }];
}

// ── Rotación forzada entre top 3 ──────────────────────────────────────────────
const rotationSlot = state.cycleIndex % Math.min(3, valid.length);
const primary      = valid[rotationSlot];
const fallbacks    = valid.filter(f => f.symbol !== primary.symbol && !openSyms.includes(f.symbol));

state.cycleIndex = (state.cycleIndex + 1) % 3;

console.log(`Rotación slot=${rotationSlot} → ${primary.symbol} (score=${primary.score} dir=${primary.direction}) | fallbacks=${fallbacks.map(f=>f.symbol).join(',')}`);

return [{
  json: {
    ...primary,
    noSetup: false,
    rotationSlot,
    fallbackCandidates: fallbacks.map(f => ({
      symbol:         f.symbol,
      score:          f.score,
      direction:      f.direction,
      scanScore:      f.scanScore,
      longScore:      f.longScore,
      shortScore:     f.shortScore,
      indicators:     f.indicators,
      candles:        f.candles,
      volume24h:      f.volume24h,
      priceChangePct: f.priceChangePct,
      tf4h:           f.tf4h || null,
      marketContext:  sharedMarketContext
    }))
  }
}];
```

---

## AI Market Context

```javascript
const ANTHROPIC_KEY = 'YOUR_ANTHROPIC_API_KEY';
const d = $input.first().json;

const sigScore   = Number(d.score || 0);
const symbol     = d.symbol;
const direction  = d.direction || 'NEUTRAL';
const indicators = d.indicators || {};
const candles    = d.candles || {};
const fallbacks  = d.fallbackCandidates || [];
const openCount  = d.openCount || 0;

const tf4h      = d.tf4h || {};
const marketCtx = d.marketContext || {};

// ── THRESHOLD DINÁMICO ────────────────────────────────────────────────────────
let dynamicThreshold = 65;
const macroBias  = marketCtx.market_bias || 'NEUTRAL';
const tf4hStatus = tf4h.status || 'NEUTRAL';

const macroAlignsWithDirection =
  (macroBias === 'BEARISH' && direction === 'SHORT') ||
  (macroBias === 'BULLISH' && direction === 'LONG');

const macroContradictsDirection =
  (macroBias === 'BEARISH' && direction === 'LONG') ||
  (macroBias === 'BULLISH' && direction === 'SHORT');

if(macroContradictsDirection || tf4hStatus === 'CONTRADICTS'){
  dynamicThreshold = 80;
} else if(macroAlignsWithDirection && tf4hStatus === 'CONFIRMS'){
  dynamicThreshold = 62;
} else if(macroAlignsWithDirection && tf4hStatus === 'NEUTRAL'){
  dynamicThreshold = 64;
} else if(macroAlignsWithDirection && tf4hStatus === 'CONTRADICTS'){
  dynamicThreshold = 75;
} else if(macroBias === 'NEUTRAL' && tf4hStatus === 'CONFIRMS'){
  dynamicThreshold = 65;
} else if(macroBias === 'NEUTRAL' && tf4hStatus === 'NEUTRAL'){
  dynamicThreshold = 70;
} else {
  dynamicThreshold = 67;
}

if(openCount >= 2)      dynamicThreshold += 8;
else if(openCount >= 1) dynamicThreshold += 4;

// ── MEJORA 3: Módulo de volatilidad desaprovechada ────────────────────────────
let volatilityBonus = 0;
try{
  const cdResp = await this.helpers.httpRequest({
    method: 'GET', url: 'http://18.228.14.96:3001/cooldown/status', json: true
  });
  const activeCooldowns = Object.keys(cdResp.active || {}).length;
  const atrPct = Number(indicators.atrPct || 0);
  const highVolatility = atrPct > 2.0;

  if(openCount === 0 && activeCooldowns >= 5 && highVolatility && direction === 'SHORT' && macroAlignsWithDirection){
    volatilityBonus = 8;
    console.log(`[${symbol}] Volatility bonus activado: ${activeCooldowns} cooldowns activos, ATR=${atrPct}%`);
  }
}catch(e){ console.log('[NO-IMG] Volatility check error:', e.message); }

dynamicThreshold = Math.max(55, dynamicThreshold - volatilityBonus);

// ── Ajuste de inteligencia ────────────────────────────────────────────────────
const intel = marketCtx.intelligenceSignal || {};
let intelAdjFinal = 0;

const hasAdjustment = (intel.scoreAdjustment?.ifLong || 0) !== 0 ||
                      (intel.scoreAdjustment?.ifShort || 0) !== 0;

if(intel.signal && intel.confidence !== 'baja' && hasAdjustment){
  const rawAdj = direction === 'LONG'
    ? (intel.scoreAdjustment?.ifLong  || 0)
    : direction === 'SHORT'
    ? (intel.scoreAdjustment?.ifShort || 0)
    : 0;
  intelAdjFinal = intel.confidence === 'media' ? Math.round(rawAdj * 0.6) : rawAdj;
}

console.log(`[${symbol}] dynamicThreshold=${dynamicThreshold} (macro=${macroBias} 4h=${tf4hStatus} openCount=${openCount} volBonus=${volatilityBonus})`);
console.log(`[${symbol}] Intelligence adj: ${intelAdjFinal} pts (signal=${intel.signal||'N/A'} conf=${intel.confidence||'N/A'} dir=${direction})`);

// ── Bloqueo macro ─────────────────────────────────────────────────────────────
if(marketCtx.long_ok === false && direction === 'LONG'){
  return [{
    json: {
      ...d, passAI: false, finalScore: 0,
      skipReason: `Macro bloquea LONG — ${marketCtx.reason || 'contexto desfavorable'}`,
      dynamicThreshold,
      aiResult: { regime:'NEUTRAL', direction_bias:'NEUTRAL', recommended_leverage:3, confidence_adjustment:-100, key_risk:'Macro block', reasoning:'Blocked by market agent' },
      filters: { visionReject:false, visionLate:false, rsiDangerous:false, volumeSpike:false, biasAligns:false, rangingBlock:false }
    }
  }];
}
if(marketCtx.short_ok === false && direction === 'SHORT'){
  return [{
    json: {
      ...d, passAI: false, finalScore: 0,
      skipReason: `Macro bloquea SHORT — ${marketCtx.reason || 'contexto desfavorable'}`,
      dynamicThreshold,
      aiResult: { regime:'NEUTRAL', direction_bias:'NEUTRAL', recommended_leverage:3, confidence_adjustment:-100, key_risk:'Macro block', reasoning:'Blocked by market agent' },
      filters: { visionReject:false, visionLate:false, rsiDangerous:false, volumeSpike:false, biasAligns:false, rangingBlock:false }
    }
  }];
}

// ── Contextos para el prompt ──────────────────────────────────────────────────
const rsi = indicators.rsi14 || 50;
const rsiLabel = rsi <= 25 ? '(SOBREVENDIDO EXTREMO — PELIGRO SHORT)'
               : rsi <= 35 ? '(sobrevendido — posible rebote)'
               : rsi >= 75 ? '(SOBRECOMPRADO EXTREMO — PELIGRO LONG)'
               : rsi >= 65 ? '(sobrecomprado — posible corrección)'
               : rsi <= 45 ? '(zona baja)'
               : rsi >= 55 ? '(zona alta)'
               : '(neutral)';

const tf4hContext = tf4h.trend
  ? `CONFIRMACIÓN 4H (ALTA PRIORIDAD):
- Tendencia 4h: ${tf4h.trend}
- Estado vs señal 1h: ${tf4h.status} (ajuste: ${tf4h.adjust >= 0 ? '+' : ''}${tf4h.adjust}pts)
- EMA8/21/50 en 4h: ${tf4h.ema8}/${tf4h.ema21}/${tf4h.ema50}
- RSI 4h: ${tf4h.rsi}
${tf4h.status === 'CONTRADICTS' ? '⚠️ ALERTA: La tendencia 4h CONTRADICE la señal 1h — reduce confianza significativamente' : ''}
${tf4h.status === 'CONFIRMS' ? '✅ La tendencia 4h CONFIRMA la señal 1h — señal de mayor calidad' : ''}`
  : 'Sin datos 4h disponibles.';

const macroContext = marketCtx.market_bias
  ? `CONTEXTO MACRO:
- Sesgo del mercado: ${marketCtx.market_bias} (confianza: ${marketCtx.confidence}%)
- Fear & Greed: ${marketCtx.fearGreed?.value || 'N/A'}/100 (${marketCtx.fearGreed?.classification || 'N/A'})
- BTC cambio 12h: ${marketCtx.btcChange || 'N/A'}%
- Size multiplier macro: ${marketCtx.size_multiplier || 1.0}x
- Razón: ${marketCtx.reason || 'N/A'}`
  : 'Sin contexto macro disponible.';

const intelContext = intel.signal
  ? `SEÑAL DE INTELIGENCIA (noticias + sesiones):
- Señal: ${intel.signal} (confianza: ${intel.confidence})
- Sesgo noticias/sesiones: ${intel.bias}
- Ajuste aplicado al score: ${intelAdjFinal >= 0 ? '+' : ''}${intelAdjFinal} pts
${intel.alerts?.length ? intel.alerts.map(a => `- ⚠️ ${a.title}: ${a.detail}`).join('\n') : '- Sin alertas activas'}`
  : '';

const volatilityCtx = volatilityBonus > 0
  ? `\n⚡ MODO VOLATILIDAD ACTIVO: threshold reducido ${volatilityBonus}pts por mercado en pánico con ${openCount} trades abiertos`
  : '';

const prompt = `Eres un trader profesional de crypto futures. Analiza ${symbol} en 1h con contexto completo.

SEÑAL: direction=${direction}, score_base=${sigScore}
THRESHOLD MÍNIMO: ${dynamicThreshold} pts${volatilityCtx}

${tf4hContext}

${macroContext}

${intelContext}

INDICADORES 1H:
- EMA8=${indicators?.ema8}, EMA21=${indicators?.ema21}, EMA50=${indicators?.ema50}
- RSI14=${rsi} ${rsiLabel}
- ATR%=${indicators?.atrPct}, FundingRate=${indicators?.fundingRate}
- VolRatio=${indicators?.volRatio}x (vs 20-bar avg)
- Precio=${indicators?.currentPrice}, VWAP=${indicators?.vwap}

Últimas 5 velas: ${(candles?.closes || []).map(v => (+v).toFixed(4)).join(' → ')}

REGLAS:
1. Si 4h CONTRADICE → confidence_adjustment máximo -15, leverage máximo 4x
2. Si 4h CONFIRMA → puedes dar confidence_adjustment positivo hasta +8
3. Mercado BEARISH macro + señal LONG → confidence_adjustment mínimo -20
4. Mercado BEARISH macro + señal SHORT → señal válida, mantener o subir confianza
5. RSI 4h > 75 en LONG o < 25 en SHORT → reducir leverage a máximo 3x
6. Score final < ${dynamicThreshold} → rechazar
7. Señal NO OPERAR o conflicto de inteligencia → reducir confianza adicional
8. En mercado de pánico extremo con SHORT alineado macro → priorizar continuación bajista

Responde SOLO con este JSON:
{
  "regime": "TRENDING | RANGING | HIGH_VOLATILITY",
  "direction_bias": "LONG | SHORT | NEUTRAL",
  "recommended_leverage": 5,
  "confidence_adjustment": 0,
  "key_risk": "una sola oración en español",
  "reasoning": "máximo 2 oraciones en español"
}`;

let aiResult = {
  regime: 'TRENDING', direction_bias: direction,
  recommended_leverage: 5, confidence_adjustment: 0,
  key_risk: 'unknown', reasoning: 'Fallback defaults'
};

try{
  const resp = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 256, messages: [{ role: 'user', content: prompt }] }),
    json: false
  });
  const body = typeof resp === 'string' ? JSON.parse(resp) : resp;
  if(!body?.error){
    const match = (body?.content?.[0]?.text || '{}').match(/\{[\s\S]*\}/);
    if(match){ const parsed = JSON.parse(match[0]); if(parsed.regime && parsed.direction_bias) aiResult = parsed; }
  } else {
    aiResult.reasoning = 'API error: ' + JSON.stringify(body.error);
  }
}catch(e){ aiResult.reasoning = 'AI API error: ' + e.message; }

// ── Filtros ───────────────────────────────────────────────────────────────────
const adjustment    = Number(aiResult.confidence_adjustment || 0);
const finalScore    = Math.min(100, Math.max(0, sigScore + adjustment + intelAdjFinal));
const biasAligns    = aiResult.direction_bias === 'NEUTRAL' || aiResult.direction_bias === direction;
const rangingBlock  = aiResult.regime === 'RANGING' && finalScore < 65;
const rsiDangerous  = (direction === 'SHORT' && rsi < 30) || (direction === 'LONG' && rsi > 70);
const volumeSpike   = (indicators.volRatio || 0) > 4;

const tf4hPenalty   = tf4h.status === 'CONTRADICTS' ? 10 : 0;
const scoreAdjusted = Math.max(0, finalScore - tf4hPenalty);

const passAI = biasAligns && !rangingBlock && scoreAdjusted >= dynamicThreshold && !rsiDangerous && !volumeSpike;

if(passAI){
  return [{
    json: {
      ...d, aiResult, finalScore: scoreAdjusted, passAI: true, skipReason: null,
      dynamicThreshold, intelAdjFinal, volatilityBonus,
      filters: { visionReject:false, visionLate:false, rsiDangerous, volumeSpike, biasAligns, rangingBlock }
    }
  }];
}

// ── Skip reason ───────────────────────────────────────────────────────────────
let skipReason = '';
if(rsiDangerous)
  skipReason = `RSI peligroso para ${direction}: ${rsi.toFixed(1)}`;
else if(volumeSpike)
  skipReason = `Vol spike extremo (${(indicators.volRatio||0).toFixed(1)}x)`;
else if(!biasAligns)
  skipReason = `Bias conflict: AI dice ${aiResult.direction_bias} vs ${direction}`;
else if(rangingBlock)
  skipReason = `Ranging market — score ${scoreAdjusted} pts (threshold ${dynamicThreshold})`;
else if(tf4h.status === 'CONTRADICTS')
  skipReason = `4h contradice señal 1h (${tf4h.trend} vs ${direction}) — score ${scoreAdjusted} < threshold ${dynamicThreshold}`;
else
  skipReason = `Score insuficiente: ${scoreAdjusted} < threshold dinámico ${dynamicThreshold} (macro=${macroBias} 4h=${tf4hStatus} intel=${intel.signal||'N/A'} pos=${openCount})`;

console.log(`[${symbol}] Rechazado: ${skipReason} — intentando ${fallbacks.length} fallbacks`);

// ── Fallbacks ─────────────────────────────────────────────────────────────────
for(const fb of fallbacks){
  const fbRsi          = fb.indicators?.rsi14 || 50;
  const fbDir          = fb.direction;
  const fbRsiDangerous = (fbDir === 'SHORT' && fbRsi < 30) || (fbDir === 'LONG' && fbRsi > 70);
  const fbVolSpike     = (fb.indicators?.volRatio || 0) > 4;
  const fbScore        = fb.score || 0;

  if(fbRsiDangerous || fbVolSpike || fbScore < dynamicThreshold){
    console.log(`[${fb.symbol}] Fallback descartado: rsi=${fbRsiDangerous} vol=${fbVolSpike} score=${fbScore} < ${dynamicThreshold}`);
    continue;
  }
  if(marketCtx.long_ok === false && fbDir === 'LONG') continue;
  if(marketCtx.short_ok === false && fbDir === 'SHORT') continue;

  const fbTf4h = fb.tf4h || {};
  const fbRsiLabel = fbRsi <= 25 ? '(SOBREVENDIDO EXTREMO)'
                   : fbRsi <= 35 ? '(sobrevendido)'
                   : fbRsi >= 75 ? '(SOBRECOMPRADO EXTREMO)'
                   : fbRsi >= 65 ? '(sobrecomprado)'
                   : '(neutral)';

  let fbIntelAdj = 0;
  if(intel.signal && intel.confidence !== 'baja' && hasAdjustment){
    const rawAdj = fbDir === 'LONG'
      ? (intel.scoreAdjustment?.ifLong  || 0)
      : fbDir === 'SHORT'
      ? (intel.scoreAdjustment?.ifShort || 0)
      : 0;
    fbIntelAdj = intel.confidence === 'media' ? Math.round(rawAdj * 0.6) : rawAdj;
  }

  // Volatility bonus para fallbacks también
  let fbVolBonus = 0;
  if(openCount === 0 && volatilityBonus > 0 && fbDir === 'SHORT' &&
    ((macroBias === 'BEARISH' && fbDir === 'SHORT') || (macroBias === 'BULLISH' && fbDir === 'LONG'))){
    fbVolBonus = volatilityBonus;
  }
  const fbThreshold = Math.max(55, dynamicThreshold - fbVolBonus);

  const fbPrompt = `You are a professional crypto futures trader.
Symbol: ${fb.symbol} | Signal: ${fbDir} | Score: ${fbScore}
4H: ${fbTf4h.trend||'N/A'} (${fbTf4h.status||'N/A'}) | Macro: ${macroBias} | F&G: ${marketCtx.fearGreed?.value||'N/A'}
Intelligence signal: ${intel.signal||'NEUTRAL'} (confidence: ${intel.confidence||'N/A'})

INDICATORS:
- EMA8=${fb.indicators?.ema8||0}, EMA21=${fb.indicators?.ema21||0}, EMA50=${fb.indicators?.ema50||0}
- RSI14=${fbRsi} ${fbRsiLabel}, ATR%=${fb.indicators?.atrPct||0}
- VolRatio=${fb.indicators?.volRatio||0}, FundingRate=${fb.indicators?.fundingRate||0}
- CurrentPrice=${fb.indicators?.currentPrice||0}, VWAP=${fb.indicators?.vwap||0}

Return ONLY this JSON:
{
  "regime": "TRENDING | RANGING | HIGH_VOLATILITY",
  "direction_bias": "LONG | SHORT | NEUTRAL",
  "recommended_leverage": 5,
  "confidence_adjustment": 0,
  "key_risk": "one sentence",
  "reasoning": "one sentence max"
}`;

  let fbAI = { regime:'TRENDING', direction_bias:fbDir, recommended_leverage:5, confidence_adjustment:0, key_risk:'unknown', reasoning:'fallback' };
  try{
    const fbResp = await this.helpers.httpRequest({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: fbPrompt }] }),
      json: false
    });
    const fbBody = typeof fbResp === 'string' ? JSON.parse(fbResp) : fbResp;
    if(!fbBody?.error){
      const m = (fbBody?.content?.[0]?.text || '{}').match(/\{[\s\S]*\}/);
      if(m){ const p = JSON.parse(m[0]); if(p.regime) fbAI = p; }
    }
  }catch(e){ console.log(`Fallback AI error ${fb.symbol}: ${e.message}`); continue; }

  const fbAdj     = Number(fbAI.confidence_adjustment || 0);
  const fbFinal   = Math.min(100, Math.max(0, fbScore + fbAdj + fbIntelAdj));
  const fbAligns  = fbAI.direction_bias === 'NEUTRAL' || fbAI.direction_bias === fbDir;
  const fbRanging = fbAI.regime === 'RANGING' && fbFinal < 65;

  if(fbAligns && !fbRanging && fbFinal >= fbThreshold){
    console.log(`[${fb.symbol}] Fallback APROBADO score=${fbFinal} >= threshold=${fbThreshold}`);
    return [{
      json: {
        ...d,
        symbol: fb.symbol, score: fb.score, direction: fb.direction,
        longScore: fb.longScore || 0, shortScore: fb.shortScore || 0,
        scanScore: fb.scanScore, indicators: fb.indicators,
        candles: fb.candles, volume24h: fb.volume24h,
        priceChangePct: fb.priceChangePct,
        tf4h: fb.tf4h || null,
        aiVision: null, aiResult: fbAI, finalScore: fbFinal,
        passAI: true, skipReason: null,
        dynamicThreshold: fbThreshold, intelAdjFinal: fbIntelAdj,
        volatilityBonus: fbVolBonus,
        usedFallback: true, originalSymbol: symbol,
        originalSkipReason: skipReason, fallbackCandidates: [],
        filters: { visionReject:false, visionLate:false, rsiDangerous:false, volumeSpike:false, biasAligns:fbAligns, rangingBlock:false }
      }
    }];
  }
  console.log(`[${fb.symbol}] Fallback rechazado: bias=${fbAligns} ranging=${fbRanging} score=${fbFinal} < ${fbThreshold}`);
}

return [{
  json: {
    ...d, aiResult, finalScore: scoreAdjusted, passAI: false, skipReason,
    dynamicThreshold, intelAdjFinal, volatilityBonus,
    allFallbacksFailed: true,
    filters: { visionReject:false, visionLate:false, rsiDangerous, volumeSpike, biasAligns, rangingBlock }
  }
}];
```

---

## AI Market Context Image

```javascript
const ANTHROPIC_KEY = 'YOUR_ANTHROPIC_API_KEY';

const d          = $input.first().json;
const sigScore   = Number(d.score || 0);
const symbol     = d.symbol;
const direction  = d.direction || 'NEUTRAL';
const indicators = d.indicators || {};
const candles    = d.candles || {};
const vision     = d.aiVision || {};
const tf4h       = d.tf4h || {};
const marketCtx  = d.marketContext || {};
const openCount  = d.openCount || 0;

// ── THRESHOLD DINÁMICO ────────────────────────────────────────────────────────
const macroBias  = marketCtx.market_bias || 'NEUTRAL';
const tf4hStatus = tf4h.status || 'NEUTRAL';

const macroAlignsWithDirection =
  (macroBias === 'BEARISH' && direction === 'SHORT') ||
  (macroBias === 'BULLISH' && direction === 'LONG');

const macroContradictsDirection =
  (macroBias === 'BEARISH' && direction === 'LONG') ||
  (macroBias === 'BULLISH' && direction === 'SHORT');

let dynamicThreshold = 65;
if(macroContradictsDirection || tf4hStatus === 'CONTRADICTS'){
  dynamicThreshold = 80;
} else if(macroAlignsWithDirection && tf4hStatus === 'CONFIRMS'){
  dynamicThreshold = 62;
} else if(macroAlignsWithDirection && tf4hStatus === 'NEUTRAL'){
  dynamicThreshold = 64;
} else if(macroAlignsWithDirection && tf4hStatus === 'CONTRADICTS'){
  dynamicThreshold = 75;
} else if(macroBias === 'NEUTRAL' && tf4hStatus === 'CONFIRMS'){
  dynamicThreshold = 65;
} else if(macroBias === 'NEUTRAL' && tf4hStatus === 'NEUTRAL'){
  dynamicThreshold = 70;
} else {
  dynamicThreshold = 67;
}

if(openCount >= 2)      dynamicThreshold += 8;
else if(openCount >= 1) dynamicThreshold += 4;

// Con imagen — 3pts más permisivo
dynamicThreshold = Math.max(59, dynamicThreshold - 3);

// ── MEJORA 3: Módulo de volatilidad desaprovechada ────────────────────────────
// Si el mercado está muy activo y el bot no ha operado, bajar threshold
let volatilityBonus = 0;
try{
  const cdResp = await this.helpers.httpRequest({
    method: 'GET', url: 'http://18.228.14.96:3001/cooldown/status', json: true
  });
  const activeCooldowns = Object.keys(cdResp.active || {}).length;
  const atrPct = Number(indicators.atrPct || 0);
  const highVolatility = atrPct > 2.0; // ATR > 2% = volatilidad alta

  if(openCount === 0 && activeCooldowns >= 5 && highVolatility && direction === 'SHORT' && macroAlignsWithDirection){
    volatilityBonus = 8; // bajar threshold 8pts en pánico con 0 trades y muchos rechazos
    console.log(`[${symbol}][IMG] Volatility bonus activado: ${activeCooldowns} cooldowns activos, ATR=${atrPct}%`);
  }
}catch(e){ console.log('[IMG] Volatility check error:', e.message); }

dynamicThreshold = Math.max(55, dynamicThreshold - volatilityBonus);

// ── Ajuste de inteligencia ────────────────────────────────────────────────────
const intel = marketCtx.intelligenceSignal || {};
let intelAdjFinal = 0;

const hasAdjustment = (intel.scoreAdjustment?.ifLong || 0) !== 0 ||
                      (intel.scoreAdjustment?.ifShort || 0) !== 0;

if(intel.signal && intel.confidence !== 'baja' && hasAdjustment){
  const rawAdj = direction === 'LONG'
    ? (intel.scoreAdjustment?.ifLong  || 0)
    : direction === 'SHORT'
    ? (intel.scoreAdjustment?.ifShort || 0)
    : 0;
  intelAdjFinal = intel.confidence === 'media' ? Math.round(rawAdj * 0.6) : rawAdj;
}

console.log(`[${symbol}][IMG] dynamicThreshold=${dynamicThreshold} (macro=${macroBias} 4h=${tf4hStatus} openCount=${openCount} volBonus=${volatilityBonus})`);
console.log(`[${symbol}][IMG] Intelligence adj: ${intelAdjFinal} pts (signal=${intel.signal||'N/A'} conf=${intel.confidence||'N/A'} dir=${direction})`);

// ── Bloqueo macro — PRIMERO verificar dirección ───────────────────────────────
if(marketCtx.long_ok === false && direction === 'LONG'){
  return [{
    json: {
      ...d, passAI: false, finalScore: 0,
      skipReason: `Macro bloquea LONG — ${marketCtx.reason || 'contexto desfavorable'}`,
      dynamicThreshold,
      aiResult: { regime:'NEUTRAL', direction_bias:'NEUTRAL', recommended_leverage:3, confidence_adjustment:-100, key_risk:'Macro block', reasoning:'Blocked by market agent' },
      slMultiplier:1.5, tpMultiplier:2.0, riskReduction:0, leverageOverride:null,
      filters: { visionReject:false, visionLate:false, rsiDangerous:false, volumeSpike:false, biasAligns:false, rangingBlock:false }
    }
  }];
}
if(marketCtx.short_ok === false && direction === 'SHORT'){
  return [{
    json: {
      ...d, passAI: false, finalScore: 0,
      skipReason: `Macro bloquea SHORT — ${marketCtx.reason || 'contexto desfavorable'}`,
      dynamicThreshold,
      aiResult: { regime:'NEUTRAL', direction_bias:'NEUTRAL', recommended_leverage:3, confidence_adjustment:-100, key_risk:'Macro block', reasoning:'Blocked by market agent' },
      slMultiplier:1.5, tpMultiplier:2.0, riskReduction:0, leverageOverride:null,
      filters: { visionReject:false, visionLate:false, rsiDangerous:false, volumeSpike:false, biasAligns:false, rangingBlock:false }
    }
  }];
}

// ── Filtros duros ─────────────────────────────────────────────────────────────
const rsi          = indicators.rsi14 || 50;
const rsiLabel     = rsi <= 25 ? '(SOBREVENDIDO EXTREMO — PELIGRO SHORT)'
                   : rsi <= 35 ? '(sobrevendido — posible rebote)'
                   : rsi >= 75 ? '(SOBRECOMPRADO EXTREMO — PELIGRO LONG)'
                   : rsi >= 65 ? '(sobrecomprado — posible corrección)'
                   : rsi <= 45 ? '(zona baja)'
                   : rsi >= 55 ? '(zona alta)'
                   : '(neutral)';
const rsiDangerous = (direction === 'SHORT' && rsi < 25) || (direction === 'LONG' && rsi > 75);
const volumeSpike  = (indicators.volRatio || 0) > 4;
const visionReject = vision.approve_trade === false;
const visionLate   = vision.market_state === 'LATE_TREND' || vision.market_state === 'PARABOLIC';

// PARABOLIC siempre bloquea
if(visionReject && vision.market_state === 'PARABOLIC'){
  return [{
    json: {
      ...d, passAI: false, finalScore: 0,
      skipReason: `PARABOLIC detectado — rechazo inmediato: ${vision.reason}`,
      dynamicThreshold,
      aiResult: { regime:'HIGH_VOLATILITY', direction_bias:'NEUTRAL', recommended_leverage:0, confidence_adjustment:-100, key_risk:'Parabolic move', reasoning:'Blocked by vision' },
      slMultiplier:1.5, tpMultiplier:2.0, leverageOverride:null,
      filters: { visionReject, visionLate, rsiDangerous, volumeSpike, biasAligns:false, rangingBlock:false }
    }
  }];
}

// ── MEJORA 1: LATE_TREND no bloquea SHORTs alineados con macro BEARISH ────────
// Si dirección es SHORT y macro es BEARISH, montarse en la tendencia bajista es válido
const lateTrendBlocks = visionLate && !(direction === 'SHORT' && macroBias === 'BEARISH');

console.log(`[${symbol}][IMG] visionLate=${visionLate} lateTrendBlocks=${lateTrendBlocks} (dir=${direction} macro=${macroBias})`);

// ── Contextos para el prompt ──────────────────────────────────────────────────
const visionCtx = vision.market_state
  ? `ANÁLISIS DE IMAGEN (ALTA PRIORIDAD):
- Estado del chart: ${vision.market_state}
- Imagen aprueba: ${vision.approve_trade}
- Razón visual: ${vision.reason}
${vision.market_state === 'LATE_TREND' && direction === 'SHORT' && macroBias === 'BEARISH'
  ? '⚠️ LATE_TREND pero SHORT alineado con macro BEARISH — montarse en continuación, ampliar SL 2.0x, leverage máx 3x'
  : vision.market_state === 'LATE_TREND' ? '⚠️ LATE_TREND: reduce confianza -15pts, amplía SL' : ''}
${vision.market_state === 'EARLY_TREND' ? '✅ EARLY_TREND: aumenta confianza +10pts' : ''}`
  : 'Sin análisis de imagen.';

const tf4hCtx = tf4h.trend
  ? `CONFIRMACIÓN 4H:
- Tendencia 4h: ${tf4h.trend} | Estado: ${tf4h.status}
- RSI 4h: ${tf4h.rsi} | EMA8/21: ${tf4h.ema8}/${tf4h.ema21}
${tf4h.status === 'CONTRADICTS' ? '⚠️ 4h CONTRADICE señal 1h — máximo leverage 4x, confidence_adjustment negativo' : ''}
${tf4h.status === 'CONFIRMS' ? '✅ 4h CONFIRMA señal — puedes dar más confianza' : ''}`
  : '';

const macroCtx = marketCtx.market_bias
  ? `CONTEXTO MACRO:
- Sesgo: ${marketCtx.market_bias} | Fear&Greed: ${marketCtx.fearGreed?.value || 'N/A'}/100
- BTC 12h: ${marketCtx.btcChange || 'N/A'}% | Size multiplier: ${marketCtx.size_multiplier || 1.0}x`
  : '';

const intelCtx = intel.signal
  ? `SEÑAL DE INTELIGENCIA (noticias + sesiones):
- Señal: ${intel.signal} (confianza: ${intel.confidence})
- Sesgo noticias/sesiones: ${intel.bias}
- Ajuste aplicado al score: ${intelAdjFinal >= 0 ? '+' : ''}${intelAdjFinal} pts
${intel.alerts?.length ? intel.alerts.map(a => `- ⚠️ ${a.title}: ${a.detail}`).join('\n') : '- Sin alertas activas'}`
  : '';

const volatilityCtx = volatilityBonus > 0
  ? `\n⚡ MODO VOLATILIDAD ACTIVO: threshold reducido ${volatilityBonus}pts por mercado en pánico con ${openCount} trades abiertos`
  : '';

const prompt = `Eres un trader profesional de crypto futures. Analiza este setup completo y decide si operar.

SÍMBOLO: ${symbol} | DIRECCIÓN: ${direction} | SCORE BASE: ${sigScore}
THRESHOLD MÍNIMO PARA APROBAR: ${dynamicThreshold} pts${volatilityCtx}

${visionCtx}

${tf4hCtx}

${macroCtx}

${intelCtx}

INDICADORES 1H:
- EMA8=${indicators.ema8||0}, EMA21=${indicators.ema21||0}, EMA50=${indicators.ema50||0}
- RSI14=${rsi} ${rsiLabel}
- ATR%=${indicators.atrPct||0} | VolRatio=${indicators.volRatio||0}x ${(indicators.volRatio||0)>3?'(SPIKE)':''}
- FundingRate=${indicators.fundingRate||0} | VWAP=${indicators.vwap||0}
- Precio=${indicators.currentPrice||0}

Últimas 5 velas: ${(candles.closes||[]).map(v=>(+v).toFixed(4)).join(' → ')}

REGLAS:
1. RSI < 28 en SHORT = rechazar o leverage máx 3x
2. LATE_TREND en SHORT alineado con macro BEARISH = permitir con sl_multiplier 2.0, leverage máx 3x
3. LATE_TREND en LONG o contra tendencia = reduce confianza -15pts, amplía SL
4. 4h CONTRADICE = confidence_adjustment entre -10 y -20, leverage máx 4x
5. 4h CONFIRMA = puedes dar sl_multiplier más ajustado, más leverage
6. Score final < ${dynamicThreshold} = approve: false
7. Macro BEARISH + señal LONG = reduce confianza -15 mínimo
8. Señal NO OPERAR o conflicto de inteligencia → reducir confianza adicional

Responde SOLO con este JSON:
{
  "approve": true or false,
  "regime": "TRENDING | RANGING | HIGH_VOLATILITY",
  "direction_bias": "LONG | SHORT | NEUTRAL",
  "confidence_adjustment": 0,
  "recommended_leverage": 5,
  "sl_multiplier": 1.5,
  "tp_multiplier": 2.5,
  "risk_reduction": 0,
  "key_risk": "una sola oración en español",
  "reasoning": "máximo 2 oraciones en español"
}`;

let aiResult = {
  approve: false, regime:'TRENDING', direction_bias:direction,
  recommended_leverage:5, confidence_adjustment:0,
  sl_multiplier:1.5, tp_multiplier:2.0, risk_reduction:0,
  key_risk:'fallback', reasoning:'fallback defaults'
};

try{
  const resp = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:350, messages:[{ role:'user', content:prompt }] }),
    json: false
  });
  const body = typeof resp === 'string' ? JSON.parse(resp) : resp;
  if(!body?.error){
    const match = (body?.content?.[0]?.text || '{}').match(/\{[\s\S]*\}/);
    if(match){ const parsed = JSON.parse(match[0]); if(parsed.regime) aiResult = parsed; }
  }
}catch(e){ aiResult.reasoning = 'AI error: ' + e.message; }

// ── Score final ───────────────────────────────────────────────────────────────
const adjustment    = Number(aiResult.confidence_adjustment || 0);
const finalScore    = Math.min(100, Math.max(0, sigScore + adjustment + intelAdjFinal));
const biasAligns    = aiResult.direction_bias === 'NEUTRAL' || aiResult.direction_bias === direction;
const rangingBlock  = aiResult.regime === 'RANGING' && finalScore < 60;

const tf4hPenalty   = tf4h.status === 'CONTRADICTS' ? 10 : 0;
const scoreAdjusted = Math.max(0, finalScore - tf4hPenalty);

const macroRiskReduction = Math.max(0, 1 - (marketCtx.size_multiplier || 1.0));
const finalRiskReduction = Math.min(0.7, (aiResult.risk_reduction || 0) + macroRiskReduction);

// ── MEJORA 2: passAI usa lateTrendBlocks en vez de visionLate directo ─────────
const passAI =
  aiResult.approve === true &&
  biasAligns &&
  !rangingBlock &&
  scoreAdjusted >= dynamicThreshold &&
  !rsiDangerous &&
  !volumeSpike &&
  !(visionReject && lateTrendBlocks);

let skipReason = null;
if(!passAI){
  if(rsiDangerous)
    skipReason = `RSI peligroso para ${direction}: ${rsi.toFixed(1)}`;
  else if(volumeSpike)
    skipReason = `Vol spike extremo (${(indicators.volRatio||0).toFixed(1)}x)`;
  else if(visionReject && lateTrendBlocks)
    skipReason = `Chart ${vision.market_state} + imagen rechaza: ${vision.reason}`;
  else if(visionReject)
    skipReason = `Imagen rechaza: ${vision.reason}`;
  else if(lateTrendBlocks && visionLate)
    skipReason = `Tendencia extendida (${vision.market_state}) — no permitido para ${direction}`;
  else if(!biasAligns)
    skipReason = `Bias conflict: AI dice ${aiResult.direction_bias} vs ${direction}`;
  else if(rangingBlock)
    skipReason = `Ranging + score bajo (${scoreAdjusted})`;
  else if(tf4h.status === 'CONTRADICTS')
    skipReason = `4h contradice 1h (${tf4h.trend} vs ${direction}) score=${scoreAdjusted} < threshold ${dynamicThreshold}`;
  else if(!aiResult.approve)
    skipReason = `AI rechaza: ${aiResult.key_risk}`;
  else
    skipReason = `Score insuficiente: ${scoreAdjusted} < threshold dinámico ${dynamicThreshold} (macro=${macroBias} 4h=${tf4hStatus} intel=${intel.signal||'N/A'} pos=${openCount})`;
}

console.log(`[${symbol}][IMG] passAI=${passAI} score=${scoreAdjusted} threshold=${dynamicThreshold} lateTrendBlocks=${lateTrendBlocks} volBonus=${volatilityBonus}`);

return [{
  json: {
    ...d,
    aiResult,
    finalScore:       scoreAdjusted,
    passAI,
    skipReason,
    dynamicThreshold,
    intelAdjFinal,
    volatilityBonus,
    slMultiplier:     aiResult.sl_multiplier  || 1.5,
    tpMultiplier:     aiResult.tp_multiplier  || 2.0,
    riskReduction:    finalRiskReduction,
    leverageOverride: aiResult.recommended_leverage || null,
    usedFallback:     false,
    originalSymbol:   symbol,
    filters: { visionReject, visionLate, rsiDangerous, volumeSpike, biasAligns, rangingBlock }
  }
}];
```

---

## Position Sizer

```javascript
const d = $input.first().json;
const { symbol, direction, finalScore, indicators, aiResult, balance, availableBalance, openCount, openSymbols, candles, intelAdjFinal } = d;

const currentPrice = indicators.currentPrice;
const atrVal       = indicators.atr;

// ── Parámetros base ───────────────────────────────────────────────────────────
const BASE_RISK_PCT  = 0.02;
const MAX_MARGIN_PCT = 0.30;
const MIN_RISK_PCT   = 0.005;

// ── Score multiplier ──────────────────────────────────────────────────────────
let scoreMultiplier = 1.0;
if      (finalScore >= 80) scoreMultiplier = 1.5;
else if (finalScore >= 70) scoreMultiplier = 1.25;
else if (finalScore >= 60) scoreMultiplier = 1.0;
else if (finalScore >= 55) scoreMultiplier = 0.7;
else                       scoreMultiplier = 0.5;

// ── Vision multiplier ─────────────────────────────────────────────────────────
const marketState = d.aiVision?.market_state || 'UNKNOWN';
let visionMultiplier = 1.0;
if      (marketState === 'EARLY_TREND') visionMultiplier = 1.3;
else if (marketState === 'MID_TREND')   visionMultiplier = 1.1;
else if (marketState === 'LATE_TREND')  visionMultiplier = 0.6;
else if (marketState === 'PARABOLIC')   visionMultiplier = 0.3;

// ── Régimen multiplier ────────────────────────────────────────────────────────
const regime = aiResult?.regime || 'TRENDING';
let regimeMultiplier = 1.0;
if      (regime === 'TRENDING')        regimeMultiplier = 1.1;
else if (regime === 'RANGING')         regimeMultiplier = 0.8;
else if (regime === 'HIGH_VOLATILITY') regimeMultiplier = 0.7;

// ── 4h multiplier ─────────────────────────────────────────────────────────────
const tf4h = d.tf4h || {};
let tf4hMultiplier = 1.0;
if      (tf4h.status === 'CONFIRMS')    tf4hMultiplier = 1.1;
else if (tf4h.status === 'NEUTRAL')     tf4hMultiplier = 0.95;
else if (tf4h.status === 'CONTRADICTS') tf4hMultiplier = 0.6;

// ── Macro multiplier ──────────────────────────────────────────────────────────
const macroSizeMultiplier = d.marketContext?.size_multiplier || 1.0;

// ── Open positions penalty ────────────────────────────────────────────────────
let openPenalty = 1.0;
if      (openCount >= 3) openPenalty = 0.5;
else if (openCount >= 2) openPenalty = 0.7;
else if (openCount >= 1) openPenalty = 0.85;

// ── Risk reduction desde AI ───────────────────────────────────────────────────
const aiRiskReduction = d.riskReduction || 0;

// ── Riesgo efectivo ───────────────────────────────────────────────────────────
const rawRisk = BASE_RISK_PCT
  * scoreMultiplier
  * visionMultiplier
  * regimeMultiplier
  * tf4hMultiplier
  * macroSizeMultiplier
  * openPenalty
  * (1 - aiRiskReduction);

const effectiveRisk = Math.min(0.05, Math.max(MIN_RISK_PCT, rawRisk));

// ── Leverage ──────────────────────────────────────────────────────────────────
const maxLeverage = tf4h.status === 'CONTRADICTS' ? 4 : 15;
const leverage = Math.min(Math.max(d.leverageOverride || aiResult?.recommended_leverage || 5, 2), maxLeverage);

// ── SL y TP ───────────────────────────────────────────────────────────────────
const slMultiplier = d.slMultiplier || 1.5;
const tpMultiplier = d.tpMultiplier || 2.0;

// ── Qty ───────────────────────────────────────────────────────────────────────
const slDistance = atrVal * slMultiplier;
const riskAmount = balance * effectiveRisk;
let   qty        = riskAmount / slDistance;

const margin = (qty * currentPrice) / leverage;
if(margin > balance * MAX_MARGIN_PCT){
  qty = (balance * MAX_MARGIN_PCT * leverage) / currentPrice;
}

const pricePrecision = currentPrice >= 1000 ? 1 : currentPrice >= 10 ? 2 : currentPrice >= 1 ? 3 : 4;
const qtyPrecision   = currentPrice >= 1000 ? 3 : currentPrice >= 10 ? 2 : 1;
qty = Math.floor(qty * Math.pow(10, qtyPrecision)) / Math.pow(10, qtyPrecision);

let sl, tp, side;
if(direction === 'LONG'){
  side = 'BUY';
  sl   = +(currentPrice - slDistance).toFixed(pricePrecision);
  tp   = +(currentPrice + slDistance * tpMultiplier).toFixed(pricePrecision);
} else {
  side = 'SELL';
  sl   = +(currentPrice + slDistance).toFixed(pricePrecision);
  tp   = +(currentPrice - slDistance * tpMultiplier).toFixed(pricePrecision);
}

// ── P&L real basado en qty final ─────────────────────────────────────────────
const maxLoss        = +(Math.abs(currentPrice - sl) * qty).toFixed(2);
const maxGain        = +(maxLoss * tpMultiplier).toFixed(2);
const marginRequired = +((qty * currentPrice) / leverage).toFixed(2);

// riskAmount y riskPct consistentes con qty final (no con la estimación previa al truncado)
const actualRiskAmount = maxLoss;
const actualRiskPct    = +(actualRiskAmount / balance * 100).toFixed(2);

console.log(`[${symbol}] sizing: score=${finalScore} 4h=${tf4h.status||'N/A'} macro=${macroSizeMultiplier}x vision=${marketState} regime=${regime} open=${openCount}`);
console.log(`[${symbol}] multipliers: score=${scoreMultiplier} 4h=${tf4hMultiplier} macro=${macroSizeMultiplier} vision=${visionMultiplier} regime=${regimeMultiplier} openPenalty=${openPenalty} aiRed=${aiRiskReduction}`);
console.log(`[${symbol}] result: risk=${actualRiskPct}% ($${actualRiskAmount}) qty=${qty} lev=${leverage}x sl=${sl} tp=${tp} margin=$${marginRequired}`);

return [{
  json: {
    symbol, side, direction, qty, leverage,
    entryPrice:      +currentPrice.toFixed(pricePrecision),
    sl, tp,
    riskAmount:      actualRiskAmount,
    riskPct:         actualRiskPct,
    maxLoss,
    maxGain,
    rrRatio:         tpMultiplier,
    marginRequired,
    finalScore,
    indicators,
    candles,
    balance,
    availableBalance,
    openCount,
    openSymbols,
    aiResult,
    aiVision:        d.aiVision || null,
    slMultiplier,
    tpMultiplier,
    riskReduction:   aiRiskReduction,
    leverageOverride: leverage,
    scanScore:       d.scanScore,
    marketContext:   d.marketContext || null,
    tf4h:            d.tf4h || null,
    dynamicThreshold: d.dynamicThreshold || null,
    intelAdjFinal:    intelAdjFinal || 0,   // ← NUEVO
    sizingInfo: {
      baseRisk:           (BASE_RISK_PCT*100).toFixed(1)+'%',
      effectiveRisk:      (effectiveRisk*100).toFixed(2)+'%',
      actualRisk:         actualRiskPct+'%',
      scoreMultiplier,
      visionMultiplier,
      regimeMultiplier,
      tf4hMultiplier,
      tf4hStatus:         tf4h.status || 'N/A',
      macroSizeMultiplier,
      openPenalty,
      marketState,
      regime
    }
  }
}];
```

---

## Position Sizer1

```javascript
const d = $input.first().json;
const { symbol, direction, finalScore, indicators, aiResult, balance, availableBalance, openCount, openSymbols, candles, intelAdjFinal } = d;

const currentPrice = indicators.currentPrice;
const atrVal       = indicators.atr;

// ── Parámetros base ───────────────────────────────────────────────────────────
const BASE_RISK_PCT  = 0.02;
const MAX_MARGIN_PCT = 0.30;
const MIN_RISK_PCT   = 0.005;

// ── Score multiplier ──────────────────────────────────────────────────────────
let scoreMultiplier = 1.0;
if      (finalScore >= 80) scoreMultiplier = 1.5;
else if (finalScore >= 70) scoreMultiplier = 1.25;
else if (finalScore >= 60) scoreMultiplier = 1.0;
else if (finalScore >= 55) scoreMultiplier = 0.7;
else                       scoreMultiplier = 0.5;

// ── Vision multiplier — imagen tiene mayor peso aquí ─────────────────────────
const marketState = d.aiVision?.market_state || 'UNKNOWN';
let visionMultiplier = 1.0;
if      (marketState === 'EARLY_TREND') visionMultiplier = 1.3;
else if (marketState === 'MID_TREND')   visionMultiplier = 1.1;
else if (marketState === 'LATE_TREND')  visionMultiplier = 0.6;
else if (marketState === 'PARABOLIC')   visionMultiplier = 0.3;

// ── Régimen multiplier ────────────────────────────────────────────────────────
const regime = aiResult?.regime || 'TRENDING';
let regimeMultiplier = 1.0;
if      (regime === 'TRENDING')        regimeMultiplier = 1.1;
else if (regime === 'RANGING')         regimeMultiplier = 0.8;
else if (regime === 'HIGH_VOLATILITY') regimeMultiplier = 0.7;

// ── 4h multiplier ─────────────────────────────────────────────────────────────
const tf4h = d.tf4h || {};
let tf4hMultiplier = 1.0;
if      (tf4h.status === 'CONFIRMS')    tf4hMultiplier = 1.1;
else if (tf4h.status === 'NEUTRAL')     tf4hMultiplier = 0.95;
else if (tf4h.status === 'CONTRADICTS') tf4hMultiplier = 0.6;

// ── Macro multiplier ──────────────────────────────────────────────────────────
const macroSizeMultiplier = d.marketContext?.size_multiplier || 1.0;

// ── Open positions penalty ────────────────────────────────────────────────────
let openPenalty = 1.0;
if      (openCount >= 3) openPenalty = 0.5;
else if (openCount >= 2) openPenalty = 0.7;
else if (openCount >= 1) openPenalty = 0.85;

// ── Risk reduction — suma AI Image + macro ────────────────────────────────────
const aiRiskReduction    = d.riskReduction || 0;
const macroRiskReduction = Math.max(0, 1 - macroSizeMultiplier);
const totalRiskReduction = Math.min(0.7, aiRiskReduction + macroRiskReduction);

// ── Riesgo efectivo ───────────────────────────────────────────────────────────
const rawRisk = BASE_RISK_PCT
  * scoreMultiplier
  * visionMultiplier
  * regimeMultiplier
  * tf4hMultiplier
  * macroSizeMultiplier
  * openPenalty
  * (1 - aiRiskReduction);

const effectiveRisk = Math.min(0.05, Math.max(MIN_RISK_PCT, rawRisk));

// ── Leverage — AI Image manda, con cap si 4h contradice ──────────────────────
const maxLeverage = tf4h.status === 'CONTRADICTS' ? 4 : 15;
const leverage = Math.min(Math.max(d.leverageOverride || aiResult?.recommended_leverage || 5, 2), maxLeverage);

// ── SL y TP — vienen del AI Context Image ────────────────────────────────────
const slMultiplier = d.slMultiplier || 1.5;
const tpMultiplier = d.tpMultiplier || 2.0;

// ── Qty ───────────────────────────────────────────────────────────────────────
const slDistance = atrVal * slMultiplier;
const riskAmount = balance * effectiveRisk;
let   qty        = riskAmount / slDistance;

const margin = (qty * currentPrice) / leverage;
if(margin > balance * MAX_MARGIN_PCT){
  qty = (balance * MAX_MARGIN_PCT * leverage) / currentPrice;
}

const pricePrecision = currentPrice >= 1000 ? 1 : currentPrice >= 10 ? 2 : currentPrice >= 1 ? 3 : 4;
const qtyPrecision   = currentPrice >= 1000 ? 3 : currentPrice >= 10 ? 2 : 1;
qty = Math.floor(qty * Math.pow(10, qtyPrecision)) / Math.pow(10, qtyPrecision);

let sl, tp, side;
if(direction === 'LONG'){
  side = 'BUY';
  sl   = +(currentPrice - slDistance).toFixed(pricePrecision);
  tp   = +(currentPrice + slDistance * tpMultiplier).toFixed(pricePrecision);
} else {
  side = 'SELL';
  sl   = +(currentPrice + slDistance).toFixed(pricePrecision);
  tp   = +(currentPrice - slDistance * tpMultiplier).toFixed(pricePrecision);
}

// ── P&L real basado en qty final ─────────────────────────────────────────────
const maxLoss        = +(Math.abs(currentPrice - sl) * qty).toFixed(2);
const maxGain        = +(maxLoss * tpMultiplier).toFixed(2);
const marginRequired = +((qty * currentPrice) / leverage).toFixed(2);

// riskAmount y riskPct consistentes con qty final
const actualRiskAmount = maxLoss;
const actualRiskPct    = +(actualRiskAmount / balance * 100).toFixed(2);

console.log(`[${symbol}] sizing(img): score=${finalScore} 4h=${tf4h.status||'N/A'} macro=${macroSizeMultiplier}x vision=${marketState} regime=${regime} open=${openCount}`);
console.log(`[${symbol}] multipliers: score=${scoreMultiplier} 4h=${tf4hMultiplier} macro=${macroSizeMultiplier} vision=${visionMultiplier} regime=${regimeMultiplier} openPenalty=${openPenalty} aiRed=${aiRiskReduction}`);
console.log(`[${symbol}] result: risk=${actualRiskPct}% ($${actualRiskAmount}) qty=${qty} lev=${leverage}x sl=${sl} tp=${tp} margin=$${marginRequired}`);

return [{
  json: {
    symbol, side, direction, qty, leverage,
    entryPrice:      +currentPrice.toFixed(pricePrecision),
    sl, tp,
    riskAmount:      actualRiskAmount,
    riskPct:         actualRiskPct,
    maxLoss,
    maxGain,
    rrRatio:         tpMultiplier,
    marginRequired,
    finalScore,
    indicators,
    candles,
    balance,
    availableBalance,
    openCount,
    openSymbols,
    aiResult,
    aiVision:        d.aiVision || null,
    slMultiplier,
    tpMultiplier,
    riskReduction:   totalRiskReduction,
    leverageOverride: leverage,
    scanScore:       d.scanScore,
    marketContext:   d.marketContext || null,
    tf4h:            d.tf4h || null,
    dynamicThreshold: d.dynamicThreshold || null,
    intelAdjFinal:    intelAdjFinal || 0,   // ← NUEVO
    sizingInfo: {
      baseRisk:           (BASE_RISK_PCT*100).toFixed(1)+'%',
      effectiveRisk:      (effectiveRisk*100).toFixed(2)+'%',
      actualRisk:         actualRiskPct+'%',
      scoreMultiplier,
      visionMultiplier,
      regimeMultiplier,
      tf4hMultiplier,
      tf4hStatus:         tf4h.status || 'N/A',
      macroSizeMultiplier,
      openPenalty,
      marketState,
      regime
    }
  }
}];
```

---

## Execute Trade

```javascript
const crypto = require('crypto');
const API_KEY    = 'YOUR_BINANCE_API_KEY';
const API_SECRET = 'YOUR_BINANCE_API_SECRET';
const BASE       = 'https://fapi.binance.com';

function sign(params){
  const query = Object.entries({ ...params, timestamp: Date.now(), recvWindow: 60000 })
    .map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return query + '&signature=' + crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function req(method, path, params={}){
  try{
    return await this.helpers.httpRequest({
      method,
      url: `${BASE}${path}?${sign(params)}`,
      headers: {'X-MBX-APIKEY': API_KEY},
      json: true
    });
  }catch(e){
    const err = e.response?.data || e.message;
    throw new Error(JSON.stringify(err));
  }
}

const d = $input.first().json;
const { symbol, side, qty, leverage, sl, tp, entryPrice } = d;
const isLong       = side === 'BUY';
const positionSide = isLong ? 'LONG' : 'SHORT';
const closeSide    = isLong ? 'SELL' : 'BUY';

const logs = [];
const log = m => { console.log(m); logs.push(m); };

log(`Starting: ${symbol} ${side} qty=${qty} lev=${leverage}`);

// ── PROTECCIÓN CONTRA RE-ENTRADA ──────────────────────────────────────────────
// Verificar en Binance que no existe ya una posición abierta en este símbolo+dirección
try{
  const posRisk = await this.helpers.httpRequest({
    method: 'GET',
    url: `${BASE}/fapi/v2/positionRisk?${sign({ symbol })}`,
    headers: {'X-MBX-APIKEY': API_KEY},
    json: true
  });
  const arr = Array.isArray(posRisk) ? posRisk : [posRisk];
  const existing = arr.find(p =>
    p.symbol === symbol &&
    p.positionSide === positionSide &&
    Math.abs(parseFloat(p.positionAmt || 0)) > 0
  );
  if(existing){
    const existingSize = Math.abs(parseFloat(existing.positionAmt));
    log(`⛔ RE-ENTRADA BLOQUEADA: ${symbol} ${positionSide} ya tiene posición abierta (size=${existingSize} entry=${existing.entryPrice})`);
    return [{
      json: {
        ...d,
        success:  false,
        blocked:  true,
        blockReason: `Posición ${positionSide} en ${symbol} ya existe (size=${existingSize} @ $${existing.entryPrice})`,
        logs
      }
    }];
  }
  log(`Position check OK — no existe posición ${positionSide} en ${symbol}`);
}catch(e){
  // Si falla la verificación, continuar — mejor intentar que quedarse sin trade
  log(`Position check error (continuando): ${e.message}`);
}

// ── EXCHANGE INFO ─────────────────────────────────────────────────────────────
const exchange = await this.helpers.httpRequest({
  method: 'GET',
  url: `${BASE}/fapi/v1/exchangeInfo`,
  json: true
});

const sym = exchange.symbols.find(s => s.symbol === symbol);
if(!sym) throw new Error(`Symbol ${symbol} not found`);

const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
const lotFilter   = sym.filters.find(f => f.filterType === 'LOT_SIZE');

const tick = parseFloat(priceFilter.tickSize);
const step = parseFloat(lotFilter.stepSize);
log(`Filters: tick=${tick} step=${step}`);

function precision(v){
  const s = v.toString();
  if(!s.includes('.')) return 0;
  return s.split('.')[1].replace(/0+$/, '').length;
}
function roundStep(val, s){
  const p = precision(s);
  return Number((Math.floor(val/s)*s).toFixed(p));
}
function roundStepCeil(val, s){
  const p = precision(s);
  return Number((Math.ceil(val/s)*s).toFixed(p));
}

// ── PRECIO REAL ───────────────────────────────────────────────────────────────
const ticker = await this.helpers.httpRequest({
  method: 'GET',
  url: `${BASE}/fapi/v1/ticker/price?symbol=${symbol}`,
  json: true
});
const livePrice = parseFloat(ticker.price);
log(`Live price: ${livePrice}`);

let adjQty = roundStep(qty, step);
let adjSL  = roundStep(sl, tick);
let adjTP  = roundStep(tp, tick);
log(`Adjusted: qty=${adjQty} sl=${adjSL} tp=${adjTP}`);

// ── PREVENT INSTANT TRIGGER ───────────────────────────────────────────────────
if(isLong){
  if(adjSL >= livePrice){ adjSL = roundStep(livePrice*0.99, tick); log(`SL corregido: ${adjSL}`); }
  if(adjTP <= livePrice){ adjTP = roundStep(livePrice*1.02, tick); log(`TP corregido: ${adjTP}`); }
}else{
  if(adjSL <= livePrice){ adjSL = roundStep(livePrice*1.01, tick); log(`SL corregido: ${adjSL}`); }
  if(adjTP >= livePrice){ adjTP = roundStep(livePrice*0.98, tick); log(`TP corregido: ${adjTP}`); }
}

// ── VALIDAR NOTIONAL ──────────────────────────────────────────────────────────
const REAL_MIN = 100;
const notional = adjQty * livePrice;
log(`Notional: ${notional.toFixed(4)} USDT (min=${REAL_MIN})`);

if(notional < REAL_MIN){
  adjQty = roundStepCeil((REAL_MIN * 1.02) / livePrice, step);
  const nn = adjQty * livePrice;
  log(`Qty ajustado a ${adjQty} (notional=${nn.toFixed(4)})`);
  if(nn < REAL_MIN) throw new Error(`No se puede alcanzar ${REAL_MIN} USDT. qty=${adjQty} notional=${nn.toFixed(4)}`);
}
log(`Qty final: ${adjQty} | Notional: ${(adjQty*livePrice).toFixed(4)} USDT`);


// ── HEDGE MODE ────────────────────────────────────────────────────────────────
try{
  await req.call(this, 'POST', '/fapi/v1/positionSide/dual', { dualSidePosition:'true' });
  log('Hedge mode enabled');
}catch(e){ log('Hedge mode already enabled'); }

// ── MARGIN TYPE ───────────────────────────────────────────────────────────────
try{
  await req.call(this, 'POST', '/fapi/v1/marginType', { symbol, marginType:'ISOLATED' });
  log('Margin set ISOLATED');
}catch(e){ log('Margin already isolated'); }

// ── LEVERAGE ──────────────────────────────────────────────────────────────────
await req.call(this, 'POST', '/fapi/v1/leverage', { symbol, leverage });
log('Leverage set');

// ── CANCEL OPEN ORDERS ────────────────────────────────────────────────────────
try{
  await this.helpers.httpRequest({
    method: 'DELETE',
    url: `${BASE}/fapi/v1/allOpenOrders?${sign({symbol})}`,
    headers: {'X-MBX-APIKEY': API_KEY},
    json: true
  });
  log('Open orders cancelled');
}catch(e){ log('No open orders'); }


// 🧠 ── NUEVO: AJUSTE POR MARGEN DISPONIBLE ─────────────────────────────────────
let availableBalance = 0;

try{
  const balance = await req.call(this, 'GET', '/fapi/v2/balance');
  const usdt = balance.find(b => b.asset === 'USDT');

  availableBalance = parseFloat(usdt.availableBalance);
  log(`Available balance: ${availableBalance}`);

  const requiredMargin = (adjQty * livePrice) / leverage;
  log(`Required margin: ${requiredMargin}`);

  if(requiredMargin > availableBalance){
    const maxQty = roundStep((availableBalance * leverage * 0.98) / livePrice, step);

    log(`⚠️ Margin insuficiente. Ajustando qty → ${maxQty}`);

    if(maxQty <= 0){
      throw new Error(`Sin margen suficiente incluso para mínima posición`);
    }

    adjQty = maxQty;
  }

}catch(e){
  log(`Error chequeando margen (continúa): ${e.message}`);
}


// ── MARKET ORDER ──────────────────────────────────────────────────────────────
log(`Market order: ${symbol} ${side} qty=${adjQty} positionSide=${positionSide}`);
const order = await req.call(this, 'POST', '/fapi/v1/order', {
  symbol, side, type:'MARKET', quantity:adjQty, positionSide
});
log(`Market order OK orderId=${order.orderId}`);


// ── CONFIRM POSITION ──────────────────────────────────────────────────────────
let positionSize = adjQty;
for(let i = 0; i < 5; i++){
  await new Promise(r => setTimeout(r, 2000));
  const pos = await req.call(this, 'GET', '/fapi/v2/positionRisk', { symbol });
  const arr = Array.isArray(pos) ? pos : [pos];
  const p = arr.find(x =>
    x.symbol === symbol &&
    x.positionSide === positionSide &&
    Math.abs(parseFloat(x.positionAmt)) > 0
  );
  if(p){
    positionSize = Math.abs(parseFloat(p.positionAmt));
    log(`Position confirmed size=${positionSize} entryPrice=${p.entryPrice}`);
    break;
  }
  log(`Waiting position... ${i+1}/5`);
}

// ── TAKE PROFIT ───────────────────────────────────────────────────────────────
let tpOrder = null;
try{
  try{
    const p = { symbol, side:closeSide, positionSide, type:'TAKE_PROFIT_MARKET', stopPrice:adjTP, quantity:positionSize, workingType:'MARK_PRICE', priceProtect:'true' };
    log(`[TP] TAKE_PROFIT_MARKET: ${JSON.stringify(p)}`);
    tpOrder = await req.call(this, 'POST', '/fapi/v1/order', p);
    log(`[TP] TAKE_PROFIT_MARKET OK orderId=${tpOrder.orderId}`);
  }catch(e){
    log(`[TP] TAKE_PROFIT_MARKET falló: ${e.message}`);
    const p = { symbol, side:closeSide, positionSide, type:'LIMIT', price:adjTP, quantity:positionSize, timeInForce:'GTC' };
    log(`[TP] LIMIT: ${JSON.stringify(p)}`);
    tpOrder = await req.call(this, 'POST', '/fapi/v1/order', p);
    log(`[TP] LIMIT OK orderId=${tpOrder.orderId}`);
  }
}catch(e){
  log(`[TP] FINAL ERROR: ${e.message}`);
}

log(`⚠️  SL no colocado via orden — requiere workflow monitor`);
log(`⚠️  SL monitor params: symbol=${symbol} positionSide=${positionSide} slPrice=${adjSL} qty=${positionSize} side=${closeSide}`);

return [{
  json: {
    ...d,
    success: true,
    symbol,
    side: isLong ? 'LONG' : 'SHORT',
    qty: positionSize,
    leverage,
    entryPrice: livePrice,
    sl: adjSL,
    tp: adjTP,
    marketOrderId: order.orderId,
    slOrderId:     null,
    tpOrderId:     tpOrder?.orderId || null,
    slPrice:       adjSL,
    slSide:        closeSide,
    slPositionSide: positionSide,
    slMonitorRequired: true,
    logs
  }
}];
```

---

## Execute Trade1

```javascript
const crypto = require('crypto');
const API_KEY    = 'YOUR_BINANCE_API_KEY';
const API_SECRET = 'YOUR_BINANCE_API_SECRET';
const BASE       = 'https://fapi.binance.com';

function sign(params){
  const query = Object.entries({ ...params, timestamp: Date.now(), recvWindow: 60000 })
    .map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return query + '&signature=' + crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function req(method, path, params={}){
  try{
    return await this.helpers.httpRequest({
      method,
      url: `${BASE}${path}?${sign(params)}`,
      headers: {'X-MBX-APIKEY': API_KEY},
      json: true
    });
  }catch(e){
    const err = e.response?.data || e.message;
    throw new Error(JSON.stringify(err));
  }
}

const d = $input.first().json;
const { symbol, side, qty, leverage, sl, tp, entryPrice } = d;
const isLong       = side === 'BUY';
const positionSide = isLong ? 'LONG' : 'SHORT';
const closeSide    = isLong ? 'SELL' : 'BUY';

const logs = [];
const log = m => { console.log(m); logs.push(m); };

log(`Starting: ${symbol} ${side} qty=${qty} lev=${leverage}`);

// ── PROTECCIÓN CONTRA RE-ENTRADA ──────────────────────────────────────────────
// Verificar en Binance que no existe ya una posición abierta en este símbolo+dirección
try{
  const posRisk = await this.helpers.httpRequest({
    method: 'GET',
    url: `${BASE}/fapi/v2/positionRisk?${sign({ symbol })}`,
    headers: {'X-MBX-APIKEY': API_KEY},
    json: true
  });
  const arr = Array.isArray(posRisk) ? posRisk : [posRisk];
  const existing = arr.find(p =>
    p.symbol === symbol &&
    p.positionSide === positionSide &&
    Math.abs(parseFloat(p.positionAmt || 0)) > 0
  );
  if(existing){
    const existingSize = Math.abs(parseFloat(existing.positionAmt));
    log(`⛔ RE-ENTRADA BLOQUEADA: ${symbol} ${positionSide} ya tiene posición abierta (size=${existingSize} entry=${existing.entryPrice})`);
    return [{
      json: {
        ...d,
        success:  false,
        blocked:  true,
        blockReason: `Posición ${positionSide} en ${symbol} ya existe (size=${existingSize} @ $${existing.entryPrice})`,
        logs
      }
    }];
  }
  log(`Position check OK — no existe posición ${positionSide} en ${symbol}`);
}catch(e){
  // Si falla la verificación, continuar — mejor intentar que quedarse sin trade
  log(`Position check error (continuando): ${e.message}`);
}

// ── EXCHANGE INFO ─────────────────────────────────────────────────────────────
const exchange = await this.helpers.httpRequest({
  method: 'GET',
  url: `${BASE}/fapi/v1/exchangeInfo`,
  json: true
});

const sym = exchange.symbols.find(s => s.symbol === symbol);
if(!sym) throw new Error(`Symbol ${symbol} not found`);

const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
const lotFilter   = sym.filters.find(f => f.filterType === 'LOT_SIZE');

const tick = parseFloat(priceFilter.tickSize);
const step = parseFloat(lotFilter.stepSize);
log(`Filters: tick=${tick} step=${step}`);

function precision(v){
  const s = v.toString();
  if(!s.includes('.')) return 0;
  return s.split('.')[1].replace(/0+$/, '').length;
}
function roundStep(val, s){
  const p = precision(s);
  return Number((Math.floor(val/s)*s).toFixed(p));
}
function roundStepCeil(val, s){
  const p = precision(s);
  return Number((Math.ceil(val/s)*s).toFixed(p));
}

// ── PRECIO REAL ───────────────────────────────────────────────────────────────
const ticker = await this.helpers.httpRequest({
  method: 'GET',
  url: `${BASE}/fapi/v1/ticker/price?symbol=${symbol}`,
  json: true
});
const livePrice = parseFloat(ticker.price);
log(`Live price: ${livePrice}`);

let adjQty = roundStep(qty, step);
let adjSL  = roundStep(sl, tick);
let adjTP  = roundStep(tp, tick);
log(`Adjusted: qty=${adjQty} sl=${adjSL} tp=${adjTP}`);

// ── PREVENT INSTANT TRIGGER ───────────────────────────────────────────────────
if(isLong){
  if(adjSL >= livePrice){ adjSL = roundStep(livePrice*0.99, tick); log(`SL corregido: ${adjSL}`); }
  if(adjTP <= livePrice){ adjTP = roundStep(livePrice*1.02, tick); log(`TP corregido: ${adjTP}`); }
}else{
  if(adjSL <= livePrice){ adjSL = roundStep(livePrice*1.01, tick); log(`SL corregido: ${adjSL}`); }
  if(adjTP >= livePrice){ adjTP = roundStep(livePrice*0.98, tick); log(`TP corregido: ${adjTP}`); }
}

// ── VALIDAR NOTIONAL ──────────────────────────────────────────────────────────
const REAL_MIN = 100;
const notional = adjQty * livePrice;
log(`Notional: ${notional.toFixed(4)} USDT (min=${REAL_MIN})`);

if(notional < REAL_MIN){
  adjQty = roundStepCeil((REAL_MIN * 1.02) / livePrice, step);
  const nn = adjQty * livePrice;
  log(`Qty ajustado a ${adjQty} (notional=${nn.toFixed(4)})`);
  if(nn < REAL_MIN) throw new Error(`No se puede alcanzar ${REAL_MIN} USDT. qty=${adjQty} notional=${nn.toFixed(4)}`);
}
log(`Qty final: ${adjQty} | Notional: ${(adjQty*livePrice).toFixed(4)} USDT`);

// ── HEDGE MODE ────────────────────────────────────────────────────────────────
try{
  await req.call(this, 'POST', '/fapi/v1/positionSide/dual', { dualSidePosition:'true' });
  log('Hedge mode enabled');
}catch(e){ log('Hedge mode already enabled'); }

// ── MARGIN TYPE ───────────────────────────────────────────────────────────────
try{
  await req.call(this, 'POST', '/fapi/v1/marginType', { symbol, marginType:'ISOLATED' });
  log('Margin set ISOLATED');
}catch(e){ log('Margin already isolated'); }

// ── LEVERAGE ──────────────────────────────────────────────────────────────────
await req.call(this, 'POST', '/fapi/v1/leverage', { symbol, leverage });
log('Leverage set');

// ── CANCEL OPEN ORDERS ────────────────────────────────────────────────────────
try{
  await this.helpers.httpRequest({
    method: 'DELETE',
    url: `${BASE}/fapi/v1/allOpenOrders?${sign({symbol})}`,
    headers: {'X-MBX-APIKEY': API_KEY},
    json: true
  });
  log('Open orders cancelled');
}catch(e){ log('No open orders'); }

// ── MARKET ORDER ──────────────────────────────────────────────────────────────
log(`Market order: ${symbol} ${side} qty=${adjQty} positionSide=${positionSide}`);
const order = await req.call(this, 'POST', '/fapi/v1/order', {
  symbol, side, type:'MARKET', quantity:adjQty, positionSide
});
log(`Market order OK orderId=${order.orderId}`);

// ── CONFIRM POSITION ──────────────────────────────────────────────────────────
let positionSize = adjQty;
for(let i = 0; i < 5; i++){
  await new Promise(r => setTimeout(r, 2000));
  const pos = await req.call(this, 'GET', '/fapi/v2/positionRisk', { symbol });
  const arr = Array.isArray(pos) ? pos : [pos];
  const p = arr.find(x =>
    x.symbol === symbol &&
    x.positionSide === positionSide &&
    Math.abs(parseFloat(x.positionAmt)) > 0
  );
  if(p){
    positionSize = Math.abs(parseFloat(p.positionAmt));
    log(`Position confirmed size=${positionSize} entryPrice=${p.entryPrice}`);
    break;
  }
  log(`Waiting position... ${i+1}/5`);
}

// ── TAKE PROFIT ───────────────────────────────────────────────────────────────
let tpOrder = null;
try{
  try{
    const p = { symbol, side:closeSide, positionSide, type:'TAKE_PROFIT_MARKET', stopPrice:adjTP, quantity:positionSize, workingType:'MARK_PRICE', priceProtect:'true' };
    log(`[TP] TAKE_PROFIT_MARKET: ${JSON.stringify(p)}`);
    tpOrder = await req.call(this, 'POST', '/fapi/v1/order', p);
    log(`[TP] TAKE_PROFIT_MARKET OK orderId=${tpOrder.orderId}`);
  }catch(e){
    log(`[TP] TAKE_PROFIT_MARKET falló: ${e.message}`);
    const p = { symbol, side:closeSide, positionSide, type:'LIMIT', price:adjTP, quantity:positionSize, timeInForce:'GTC' };
    log(`[TP] LIMIT: ${JSON.stringify(p)}`);
    tpOrder = await req.call(this, 'POST', '/fapi/v1/order', p);
    log(`[TP] LIMIT OK orderId=${tpOrder.orderId}`);
  }
}catch(e){
  log(`[TP] FINAL ERROR: ${e.message}`);
}

log(`⚠️  SL no colocado via orden — requiere workflow monitor`);
log(`⚠️  SL monitor params: symbol=${symbol} positionSide=${positionSide} slPrice=${adjSL} qty=${positionSize} side=${closeSide}`);

return [{
  json: {
    ...d,
    success: true,
    symbol,
    side: isLong ? 'LONG' : 'SHORT',
    qty: positionSize,
    leverage,
    entryPrice: livePrice,
    sl: adjSL,
    tp: adjTP,
    marketOrderId: order.orderId,
    slOrderId:     null,
    tpOrderId:     tpOrder?.orderId || null,
    slPrice:       adjSL,
    slSide:        closeSide,
    slPositionSide: positionSide,
    slMonitorRequired: true,
    logs
  }
}];
```

---

## Monitor SL Global

```javascript
const d = $input.first().json;

if(d.slMonitorRequired){
  const WEBHOOK_URL = 'http://18.228.14.96:5678/webhook/sl-monitor-set';
  const WEBHOOK_GET = 'http://18.228.14.96:5678/webhook/sl-monitor-get';
  const DASHBOARD   = 'http://18.228.14.96:3001';

  const newPosition = {
    symbol:       d.symbol,
    positionSide: d.slPositionSide,
    slPrice:      d.slPrice,
    qty:          d.qty,
    side:         d.slSide,
    entryPrice:   d.entryPrice,
    initialSL:    d.slPrice,
    stage:        'INITIAL',
    tp:           d.tp,
    leverage:     d.leverage,
    finalScore:   d.finalScore,
    openedAt:     Date.now(),
    aiRegime:     d.aiResult?.regime || 'N/A'
  };

  // ── 1. Registrar en SL Monitor con reintento ──────────────────────────────
  let slMonitorOk = false;
  for(let i = 0; i < 3; i++){
    try{
      await this.helpers.httpRequest({
        method: 'POST', url: WEBHOOK_URL, json: true, body: newPosition
      });
      slMonitorOk = true;
      console.log(`SL Monitor activado: ${d.symbol} sl=${d.slPrice} entry=${d.entryPrice}`);
      break;
    }catch(e){
      console.log(`SL Monitor intento ${i+1}/3 falló: ${e.message}`);
      if(i < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }

  if(!slMonitorOk){
    console.log(`⚠️ SL Monitor FALLÓ 3 veces para ${d.symbol} — posición puede quedar sin monitorear`);
  }

  // ── 2. Health check — verificar que quedó registrado ─────────────────────
  try{
    await new Promise(r => setTimeout(r, 1000)); // esperar 1s para que se guarde
    const state = await this.helpers.httpRequest({
      method: 'GET', url: WEBHOOK_GET, json: true
    });
    const positions = state.positions || {};

    if(!positions[d.symbol]){
      // No quedó registrado — reintentar una vez más
      console.log(`⚠️ Health check: ${d.symbol} no aparece en SL Monitor — reintentando...`);
      try{
        await this.helpers.httpRequest({
          method: 'POST', url: WEBHOOK_URL, json: true, body: newPosition
        });
        console.log(`✅ Health check reintento exitoso para ${d.symbol}`);
      }catch(e){
        console.log(`❌ Health check reintento falló: ${e.message}`);
      }
    } else {
      console.log(`✅ Health check OK: ${d.symbol} confirmado en SL Monitor`);
    }

    // ── 3. Limpiar posiciones fantasma (qty=0 o sin posición real en Binance)
    for(const sym of Object.keys(positions)){
      const pos = positions[sym];
      if(!pos.qty || pos.qty === 0 || pos.slPrice === 9999){
        console.log(`[HealthCheck] Posición fantasma detectada: ${sym} qty=${pos.qty} sl=${pos.slPrice} — limpiando`);
        // No hay endpoint DELETE en el SL Monitor webhook
        // Marcamos con qty=0 y el SL Monitor la eliminará en el próximo ciclo
        // porque Binance reportará que no existe
      }
    }

  }catch(e){
    console.log(`Health check error: ${e.message}`);
  }

  // ── 4. Registrar en Dashboard ─────────────────────────────────────────────
  try{
    await this.helpers.httpRequest({
      method: 'POST', url: `${DASHBOARD}/trade`, json: true,
      body: {
        symbol:     d.symbol,
        side:       d.slPositionSide,
        entryPrice: d.entryPrice,
        sl:         d.slPrice,
        tp:         d.tp,
        qty:        d.qty,
        leverage:   d.leverage,
        finalScore: d.finalScore,
        openedAt:   Date.now(),
        stage:      'INITIAL',
        initialSL:  d.slPrice,
        aiResult:   { regime: d.aiResult?.regime || 'N/A', direction_bias: d.slPositionSide }
      }
    });
    console.log(`Dashboard activado: ${d.symbol}`);
  }catch(e){
    console.log(`Dashboard error: ${e.message}`);
  }
}

return [$input.first()];
```

---

## Monitor SL Global of Image

```javascript
const d = $input.first().json;

if(d.slMonitorRequired){
  const WEBHOOK_URL = 'http://18.228.14.96:5678/webhook/sl-monitor-set';
  const WEBHOOK_GET = 'http://18.228.14.96:5678/webhook/sl-monitor-get';
  const DASHBOARD   = 'http://18.228.14.96:3001';

  const newPosition = {
    symbol:       d.symbol,
    positionSide: d.slPositionSide,
    slPrice:      d.slPrice,
    qty:          d.qty,
    side:         d.slSide,
    entryPrice:   d.entryPrice,
    initialSL:    d.slPrice,
    stage:        'INITIAL',
    tp:           d.tp,
    leverage:     d.leverage,
    finalScore:   d.finalScore,
    openedAt:     Date.now(),
    aiRegime:     d.aiResult?.regime || 'N/A'
  };

  // ── 1. Registrar en SL Monitor con reintento ──────────────────────────────
  let slMonitorOk = false;
  for(let i = 0; i < 3; i++){
    try{
      await this.helpers.httpRequest({
        method: 'POST', url: WEBHOOK_URL, json: true, body: newPosition
      });
      slMonitorOk = true;
      console.log(`SL Monitor activado: ${d.symbol} sl=${d.slPrice} entry=${d.entryPrice}`);
      break;
    }catch(e){
      console.log(`SL Monitor intento ${i+1}/3 falló: ${e.message}`);
      if(i < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }

  if(!slMonitorOk){
    console.log(`⚠️ SL Monitor FALLÓ 3 veces para ${d.symbol} — posición puede quedar sin monitorear`);
  }

  // ── 2. Health check — verificar que quedó registrado ─────────────────────
  try{
    await new Promise(r => setTimeout(r, 1000)); // esperar 1s para que se guarde
    const state = await this.helpers.httpRequest({
      method: 'GET', url: WEBHOOK_GET, json: true
    });
    const positions = state.positions || {};

    if(!positions[d.symbol]){
      // No quedó registrado — reintentar una vez más
      console.log(`⚠️ Health check: ${d.symbol} no aparece en SL Monitor — reintentando...`);
      try{
        await this.helpers.httpRequest({
          method: 'POST', url: WEBHOOK_URL, json: true, body: newPosition
        });
        console.log(`✅ Health check reintento exitoso para ${d.symbol}`);
      }catch(e){
        console.log(`❌ Health check reintento falló: ${e.message}`);
      }
    } else {
      console.log(`✅ Health check OK: ${d.symbol} confirmado en SL Monitor`);
    }

    // ── 3. Limpiar posiciones fantasma (qty=0 o sin posición real en Binance)
    for(const sym of Object.keys(positions)){
      const pos = positions[sym];
      if(!pos.qty || pos.qty === 0 || pos.slPrice === 9999){
        console.log(`[HealthCheck] Posición fantasma detectada: ${sym} qty=${pos.qty} sl=${pos.slPrice} — limpiando`);
        // No hay endpoint DELETE en el SL Monitor webhook
        // Marcamos con qty=0 y el SL Monitor la eliminará en el próximo ciclo
        // porque Binance reportará que no existe
      }
    }

  }catch(e){
    console.log(`Health check error: ${e.message}`);
  }

  // ── 4. Registrar en Dashboard ─────────────────────────────────────────────
  try{
    await this.helpers.httpRequest({
      method: 'POST', url: `${DASHBOARD}/trade`, json: true,
      body: {
        symbol:     d.symbol,
        side:       d.slPositionSide,
        entryPrice: d.entryPrice,
        sl:         d.slPrice,
        tp:         d.tp,
        qty:        d.qty,
        leverage:   d.leverage,
        finalScore: d.finalScore,
        openedAt:   Date.now(),
        stage:      'INITIAL',
        initialSL:  d.slPrice,
        aiResult:   { regime: d.aiResult?.regime || 'N/A', direction_bias: d.slPositionSide }
      }
    });
    console.log(`Dashboard activado: ${d.symbol}`);
  }catch(e){
    console.log(`Dashboard error: ${e.message}`);
  }
}

return [$input.first()];
```

---

## Build Trade Alert

```javascript
const d = $input.first().json;
const {
  symbol, side, qty, leverage, entryPrice, sl, tp,
  finalScore, aiResult, riskPct, rrRatio, maxLoss, maxGain,
  riskAmount, marginRequired, openCount, openSymbols,
  balance, availableBalance, slError, tpError,
  slOrderId, tpOrderId, marketOrderId,
  indicators, scanScore, aiVision, usedFallback, originalSymbol,
  tf4h, marketContext, sizingInfo, intelAdjFinal
} = d;

function clean(t,max=160){ if(!t) return 'N/A'; return String(t).replace(/[<>_*[\]()~`#+|{}.!\\]/g,' ').replace(/\s+/g,' ').trim().substring(0,max); }
function num(v,dec=2){ return Number(v??0).toFixed(dec); }
function bar(s){
  s = Math.min(100,Math.max(0,Math.round(s||0)));
  const f = Math.round(s/10);
  return '['+('█'.repeat(f)+'░'.repeat(10-f))+'] '+s+'/100';
}
function sign(n){ return n>=0?'+':''; }

const ind      = indicators || {};
const ai       = aiResult   || {};
const mc       = marketContext || {};
const tf       = tf4h || {};
const si       = sizingInfo || {};
const intel    = mc.intelligenceSignal || {};
const isLong   = side==='BUY' || side==='LONG';
const dirLabel = isLong ? 'LONG' : 'SHORT';
const dirIcon  = isLong ? '🟢' : '🔴';
const price    = Number(ind.currentPrice ?? entryPrice ?? 0);
const rsi      = Number(ind.rsi14 ?? 0);
const volRatio = Number(ind.volRatio ?? 0);
const funding  = Number(ind.fundingRate ?? 0);

// Scores desglosados
const baseScore  = d.score ?? finalScore ?? 0;
const adjValue   = Number(ai.confidence_adjustment ?? 0);
const intelAdj   = Number(intelAdjFinal ?? 0);
const tf4hAdj    = tf?.adjust ?? 0;
const scoreStep1 = baseScore;
const scoreStep2 = scoreStep1 + tf4hAdj;
const scoreStep3 = scoreStep2 + adjValue;
const scoreStep4 = Math.min(100, Math.max(0, scoreStep3 + intelAdj));

const rsiLabel  = rsi>=75?'EXTREMO ALTO':rsi>=70?'Sobrecomprado':rsi>=60?'Zona alta':rsi<=25?'EXTREMO BAJO':rsi<=30?'Sobrevendido':rsi<=40?'Zona baja':'Neutral';
const volLabel  = volRatio>4?'SPIKE':volRatio>1.5?'Alto':volRatio<0.8?'Bajo':'Normal';
const fundLabel = funding>0.0001?'Longs pagan':funding<-0.0001?'Shorts pagan':'Neutral';
const tf4hMap   = {CONFIRMS:'CONFIRMA ✅',CONTRADICTS:'CONTRADICE ❌',NEUTRAL:'NEUTRAL ⚪'};
const macroMap  = {BULLISH:'BULLISH 🟢',BEARISH:'BEARISH 🔴',NEUTRAL:'NEUTRAL ⚪'};
const regimeMap = {TRENDING:'Trending 📈',RANGING:'Ranging ↔️',HIGH_VOLATILITY:'Alta Vol ⚡'};
const intelMap  = {'NO OPERAR':'NO OPERAR ⛔',SHORT:'SHORT 🔴',LONG:'LONG 🟢',NEUTRAL:'NEUTRAL ⚪'};

const slDist   = price>0?(Math.abs(price-(+sl||0))/price*100).toFixed(2):'0.00';
const tpDist   = price>0?(Math.abs(price-(+tp||0))/price*100).toFixed(2):'0.00';
const openList = (openSymbols||[]).join(', ')||'ninguna';
const ts = new Date().toISOString().replace('T',' ').slice(0,19)+' UTC';
const emaSpread = price?((Math.abs((ind.ema8??0)-(ind.ema50??0))/price)*100).toFixed(2):'0.00';
const rrLabel  = rrRatio>=2.5?'Excelente ⭐':rrRatio>=2?'Bueno':rrRatio>=1.5?'Aceptable':'Bajo ⚠️';

// ── Guardar en DB ─────────────────────────────────────────────────────────────
try{
  await this.helpers.httpRequest({
    method:'POST', url:'http://18.228.14.96:3001/db/trade/open', json:true,
    body:{
      symbol, direction:side, entryPrice, sl, tp, qty, leverage,
      marginRequired, riskPct, maxLoss, maxGain, rrRatio,
      finalScore, scanScore, aiResult:ai, aiVision:aiVision||null,
      usedFallback:usedFallback||false, originalSymbol:originalSymbol||null,
      marketOrderId:marketOrderId||null, tpOrderId:tpOrderId||null,
      slMonitorRequired:!slOrderId,
      tf4h:tf||null, marketContext:mc||null, sizingInfo:si||null
    }
  });
}catch(e){ console.log('DB open error:',e.message); }

const lines = [
  '━━━━━━━━━━━━━━━━━━━━━━━',
  `✅ TRADE ABIERTO${usedFallback?` [FALLBACK de ${originalSymbol}]`:''} — SIN IMAGEN`,
  '━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  `💎 ${symbol}   ${dirIcon} ${dirLabel}   ⚡ ${leverage}x`,
  `⏰ ${ts}`,
  '',
  '─── PUNTUACION ───',
  `  Scoring 1h puro  : ${bar(scoreStep1)}`,
  `  Ajuste 4H        : ${sign(tf4hAdj)}${tf4hAdj} pts  (${tf?.status||'N/A'})`,
  `  Ajuste AI        : ${sign(adjValue)}${adjValue} pts  (${ai.regime||'N/A'})`,
  `  Ajuste Intel     : ${sign(intelAdj)}${intelAdj} pts  (${intel.signal||'N/A'} · ${intel.confidence||'N/A'})`,
  `  ─────────────────────────────────`,
  `  SCORE FINAL      : ${bar(scoreStep4)}`,
  '',
  `  Sizing  : base ${si.baseRisk||'N/A'} → efectivo ${si.effectiveRisk||'N/A'}`,
  `  Mult    : score ${si.scoreMultiplier||'N/A'}x · 4h ${si.tf4hMultiplier||'N/A'}x · macro ${si.macroSizeMultiplier||'N/A'}x · reg ${si.regimeMultiplier||'N/A'}x`,
  '',
  '─── PRECIOS ───',
  `  Entry  : $${num(entryPrice,4)}`,
  `  SL     : $${num(sl,4)}   (${slDist}% distancia)`,
  `  TP     : $${num(tp,4)}   (${tpDist}% distancia)`,
  `  R:R    : 1:${rrRatio}   (${rrLabel})`,
  '',
  '─── POSICION ───',
  `  Cantidad : ${qty} ${(symbol||'').replace('USDT','')}`,
  `  Riesgo   : ${riskPct}% del balance   ($${num(riskAmount)})`,
  `  Max loss : $${num(maxLoss)}   Max gain: $${num(maxGain)}`,
  `  Margen   : $${num(marginRequired)}`,
  '',
  '─── CUENTA ───',
  `  Balance     : $${num(balance)}   Disponible: $${num(availableBalance)}`,
  `  Posiciones  : ${openCount} abiertas — ${openList}`,
  '',
  '─── ORDENES ───',
  `  MARKET : Ejecutada   ID: ${marketOrderId||'N/A'}`,
  `  SL     : ${slOrderId?'Orden activa   ID: '+slOrderId:'Monitor activo'}`,
  `  TP     : ${tpOrderId?'Orden activa   ID: '+tpOrderId:'No colocado'}`,
  slError ? `  ⚠️ SL Error: ${clean(slError,80)}` : null,
  tpError ? `  ⚠️ TP Error: ${clean(tpError,80)}` : null,
  '',
  '─── INTELIGENCIA ───',
  `  Señal    : ${intelMap[intel.signal]||intel.signal||'N/A'}   Confianza: ${intel.confidence||'N/A'}`,
  `  Sesgo    : ${intel.bias||'N/A'}   Postura: ${intel.postureScore||0}`,
  intel.alerts?.length
    ? intel.alerts.map(a=>`  ⚠️ ${a.title}: ${clean(a.detail,80)}`).join('\n')
    : '  Sin alertas activas',
  '',
  '─── AI CONTEXT ───',
  `  Regimen : ${regimeMap[ai.regime]||ai.regime||'N/A'}`,
  `  Bias AI : ${ai.direction_bias||'N/A'}   Leverage: ${ai.recommended_leverage||5}x`,
  `  Riesgo  : ${clean(ai.key_risk,120)}`,
  `  Razon   : ${clean(ai.reasoning,140)}`,
  '',
  '─── MACRO ───',
  `  Sesgo    : ${macroMap[mc.market_bias]||'N/A'}   Confianza: ${mc.confidence||'N/A'}%`,
  `  F&G      : ${mc.fearGreed?.value||'N/A'}/100 (${mc.fearGreed?.classification||'N/A'})`,
  `  BTC 12h  : ${mc.btcChange||'N/A'}%   BTC: ${mc.btcBullish?'Alcista 📈':'Bajista 📉'}`,
  `  Size mult: ${mc.size_multiplier||1.0}x`,
  `  Razon    : ${clean(mc.reason,140)}`,
  '',
  '─── TIMEFRAME 4H ───',
  `  Tendencia : ${tf.trend||'N/A'}   Estado: ${tf4hMap[tf.status]||tf.status||'N/A'}`,
  `  RSI 4H    : ${tf.rsi||'N/A'}   EMA8/21: ${tf.ema8||'N/A'} / ${tf.ema21||'N/A'}`,
  '',
  '─── INDICADORES ───',
  `  RSI14  : ${rsi.toFixed(1)}   ${rsiLabel}`,
  `  ATR    : $${num(ind.atr,4)}   (${num(ind.atrPct)}%)   Vol: ${num(volRatio)}x   ${volLabel}`,
  `  Funding: ${num(funding*100,4)}%   ${fundLabel}   VWAP: $${num(ind.vwap??0,4)}`,
  `  EMA8/21/50: $${num(ind.ema8??0,2)} / $${num(ind.ema21??0,2)} / $${num(ind.ema50??0,2)}`,
  `  EMA spread: ${emaSpread}%`,
  '',
  `🔭 Scan: ${num(scanScore,3)}   💰 Balance: $${num(balance)}`,
  '━━━━━━━━━━━━━━━━━━━━━━━'
].filter(l=>l!==null).join('\n');

return [{ json: { text: lines } }];
```

---

## Build Trade Alert of Image

```javascript
const d = $input.first().json;
const {
  symbol, side, qty, leverage, entryPrice, sl, tp,
  finalScore, aiResult, riskPct, rrRatio, maxLoss, maxGain,
  riskAmount, marginRequired, openCount, openSymbols,
  balance, availableBalance, slError, tpError,
  slOrderId, tpOrderId, marketOrderId,
  indicators, scanScore, aiVision, usedFallback, originalSymbol,
  tf4h, marketContext, sizingInfo, intelAdjFinal
} = d;

function clean(t,max=160){ if(!t) return 'N/A'; return String(t).replace(/[<>_*[\]()~`#+|{}.!\\]/g,' ').replace(/\s+/g,' ').trim().substring(0,max); }
function num(v,dec=2){ return Number(v??0).toFixed(dec); }
function bar(s){
  s = Math.min(100,Math.max(0,Math.round(s||0)));
  const f = Math.round(s/10);
  return '['+('█'.repeat(f)+'░'.repeat(10-f))+'] '+s+'/100';
}
function sign(n){ return n>=0?'+':''; }

const ind      = indicators || {};
const ai       = aiResult   || {};
const vis      = aiVision   || {};
const mc       = marketContext || {};
const tf       = tf4h || {};
const si       = sizingInfo || {};
const intel    = mc.intelligenceSignal || {};
const isLong   = side==='BUY' || side==='LONG';
const dirLabel = isLong ? 'LONG' : 'SHORT';
const dirIcon  = isLong ? '🟢' : '🔴';
const price    = Number(ind.currentPrice ?? entryPrice ?? 0);
const rsi      = Number(ind.rsi14 ?? 0);
const volRatio = Number(ind.volRatio ?? 0);
const funding  = Number(ind.fundingRate ?? 0);

// Scores
const baseScore  = d.score ?? finalScore ?? 0;
const adjValue   = Number(ai.confidence_adjustment ?? 0);
const intelAdj   = Number(intelAdjFinal ?? 0);
const tf4hAdj    = tf?.adjust ?? 0;
// Score paso a paso
const scoreStep1 = baseScore;                          // base 1h pura
const scoreStep2 = scoreStep1 + tf4hAdj;              // + ajuste 4h
const scoreStep3 = scoreStep2 + adjValue;             // + ajuste AI
const scoreStep4 = Math.min(100, Math.max(0, scoreStep3 + intelAdj)); // + intel → final

const rsiLabel  = rsi>=75?'EXTREMO ALTO':rsi>=70?'Sobrecomprado':rsi>=60?'Zona alta':rsi<=25?'EXTREMO BAJO':rsi<=30?'Sobrevendido':rsi<=40?'Zona baja':'Neutral';
const volLabel  = volRatio>4?'SPIKE':volRatio>1.5?'Alto':volRatio<0.8?'Bajo':'Normal';
const fundLabel = funding>0.0001?'Longs pagan':funding<-0.0001?'Shorts pagan':'Neutral';
const tf4hMap   = {CONFIRMS:'CONFIRMA ✅',CONTRADICTS:'CONTRADICE ❌',NEUTRAL:'NEUTRAL ⚪'};
const macroMap  = {BULLISH:'BULLISH 🟢',BEARISH:'BEARISH 🔴',NEUTRAL:'NEUTRAL ⚪'};
const regimeMap = {TRENDING:'Trending 📈',RANGING:'Ranging ↔️',HIGH_VOLATILITY:'Alta Vol ⚡'};
const stateMap  = {EARLY_TREND:'Early Trend 🟢',MID_TREND:'Mid Trend 🟡',LATE_TREND:'Late Trend 🟠',PARABOLIC:'PARABOLICO 🔴'};
const intelMap  = {'NO OPERAR':'NO OPERAR ⛔',SHORT:'SHORT 🔴',LONG:'LONG 🟢',NEUTRAL:'NEUTRAL ⚪'};

const slDist  = price>0?(Math.abs(price-(+sl||0))/price*100).toFixed(2):'0.00';
const tpDist  = price>0?(Math.abs(price-(+tp||0))/price*100).toFixed(2):'0.00';
const openList = (openSymbols||[]).join(', ')||'ninguna';
const ts = new Date().toISOString().replace('T',' ').slice(0,19)+' UTC';
const emaSpread = price?((Math.abs((ind.ema8??0)-(ind.ema50??0))/price)*100).toFixed(2):'0.00';
const rrLabel = rrRatio>=2.5?'Excelente ⭐':rrRatio>=2?'Bueno':rrRatio>=1.5?'Aceptable':'Bajo ⚠️';

// ── Guardar en DB ─────────────────────────────────────────────────────────────
try{
  await this.helpers.httpRequest({
    method:'POST', url:'http://18.228.14.96:3001/db/trade/open', json:true,
    body:{
      symbol, direction:side, entryPrice, sl, tp, qty, leverage,
      marginRequired, riskPct, maxLoss, maxGain, rrRatio,
      finalScore, scanScore, aiResult:ai, aiVision:vis||null,
      usedFallback:usedFallback||false, originalSymbol:originalSymbol||null,
      marketOrderId:marketOrderId||null, tpOrderId:tpOrderId||null,
      slMonitorRequired:!slOrderId,
      tf4h:tf||null, marketContext:mc||null, sizingInfo:si||null
    }
  });
}catch(e){ console.log('DB open error:',e.message); }

const lines = [
  '━━━━━━━━━━━━━━━━━━━━━━━',
  `✅ TRADE ABIERTO${usedFallback?` [FALLBACK de ${originalSymbol}]`:''} — CON IMAGEN`,
  '━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  `💎 ${symbol}   ${dirIcon} ${dirLabel}   ⚡ ${leverage}x`,
  `⏰ ${ts}`,
  '',
  // ── PUNTUACION — desglose completo ──────────────────────────────────────────
  '─── PUNTUACION ───',
  `  Scoring 1h puro  : ${bar(scoreStep1)}`,
  `  Ajuste 4H        : ${sign(tf4hAdj)}${tf4hAdj} pts  (${tf?.status||'N/A'})`,
  `  Ajuste AI        : ${sign(adjValue)}${adjValue} pts  (${ai.regime||'N/A'})`,
  `  Ajuste Intel     : ${sign(intelAdj)}${intelAdj} pts  (${intel.signal||'N/A'} · ${intel.confidence||'N/A'})`,
  `  ─────────────────────────────────`,
  `  SCORE FINAL      : ${bar(scoreStep4)}`,
  '',
  `  Sizing  : base ${si.baseRisk||'N/A'} → efectivo ${si.effectiveRisk||'N/A'}`,
  `  Mult    : score ${si.scoreMultiplier||'N/A'}x · 4h ${si.tf4hMultiplier||'N/A'}x · macro ${si.macroSizeMultiplier||'N/A'}x · reg ${si.regimeMultiplier||'N/A'}x`,
  '',
  // ── PRECIOS ─────────────────────────────────────────────────────────────────
  '─── PRECIOS ───',
  `  Entry  : $${num(entryPrice,4)}`,
  `  SL     : $${num(sl,4)}   (${slDist}% distancia)`,
  `  TP     : $${num(tp,4)}   (${tpDist}% distancia)`,
  `  R:R    : 1:${rrRatio}   (${rrLabel})`,
  '',
  // ── POSICION ────────────────────────────────────────────────────────────────
  '─── POSICION ───',
  `  Cantidad : ${qty} ${(symbol||'').replace('USDT','')}`,
  `  Riesgo   : ${riskPct}% del balance   ($${num(riskAmount)})`,
  `  Max loss : $${num(maxLoss)}   Max gain: $${num(maxGain)}`,
  `  Margen   : $${num(marginRequired)}`,
  '',
  // ── CUENTA ──────────────────────────────────────────────────────────────────
  '─── CUENTA ───',
  `  Balance     : $${num(balance)}   Disponible: $${num(availableBalance)}`,
  `  Posiciones  : ${openCount} abiertas — ${openList}`,
  '',
  // ── ORDENES ─────────────────────────────────────────────────────────────────
  '─── ORDENES ───',
  `  MARKET : Ejecutada   ID: ${marketOrderId||'N/A'}`,
  `  SL     : ${slOrderId?'Orden activa   ID: '+slOrderId:'Monitor activo'}`,
  `  TP     : ${tpOrderId?'Orden activa   ID: '+tpOrderId:'No colocado'}`,
  slError ? `  ⚠️ SL Error: ${clean(slError,80)}` : null,
  tpError ? `  ⚠️ TP Error: ${clean(tpError,80)}` : null,
  '',
  // ── IMAGEN ──────────────────────────────────────────────────────────────────
  '─── IMAGEN ───',
  `  Estado   : ${stateMap[vis.market_state]||vis.market_state||'N/A'}`,
  `  Aprobada : ${vis.approve_trade?'SI ✅':'NO ❌'}`,
  `  Veredicto: ${clean(vis.reason,140)}`,
  '',
  // ── INTELIGENCIA ────────────────────────────────────────────────────────────
  '─── INTELIGENCIA ───',
  `  Señal    : ${intelMap[intel.signal]||intel.signal||'N/A'}   Confianza: ${intel.confidence||'N/A'}`,
  `  Sesgo    : ${intel.bias||'N/A'}   Postura: ${intel.postureScore||0}`,
  intel.alerts?.length
    ? intel.alerts.map(a=>`  ⚠️ ${a.title}: ${clean(a.detail,80)}`).join('\n')
    : '  Sin alertas activas',
  '',
  // ── AI CONTEXT ──────────────────────────────────────────────────────────────
  '─── AI CONTEXT ───',
  `  Regimen : ${regimeMap[ai.regime]||ai.regime||'N/A'}`,
  `  Bias AI : ${ai.direction_bias||'N/A'}   Leverage: ${ai.recommended_leverage||5}x`,
  `  Riesgo  : ${clean(ai.key_risk,120)}`,
  `  Razon   : ${clean(ai.reasoning,140)}`,
  '',
  // ── MACRO ───────────────────────────────────────────────────────────────────
  '─── MACRO ───',
  `  Sesgo    : ${macroMap[mc.market_bias]||'N/A'}   Confianza: ${mc.confidence||'N/A'}%`,
  `  F&G      : ${mc.fearGreed?.value||'N/A'}/100 (${mc.fearGreed?.classification||'N/A'})`,
  `  BTC 12h  : ${mc.btcChange||'N/A'}%   BTC: ${mc.btcBullish?'Alcista 📈':'Bajista 📉'}`,
  `  Size mult: ${mc.size_multiplier||1.0}x`,
  `  Razon    : ${clean(mc.reason,140)}`,
  '',
  // ── TIMEFRAME 4H ────────────────────────────────────────────────────────────
  '─── TIMEFRAME 4H ───',
  `  Tendencia : ${tf.trend||'N/A'}   Estado: ${tf4hMap[tf.status]||tf.status||'N/A'}`,
  `  RSI 4H    : ${tf.rsi||'N/A'}   EMA8/21: ${tf.ema8||'N/A'} / ${tf.ema21||'N/A'}`,
  '',
  // ── INDICADORES ─────────────────────────────────────────────────────────────
  '─── INDICADORES ───',
  `  RSI14  : ${rsi.toFixed(1)}   ${rsiLabel}`,
  `  ATR    : $${num(ind.atr,4)}   (${num(ind.atrPct)}%)   Vol: ${num(volRatio)}x   ${volLabel}`,
  `  Funding: ${num(funding*100,4)}%   ${fundLabel}   VWAP: $${num(ind.vwap??0,4)}`,
  `  EMA8/21/50: $${num(ind.ema8??0,2)} / $${num(ind.ema21??0,2)} / $${num(ind.ema50??0,2)}`,
  `  EMA spread: ${emaSpread}%`,
  '',
  `🔭 Scan: ${num(scanScore,3)}   💰 Balance: $${num(balance)}`,
  '━━━━━━━━━━━━━━━━━━━━━━━'
].filter(l=>l!==null).join('\n');

return [{ json: { text: lines } }];
```

---

## Build AI Skip Message

```javascript
const d = $input.first().json;
const ind  = d.indicators || {};
const ai   = d.aiResult   || {};
const tf4h = d.tf4h || {};
const mc   = d.marketContext || {};
const intel = mc.intelligenceSignal || {};

// ── Cooldown ──────────────────────────────────────────────────────────────────
const skipReason = d.skipReason || '';
const isHardBlock =
  skipReason.includes('Macro bloquea') ||
  skipReason.includes('RSI peligroso') ||
  skipReason.includes('Vol spike') ||
  skipReason.includes('PARABOLIC') ||
  skipReason.includes('Circuit Breaker');

const sym = d.symbol || d.originalSymbol;
let cooldownUntilTs = null;
if(sym && !isHardBlock){
  try{
    const r = await this.helpers.httpRequest({
      method:'POST', url:'http://18.228.14.96:3001/cooldown/set', json:true,
      body:{ symbol:sym, minutes:60 }
    });
    cooldownUntilTs = r.expiresAt;
  }catch(e){}
}

function clean(t,max=180){ if(!t) return 'N/A'; return String(t).replace(/[<>_*[\]()~`#+|{}.!\\]/g,' ').replace(/\s+/g,' ').trim().substring(0,max); }
function num(v,dec=2){ return Number(v??0).toFixed(dec); }
function bar(s){ s=Math.min(100,Math.max(0,Math.round(s||0))); const f=Math.round(s/10); return '['+('█'.repeat(f)+'░'.repeat(10-f))+'] '+s+'/100'; }
function sign(n){ return n>=0?'+':''; }

const direction  = d.direction || 'NEUTRAL';
const baseScore  = d.score ?? 0;
const finalScore = d.finalScore ?? 0;
const dynThresh  = d.dynamicThreshold ?? 65;
const longScore  = d.longScore ?? 0;
const shortScore = d.shortScore ?? 0;
const rsi        = Number(ind.rsi14 ?? 50);
const volRatio   = Number(ind.volRatio ?? 0);
const funding    = Number(ind.fundingRate ?? 0);
const price      = Number(ind.currentPrice ?? 0);
const scanScore  = Number(d.scanScore ?? 0);
const intelAdj   = Number(d.intelAdjFinal ?? 0);

const isMacroBlock = skipReason.includes('Macro bloquea') || ai.confidence_adjustment === -100;

// Scores paso a paso
const adjValue   = isMacroBlock ? 0 : Number(ai.confidence_adjustment ?? 0);
const tf4hAdj    = tf4h?.adjust ?? 0;
const scoreStep1 = baseScore;
const scoreStep2 = scoreStep1 + tf4hAdj;
const scoreStep3 = scoreStep2 + adjValue;
const scoreStep4 = Math.min(100, Math.max(0, scoreStep3 + intelAdj));
const displayFinal = isMacroBlock ? baseScore : finalScore;
const gap          = displayFinal - dynThresh;
const gapStr       = gap>=0 ? `+${gap} sobre threshold ✅` : `${Math.abs(gap)} pts bajo threshold ❌`;

const blockType = isMacroBlock                ? 'MACRO'
                : skipReason.includes('RSI')  ? 'RSI'
                : skipReason.includes('Score')||skipReason.includes('threshold') ? 'SCORE'
                : skipReason.includes('4h')   ? '4H'
                : skipReason.includes('Ranging') ? 'LATERAL'
                : 'AI';

const dirEmoji  = direction==='LONG'?'🟢 LONG':direction==='SHORT'?'🔴 SHORT':'⚪ NEUTRAL';
const rsiLabel  = rsi>=75?'EXTREMO ALTO':rsi>=70?'Sobrecomprado':rsi>=60?'Zona alta':rsi<=25?'EXTREMO BAJO':rsi<=30?'Sobrevendido':rsi<=40?'Zona baja':'Neutral';
const volLabel  = volRatio>4?'SPIKE':volRatio>1.5?'Alto':volRatio<0.8?'Bajo':'Normal';
const fundLabel = funding>0.0001?'Longs pagan':funding<-0.0001?'Shorts pagan':'Neutral';
const tf4hMap   = {CONFIRMS:'✅ CONFIRMA',CONTRADICTS:'❌ CONTRADICE',NEUTRAL:'⚪ NEUTRAL'};
const macroMap  = {BULLISH:'🟢 BULLISH',BEARISH:'🔴 BEARISH',NEUTRAL:'⚪ NEUTRAL'};
const regimeMap = {TRENDING:'Trending 📈',RANGING:'Ranging ↔',HIGH_VOLATILITY:'Alta Vol ⚡'};
const intelMap  = {'NO OPERAR':'NO OPERAR ⛔',SHORT:'SHORT 🔴',LONG:'LONG 🟢',NEUTRAL:'NEUTRAL ⚪'};
const dominant  = longScore>shortScore?'LONG':shortScore>longScore?'SHORT':'NEUTRAL';

const cooldownStr = cooldownUntilTs
  ? `⏳ COOLDOWN — hasta ${new Date(cooldownUntilTs-6*3600000).toISOString().replace('T',' ').slice(11,16)} CR (60min)`
  : `✅ SIN COOLDOWN — se re-evalua proximo ciclo`;

// DB
try{ await this.helpers.httpRequest({method:'POST',url:'http://18.228.14.96:3001/db/rejection',json:true,body:{symbol:d.symbol,direction,skipReason,finalScore,scanScore,aiResult:ai,aiVision:null,indicators:ind,tf4hStatus:tf4h.status||null,macroBias:mc.market_bias||null,fearGreed:mc.fearGreed?.value||null}}); }catch(e){}
try{ await this.helpers.httpRequest({method:'POST',url:'http://18.228.14.96:3001/db/scan',json:true,body:{symbol:d.symbol,scanScore,direction,finalScore,longScore,shortScore,passAI:false,skipReason,indicators:ind,volume24h:d.volume24h,priceChangePct:d.priceChangePct}}); }catch(e){}

const ts = new Date().toISOString().replace('T',' ').slice(0,19)+' UTC';
const emaSpread = price?((Math.abs((ind.ema8??0)-(ind.ema50??0))/price)*100).toFixed(2):'0.00';

const msg = [
  '━━━━━━━━━━━━━━━━━━━━━━━',
  `🚫 RECHAZADO [${blockType}] — SIN IMAGEN`,
  '━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  `💎 ${d.symbol||'N/A'}   ${dirEmoji}`,
  `💵 $${price.toLocaleString('en-US',{maximumFractionDigits:4})}   🕐 ${ts}`,
  '',
  `⛔ ${clean(skipReason,120)}`,
  '',
  cooldownStr,
  '',
  '──── PUNTUACION ────',
  `  Scoring 1h puro  : ${bar(scoreStep1)}`,
  `  Long / Short     : ${longScore} / ${shortScore} pts  (señal ${dominant})`,
  `  Ajuste 4H        : ${sign(tf4hAdj)}${tf4hAdj} pts  (${tf4h?.status||'N/A'})`,
  `  Ajuste AI        : ${sign(adjValue)}${adjValue} pts  (${ai.regime||'N/A'})`,
  `  Ajuste Intel     : ${sign(intelAdj)}${intelAdj} pts  (${intelMap[intel.signal]||intel.signal||'N/A'} · ${intel.confidence||'N/A'})`,
  `  ─────────────────────────────────`,
  `  SCORE FINAL      : ${bar(displayFinal)}`,
  isMacroBlock
    ? `  Threshold        : ${dynThresh} pts  (bloqueo directo — no aplica)`
    : `  Threshold        : ${dynThresh} pts  — ${gapStr}`,
  '',
  '──── INTELIGENCIA ────',
  `  Señal    : ${intelMap[intel.signal]||intel.signal||'N/A'}   Confianza: ${intel.confidence||'N/A'}`,
  `  Sesgo    : ${intel.bias||'N/A'}   Postura: ${intel.postureScore||0}`,
  intel.alerts?.length
    ? intel.alerts.map(a=>`  ⚠️ ${a.title}: ${clean(a.detail,80)}`).join('\n')
    : '  Sin alertas activas',
  '',
  '──── CONTEXTO MACRO ────',
  `  Sesgo:    ${macroMap[mc.market_bias]||mc.market_bias||'N/A'}  (confianza ${mc.confidence||'N/A'}%)`,
  `  F&G:      ${mc.fearGreed?.value||'N/A'}/100  ${mc.fearGreed?.classification||''}`,
  `  BTC 12h:  ${mc.btcChange||'N/A'}%   ${mc.btcBullish?'Alcista 📈':'Bajista 📉'}`,
  `  Size:     ${mc.size_multiplier||1.0}x`,
  isMacroBlock ? `  Razon:    ${clean(mc.reason,120)}` : null,
  '',
  '──── TIMEFRAME 4H ────',
  `  Tendencia: ${tf4hMap[tf4h.status]||tf4h.status||'N/A'}  (${tf4h.trend||'N/A'})`,
  `  RSI 4H:    ${tf4h.rsi||'N/A'}`,
  `  EMA8/21:   ${tf4h.ema8||'N/A'} / ${tf4h.ema21||'N/A'}`,
  '',
  '──── AI CONTEXT ────',
  `  Regimen:  ${regimeMap[ai.regime]||ai.regime||'N/A'}`,
  `  Bias:     ${({LONG:'🟢 LONG',SHORT:'🔴 SHORT',NEUTRAL:'⚪ NEUTRAL'}[ai.direction_bias])||'N/A'}`,
  `  Leverage: ${ai.recommended_leverage||5}x`,
  `  Riesgo:   ${clean(ai.key_risk,120)}`,
  !isMacroBlock ? `  Razon:    ${clean(ai.reasoning,120)}` : null,
  '',
  '──── INDICADORES ────',
  `  RSI14:   ${rsi.toFixed(1)}  (${rsiLabel})`,
  `  ATR:     $${num(ind.atr,2)}  ${num(ind.atrPct)}%`,
  `  Vol:     ${num(volRatio)}x  ${volLabel}`,
  `  Funding: ${num(funding*100,4)}%  ${fundLabel}`,
  `  VWAP:    $${num(ind.vwap??0,4)}`,
  `  EMA spr: ${emaSpread}%`,
  '',
  '──── EMAs ────',
  `  EMA8:  $${num(ind.ema8??0,4)}`,
  `  EMA21: $${num(ind.ema21??0,4)}`,
  `  EMA50: $${num(ind.ema50??0,4)}`,
  '',
  `🔭 Scan: ${num(scanScore,3)}   💰 Balance: $${num(d.balance??0)}`,
  '━━━━━━━━━━━━━━━━━━━━━━━'
].filter(l=>l!==null).join('\n');

// ── Macro cooldown en Static Data para que Aggregate excluya el símbolo ───────
if(isMacroBlock && sym){
  try{
    const wfState = $getWorkflowStaticData('global');
    if(!wfState.macroCooldowns) wfState.macroCooldowns = {};
    wfState.macroCooldowns[sym] = Date.now();
    console.log(`[MacroCooldown] ${sym} registrado — excluido 15min del Aggregate`);
  }catch(e){ console.log('[MacroCooldown] error:', e.message); }
}

return [{ json: { text: msg } }];
```

---

## Build AI Skip Message Image

```javascript
const d = $input.first().json;
const ind  = d.indicators || {};
const ai   = d.aiResult   || {};
const vis  = d.aiVision   || {};
const flt  = d.filters    || {};
const tf4h = d.tf4h || {};
const mc   = d.marketContext || {};
const intel = mc.intelligenceSignal || {};

// ── Cooldown ──────────────────────────────────────────────────────────────────
const skipReason = d.skipReason || '';
const isHardBlock =
  skipReason.includes('Macro bloquea') ||
  skipReason.includes('RSI peligroso') ||
  skipReason.includes('Vol spike') ||
  skipReason.includes('PARABOLIC') ||
  skipReason.includes('Circuit Breaker');

const sym = d.symbol || d.originalSymbol;
let cooldownUntilTs = null;
if(sym && !isHardBlock){
  try{
    const r = await this.helpers.httpRequest({
      method:'POST', url:'http://18.228.14.96:3001/cooldown/set', json:true,
      body:{ symbol:sym, minutes:60 }
    });
    cooldownUntilTs = r.expiresAt;
  }catch(e){}
}

function clean(t,max=180){ if(!t) return 'N/A'; return String(t).replace(/[<>_*[\]()~`#+|{}.!\\]/g,' ').replace(/\s+/g,' ').trim().substring(0,max); }
function num(v,dec=2){ return Number(v??0).toFixed(dec); }
function bar(s){ s=Math.min(100,Math.max(0,Math.round(s||0))); const f=Math.round(s/10); return '['+('█'.repeat(f)+'░'.repeat(10-f))+'] '+s+'/100'; }
function sign(n){ return n>=0?'+':''; }

const direction  = d.direction || 'NEUTRAL';
const baseScore  = d.score ?? 0;
const finalScore = d.finalScore ?? 0;
const dynThresh  = d.dynamicThreshold ?? 65;
const longScore  = d.longScore ?? 0;
const shortScore = d.shortScore ?? 0;
const rsi        = Number(ind.rsi14 ?? 50);
const volRatio   = Number(ind.volRatio ?? 0);
const funding    = Number(ind.fundingRate ?? 0);
const price      = Number(ind.currentPrice ?? 0);
const scanScore  = Number(d.scanScore ?? 0);
const intelAdj   = Number(d.intelAdjFinal ?? 0);

const isMacroBlock  = skipReason.includes('Macro bloquea') || ai.confidence_adjustment === -100;
const isVisionBlock = skipReason.includes('PARABOLIC') || skipReason.includes('Tendencia extendida') || skipReason.includes('imagen rechaza');

// Scores paso a paso
const adjValue   = isMacroBlock ? 0 : Number(ai.confidence_adjustment ?? 0);
const tf4hAdj    = tf4h?.adjust ?? 0;
const scoreStep1 = baseScore;
const scoreStep2 = scoreStep1 + tf4hAdj;
const scoreStep3 = scoreStep2 + adjValue;
const scoreStep4 = Math.min(100, Math.max(0, scoreStep3 + intelAdj));
const displayFinal = isMacroBlock ? baseScore : finalScore;
const gap          = displayFinal - dynThresh;
const gapStr       = gap>=0 ? `+${gap} sobre threshold ✅` : `${Math.abs(gap)} pts bajo threshold ❌`;

const blockType = isMacroBlock        ? 'MACRO'
                : isVisionBlock       ? 'VISION'
                : skipReason.includes('RSI')     ? 'RSI'
                : skipReason.includes('Score')||skipReason.includes('threshold') ? 'SCORE'
                : skipReason.includes('4h')      ? '4H'
                : skipReason.includes('Ranging') ? 'LATERAL'
                : 'AI';

const dirEmoji  = direction==='LONG'?'🟢 LONG':direction==='SHORT'?'🔴 SHORT':'⚪ NEUTRAL';
const rsiLabel  = rsi>=75?'EXTREMO ALTO':rsi>=70?'Sobrecomprado':rsi>=60?'Zona alta':rsi<=25?'EXTREMO BAJO':rsi<=30?'Sobrevendido':rsi<=40?'Zona baja':'Neutral';
const volLabel  = volRatio>4?'SPIKE':volRatio>1.5?'Alto':volRatio<0.8?'Bajo':'Normal';
const fundLabel = funding>0.0001?'Longs pagan':funding<-0.0001?'Shorts pagan':'Neutral';
const tf4hMap   = {CONFIRMS:'✅ CONFIRMA',CONTRADICTS:'❌ CONTRADICE',NEUTRAL:'⚪ NEUTRAL'};
const macroMap  = {BULLISH:'🟢 BULLISH',BEARISH:'🔴 BEARISH',NEUTRAL:'⚪ NEUTRAL'};
const stateMap  = {EARLY_TREND:'Early Trend 🟢',MID_TREND:'Mid Trend 🟡',LATE_TREND:'Late Trend ⚠',PARABOLIC:'PARABOLICO 🚨'};
const regimeMap = {TRENDING:'Trending 📈',RANGING:'Ranging ↔',HIGH_VOLATILITY:'Alta Vol ⚡'};
const intelMap  = {'NO OPERAR':'NO OPERAR ⛔',SHORT:'SHORT 🔴',LONG:'LONG 🟢',NEUTRAL:'NEUTRAL ⚪'};
const dominant  = longScore>shortScore?'LONG':shortScore>longScore?'SHORT':'NEUTRAL';

const cooldownStr = cooldownUntilTs
  ? `⏳ COOLDOWN — hasta ${new Date(cooldownUntilTs-6*3600000).toISOString().replace('T',' ').slice(11,16)} CR (60min)`
  : `✅ SIN COOLDOWN — se re-evalua proximo ciclo`;

// DB
try{ await this.helpers.httpRequest({method:'POST',url:'http://18.228.14.96:3001/db/rejection',json:true,body:{symbol:d.symbol,direction,skipReason,finalScore,scanScore,aiResult:ai,aiVision:vis,indicators:ind,tf4hStatus:tf4h.status||null,macroBias:mc.market_bias||null,fearGreed:mc.fearGreed?.value||null}}); }catch(e){}
try{ await this.helpers.httpRequest({method:'POST',url:'http://18.228.14.96:3001/db/scan',json:true,body:{symbol:d.symbol,scanScore,direction,finalScore,longScore,shortScore,passAI:false,skipReason,indicators:ind,volume24h:d.volume24h,priceChangePct:d.priceChangePct}}); }catch(e){}

const ts = new Date().toISOString().replace('T',' ').slice(0,19)+' UTC';
const emaSpread = price?((Math.abs((ind.ema8??0)-(ind.ema50??0))/price)*100).toFixed(2):'0.00';

const hasFilters = flt.visionReject||flt.visionLate||flt.rsiDangerous||flt.volumeSpike||(!flt.biasAligns)||flt.rangingBlock;

const msg = [
  '━━━━━━━━━━━━━━━━━━━━━━━',
  `🚫 RECHAZADO [${blockType}] — CON IMAGEN`,
  '━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  `💎 ${d.symbol||'N/A'}   ${dirEmoji}`,
  `💵 $${price.toLocaleString('en-US',{maximumFractionDigits:4})}   🕐 ${ts}`,
  '',
  `⛔ ${clean(skipReason,120)}`,
  '',
  cooldownStr,
  '',
  '──── PUNTUACION ────',
  `  Scoring 1h puro  : ${bar(scoreStep1)}`,
  `  Long / Short     : ${longScore} / ${shortScore} pts  (señal ${dominant})`,
  `  Ajuste 4H        : ${sign(tf4hAdj)}${tf4hAdj} pts  (${tf4h?.status||'N/A'})`,
  `  Ajuste AI        : ${sign(adjValue)}${adjValue} pts  (${ai.regime||'N/A'})`,
  `  Ajuste Intel     : ${sign(intelAdj)}${intelAdj} pts  (${intelMap[intel.signal]||intel.signal||'N/A'} · ${intel.confidence||'N/A'})`,
  `  ─────────────────────────────────`,
  `  SCORE FINAL      : ${bar(displayFinal)}`,
  isMacroBlock
    ? `  Threshold        : ${dynThresh} pts  (bloqueo directo — no aplica)`
    : `  Threshold        : ${dynThresh} pts  — ${gapStr}`,
  '',
  '──── INTELIGENCIA ────',
  `  Señal    : ${intelMap[intel.signal]||intel.signal||'N/A'}   Confianza: ${intel.confidence||'N/A'}`,
  `  Sesgo    : ${intel.bias||'N/A'}   Postura: ${intel.postureScore||0}`,
  intel.alerts?.length
    ? intel.alerts.map(a=>`  ⚠️ ${a.title}: ${clean(a.detail,80)}`).join('\n')
    : '  Sin alertas activas',
  '',
  '──── IMAGEN ────',
  `  Estado:    ${stateMap[vis.market_state]||vis.market_state||'N/A'}`,
  `  Aprobada:  ${vis.approve_trade?'SI ✅':'NO ❌'}`,
  `  Veredicto: ${clean(vis.reason,120)}`,
  '',
  '──── CONTEXTO MACRO ────',
  `  Sesgo:    ${macroMap[mc.market_bias]||mc.market_bias||'N/A'}  (confianza ${mc.confidence||'N/A'}%)`,
  `  F&G:      ${mc.fearGreed?.value||'N/A'}/100  ${mc.fearGreed?.classification||''}`,
  `  BTC 12h:  ${mc.btcChange||'N/A'}%   ${mc.btcBullish?'Alcista 📈':'Bajista 📉'}`,
  `  Size:     ${mc.size_multiplier||1.0}x`,
  isMacroBlock ? `  Razon:    ${clean(mc.reason,120)}` : null,
  '',
  '──── TIMEFRAME 4H ────',
  `  Tendencia: ${tf4hMap[tf4h.status]||tf4h.status||'N/A'}  (${tf4h.trend||'N/A'})`,
  `  RSI 4H:    ${tf4h.rsi||'N/A'}`,
  `  EMA8/21:   ${tf4h.ema8||'N/A'} / ${tf4h.ema21||'N/A'}`,
  '',
  '──── AI CONTEXT ────',
  `  Regimen:  ${regimeMap[ai.regime]||ai.regime||'N/A'}`,
  `  Bias:     ${({LONG:'🟢 LONG',SHORT:'🔴 SHORT',NEUTRAL:'⚪ NEUTRAL'}[ai.direction_bias])||'N/A'}`,
  `  Leverage: ${ai.recommended_leverage||5}x`,
  `  Riesgo:   ${clean(ai.key_risk,120)}`,
  !isMacroBlock ? `  Razon:    ${clean(ai.reasoning,120)}` : null,
  '',
  hasFilters ? '──── FILTROS ACTIVOS ────' : null,
  flt.visionReject  ? '  • Imagen rechaza el trade' : null,
  flt.visionLate    ? `  • Chart: ${stateMap[vis.market_state]||vis.market_state}` : null,
  flt.rsiDangerous  ? `  • RSI peligroso: ${rsi.toFixed(1)}` : null,
  flt.volumeSpike   ? `  • Vol spike: ${volRatio.toFixed(1)}x` : null,
  !flt.biasAligns   ? '  • Bias AI vs señal' : null,
  flt.rangingBlock  ? '  • Ranging score bajo' : null,
  hasFilters ? '' : null,
  '──── INDICADORES ────',
  `  RSI14:   ${rsi.toFixed(1)}  (${rsiLabel})`,
  `  ATR:     $${num(ind.atr,2)}  ${num(ind.atrPct)}%`,
  `  Vol:     ${num(volRatio)}x  ${volLabel}`,
  `  Funding: ${num(funding*100,4)}%  ${fundLabel}`,
  `  VWAP:    $${num(ind.vwap??0,4)}`,
  `  EMA spr: ${emaSpread}%`,
  '',
  '──── EMAs ────',
  `  EMA8:  $${num(ind.ema8??0,4)}`,
  `  EMA21: $${num(ind.ema21??0,4)}`,
  `  EMA50: $${num(ind.ema50??0,4)}`,
  '',
  `🔭 Scan: ${num(scanScore,3)}   💰 Balance: $${num(d.balance??0)}`,
  '━━━━━━━━━━━━━━━━━━━━━━━'
].filter(l=>l!==null).join('\n');
// ── Macro cooldown en Static Data para que Aggregate excluya el símbolo ───────
if(isMacroBlock && sym){
  try{
    const wfState = $getWorkflowStaticData('global');
    if(!wfState.macroCooldowns) wfState.macroCooldowns = {};
    wfState.macroCooldowns[sym] = Date.now();
    console.log(`[MacroCooldown] ${sym} registrado — excluido 15min del Aggregate`);
  }catch(e){ console.log('[MacroCooldown] error:', e.message); }
}

return [{ json: { text: msg } }];
```

---

## DETECTOR DE RSI EXTREMO

```javascript
const data = $input.first().json;
const indicators = data.indicators || {};
const state = $getWorkflowStaticData('global');

// ── Lista de símbolos sin chart en TradingView ────────────────────────────────
if(!state.noChartSymbols) state.noChartSymbols = [];
const KNOWN_NO_CHART = ['SIRENUSDT', 'RENDERUSDT', 'WIFUSDT'];
for(const s of KNOWN_NO_CHART){
  if(!state.noChartSymbols.includes(s)) state.noChartSymbols.push(s);
}

const symbolHasChart = !state.noChartSymbols.includes(data.symbol);

// ── Condición técnica — independiente del chart ───────────────────────────────
const extremeRSI     = indicators.rsi14 > 75 || indicators.rsi14 < 25;
const extremeATR     = indicators.atrPct > 1.5;
const needVisualCheck = extremeRSI || extremeATR;  // ← ya NO depende de symbolHasChart

console.log(`[Detector] ${data.symbol} rsi=${indicators.rsi14} atr=${indicators.atrPct} needVisual=${needVisualCheck} hasChart=${symbolHasChart}`);

return [{
  json: {
    ...data,
    needVisualCheck,
    symbolHasChart,
    noChartSymbols: state.noChartSymbols
  }
}];
```

---

## Daily PnL Report

```javascript
const crypto = require('crypto');
const API_KEY    = 'YOUR_BINANCE_API_KEY';
const API_SECRET = 'YOUR_BINANCE_API_SECRET';
const BASE      = 'https://fapi.binance.com';
const DASHBOARD = 'http://18.228.14.96:3001';

function sign(params) {
  const obj = {...params, timestamp: Date.now(), recvWindow: 60000};
  const qs = Object.entries(obj).map(([k,v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return qs + '&signature=' + crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
}
async function bget(path, params = {}) {
  return this.helpers.httpRequest({ method:'GET', url:`${BASE}${path}?${sign(params)}`, headers:{'X-MBX-APIKEY':API_KEY}, json:true });
}

const now      = Date.now();
const dayStart = new Date(); dayStart.setUTCHours(0,0,0,0);
const startTime = dayStart.getTime();

// ── Fetch paralelo: income + balance + posiciones + DB stats ──────────────────
const [income, balances, positions, dbStats] = await Promise.all([
  bget.call(this, '/fapi/v1/income', { startTime, endTime: now, limit: 1000 }),
  bget.call(this, '/fapi/v2/balance'),
  bget.call(this, '/fapi/v2/positionRisk'),
  this.helpers.httpRequest({ method:'GET', url:`${DASHBOARD}/db/stats`, json:true }).catch(()=>null)
]);

const rows = Array.isArray(income) ? income : [];

// ── Calcular PnL del día ──────────────────────────────────────────────────────
let realized = 0, commission = 0, funding = 0, wins = 0, losses = 0;
const perSym = {};
const tradesByHour = {};

for (const r of rows) {
  const v = parseFloat(r.income || 0);
  if (r.incomeType === 'REALIZED_PNL') {
    realized += v;
    if (v > 0) wins++; else if (v < 0) losses++;
    const s = r.symbol || '';
    if (s) perSym[s] = (perSym[s] || 0) + v;
    // por hora
    const h = new Date(r.time).getUTCHours();
    if (!tradesByHour[h]) tradesByHour[h] = { pnl:0, count:0 };
    tradesByHour[h].pnl += v;
    tradesByHour[h].count++;
  }
  if (r.incomeType === 'COMMISSION') commission += v;
  if (r.incomeType === 'FUNDING_FEE') funding += v;
}

const net          = realized + commission + funding;
const totalTrades  = wins + losses;
const winrate      = totalTrades > 0 ? (wins/totalTrades*100).toFixed(1) : '0.0';
const avgTrade     = totalTrades > 0 ? (realized/totalTrades).toFixed(2) : '0.00';
const profitFactor = losses > 0 && wins > 0
  ? (rows.filter(r=>r.incomeType==='REALIZED_PNL'&&+r.income>0).reduce((s,r)=>s+(+r.income),0) /
     Math.abs(rows.filter(r=>r.incomeType==='REALIZED_PNL'&&+r.income<0).reduce((s,r)=>s+(+r.income),0))).toFixed(2)
  : 'N/A';

// ── Balance ───────────────────────────────────────────────────────────────────
const usdt         = (Array.isArray(balances)?balances:[]).find(b=>b.asset==='USDT') || {};
const balance      = parseFloat(usdt.balance || 0);
const available    = parseFloat(usdt.availableBalance || 0);
const unrealized   = parseFloat(usdt.crossUnPnl || 0);
const marginUsed   = balance - available;
const dailyROI     = balance > 0 ? (net/balance*100).toFixed(2) : '0.00';

// ── Posiciones abiertas ───────────────────────────────────────────────────────
const openPos = (Array.isArray(positions)?positions:[])
  .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
  .map(p => ({
    symbol:    p.symbol,
    side:      parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
    size:      Math.abs(parseFloat(p.positionAmt)),
    entry:     parseFloat(p.entryPrice),
    mark:      parseFloat(p.markPrice),
    pnl:       parseFloat(p.unRealizedProfit),
    roe:       parseFloat(p.percentage || 0),
    leverage:  parseFloat(p.leverage || 1)
  }));

const totalUnrealized = openPos.reduce((s,p) => s + p.pnl, 0);

// ── DB: trades de hoy con R ───────────────────────────────────────────────────
const recent    = (dbStats?.recent || []);
const todayDB   = recent.filter(t => {
  const d = (t.closed_at || t.opened_at || '').toString().slice(0,10);
  return d === new Date().toISOString().slice(0,10);
});
const closedDB  = todayDB.filter(t => t.pnl_usdt != null);
const avgR      = closedDB.length
  ? (closedDB.reduce((s,t)=>s+(+t.r_final||0),0)/closedDB.length).toFixed(2)
  : '—';
const bestTrade = closedDB.reduce((b,t) => (!b||+t.pnl_usdt>+b.pnl_usdt)?t:b, null);
const worstTrade= closedDB.reduce((b,t) => (!b||+t.pnl_usdt<+b.pnl_usdt)?t:b, null);

// ── Mejor hora del día ────────────────────────────────────────────────────────
const bestHour = Object.entries(tradesByHour)
  .sort((a,b) => b[1].pnl - a[1].pnl)[0];

// ── Top symbols ───────────────────────────────────────────────────────────────
const topSyms = Object.entries(perSym)
  .sort((a,b) => b[1] - a[1]);
const topWin  = topSyms.filter(([,v]) => v > 0).slice(0, 3);
const topLoss = topSyms.filter(([,v]) => v < 0).slice(0, 3);

// ── Semaforo de rendimiento ───────────────────────────────────────────────────
const perfEmoji = net > 5 ? '🟢' : net > 0 ? '🟡' : net > -5 ? '🟠' : '🔴';
const wrEmoji   = +winrate >= 70 ? '🔥' : +winrate >= 50 ? '✅' : '⚠️';

// ── Construir mensaje ─────────────────────────────────────────────────────────
const dateStr = new Date().toISOString().slice(0,10);
const ts      = new Date().toISOString().replace('T',' ').slice(0,16) + ' UTC';

function pnlStr(v) { return (v>=0?'+':'') + '$' + Math.abs(v).toFixed(2); }
function bar(pct, max=10) {
  const f = Math.round(Math.min(Math.abs(pct)/10, 1) * max);
  return '█'.repeat(f) + '░'.repeat(max-f);
}

const lines = [
  '━━━━━━━━━━━━━━━━━━━━━━━',
  `${perfEmoji} DAILY PnL REPORT — ${dateStr}`,
  '━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '💰 RESULTADO DEL DÍA',
  `  Realized PnL:   ${pnlStr(realized)}`,
  `  Comisiones:     ${pnlStr(commission)}`,
  `  Funding:        ${pnlStr(funding)}`,
  `  ─────────────────────`,
  `  NET TOTAL:      ${pnlStr(net)}   (${dailyROI >= 0 ? '+' : ''}${dailyROI}% del balance)`,
  '',
  '📊 ESTADÍSTICAS',
  `  Trades:    ${totalTrades}   ${wrEmoji} WR: ${winrate}%   [${bar(+winrate)}]`,
  `  Wins:      ${wins}   Losses: ${losses}`,
  `  Avg trade: ${pnlStr(+avgTrade)}   Avg R: ${avgR}R`,
  `  Profit F:  ${profitFactor}x`,
  bestTrade  ? `  Mejor:    ${bestTrade.symbol} ${pnlStr(+bestTrade.pnl_usdt)} (+${(+bestTrade.r_final||0).toFixed(2)}R)` : '',
  worstTrade ? `  Peor:     ${worstTrade.symbol} ${pnlStr(+worstTrade.pnl_usdt)} (${(+worstTrade.r_final||0).toFixed(2)}R)` : '',
  '',
  '💼 CUENTA',
  `  Balance:     $${balance.toFixed(2)}`,
  `  Disponible:  $${available.toFixed(2)}`,
  `  En margen:   $${marginUsed.toFixed(2)}`,
  `  Unrealized:  ${pnlStr(totalUnrealized)}`,
  '',
];

// Top wins
if (topWin.length > 0) {
  lines.push('🏆 MEJORES PARES');
  topWin.forEach(([s,v]) => lines.push(`  ${s.replace('USDT','')}:  ${pnlStr(v)}`));
  lines.push('');
}

// Top losses
if (topLoss.length > 0) {
  lines.push('💀 PEORES PARES');
  topLoss.forEach(([s,v]) => lines.push(`  ${s.replace('USDT','')}:  ${pnlStr(v)}`));
  lines.push('');
}

// Mejor hora
if (bestHour) {
  lines.push('🕐 MEJOR HORA DEL DÍA');
  lines.push(`  ${String(bestHour[0]).padStart(2,'0')}:00 UTC — ${pnlStr(bestHour[1].pnl)} (${bestHour[1].count} trades)`);
  lines.push('');
}

// Posiciones abiertas
if (openPos.length > 0) {
  lines.push(`📈 POSICIONES ABIERTAS (${openPos.length})`);
  openPos.forEach(p => {
    const pnlS = pnlStr(p.pnl);
    const roeS = (p.roe>=0?'+':'') + p.roe.toFixed(1) + '%';
    lines.push(`  ${p.side === 'SHORT' ? '🔴' : '🟢'} ${p.symbol.replace('USDT','')} ${p.leverage}x @ $${p.entry} → ${pnlS} (${roeS})`);
  });
  lines.push('');
}

lines.push(`⏰ ${ts}`);
lines.push('━━━━━━━━━━━━━━━━━━━━━━━');

const text = lines.filter(l => l !== null && l !== undefined).join('\n');
return [{ json: { text } }];
```

---

## Parse Output Of Claude

```javascript
let aiVision;
const raw = $input.first().json.stdout;

try {
  const apiResponse = JSON.parse(raw);
  
  if(apiResponse.content && apiResponse.content[0]?.text){
    const text = apiResponse.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    if(match){
      aiVision = JSON.parse(match[0]);
    } else {
      throw new Error('No JSON en content[0].text');
    }
    aiVision._apiResponse = {
      model: apiResponse.model,
      usage: apiResponse.usage
    };
  } else if(apiResponse.approve_trade !== undefined){
    aiVision = apiResponse;
  } else {
    throw new Error('Formato desconocido');
  }
} catch(e) {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if(match) aiVision = JSON.parse(match[0]);
    else throw new Error('No JSON encontrado');
  } catch(e2) {
    aiVision = {
      approve_trade: true,
      market_state: 'UNKNOWN',
      reason: 'parse_error_fallback'
    };
  }
}

// ── Auto-detectar símbolos sin chart válido en TradingView ────────────────────
const state = $getWorkflowStaticData('global');
if(!state.noChartSymbols) state.noChartSymbols = [];

const sym = $('Aggregate Best Setup').first().json.symbol;
const reason = (aiVision.reason || '').toLowerCase();

const chartFailed =
  reason.includes('no exist') ||
  reason.includes('no hay datos') ||
  reason.includes('no existe') ||
  reason.includes('not found') ||
  reason.includes('símbolo no') ||
  reason.includes('symbol') ||
  (aiVision.market_state === 'UNKNOWN' && aiVision.approve_trade === false && !aiVision._apiResponse);

if(chartFailed && sym && !state.noChartSymbols.includes(sym)){
  state.noChartSymbols.push(sym);
  console.log(`[Chart] ${sym} agregado a noChartSymbols automáticamente — TradingView no lo soporta`);
}

console.log(`[Parse] ${sym} aiVision=${JSON.stringify(aiVision)} chartFailed=${chartFailed} noChartList=${state.noChartSymbols.join(',')}`);

// ── Recuperar datos originales ────────────────────────────────────────────────
const originalData = $('Aggregate Best Setup').first().json;

return [{
  json: {
    ...originalData,
    aiVision
  }
}];
```

---

## Daily Analysis Report

```javascript
const ANTHROPIC_KEY = 'YOUR_ANTHROPIC_API_KEY';
const DASHBOARD     = 'http://18.228.14.96:3001';

// ── 1. Obtener stats del día ──────────────────────────────────────────────────
const statsResp = await this.helpers.httpRequest({
  method: 'GET',
  url: `${DASHBOARD}/db/stats`,
  json: true
});

const stats = statsResp;

// ── 2. Obtener datos adicionales de MySQL via dashboard ───────────────────────
const today = new Date().toISOString().slice(0, 10);

// Trades de hoy
const todayTrades = (stats.recent || []).filter(t => {
  const d = (t.closed_at || t.opened_at || '').toString().slice(0, 10);
  return d === today;
});

const todayClosed  = todayTrades.filter(t => t.pnl_usdt != null);
const todayOpen    = todayTrades.filter(t => t.pnl_usdt == null);
const todayWins    = todayClosed.filter(t => +t.pnl_usdt > 0);
const todayLosses  = todayClosed.filter(t => +t.pnl_usdt <= 0);
const todayPnL     = todayClosed.reduce((s, t) => s + (+t.pnl_usdt || 0), 0);
const todayAvgR    = todayClosed.length ? todayClosed.reduce((s,t) => s + (+t.r_final||0), 0) / todayClosed.length : 0;

// Rechazos de hoy
const todayRejections = (stats.topRejections || []);

// ── 3. Construir contexto para Claude ─────────────────────────────────────────
const tradesDetail = todayClosed.map(t =>
  `- ${t.symbol} ${t.direction} | entry=$${+t.entry_price} | exit=$${+t.exit_price||0} | PnL=${+t.pnl_usdt>=0?'+':''}$${(+t.pnl_usdt||0).toFixed(2)} | R=${+t.r_final||0} | score=${+t.final_score||0} | cierre=${t.close_reason} | stage=${t.trailing_stage||'N/A'}`
).join('\n');

const rejectDetail = todayRejections.slice(0, 5).map(r =>
  `- "${r.skip_reason}" — ${r.count} veces`
).join('\n');

const prompt = `Eres un analista experto en trading algorítmico de crypto futures. Analiza el rendimiento del día de este bot de trading automático y da recomendaciones CONCRETAS y ACCIONABLES.

DATOS DEL DÍA ${today}:
- Trades cerrados: ${todayClosed.length} (${todayWins.length} wins / ${todayLosses.length} losses)
- PnL total: ${todayPnL >= 0 ? '+' : ''}$${todayPnL.toFixed(2)}
- Win rate: ${todayClosed.length ? ((todayWins.length/todayClosed.length)*100).toFixed(1) : 0}%
- R promedio: ${todayAvgR >= 0 ? '+' : ''}${todayAvgR.toFixed(2)}R
- Trades abiertos: ${todayOpen.length}

DETALLE DE TRADES CERRADOS:
${tradesDetail || 'Ninguno hoy'}

RAZONES DE RECHAZO MÁS FRECUENTES (histórico):
${rejectDetail || 'Sin datos'}

CONTEXTO DEL SISTEMA:
- El scoring usa: TREND(40pts) + RSI(25pts) + VOLUME(20pts) + VWAP(15pts) + FUNDING(10pts)
- Filtros AI: biasAligns, rangingBlock(<65pts), rsiDangerous(SHORT<30/LONG>70), volumeSpike(>4x)
- Trailing stages: INITIAL → BREAKEVEN(1R) → LOCK(1.5R) → TRAILING(2R+ATR)
- Umbral mínimo para operar: score >= 45

Responde en español con este formato EXACTO (sin markdown extra):

📊 ANÁLISIS DIARIO — ${today}

💰 RESUMEN
[2-3 líneas con lo más importante del día]

✅ LO QUE FUNCIONÓ
[máx 3 puntos concretos]

⚠️ PROBLEMAS DETECTADOS
[máx 3 problemas específicos con números]

🔧 RECOMENDACIONES PARA MAÑANA
[máx 3 cambios concretos con valores exactos. Ej: "Subir umbral ATR de 5% a 7%" o "Excluir XRPUSDT en horario 02:00-06:00 UTC"]

📈 OUTLOOK
[1 línea sobre qué esperar mañana]`;

// ── 4. Llamar a Claude ────────────────────────────────────────────────────────
let analysis = 'Error generando análisis';
try {
  const resp = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    }),
    json: false
  });
  const body = typeof resp === 'string' ? JSON.parse(resp) : resp;
  if (!body?.error) {
    analysis = body?.content?.[0]?.text || 'Sin respuesta';
  } else {
    analysis = 'API Error: ' + JSON.stringify(body.error);
  }
} catch(e) {
  analysis = 'Error: ' + e.message;
}

return [{ json: { text: analysis } }];
```

---

## Weekly Deep Analysis

```javascript
const ANTHROPIC_KEY = 'YOUR_ANTHROPIC_API_KEY';
const DASHBOARD     = 'http://18.228.14.96:3001';

// ── 1. Obtener todos los stats ────────────────────────────────────────────────
const stats = await this.helpers.httpRequest({
  method: 'GET',
  url: `${DASHBOARD}/db/stats`,
  json: true
});

const closed = (stats.recent || [])
  .filter(t => t.pnl_usdt != null)
  .map(t => ({
    ...t,
    pnl_usdt:    +t.pnl_usdt    || 0,
    r_final:     +t.r_final     || 0,
    final_score: +t.final_score || 0,
    entry_price: +t.entry_price || 0,
    exit_price:  +t.exit_price  || 0,
  }));

// ── 2. Calcular métricas avanzadas ────────────────────────────────────────────

// Por hora de apertura
const byHour = {};
closed.forEach(t => {
  const h = new Date(t.opened_at).getUTCHours();
  if (!byHour[h]) byHour[h] = { wins:0, losses:0, pnl:0 };
  t.pnl_usdt > 0 ? byHour[h].wins++ : byHour[h].losses++;
  byHour[h].pnl += t.pnl_usdt;
});
const hourStats = Object.entries(byHour)
  .map(([h, d]) => ({ hour: +h, ...d, total: d.wins + d.losses, wr: d.wins/(d.wins+d.losses)*100 }))
  .sort((a, b) => b.wr - a.wr);

// Por par
const bySymbol = {};
closed.forEach(t => {
  if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { wins:0, losses:0, pnl:0, scores:[], rs:[] };
  t.pnl_usdt > 0 ? bySymbol[t.symbol].wins++ : bySymbol[t.symbol].losses++;
  bySymbol[t.symbol].pnl  += t.pnl_usdt;
  bySymbol[t.symbol].scores.push(t.final_score);
  bySymbol[t.symbol].rs.push(t.r_final);
});
const symbolStats = Object.entries(bySymbol).map(([sym, d]) => ({
  symbol: sym,
  wins: d.wins, losses: d.losses,
  wr: (d.wins/(d.wins+d.losses)*100).toFixed(1),
  pnl: d.pnl.toFixed(2),
  avgScore: (d.scores.reduce((a,b)=>a+b,0)/d.scores.length).toFixed(0),
  avgR: (d.rs.reduce((a,b)=>a+b,0)/d.rs.length).toFixed(2)
})).sort((a,b) => +b.pnl - +a.pnl);

// Por trailing stage de cierre
const byStage = {};
closed.forEach(t => {
  const s = t.trailing_stage || 'INITIAL';
  if (!byStage[s]) byStage[s] = { wins:0, losses:0, pnl:0 };
  t.pnl_usdt > 0 ? byStage[s].wins++ : byStage[s].losses++;
  byStage[s].pnl += t.pnl_usdt;
});

// Por régimen AI
const byRegime = {};
closed.forEach(t => {
  const r = t.ai_regime || 'N/A';
  if (!byRegime[r]) byRegime[r] = { wins:0, losses:0, pnl:0 };
  t.pnl_usdt > 0 ? byRegime[r].wins++ : byRegime[r].losses++;
  byRegime[r].pnl += t.pnl_usdt;
});

// Score de ganadores vs perdedores
const winners = closed.filter(t => t.pnl_usdt > 0);
const losers  = closed.filter(t => t.pnl_usdt <= 0);
const avgScoreWin  = winners.length ? (winners.reduce((s,t)=>s+t.final_score,0)/winners.length).toFixed(1) : 0;
const avgScoreLoss = losers.length  ? (losers.reduce((s,t)=>s+t.final_score,0)/losers.length).toFixed(1)  : 0;

// Razones de rechazo
const rejections = (stats.topRejections || []).slice(0, 8);

// ── 3. Construir prompt ───────────────────────────────────────────────────────
const weekEnd   = new Date().toISOString().slice(0,10);
const weekStart = new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);

const prompt = `Eres un quant trader experto en sistemas algorítmicos de crypto futures. Haz un análisis PROFUNDO y TÉCNICO de la semana de este bot y da recomendaciones con valores EXACTOS para mejorar el código.

SEMANA: ${weekStart} → ${weekEnd}
TRADES TOTALES: ${closed.length} | WINS: ${winners.length} | LOSSES: ${losers.length}
WIN RATE GLOBAL: ${closed.length ? ((winners.length/closed.length)*100).toFixed(1) : 0}%
PnL TOTAL: $${closed.reduce((s,t)=>s+t.pnl_usdt,0).toFixed(2)}
AVG R: ${closed.length ? (closed.reduce((s,t)=>s+t.r_final,0)/closed.length).toFixed(2) : 0}R

SCORE PROMEDIO — Ganadores: ${avgScoreWin} | Perdedores: ${avgScoreLoss}

PERFORMANCE POR PAR:
${symbolStats.map(s => `${s.symbol}: ${s.wins}W/${s.losses}L WR=${s.wr}% PnL=$${s.pnl} avgScore=${s.avgScore} avgR=${s.avgR}R`).join('\n')}

PERFORMANCE POR HORA UTC (mejores primero):
${hourStats.slice(0,8).map(h => `${String(h.hour).padStart(2,'0')}:00 — ${h.wins}W/${h.losses}L WR=${h.wr.toFixed(0)}% PnL=$${h.pnl.toFixed(2)}`).join('\n')}

PERFORMANCE POR TRAILING STAGE AL CIERRE:
${Object.entries(byStage).map(([s,d])=>`${s}: ${d.wins}W/${d.losses}L PnL=$${d.pnl.toFixed(2)}`).join('\n')}

PERFORMANCE POR RÉGIMEN AI:
${Object.entries(byRegime).map(([r,d])=>`${r}: ${d.wins}W/${d.losses}L PnL=$${d.pnl.toFixed(2)}`).join('\n')}

RAZONES DE RECHAZO TOP:
${rejections.map(r=>`"${r.skip_reason}" — ${r.count}x`).join('\n')}

CÓDIGO ACTUAL DEL SCORING (resumen):
- TREND: EMA8>EMA21(+15) + EMA stack(+25) + EMA spread>1%(+5) = max 45pts
- RSI: 55-70(+20) / 70+(+8) / 50-55(+10) = max 20pts por lado
- VOLUME: >=2x(+15) / >=1.5x(+10) / >=1.2x(+6) / >=0.8(+2) = max 15pts
- VWAP: diff>0.5%(+15) / diff>0.1%(+8) / neutral(+3) = max 15pts
- FUNDING: >0.0005(+10) / >0.0001(+5) = max 10pts
- ATR penalty: >8%(x0.5) / >5%(x0.75)
- Umbral mínimo: 45pts para pasar a AI

FILTROS AI ACTUALES:
- rsiDangerous: SHORT con RSI<30, LONG con RSI>70
- volumeSpike: volRatio>4x bloquea
- rangingBlock: RANGING y score<65
- biasAligns: AI bias debe coincidir con dirección

Responde en español con este formato EXACTO:

🧠 ANÁLISIS SEMANAL PROFUNDO — ${weekStart} → ${weekEnd}

📊 RESUMEN EJECUTIVO
[3-4 líneas con conclusiones clave basadas en números]

🏆 MEJORES PATRONES DETECTADOS
[Top 3 patrones que generan ganancias con datos exactos]

🚨 PROBLEMAS CRÍTICOS
[Top 3 problemas con números específicos]

⚙️ AJUSTES DE SCORING RECOMENDADOS
[Cambios exactos al algoritmo. Ej: "Aumentar peso VWAP de 15 a 20pts porque trades con vwapDiff>0.5% tienen WR=80%"]

🕐 OPTIMIZACIÓN DE HORARIOS
[Horas a priorizar y horas a evitar con datos]

💎 MEJORES PARES
[Qué pares incluir/excluir y por qué con datos]

🎯 CALIBRACIÓN DE TRAILING
[Si los stages están bien calibrados o necesitan ajuste]

🤖 AJUSTES DE FILTROS AI
[Qué filtros están bloqueando demasiado o muy poco]

📋 PLAN DE ACCIÓN SEMANA SIGUIENTE
[Lista ordenada por impacto de los 5 cambios más importantes con valores exactos]`;

// ── 4. Llamar a Claude Opus ───────────────────────────────────────────────────
let analysis = 'Error generando análisis';
try {
  const resp = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    }),
    json: false
  });
  const body = typeof resp === 'string' ? JSON.parse(resp) : resp;
  if (!body?.error) {
    analysis = body?.content?.[0]?.text || 'Sin respuesta';
  } else {
    analysis = 'API Error: ' + JSON.stringify(body.error);
  }
} catch(e) {
  analysis = 'Error: ' + e.message;
}

return [{ json: { text: analysis } }];
```

---

**En n8n el flujo es idéntico para ambos:**
```
Schedule Trigger
    ↓
Daily Analysis Report / Weekly Deep Analysis (código arriba)
    ↓
Telegram (mismo chat, parse_mode: Markdown desactivado)
```

---
const crypto = require('crypto');
const API_KEY    = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
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

// ────────────────────────────────────────────────────────────────────────────────
// FIX #2: Panic Mode — permitir longs en pánico extremo (Fear < 15)
// ────────────────────────────────────────────────────────────────────────────────
const panicMode = dailyPnLPct < -5; // Trigger si el día está rojo (opcional, o usa otro criterio)
const minScoreForPanicLong = 90; // Longs en pánico SOLO si score >= 90

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
    sessionBlock:     null,
    // FIX #2: Añadir flags de panic mode
    panicMode,
    minScoreForPanicLong
  }
}];

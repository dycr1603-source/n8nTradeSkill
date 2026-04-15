const crypto = require('crypto');
const API_KEY = process.env.BINANCE_API_KEY || 'YOUR_BINANCE_API_KEY';
const API_SECRET = process.env.BINANCE_API_SECRET || 'YOUR_BINANCE_API_SECRET';
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
const isTradFiAgreementError = (error) => {
  const msg = String(error?.message || error || '');
  return msg.includes('"code":-4411') || msg.toLowerCase().includes('tradfi-perps agreement');
};
const buildTradFiBlockedPayload = (exchangeErrorMessage) => ([{
  json: {
    ...d,
    success: false,
    blocked: true,
    blockReason: 'Binance exige firmar el contrato TradFi-Perps (code -4411) antes de abrir esta operación.',
    exchangeError: String(exchangeErrorMessage || ''),
    logs
  }
}]);

log(`Starting: ${symbol} ${side} qty=${qty} lev=${leverage}`);

// ── PROTECCIÓN CONTRA RE-ENTRADA ──────────────────────────────────────────────
// Verificar en Binance que no existe ya una posición abierta en este símbolo
try{
  const posRisk = await this.helpers.httpRequest({
    method: 'GET',
    url: `${BASE}/fapi/v2/positionRisk?${sign({ symbol })}`,
    headers: {'X-MBX-APIKEY': API_KEY},
    json: true
  });
  const arr = Array.isArray(posRisk) ? posRisk : [posRisk];
  const existing = arr.find(p => {
    if(p.symbol !== symbol) return false;
    const amt = Math.abs(parseFloat(p.positionAmt || 0));
    return amt > 0;
  });
  if(existing){
    const existingSize = Math.abs(parseFloat(existing.positionAmt));
    const existingSide = parseFloat(existing.positionAmt || 0) >= 0 ? 'LONG' : 'SHORT';
    log(`⛔ RE-ENTRADA BLOQUEADA: ${symbol} ya tiene posición abierta (${existingSide}, size=${existingSize}, entry=${existing.entryPrice})`);
    return [{
      json: {
        ...d,
        success:  false,
        blocked:  true,
        blockReason: `Ya existe posición abierta en ${symbol} (${existingSide}, size=${existingSize} @ $${existing.entryPrice})`,
        logs
      }
    }];
  }
  log(`Position check OK — ${symbol} sin posición abierta`);
}catch(e){
  // Si falla la verificación, bloquear por seguridad para evitar duplicados
  log(`⛔ Position check error (bloqueado por seguridad): ${e.message}`);
  return [{
    json: {
      ...d,
      success: false,
      blocked: true,
      blockReason: `No se pudo validar posición abierta en ${symbol}: ${e.message}`,
      logs
    }
  }];
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
try{
  await req.call(this, 'POST', '/fapi/v1/leverage', { symbol, leverage });
  log('Leverage set');
}catch(e){
  if(isTradFiAgreementError(e)){
    log('⛔ Binance bloquea la operación: falta firmar contrato TradFi-Perps (code -4411)');
    return buildTradFiBlockedPayload(e.message);
  }
  throw e;
}

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
let order;
try{
  order = await req.call(this, 'POST', '/fapi/v1/order', {
    symbol, side, type:'MARKET', quantity:adjQty, positionSide
  });
}catch(e){
  if(isTradFiAgreementError(e)){
    log('⛔ Binance bloquea la operación: falta firmar contrato TradFi-Perps (code -4411)');
    return buildTradFiBlockedPayload(e.message);
  }
  throw e;
}
log(`Market order OK orderId=${order.orderId}`);


// ── CONFIRM POSITION ──────────────────────────────────────────────────────────
let positionSize = adjQty;
for(let i = 0; i < 5; i++){
  await new Promise(r => setTimeout(r, 2000));
  const pos = await req.call(this, 'GET', '/fapi/v2/positionRisk', { symbol });
  const arr = Array.isArray(pos) ? pos : [pos];
  const p = arr.find(x => {
    if(x.symbol !== symbol) return false;
    return Math.abs(parseFloat(x.positionAmt || 0)) > 0;
  });
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

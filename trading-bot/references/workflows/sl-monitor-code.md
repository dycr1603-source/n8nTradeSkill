# Código Completo — SL Monitor

## Leer Estado

```javascript
const state = $getWorkflowStaticData('global');
return [{ json: { positions: state.positions || {} } }];
```

---

## Guardar Estado

```javascript
const state = $getWorkflowStaticData('global');
const d = $input.first().json.body || $input.first().json;

if (!state.positions) state.positions = {};

// Preservar bestPrice existente si no viene en el payload
const existingBestPrice = state.positions[d.symbol]?.bestPrice || null;

state.positions[d.symbol] = {
  positionSide: d.positionSide,
  slPrice:      d.slPrice,
  qty:          d.qty,
  side:         d.side,
  entryPrice:   d.entryPrice  || null,
  initialSL:    d.initialSL   || d.slPrice,
  stage:        d.stage       || 'INITIAL',
  tp:           d.tp          || null,
  leverage:     d.leverage    || null,
  finalScore:   d.finalScore  || null,
  openedAt:     d.openedAt    || Date.now(),
  aiRegime:     d.aiRegime    || 'N/A',
  bestPrice:    d.bestPrice   || existingBestPrice  // ← preserva el bestPrice acumulado
};

console.log(`Estado actualizado: ${JSON.stringify(state.positions[d.symbol])}`);
return [{ json: { ok: true, positions: state.positions } }];
```

---

## Reset Estado

```javascript
const state = $getWorkflowStaticData('global');
state.positions = {};
console.log('Estado reseteado completamente');
return [{ json: { ok: true, message: 'Estado limpiado', positions: {} } }];
```

---

## SL Monitor Code

```javascript
const API_KEY    = 'YOUR_BINANCE_API_KEY';
const API_SECRET = 'YOUR_BINANCE_API_SECRET';
const BASE       = 'https://fapi.binance.com';
const DASHBOARD  = 'http://18.228.14.96:3001';
const crypto     = require('crypto');
const state      = $getWorkflowStaticData('global');

if(!state.positions || Object.keys(state.positions).length === 0){
  return [{ json: { status: 'no_positions_active' } }];
}

function sign(params){
  const query = Object.entries({ ...params, timestamp: Date.now(), recvWindow: 60000 })
    .map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return query + '&signature=' + crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

function esc(v){ return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildCloseMessage(symbol, pos, exitPrice, reason, pnl, rFinal, durationMinutes, extraNote=''){
  const dir     = pos.positionSide === 'SHORT' ? '🔴 SHORT' : '🟢 LONG';
  const ts      = new Date().toISOString().replace('T',' ').slice(0,19) + ' UTC';
  const durTxt  = durationMinutes < 60
    ? `${durationMinutes}m`
    : `${Math.floor(durationMinutes/60)}h ${durationMinutes%60}m`;
  const pnlSign = pnl >= 0 ? '+' : '';
  const pnlPct  = pos.entryPrice > 0
    ? ((pnl / (pos.entryPrice * pos.qty)) * 100).toFixed(2)
    : '0.00';
  const reasonMap = {
    TP:       { emoji:'🎯', label:'Take Profit Alcanzado',     color:'✅' },
    SL:       { emoji:'🛑', label:'Stop Loss Ejecutado',       color:'❌' },
    TIME_EXIT:{ emoji:'⏱', label:'Cierre por Tiempo (20h)',   color:'⚠️' },
  };
  const r = reasonMap[reason] || { emoji:'⚪', label:reason, color:'—' };
  const stageMap = {
    INITIAL:'Initial', BREAKEVEN:'Breakeven ⚖',
    TIME_LOCK:'Time Lock ⏰', LOCK:'Lock 🔒', TRAILING:'Trailing 🎯'
  };
  const stage    = pos.stage || 'INITIAL';
  const pnlEmoji = pnl >= 0 ? '💚' : '🔴';

  return [
    '━━━━━━━━━━━━━━━━━━━━━━━',
    `${r.emoji} TRADE CERRADO — ${r.color} ${r.label}`,
    extraNote ? `   ${extraNote}` : null,
    '━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `${dir}   💎 ${esc(symbol)}`,
    `⏰ ${ts}`,
    '',
    '─── RESULTADO ───',
    `  ${pnlEmoji} PnL      : ${pnlSign}$${Math.abs(pnl).toFixed(2)}   (${pnlSign}${pnlPct}%)`,
    `  R final  : ${rFinal >= 0 ? '+' : ''}${rFinal}R`,
    `  Duración : ${durTxt}`,
    `  Stage    : ${stageMap[stage] || stage}`,
    '',
    '─── PRECIOS ───',
    `  Entry    : $${esc(pos.entryPrice)}`,
    `  Exit     : $${esc(exitPrice)}`,
    `  SL era   : $${esc(pos.slPrice)}`,
    `  TP era   : $${esc(pos.tp || 'N/A')}`,
    '',
    '─── POSICION ───',
    `  Qty      : ${esc(pos.qty)}`,
    `  Leverage : ${esc(pos.leverage || '—')}x`,
    `  SL ini   : $${esc(pos.initialSL || pos.slPrice)}`,
    `  Score AI : ${esc(pos.finalScore || '—')}/100`,
    '━━━━━━━━━━━━━━━━━━━━━━━'
  ].filter(l => l !== null).join('\n');
}

async function closeDashboard(symbol, reason, price){
  try{
    await this.helpers.httpRequest({
      method: 'DELETE',
      url: `${DASHBOARD}/trade/${symbol}?reason=${reason}&exitPrice=${price}`,
      json: true
    });
    console.log(`Dashboard: ${symbol} cerrado (${reason}) @ ${price}`);
  }catch(e){ console.log(`Dashboard close error ${symbol}: ${e.message}`); }
}

async function closeDB(symbol, pos, exitPrice, reason){
  try{
    const pnl = pos.positionSide === 'SHORT'
      ? (pos.entryPrice - exitPrice) * pos.qty
      : (exitPrice - pos.entryPrice) * pos.qty;
    const initialSL   = pos.initialSL || pos.slPrice;
    const initialRisk = Math.abs(pos.entryPrice - initialSL);
    const rFinal = initialRisk > 0
      ? +((Math.abs(exitPrice - pos.entryPrice) / initialRisk) * (pnl >= 0 ? 1 : -1)).toFixed(2)
      : 0;
    const durationMinutes = pos.openedAt
      ? Math.floor((Date.now() - pos.openedAt) / 60000)
      : null;
    await this.helpers.httpRequest({
      method: 'POST', url: `${DASHBOARD}/db/trade/close`, json: true,
      body: {
        symbol, exitPrice,
        pnlUsdt:        +pnl.toFixed(2),
        pnlPct:         +((pnl / (pos.entryPrice * pos.qty)) * 100).toFixed(3),
        rFinal,
        closeReason:    reason,
        trailingStage:  pos.stage || 'INITIAL',
        durationMinutes
      }
    });
    console.log(`DB: trade cerrado ${symbol} pnl=${pnl.toFixed(2)} reason=${reason}`);
    return { pnl: +pnl.toFixed(2), rFinal, durationMinutes };
  }catch(e){
    console.log(`DB close error ${symbol}: ${e.message}`);
    return { pnl: 0, rFinal: 0, durationMinutes: 0 };
  }
}

async function notifyCB(event, positionSide, symbol){
  try{
    await this.helpers.httpRequest({
      method: 'POST', url: `${DASHBOARD}/cb/${event}`, json: true,
      body: { direction: positionSide, symbol }
    });
    console.log(`[CB] ${event.toUpperCase()} notificado: ${symbol} ${positionSide}`);
  }catch(e){ console.log(`[CB] notify error: ${e.message}`); }
}

async function setCooldown(symbol, minutes){
  try{
    await this.helpers.httpRequest({
      method: 'POST', url: `${DASHBOARD}/cooldown/set`, json: true,
      body: { symbol, minutes }
    });
    console.log(`[Cooldown] ${symbol} pausado ${minutes}min tras cierre`);
  }catch(e){ console.log(`[Cooldown] set error ${symbol}: ${e.message}`); }
}

async function updateSLDashboard(symbol, newSL){
  try{
    await this.helpers.httpRequest({
      method: 'POST', url: `${DASHBOARD}/db/trade/update-sl`, json: true,
      body: { symbol, newSL }
    });
  }catch(e){ console.log(`[SL Update] DB error ${symbol}: ${e.message}`); }
}

// ── Gestión profesional de tiempo en pérdida ──────────────────────────────────
// Reglas moderadas:
// 6h  en pérdida sin tocar BE → mover SL 30% más cerca
// 12h en pérdida sin tocar BE → mover SL 50% más cerca
// 20h en pérdida sin tocar BE → cierre forzado
function calcTimeSLAdjustment(pos, currentPrice, hoursOpen){
  const stage = pos.stage || 'INITIAL';

  // Solo aplica en stage INITIAL — si ya movió a BE o mejor, no tocar
  if(stage !== 'INITIAL') return null;

  const isLong  = pos.positionSide === 'LONG';
  const entry   = pos.entryPrice;
  const slOrig  = pos.initialSL || pos.slPrice;
  const slDist  = Math.abs(entry - slOrig);

  // Verificar si está en pérdida ahora mismo
  const inLoss = isLong
    ? currentPrice < entry
    : currentPrice > entry;

  if(!inLoss) return null; // en ganancia → no aplicar

  // Verificar si alguna vez tocó ganancia (si sí, el trailing ya debería haber actuado)
  const bestPrice = pos.bestPrice || entry;
  const everInProfit = isLong
    ? bestPrice > entry * 1.001  // tocó al menos 0.1% de ganancia
    : bestPrice < entry * 0.999;

  if(everInProfit) return null; // ya tuvo profit → no aplicar estas reglas

  if(hoursOpen >= 20){
    return { action: 'FORCE_CLOSE', reason: 'TIME_EXIT', note: '20h en pérdida sin recuperación' };
  }

  if(hoursOpen >= 12){
    // Mover SL 50% más cerca del entry
    const newSLDist = slDist * 0.50;
    const newSL = isLong
      ? +(entry - newSLDist).toFixed(4)
      : +(entry + newSLDist).toFixed(4);

    // Solo mover si es más restrictivo que el SL actual
    const shouldMove = isLong
      ? newSL > pos.slPrice
      : newSL < pos.slPrice;

    if(shouldMove){
      return { action: 'MOVE_SL', newSL, note: `12h en pérdida → SL movido 50% más cerca ($${newSL})` };
    }
  }

  if(hoursOpen >= 6){
    // Mover SL 30% más cerca del entry
    const newSLDist = slDist * 0.70; // 70% de la distancia original = 30% más cerca
    const newSL = isLong
      ? +(entry - newSLDist).toFixed(4)
      : +(entry + newSLDist).toFixed(4);

    const shouldMove = isLong
      ? newSL > pos.slPrice
      : newSL < pos.slPrice;

    if(shouldMove){
      return { action: 'MOVE_SL', newSL, note: `6h en pérdida → SL movido 30% más cerca ($${newSL})` };
    }
  }

  return null;
}

const results = [];

for(const symbol of Object.keys(state.positions)){
  const pos = state.positions[symbol];
  const { positionSide, slPrice, qty, side } = pos;

  try{
    const posRisk = await this.helpers.httpRequest({
      method: 'GET',
      url: `${BASE}/fapi/v2/positionRisk?${sign({ symbol })}`,
      headers: { 'X-MBX-APIKEY': API_KEY },
      json: true
    });

    const arr       = Array.isArray(posRisk) ? posRisk : [posRisk];
    const activePos = arr.find(p =>
      p.symbol === symbol &&
      p.positionSide === positionSide &&
      Math.abs(parseFloat(p.positionAmt)) > 0
    );

    // ── Cerrada externamente (TP hit) ─────────────────────────────────────────
    if(!activePos){
      console.log(`${symbol} cerrada externamente → removiendo estado`);

      let exitPrice = pos.tp || pos.entryPrice;
      try{
        const t = await this.helpers.httpRequest({
          method: 'GET', url: `${BASE}/fapi/v1/ticker/price?symbol=${symbol}`, json: true
        });
        if(!pos.tp) exitPrice = parseFloat(t.price);
      }catch(e){}

      await closeDashboard.call(this, symbol, 'tp', exitPrice);
      const { pnl, rFinal, durationMinutes } = await closeDB.call(this, symbol, pos, exitPrice, 'TP');
      await notifyCB.call(this, 'tp', positionSide, symbol);
      await setCooldown.call(this, symbol, 30);

      const telegramText = buildCloseMessage(symbol, pos, exitPrice, 'TP', pnl, rFinal, durationMinutes);
      delete state.positions[symbol];
      results.push({ symbol, status:'position_closed_externally', exitPrice, pnl, rFinal, telegramText });
      continue;
    }

    // ── Precio actual ─────────────────────────────────────────────────────────
    const ticker = await this.helpers.httpRequest({
      method: 'GET', url: `${BASE}/fapi/v1/ticker/price?symbol=${symbol}`, json: true
    });
    const price = parseFloat(ticker.price);

    // ── Actualizar mejor precio visto ─────────────────────────────────────────
    const isLong = positionSide === 'LONG';
    if(!pos.bestPrice) pos.bestPrice = pos.entryPrice;
    if(isLong && price > pos.bestPrice)  pos.bestPrice = price;
    if(!isLong && price < pos.bestPrice) pos.bestPrice = price;

    // ── Calcular tiempo abierto ───────────────────────────────────────────────
    const hoursOpen = pos.openedAt
      ? (Date.now() - pos.openedAt) / 3600000
      : 0;

    const slTriggered = positionSide === 'SHORT' ? price >= slPrice : price <= slPrice;
    console.log(`${symbol} price=${price} sl=${slPrice} stage=${pos.stage||'INITIAL'} triggered=${slTriggered} hoursOpen=${hoursOpen.toFixed(1)}h`);

    if(slTriggered){
      // ── Ejecutar cierre por SL ────────────────────────────────────────────
      const closeOrder = await this.helpers.httpRequest({
        method: 'POST',
        url: `${BASE}/fapi/v1/order?${sign({ symbol, side, type:'MARKET', quantity:qty, positionSide })}`,
        headers: { 'X-MBX-APIKEY': API_KEY },
        json: true
      });

      try{
        await this.helpers.httpRequest({
          method: 'DELETE',
          url: `${BASE}/fapi/v1/allOpenOrders?${sign({ symbol })}`,
          headers: { 'X-MBX-APIKEY': API_KEY },
          json: true
        });
      }catch(e){ console.log(`Cancel orders error ${symbol}: ${e.message}`); }

      await closeDashboard.call(this, symbol, 'sl', price);
      const { pnl, rFinal, durationMinutes } = await closeDB.call(this, symbol, pos, price, 'SL');

      const stage      = pos.stage || 'INITIAL';
      const isRealLoss = stage === 'INITIAL' && pnl < 0;

      if(isRealLoss){
        await notifyCB.call(this, 'sl', positionSide, symbol);
      } else {
        await notifyCB.call(this, 'tp', positionSide, symbol);
      }

      const cooldownMins = isRealLoss ? 15 : 30;
      await setCooldown.call(this, symbol, cooldownMins);

      const telegramText = buildCloseMessage(symbol, pos, price, 'SL', pnl, rFinal, durationMinutes);
      delete state.positions[symbol];
      results.push({
        symbol, status:'SL_EXECUTED', price, slPrice,
        stage, orderId: closeOrder.orderId,
        pnl, rFinal, telegramText
      });

    } else {

      // ── Gestión por tiempo en pérdida ─────────────────────────────────────
      const timeAction = calcTimeSLAdjustment(pos, price, hoursOpen);

      if(timeAction){

        if(timeAction.action === 'FORCE_CLOSE'){
          // ── Cierre forzado por 20h en pérdida ───────────────────────────
          console.log(`[TIME_EXIT] ${symbol} — ${timeAction.note}`);

          const closeOrder = await this.helpers.httpRequest({
            method: 'POST',
            url: `${BASE}/fapi/v1/order?${sign({ symbol, side, type:'MARKET', quantity:qty, positionSide })}`,
            headers: { 'X-MBX-APIKEY': API_KEY },
            json: true
          });

          try{
            await this.helpers.httpRequest({
              method: 'DELETE',
              url: `${BASE}/fapi/v1/allOpenOrders?${sign({ symbol })}`,
              headers: { 'X-MBX-APIKEY': API_KEY },
              json: true
            });
          }catch(e){}

          await closeDashboard.call(this, symbol, 'sl', price);
          const { pnl, rFinal, durationMinutes } = await closeDB.call(this, symbol, pos, price, 'TIME_EXIT');
          await notifyCB.call(this, 'sl', positionSide, symbol);
          await setCooldown.call(this, symbol, 60); // cooldown más largo tras time exit

          const telegramText = buildCloseMessage(
            symbol, pos, price, 'TIME_EXIT', pnl, rFinal, durationMinutes,
            `⏱ ${timeAction.note}`
          );
          delete state.positions[symbol];
          results.push({
            symbol, status:'TIME_EXIT', price,
            orderId: closeOrder.orderId,
            pnl, rFinal, telegramText
          });

        } else if(timeAction.action === 'MOVE_SL'){
          // ── Mover SL más cerca ────────────────────────────────────────────
          console.log(`[TIME_SL] ${symbol} — ${timeAction.note}`);

          // Actualizar SL en estado local
          state.positions[symbol].slPrice = timeAction.newSL;

          // Actualizar en DB para que quede registrado
          await updateSLDashboard.call(this, symbol, timeAction.newSL);

          results.push({
            symbol,
            status:    'TIME_SL_ADJUSTED',
            price,
            oldSL:     slPrice,
            newSL:     timeAction.newSL,
            hoursOpen: +hoursOpen.toFixed(1),
            note:      timeAction.note,
            telegramText: [
              '━━━━━━━━━━━━━━━━━━━━━━━',
              `⏱ SL AJUSTADO POR TIEMPO`,
              '━━━━━━━━━━━━━━━━━━━━━━━',
              `💎 ${symbol}   ${isLong ? '🟢 LONG' : '🔴 SHORT'}`,
              ``,
              `  ${timeAction.note}`,
              `  SL anterior : $${slPrice}`,
              `  SL nuevo    : $${timeAction.newSL}`,
              `  Precio act  : $${price}`,
              `  Entry       : $${pos.entryPrice}`,
              `  Tiempo      : ${Math.floor(hoursOpen)}h ${Math.round((hoursOpen%1)*60)}m`,
              '━━━━━━━━━━━━━━━━━━━━━━━'
            ].join('\n')
          });
        }

      } else {
        // ── Monitoreo normal ──────────────────────────────────────────────
        const diff = positionSide === 'SHORT'
          ? (slPrice - price).toFixed(4)
          : (price - slPrice).toFixed(4);
        results.push({
          symbol, status:'monitoring', price, slPrice,
          positionSide, stage: pos.stage||'INITIAL',
          entryPrice: pos.entryPrice||null, diff,
          hoursOpen: +hoursOpen.toFixed(1),
          telegramText: null
        });
      }
    }

  }catch(err){
    results.push({ symbol, status:'error', message:err.message, telegramText:null });
  }
}

return results.map(r => ({ json: r }));
```

---

## Post-Trade Agent

```javascript
const ANTHROPIC_KEY = 'YOUR_ANTHROPIC_API_KEY';
const DASHBOARD     = 'http://18.228.14.96:3001';

const t = $input.first().json;

// Solo analizar cierres reales
if(!t.telegramText || t.status === 'monitoring' || t.status === 'no_positions_active'){
  return [{ json: { skipped: true, reason: 'no close event' } }];
}

const symbol    = t.symbol;
const pnl       = t.pnl || 0;
const rFinal    = t.rFinal || 0;
const stage     = t.stage || 'INITIAL';
const isLoss    = pnl < 0;
const closeType = t.status === 'SL_EXECUTED' ? 'SL' : 'TP';

// ── Obtener contexto del trade desde DB ───────────────────────────────────────
let tradeData = {};
try{
  const stats  = await this.helpers.httpRequest({ method:'GET', url:`${DASHBOARD}/db/stats`, json:true });
  const recent = stats.recent || [];
  const trade  = recent.find(r => r.symbol === symbol && r.status === 'CLOSED' && r.pnl_usdt != null);
  if(trade) tradeData = trade;
}catch(e){ console.log('DB context error:', e.message); }

// ── Construir prompt ──────────────────────────────────────────────────────────
const durationTxt = t.durationMinutes
  ? t.durationMinutes < 60
    ? `${t.durationMinutes} minutos`
    : `${Math.floor(t.durationMinutes/60)}h ${t.durationMinutes%60}m`
  : 'desconocida';

const prompt = `Eres un trader experto analizando un trade que acaba de cerrar. Sé específico y directo — sin frases genéricas.

TRADE CERRADO:
- Símbolo: ${symbol}
- Dirección: ${t.positionSide || tradeData.direction || 'N/A'}
- Entry: $${t.entryPrice || tradeData.entry_price || 'N/A'}
- Exit: $${t.price || t.exitPrice || 'N/A'}
- PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
- R final: ${rFinal >= 0 ? '+' : ''}${rFinal}R
- Cierre por: ${closeType}
- Stage al cierre: ${stage}
- Duración: ${durationTxt}
- Score AI: ${tradeData.final_score || 'N/A'}/100
- Régimen AI: ${tradeData.ai_regime || 'N/A'}
- Bias AI: ${tradeData.ai_bias || 'N/A'}
- Vision state: ${tradeData.vision_state || 'N/A'}

INDICADORES AL ENTRAR:
- RSI: ${tradeData.rsi14 || 'N/A'}
- Vol ratio: ${tradeData.vol_ratio || 'N/A'}x
- ATR%: ${tradeData.atr_pct || 'N/A'}%
- Funding: ${tradeData.funding_rate || 'N/A'}

RESULTADO: ${isLoss ? '❌ PÉRDIDA' : '✅ GANANCIA'} en stage ${stage}

${isLoss
  ? `ANÁLISIS DE FALLO — responde con precisión quirúrgica:
1. ¿Cuál fue la causa principal? (timing, dirección equivocada, SL muy ajustado, contra-tendencia, etc.)
2. ¿Qué indicador daba señal de alerta que se ignoró?
3. ¿Qué cambio concreto evitaría este trade o mejoraría el resultado?`
  : `ANÁLISIS DE ÉXITO — identifica qué funcionó:
1. ¿Qué factor fue el más determinante del éxito?
2. ¿Se puede replicar esta configuración? ¿Qué condiciones específicas se daban?
3. ¿Se salió en el momento óptimo o había más recorrido?`}

Responde en español en máximo 4 líneas totales. Sé concreto con números cuando sea relevante.`;

// ── Llamar a Claude Haiku ─────────────────────────────────────────────────────
let analysis = 'Sin análisis disponible';
try{
  const resp = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages:   [{ role: 'user', content: prompt }]
    }),
    json: false
  });
  const body = typeof resp === 'string' ? JSON.parse(resp) : resp;
  if(!body?.error) analysis = body?.content?.[0]?.text?.trim() || analysis;
  else analysis = 'Error API: ' + JSON.stringify(body.error);
}catch(e){ analysis = 'Error: ' + e.message; }

// ── Guardar en DB ─────────────────────────────────────────────────────────────
try{
  await this.helpers.httpRequest({
    method: 'POST',
    url: `${DASHBOARD}/db/post-trade`,
    json: true,
    body: {
      symbol,
      direction: t.positionSide || null,
      closeType,
      stage,
      pnl,
      rFinal,
      durationMinutes: t.durationMinutes || null,
      analysis
    }
  });
  console.log(`[PostTrade] DB guardado: ${symbol} ${closeType}`);
}catch(e){ console.log(`[PostTrade] DB error: ${e.message}`); }

// ── Construir mensaje Telegram ────────────────────────────────────────────────
const resultEmoji = isLoss ? '🔍' : '✨';
const pnlStr      = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2);
const rStr        = (rFinal >= 0 ? '+' : '') + rFinal + 'R';
const stageMap    = {
  INITIAL:'Initial', BREAKEVEN:'Breakeven ⚖',
  TIME_LOCK:'Time Lock ⏰', LOCK:'Lock 🔒', TRAILING:'Trailing 🎯'
};

const text = [
  `━━━━━━━━━━━━━━━━━━━`,
  `${resultEmoji} POST-TRADE ANALYSIS`,
  `━━━━━━━━━━━━━━━━━━━`,
  ``,
  `${symbol} ${t.positionSide||''} ${isLoss ? '❌' : '✅'} ${closeType}`,
  `PnL: ${pnlStr}  R: ${rStr}  Stage: ${stageMap[stage]||stage}`,
  `Duración: ${durationTxt}`,
  ``,
  `${isLoss ? '🔎 ¿Qué falló?' : '🎯 ¿Qué funcionó?'}`,
  analysis,
  `━━━━━━━━━━━━━━━━━━━`
].join('\n');

console.log(`[PostTrade] ${symbol} ${closeType} pnl=${pnlStr} done`);

return [{ json: { text, symbol, pnl, rFinal, closeType, stage, analysis } }];
```

---
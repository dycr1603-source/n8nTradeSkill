const API_KEY = process.env.BINANCE_API_KEY || 'YOUR_BINANCE_API_KEY';
const API_SECRET = process.env.BINANCE_API_SECRET || 'YOUR_BINANCE_API_SECRET';
const BASE       = 'https://fapi.binance.com';
const DASHBOARD  = process.env.INTERNAL_DASHBOARD_BASE || 'http://127.0.0.1:3001';
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

function matchesTrackedPosition(p, symbol, trackedSide){
  if(!p || p.symbol !== symbol) return false;
  const amt = parseFloat(p.positionAmt || 0);
  if(!Number.isFinite(amt) || Math.abs(amt) <= 0) return false;
  const inferredSide = amt > 0 ? 'LONG' : 'SHORT';
  if(p.positionSide === trackedSide) return true; // hedge mode
  if((p.positionSide === 'BOTH' || !p.positionSide) && inferredSide === trackedSide) return true; // one-way mode
  return false;
}

function buildCloseOrderParams(symbol, side, qty, trackedSide, activePos){
  const params = { symbol, side, type:'MARKET', quantity:qty };
  // En hedge mode debemos enviar positionSide, en one-way NO.
  if(activePos && activePos.positionSide && activePos.positionSide !== 'BOTH'){
    params.positionSide = trackedSide;
  }
  return params;
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
    const activePos = arr.find(p => matchesTrackedPosition(p, symbol, positionSide));

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
      await setCooldown.call(this, symbol, 60);

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
        url: `${BASE}/fapi/v1/order?${sign(buildCloseOrderParams(symbol, side, qty, positionSide, activePos))}`,
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

      const cooldownMins = 60;
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
            url: `${BASE}/fapi/v1/order?${sign(buildCloseOrderParams(symbol, side, qty, positionSide, activePos))}`,
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

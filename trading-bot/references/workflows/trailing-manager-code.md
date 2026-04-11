# Código Completo — Trailing Manager

## Trailing Manager Code

```javascript
const crypto = require('crypto');
const API_KEY    = 'YOUR_BINANCE_API_KEY';
const API_SECRET = 'YOUR_BINANCE_API_SECRET';
const BASE       = 'https://fapi.binance.com';
const SL_GET     = 'http://18.228.14.96:5678/webhook/sl-monitor-get';
const SL_SET     = 'http://18.228.14.96:5678/webhook/sl-monitor-set';
const DASHBOARD  = 'http://18.228.14.96:3001';

const R_BREAKEVEN = 1.0;
const R_LOCK      = 1.5;
const R_TRAIL     = 2.0;
const MIN_MOVE    = 0.003;
const ATR_MULT    = 1.0;
const ATR_PERIOD  = 14;

const TIME_RULES = [
  { h:4,  pct:0.015, keep:0.30, label:'4h +1.5% → asegura 30%'  },
  { h:6,  pct:0.020, keep:0.45, label:'6h +2.0% → asegura 45%'  },
  { h:8,  pct:0.020, keep:0.55, label:'8h +2.0% → asegura 55%'  },
  { h:12, pct:0.015, keep:0.65, label:'12h +1.5% → asegura 65%' },
  { h:16, pct:0.010, keep:0.75, label:'16h +1.0% → asegura 75%' },
  { h:24, pct:0.005, keep:0.85, label:'24h +0.5% → asegura 85%' },
];

function sign(params){
  const query=Object.entries({...params,timestamp:Date.now(),recvWindow:60000})
    .map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
  return query+'&signature='+crypto.createHmac('sha256',API_SECRET).update(query).digest('hex');
}
function precision(v){
  const s=v.toString();
  if(!s.includes('.'))return 0;
  return s.split('.')[1].replace(/0+$/,'').length;
}
function roundTick(val,tick){
  return Number((Math.round(val/tick)*tick).toFixed(precision(tick)));
}
function calcATR(klines){
  const trs=[];
  for(let i=1;i<klines.length;i++){
    const h=parseFloat(klines[i][2]),l=parseFloat(klines[i][3]),pc=parseFloat(klines[i-1][4]);
    trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  if(trs.length<ATR_PERIOD)return trs.reduce((a,b)=>a+b,0)/(trs.length||1);
  let atr=trs.slice(0,ATR_PERIOD).reduce((a,b)=>a+b,0)/ATR_PERIOD;
  for(let i=ATR_PERIOD;i<trs.length;i++)atr=(atr*(ATR_PERIOD-1)+trs[i])/ATR_PERIOD;
  return atr;
}
function stageWeight(s){
  return {INITIAL:0,BREAKEVEN:1,TIME_LOCK:2,LOCK:3,TRAILING:4}[s]||0;
}
function calcTimeLockSL(positionSide,entryPrice,currentPnL,hoursOpen,currentPct,tick){
  let bestRule=null;
  for(const rule of TIME_RULES){
    if(hoursOpen>=rule.h&&currentPct>=rule.pct) bestRule=rule;
  }
  if(!bestRule)return{sl:null,rule:null};
  const preserveAmount=currentPnL*bestRule.keep;
  const sl=positionSide==='SHORT'
    ?roundTick(entryPrice-preserveAmount,tick)
    :roundTick(entryPrice+preserveAmount,tick);
  return{sl,rule:bestRule};
}
function esc(v){
  return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Reintento para SL_SET ─────────────────────────────────────────────────────
async function setSLWithRetry(helpers, url, body, maxRetries=3){
  for(let i=0; i<maxRetries; i++){
    try{
      await helpers.httpRequest({ method:'POST', url, json:true, body });
      return true;
    }catch(e){
      console.log(`[SL_SET] Intento ${i+1}/${maxRetries} falló: ${e.message}`);
      if(i < maxRetries-1) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

// ── Fetch estado ──────────────────────────────────────────────────────────────
let positions={};
try{
  const resp=await this.helpers.httpRequest({method:'GET',url:SL_GET,json:true});
  positions=resp.positions||{};
}catch(e){
  return [{json:{status:'error_reading_state',message:e.message}}];
}

if(Object.keys(positions).length===0){
  return [{json:{status:'no_positions',ts:new Date().toISOString()}}];
}

// exchangeInfo una sola vez
const exInfo=await this.helpers.httpRequest({
  method:'GET',url:`${BASE}/fapi/v1/exchangeInfo`,json:true
});

// ── Procesar todas las posiciones EN PARALELO ─────────────────────────────────
const results=await Promise.all(Object.keys(positions).map(async(symbol)=>{
  const pos=positions[symbol];
  const{positionSide,slPrice,qty,side,entryPrice,initialSL,stage}=pos;

  if(!entryPrice||!initialSL){
    return{symbol,status:'missing_entry_data',slPrice,stage,telegramText:null};
  }

  try{
    const[tickerResp,klinesResp]=await Promise.all([
      this.helpers.httpRequest({method:'GET',url:`${BASE}/fapi/v1/ticker/price?symbol=${symbol}`,json:true}),
      this.helpers.httpRequest({method:'GET',url:`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=30`,json:true})
    ]);

    const price=parseFloat(tickerResp.price);
    const atr=calcATR(klinesResp);

    const symInfo=exInfo.symbols.find(s=>s.symbol===symbol);
    const tick=parseFloat(symInfo?.filters.find(f=>f.filterType==='PRICE_FILTER')?.tickSize||'0.01');

    const initialRisk  =Math.abs(entryPrice-initialSL);
    const currentPnL   =positionSide==='SHORT'?entryPrice-price:price-entryPrice;
    const currentR     =currentPnL/initialRisk;
    const currentPct   =currentPnL/entryPrice;
    const unrealizedPnL=+(currentPnL*qty).toFixed(2);
    const pnlPct       =+((currentPnL/entryPrice)*100).toFixed(3);
    const openedAt     =pos.openedAt||Date.now();
    const hoursOpen    =(Date.now()-openedAt)/(1000*60*60);
    const minutesOpen  =Math.floor((Date.now()-openedAt)/60000);
    const currentWeight=stageWeight(stage||'INITIAL');

    let newSL=slPrice,newStage=stage||'INITIAL',reason='monitoring';
    let slChanged=false,stageLabel='',stageEmoji='';
    let candidateSL=null,candidateStage=null,candidateLabel='',candidateEmoji='';

    // ── Candidato 1: TRAILING (2R+) ──────────────────────────────────────────
    if(currentR>=R_TRAIL){
      const trailSL=positionSide==='SHORT'
        ?roundTick(price+atr*ATR_MULT,tick)
        :roundTick(price-atr*ATR_MULT,tick);
      const isBetter=positionSide==='SHORT'?trailSL<slPrice:trailSL>slPrice;
      const bigEnough=Math.abs(trailSL-slPrice)/slPrice>MIN_MOVE;
      if(isBetter&&bigEnough){
        candidateSL=trailSL;candidateStage='TRAILING';
        candidateLabel='🎯 Trailing Dinámico ATR';candidateEmoji='🎯';
        reason=`2R+ trailing ATR ${slPrice} → ${trailSL}`;
      }else{
        newStage='TRAILING';
        reason=`TRAILING activo — mov insuficiente`;
      }
    }

    // ── Candidato 2: LOCK (1.5R) ─────────────────────────────────────────────
    if(currentR>=R_LOCK&&stageWeight('LOCK')>=currentWeight){
      const lockSL=positionSide==='SHORT'
        ?roundTick(entryPrice-initialRisk*0.5,tick)
        :roundTick(entryPrice+initialRisk*0.5,tick);
      const isBetter=positionSide==='SHORT'?lockSL<slPrice:lockSL>slPrice;
      if(isBetter&&!candidateSL){
        candidateSL=lockSL;candidateStage='LOCK';
        candidateLabel='🔒 Ganancia Asegurada +0.5R';candidateEmoji='🔒';
        reason=`1.5R alcanzado: ${slPrice} → ${lockSL}`;
      }else if(!candidateSL){
        if(currentWeight<stageWeight('LOCK'))newStage='LOCK';
        reason=`ya en stage >= LOCK (${stage})`;
      }
    }

    // ── Candidato 3: TIME_LOCK ────────────────────────────────────────────────
    if(currentPct>0&&stageWeight('TIME_LOCK')>=currentWeight&&!candidateSL){
      const{sl:tlSL,rule}=calcTimeLockSL(positionSide,entryPrice,currentPnL,hoursOpen,currentPct,tick);
      if(tlSL!==null){
        const isBetter=positionSide==='SHORT'?tlSL<slPrice:tlSL>slPrice;
        const bigEnough=Math.abs(tlSL-slPrice)/(slPrice||1)>MIN_MOVE;
        if(isBetter&&bigEnough){
          candidateSL=tlSL;candidateStage='TIME_LOCK';
          candidateLabel=`⏰ Time Lock: ${rule.label}`;candidateEmoji='⏰';
          reason=`${rule.label}: ${slPrice} → ${tlSL}`;
        }else if(tlSL!==null){
          reason=`TIME_LOCK aplicable (${rule?.label}) pero SL no mejoraría`;
        }
      }
    }

    // ── Candidato 4: BREAKEVEN (1R) ───────────────────────────────────────────
    if(currentR>=R_BREAKEVEN&&newStage==='INITIAL'&&!candidateSL){
      const beSL=positionSide==='SHORT'
        ?roundTick(entryPrice*0.999,tick)
        :roundTick(entryPrice*1.001,tick);
      candidateSL=beSL;candidateStage='BREAKEVEN';
      candidateLabel='⚖️ Breakeven Activado';candidateEmoji='⚖️';
      reason=`1R alcanzado: ${slPrice} → ${beSL}`;
    }

    // ── Aplicar mejor candidato ───────────────────────────────────────────────
    if(candidateSL!==null){
      const finalIsBetter=positionSide==='SHORT'?candidateSL<slPrice:candidateSL>slPrice;
      if(finalIsBetter){
        newSL=candidateSL;newStage=candidateStage;
        stageLabel=candidateLabel;stageEmoji=candidateEmoji;
        slChanged=true;
      }else{
        reason=`Candidato ${candidateStage} no mejora SL actual`;
      }
    }

    if(!slChanged&&reason==='monitoring'){
      const nextR=currentR<R_BREAKEVEN?R_BREAKEVEN:currentR<R_LOCK?R_LOCK:R_TRAIL;
      const nextStage=currentR<R_BREAKEVEN?'BREAKEVEN':currentR<R_LOCK?'LOCK':'TRAILING';
      const timeInfo=hoursOpen<4?` | TIME_LOCK en ${(4-hoursOpen).toFixed(1)}h`:'';;
      reason=`R=${currentR.toFixed(3)} (+${(nextR-currentR).toFixed(3)} para ${nextStage}) | ${Math.floor(hoursOpen)}h | +${(currentPct*100).toFixed(2)}%${timeInfo}`;
    }

    const guaranteedPnL=slChanged
      ?+((positionSide==='SHORT'?(entryPrice-newSL):(newSL-entryPrice))*qty).toFixed(2)
      :null;

    let telegramText=null;

    if(slChanged){
      // ── 1. SL Monitor con reintento — si falla, abortar todo ─────────────
      const slSetOk = await setSLWithRetry(this.helpers, SL_SET, {
        symbol, positionSide, slPrice:newSL, qty, side,
        entryPrice, initialSL, stage:newStage,
        tp:pos.tp||null, leverage:pos.leverage||null,
        finalScore:pos.finalScore||null,
        openedAt, aiRegime:pos.aiRegime||'N/A'
      });

      if(!slSetOk){
        slChanged = false;
        reason += ' | ERROR SL_SET después de 3 intentos — dashboard NO actualizado';
        console.log(`[${symbol}] SL_SET falló 3 veces — abortando update completo`);
      } else {
        console.log(`[${symbol}] SL Monitor: ${slPrice} → ${newSL} (${newStage})`);

        // ── 2. Dashboard — solo si SL Monitor fue exitoso ─────────────────
        try{
          await this.helpers.httpRequest({
            method:'POST',url:`${DASHBOARD}/trade`,json:true,
            body:{
              symbol,side:positionSide,entryPrice,
              sl:newSL,tp:pos.tp||0,qty,
              leverage:pos.leverage||1,finalScore:pos.finalScore||0,
              openedAt,stage:newStage,initialSL,
              aiResult:{regime:pos.aiRegime||'N/A',direction_bias:positionSide}
            }
          });
        }catch(e){console.log(`[${symbol}] Dashboard error: ${e.message}`);}

        // ── 3. DB — solo si SL Monitor fue exitoso ────────────────────────
        try{
          await this.helpers.httpRequest({
            method:'POST',url:`${DASHBOARD}/db/trade/update-sl`,json:true,
            body:{symbol,newSL,stage:newStage}
          });
        }catch(e){console.log(`[${symbol}] DB error: ${e.message}`);}

        // ── 4. Telegram ───────────────────────────────────────────────────
        const dir=positionSide==='SHORT'?'🔴 SHORT':'🟢 LONG';
        const ts=new Date().toISOString().replace('T',' ').slice(0,19)+' UTC';
        const durTxt=minutesOpen<60?`${minutesOpen}m`:`${Math.floor(minutesOpen/60)}h ${minutesOpen%60}m`;
        const nextMap={
          BREAKEVEN:'Próximo: 1.5R o TIME_LOCK si el precio tarda',
          TIME_LOCK:'Próximo: 1.5R → LOCK o 2R+ → TRAILING',
          LOCK:'Próximo: 2R+ → trailing dinámico ATR',
          TRAILING:'Trailing activo — SL sigue al precio con ATR'
        };
        const be  =esc(roundTick(entryPrice*(positionSide==='SHORT'?0.999:1.001),tick));
        const lock=esc(roundTick(positionSide==='SHORT'?entryPrice-initialRisk*0.5:entryPrice+initialRisk*0.5,tick));

        telegramText=[
          `━━━━━━━━━━━━━━━━━━━`,
          `${stageEmoji} SL ACTUALIZADO — ${esc(newStage)}`,
          `━━━━━━━━━━━━━━━━━━━`,
          ``,
          `${dir}  ${esc(symbol)}`,
          `⏰ ${ts}  (abierto ${durTxt})`,
          ``,
          `📊 ${esc(stageLabel)}`,
          ``,
          `🎯 Stop Loss`,
          `├ Anterior:  ${esc(slPrice)}`,
          `└ Nuevo:     ${esc(newSL)}  ✅`,
          ``,
          `💰 Estado`,
          `├ Entry:     ${esc(entryPrice)}`,
          `├ Precio:    ${esc(price)}`,
          `├ R actual:  ${currentR.toFixed(3)}R`,
          `├ PnL:       ${unrealizedPnL>=0?'+':''}$${esc(unrealizedPnL)} (${pnlPct>=0?'+':''}${pnlPct}%)`,
          guaranteedPnL!==null?`└ Garantizado: ${guaranteedPnL>=0?'+':''}$${esc(guaranteedPnL)}`:'',
          ``,
          `📐 Niveles R`,
          `├ 1R BE:     ${be}`,
          `├ 1.5R LOCK: ${lock}`,
          `├ 2R TP:     ${esc(pos.tp||'N/A')}`,
          `├ Initial SL: ${esc(initialSL)}`,
          `└ ${esc(nextMap[newStage]||'')}`,
          `━━━━━━━━━━━━━━━━━━━`
        ].filter(l=>l!=='').join('\n');
      }
    }

    console.log(`[${symbol}] R=${currentR.toFixed(2)} stage=${newStage} ${Math.floor(hoursOpen)}h +${(currentPct*100).toFixed(2)}% | ${reason}`);

    return{
      symbol,
      status:       slChanged?'SL_UPDATED':'monitoring',
      currentR:     +currentR.toFixed(3),
      price,entryPrice,initialSL,
      initialRisk:  +initialRisk.toFixed(4),
      unrealizedPnL,pnlPct,
      hoursOpen:    +hoursOpen.toFixed(2),
      oldSL:slPrice,newSL,
      stage:newStage,
      atr:+atr.toFixed(4),
      reason,telegramText
    };

  }catch(err){
    console.log(`[${symbol}] Error: ${err.message}`);
    return{symbol,status:'error',message:err.message,telegramText:null};
  }
}));

return results.map(r=>({json:r}));
```

---
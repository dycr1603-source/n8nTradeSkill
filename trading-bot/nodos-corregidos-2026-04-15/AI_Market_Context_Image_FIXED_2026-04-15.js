const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY';

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
const openSymbols = Array.isArray(d.openSymbols) ? d.openSymbols.map(s => String(s || '').toUpperCase()) : [];
const symbolUpper = String(symbol || '').toUpperCase();

const panicMode = marketCtx.panicMode || false;
const minScoreForPanicLong = marketCtx.minScoreForPanicLong || 90;
const INTERNAL_DASHBOARD_BASE = process.env.INTERNAL_DASHBOARD_BASE || 'http://localhost:3001';

// ── BLOQUEO DURO: no analizar símbolos que ya tienen posición abierta ────────
if(openSymbols.includes(symbolUpper)){
  return [{
    json: {
      ...d,
      passAI: false,
      finalScore: 0,
      skipReason: `Símbolo ya abierto: ${symbol} — omitido para evitar reentrada`,
      dynamicThreshold: null,
      aiResult: {
        regime: 'NEUTRAL',
        direction_bias: 'NEUTRAL',
        recommended_leverage: 1,
        confidence_adjustment: -100,
        key_risk: 'symbol already open',
        reasoning: 'El símbolo ya tiene una posición abierta en Binance.'
      },
      filters: {
        symbolAlreadyOpen: true,
        visionReject: false,
        visionLate: false,
        rsiDangerous: false,
        volumeSpike: false,
        biasAligns: false,
        rangingBlock: false
      }
    }
  }];
}

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

// ── Módulo de volatilidad desaprovechada ──────────────────────────────────────
let volatilityBonus = 0;
try{
  const cdResp = await this.helpers.httpRequest({
    method: 'GET', url: `${INTERNAL_DASHBOARD_BASE}/cooldown/status`, json: true
  });
  const activeCooldowns = Object.keys(cdResp.active || {}).length;
  const atrPct = Number(indicators.atrPct || 0);
  const highVolatility = atrPct > 2.0;

  if(openCount === 0 && activeCooldowns >= 5 && highVolatility && direction === 'SHORT' && macroAlignsWithDirection){
    volatilityBonus = 8;
    console.log(`[${symbol}][IMG] Volatility bonus activado: ${activeCooldowns} cooldowns activos, ATR=${atrPct}%`);
  }
}catch(e){ console.log('[IMG] Volatility check error:', e.message); }

dynamicThreshold = Math.max(55, dynamicThreshold - volatilityBonus);

// ── Política histórica (simulador + base de datos) ───────────────────────────
const rsiNow = Number(indicators.rsi14 || 50);
const volNow = Number(indicators.volRatio || 0);
const macroRelation = macroContradictsDirection ? 'contradicts' : macroAlignsWithDirection ? 'aligns' : 'neutral';

let historyPolicyMatch = null;
let historyOverrideRelief = 0;
let historyNearThresholdSlack = 0;
const historyGuardrails = {
  maxOpenCountForOverride: 1,
  maxVolRatio: 4,
  maxRsiLong: 82,
  minRsiShort: 25,
  allowTf4hStatuses: ['CONFIRMS', 'NEUTRAL']
};

try{
  const policyResp = await this.helpers.httpRequest({
    method: 'GET',
    url: `${INTERNAL_DASHBOARD_BASE}/api/simulator/policy?limit=160&hours=8&key=aterum_policy_v1`,
    json: true
  });
  if(policyResp?.guardrails) Object.assign(historyGuardrails, policyResp.guardrails);
  const groups = Array.isArray(policyResp?.opportunityGroups) ? policyResp.opportunityGroups : [];
  historyPolicyMatch = groups.find(g =>
    g.direction === direction &&
    g.macroRelation === macroRelation &&
    g.tf4h === tf4hStatus
  ) || null;

  if(historyPolicyMatch){
    historyOverrideRelief = Math.max(0, Number(historyPolicyMatch.reliefPts || 0));
    historyNearThresholdSlack = Math.max(0, Number(historyPolicyMatch.nearThresholdSlack || 0));

    const tfOk = (historyGuardrails.allowTf4hStatuses || []).includes(tf4hStatus);
    const openOk = openCount <= Number(historyGuardrails.maxOpenCountForOverride || 1);
    const volOk = volNow < Number(historyGuardrails.maxVolRatio || 4);
    const rsiOk = direction === 'LONG'
      ? rsiNow <= Number(historyGuardrails.maxRsiLong || 82)
      : rsiNow >= Number(historyGuardrails.minRsiShort || 25);

    if(tfOk && openOk && volOk && rsiOk){
      dynamicThreshold = Math.max(55, dynamicThreshold - historyOverrideRelief);
      console.log(`[${symbol}][IMG] History policy activa: relief=${historyOverrideRelief} pts para ${direction}|${macroRelation}|4h=${tf4hStatus}`);
    } else {
      historyOverrideRelief = 0;
      historyNearThresholdSlack = 0;
      console.log(`[${symbol}][IMG] History policy no aplicada por guardrail tfOk=${tfOk} openOk=${openOk} volOk=${volOk} rsiOk=${rsiOk}`);
    }
  }
}catch(e){
  console.log(`[${symbol}][IMG] History policy error: ${e.message}`);
}

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

console.log(`[${symbol}][IMG] dynamicThreshold=${dynamicThreshold} (macro=${macroBias} 4h=${tf4hStatus} openCount=${openCount} volBonus=${volatilityBonus} panicMode=${panicMode})`);
console.log(`[${symbol}][IMG] Intelligence adj: ${intelAdjFinal} pts (signal=${intel.signal||'N/A'} conf=${intel.confidence||'N/A'} dir=${direction})`);

// ── Bloqueo macro ─────────────────────────────────────────────────────────────
const historyMacroBypass =
  historyOverrideRelief > 0 &&
  direction === 'LONG' &&
  tf4hStatus === 'CONFIRMS' &&
  openCount <= Number(historyGuardrails.maxOpenCountForOverride || 1) &&
  volNow < Number(historyGuardrails.maxVolRatio || 4) &&
  rsiNow <= Number(historyGuardrails.maxRsiLong || 82) &&
  sigScore >= Math.max(55, dynamicThreshold - Math.max(4, historyNearThresholdSlack || 0));

if(marketCtx.long_ok === false && direction === 'LONG'){
  const isPanicLong = panicMode && sigScore >= minScoreForPanicLong;
  if(!isPanicLong && !historyMacroBypass){
    return [{
      json: {
        ...d, passAI: false, finalScore: 0,
        skipReason: `Macro bloquea LONG — ${marketCtx.reason || 'contexto desfavorable'}${panicMode ? ' (panic mode pero score < ' + minScoreForPanicLong + ')' : ''}`,
        dynamicThreshold,
        aiResult: { regime:'NEUTRAL', direction_bias:'NEUTRAL', recommended_leverage:3, confidence_adjustment:-100, key_risk:'Macro block', reasoning:'Blocked by market agent' },
        slMultiplier:1.5, tpMultiplier:2.0, riskReduction:0, leverageOverride:null,
        filters: { visionReject:false, visionLate:false, rsiDangerous:false, volumeSpike:false, biasAligns:false, rangingBlock:false }
      }
    }];
  }
  if(historyMacroBypass) console.log(`[${symbol}][IMG] ✅ History bypass habilita LONG bloqueado por macro`);
  if(isPanicLong) console.log(`[${symbol}][IMG] ✅ PANIC LONG PERMITTED: score=${sigScore} >= ${minScoreForPanicLong}`);
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

// ── FIX RSI: subido de 75 a 82 para LONG, mantenido 25 para SHORT ─────────────
const rsiDangerous = (direction === 'SHORT' && rsi < 25) || (direction === 'LONG' && rsi > 82);
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

// ── FIX LATE_TREND gate: score>=90+vol>=1.2x OR score>=85+vol>=1.5x ───────────
const lateScore = sigScore;
const volRatio  = indicators?.volRatio || 0;
const allowLateWithGate = (lateScore >= 90 && volRatio >= 1.2) || (lateScore >= 85 && volRatio >= 1.5);
const lateTrendBlocks   = visionLate && !(direction === 'SHORT' && macroBias === 'BEARISH') && !allowLateWithGate;

console.log(`[${symbol}][IMG] visionLate=${visionLate} allowLateWithGate=${allowLateWithGate} (score=${lateScore} vol=${volRatio}x) lateTrendBlocks=${lateTrendBlocks}`);

// ── Contextos para el prompt ──────────────────────────────────────────────────
const visionCtx = vision.market_state
  ? `ANÁLISIS DE IMAGEN (ALTA PRIORIDAD):
- Estado del chart: ${vision.market_state}
- Imagen aprueba: ${vision.approve_trade}
- Razón visual: ${vision.reason}
${vision.market_state === 'LATE_TREND' && direction === 'SHORT' && macroBias === 'BEARISH'
  ? '⚠️ LATE_TREND pero SHORT alineado con macro BEARISH — montarse en continuación, ampliar SL 2.0x, leverage máx 3x'
  : vision.market_state === 'LATE_TREND' && allowLateWithGate
  ? '✅ LATE_TREND pero score>=85+vol>=1.5x o score>=90+vol>=1.2x — permitir con penalty -10pts'
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
- BTC 12h: ${marketCtx.btcChange || 'N/A'}% | Size multiplier: ${marketCtx.size_multiplier || 1.0}x${panicMode ? ' | PANIC MODE ACTIVO' : ''}`
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
THRESHOLD MÍNIMO PARA APROBAR: ${dynamicThreshold} pts${panicMode ? ' | PANIC MODE: longs permitidos si score >= ' + minScoreForPanicLong : ''}${volatilityCtx}

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
2. RSI > 82 en LONG = rechazar (umbral actualizado)
3. LATE_TREND en SHORT alineado con macro BEARISH = permitir con sl_multiplier 2.0, leverage máx 3x
4. LATE_TREND con score>=90+vol>=1.2x o score>=85+vol>=1.5x = permitir con penalty -10pts
5. LATE_TREND sin gate = rechazar completamente
6. 4h CONTRADICE = confidence_adjustment entre -10 y -20, leverage máx 4x
7. 4h CONFIRMA = puedes dar sl_multiplier más ajustado, más leverage
8. Score final < ${dynamicThreshold} = approve: false
9. Macro BEARISH + señal LONG = reduce confianza -15 mínimo (excepto panic mode con score>=${minScoreForPanicLong})
10. Señal NO OPERAR o conflicto de inteligencia → reducir confianza adicional

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
}catch(e){
  aiResult.reasoning = 'AI error: ' + e.message;
  aiResult.confidence_adjustment = -50;
}

// ── Score final ───────────────────────────────────────────────────────────────
const adjustment    = Number(aiResult.confidence_adjustment || 0);
const finalScore    = Math.min(100, Math.max(0, sigScore + adjustment + intelAdjFinal));
const biasAligns    = aiResult.direction_bias === 'NEUTRAL' || aiResult.direction_bias === direction;
const rangingBlock  = aiResult.regime === 'RANGING' && finalScore < 60;

const tf4hPenalty   = tf4h.status === 'CONTRADICTS' ? 10 : 0;
const scoreAdjusted = Math.max(0, finalScore - tf4hPenalty);

const macroRiskReduction = Math.max(0, 1 - (marketCtx.size_multiplier || 1.0));
const finalRiskReduction = Math.min(0.7, (aiResult.risk_reduction || 0) + macroRiskReduction);

// Penalty de -10pts si LATE_TREND pasa el gate
let lateTrendPenalty = 0;
if(visionLate && allowLateWithGate && !(direction === 'SHORT' && macroBias === 'BEARISH')){
  lateTrendPenalty = 10;
}
const scoreWithLatePenalty = Math.max(0, scoreAdjusted - lateTrendPenalty);

const passAI =
  (
    aiResult.approve === true &&
    biasAligns &&
    !rangingBlock &&
    scoreWithLatePenalty >= dynamicThreshold &&
    !rsiDangerous &&
    !volumeSpike &&
    !lateTrendBlocks
  ) ||
  (
    historyOverrideRelief > 0 &&
    biasAligns &&
    !rangingBlock &&
    !rsiDangerous &&
    !volumeSpike &&
    !lateTrendBlocks &&
    scoreWithLatePenalty >= (dynamicThreshold - Math.max(2, historyNearThresholdSlack || 0))
  );

let skipReason = null;
if(!passAI){
  if(rsiDangerous)
    skipReason = `RSI peligroso para ${direction}: ${rsi.toFixed(1)}`;
  else if(volumeSpike)
    skipReason = `Vol spike extremo (${(indicators.volRatio||0).toFixed(1)}x)`;
  else if(lateTrendBlocks)
    skipReason = `LATE_TREND bloqueado — score=${lateScore} vol=${volRatio.toFixed(2)}x (necesita score>=90+vol>=1.2x o score>=85+vol>=1.5x)`;
  else if(visionReject && !allowLateWithGate)
    skipReason = `Chart ${vision.market_state} + imagen rechaza: ${vision.reason}`;
  else if(visionReject)
    skipReason = `Imagen rechaza: ${vision.reason}`;
  else if(!biasAligns)
    skipReason = `Bias conflict: AI dice ${aiResult.direction_bias} vs ${direction}`;
  else if(rangingBlock)
    skipReason = `Ranging + score bajo (${scoreAdjusted})`;
  else if(tf4h.status === 'CONTRADICTS')
    skipReason = `4h contradice 1h (${tf4h.trend} vs ${direction}) score=${scoreAdjusted} < threshold ${dynamicThreshold}`;
  else if(!aiResult.approve)
    skipReason = `AI rechaza: ${aiResult.key_risk}`;
  else
    skipReason = `Score insuficiente: ${scoreWithLatePenalty} < threshold dinámico ${dynamicThreshold} (macro=${macroBias} 4h=${tf4hStatus} intel=${intel.signal||'N/A'} pos=${openCount})`;
}

console.log(`[${symbol}][IMG] passAI=${passAI} score=${scoreWithLatePenalty} threshold=${dynamicThreshold} lateTrendPenalty=${lateTrendPenalty} rsiDangerous=${rsiDangerous}(${rsi})`);

return [{
  json: {
    ...d,
    aiResult,
    finalScore:       scoreWithLatePenalty,
    passAI,
    skipReason,
    dynamicThreshold,
    intelAdjFinal,
    volatilityBonus,
    historyOverride: historyOverrideRelief > 0 && passAI,
    historyPolicy: historyPolicyMatch,
    historyOverrideRelief,
    slMultiplier:     aiResult.sl_multiplier  || 1.5,
    tpMultiplier:     aiResult.tp_multiplier  || 2.0,
    riskReduction:    finalRiskReduction,
    leverageOverride: aiResult.recommended_leverage || null,
    usedFallback:     false,
    originalSymbol:   symbol,
    filters: { visionReject, visionLate, rsiDangerous, volumeSpike, biasAligns, rangingBlock }
  }
}];

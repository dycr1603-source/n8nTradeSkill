const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY';
const d = $input.first().json;

const sigScore   = Number(d.score || 0);
const symbol     = d.symbol;
const direction  = d.direction || 'NEUTRAL';
const indicators = d.indicators || {};
const candles    = d.candles || {};
const fallbacks  = d.fallbackCandidates || [];
const openCount  = d.openCount || 0;
const openSymbols = Array.isArray(d.openSymbols) ? d.openSymbols.map(s => String(s || '').toUpperCase()) : [];
const symbolUpper = String(symbol || '').toUpperCase();

const tf4h      = d.tf4h || {};
const marketCtx = d.marketContext || {};

const panicMode = marketCtx.panicMode || false;
const minScoreForPanicLong = marketCtx.minScoreForPanicLong || 90;
const INTERNAL_DASHBOARD_BASE = process.env.INTERNAL_DASHBOARD_BASE || 'http://localhost:3001';
const RECOVERY_MODE = true;
const tradingDisabled = process.env.N8N_TRADING_DISABLED === '1';

if(tradingDisabled){
  return [{
    json: {
      ...d,
      passAI: false,
      finalScore: 0,
      skipReason: 'Trading disabled by kill switch (N8N_TRADING_DISABLED=1)',
      dynamicThreshold: null,
      aiResult: {
        regime: 'NEUTRAL',
        direction_bias: 'NEUTRAL',
        recommended_leverage: 1,
        confidence_adjustment: -100,
        key_risk: 'kill switch active',
        reasoning: 'Trading deshabilitado manualmente por seguridad.'
      },
      decisionAudit: {
        stage: 'AI Market Context',
        decision: 'blocked',
        reason: 'kill_switch',
        macroBias: marketCtx.market_bias || 'NEUTRAL',
        tf4hStatus: tf4h.status || 'NEUTRAL',
        filters: { tradingDisabled: true }
      },
      filters: {
        tradingDisabled: true,
        symbolAlreadyOpen: false,
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
  dynamicThreshold = 82;
} else if(macroAlignsWithDirection && tf4hStatus === 'CONFIRMS'){
  dynamicThreshold = 74;
} else if(macroAlignsWithDirection && tf4hStatus === 'NEUTRAL'){
  dynamicThreshold = 70;
} else if(macroAlignsWithDirection && tf4hStatus === 'CONTRADICTS'){
  dynamicThreshold = 79;
} else if(macroBias === 'NEUTRAL' && tf4hStatus === 'CONFIRMS'){
  dynamicThreshold = 72;
} else if(macroBias === 'NEUTRAL' && tf4hStatus === 'NEUTRAL'){
  dynamicThreshold = 74;
} else {
  dynamicThreshold = 71;
}

if(openCount >= 2)      dynamicThreshold += 8;
else if(openCount >= 1) dynamicThreshold += 4;

// ── Módulo de volatilidad desaprovechada ──────────────────────────────────────
let volatilityBonus = 0;
try{
  const cdResp = await this.helpers.httpRequest({
    method: 'GET', url: `${INTERNAL_DASHBOARD_BASE}/cooldown/status`, json: true
  });
  const activeCooldowns = Object.keys(cdResp.active || {}).length;
  const atrPct = Number(indicators.atrPct || 0);
  const highVolatility = atrPct > 2.0;

  if(!RECOVERY_MODE && openCount === 0 && activeCooldowns >= 5 && highVolatility && direction === 'SHORT' && macroAlignsWithDirection){
    volatilityBonus = 8;
    console.log(`[${symbol}] Volatility bonus activado: ${activeCooldowns} cooldowns activos, ATR=${atrPct}%`);
  }
}catch(e){ console.log('[NO-IMG] Volatility check error:', e.message); }

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
  maxRsiLong: 78,
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
      ? rsiNow <= Number(historyGuardrails.maxRsiLong || 78)
      : rsiNow >= Number(historyGuardrails.minRsiShort || 25);

    if(tfOk && openOk && volOk && rsiOk){
      if(RECOVERY_MODE){
        historyOverrideRelief = 0;
        historyNearThresholdSlack = 0;
        console.log(`[${symbol}] Recovery mode: policy observada pero sin bajar threshold para ${direction}|${macroRelation}|4h=${tf4hStatus}`);
      } else {
        dynamicThreshold = Math.max(55, dynamicThreshold - historyOverrideRelief);
        console.log(`[${symbol}] History policy activa: relief=${historyOverrideRelief} pts para ${direction}|${macroRelation}|4h=${tf4hStatus}`);
      }
    } else {
      historyOverrideRelief = 0;
      historyNearThresholdSlack = 0;
      console.log(`[${symbol}] History policy no aplicada por guardrail tfOk=${tfOk} openOk=${openOk} volOk=${volOk} rsiOk=${rsiOk}`);
    }
  }
}catch(e){
  console.log(`[${symbol}] History policy error: ${e.message}`);
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

console.log(`[${symbol}] dynamicThreshold=${dynamicThreshold} (macro=${macroBias} 4h=${tf4hStatus} openCount=${openCount} volBonus=${volatilityBonus} panicMode=${panicMode})`);
console.log(`[${symbol}] Intelligence adj: ${intelAdjFinal} pts (signal=${intel.signal||'N/A'} conf=${intel.confidence||'N/A'} dir=${direction})`);

// ── Bloqueo macro ─────────────────────────────────────────────────────────────
const historyMacroBypass = !RECOVERY_MODE &&
  historyOverrideRelief > 0 &&
  direction === 'LONG' &&
  tf4hStatus === 'CONFIRMS' &&
  openCount <= Number(historyGuardrails.maxOpenCountForOverride || 1) &&
  volNow < Number(historyGuardrails.maxVolRatio || 4) &&
  rsiNow <= Number(historyGuardrails.maxRsiLong || 78) &&
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
        filters: { visionReject:false, visionLate:false, rsiDangerous:false, volumeSpike:false, biasAligns:false, rangingBlock:false }
      }
    }];
  }
  if(historyMacroBypass) console.log(`[${symbol}] ✅ History bypass habilita LONG bloqueado por macro`);
  if(isPanicLong) console.log(`[${symbol}] ✅ PANIC LONG PERMITTED: score=${sigScore} >= ${minScoreForPanicLong}`);
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
- Razón: ${marketCtx.reason || 'N/A'}${panicMode ? ' | PANIC MODE ACTIVO' : ''}`
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
THRESHOLD MÍNIMO: ${dynamicThreshold} pts${panicMode ? ' | PANIC MODE: longs permitidos si score >= ' + minScoreForPanicLong : ''}${volatilityCtx}

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
3. Mercado BEARISH macro + señal LONG → confidence_adjustment mínimo -20 (excepto panic mode con score>=${minScoreForPanicLong})
4. Mercado BEARISH macro + señal SHORT → señal válida, mantener o subir confianza
5. RSI 4h > 75 en LONG o < 25 en SHORT → reducir leverage a máximo 3x
6. RSI > 82 en LONG = penalizar fuertemente (umbral actualizado)
7. Score final < ${dynamicThreshold} → rechazar
8. Señal NO OPERAR o conflicto de inteligencia → reducir confianza adicional
9. En mercado de pánico extremo con SHORT alineado macro → priorizar continuación bajista

Responde SOLO con este JSON:
{
  "regime": "TRENDING | RANGING | HIGH_VOLATILITY",
  "direction_bias": "LONG | SHORT | NEUTRAL",
  "recommended_leverage": 5,
  "confidence_adjustment": 0,
  "key_risk": "una sola oración en español",
  "reasoning": "máximo 2 oraciones en español"
}`;

let usedAIFallback = true;
let aiResult = {
  regime: 'NEUTRAL', direction_bias: 'NEUTRAL',
  recommended_leverage: 1, confidence_adjustment: -20,
  key_risk: 'AI unavailable',
  reasoning: 'Fallback defaults — bloqueado en recovery mode'
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
    if(match){
      const parsed = JSON.parse(match[0]);
      if(parsed.regime && parsed.direction_bias){
        aiResult = parsed;
        usedAIFallback = false;
      }
    }
  } else {
    aiResult.reasoning = 'API error: ' + JSON.stringify(body.error);
  }
}catch(e){
  aiResult.reasoning = 'AI API error: ' + e.message;
  aiResult.confidence_adjustment = -20;
}

// ── Filtros ───────────────────────────────────────────────────────────────────
const adjustment    = Number(aiResult.confidence_adjustment || 0);
const finalScore    = Math.min(100, Math.max(0, sigScore + adjustment + intelAdjFinal));
const biasAligns    = aiResult.direction_bias === 'NEUTRAL' || aiResult.direction_bias === direction;
const rangingBlock  = aiResult.regime === 'RANGING' && finalScore < 65;

// Recovery mode: volvemos a filtros RSI mas estrictos para frenar entradas tardias.
const rsiDangerous  = (direction === 'SHORT' && rsi < 30) || (direction === 'LONG' && rsi > 70);
const volumeSpike   = (indicators.volRatio || 0) > 4;
const lateTrendNoImage =
  tf4hStatus === 'CONFIRMS' &&
  macroAlignsWithDirection &&
  ((direction === 'LONG' && rsi >= 68) || (direction === 'SHORT' && rsi <= 32));

const tf4hPenalty   = tf4h.status === 'CONTRADICTS' ? 10 : 0;
const scoreAdjusted = Math.max(0, finalScore - tf4hPenalty);

const basePassAI =
  !usedAIFallback &&
  biasAligns &&
  !rangingBlock &&
  scoreAdjusted >= dynamicThreshold &&
  !rsiDangerous &&
  !volumeSpike &&
  !lateTrendNoImage;
const historyNearThresholdPass = !RECOVERY_MODE &&
  historyOverrideRelief > 0 &&
  biasAligns &&
  !rangingBlock &&
  !rsiDangerous &&
  !volumeSpike &&
  !lateTrendNoImage &&
  scoreAdjusted >= (dynamicThreshold - Math.max(2, historyNearThresholdSlack || 0));
const passAI = basePassAI || historyNearThresholdPass;

if(passAI){
  console.log(`[${symbol}] Aprobado: score=${scoreAdjusted} threshold=${dynamicThreshold} macro=${macroBias} 4h=${tf4hStatus} filters=${JSON.stringify({ rsiDangerous, volumeSpike, biasAligns, rangingBlock, aiFallback: usedAIFallback, lateTrendNoImage })}`);
  return [{
    json: {
      ...d, aiResult, finalScore: scoreAdjusted, passAI: true, skipReason: null,
      dynamicThreshold, intelAdjFinal, volatilityBonus,
      historyOverride: historyNearThresholdPass || historyMacroBypass,
      historyPolicy: historyPolicyMatch,
      historyOverrideRelief,
      decisionAudit: {
        stage: 'AI Market Context',
        decision: 'approved',
        reason: 'passAI',
        macroBias,
        tf4hStatus,
        dynamicThreshold,
        finalScore: scoreAdjusted,
        filters: { rsiDangerous, volumeSpike, biasAligns, rangingBlock, historyNearThresholdPass, aiFallback: usedAIFallback, lateTrendNoImage }
      },
      filters: { visionReject:false, visionLate:false, rsiDangerous, volumeSpike, biasAligns, rangingBlock, historyNearThresholdPass, aiFallback: usedAIFallback, lateTrendNoImage }
    }
  }];
}

// ── Skip reason ───────────────────────────────────────────────────────────────
let skipReason = '';
if(usedAIFallback){
  skipReason = `AI fallback bloqueado en recovery mode — score=${scoreAdjusted} threshold=${dynamicThreshold}`;
} else if(rsiDangerous){
  const rsiLimit = direction === 'SHORT' ? 30 : 70;
  const rsiDiff  = direction === 'SHORT'
    ? (rsi - rsiLimit).toFixed(1)
    : (rsi - rsiLimit).toFixed(1);
  skipReason = `RSI peligroso para ${direction}: ${rsi.toFixed(1)} (límite ${rsiLimit}, excede por ${Math.abs(rsiDiff)} pts) — score=${scoreAdjusted} threshold=${dynamicThreshold} (+${scoreAdjusted - dynamicThreshold} sobre threshold)`;
} else if(volumeSpike){
  skipReason = `Vol spike extremo (${(indicators.volRatio||0).toFixed(1)}x) — score=${scoreAdjusted} threshold=${dynamicThreshold}`;
} else if(lateTrendNoImage){
  skipReason = `Entrada tardia detectada sin imagen: 4h=${tf4hStatus} macro=${macroBias} RSI=${rsi.toFixed(1)} — score=${scoreAdjusted} threshold=${dynamicThreshold}`;
} else if(!biasAligns){
  skipReason = `Bias conflict: AI dice ${aiResult.direction_bias} vs ${direction} — score=${scoreAdjusted} threshold=${dynamicThreshold}`;
} else if(rangingBlock){
  skipReason = `Ranging market — score ${scoreAdjusted} pts (threshold ${dynamicThreshold}, faltaron ${dynamicThreshold - scoreAdjusted} pts)`;
} else if(tf4h.status === 'CONTRADICTS'){
  skipReason = `4h contradice señal 1h (${tf4h.trend} vs ${direction}) — score ${scoreAdjusted} < threshold ${dynamicThreshold} (faltan ${dynamicThreshold - scoreAdjusted} pts)`;
} else {
  const diff = scoreAdjusted - dynamicThreshold;
  skipReason = `Score insuficiente: ${scoreAdjusted} < threshold ${dynamicThreshold} (faltan ${Math.abs(diff)} pts) — macro=${macroBias} 4h=${tf4hStatus} intel=${intel.signal||'N/A'} pos=${openCount}`;
}
console.log(`[${symbol}] Rechazado: ${skipReason} — intentando ${fallbacks.length} fallbacks`);

// ── Fallbacks ─────────────────────────────────────────────────────────────────
for(const fb of fallbacks){
  const fbRsi          = fb.indicators?.rsi14 || 50;
  const fbDir          = fb.direction;
  const fbSymbol       = String(fb.symbol || '').toUpperCase();
  if(openSymbols.includes(fbSymbol)){
    console.log(`[${fb.symbol}] Fallback omitido: símbolo ya abierto`);
    continue;
  }
  // Recovery mode: mismo filtro RSI estricto para fallbacks.
  const fbRsiDangerous = (fbDir === 'SHORT' && fbRsi < 30) || (fbDir === 'LONG' && fbRsi > 70);
  const fbVolSpike     = (fb.indicators?.volRatio || 0) > 4;
  const fbScore        = fb.score || 0;

  if(fbRsiDangerous || fbVolSpike || fbScore < dynamicThreshold){
    console.log(`[${fb.symbol}] Fallback descartado: rsi=${fbRsiDangerous} vol=${fbVolSpike} score=${fbScore} < ${dynamicThreshold}`);
    continue;
  }
  if(marketCtx.long_ok === false && fbDir === 'LONG'){
    const isFbPanicLong = panicMode && fbScore >= minScoreForPanicLong;
    if(!isFbPanicLong) continue;
  }
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

  let fbVolBonus = 0;
  if(openCount === 0 && volatilityBonus > 0 && fbDir === 'SHORT' &&
    ((macroBias === 'BEARISH' && fbDir === 'SHORT') || (macroBias === 'BULLISH' && fbDir === 'LONG'))){
    fbVolBonus = volatilityBonus;
  }
  const fbThreshold = Math.max(55, dynamicThreshold - fbVolBonus);

  const fbPrompt = `You are a professional crypto futures trader.
Symbol: ${fb.symbol} | Signal: ${fbDir} | Score: ${fbScore}
4H: ${fbTf4h.trend||'N/A'} (${fbTf4h.status||'N/A'}) | Macro: ${macroBias} | F&G: ${marketCtx.fearGreed?.value||'N/A'}${panicMode ? ' | PANIC MODE' : ''}
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

  let fbUsedAIFallback = true;
  let fbAI = {
    regime:'NEUTRAL',
    direction_bias:'NEUTRAL',
    recommended_leverage:1,
    confidence_adjustment: -20,
    key_risk:'AI unavailable',
    reasoning:'fallback blocked in recovery mode'
  };
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
      if(m){
        const p = JSON.parse(m[0]);
        if(p.regime){
          fbAI = p;
          fbUsedAIFallback = false;
        }
      }
    }
  }catch(e){ console.log(`Fallback AI error ${fb.symbol}: ${e.message}`); continue; }

  const fbAdj     = Number(fbAI.confidence_adjustment || 0);
  const fbFinal   = Math.min(100, Math.max(0, fbScore + fbAdj + fbIntelAdj));
  const fbAligns  = fbAI.direction_bias === 'NEUTRAL' || fbAI.direction_bias === fbDir;
  const fbRanging = fbAI.regime === 'RANGING' && fbFinal < 65;
  const fbLateTrendNoImage =
    (fb.tf4h?.status || 'NEUTRAL') === 'CONFIRMS' &&
    (((macroBias === 'BEARISH' && fbDir === 'SHORT') || (macroBias === 'BULLISH' && fbDir === 'LONG'))) &&
    ((fbDir === 'LONG' && fbRsi >= 68) || (fbDir === 'SHORT' && fbRsi <= 32));

  if(!fbUsedAIFallback && fbAligns && !fbRanging && !fbLateTrendNoImage && fbFinal >= fbThreshold){
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
        filters: { visionReject:false, visionLate:false, rsiDangerous:false, volumeSpike:false, biasAligns:fbAligns, rangingBlock:false, aiFallback:false, lateTrendNoImage:fbLateTrendNoImage }
      }
    }];
  }
  console.log(`[${fb.symbol}] Fallback rechazado: aiFallback=${fbUsedAIFallback} bias=${fbAligns} ranging=${fbRanging} late=${fbLateTrendNoImage} score=${fbFinal} < ${fbThreshold}`);
}

return [{
  json: {
    ...d, aiResult, finalScore: scoreAdjusted, passAI: false, skipReason,
    dynamicThreshold, intelAdjFinal, volatilityBonus,
    historyOverride: false,
    historyPolicy: historyPolicyMatch,
    historyOverrideRelief,
    allFallbacksFailed: true,
    decisionAudit: {
      stage: 'AI Market Context',
      decision: 'blocked',
      reason: skipReason,
      macroBias,
      tf4hStatus,
      dynamicThreshold,
      finalScore: scoreAdjusted,
      filters: { rsiDangerous, volumeSpike, biasAligns, rangingBlock, historyNearThresholdPass:false, aiFallback: usedAIFallback, lateTrendNoImage }
    },
    filters: { visionReject:false, visionLate:false, rsiDangerous, volumeSpike, biasAligns, rangingBlock, historyNearThresholdPass:false, aiFallback: usedAIFallback, lateTrendNoImage }
  }
}];

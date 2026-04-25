# Resumen Operativo del Bot

Fecha: 2026-04-25  
Sistema: `n8nTradeSkill`  
Workflows principales:

- `Advanced AI Trading Bot v2 - Clean`
- `SL Monitor`
- `Trailing Manager`

## 1. Resumen ejecutivo

Durante los ultimos dias el bot sufrio una degradacion clara de rendimiento. El problema no fue un cruce simple de LONG/SHORT en el cableado, sino una politica de aprobacion demasiado permisiva que estaba dejando entrar operaciones tardias, especialmente cuando:

- el contexto `macro` parecia apoyar la direccion,
- el `4H` aparecia como `CONFIRMS`,
- el score base se acercaba al threshold,
- y la IA o el historial relajaban demasiado el filtro.

La consecuencia fue una exposicion frecuente del lado equivocado del movimiento, con entradas de continuacion tardias y peor calidad estadistica.

## 2. Hallazgos basados en datos

Ventanas analizadas:

- Ultimos 7 dias posteriores a cambios recientes:
  - `24 trades`
  - `-35.05 USDT`
  - `29.2%` de win rate
- Semana previa estable:
  - `37 trades`
  - `+8.25 USDT`
  - `51.4%` de win rate

Simulacion espejo:

- PnL real: `-35.05 USDT`
- PnL con direcciones invertidas: `+35.05 USDT`

Interpretacion:

- El bot estaba entrando muchas veces en zonas malas de timing.
- No parecia un bug trivial de “invertir LONG/SHORT” en todos los casos.
- Si parecia una combinacion de:
  - continuation chasing,
  - thresholds demasiado bajos,
  - filtros relajados,
  - y confianza excesiva cuando `4H` confirmaba.

## 3. Causa raiz

La causa principal fue una degradacion en la capa de aprobacion `AI_Market_Context`, tanto en la ruta sin imagen como en la ruta con imagen, aunque el mayor dano vino de la ruta sin imagen.

Factores que explican la degradacion:

1. `dynamicThreshold` demasiado permisivo en setups “alineados”.
2. `historyOverrideRelief` y `historyMacroBypass` bajaban aun mas el filtro.
3. Cuando la IA fallaba, el fallback seguia dejando puertas abiertas.
4. Los filtros RSI habian quedado demasiado sueltos.
5. Se permitian entradas tardias en continuacion, sobre todo si el `4H` “confirmaba”.

## 4. Que se corrigio

### 4.1 Nodo sin imagen

Archivo:

- [AI_Market_Context_FIXED_2026-04-25.js](/home/admin/n8nTradeSkill/trading-bot/nodos-corregidos-2026-04-25/AI_Market_Context_FIXED_2026-04-25.js)

Cambios principales:

- kill switch por variable de entorno (`N8N_TRADING_DISABLED=1`)
- bloqueo duro de simbolos ya abiertos
- thresholds mas estrictos en recovery mode
- fallback de IA bloqueado como via de aprobacion
- RSI mas estricto:
  - LONG peligroso si `RSI > 70`
  - SHORT peligroso si `RSI < 30`
- bloqueo explicable para `lateTrendNoImage`
- `decisionAudit` y `filters` para trazabilidad

### 4.2 Nodo con imagen

Archivo:

- [AI_Market_Context_Image_FIXED_2026-04-25.js](/home/admin/n8nTradeSkill/trading-bot/nodos-corregidos-2026-04-25/AI_Market_Context_Image_FIXED_2026-04-25.js)

Cambios principales:

- kill switch compatible con n8n
- bloqueo duro de simbolos abiertos
- thresholds endurecidos
- fallback de IA bloqueado
- gate explicable para `LATE_TREND`
- rechazo inmediato para `PARABOLIC`
- RSI revisado:
  - LONG peligroso si `RSI > 82`
  - SHORT peligroso si `RSI < 25`
- soporte de vision contextual sin relajar automaticamente el threshold

## 5. Como trabaja el bot ahora

## 5.1 Flujo general

El bot ahora funciona con una filosofia mas conservadora:

1. Genera una senal base (`score`, `direction`, indicadores 1H).
2. Cruza la senal con:
   - contexto macro,
   - inteligencia de noticias/sesiones,
   - tendencia 4H,
   - y, cuando existe, analisis de imagen.
3. Calcula un `dynamicThreshold`.
4. Revisa filtros duros:
   - simbolo ya abierto,
   - kill switch,
   - RSI peligroso,
   - volumen extremo,
   - contradiccion macro,
   - contradiccion 4H,
   - late trend no permitido.
5. Solo aprueba si:
   - la IA respondio bien,
   - el sesgo coincide,
   - el score final supera threshold,
   - y no hay bloqueos duros.

## 5.2 Recovery mode

`RECOVERY_MODE = true`

Significa:

- mas prioridad a seguridad que a frecuencia,
- menos alivios por historial,
- menos tolerancia a fallback,
- menos entradas tardias,
- y mas disciplina contra setups extendidos.

## 5.3 Kill switch

La parada rapida ahora se controla por variable de entorno:

- `N8N_TRADING_DISABLED=1`

Efecto:

- el nodo devuelve `passAI=false`
- `finalScore=0`
- `skipReason='Trading disabled by kill switch (N8N_TRADING_DISABLED=1)'`

## 5.4 Reentrada en simbolos abiertos

El bot ahora evita analizar o reaprobar el mismo simbolo si ya existe una posicion viva en Binance para ese simbolo.

Efecto:

- reduce duplicacion accidental,
- evita stacking no deseado,
- protege contra aperturas repetidas del mismo activo.

## 6. Explicacion de los principales filtros

## 6.1 Macro

`marketContext.long_ok` y `marketContext.short_ok` pueden bloquear operaciones.

Escenarios:

- `macro BEARISH` + `LONG`: se vuelve mucho mas exigente
- `macro BEARISH` + `SHORT`: puede ser valido
- `panicMode`: permite algunas excepciones si el score es muy alto

## 6.2 4H

Estados mas comunes:

- `CONFIRMS`
- `NEUTRAL`
- `CONTRADICTS`

Interpretacion:

- `CONFIRMS`: ayuda, pero ya no da via libre
- `NEUTRAL`: no estorba, pero exige calidad
- `CONTRADICTS`: castiga score y puede bloquear

## 6.3 RSI

Se usa como freno contra entradas tardias o extendidas.

Sin imagen:

- LONG peligroso: `RSI > 70`
- SHORT peligroso: `RSI < 30`

Con imagen:

- LONG peligroso: `RSI > 82`
- SHORT peligroso: `RSI < 25`

## 6.4 Volumen

Si `volRatio > 4`, el bot lo considera `volumeSpike`.

Interpretacion:

- evita entrar cuando el movimiento puede estar demasiado acelerado,
- reduce persecucion de velas explosivas.

## 6.5 Vision

Cuando hay analisis de chart:

- `PARABOLIC`: bloqueo inmediato
- `LATE_TREND`: bloqueado salvo que pase gate
- `EARLY_TREND`: puede apoyar la aprobacion

Gate especial para `LATE_TREND`:

- `score >= 90` y `vol >= 1.2x`, o
- `score >= 85` y `vol >= 1.5x`

## 7. Escenarios operativos explicados

## 7.1 Escenario sano para aprobar

Ejemplo:

- direction = `SHORT`
- macro = `BEARISH`
- 4H = `CONFIRMS`
- RSI en zona no extrema
- sin volume spike
- la IA responde con sesgo consistente
- score final supera threshold

Resultado:

- el bot puede aprobar,
- con leverage y riesgo ajustados segun contexto.

## 7.2 Escenario de bloqueo por riesgo macro

Ejemplo:

- direction = `LONG`
- macro = `BEARISH`
- sin panic mode valido

Resultado:

- bloqueo temprano,
- evita intentar capturar rebotes de baja calidad.

## 7.3 Escenario de bloqueo por entrada tardia

Ejemplo:

- LONG ya muy extendido,
- RSI alto,
- 4H confirmando,
- contexto aparentemente favorable,
- pero precio demasiado adelantado.

Resultado:

- el bot lo puede rechazar por:
  - `rsiDangerous`
  - `lateTrendNoImage`
  - o `LATE_TREND` visual

## 7.4 Escenario de IA caida

Si la API de IA falla o devuelve algo incompleto:

- antes podia dejar una salida blanda,
- ahora en recovery mode se bloquea la aprobacion.

Resultado:

- menos trades,
- mas consistencia,
- menos entradas “por default”.

## 8. Cambios en infraestructura relacionados

Durante el ajuste tambien se corrigieron temas operativos del sistema:

- conflictos entre servicios `chart-api`
- rutas internas usando `127.0.0.1`
- reemplazo de rutas de imagen a `/tmp/aterum_chart.jpg`
- compatibilidad de `Code` nodes de n8n sin `require('fs')`
- correcciones de sintaxis en nodos live

## 9. Panorama de riesgos actuales

Aunque el bot ahora esta mejor protegido, estos riesgos siguen existiendo:

1. `chart-api` y Puppeteer pueden fallar de forma intermitente.
2. La IA externa puede responder lento o de forma imperfecta.
3. Un mercado extremadamente rapido puede saltarse confirmaciones.
4. `4H CONFIRMS` no garantiza timing; solo contexto.
5. Un exceso de conservadurismo puede mejorar calidad pero reducir frecuencia.

## 10. Que deberia verse ahora en la practica

Comportamiento esperado del bot:

- menos operaciones abiertas
- menos trades impulsivos
- menos reentradas del mismo simbolo
- menos aprobaciones con IA degradada
- mas rechazos explicables
- mejor trazabilidad por `decisionAudit`

## 11. Monitoreo recomendado

Durante 48-72h conviene revisar:

- win rate total
- PnL diario
- distribucion LONG vs SHORT
- cantidad de trades bloqueados
- motivos de bloqueo mas frecuentes
- resultado por `4H CONFIRMS`, `NEUTRAL`, `CONTRADICTS`
- frecuencia de `AI fallback bloqueado`

## 12. Conclusiones

El bot ahora trabaja con una logica mas prudente, explicable y alineada a recuperacion.

La idea central ya no es “tomar mas entradas”, sino:

- tomar menos,
- tomar mejores,
- y evitar con fuerza las entradas tardias que estaban destruyendo el rendimiento.

Si el sistema se estabiliza con esta revision, el siguiente paso ideal no es aflojar thresholds a ciegas, sino construir mejoras explicables basadas en:

- VWAP distance
- EMA spread
- RSI 1H + RSI 4H
- y estadistica historica por grupo de contexto

## 13. Como convertir este archivo a PDF

Opciones simples:

1. Abrir este `.md` en VS Code y usar una extension Markdown PDF.
2. Copiarlo a Google Docs / Word y exportar como PDF.
3. Convertirlo a HTML y usar “Print > Save as PDF”.
4. Si quieres una version ya lista para imprimir, usa el archivo HTML hermano:

- [BOT_OPERATING_SUMMARY_2026-04-25.html](/home/admin/n8nTradeSkill/trading-bot/nodos-corregidos-2026-04-25/BOT_OPERATING_SUMMARY_2026-04-25.html)

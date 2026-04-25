# Nodos Corregidos — 2026-04-25

Revision conservadora orientada a recuperacion tras degradacion fuerte observada en los ultimos 7 dias.

## Hallazgos basados en datos

Ventanas analizadas en MariaDB (`trading_bot`):

- Ultimos 7 dias posteriores a cambios recientes:
  - 24 trades
  - PnL: `-35.05 USDT`
  - Win rate: `29.2%`
- Semana previa estable (`2026-04-04` a `2026-04-11`):
  - 37 trades
  - PnL: `+8.25 USDT`
  - Win rate: `51.4%`

Simulacion espejo de los ultimos 7 dias:

- PnL real: `-35.05 USDT`
- PnL invertido (LONG ↔ SHORT): `+35.05 USDT`

Esto demuestra exposicion sistematicamente del lado equivocado del movimiento, pero no un bug simple de cableado LONG/SHORT. La evidencia apunta a entradas de continuacion demasiado tardias.

## Causa raiz

La degradacion vino principalmente de una politica de aprobacion demasiado permisiva en `AI_Market_Context`, sobre todo en la ruta **sin imagen**:

1. `dynamicThreshold` demasiado bajo cuando `macro` y `4H` confirmaban.
2. `historyOverrideRelief` y `historyMacroBypass` reducian aun mas el filtro.
3. Cuando la IA fallaba, el fallback seguia sesgado a favor de la direccion de entrada.
4. Los filtros RSI se relajaron, permitiendo perseguir tendencia tarde.

Resultado observado:

- `4H CONFIRMS`: 19 trades, `-46.48 USDT`, WR `21.1%`
- `4H NEUTRAL`: 5 trades, `+11.43 USDT`, WR `60.0%`

Eso es consistente con un bug de **late trend chasing**, no con un simple inversion flag.

## Cambios aplicados en esta revision

### `AI_Market_Context_FIXED_2026-04-25.js`

- Sube thresholds de aprobacion, especialmente en `macro aligned + 4H CONFIRMS`
- Desactiva alivios historicos y bypass de macro en `RECOVERY_MODE`
- Bloquea aprobaciones cuando la IA cae en fallback
- Restaura filtros RSI mas estrictos (`LONG > 70`, `SHORT < 30`)
- Agrega bloqueo explicable de `lateTrendNoImage`

### `AI_Market_Context_Image_FIXED_2026-04-25.js`

- Mismo endurecimiento de thresholds base
- Sin reduccion automatica de threshold por tener imagen
- Desactiva alivios historicos y bypass en `RECOVERY_MODE`
- Bloquea fallback de IA

## Intencion operativa

Esta revision prioriza:

- fiabilidad sobre agresividad
- menos trades, pero mas limpios
- evitar continuation entries tardias
- evitar operar cuando la IA no responde bien

## Safety controls

- `kill switch` rapido:
  - archivo: `/tmp/aterum_trading_disabled.flag`
  - o variable: `N8N_TRADING_DISABLED=1`
- `decisionAudit` agregado al output de ambos nodos para registrar:
  - razon
  - filtros
  - estado macro
  - estado 4H

## Despliegue recomendado

1. Reemplazar en n8n el nodo sin imagen por:
   - `AI_Market_Context_FIXED_2026-04-25.js`
2. Reemplazar tambien el nodo con imagen por:
   - `AI_Market_Context_Image_FIXED_2026-04-25.js`
3. Guardar workflow y reactivar.
4. Monitorear 48-72h:
   - win rate por `4H CONFIRMS`
   - frecuencia de `AI fallback bloqueado`
   - distribucion LONG vs SHORT

## Nota sobre backups live

Los backups extraidos directamente de n8n pueden contener secretos operativos reales
(API keys, tokens, credenciales embebidas en nodos antiguos). Por eso:

- no deben subirse al repo publico,
- deben mantenerse solo localmente si se necesitan para rollback,
- y cualquier version compartida debe estar sanitizada antes.

## Siguiente mejora sugerida

Si esta revision estabiliza el sistema, el siguiente paso no deberia ser volver a aflojar thresholds globales, sino construir un filtro explicable de entrada tardia usando:

- distancia a VWAP
- extension EMA spread
- RSI 1H + RSI 4H
- rendimiento historico por grupo (`direction + macroRelation + tf4h`)

Eso permitiria reabrir oportunidades buenas sin volver a perseguir continuaciones malas.

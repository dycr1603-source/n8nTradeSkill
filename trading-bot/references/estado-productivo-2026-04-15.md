# Estado Productivo y Memoria Operativa (2026-04-15)

Este archivo concentra la memoria operativa real del sistema para que cualquier AI pueda continuar trabajo sin perder contexto.

## 1) Fuente de verdad actual

- Producción activa vive en n8n + chart-api del servidor.
- Workflows activos:
  - `Cz4TfvaVAygWGRJm` — `Advanced AI Trading Bot v2 - Clean`
  - `ZYhtV8yWXjNukrW4` — `SL Monitor`
  - `q32UEjoj5wNiBHil` — `Trailing Manager`
- Servicio n8n: `systemctl status n8n` debe estar `active (running)`.

## 2) Parches críticos ya aplicados en producción

## A. No reentrada por símbolo ya abierto

Aplicado en workflow principal:

- `Cz4TfvaVAygWGRJm`, nodo key `12` (`AI Market Context`)
- `Cz4TfvaVAygWGRJm`, nodo key `23` (`AI Market Context Image`)

Regla: si `symbol` está en `openSymbols`, se devuelve `passAI:false` y se omite.

Aplicado también en ejecución:

- `Cz4TfvaVAygWGRJm`, nodo key `15` (`Execute Trade`)
- `Cz4TfvaVAygWGRJm`, nodo key `26` (`Execute Trade1`)

Regla: consulta `positionRisk`; si existe cualquier `positionAmt != 0` para el símbolo, bloquea apertura.
Si falla la validación de `positionRisk`, bloquea por seguridad (fail-closed).

## B. Cooldown por cierre de símbolo = 60 min

Aplicado en:

- `ZYhtV8yWXjNukrW4`, nodo key `7` (`SL Monitor Code`)

Regla: al cerrar una posición, el símbolo queda en cooldown de 60 minutos.

## 3) Señales de verificación rápidas (DB n8n)

Comprobar presencia de parches en SQLite de n8n:

```sql
SELECT w.id, j.key,
  instr(json_extract(j.value,'$.parameters.jsCode'),'Símbolo ya abierto:') AS ai_open_block,
  instr(json_extract(j.value,'$.parameters.jsCode'),'ya tiene posición abierta') AS exec_open_block,
  instr(json_extract(j.value,'$.parameters.jsCode'),'const cooldownMins = 60') AS cooldown_60
FROM workflow_entity w, json_each(w.nodes) j
WHERE w.id IN ('Cz4TfvaVAygWGRJm','ZYhtV8yWXjNukrW4')
  AND j.key IN (7,12,15,23,26);
```

Interpretación esperada:

- key 12 y 23: `ai_open_block > 0`
- key 15 y 26: `exec_open_block > 0`
- workflow `ZYhtV8yWXjNukrW4`, key 7: `cooldown_60 > 0`

## 4) Endpoints internos recomendados (evitar IP pública fija)

- Dashboard/API: `INTERNAL_DASHBOARD_BASE` (default `http://localhost:3001`)
- n8n webhooks locales: `http://localhost:5678/webhook/...`

No hardcodear IP pública en nuevos cambios.

## 5) Archivos recomendados para despliegue manual

Usar esta carpeta como versión recomendada:

- `nodos-corregidos-2026-04-15/AI_Market_Context_FIXED_2026-04-15.js`
- `nodos-corregidos-2026-04-15/AI_Market_Context_Image_FIXED_2026-04-15.js`
- `nodos-corregidos-2026-04-15/Execute_Trade_FIXED_2026-04-15.js`
- `nodos-corregidos-2026-04-15/SL_Monitor_Code_FIXED_2026-04-15.js`

## 6) Operación y troubleshooting

## A. Si dashboard no muestra posiciones abiertas

Posible desalineación Binance vs DB/estado local.

Checklist:

1. Verificar posiciones reales en Binance (`positionRisk`).
2. Verificar `state.positions` de SL Monitor (`/webhook/sl-monitor-get`).
3. Verificar trades en DB (`/db/stats` y tablas de trades).
4. Sincronizar estado faltante hacia SL Monitor con `/webhook/sl-monitor-set`.

## B. Error Binance `-4411` TradFi-Perps agreement

Significa que Binance exige firma previa del contrato para ese producto.
No es bug de lógica del bot.

## C. Si no abre operaciones y todo parece correcto

Revisar:

- `openSymbols` (puede bloquear por símbolo ya abierto)
- cooldown activo del símbolo (`/cooldown/status`)
- circuit breaker (`/cb/status`)
- `marketContext.long_ok/short_ok` y señales de inteligencia

## 7) Convenciones para futuras AI

- Antes de tocar producción, respaldar nodos actuales de n8n.
- Cambios en nodos críticos: `AI Market Context`, `Execute Trade`, `SL Monitor Code`.
- Después de parchear SQLite de n8n: reiniciar `n8n` y validar workflows activos.
- Nunca subir credenciales reales al repo.

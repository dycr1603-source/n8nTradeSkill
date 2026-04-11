# Nodos Corregidos — 2026-04-11

Optimizaciones aplicadas tras análisis de rendimiento del 2026-04-11.
Impacto esperado: **$2.96 → $8-12/día** (2.7x–4x mejora).

---

## Variables de entorno requeridas

Antes de usar estos nodos, configura las siguientes variables en tu entorno n8n:

| Variable              | Descripción                     |
|-----------------------|---------------------------------|
| `BINANCE_API_KEY`     | API Key de Binance Futures      |
| `BINANCE_API_SECRET`  | API Secret de Binance Futures   |
| `ANTHROPIC_API_KEY`   | API Key de Anthropic (Claude)   |

En n8n puedes configurarlas en **Settings → Variables** o como variables de entorno del sistema.

---

## Archivos incluidos

### `Trailing_Manager_Code_FIXED.js`
**FIX #1: TIMELOCK SL — retiene 0.8R mínimo**
- Antes: al activar TIME_LOCK, el SL podía quedar en 0.53R
- Después: garantiza mínimo 0.8R protegido
- Impacto estimado: +$2-3/día

### `Risk_Guard_FIXED.js`
**FIX #2: Panic Mode — flags para permitir longs en pánico extremo**
- Añade `panicMode` y `minScoreForPanicLong` (score >= 90) al output
- Estos flags son consumidos por los nodos de AI Market Context
- Impacto estimado: parte del +$2-3/día del FIX #2

### `AI_Market_Context_Image_FIXED.js`
**FIX #2 + FIX #3 (versión con análisis de imagen)**
- FIX #2: Permite longs en modo pánico si score >= 90, aunque macro bloquee
- FIX #3: LATETREND solo pasa si score >= 85 AND volRatio >= 1.5x (gate dual)
  - Antes: ~60% de LATETREND bloqueaba operaciones válidas
  - Después: gate preciso, -60% rechazos falsos, penalty de -10pts si pasa
- Impacto estimado: +$1-3/día

### `AI_Market_Context_FIXED.js`
**FIX #2 + FIX #3 (versión sin imagen)**
- Mismos fixes que la versión con imagen
- Incluye lógica de fallbacks con soporte para panic mode
- Impacto estimado: +$1-3/día

---

## Instrucciones de instalación

1. Abre n8n y localiza cada workflow correspondiente
2. Edita el nodo **Code** de cada workflow
3. Reemplaza el contenido con el archivo `.js` correspondiente
4. Verifica que las variables de entorno estén configuradas
5. Activa el workflow y monitorea los logs

---

## Orden de despliegue recomendado

1. `Risk_Guard_FIXED.js` — primero, ya que los demás dependen de sus flags
2. `Trailing_Manager_Code_FIXED.js` — independiente, se puede desplegar en paralelo
3. `AI_Market_Context_Image_FIXED.js` — después de Risk Guard
4. `AI_Market_Context_FIXED.js` — después de Risk Guard

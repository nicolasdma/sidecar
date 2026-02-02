# Plan de Optimización de Performance - Sidecar

## Problema Identificado

El sistema actual toma ~13 segundos para una traducción simple debido a:

1. **Doble clasificación redundante**: LocalRouter + RouterV2 clasifican secuencialmente
2. **Cold start de modelos**: gemma2:9b no está precargado
3. **Warm-up bloqueante**: El startup espera 3.5s por el clasificador
4. **Contención de Ollama**: Extraction worker compite por recursos

## Flujo Actual (Problemático)

```
Usuario: "traduce hello world"
    │
    ├─► LocalRouter.tryRoute()          [1-4 seg]
    │   └─► classifyIntent() con CLASSIFICATION_PROMPT
    │       └─► No conoce "translate" → ROUTE_TO_LLM
    │
    ├─► routeV2()                       [4-5 seg]
    │   └─► classifyExtended() con EXTENDED_CLASSIFICATION_PROMPT
    │       └─► Reconoce "translate" → tier: local
    │
    └─► executeProductivityTool()       [6-8 seg cold, 2-3 seg warm]
        └─► Carga gemma2:9b → ejecuta

TOTAL: ~13-17 segundos
```

## Flujo Objetivo

```
Usuario: "traduce hello world"
    │
    ├─► Fast-path regex check           [<1 ms]
    │   └─► Detecta patrón "traduc*" → intent: translate
    │
    └─► executeProductivityTool()       [2-3 seg]
        └─► gemma2:9b ya caliente → ejecuta

TOTAL: ~2-4 segundos
```

## Optimizaciones a Implementar

### Fase 1: Unificar Clasificación (Impacto: -4-5 seg)

**Problema**: Dos clasificadores con prompts diferentes corriendo secuencialmente.

**Solución**: Eliminar LocalRouter.tryRoute() del flujo del Brain. RouterV2 ya maneja todos los casos:
- `deterministic`: time, weather, reminders (ejecución directa)
- `local`: translate, grammar, summarize (LLM local)
- `api`: conversación compleja (Kimi API)

**Archivos a modificar**:
- `src/agent/brain.ts`: Eliminar bloque de LocalRouter, usar solo routeV2
- `src/agent/local-router/router-v2.ts`: Manejar intents determinísticos directamente

### Fase 2: Fast-path con Regex (Impacto: -1-4 seg)

**Problema**: Incluso con clasificador unificado, cada request requiere LLM call.

**Solución**: Detectar patrones obvios con regex ANTES de clasificar:

```typescript
const FAST_PATH_PATTERNS: Record<string, { pattern: RegExp; tier: RoutingTier }> = {
  translate: { pattern: /\b(traduc[eií]|translate|traducción)\b/i, tier: 'local' },
  time: { pattern: /\b(qué hora|what time|hora actual)\b/i, tier: 'deterministic' },
  weather: { pattern: /\b(clima en|weather in|va a llover|temperatura)\b/i, tier: 'deterministic' },
  list_reminders: { pattern: /\b(mis recordatorios|my reminders|qué tengo pendiente)\b/i, tier: 'deterministic' },
};
```

**Archivos a modificar**:
- `src/agent/local-router/router-v2.ts`: Agregar fast-path antes de classifyExtended()

### Fase 3: Preload Inteligente de Modelos (Impacto: -6 seg cold start)

**Problema**: gemma2:9b tiene delay de 15 segundos para preload.

**Solución**:
1. Preload inmediato en background (no bloqueante) al startup
2. Preload predictivo: si fast-path detecta "translate", precargar mientras valida

**Archivos a modificar**:
- `src/device/model-manager.ts`: Reducir delay de preload
- `src/agent/local-router/router-v2.ts`: Trigger preload en fast-path

### Fase 4: Warm-up No Bloqueante (Impacto: -3.5 seg startup)

**Problema**: `await router.warmup()` bloquea el startup.

**Solución**: Warm-up async, el clasificador se calienta con el primer request real.

**Archivos a modificar**:
- `src/agent/local-router/index.ts`: warmup() no bloqueante
- `src/index.ts`: No esperar warmup

### Fase 5: Extraction Worker Optimizado (Evita contención)

**Problema**: Extraction corre inmediatamente después de cada mensaje, compitiendo por Ollama.

**Solución**:
1. Debounce de 30 segundos después del último mensaje del usuario
2. No procesar si hay requests activos en el Brain

**Archivos a modificar**:
- `src/memory/extraction-service.ts`: Agregar debounce y check de actividad

## Principios de Arquitectura

1. **Single Responsibility**: Cada componente hace una cosa bien
2. **No duplicar código**: Un solo clasificador, un solo sistema de routing
3. **Fail fast, fail gracefully**: Timeouts cortos, fallbacks claros
4. **Lazy loading**: Cargar recursos cuando se necesitan, no antes
5. **Predictive loading**: Precargar recursos que probablemente se usarán

## Métricas de Éxito

| Métrica | Actual | Objetivo |
|---------|--------|----------|
| Traducción (cold) | ~13 seg | ~4-5 seg |
| Traducción (warm) | ~8 seg | ~2-3 seg |
| Startup time | ~5 seg | ~2 seg |
| Clasificación | ~5 seg | <1 seg (fast-path) |

## Estado de Implementación

- [x] Fase 1: Unificar clasificación (brain.ts usa solo routeV2)
- [x] Fase 2: Fast-path con regex (router-v2.ts FAST_PATH_RULES)
- [x] Fase 3: Preload inteligente (reducido de 15s a 3s)
- [x] Fase 4: Warm-up no bloqueante (index.ts async warmup)
- [x] Fase 5: Extraction optimizado (15s cooling period)

## Cambios Realizados

### brain.ts
- Eliminado LocalRouter.tryRoute() redundante
- Unificado routing en un solo bloque con routeV2
- Agregado recordUserActivity() para extraction cooling

### router-v2.ts
- Agregado FAST_PATH_RULES con patterns para intents comunes
- tryFastPath() ejecuta ANTES de clasificación LLM
- Patterns para: translate, time, weather, reminders, grammar, summarize, greetings

### index.ts
- Warmup de LocalRouter ahora es async (no bloquea startup)
- Startup ~3.5 segundos más rápido

### device/index.ts
- Preload de modelo de productividad reducido de 15s a 3s

### extraction-service.ts
- Agregado cooling period de 15 segundos después de actividad del usuario
- recordUserActivity() para triggear el cooling
- isInCoolingPeriod() para verificar antes de procesar

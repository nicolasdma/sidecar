# Fase 3.5: Local Router

> **Estado:** ✅ Completada (código + tests + bugfixes)
> **Bugfixes:** Aplicados - Ver `plan/fase-3.5-bugfixes.md`
> **Prerequisitos:** Fase 2 completada (Fase 3 es independiente), Ollama + Qwen funcionando
> **Spike:** Completado con 100% route accuracy
> **Última revisión:** 2026-02-01 (post-análisis tri-perspectiva)
> **Nota:** Este módulo NO depende de embeddings/Fase 3. Usa Qwen como clasificador de intents.

---

## Objetivo

Usar Qwen2.5-3B como router de intents para ejecutar tools determinísticos sin llamar a Kimi K2.5, reduciendo costos, latencia, y eliminando el riesgo de que el LLM "decida" no usar un tool.

---

## Problema que resuelve

El usuario pidió "Recordame en 10 min de las pastas". Kimi respondió amigablemente pero no llamó al tool. El recordatorio nunca se creó.

**Causa raíz:** El LLM tiene agencia sobre si usar tools. Para operaciones determinísticas, esta agencia es innecesaria y riesgosa.

---

## Arquitectura

```
Usuario Input
      │
      ▼
┌─────────────────────┐
│  LocalRouter        │  ← Qwen local, ~700ms
│  (Intent Classifier)│
└─────────────────────┘
      │
      ├── DIRECT_TOOL ───► DirectToolExecutor ───► Template Response
      │   (determinístico)       │
      │                          └── usa executeTool() del registry
      │
      └── ROUTE_TO_LLM ──► Brain ──► Kimi K2.5 ──► Response
          (requiere agencia)
```

**Invariante crítico:** DirectToolExecutor NO reimplementa lógica de tools. Llama a `executeTool()` del registry existente.

---

## Scope: 5 Intents

| Intent | Tool | Ejemplo |
|--------|------|---------|
| `time` | `get_current_time` | "qué hora es" |
| `weather` | `get_weather` | "clima en Buenos Aires" |
| `list_reminders` | `list_reminders` | "mis recordatorios" |
| `reminder` | `set_reminder` | "recordame en 10 min de X" |
| `cancel_reminder` | `find_reminder` + `cancel_reminder` | "cancela el de X" |

Todo lo demás → ROUTE_TO_LLM (conversación, preguntas, ambiguo, etc.)

---

## Reglas de Validación Post-Clasificación

Hardcoded rules que overridean la clasificación del LLM:

```typescript
// Negaciones específicas (no amplias)
/^no\s+(me\s+recuerdes|quiero\s+que|necesito\s+que)/ → ROUTE_TO_LLM

// Pero "no me dejes olvidar" es un reminder válido
/no\s+me\s+dejes\s+olvidar/ → PERMITE reminder

// Acciones masivas
/\b(todos?|todas?)\b.*\b(elimina|borra|cancela)/ → ROUTE_TO_LLM

// Reminder incompleto
intent === 'reminder' && (!params.time || !params.message) → ROUTE_TO_LLM

// Fact memory pattern
/recordame\s+que\s+(soy|tengo|trabajo|vivo|estoy)/ → ROUTE_TO_LLM

// Sugerencias
/^(deberías|podrías|quizás|tal\s*vez)/ → ROUTE_TO_LLM

// Single word ambiguo (excepto palabras clave claras)
wordCount === 1 && !['hora', 'clima', 'recordatorios'].includes(word) → ROUTE_TO_LLM
```

---

## Resultados del Spike

| Métrica | Resultado |
|---------|-----------|
| Route accuracy | 100% |
| False positives | 0 |
| False negatives | 0 |
| Latencia promedio | 722ms |

Ver `src/experiments/local-router-spike/` para código y test cases.

---

## Implementación

### 3.5.1: Core LocalRouter

**Archivos:**
- `src/agent/local-router/index.ts` - Exports
- `src/agent/local-router/classifier.ts` - Intent classification con Qwen
- `src/agent/local-router/validation-rules.ts` - Post-classification rules
- `src/agent/local-router/types.ts` - Interfaces

**Tareas:**
- [x] Port classifier desde spike
- [x] Port validation rules desde spike (con regex refinados)
- [x] Agregar config en `src/utils/config.ts`:
  ```typescript
  localRouter: {
    enabled: boolean;           // Feature flag
    confidenceThreshold: number; // Default 0.8
    ollamaTimeout: number;       // Default 30000ms
    maxLatencyBeforeBypass: number; // Default 2000ms - si tarda más, bypass a Brain
  }
  ```
- [x] Validar modelo exacto de Ollama (no solo prefix):
  ```typescript
  // MAL:
  models.some(m => m.name.startsWith('qwen2.5'));

  // BIEN:
  models.some(m => m.name === MEMORY_MODEL || m.name === `${MEMORY_MODEL}:latest`);
  ```

### 3.5.2: DirectToolExecutor

**Archivos:**
- `src/agent/local-router/direct-executor.ts` - Tool execution
- `src/agent/local-router/response-templates.ts` - Template responses

**Principio clave:** NO reimplementar lógica de tools. Usar `executeTool()` del registry.

```typescript
// direct-executor.ts
import { executeTool, createExecutionContext } from '../../tools/index.js';

async function executeIntent(intent: Intent, params: Params): Promise<ExecutionResult> {
  const context = createExecutionContext();

  // Mapear intent a tool call
  const toolName = INTENT_TO_TOOL[intent];
  const toolArgs = mapParamsToToolArgs(intent, params);

  // Usar el tool existente - NO reimplementar
  const result = await executeTool(toolName, toolArgs, context);

  return {
    success: result.success,
    data: result.data,
    error: result.error,
  };
}
```

**Templates con variantes (evitar respuestas robóticas):**
```typescript
const TEMPLATES = {
  time: {
    success: [
      (t) => `Son las ${t}.`,
      (t) => `${t}.`,
      (t) => `Ahora son las ${t}.`,
    ],
  },
  weather: {
    success: [
      (w) => `En ${w.location}: ${w.temp}°C, ${w.condition}.`,
      (w) => `${w.location}: ${w.temp}°C y ${w.condition}.`,
    ],
    error: [
      () => `No pude obtener el clima.`,
      () => `Falló la consulta del clima.`,
    ],
  },
  reminder: {
    success: [
      (msg, time) => `Listo, te voy a recordar "${msg}" ${time}.`,
      (msg, time) => `Dale, te aviso ${time} sobre "${msg}".`,
      (msg, time) => `Anotado: "${msg}" para ${time}.`,
    ],
    error: [
      (err) => `No pude crear el recordatorio: ${err}`,
    ],
  },
  list_reminders: {
    empty: [
      () => `No tenés recordatorios pendientes.`,
      () => `Tu lista de recordatorios está vacía.`,
    ],
    success: [
      (list) => `Tus recordatorios:\n${list}`,
    ],
  },
  cancel_reminder: {
    success: [
      (msg) => `Cancelé el recordatorio: "${msg}"`,
      (msg) => `Listo, borré el recordatorio de "${msg}"`,
    ],
    notFound: [
      () => `No encontré ese recordatorio.`,
    ],
  },
};

// Seleccionar variante random
function pickTemplate(templates: Array<(...args) => string>, ...args): string {
  const idx = Math.floor(Math.random() * templates.length);
  return templates[idx](...args);
}
```

**Tareas:**
- [x] Implementar executor que usa `executeTool()`
- [x] Response templates con variantes
- [x] Usar `parseDateTime()` existente para reminders (no reimplementar)
- [x] Error handling con fallback a Brain (ver 3.5.3)
- [x] Logging de ejecuciones directas

### 3.5.3: Brain Integration

**Archivos:**
- `src/agent/brain.ts` - Modificar `think()`

**Cambio en brain.ts:**
```typescript
async think(optionsOrInput: string | ThinkOptions): Promise<string> {
  const options = typeof optionsOrInput === 'string'
    ? { userInput: optionsOrInput }
    : optionsOrInput;

  // INVARIANTE: Proactive mode SIEMPRE bypasea LocalRouter
  const isProactiveMode = options.userInput == null;

  // Fase 3.5: Pre-Brain routing (solo para mensajes de usuario)
  if (!isProactiveMode &&
      this.localRouter &&
      config.localRouter.enabled) {

    const routingResult = await this.localRouter.tryRoute(options.userInput);

    if (routingResult.route === 'DIRECT_TOOL') {
      const execResult = await this.localRouter.executeDirect(
        routingResult.intent,
        routingResult.params
      );

      if (execResult.success) {
        // Guardar en history con MISMO formato que Brain
        this.saveDirectResponse(options.userInput, execResult.response);
        return execResult.response;
      }

      // Tool falló → fallback a Brain CON CONTEXTO
      logger.warn('Direct execution failed, falling back to Brain', {
        intent: routingResult.intent,
        error: execResult.error,
      });

      // Brain recibe contexto del intento fallido
      return this.agenticLoopWithContext(options.userInput, {
        previousAttempt: {
          intent: routingResult.intent,
          error: execResult.error,
        }
      });
    }

    // ROUTE_TO_LLM → continuar a agentic loop normal
  }

  // Existing agentic loop (unchanged)
  return this.agenticLoop(options);
}

// Guardar con MISMO formato que agentic loop
private saveDirectResponse(input: string, response: string): void {
  // Guardar mensaje del usuario
  const userMsg: UserMessage = { role: 'user', content: input };
  saveMessage(userMsg);

  // Guardar respuesta del asistente (mismo formato que Brain)
  const assistantMsg: AssistantMessage = { role: 'assistant', content: response };
  saveMessage(assistantMsg);
}
```

**Tareas:**
- [x] Agregar LocalRouter como dependencia opcional de Brain
- [x] Pre-routing antes del agentic loop
- [x] **CRÍTICO:** Proactive mode bypasea LocalRouter
- [x] **CRÍTICO:** Fallback incluye contexto del intento fallido
- [x] **CRÍTICO:** saveDirectResponse usa saveMessage() con mismo formato
- [x] Backoff handling (si Ollama no disponible → bypass silencioso)
- [x] Si latencia > maxLatencyBeforeBypass → bypass a Brain

### 3.5.4: Observabilidad y Métricas

**Logging estructurado:**
```typescript
// En cada decisión de routing:
logger.info('local_router_decision', {
  route: 'DIRECT_TOOL' | 'ROUTE_TO_LLM',
  intent: string,
  confidence: number,
  latency_ms: number,
  validation_override: boolean,  // true si validation rules cambiaron la decisión
});

// En cada ejecución directa:
logger.info('direct_execution', {
  intent: string,
  tool: string,
  success: boolean,
  latency_ms: number,
  fallback_to_brain: boolean,
});
```

**Métricas agregadas (para /stats o similar):**
```typescript
interface LocalRouterStats {
  total_requests: number;
  routed_local: number;
  routed_to_llm: number;
  direct_success: number;
  direct_failures: number;
  fallbacks_to_brain: number;
  avg_local_latency_ms: number;
}
```

**Tareas:**
- [x] Logging estructurado en cada punto de decisión
- [x] Contador de métricas en memoria (reseteable)
- [x] Comando `/router-stats` para ver métricas (incluye backoff state)

### 3.5.5: Startup y Warm-up

**Problema:** Cold start de Ollama puede tomar 5-10 segundos.

**Solución:** Warm-up al startup del agente.

```typescript
// En index.ts o donde se inicializa el agente
async function warmupLocalRouter(): Promise<void> {
  if (!config.localRouter.enabled) return;

  logger.info('Warming up LocalRouter...');
  const start = Date.now();

  try {
    // Hacer una clasificación dummy para cargar el modelo en memoria
    await localRouter.classify('test warmup');
    logger.info('LocalRouter warm-up complete', {
      latency_ms: Date.now() - start
    });
  } catch (error) {
    logger.warn('LocalRouter warm-up failed, will retry on first request', {
      error: error.message,
    });
  }
}
```

**Tareas:**
- [x] Warm-up de Ollama/Qwen al startup
- [x] Log de tiempo de warm-up
- [x] Si falla warm-up, continuar (retry on first request)

### 3.5.6: Consolidation (Fix #1 integrado)

**Tareas:**
- [x] Revisar `response-cache.ts` existente
- [x] Determinar si merge o deprecate (DEPRECATED - LocalRouter subsumes)
- [x] Unificar handling de respuestas determinísticas
- [x] Documentar decisión

---

## Fixes incluidos en esta fase

| Fix | Descripción | Cómo se resuelve |
|-----|-------------|------------------|
| **#1** | Wire response cache into brain.ts | Local Router subsume este concepto. Las respuestas determinísticas se manejan via DIRECT_TOOL. |
| **#3** | Don't record failures during model backoff | Aplicar mismo patrón al LocalRouter: si Ollama está en backoff, bypass silencioso a Brain sin penalizar. |

---

## Invariantes Críticos

1. **DirectToolExecutor usa `executeTool()`** - NO reimplementa lógica de tools
2. **Proactive loop SIEMPRE bypasea LocalRouter** - Solo procesa mensajes de usuario
3. **Fallback a Brain incluye contexto** - Brain sabe que hubo un intento fallido
4. **saveDirectResponse usa saveMessage()** - Mismo formato de history que Brain
5. **Validar modelo exacto de Ollama** - No solo prefix match

---

## Testing

### Unit tests (✅ 90 tests passing)
- [x] Classifier returns correct intent for each test case
- [x] Validation rules override correctly (incluir "no me dejes olvidar")
- [x] DirectExecutor calls `executeTool()` (mock y verificar)
- [x] Templates render correctly con variantes
- [x] Error handling for tool failures
- [x] Malformed JSON handling in classifier

**Test files:**
- `tests/local-router/classifier.test.ts` (12 tests)
- `tests/local-router/validation-rules.test.ts` (36 tests)
- `tests/local-router/direct-executor.test.ts` (21 tests)
- `tests/local-router/response-templates.test.ts` (18 tests)

**Run tests:**
```bash
npm run test:local-router       # Run all (90 tests, ~300ms)
npm run test:local-router:watch # Watch mode
```

### Integration tests
- [ ] Full flow: user input → LocalRouter → response
- [ ] Fallback: Ollama down → Brain handles request (backoff implemented)
- [ ] Fallback: Tool fails → Brain handles with context
- [ ] Feature flag: disabled → all goes to Brain
- [ ] Proactive loop: bypasses LocalRouter

### Regression tests
- [ ] Existing Brain behavior unchanged when LocalRouter disabled
- [ ] Proactive loop unaffected
- [ ] Memory extraction unaffected
- [ ] History format consistent (direct vs agentic)

---

## Rollout

1. **Feature flag OFF** - Deploy código, no activo
2. **Warm-up test** - Verificar que startup no se cuelga
3. **Canary** - Activar solo para `time` intent (trivial)
4. **Gradual** - Agregar intents uno por uno
5. **Full** - Todos los intents activos

---

## Métricas de éxito

| Métrica | Target |
|---------|--------|
| % requests handled locally | 30-40% |
| Latencia (local path) | < 1000ms |
| False positives in prod | 0 |
| Kimi cost reduction | ~30% |
| Fallback rate | < 5% |

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| Qwen clasifica mal | Validation rules + thresholds conservadores |
| Tool falla | Fallback a Brain con contexto |
| Respuestas robóticas | Templates con variantes random |
| Ollama no disponible | Bypass directo a Brain |
| Cold start lento | Warm-up al startup |
| Regresión en Brain | Feature flag + tests de regresión |
| Proactive loop afectado | Bypass explícito para proactive mode |
| History inconsistente | Usar saveMessage() con mismo formato |

---

## Referencias

- RFC: `plan/local-router-rfc.md`
- Spike code: `src/experiments/local-router-spike/`
- Memory Architecture: `plan/memory-architecture.md` (líneas 276, 284-296, 359)
- Tool registry: `src/tools/registry.ts`
- Date parser: `src/agent/proactive/date-parser.ts`

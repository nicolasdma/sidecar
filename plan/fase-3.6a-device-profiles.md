# Fase 3.6a: Device Profiles + Smart Router

> **Estado:** ⏳ Planificado
> **Prerequisitos:** Fase 3.5 completada, Ollama funcionando
> **Objetivo:** 80-90% de requests resueltos localmente (costo $0)
> **Última revisión:** 2026-02-01

---

## Contexto

Sidecar está diseñado para ser un **asistente personal de productividad**, no un coding assistant. Los casos de uso principales son:

| Categoría | Tasks |
|-----------|-------|
| **Lenguaje** | Traducción, corrección ortográfica, práctica de inglés |
| **Búsquedas** | Investigación web, información general |
| **Trabajo** | Emails, LinkedIn, Upwork, postulaciones, formularios |
| **Aprendizaje** | Inglés, conceptos de temas específicos |
| **Gestión** | Recordatorios, procesos |

**Problema actual:** Todo pasa por Kimi K2.5 (API de pago). Muchas tareas simples podrían resolverse localmente.

**Solución:** Device-aware architecture que maximiza uso de LLMs locales según capacidades del hardware.

---

## Objetivo

1. **Detectar automáticamente** las capacidades del dispositivo
2. **Asignar un tier** que determina qué modelos pueden correr
3. **Extender LocalRouter** para clasificar tasks y rutearlas al modelo local apropiado
4. **Hot-swap de modelos** para optimizar uso de RAM
5. **Métricas** de uso local vs API

**Meta:** Reducir costos de API en 80-90% para uso típico.

---

## Arquitectura

### Diagrama General

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         DEVICE-AWARE SIDECAR                             │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  STARTUP                                                         │    │
│  │                                                                  │    │
│  │  1. Detect device capabilities (RAM, CPU, GPU)                   │    │
│  │  2. Assign tier (minimal → server)                               │    │
│  │  3. Configure available models                                   │    │
│  │  4. Load classifier model (always Qwen2.5:3b)                   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  SMART ROUTER v2                                                 │    │
│  │                                                                  │    │
│  │  Input ──► Intent Classifier (Qwen2.5:3b)                       │    │
│  │                    │                                             │    │
│  │                    ▼                                             │    │
│  │  ┌─────────────────────────────────────────────────────────┐    │    │
│  │  │  TIER 1: DETERMINISTIC (0ms, $0)                        │    │    │
│  │  │  - time, weather, reminders → Direct execution          │    │    │
│  │  └─────────────────────────────────────────────────────────┘    │    │
│  │                    │ (si no matchea)                             │    │
│  │                    ▼                                             │    │
│  │  ┌─────────────────────────────────────────────────────────┐    │    │
│  │  │  TIER 2: LOCAL LLM ($0, ~2-5s)                          │    │    │
│  │  │  - translate      → best_local_model                    │    │    │
│  │  │  - grammar_fix    → best_local_model                    │    │    │
│  │  │  - simple_chat    → best_local_model                    │    │    │
│  │  │  - summarize      → best_local_model                    │    │    │
│  │  │  - explain        → best_local_model                    │    │    │
│  │  └─────────────────────────────────────────────────────────┘    │    │
│  │                    │ (si falla, timeout, o complejo)             │    │
│  │                    ▼                                             │    │
│  │  ┌─────────────────────────────────────────────────────────┐    │    │
│  │  │  TIER 3: API ($$, ~1-3s)                                │    │    │
│  │  │  - multi-step reasoning                                  │    │    │
│  │  │  - tool chains complejos                                 │    │    │
│  │  │  - web search + analysis                                 │    │    │
│  │  │  - cuando local falla                                    │    │    │
│  │  └─────────────────────────────────────────────────────────┘    │    │
│  │                                                                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  MODEL MANAGER                                                   │    │
│  │                                                                  │    │
│  │  - Tracks loaded models                                          │    │
│  │  - Hot-swap: unload → load when switching                       │    │
│  │  - RAM monitoring                                                │    │
│  │  - Preload classifier on startup                                 │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  METRICS                                                         │    │
│  │                                                                  │    │
│  │  - requests_local / requests_api (ratio)                        │    │
│  │  - tokens_saved (vs if all went to API)                         │    │
│  │  - latency_local_avg / latency_api_avg                          │    │
│  │  - model_load_time_avg                                          │    │
│  │  - fallback_count (local failed → API)                          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Device Profiles

### Detección de Capacidades

```typescript
// src/device/profile.ts

interface DeviceCapabilities {
  ram: number;                              // GB total
  ramAvailable: number;                     // GB disponible
  cpu: 'x64' | 'arm64';                     // Arquitectura
  accelerator: 'metal' | 'cuda' | 'rocm' | 'cpu';  // GPU acceleration
  cores: number;                            // CPU cores
  diskFree: number;                         // GB libres
  os: 'darwin' | 'linux' | 'win32';
}

interface DeviceProfile {
  tier: DeviceTier;
  maxModelSize: ModelSize;
  concurrentModels: number;
  recommendedModels: string[];
  embeddingsLocal: boolean;
  classifierModel: string;
}

type DeviceTier = 'minimal' | 'basic' | 'standard' | 'power' | 'server';
type ModelSize = '1b' | '3b' | '7b' | '13b' | '70b';
```

### Tiers

| Tier | RAM | Max Model | Concurrent | Embeddings | Ejemplo Dispositivos |
|------|-----|-----------|------------|------------|---------------------|
| **Minimal** | <4GB | API only | 0 | API | Raspberry Pi 3, VPS 2GB |
| **Basic** | 4-8GB | 3B | 1 | Local | Raspberry Pi 4, laptops viejas |
| **Standard** | 8-16GB | 7B | 1 | Local | MacBook Air M1, laptops modernas |
| **Power** | 16-32GB | 13B | 2 | Local | MacBook Pro M1/M2, gaming PCs |
| **Server** | 32GB+ | 70B | 3+ | Local | Mac Studio, servidores |

### Lógica de Asignación

```typescript
function assignTier(capabilities: DeviceCapabilities): DeviceTier {
  const { ram, accelerator } = capabilities;

  // RAM es el factor principal
  if (ram < 4) return 'minimal';
  if (ram < 8) return 'basic';
  if (ram < 16) return 'standard';
  if (ram < 32) return 'power';
  return 'server';
}

function getProfile(tier: DeviceTier): DeviceProfile {
  const profiles: Record<DeviceTier, DeviceProfile> = {
    minimal: {
      tier: 'minimal',
      maxModelSize: '1b',
      concurrentModels: 0,
      recommendedModels: [],
      embeddingsLocal: false,
      classifierModel: 'none', // API only
    },
    basic: {
      tier: 'basic',
      maxModelSize: '3b',
      concurrentModels: 1,
      recommendedModels: ['qwen2.5:3b-instruct'],
      embeddingsLocal: true,
      classifierModel: 'qwen2.5:3b-instruct',
    },
    standard: {
      tier: 'standard',
      maxModelSize: '7b',
      concurrentModels: 1,
      recommendedModels: ['qwen2.5:7b-instruct', 'mistral:7b-instruct', 'gemma2:9b'],
      embeddingsLocal: true,
      classifierModel: 'qwen2.5:3b-instruct',
    },
    power: {
      tier: 'power',
      maxModelSize: '13b',
      concurrentModels: 2,
      recommendedModels: ['qwen2.5:14b-instruct', 'llama3:13b', 'mixtral:8x7b'],
      embeddingsLocal: true,
      classifierModel: 'qwen2.5:3b-instruct',
    },
    server: {
      tier: 'server',
      maxModelSize: '70b',
      concurrentModels: 3,
      recommendedModels: ['qwen2.5:72b-instruct', 'llama3:70b'],
      embeddingsLocal: true,
      classifierModel: 'qwen2.5:7b-instruct', // Puede usar uno mejor
    },
  };

  return profiles[tier];
}
```

---

## Modelos Locales Recomendados

### Para Tier Standard (8-16GB) - Tu Mac M1 Pro

| Modelo | Tamaño | Especialidad | RAM | Latencia M1 |
|--------|--------|--------------|-----|-------------|
| **qwen2.5:3b-instruct** | 3B | Clasificador (siempre cargado) | ~2GB | ~500ms |
| **qwen2.5:7b-instruct** | 7B | General, español/inglés, tool calling | ~5GB | ~2s |
| **mistral:7b-instruct** | 7B | Conversación fluida | ~5GB | ~2s |
| **gemma2:9b** | 9B | Alta calidad, traducciones | ~7GB | ~3s |

**Estrategia para 16GB:**
- Clasificador (qwen2.5:3b): Siempre cargado (~2GB)
- Un modelo de 7B a la vez (~5GB)
- Hot-swap cuando cambia el tipo de task

**RAM Budget:**
```
OS + Apps:        ~6GB
Sidecar Core:     ~1GB
Embeddings:       ~0.5GB
Clasificador:     ~2GB
Modelo activo:    ~5GB
Buffer:           ~1.5GB
─────────────────────────
Total:            ~16GB ✓
```

### Instalación

```bash
# Clasificador (ya instalado)
ollama pull qwen2.5:3b-instruct

# Modelos de trabajo
ollama pull qwen2.5:7b-instruct
ollama pull mistral:7b-instruct
ollama pull gemma2:9b
```

---

## Smart Router v2

### Intents Extendidos

| Intent | Tier | Modelo | Ejemplo |
|--------|------|--------|---------|
| `time` | Deterministic | - | "qué hora es" |
| `weather` | Deterministic | - | "clima en Madrid" |
| `reminder` | Deterministic | - | "recordame en 10 min" |
| `list_reminders` | Deterministic | - | "mis recordatorios" |
| `cancel_reminder` | Deterministic | - | "cancela el de las pastas" |
| `translate` | Local LLM | gemma2:9b | "traduce esto al inglés" |
| `grammar_check` | Local LLM | qwen2.5:7b | "corrige la ortografía" |
| `summarize` | Local LLM | qwen2.5:7b | "resume este texto" |
| `explain` | Local LLM | gemma2:9b | "explícame qué es X" |
| `simple_chat` | Local LLM | mistral:7b | "hola, cómo estás" |
| `complex` | API | Kimi K2.5 | Requiere tools, multi-step |

### Clasificación Extendida

```typescript
// Prompt del clasificador extendido
const CLASSIFIER_PROMPT_V2 = `
Clasifica el intent del usuario. Responde SOLO con JSON.

Intents disponibles:
- time: preguntas sobre la hora
- weather: preguntas sobre el clima
- reminder: crear un recordatorio
- list_reminders: ver recordatorios
- cancel_reminder: cancelar un recordatorio
- translate: traducir texto
- grammar_check: corregir ortografía/gramática
- summarize: resumir un texto
- explain: explicar un concepto
- simple_chat: saludo o conversación simple
- complex: requiere búsqueda web, múltiples pasos, o herramientas

Responde: {"intent": "...", "params": {...}, "confidence": 0.0-1.0}
`;
```

### Routing Logic

```typescript
interface RouteDecision {
  tier: 'deterministic' | 'local' | 'api';
  model?: string;
  intent: string;
  confidence: number;
}

async function route(input: string, profile: DeviceProfile): Promise<RouteDecision> {
  // 1. Clasificar intent
  const classification = await classifier.classify(input);

  // 2. Aplicar validation rules (ya existentes)
  const validated = applyValidationRules(classification, input);

  // 3. Determinar tier y modelo
  if (DETERMINISTIC_INTENTS.includes(validated.intent)) {
    return { tier: 'deterministic', intent: validated.intent, confidence: validated.confidence };
  }

  if (LOCAL_INTENTS.includes(validated.intent) && profile.tier !== 'minimal') {
    const model = selectLocalModel(validated.intent, profile);
    return { tier: 'local', model, intent: validated.intent, confidence: validated.confidence };
  }

  // Fallback a API
  return { tier: 'api', intent: validated.intent, confidence: validated.confidence };
}

function selectLocalModel(intent: string, profile: DeviceProfile): string {
  // Mapeo de intents a modelos preferidos
  const preferences: Record<string, string[]> = {
    translate: ['gemma2:9b', 'qwen2.5:7b-instruct'],
    grammar_check: ['qwen2.5:7b-instruct', 'mistral:7b-instruct'],
    summarize: ['qwen2.5:7b-instruct', 'mistral:7b-instruct'],
    explain: ['gemma2:9b', 'qwen2.5:7b-instruct'],
    simple_chat: ['mistral:7b-instruct', 'qwen2.5:7b-instruct'],
  };

  // Elegir el primero disponible que no exceda el tier
  const candidates = preferences[intent] || profile.recommendedModels;
  const available = candidates.find(m => isModelAvailable(m));

  // CRÍTICO: Manejar caso de ningún modelo disponible
  if (!available) {
    const fallback = profile.recommendedModels.find(m => isModelAvailable(m));
    if (!fallback) {
      throw new NoModelsAvailableError(
        `No hay modelos locales disponibles. Instala uno:\n` +
        `  ollama pull ${profile.recommendedModels[0] || 'qwen2.5:7b-instruct'}`
      );
    }
    return fallback;
  }

  return available;
}
```

---

## Ollama Health Check (Crítico)

Antes de cualquier operación con LLMs locales, verificar disponibilidad de Ollama:

```typescript
// src/device/ollama-health.ts

interface OllamaHealthStatus {
  available: boolean;
  version?: string;
  modelsLoaded: string[];
  error?: string;
}

async function checkOllamaHealth(): Promise<OllamaHealthStatus> {
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(3000), // 3s timeout
    });

    if (!response.ok) {
      return { available: false, modelsLoaded: [], error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    return {
      available: true,
      modelsLoaded: data.models?.map((m: any) => m.name) || [],
    };
  } catch (error) {
    return {
      available: false,
      modelsLoaded: [],
      error: error instanceof Error ? error.message : 'Connection failed',
    };
  }
}

// Llamar al startup y mostrar mensaje claro
async function ensureOllamaAvailable(): Promise<void> {
  const health = await checkOllamaHealth();

  if (!health.available) {
    logger.warn('═══════════════════════════════════════════════════════════');
    logger.warn('⚠️  Ollama no está corriendo. Features de LLM local deshabilitados.');
    logger.warn('   Para habilitar: ollama serve');
    logger.warn('   Todas las requests irán a API (con costo).');
    logger.warn('═══════════════════════════════════════════════════════════');
    return;
  }

  if (health.modelsLoaded.length === 0) {
    logger.warn('⚠️  Ollama está corriendo pero no hay modelos instalados.');
    logger.warn('   Instala al menos uno: ollama pull qwen2.5:7b-instruct');
  }

  logger.info(`✓ Ollama disponible con ${health.modelsLoaded.length} modelos`);
}
```

---

## Model Manager

### Responsabilidades

1. **Track de modelos cargados** en Ollama
2. **Hot-swap** cuando se necesita un modelo diferente
3. **Preload** del clasificador al startup
4. **Verificación** de modelos disponibles
5. **Health check** de Ollama (nuevo)

### Interfaz

```typescript
// src/device/model-manager.ts

interface ModelManager {
  // Estado
  getLoadedModels(): Promise<string[]>;
  isModelLoaded(model: string): Promise<boolean>;
  isModelAvailable(model: string): Promise<boolean>;

  // Operaciones
  preloadClassifier(): Promise<void>;
  ensureLoaded(model: string): Promise<void>;  // Hot-swap si necesario
  unload(model: string): Promise<void>;

  // Info
  getModelInfo(model: string): Promise<ModelInfo>;
  getMemoryUsage(): Promise<MemoryUsage>;
}

interface ModelInfo {
  name: string;
  size: string;        // "7b", "13b"
  quantization: string; // "q4_0", "q8_0"
  ramRequired: number; // GB estimado
}

interface MemoryUsage {
  total: number;
  used: number;
  available: number;
  modelsLoaded: { name: string; ram: number }[];
}
```

### Hot-Swap Logic

```typescript
async function ensureLoaded(model: string): Promise<void> {
  if (await this.isModelLoaded(model)) {
    return; // Ya está cargado
  }

  const memUsage = await this.getMemoryUsage();
  const modelInfo = await this.getModelInfo(model);

  // ¿Hay espacio?
  if (memUsage.available < modelInfo.ramRequired) {
    // Descargar modelos que no son el clasificador
    const toUnload = memUsage.modelsLoaded
      .filter(m => m.name !== this.classifierModel)
      .sort((a, b) => b.ram - a.ram); // Más grandes primero

    for (const m of toUnload) {
      await this.unload(m.name);
      const newUsage = await this.getMemoryUsage();
      if (newUsage.available >= modelInfo.ramRequired) break;
    }
  }

  // Cargar el modelo (Ollama lo hace con el primer request)
  await this.warmup(model);
}
```

---

## Métricas

### Datos a Trackear

```typescript
// src/device/metrics.ts

interface RouterMetrics {
  // Contadores
  requestsTotal: number;
  requestsDeterministic: number;
  requestsLocal: number;
  requestsApi: number;

  // Fallbacks
  localToApiFallbacks: number;  // Local falló → API

  // Tokens (estimados)
  tokensProcessedLocal: number;
  tokensSavedVsApi: number;     // Si todo fuera API

  // Latencia
  latencyDeterministicAvg: number;
  latencyLocalAvg: number;
  latencyApiAvg: number;

  // Modelos
  modelLoadCount: number;
  modelLoadTimeAvg: number;

  // Por intent
  intentBreakdown: Record<string, {
    count: number;
    successRate: number;
    avgLatency: number;
  }>;
}
```

### Comando `/router-stats` Extendido

```
/router-stats

┌─────────────────────────────────────────────────────────────┐
│  Smart Router Stats                                          │
│                                                              │
│  Device: MacBook Pro M1 Pro (16GB)                          │
│  Tier: Standard                                              │
│  Classifier: qwen2.5:3b-instruct (loaded)                   │
│  Active Model: qwen2.5:7b-instruct                          │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  Requests (last 24h):                                        │
│    Total:         127                                        │
│    Deterministic: 45  (35%)  ████████░░░░░░░░░░░░  ~0ms     │
│    Local LLM:     62  (49%)  ████████████░░░░░░░░  ~2.1s    │
│    API:           20  (16%)  ████░░░░░░░░░░░░░░░░  ~1.8s    │
│                                                              │
│  Cost Savings:                                               │
│    Tokens saved:  ~45,000                                    │
│    Est. savings:  ~$0.12                                     │
│                                                              │
│  Fallbacks:                                                  │
│    Local → API:   3 (4.8% of local attempts)                │
│                                                              │
│  Model Swaps: 8                                              │
│  Avg swap time: 1.2s                                         │
│                                                              │
│  Top Intents:                                                │
│    simple_chat:   34  (local, 97% success)                  │
│    translate:     28  (local, 100% success)                 │
│    reminder:      22  (deterministic)                        │
│    time:          18  (deterministic)                        │
│    complex:       15  (api)                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Estructura de Archivos

```
sidecar/
├── src/
│   ├── device/
│   │   ├── index.ts            # Exports
│   │   ├── capabilities.ts     # Detección de hardware
│   │   ├── tiers.ts            # Definición de tiers y profiles
│   │   ├── model-manager.ts    # Hot-swap, preload, tracking
│   │   └── metrics.ts          # Estadísticas de routing
│   │
│   ├── agent/
│   │   └── local-router/
│   │       ├── index.ts        # (existente)
│   │       ├── classifier.ts   # (existente, extender prompt)
│   │       ├── router-v2.ts    # NUEVO: routing extendido
│   │       ├── local-executor.ts  # NUEVO: ejecuta con modelo local
│   │       └── ...
│   │
│   └── ...
│
├── data/
│   └── device-config.json      # Override manual de tier (opcional)
│
└── ...
```

---

## Orden de Implementación

### Día 1: Device Detection + Tiers

- [ ] `src/device/capabilities.ts`
  - Detectar RAM total y disponible
  - Detectar CPU architecture (arm64/x64)
  - Detectar GPU acceleration (Metal/CUDA/none)
  - Detectar OS

- [ ] `src/device/tiers.ts`
  - Definir los 5 tiers con sus profiles
  - Función `assignTier(capabilities)`
  - Función `getProfile(tier)`

- [ ] `src/device/index.ts`
  - Export de `getDeviceProfile()`
  - Logging al startup del tier detectado

- [ ] Tests unitarios para tiers

### Día 2: Model Manager

- [ ] `src/device/model-manager.ts`
  - `getLoadedModels()` via Ollama API
  - `isModelAvailable()` via Ollama API
  - `ensureLoaded()` con hot-swap logic
  - `unload()` si es necesario
  - `getMemoryUsage()`

- [ ] Integración con startup
  - Preload clasificador
  - Log de modelos disponibles

- [ ] Tests unitarios con mocks de Ollama

### Día 3: Smart Router v2

- [ ] Extender `classifier.ts`
  - Nuevos intents: translate, grammar_check, summarize, explain, simple_chat
  - Confidence threshold por intent

- [ ] `src/agent/local-router/router-v2.ts`
  - Lógica de routing a 3 tiers
  - Selección de modelo según intent
  - Integración con ModelManager

- [ ] `src/agent/local-router/local-executor.ts`
  - Ejecutar prompt con modelo local
  - Timeout handling
  - Fallback a API si falla

- [ ] Tests unitarios para nuevos intents

### Día 4: Métricas + Integración

- [ ] `src/device/metrics.ts`
  - Tracking de todas las métricas
  - Persistencia en SQLite (tabla `router_metrics`)
  - Agregación diaria

- [ ] Extender `/router-stats`
  - Mostrar device info
  - Mostrar breakdown por tier
  - Mostrar model swaps
  - Mostrar savings estimados

- [ ] Integración con Brain
  - Router v2 como paso previo a Brain
  - Fallback chain: Deterministic → Local → API

### Día 5: Testing + Polish

- [ ] Tests de integración
  - End-to-end con Ollama real
  - Hot-swap en diferentes escenarios
  - Fallback cuando local falla

- [ ] Edge cases **(CRÍTICOS)**
  - **Ollama no disponible al startup:**
    - Health check proactivo antes de intentar clasificar
    - Mensaje claro: "⚠️ Ollama no está corriendo. Ejecuta: ollama serve"
    - Graceful degradation a API (con log visible, no silencioso)
  - **Ningún modelo instalado:**
    - Validación explícita en `selectLocalModel()`
    - Throw error con instrucciones: "Instala un modelo: ollama pull qwen2.5:7b-instruct"
    - NO retornar undefined ni crashear silenciosamente
  - Modelo específico no instalado → log warning, usar siguiente disponible
  - RAM insuficiente → no intentar cargar, ir a API con log explicativo

- [ ] Documentación
  - Actualizar PLAN.md
  - Actualizar README con requisitos de hardware

---

## Criterios de Verificación

### Funcionalidad Core

- [ ] Device tier se detecta correctamente al startup
- [ ] Log muestra: "Device: [name], Tier: [tier], RAM: [X]GB"
- [ ] Clasificador se precarga al startup
- [ ] Nuevos intents (translate, grammar_check, etc.) se clasifican correctamente
- [ ] Routing a modelo local funciona para intents soportados
- [ ] Fallback a API funciona cuando local falla
- [ ] Hot-swap descarga modelo anterior antes de cargar nuevo

### Métricas

- [ ] `/router-stats` muestra breakdown por tier
- [ ] Porcentaje de requests locales es visible
- [ ] Tokens saved se calcula (estimado)
- [ ] Intent breakdown muestra success rate

### Edge Cases

- [ ] Si Ollama no está corriendo → todo va a API (graceful degradation)
- [ ] Si modelo no está instalado → warning + usa siguiente disponible
- [ ] Si RAM insuficiente para modelo → no intenta cargar, va a API
- [ ] Timeout en modelo local (>30s) → fallback a API

### Performance

- [ ] Clasificación <1s (ya funciona)
- [ ] Modelo local responde en <5s para prompts cortos
- [ ] Hot-swap completa en <3s
- [ ] No memory leaks en uso prolongado

---

## Validation Rules Adicionales

```typescript
// Reglas para nuevos intents

// translate: debe tener texto a traducir
intent === 'translate' && input.length < 10 → ROUTE_TO_LLM (muy corto, ambiguo)

// grammar_check: debe tener texto a corregir
intent === 'grammar_check' && input.length < 5 → ROUTE_TO_LLM

// summarize: texto muy corto no tiene sentido resumir
intent === 'summarize' && input.length < 100 → ROUTE_TO_LLM

// explain: términos muy técnicos pueden requerir búsqueda
intent === 'explain' && containsTechnicalTerms(input) → considerar API

// simple_chat: si menciona búsqueda o herramientas → complex
intent === 'simple_chat' && /\b(busca|encuentra|googlea)\b/i.test(input) → complex
```

---

## Configuración Manual (Opcional)

Para override del tier autodetectado:

```json
// data/device-config.json
{
  "tierOverride": "power",  // Forzar tier específico
  "maxRamForModels": 8,     // Limitar RAM para modelos (GB)
  "preferredModels": [      // Override de modelos preferidos
    "mistral:7b-instruct",
    "qwen2.5:7b-instruct"
  ],
  "disableLocalLLM": false  // Forzar todo a API
}
```

**Comando para configurar:**
```
/device-config

Current: Auto-detected (Standard tier, 16GB)
Options:
  1. Keep auto-detect
  2. Force tier: [minimal/basic/standard/power/server]
  3. Limit RAM for models: [X GB]
  4. Disable local LLM (API only)
```

---

## Futuro (No en Fase 3.6a)

Ideas para fases posteriores:

- **Auto-calibración:** Si un modelo falla mucho en cierto intent, ajustar routing automáticamente
- **Model download on-demand:** Si usuario necesita translate pero no tiene gemma2, ofrecerle instalarlo
- **Queue de requests:** Si modelo está ocupado, encolar en vez de fallar
- **Batch processing:** Agrupar requests similares para eficiencia
- **Remote Ollama:** Conectar a Ollama en otra máquina de la red local

---

## Decisiones Diferidas

| Decisión | Por qué diferida | Trigger para implementar |
|----------|------------------|--------------------------|
| Remote Ollama support | Complejidad de red | Cuando usuario tenga server separado |
| Model auto-download | UX de descarga grande | Cuando usuarios pidan modelos faltantes |
| Per-intent model calibration | Necesita datos de uso real | Después de 1000+ requests |
| GPU memory monitoring | Solo relevante para CUDA | Cuando soporte Windows/Linux con GPU |

---

## Changelog

### 2026-02-01 - Análisis de riesgos integrado
- Agregado Ollama Health Check con código de referencia
- Actualizado `selectLocalModel()` para manejar caso de ningún modelo disponible
- Edge cases marcados como CRÍTICOS con mitigaciones específicas
- Mensajes de error claros para el usuario

### 2026-02-01 - Documento inicial
- Definición de Device Profiles y Tiers
- Smart Router v2 con routing a modelos locales
- Model Manager con hot-swap
- Métricas de uso
- Orden de implementación (5 días)
- Criterios de verificación

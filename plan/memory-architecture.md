# Arquitectura de Memoria y Contexto

> "El agente debe ser agresivo en olvidar y quirúrgico en recordar."
> "La memoria perfecta es un anti-patrón."

## Principios Fundamentales

- El prompt NO puede crecer linealmente con el tiempo: O(1), no O(n)
- Toda información debe justificar su presencia en el prompt
- Más contexto ≠ mejor respuesta
- La memoria sirve al agente, no al revés

---

## 1. Tipos de Memoria

### 1.1 Memoria Factual (Persistente)

**Dónde vive:** SQLite, tabla `facts`

**Estructura:**
```
{
  id: string
  domain: "work" | "preferences" | "decisions" | "personal" | "projects"
  fact: string
  confidence: "high" | "medium" | "low"
  created_at: timestamp
  last_confirmed_at: timestamp  // Para confidence decay
  source: "explicit" | "inferred"
}
```

**Ejemplos concretos:**

| Input del usuario | Fact almacenado |
|-------------------|-----------------|
| "Trabajo en fintech, equipo de 5" | `{domain: "work", fact: "fintech company, team of 5", confidence: high, source: explicit}` |
| "Prefiero respuestas directas" | `{domain: "preferences", fact: "direct responses, no hedging", confidence: high, source: explicit}` |
| "Decidí usar Kimi K2.5" | `{domain: "decisions", fact: "primary LLM: Kimi K2.5", confidence: high, source: explicit}` |

**Cuándo se escribe:**
- Señal explícita: "recordá que...", "siempre...", "decidí...", "a partir de ahora..."
- Cambio de estado verificable
- NUNCA por inferencia de conversación casual

**Cuándo se lee:**
- Al inicio de cada sesión
- Se inyecta subset filtrado por dominio relevante a la query

**Confidence Decay (regla temporal):**
```
Si last_confirmed_at > 90 días Y confidence != high:
  → No inyectar automáticamente (requiere retrieval explícito)

Si last_confirmed_at > 180 días:
  → Marcar como "stale", no inyectar nunca
  → Requerir re-confirmación si se accede

Re-confirmación:
  → Usuario menciona el fact de nuevo → update last_confirmed_at
  → Usuario contradice el fact → soft delete + crear nuevo
```

**Qué NUNCA vuelve al prompt:**
- Facts marcados como stale
- Facts con confidence: low que no fueron re-confirmados en 30 días
- Facts contradichos (soft deleted)

---

### 1.2 Memoria Conversacional (Efímera Estructurada)

**Dónde vive:** SQLite tabla `conversations` + cache en memoria para sesión activa

**Estructura por turno:**
```
{
  id: string
  session_id: string
  turn_number: int
  role: "user" | "assistant"
  content: string
  timestamp: timestamp
  token_count: int
  semantic_continuity: float  // 0-1, similarity con turno anterior
  summarized_at: timestamp | null
}
```

**Reglas de ventana activa:**

| Condición | Tamaño ventana |
|-----------|----------------|
| Default | 6 turnos |
| Alta continuidad semántica (similarity > 0.7 en últimos 2) | 8 turnos |
| Baja continuidad (chitchat, similarity < 0.3) | 4 turnos |

**Flujo de compresión:**
```
1. Turno sale de ventana activa
2. Extraer facts si los hay → tabla facts
3. Comprimir a resumen estructurado
4. Guardar resumen, descartar turno raw
```

---

### 1.3 Memoria Descartable (No Persistente)

**Dónde vive:** Logs en disco (`data/logs/`), TTL 24 horas

**Qué es descartable:**

| Categoría | Razón |
|-----------|-------|
| Tool execution logs | Resultado final basta |
| Intentos fallidos de parsing | Ruido |
| Respuestas intermedias en chains | Output final es lo que importa |
| Stack traces | Solo debugging humano |
| Token counts de responses | Metadata operativa |
| Embeddings temporales | Solo para retrieval, no contexto |

**Regla dura:** Si está etiquetado como descartable, tiene:
- TTL de 24 horas en disco
- CERO presencia en cualquier flujo de prompt
- NUNCA se re-lee por el agente

---

## 2. Context Pruning y Resumen

### 2.1 Parámetros Operativos

```
VENTANA_ACTIVA_DEFAULT = 6 turnos
VENTANA_ACTIVA_MIN = 4 turnos
VENTANA_ACTIVA_MAX = 8 turnos
MAX_TOKENS_VENTANA = 1200 tokens

RESUMEN_SEGMENT_SIZE = 3 turnos
MAX_RESUMENES = 4 segmentos
MAX_TOKENS_POR_RESUMEN = 50 tokens
TOTAL_RESUMENES_MAX = 200 tokens

MAX_CONTEXT_TOTAL = 4000 tokens
```

### 2.2 Triggers de Pruning

| Señal | Acción |
|-------|--------|
| `turn_count > VENTANA_ACTIVA` | Comprimir turno más viejo |
| `total_context_tokens > 3000` | Forzar resumen agresivo |
| Topic shift detectado | Cerrar segmento, nuevo resumen |
| Usuario dice "cambiemos de tema" | Flush ventana a resumen, reset |
| `semantic_continuity < 0.3` por 2 turnos | Reducir ventana a 4 |

### 2.3 Topic Shift Detection

**Definición operativa (no magia LLM):**

```
Topic shift = TRUE si:
  1. Cosine similarity entre turno actual y anterior < 0.4
  O
  2. Frase explícita del usuario:
     - "otra cosa"
     - "cambiando de tema"
     - "te quería preguntar sobre"
     - "dejando eso de lado"
  O
  3. Cambio de dominio detectado (work → personal, code → planning)
```

### 2.4 Formato de Resumen (Key-Value, NO Narrativo)

**MAL (genera drift):**
```
"Estuvimos hablando sobre varios temas de arquitectura y el usuario
mencionó que prefiere ciertas cosas..."
```

**BIEN (estable):**
```json
{
  "topic": "context management",
  "discussed": ["sliding window", "token limits", "pruning triggers"],
  "outcome": "decided sliding window of 6 turns",
  "decisions": ["use key-value summaries"],
  "open_questions": []
}
```

**Regla write-once:** Una vez comprimido, el resumen NO se re-resume. Se descarta cuando sale de los 4 slots.

---

## 3. System Prompt y Delta Mínimo

### 3.1 System Prompt Estático (~400 tokens)

```
BLOQUE 1: Identidad y rol (80 tokens)
├── Quién es el agente
├── Para quién trabaja
└── Tono y estilo

BLOQUE 2: Capacidades y herramientas (120 tokens)
├── Lista de tools disponibles
└── Formato de invocación

BLOQUE 3: Reglas duras (100 tokens)
├── Qué nunca hacer
└── Límites de autonomía

BLOQUE 4: Formato de respuesta (100 tokens)
├── Estructura esperada
└── Cuándo pedir clarificación
```

**Este bloque es IDÉNTICO en cada request.** Se cachea si el provider lo soporta.

### 3.2 Delta Mínimo por Request

| Componente | Tokens | Condición |
|------------|--------|-----------|
| Facts relevantes | 50-150 | Siempre (filtrados) |
| Resúmenes activos | 0-200 | Si existen |
| Ventana activa | 600-1200 | Siempre |
| Tool results pendientes | 0-300 | Si hay ejecución |
| **TOTAL DELTA** | **650-1850** | |

### 3.3 Qué NO se Repite

| Elemento | Condición para omitir |
|----------|----------------------|
| Descripción completa de tools | Ya usados en sesión |
| Facts mencionados | En últimos 3 turnos |
| Instrucciones de formato | Output anterior pasó validación estructural |
| Ejemplos few-shot | Primera respuesta fue correcta |

**Regla dura para formato:**
```
Omitir instrucciones de formato SOLO SI:
  1. Output anterior fue válido
  2. Pasó validación estructural
  3. No hubo error de parsing

Si cualquier condición falla → re-inyectar instrucciones
```

---

## 4. Qué NO se Envía al Modelo

| Categoría | Manejo Alternativo |
|-----------|-------------------|
| Logs de ejecución | `data/logs/`, grep manual |
| Debug steps | Flag `--verbose` a stdout |
| Respuestas deterministas | Cache local, lookup pre-LLM |
| Estado interno del agente | Variables en memoria |
| Historial de errores | SQLite `errors`, solo último si es retry |
| Archivos completos | Solo fragmentos relevantes |
| Outputs de tools intermedios | Solo resultado final |

### 4.1 Flujo de Filtrado Pre-Prompt

```
1. Request entra
2. ¿Es determinista? → Cache hit → Return (sin LLM)
3. ¿Requiere tool? → Ejecutar tool → Solo resultado al prompt
4. Construir prompt:
   a. System prompt (cacheado)
   b. Facts filtrados por dominio
   c. Resúmenes (si existen)
   d. Ventana activa
5. Validar tokens < 4000
   → Si excede: comprimir resúmenes primero, luego reducir ventana
6. Llamar LLM
```

---

## 5. Caching y Batching

### 5.1 Qué se Cachea

| Tipo | TTL | Key |
|------|-----|-----|
| Respuestas factuales sobre usuario | 24h | `hash(query_normalizada)` |
| Tools idempotentes | 1h | `tool_name:hash(params)` |
| Embeddings de facts | Permanente | `fact_id` |
| System prompt compilado | Hasta cambio | `system_v{version}` |

### 5.2 Qué NO se Cachea

- Preguntas dependientes de tiempo ("qué hora es")
- Queries con estado emocional
- Tools con side effects
- Cualquier cosa con "ahora", "hoy", "recién"

### 5.3 Batching

| Escenario | Estrategia |
|-----------|------------|
| Múltiples tools en respuesta | Paralelo, esperar todas, un prompt |
| Flujo multi-step predecible | Prefetch siguiente paso |
| Actualización de facts | Batch write cada 5 min o al cerrar |

### 5.4 Dedup de Intención

```
Si usuario reformula misma pregunta:
  1. Detectar similarity > 0.85
  2. Retornar respuesta anterior
  3. Disclaimer generado por SISTEMA (no LLM):
     "[Respuesta recuperada de conversación anterior]"

El LLM NO genera el disclaimer (no gastar tokens explicando ahorro)
```

---

## 6. Estimación de Ahorro

| Métrica | Sin estrategia | Con estrategia |
|---------|----------------|----------------|
| Tokens/request (20 turnos) | ~8000 | ~1500 |
| Crecimiento | O(n) lineal | O(1) constante |
| Facts re-enviados | 100% cada turno | ~30% filtrados |
| Ruido en contexto | Alto | Cero |

**Ahorro estimado: 80%+ en conversaciones largas**

---

## 7. Reglas Duras Consolidadas

### SÍ (Obligatorio)

- [ ] Extraer facts ANTES de descartar turnos
- [ ] Resumen en formato key-value estructurado
- [ ] Cachear respuestas deterministas
- [ ] Límite hard de 4000 tokens por request
- [ ] Filtrar facts por dominio relevante
- [ ] Confidence decay en facts antiguos
- [ ] Validar formato antes de omitir instrucciones
- [ ] Disclaimer de dedup generado por sistema

### NO (Prohibido)

- [ ] Guardar turnos completos indefinidamente
- [ ] Resumir en prosa narrativa
- [ ] Llamar LLM para lookups cacheables
- [ ] Crecer contexto linealmente
- [ ] Inyectar todos los facts siempre
- [ ] Mantener facts sin re-confirmación > 180 días
- [ ] Omitir formato sin validación previa
- [ ] Gastar tokens explicando que se ahorran tokens

---

## 8. Ejemplo: Flujo de Request Típica

```
Usuario: "¿Cómo quedó lo que decidimos ayer sobre el deployment?"

PASO 1 - LOOKUP
├── ¿Cache hit? → NO
├── ¿Fact relevante? → SÍ: domain=decisions, keyword=deployment
└── Fact encontrado: "decided k8s over docker-compose, 2024-01-30"

PASO 2 - CONSTRUIR PROMPT
├── System prompt: 400 tokens (cacheado)
├── Fact relevante: 20 tokens
├── Resumen sesión ayer: 40 tokens
│   └── {topic: "deployment", discussed: ["k8s", "compose"], outcome: "k8s"}
├── Ventana actual: 30 tokens (solo este mensaje)
└── TOTAL: ~490 tokens

PASO 3 - LLAMAR LLM
└── Response generada

PASO 4 - POST-PROCESS
├── ¿Nueva decisión? → NO
├── ¿Nuevo fact? → NO
├── ¿Re-confirmación de fact existente? → SÍ
│   └── UPDATE last_confirmed_at
└── Guardar turno en ventana

TOKENS USADOS: 490 (vs ~2000+ sin estrategia)
```

---

## 9. Implementación Progresiva

### Fase 1: Foundation
- [ ] Schema SQLite para facts con confidence decay
- [ ] Ventana deslizante básica (6 turnos fijos)
- [ ] Extracción de facts por señales explícitas

### Fase 2: Pruning Inteligente
- [ ] Resúmenes estructurados key-value
- [ ] Topic shift detection (similarity + keywords)
- [ ] Ventana adaptativa (4-8 según continuidad)

### Fase 3: Optimización
- [ ] Cache de respuestas deterministas
- [ ] Dedup de intención con disclaimer sistema
- [ ] Batching de writes a SQLite

### Fase 4: Refinamiento
- [ ] Métricas de token usage por sesión
- [ ] Alertas si contexto excede límites
- [ ] Dashboard de facts activos/stale

---

## Referencias

- Arquitectura diseñada para uso diario continuo
- Optimizada para Kimi K2.5 como modelo principal
- Compatible con cualquier LLM que soporte system prompts

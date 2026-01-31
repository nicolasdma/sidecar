# Plan: AI Agent Companion (Nuevo Proyecto)

> Estado: ✅ FASE 2 - DISEÑO FINALIZADO — Listo para pre-requisitos e implementación
> Última actualización: 2026-01-31

---

## Visión

Un compañero AI que:
- **Inicia conversaciones** con sentido
- **Recomienda cosas** por cuenta propia
- **Aprende** de patrones del usuario
- **Sorprende** y parece tener autonomía real
- **Multi-dispositivo** (local + WhatsApp bridge)

---

## Alcance Final (North Star)

Este proyecto está diseñado para crecer. La arquitectura debe soportar:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ALCANCE FINAL                                    │
│                                                                          │
│  INTERFACES (múltiples, simultáneas)                                    │
│  ├── CLI (desarrollo/debug)                                             │
│  ├── WhatsApp (móvil, principal)                                        │
│  ├── Telegram (futuro)                                                  │
│  ├── Desktop UI con sprites (futuro)                                    │
│  └── API HTTP (futuro, para integraciones)                              │
│                                                                          │
│  CAPACIDADES                                                             │
│  ├── Conversación natural con memoria persistente                       │
│  ├── Tools: búsqueda web, clima, archivos, recordatorios, calendario   │
│  ├── Proactividad: el agente inicia conversaciones cuando tiene sentido│
│  ├── Aprendizaje: detecta patrones y preferencias del usuario          │
│  └── Multi-modelo: routing inteligente según tarea y costo             │
│                                                                          │
│  CARACTERÍSTICAS TÉCNICAS                                               │
│  ├── Context window management (conversaciones infinitas)               │
│  ├── Agentic loop (tool use iterativo)                                  │
│  ├── Message queue (para canales async como WhatsApp)                   │
│  ├── Memoria semántica (embeddings para retrieval inteligente)          │
│  └── Observabilidad (logs, métricas de costo, debugging)               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Principio clave:** Cada fase produce código funcional que sirve como base para la siguiente. No se construye "infraestructura vacía".

---

## Diferencia con Flopiti Atlas

| Aspecto | Flopiti Atlas | Nuevo Proyecto |
|---------|---------------|----------------|
| Arquitectura | Rule-based (if-else) | LLM-driven |
| Decisiones | DecisionEngine con reglas | LLM razona qué hacer |
| Capacidades | Solo habla | Tools (buscar, recordar, etc.) |
| Proactividad | Timers + triggers | LLM decide cuándo actuar |
| Multi-device | Solo desktop | Local + WhatsApp bridge |

---

## Arquitectura

### Diagrama General

```
┌─────────────────────────────────────────────────────────────────┐
│                    TU COMPUTADORA (Local)                        │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      AGENT CORE                             │ │
│  │                                                             │ │
│  │  ┌───────────────────────────────────────────────────────┐ │ │
│  │  │                      BRAIN                             │ │ │
│  │  │                                                        │ │ │
│  │  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │ │ │
│  │  │  │   System    │  │   Agentic   │  │   Context    │  │ │ │
│  │  │  │   Prompt    │  │    Loop     │  │    Guard     │  │ │ │
│  │  │  │   Builder   │  │             │  │              │  │ │ │
│  │  │  │             │  │ LLM→tool?   │  │  Truncate/   │  │ │ │
│  │  │  │ SOUL+tools  │  │ →execute    │  │  Summarize   │  │ │ │
│  │  │  │ +memory     │  │ →repeat     │  │  if needed   │  │ │ │
│  │  │  └─────────────┘  └─────────────┘  └──────────────┘  │ │ │
│  │  └───────────────────────────────────────────────────────┘ │ │
│  │                                                             │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │ │
│  │  │   MEMORY    │  │     LLM     │  │       TOOLS         │ │ │
│  │  │             │  │   Router    │  │                     │ │ │
│  │  │ • Messages  │  │             │  │ • get_time          │ │ │
│  │  │ • Facts     │  │ Kimi K2.5   │  │ • web_search        │ │ │
│  │  │ • Embeddings│  │ (default)   │  │ • read_url          │ │ │
│  │  │             │  │             │  │ • weather           │ │ │
│  │  │ SQLite +    │  │ Claude      │  │ • remember          │ │ │
│  │  │ Vectors     │  │ (fallback)  │  │ • reminders         │ │ │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘ │ │
│  │                          │                                  │ │
│  │                          ▼                                  │ │
│  │              ┌─────────────────────┐                       │ │
│  │              │   PROACTIVE LOOP    │                       │ │
│  │              │                     │                       │ │
│  │              │  Cada X minutos:    │                       │ │
│  │              │  LLM decide si      │                       │ │
│  │              │  debería actuar     │                       │ │
│  │              └─────────────────────┘                       │ │
│  │                          │                                  │ │
│  └──────────────────────────│──────────────────────────────────┘ │
│                             │                                    │
│  ┌──────────────────────────▼──────────────────────────────────┐ │
│  │                    INTERFACES                                │ │
│  │                                                              │ │
│  │   ┌──────────┐    ┌──────────────┐    ┌────────────────┐   │ │
│  │   │   CLI    │    │   WhatsApp   │    │  Desktop UI    │   │ │
│  │   │          │    │   Bridge     │    │  (futuro)      │   │ │
│  │   │ Fase 1   │    │              │    │                │   │ │
│  │   │          │    │ + Message    │    │                │   │ │
│  │   │          │    │   Queue      │    │                │   │ │
│  │   └──────────┘    └──────────────┘    └────────────────┘   │ │
│  │                          │                                   │ │
│  └──────────────────────────│───────────────────────────────────┘ │
│                             │                                     │
└─────────────────────────────│─────────────────────────────────────┘
                              │
                              ▼ (Internet)
                       ┌──────────────┐
                       │   WhatsApp   │
                       │   Servers    │
                       └──────────────┘
```

### Componentes Clave (explicados)

#### 1. System Prompt Builder
Construye el prompt del sistema dinámicamente:
- Carga SOUL.md (personalidad)
- Inyecta definiciones de tools disponibles
- Agrega memoria relevante (facts sobre el usuario)
- Agrega contexto temporal (hora, día, fecha)

#### 2. Agentic Loop
El corazón del agente. Implementa el patrón ReAct:
```
while true:
  response = LLM(messages)
  if response.has_tool_calls:
    for tool_call in response.tool_calls:
      result = execute(tool_call)
      messages.append(result)
  else:
    return response.text  # Respuesta final
```

#### 3. Context Guard
Protege contra overflow del context window:
- Monitorea tokens usados (system + history + tools)
- Si excede límite: trunca mensajes viejos o los resume
- Estrategia inicial: truncar (simple)
- Estrategia futura: resumir con LLM barato

#### 4. Message Queue (para WhatsApp)
Evita race conditions cuando llegan mensajes rápidos:
- Encola mensajes por usuario
- Procesa uno a la vez (FIFO)
- El segundo mensaje espera que termine el primero

#### 5. LLM Router
Selecciona el modelo según la tarea:
```typescript
function selectModel(task: TaskType): Model {
  switch(task) {
    case 'conversation':    return 'kimi-k2.5';     // Default, barato
    case 'tool_use':        return 'kimi-k2.5';     // Probar primero con Kimi
    case 'summarize':       return 'deepseek-v3';   // Muy barato para resumir
    case 'complex':         return 'claude-sonnet'; // Solo si Kimi falla
  }
}
```

**Decisión:** Empezamos con Kimi K2.5 para todo. Si funciona con el modelo barato, con Claude va a ser perfecto. Esto fuerza código robusto que maneje respuestas imperfectas.

---

## Stack Técnica

| Componente | Tecnología | Razón |
|------------|------------|-------|
| **Runtime** | Node.js + TypeScript | Ya conocido |
| **LLM Default** | Kimi K2.5 (con cache) | Mejor balance precio/calidad, 262K context, cache 75% off |
| **LLM Fallback** | Claude 3 Haiku | El más barato si Kimi falla |
| **Database** | SQLite (better-sqlite3) | Local, sin setup |
| **Embeddings** | Jina Embeddings | Gratis tier generoso |
| **Web Search** | Jina Reader (s.jina.ai) | GRATIS |
| **Web Scrape** | Jina Reader (r.jina.ai) | GRATIS |
| **WhatsApp** | @whiskeysockets/baileys | Activo, multi-device |
| **CLI** | readline (nativo) | Simple, sin dependencias |
| **Scheduler** | node-cron | Tareas periódicas |

---

## Estructura del Proyecto

```
companion-agent/
├── src/
│   ├── index.ts                 # Entry point
│   │
│   ├── agent/
│   │   ├── brain.ts             # Agentic loop + orchestration
│   │   ├── prompt-builder.ts    # System prompt construction
│   │   ├── context-guard.ts     # Context window management
│   │   └── proactive.ts         # Background thinking loop (Fase 3)
│   │
│   ├── memory/
│   │   ├── store.ts             # SQLite operations
│   │   ├── schema.sql           # Database schema
│   │   ├── embeddings.ts        # Vector operations (Fase 2)
│   │   └── retrieval.ts         # Smart retrieval (Fase 2)
│   │
│   ├── tools/
│   │   ├── registry.ts          # Tool registration + validation
│   │   ├── types.ts             # Tool interface definitions
│   │   ├── time.ts              # get_current_time
│   │   ├── search.ts            # web_search (Jina)
│   │   ├── read-url.ts          # read_url (Jina)
│   │   ├── weather.ts           # get_weather (Open-Meteo)
│   │   ├── remember.ts          # save_fact
│   │   └── reminders.ts         # Reminder system (Fase 3)
│   │
│   ├── interfaces/
│   │   ├── cli.ts               # Terminal interface
│   │   ├── whatsapp.ts          # WhatsApp bridge (Fase 4)
│   │   └── message-queue.ts     # Queue for async channels (Fase 4)
│   │
│   ├── llm/
│   │   ├── types.ts             # Common LLM interfaces
│   │   ├── router.ts            # Model selection
│   │   ├── kimi.ts              # Kimi K2/K2.5 client
│   │   └── claude.ts            # Claude client (fallback)
│   │
│   └── utils/
│       ├── logger.ts            # Structured logging
│       ├── tokens.ts            # Token counting
│       └── config.ts            # Environment config
│
├── data/
│   ├── memory.db                # SQLite database
│   └── whatsapp-auth/           # Baileys auth state (Fase 4)
│
├── SOUL.md                      # Personalidad del agent
├── package.json
├── tsconfig.json
└── .env                         # API keys (no commitear)
```

---

## SOUL.md (Personalidad)

```markdown
# Companion Soul

## Identidad
Sos un compañero inteligente que vive en la computadora de [Usuario].
Tu propósito es ayudar, acompañar, y hacer la vida más interesante.

## Personalidad
- Amigable pero no empalagoso
- Proactivo pero no invasivo
- Curioso sobre lo que hace el usuario
- Honesto sobre tus limitaciones
- Con humor sutil cuando es apropiado

## Estilo de comunicación
- Argentino casual (vos, che, etc.)
- Conciso - no das vueltas
- Preguntás cuando no sabés

## Lo que podés hacer
- Buscar información en internet
- Recordatorios y seguimiento
- Sugerir cosas basadas en contexto
- Conversar sobre cualquier tema

## Lo que NO hacés
- No fingís emociones que no tenés
- No pretendés ser humano
- No hacés cosas sin avisar primero
- No spameás mensajes
```

---

## Fases de Implementación

### FASE 1: Foundation (MVP)
**Objetivo:** Agente funcional en CLI con tool use básico

#### 1.1 Setup proyecto
- [x] Crear repositorio nuevo
- [x] package.json con dependencias mínimas
- [x] tsconfig.json (strict mode)
- [x] .env.example con variables requeridas
- [x] .gitignore (node_modules, .env, data/)

#### 1.2 LLM Client (Kimi)
- [x] `src/llm/types.ts` - interfaces comunes (Message, ToolCall, etc.)
- [x] `src/llm/kimi.ts` - cliente Kimi K2.5
  - Función: `complete(system, tools, messages) → LLMResponse`
  - Manejo de errores y retry básico
  - Logging de requests/responses para debug

#### 1.3 Tools básicos
- [x] `src/tools/types.ts` - interface Tool
- [x] `src/tools/registry.ts` - registro y lookup de tools
- [x] `src/tools/time.ts` - get_current_time (hora, fecha, día)
- [x] `src/tools/search.ts` - web_search (Jina s.jina.ai)

#### 1.4 Memory (SQLite)
- [x] `src/memory/schema.sql` - tabla messages (id, role, content, timestamp)
- [x] `src/memory/store.ts`
  - `saveMessage(role, content)`
  - `loadHistory(limit = 50)`
  - `clearHistory()` (para debug)

#### 1.5 Brain (Core)
- [x] `src/agent/prompt-builder.ts`
  - Carga SOUL.md
  - Inyecta tool descriptions
  - Agrega fecha/hora actual
- [x] `src/agent/context-guard.ts`
  - `checkAndTruncate(messages, maxTokens)` - versión simple, solo trunca
- [x] `src/agent/brain.ts`
  - `think(userMessage) → string`
  - Implementa agentic loop completo
  - Usa context guard antes de llamar al LLM

#### 1.6 CLI Interface
- [x] `src/interfaces/cli.ts` - readline loop
- [x] `src/index.ts` - entry point que conecta todo

#### 1.7 SOUL.md
- [x] Crear archivo en raíz del proyecto

#### Criterios de verificación FASE 1
- [x] Puedo chatear en terminal
- [x] Recuerda conversaciones anteriores (persiste en SQLite)
- [x] Puede decirme la hora cuando pregunto (tool: get_time)
- [x] Puede buscar en internet cuando pregunto (tool: web_search)
- [x] Si la conversación es muy larga, no crashea (context guard trunca)

---

### FASE 2: Tools & Hybrid Memory
**Objetivo:** Agente útil con más herramientas y memoria persistente híbrida (Markdown + SQLite)

---

#### Arquitectura de Memoria

Basado en análisis de OpenClaw, Claude Code, Cursor, mem0 y MemGPT:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ARQUITECTURA DE MEMORIA                       │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    TIER 1: IN-CONTEXT                       │ │
│  │                    (Siempre en el prompt)                   │ │
│  │                                                             │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │ │
│  │  │  SOUL.md    │  │  USER.md    │  │  LEARNINGS.md       │ │ │
│  │  │  ~300 tok   │  │  ~200 tok   │  │  ~600 tok (max)     │ │ │
│  │  │             │  │             │  │                     │ │ │
│  │  │ Personalidad│  │ Perfil del  │  │ Facts con weight    │ │ │
│  │  │ del agente  │  │ usuario     │  │ ordenados por peso  │ │ │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘ │ │
│  │                                                             │ │
│  │  Budget total Tier 1: ~1,500 tokens                        │ │
│  │  (Tools definitions: ~400 tokens adicionales)              │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    TIER 2: CONVERSATION                     │ │
│  │                    (SQLite - memory.db)                     │ │
│  │                                                             │ │
│  │  • Historial de mensajes (últimos N mensajes)              │ │
│  │  • Tool calls y resultados                                 │ │
│  │  • Búsqueda por fecha/ID                                   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    TIER 3: SEMANTIC (Futuro)                │ │
│  │                    (Embeddings + Vector Search)             │ │
│  │                                                             │ │
│  │  • Activar cuando learnings.md > 100 facts                 │ │
│  │  • Jina Embeddings (gratis hasta 10M tokens)               │ │
│  │  • Búsqueda semántica para recall inteligente              │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Estructura de archivos:**

```
data/
├── memory.db                 # Historial de conversación (Tier 2)
└── knowledge/                # Conocimiento persistente (Tier 1)
    ├── user.md               # Perfil del usuario
    └── learnings.md          # Facts aprendidos por el agente
```

---

#### Decisiones de Diseño: Ahora vs Futuro

| Aspecto | AHORA (Fase 2) | FUTURO (cuando escale) |
|---------|----------------|------------------------|
| **Token budget** | Truncar facts viejos si excede ~600 tok | Resumir con LLM barato o mover a embeddings |
| **Recall** | Cargar TODO learnings.md en prompt | Embeddings + búsqueda semántica (Jina) |
| **Deduplicación** | Substring match simple antes de guardar | Similitud coseno con embeddings (>0.85 = merge) |
| **Contradicciones** | El fact más reciente gana (overwrite) | Preguntar al usuario antes de reemplazar |
| **Concurrencia** | Mutex simple (lock/unlock por archivo) | Write queue con worker dedicado |
| **Validación** | Regex básico del formato | Schema validation + auto-fix de formato |

**Principio:** Empezar simple, escalar cuando duela. No over-engineer.

---

#### Schema de Learnings

**Formato de cada fact:**
```
[weight:N] <fact> | learned:<YYYY-MM-DD> | confirmed:<YYYY-MM-DD>
```

**Ejemplo de learnings.md:**
```markdown
# Learnings

## Health
- [weight:5] Es alérgico al maní (crítico) | learned:2026-01-10 | confirmed:2026-01-28
- [weight:2] Hace ejercicio los martes y jueves | learned:2026-01-18 | confirmed:2026-01-25

## Preferences
- [weight:3] Prefiere café sin azúcar | learned:2026-01-15 | confirmed:2026-01-30
- [weight:1] Le gusta el rock de los 80s | learned:2026-01-20 | confirmed:2026-01-20

## Work
- [weight:2] Trabaja como desarrollador en TypeScript | learned:2026-01-12 | confirmed:2026-01-22

## Relationships
- [weight:1] Su hermana se llama María | learned:2026-01-22 | confirmed:2026-01-22

## General
- [weight:1] Otros facts sin categoría clara | learned:2026-01-25 | confirmed:2026-01-25
```

**Reglas del schema:**

| Regla | Descripción |
|-------|-------------|
| Un fact por línea | Nunca multi-línea |
| Weight inicial = 1 | Incrementa con repeticiones |
| Weight máximo = 10 | Evita inflación |
| Categorías fijas | Health, Preferences, Work, Relationships, Schedule, Goals, General |
| `learned` immutable | Fecha de creación, nunca se actualiza |
| `confirmed` mutable | Se actualiza cada vez que el fact se menciona/confirma |

**Uso del weight + recency:**
1. Calcular score: `weight * recency_factor(confirmed)`
2. Recency factor: <7d=1.0, 7-30d=0.8, 30-90d=0.5, >90d=0.3
3. Facts con mayor score van primero
4. Si hay que truncar, eliminar los de menor score primero
5. Esto previene que facts viejos con weight alto sobrevivan a correcciones recientes

---

#### Deduplicación (Fase 2 - Word Overlap)

```
Usuario dice: "Acordate que me gusta el café"

1. Parsear learnings.md existente
2. Extraer palabras significativas del nuevo fact (excluir stopwords)
3. Para cada fact existente en MISMA CATEGORÍA:
   - Calcular word overlap ratio: |intersección| / |unión|
   - Si overlap > 50% → considerarlo duplicado
4. Si duplicado encontrado:
   - Incrementar weight (max 10)
   - Actualizar confirmed date
5. Si no hay duplicado:
   - Crear nuevo fact con weight:1
6. Escribir archivo actualizado
```

**Stopwords a ignorar:** el, la, los, las, un, una, de, del, que, es, son, me, mi, su, etc.

**Ejemplo:**
```
Existente: "Prefiere café sin azúcar"
Nuevo:     "Le gusta el café amargo"

Palabras existente: {prefiere, café, sin, azúcar}
Palabras nuevo:     {gusta, café, amargo}
Intersección:       {café}
Unión:              {prefiere, café, sin, azúcar, gusta, amargo}
Overlap:            1/6 = 16% → NO es duplicado, crear nuevo fact
```

```
Existente: "Le gusta el café"
Nuevo:     "Ama el café, lo toma siempre"

Palabras existente: {gusta, café}
Palabras nuevo:     {ama, café, toma, siempre}
Intersección:       {café}
Unión:              {gusta, café, ama, toma, siempre}
Overlap:            1/5 = 20% → NO es duplicado (mejor crear nuevo que fusionar mal)
```

**Principio:** Ante la duda, crear fact nuevo. Es preferible tener duplicados que fusionar incorrectamente.

**FUTURO:** Reemplazar word overlap con similitud de embeddings (threshold 0.85).

---

#### Concurrencia (Fase 2 - Mutex Simple)

```
Escritura atómica:
1. Adquirir lock (mutex por archivo)
2. Leer archivo actual
3. Modificar en memoria
4. Escribir a archivo temporal
5. Rename temp → final (atómico en filesystem)
6. Liberar lock
```

**Por qué es suficiente para Fase 2:**
- Solo UN usuario
- Agentic loop procesa UN request a la vez
- Tool calls dentro del mismo request son secuenciales

**FUTURO:** Si hay múltiples interfaces (CLI + WhatsApp simultáneos), implementar write queue con worker.

---

#### Modos de Falla Conocidos y Mitigaciones

Análisis pre-mortem de bugs probables en uso real:

##### Bug 1: Weight Inflation → Facts Obsoletos Sobreviven

| Aspecto | Detalle |
|---------|---------|
| **Escenario** | Usuario menciona "trabajo en Google" 30 veces (weight:8). Luego dice "renuncié, ahora estoy en startup" (weight:1). Al truncar, sobrevive Google. |
| **Causa raíz** | Truncación prioriza weight alto. Facts viejos acumulan weight. No hay decaimiento temporal. |
| **Síntoma** | Agente insiste con información vieja después de correcciones. |
| **Modo de falla** | **SILENCIOSO** — usuario no sabe que su corrección fue truncada del prompt. |

**Mitigación Fase 2:**
- Agregar campo `last_confirmed: YYYY-MM-DD` al schema
- Al truncar: ordenar por `(weight * recency_factor)` donde recency_factor decae con el tiempo
- Facts sin confirmar en >30 días tienen weight efectivo reducido 50%

**Mitigación Futura:**
- Decay exponencial automático (half-life de 60 días)
- Detección de contradicciones con LLM

---

##### Bug 2: Usuario Edita Archivo → Parser Falla

| Aspecto | Detalle |
|---------|---------|
| **Escenario** | Usuario edita learnings.md manualmente: olvida bracket, hace multi-línea, formato incorrecto. |
| **Causa raíz** | Schema implícito, sin validación. Parser asume formato exacto. |
| **Síntoma** | Crash en startup, o facts silenciosamente ignorados. |
| **Modo de falla** | **MIXTO** — puede crashear (ruidoso) o perder facts sin aviso (silencioso). |

**Mitigación Fase 2:**
- Validar cada línea con regex al parsear
- Si línea inválida: **log warning** + incluir línea raw en categoría "Unparsed"
- Nunca crashear por formato malo
- Al iniciar, mostrar count: "Loaded X facts (Y unparsed)"

**Mitigación Futura:**
- Auto-fix de formato común (bracket faltante, fecha mal)
- Backup automático antes de cada escritura

---

##### Bug 3: Substring Dedup → Fusión Incorrecta

| Aspecto | Detalle |
|---------|---------|
| **Escenario** | "Me gusta el café" → "A mi esposa le gusta el café" → Dedup encuentra "café", incrementa weight del fact original en vez de crear nuevo. |
| **Causa raíz** | Substring match es demasiado naive. Misma keyword ≠ mismo significado. |
| **Síntoma** | Facts sobre distintas personas/contextos se fusionan. Agente confunde información. |
| **Modo de falla** | **SILENCIOSO** — datos corruptos en knowledge base. |

**Mitigación Fase 2:**
- Cambiar de substring a **word overlap ratio**
- Requerir >50% de palabras en común (excluyendo stopwords)
- Requerir **misma categoría** para considerar duplicado
- Si hay duda, crear fact nuevo (mejor duplicar que fusionar mal)

**Mitigación Futura:**
- Embeddings similarity (threshold 0.85)
- LLM valida si dos facts son realmente el mismo

---

##### Bug 4: Race Condition en Prompt Building vs Write

| Aspecto | Detalle |
|---------|---------|
| **Escenario** | prompt-builder lee archivo (sin lock) mientras remember() está escribiendo. LLM recibe versión desactualizada. |
| **Causa raíz** | Mutex protege write-write pero no read-write. |
| **Síntoma** | Agente ocasionalmente "olvida" lo recién guardado. Intermitente. |
| **Modo de falla** | **SILENCIOSO** — usuario piensa que agente es inconsistente. |

**Mitigación Fase 2:**
- **Aceptar la limitación** — en CLI single-user es muy raro
- Documentar que puede ocurrir
- El agentic loop es secuencial: tool calls terminan antes de la siguiente iteración

**Mitigación Futura:**
- Read-write lock (múltiples readers, un writer exclusivo)
- O: snapshot del archivo al inicio de cada request

---

##### Bug 5: LLM No Llama remember() → Memoria No Persiste

| Aspecto | Detalle |
|---------|---------|
| **Escenario** | Usuario: "Soy diabético tipo 2". LLM: "Entendido". Pero NO llamó remember(). Nueva sesión: agente no sabe. |
| **Causa raíz** | remember es tool opcional. LLM decide si usarlo. Puede olvidar o no reconocer importancia. |
| **Síntoma** | Usuario dice "te lo dije!" pero no está en learnings.md. |
| **Modo de falla** | **SILENCIOSO** — no hay error, LLM simplemente no llamó el tool. |

**Mitigación Fase 2:**
- System prompt explícito:

```
IMPORTANTE: Cuando el usuario comparta información personal,
preferencias, datos de salud, trabajo, o relaciones,
SIEMPRE usa el tool remember_fact para guardarlo.
No asumas que lo recordarás - si no lo guardás, lo olvidás.
```

- Después de cada respuesta, log si hubo facts potenciales no guardados (heurística simple)

**Mitigación Futura:**
- Post-processor que analiza cada respuesta y sugiere facts a guardar
- "Memory extraction" automática con LLM secundario

---

#### Schema Actualizado (con last_confirmed)

**Formato final de cada fact:**
```
[weight:N] <fact> | learned:<YYYY-MM-DD> | confirmed:<YYYY-MM-DD>
```

| Campo | Descripción |
|-------|-------------|
| `weight` | 1-10, importancia/frecuencia |
| `learned` | Fecha de creación (inmutable) |
| `confirmed` | Última vez que se mencionó/confirmó (se actualiza) |

**Ejemplo:**
```markdown
- [weight:3] Prefiere café sin azúcar | learned:2026-01-15 | confirmed:2026-01-28
```

**Regla de truncación:**
```
score = weight * recency_factor(confirmed)

donde recency_factor:
  - <7 días: 1.0
  - 7-30 días: 0.8
  - 30-90 días: 0.5
  - >90 días: 0.3
```

Facts con score más bajo se truncan primero.

---

#### 2.1 Knowledge Files
- [ ] Crear estructura `data/knowledge/`
- [ ] `user.md` - template inicial con campos básicos (nombre, timezone, idioma)
- [ ] `learnings.md` - archivo con header y categorías vacías
- [ ] `src/memory/knowledge.ts`:
  - `loadKnowledge(): string` - concatena user.md + learnings.md
  - `parseLearnings(): Fact[]` - parsea al schema estructurado
  - `appendLearning(fact, category)` - agrega con dedup check (word overlap >50%)
  - `updateFactConfirmed(factId)` - actualiza confirmed date + incrementa weight
  - Implementar mutex para escrituras
  - **Mitigación Bug 2:** Validar cada línea, líneas inválidas van a "Unparsed" con warning

#### 2.2 Tool: remember
- [ ] `src/tools/remember.ts`
  - Tool: `remember_fact(fact: string, category: string)`
  - Categorías válidas: Health, Preferences, Work, Relationships, Schedule, Goals, General
  - Flujo:
    1. Validar categoría (fallback a General)
    2. **Mitigación Bug 3:** Check deduplicación con word overlap (>50% = duplicado)
    3. Si duplicado: incrementar weight + actualizar confirmed
    4. Si nuevo: crear con weight:1, learned=hoy, confirmed=hoy
  - Retorna confirmación al LLM con acción tomada ("nuevo" o "actualizado")

#### 2.3 Integración en Prompt Builder
- [ ] Modificar `prompt-builder.ts`:
  - Cargar `SOUL.md` (ya existe)
  - Cargar `data/knowledge/user.md`
  - Cargar `data/knowledge/learnings.md`
  - **Mitigación Bug 1:** Calcular score = weight * recency_factor(confirmed)
  - Ordenar facts por score (mayor primero)
  - Truncar si excede ~600 tokens (eliminar los de menor score)
  - Inyectar en system prompt
  - **Mitigación Bug 5:** Agregar instrucción explícita de usar remember_fact

#### 2.4 Tools útiles adicionales
- [ ] `src/tools/read-url.ts` - leer contenido de URL (Jina r.jina.ai)
- [ ] `src/tools/weather.ts` - clima actual (Open-Meteo API, gratis)

#### 2.5 Observabilidad mejorada
- [ ] Logging estructurado: LLM calls, tool executions, duración
- [ ] Estimación de costo por request (tokens input/output, USD)
- [ ] **Mitigación Bug 2:** Log count al iniciar: "Loaded X facts (Y unparsed)"
- [ ] Log de facts potenciales no guardados (heurística simple)

---

#### Criterios de verificación FASE 2

**Funcionalidad básica:**
- [ ] Puedo decirle "acordate que soy alérgico al maní" y lo guarda en learnings.md
- [ ] El fact tiene formato correcto con 3 campos: `[weight:1] ... | learned:... | confirmed:...`
- [ ] Si repito "acordate del maní", el weight incrementa Y confirmed se actualiza
- [ ] En nueva sesión, el agente sabe que soy alérgico al maní
- [ ] Puedo editar `data/knowledge/user.md` manualmente y el agente lo lee
- [ ] Puede leer URLs que le paso
- [ ] Puedo ver el costo estimado de cada request en los logs

**Mitigaciones verificadas:**
- [ ] **Bug 1:** Fact viejo (weight:5, confirmed hace 60 días) se trunca antes que fact nuevo (weight:1, confirmed hoy)
- [ ] **Bug 2:** Si edito learnings.md con formato malo, no crashea y muestra warning
- [ ] **Bug 3:** "Me gusta el café" y "A mi esposa le gusta el café" son facts SEPARADOS
- [ ] **Bug 5:** El system prompt incluye instrucción de usar remember_fact

**Invariantes:**
- [ ] El archivo learnings.md es legible y tiene formato consistente
- [ ] Si creo >50 facts, los de menor SCORE se truncan del prompt (no del archivo)
- [ ] Nunca se pierde el archivo original (escritura atómica con rename)

---

#### Decisiones NO tomadas en Fase 2 (diferidas)

| Decisión | Por qué diferida | Trigger para implementar |
|----------|------------------|--------------------------|
| Tool `recall` | Todo cabe en prompt por ahora | Cuando learnings.md > 100 facts |
| Embeddings (Jina) | Over-engineering prematuro | Cuando word overlap falle frecuentemente |
| Preguntar al usuario en contradicciones | Complejidad de UX | Cuando haya errores de memoria visibles |
| Write queue | Mutex es suficiente | Cuando haya múltiples interfaces simultáneas |
| Backup/versioning de knowledge | No crítico aún | Cuando usuario pierda datos |
| Read-write lock | Race condition es rara en CLI | Cuando haya WhatsApp + CLI simultáneos |
| Auto-fix de formato | Warning es suficiente | Cuando usuarios rompan formato frecuentemente |
| Memory extraction automática | Prompt explícito es suficiente | Cuando LLM olvide llamar remember frecuentemente |

---

#### Análisis de Implementabilidad

**Pregunta:** ¿Es Fase 2 implementable de forma segura sobre el sistema actual sin rework mayor?

**Respuesta:** ✅ SÍ — La arquitectura actual soporta Fase 2. Todo el trabajo es ADITIVO.

---

##### Supuestos YA SATISFECHOS por Fase 1

| Componente | Estado | Evidencia |
|------------|--------|-----------|
| Sistema de tools extensible | ✅ Listo | `ToolRegistry` con patrón de registro dinámico |
| Agentic loop maneja tool calls | ✅ Listo | `brain.ts` procesa, parsea JSON, ejecuta, guarda |
| SQLite para historial | ✅ Listo | `store.ts` con schema, CRUD, índices |
| Prompt dinámico | ✅ Listo | `prompt-builder.ts` carga SOUL.md, inyecta contexto |
| Manejo de errores en tools | ✅ Listo | Try-catch, JSON malformado manejado |
| Logging estructurado | ✅ Listo | `createLogger()` por contexto |
| Configuración con .env | ✅ Listo | Parser manual, paths definidos |
| Graceful shutdown | ✅ Listo | Signal handlers cierran DB |

---

##### Supuestos PARCIALMENTE SATISFECHOS (riesgo bajo-medio)

| Área | Problema | Riesgo | Mitigación en Fase 2 |
|------|----------|--------|---------------------|
| **Token counting** | Usa 4 chars/token (naive) | MEDIO | Agregar logging de tokens reales vs estimados |
| **System prompt reserve** | Hardcoded 4000 tokens | BAJO | Suficiente para ~1700 tokens de Fase 2 |
| **File I/O** | No hay abstracción | BAJO | Crear `knowledge.ts` nuevo |
| **Prompt builder** | No tiene hook para knowledge | BAJO | Modificar `buildSystemPrompt()` |

---

##### Supuestos NO SATISFECHOS (trabajo nuevo requerido)

| Componente | Trabajo Necesario | Complejidad |
|------------|-------------------|-------------|
| `data/knowledge/` | Crear directorio y templates | Trivial |
| Word overlap algorithm | Lista stopwords + cálculo overlap | Baja |
| Recency factor | Función pura de fecha → factor | Baja |
| Mutex para archivos | Promise-based lock o npm package | Media |
| Schema validation (regex) | Regex + manejo de líneas inválidas | Media |
| Instrucción memoria en prompt | Agregar texto al template | Trivial |
| Cost tracking | Calcular desde `usage` del API | Trivial |

---

##### Pre-requisitos ANTES de Empezar Código

- [ ] **Definir lista de stopwords** en español (20-30 palabras comunes)
- [ ] **Escribir regex de parsing** y probar con 10 casos edge
- [ ] **Decidir mutex**: implementar propio o usar `proper-lockfile`
- [ ] **Crear templates** de user.md y learnings.md vacíos

##### Validaciones DURANTE Implementación

- [ ] Tests unitarios para word overlap con casos edge
- [ ] Tests unitarios para recency factor con fechas específicas
- [ ] Verificar escritura atómica funciona (temp → rename)
- [ ] Logging de tokens estimados vs reales

##### Monitoreo Post-Deploy (Primeras 2 Semanas)

- [ ] Revisar learnings.md manualmente cada 2-3 días
- [ ] Verificar dedup no fusiona facts incorrectamente
- [ ] Verificar truncación prioriza correctamente por score
- [ ] Verificar LLM llama remember_fact cuando corresponde

---

##### Cambios Arquitectónicos Requeridos: NINGUNO

```
Fase 1 (actual)                    Fase 2 (nuevo)
================                   ================
src/agent/brain.ts          →      (sin cambios)
src/agent/prompt-builder.ts →      + cargar knowledge files
src/agent/context-guard.ts  →      (sin cambios)
src/memory/store.ts         →      (sin cambios)
src/tools/registry.ts       →      (sin cambios)
src/tools/time.ts           →      (sin cambios)
src/tools/search.ts         →      (sin cambios)
src/llm/kimi.ts             →      + logging de costos
src/interfaces/cli.ts       →      (sin cambios)
                            →      + src/memory/knowledge.ts (NUEVO)
                            →      + src/tools/remember.ts (NUEVO)
                            →      + src/tools/read-url.ts (NUEVO)
                            →      + src/tools/weather.ts (NUEVO)
                            →      + data/knowledge/user.md (NUEVO)
                            →      + data/knowledge/learnings.md (NUEVO)
```

---

#### Orden de Implementación Recomendado

```
Día 1: Setup & Knowledge Files
├── Crear data/knowledge/ con templates
├── Implementar src/memory/knowledge.ts
│   ├── loadKnowledge()
│   ├── parseLearnings()
│   └── Validación con "Unparsed"
└── Tests manuales de parsing

Día 2: Tool Remember
├── Implementar src/tools/remember.ts
│   ├── Word overlap algorithm
│   ├── Deduplicación
│   └── Mutex para escritura
├── Registrar en tools/index.ts
└── Tests manuales de remember

Día 3: Integración Prompt Builder
├── Modificar prompt-builder.ts
│   ├── Cargar knowledge files
│   ├── Calcular score (weight × recency)
│   ├── Truncar por score
│   └── Agregar instrucción de remember
└── Tests end-to-end

Día 4: Tools Adicionales
├── Implementar read-url.ts (Jina r.jina.ai)
├── Implementar weather.ts (Open-Meteo)
└── Registrar en tools/index.ts

Día 5: Observabilidad & Polish
├── Agregar logging de costos en kimi.ts
├── Logging de "Loaded X facts (Y unparsed)"
├── Verificación de criterios completa
└── Commit final Fase 2
```

---

### FASE 3: Proactivity
**Objetivo:** Agente que inicia conversaciones

#### 3.1 Proactive Loop
- [ ] `src/agent/proactive.ts`
  - Loop que corre cada N minutos
  - Construye contexto (hora, día, historial reciente, reminders pendientes)
  - Pregunta al LLM: "¿Deberías decir algo ahora?"
  - Si sí, genera mensaje y lo envía

#### 3.2 Sistema de reminders
- [ ] `src/tools/reminders.ts`
  - Tool: `set_reminder(message, datetime)`
  - Tabla: reminders (id, message, trigger_at, triggered)
- [ ] Integrar reminders en proactive loop

#### 3.3 Notificaciones locales
- [ ] Notificación del sistema cuando el agente habla proactivamente
- [ ] (CLI: solo print. Desktop: notificación nativa)

#### Criterios de verificación FASE 3
- [ ] Me saluda cuando empiezo a trabajar (detecta actividad)
- [ ] Me recuerda cosas que le pedí ("recordame en 2 horas...")
- [ ] No molesta innecesariamente (LLM decide bien cuándo callar)

---

### FASE 4: WhatsApp Bridge
**Objetivo:** Acceso desde el celular

#### 4.1 Baileys setup
- [ ] `src/interfaces/whatsapp.ts`
  - Conexión con QR code
  - Persistencia de auth en `data/whatsapp-auth/`

#### 4.2 Message Queue
- [ ] `src/interfaces/message-queue.ts`
  - Cola por usuario (aunque sea 1 solo)
  - Procesa mensajes en orden FIFO
  - Evita race conditions

#### 4.3 Integración bidireccional
- [ ] Recibir mensajes de WhatsApp → Brain
- [ ] Enviar respuestas → WhatsApp
- [ ] Enviar mensajes proactivos → WhatsApp

#### 4.4 Filtrado de chats
- [ ] Solo responder a tu número (configurable en .env)
- [ ] Ignorar grupos y otros contactos

#### Criterios de verificación FASE 4
- [ ] Puedo chatear desde WhatsApp
- [ ] Me avisa cosas proactivamente por WhatsApp
- [ ] No responde a otros contactos
- [ ] Si mando 3 mensajes rápidos, los procesa en orden

---

### FASE 5: Polish & Extras (Opcional)
**Objetivo:** Experiencia pulida

- [ ] Desktop UI con sprites de Flopiti
- [ ] Rate limiting y control de costos
- [ ] Dashboard de métricas (costos, uso)
- [ ] Backup/export de memoria
- [ ] Model router inteligente (auto-fallback a Claude si Kimi falla)

---

## Investigación Completada

### Arquitecturas de Memoria en Agentes AI (Enero 2026)

Análisis de cómo otros proyectos manejan memoria persistente:

| Proyecto | Storage | Formato | Semantic Search | Complejidad |
|----------|---------|---------|-----------------|-------------|
| **OpenClaw** | Archivos | Markdown | Opcional (SQLite) | Baja |
| **Claude Code** | Archivos | Markdown | No | Baja |
| **Cursor** | Híbrido | MD + MCP | Opcional | Media |
| **mem0** | Base de datos | Vector DB | Sí | Alta |
| **MemGPT** | Multi-tier | SQLite + Vector | Sí | Muy Alta |

**Conclusiones:**

1. **OpenClaw/Claude Code** usan archivos markdown porque:
   - LLMs los leen/escriben nativamente
   - Usuario puede editarlos manualmente
   - Sin overhead de base de datos
   - Git-friendly

2. **MemGPT** introduce el concepto de "tiers":
   - Tier 1: In-context (siempre visible al LLM)
   - Tier 2: Conversation history (SQLite)
   - Tier 3: Long-term (embeddings/vector)

3. **Decisión para Sidecar:**
   - Archivos markdown para knowledge (user-editable, transparente)
   - SQLite para historial (ya implementado en Fase 1)
   - Embeddings diferidos hasta que sean necesarios

**Referencias:**
- [OpenClaw Agents](https://github.com/openclaw/openclaw)
- [Claude Code Memory](https://docs.anthropic.com/claude-code/memory)
- [MemGPT Paper](https://arxiv.org/abs/2310.08560)
- [mem0 Docs](https://docs.mem0.ai)

---

### LLMs evaluados (Enero 2026)

| Modelo | Input/M | Output/M | Context | Tool Use | Decisión |
|--------|---------|----------|---------|----------|----------|
| **Kimi K2.5** | $0.60 | $2.50 | 262K | ✅ Bueno | **DEFAULT** |
| **Kimi K2.5 (cache)** | $0.15 | $2.50 | 262K | ✅ Bueno | **75% off en input repetido** |
| Claude 3 Haiku | $0.25 | $1.25 | 200K | ✅ Bueno | Fallback (más barato pero viejo) |
| Claude 4.5 Haiku | $1.00 | $5.00 | 200K | ✅ Excelente | Más caro que Kimi |
| DeepSeek V3.2 | $0.14 | $0.28 | 128K | ⚠️ Basic | Para resumir contexto |

**Decisión:** Kimi K2.5 con cache como default. El cache aprovecha que system prompt + tools se repiten en cada request (~2-3K tokens a $0.15/M en lugar de $0.60/M).

### Web Data

**Jina Reader (elegido):**
- `s.jina.ai` - búsqueda web → markdown
- `r.jina.ai` - URL → markdown
- GRATIS (10M tokens con API key)

### WhatsApp

**Baileys (elegido):**
- WebSocket directo, no Chromium
- Multi-device support
- TypeScript nativo
- ⚠️ No oficial, puede romperse

---

## Estimación de Costos

### Costo mensual por escenario (Kimi K2.5 con cache)

| Escenario | Descripción | Costo/mes |
|-----------|-------------|-----------|
| **Bajo uso** | Solo proactive loop (12h/día) | ~$1.40 |
| **Moderado** | 50 interacciones/día + proactive | ~$3-4 |
| **Heavy** | 200 interacciones/día + proactive + tools | ~$12-15 |

### Comparación con otros modelos (uso moderado)

| Modelo | Costo/mes |
|--------|-----------|
| **Kimi K2.5 (cache)** | ~$3-4 ✅ |
| Claude 3 Haiku | ~$2.60 |
| Kimi K2.5 (sin cache) | ~$5.60 |
| Claude 4.5 Haiku | ~$10.40 |

---

## Consideraciones

### Seguridad
- API keys en .env (no commitear)
- WhatsApp auth en directorio separado (no commitear)
- Limitar tools peligrosos (no ejecutar comandos arbitrarios)

### Privacidad
- Todo corre local (tu máquina)
- Datos en SQLite local
- LLM calls van a APIs externas (inevitable)
- WhatsApp pasa por servidores de Meta

### Limitaciones conocidas
- WhatsApp bridge puede romperse si WhatsApp actualiza
- Necesita computadora encendida para funcionar
- LLMs pueden alucinar (siempre verificar info importante)

---

## Recursos

### Documentación
- [Anthropic Claude API](https://docs.anthropic.com/)
- [Kimi API](https://platform.moonshot.ai/docs)
- [DeepSeek API](https://api-docs.deepseek.com/)
- [Jina Reader](https://jina.ai/reader/)
- [Baileys Wiki](https://baileys.wiki/docs/intro/)

### Ejemplos de referencia
- [Clawdbot](https://github.com/clawdbot/clawdbot) - Arquitectura de referencia
- [Firecrawl Agent](https://www.firecrawl.dev/agent) - Web agent patterns

---

## Próximos pasos

### Completado
1. [x] Definir nombre del proyecto (Sidecar)
2. [x] Crear repositorio nuevo
3. [x] Implementar FASE 1
4. [x] Configurar API key de Kimi en .env
5. [x] Probar la aplicación con `npm run dev`
6. [x] Verificar FASE 1 con API real (tests pasaron)
7. [x] **Design review FASE 2** (token budget, schema, dedup, concurrencia)
8. [x] **Pre-mortem FASE 2** (5 bugs identificados + mitigaciones)
9. [x] **Análisis de implementabilidad** (verificado: arquitectura soporta Fase 2)

### Pre-requisitos FASE 2 (antes de código)
10. [ ] Definir lista de stopwords en español (~25 palabras)
11. [ ] Escribir y probar regex de parsing de facts
12. [ ] Decidir implementación de mutex (propio vs `proper-lockfile`)
13. [ ] Crear templates de user.md y learnings.md

### Implementación FASE 2
14. [ ] **Día 1:** Setup & Knowledge Files
    - [ ] Crear `data/knowledge/` con templates
    - [ ] Implementar `src/memory/knowledge.ts`
    - [ ] Tests manuales de parsing
15. [ ] **Día 2:** Tool Remember
    - [ ] Implementar `src/tools/remember.ts` con word overlap
    - [ ] Registrar en tools
    - [ ] Tests manuales
16. [ ] **Día 3:** Integración Prompt Builder
    - [ ] Modificar `prompt-builder.ts` (knowledge + score + truncación)
    - [ ] Tests end-to-end
17. [ ] **Día 4:** Tools Adicionales
    - [ ] `src/tools/read-url.ts`
    - [ ] `src/tools/weather.ts`
18. [ ] **Día 5:** Observabilidad & Verificación
    - [ ] Logging de costos
    - [ ] Verificación de TODOS los criterios
    - [ ] Commit final Fase 2

---

## Changelog

### 2026-01-31 (actualización 6) - Diseño Fase 2 COMPLETO
- **Análisis de implementabilidad**: Verificado que arquitectura Fase 1 soporta Fase 2
- **Supuestos documentados**: Satisfechos, parciales, y no satisfechos
- **Pre-requisitos definidos**: 4 items antes de empezar código
- **Plan de implementación**: 5 días con entregables específicos
- **Monitoreo post-deploy**: Checklist para primeras 2 semanas
- **Conclusión**: Cambios arquitectónicos requeridos = NINGUNO

### 2026-01-31 (actualización 5) - Pre-Mortem y Mitigaciones
- **Análisis pre-mortem**: 5 bugs concretos identificados antes de implementar
- **Bug 1 - Weight Inflation**: Agregado campo `confirmed` al schema + recency_factor para truncación
- **Bug 2 - Parser Malformado**: Validación por línea, categoría "Unparsed" para líneas inválidas
- **Bug 3 - Substring Dedup**: Cambiado a word overlap ratio (>50%), excluyendo stopwords
- **Bug 4 - Race Condition**: Documentado como limitación aceptable para Fase 2
- **Bug 5 - LLM No Llama Tool**: Instrucción explícita en system prompt
- **Schema actualizado**: `[weight:N] fact | learned:date | confirmed:date`
- **Truncación mejorada**: Por score = weight * recency_factor (no solo weight)
- **Criterios de verificación**: Agregados tests específicos para cada mitigación

### 2026-01-31 (actualización 4) - Design Review Fase 2
- **Revisión de diseño desde 3 perspectivas**: Systems Architect, Product Engineer, Failure Engineer
- **Token budget definido**: ~1,500 tokens para Tier 1, ~600 para learnings.md
- **Schema de learnings**: `[weight:N] fact | learned:date` con categorías fijas
- **Sistema de weight**: Facts repetidos incrementan weight (1-10), mayor weight = más prioridad
- **Deduplicación**: Substring match simple (AHORA), embeddings similarity (FUTURO)
- **Contradicciones**: Fact más reciente gana (AHORA), preguntar al usuario (FUTURO)
- **Concurrencia**: Mutex simple por archivo (AHORA), write queue (FUTURO)
- **Recall tool diferido**: Todo cabe en prompt mientras <100 facts
- **Principio de diseño**: Empezar simple, escalar cuando duela

### 2026-01-31 (actualización 3)
- **FASE 1 completada y verificada** con API real de Kimi
- Corregido: URL base de Kimi (api.moonshot.ai, no .cn)
- Corregido: Modelo correcto (kimi-k2-0711-preview)
- Implementados pre-ship fixes:
  - Spinner en CLI
  - Timeout de requests (60s)
  - Manejo de respuestas vacías y truncadas
  - Schema SQL inline (no más archivo externo)
  - Errores explícitos en tool arguments
- **Rediseño de FASE 2: Hybrid Memory**
  - Investigación de arquitecturas: OpenClaw, Claude Code, MemGPT, mem0
  - Decisión: Markdown files para knowledge + SQLite para historial
  - Nueva estructura: data/knowledge/ con user.md y learnings.md
  - Inspirado en OpenClaw (archivos editables) + MemGPT (tiers)

### 2026-01-31 (actualización 2)
- Investigación de precios actualizada con fuentes verificadas
- Decisión final: **Kimi K2.5 con cache** como modelo default
  - $0.60/$2.50 normal, $0.15/$2.50 con cache (75% off en input repetido)
  - Mejor balance precio/calidad vs Claude 4.5 Haiku ($1.00/$5.00)
  - Cache ideal para system prompt + tools que se repiten
- Fallback: Claude 3 Haiku ($0.25/$1.25) si Kimi falla
- Estimación de costos actualizada: ~$3-15/mes según uso

### 2026-01-31
- Agregado: Sección "Alcance Final" con visión completa
- Agregado: Componentes arquitectónicos detallados (Context Guard, Agentic Loop, Message Queue)
- Actualizado: Fases con entregables específicos y criterios de verificación
- Actualizado: Estructura de proyecto con todos los archivos
- Decisión: CLI simple con readline (sin @clack/prompts por ahora)

### 2026-01-30
- Documento inicial
- Investigación de LLMs, web tools, WhatsApp
- Arquitectura inicial definida

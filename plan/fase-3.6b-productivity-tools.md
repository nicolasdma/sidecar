# Fase 3.6b: Tools de Productividad

> **Estado:** ⏳ Planificado
> **Prerequisitos:** Fase 3.6a completada (Device Profiles + Smart Router v2)
> **Objetivo:** Tools core que corren 100% local con LLMs
> **Última revisión:** 2026-02-01

---

## Contexto

Con el Smart Router v2 de Fase 3.6a, tenemos la capacidad de rutear requests a modelos locales. Esta fase implementa las **tools de productividad** que aprovechan esa infraestructura.

**Principio:** Estas tools NO requieren APIs externas. Corren 100% local usando los LLMs del dispositivo.

---

## Objetivo

Implementar 4 tools core de productividad:

| Tool | Descripción | Modelo Preferido |
|------|-------------|------------------|
| `translate` | Traducción entre idiomas | gemma2:9b |
| `grammar_check` | Corrección ortográfica/gramatical | qwen2.5:7b |
| `summarize` | Resumen de textos | qwen2.5:7b |
| `explain` | Explicación de conceptos | gemma2:9b |

**Bonus:** Preparar arquitectura para `/learn` (modo aprendizaje).

---

## Arquitectura

### Flujo General

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      PRODUCTIVITY TOOLS FLOW                             │
│                                                                          │
│  User Input                                                              │
│      │                                                                   │
│      ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Smart Router v2 (Fase 3.6a)                                    │    │
│  │                                                                  │    │
│  │  Clasifica intent → translate | grammar_check | summarize | ... │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│      │                                                                   │
│      ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Local Executor                                                  │    │
│  │                                                                  │    │
│  │  1. Selecciona modelo según intent                              │    │
│  │  2. Construye prompt especializado                              │    │
│  │  3. Ejecuta con Ollama                                          │    │
│  │  4. Post-procesa respuesta                                      │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│      │                                                                   │
│      ▼                                                                   │
│  Response to User                                                        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Diferencia con Tools Existentes

| Aspecto | Tools Existentes (time, weather) | Productivity Tools |
|---------|----------------------------------|-------------------|
| Ejecución | Deterministic, sin LLM | Requiere LLM local |
| Respuesta | Template fijo | Generada por LLM |
| Latencia | ~0ms | ~2-5s |
| Fallback | No aplica | Puede ir a API |

---

## Tool: `translate`

### Especificación

```typescript
interface TranslateParams {
  text: string;           // Texto a traducir
  targetLang: string;     // Idioma destino (es, en, fr, pt, de, it, zh, ja, ko)
  sourceLang?: string;    // Idioma origen (auto-detect si no se especifica)
  formality?: 'formal' | 'informal';  // Tono
}

interface TranslateResult {
  original: string;
  translated: string;
  detectedLang?: string;  // Si sourceLang era auto
  targetLang: string;
}
```

### Prompt Template

```typescript
const TRANSLATE_PROMPT = `
You are a professional translator. Translate the following text.

Source language: {{sourceLang || 'auto-detect'}}
Target language: {{targetLang}}
Formality: {{formality || 'neutral'}}

Text to translate:
"""
{{text}}
"""

Respond with ONLY the translated text, nothing else. Preserve formatting.
`;
```

### Detección de Idiomas Soportados

```typescript
const SUPPORTED_LANGUAGES = {
  es: 'Spanish',
  en: 'English',
  fr: 'French',
  pt: 'Portuguese',
  de: 'German',
  it: 'Italian',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  ar: 'Arabic',
};

// Auto-detect: el modelo lo infiere del texto
```

### Ejemplos de Uso

```
Usuario: "Traduce esto al inglés: Hola, cómo estás?"
→ Intent: translate
→ Params: { text: "Hola, cómo estás?", targetLang: "en" }
→ Response: "Hello, how are you?"

Usuario: "Translate to Spanish: The weather is nice today"
→ Intent: translate
→ Params: { text: "The weather is nice today", targetLang: "es" }
→ Response: "El clima está agradable hoy"

Usuario: "Traduce al francés formal: Necesito hablar contigo"
→ Intent: translate
→ Params: { text: "Necesito hablar contigo", targetLang: "fr", formality: "formal" }
→ Response: "J'ai besoin de vous parler"
```

### Modelo Preferido

**gemma2:9b** - Mejor calidad en traducciones, especialmente para idiomas europeos.

Fallback: qwen2.5:7b-instruct

---

## Tool: `grammar_check`

### Especificación

```typescript
interface GrammarCheckParams {
  text: string;           // Texto a corregir
  language?: string;      // Idioma del texto (auto-detect si no se especifica)
  style?: 'formal' | 'informal' | 'academic';  // Estilo objetivo
}

interface GrammarCheckResult {
  original: string;
  corrected: string;
  changes: GrammarChange[];
  summary: string;        // "3 errores corregidos: 2 ortográficos, 1 gramatical"
}

interface GrammarChange {
  type: 'spelling' | 'grammar' | 'punctuation' | 'style';
  original: string;
  corrected: string;
  explanation?: string;
}
```

### Prompt Template

```typescript
const GRAMMAR_CHECK_PROMPT = `
You are a professional editor. Correct the following text for spelling, grammar, and punctuation errors.

Language: {{language || 'auto-detect'}}
Target style: {{style || 'neutral'}}

Text to correct:
"""
{{text}}
"""

Respond in this exact JSON format:
{
  "corrected": "the corrected text here",
  "changes": [
    {
      "type": "spelling|grammar|punctuation|style",
      "original": "wrong word",
      "corrected": "correct word",
      "explanation": "brief explanation"
    }
  ]
}

If there are no errors, return the original text with empty changes array.
`;
```

### Ejemplos de Uso

```
Usuario: "Corrige esto: Ayer fuistes al mercado y comprastes muchas cozas"
→ Intent: grammar_check
→ Params: { text: "Ayer fuistes al mercado y comprastes muchas cozas" }
→ Response:
  Corrected: "Ayer fuiste al mercado y compraste muchas cosas"
  Changes:
  - "fuistes" → "fuiste" (grammar: conjugación incorrecta)
  - "comprastes" → "compraste" (grammar: conjugación incorrecta)
  - "cozas" → "cosas" (spelling)

Usuario: "Fix grammar: Their going to the store"
→ Intent: grammar_check
→ Params: { text: "Their going to the store", language: "en" }
→ Response:
  Corrected: "They're going to the store"
  Changes:
  - "Their" → "They're" (grammar: wrong homophone)
```

### Modelo Preferido

**qwen2.5:7b-instruct** - Buen balance entre velocidad y precisión gramatical.

Fallback: mistral:7b-instruct

---

## Tool: `summarize`

### Especificación

```typescript
interface SummarizeParams {
  text: string;           // Texto a resumir
  length?: 'brief' | 'medium' | 'detailed';  // Longitud del resumen
  format?: 'paragraph' | 'bullets' | 'tldr';  // Formato de salida
  language?: string;      // Idioma del resumen (mismo que input si no se especifica)
}

interface SummarizeResult {
  original_length: number;  // Palabras originales
  summary: string;
  summary_length: number;   // Palabras del resumen
  compression_ratio: number; // ej: 0.2 = 20% del original
}
```

### Prompt Template

```typescript
const SUMMARIZE_PROMPT = `
Summarize the following text.

Length: {{length || 'medium'}}
Format: {{format || 'paragraph'}}
Language: {{language || 'same as input'}}

Text to summarize:
"""
{{text}}
"""

Guidelines:
- brief: 1-2 sentences, only the most essential point
- medium: 3-5 sentences, main points
- detailed: comprehensive summary, all important points

- paragraph: flowing prose
- bullets: bullet points
- tldr: single sentence starting with "TL;DR:"

Respond with ONLY the summary, no preamble.
`;
```

### Ejemplos de Uso

```
Usuario: "Resume este artículo: [texto largo de 500 palabras]"
→ Intent: summarize
→ Params: { text: "...", length: "medium", format: "paragraph" }
→ Response: "El artículo explica que... Los puntos principales son... En conclusión..."

Usuario: "Dame los bullet points de esto: [texto]"
→ Intent: summarize
→ Params: { text: "...", format: "bullets" }
→ Response:
  • Punto principal 1
  • Punto principal 2
  • Punto principal 3

Usuario: "TL;DR: [texto largo]"
→ Intent: summarize
→ Params: { text: "...", format: "tldr" }
→ Response: "TL;DR: El autor argumenta que X es mejor que Y por razones Z."
```

### Validación

```typescript
// No tiene sentido resumir textos muy cortos
if (params.text.split(/\s+/).length < 50) {
  return {
    error: "El texto es muy corto para resumir (menos de 50 palabras)",
    suggestion: "Puedo explicarlo o reformularlo si lo prefieres"
  };
}
```

### Modelo Preferido

**qwen2.5:7b-instruct** - Eficiente para extracción de información.

Fallback: mistral:7b-instruct

---

## Tool: `explain`

### Especificación

```typescript
interface ExplainParams {
  topic: string;          // Concepto a explicar
  level?: 'eli5' | 'beginner' | 'intermediate' | 'expert';  // Nivel de complejidad
  context?: string;       // Contexto adicional
  language?: string;      // Idioma de la explicación
}

interface ExplainResult {
  topic: string;
  explanation: string;
  examples?: string[];    // Ejemplos si aplica
  related?: string[];     // Conceptos relacionados
}
```

### Prompt Template

```typescript
const EXPLAIN_PROMPT = `
Explain the following concept.

Topic: {{topic}}
Level: {{level || 'beginner'}}
{{#if context}}Context: {{context}}{{/if}}
Language: {{language || 'Spanish'}}

Explanation levels:
- eli5: Explain like I'm 5. Simple analogies, no jargon.
- beginner: Basic understanding, define terms, simple examples.
- intermediate: Assume some knowledge, more depth.
- expert: Technical, assume expertise, nuances.

Respond with:
1. Clear explanation appropriate for the level
2. 1-2 concrete examples if helpful
3. 2-3 related concepts they might want to explore

Keep it concise but complete.
`;
```

### Ejemplos de Uso

```
Usuario: "Explícame qué es una API"
→ Intent: explain
→ Params: { topic: "API", level: "beginner" }
→ Response:
  Una API (Application Programming Interface) es como un mesero en un restaurante.
  Tú (la aplicación) le dices al mesero (la API) lo que quieres, y él va a la cocina
  (el servidor) a buscarlo y te lo trae.

  Ejemplo: Cuando usas una app del clima, la app le pide a la API del servicio
  meteorológico los datos, y la API se los devuelve.

  Relacionados: REST, endpoints, HTTP

Usuario: "Explain quantum entanglement eli5"
→ Intent: explain
→ Params: { topic: "quantum entanglement", level: "eli5" }
→ Response:
  Imagina que tienes dos calcetines mágicos. Cuando te pones uno en el pie izquierdo,
  el otro automáticamente se convierte en el del pie derecho, sin importar qué tan
  lejos esté. Los científicos descubrieron que algunas partículas muy pequeñas
  hacen algo parecido.
```

### Detección de Complejidad

```typescript
// Si el topic parece muy técnico y el nivel no está especificado
const TECHNICAL_PATTERNS = [
  /\b(algorithm|kubernetes|neural|quantum|cryptograph|protocol)\b/i,
  /\b(machine learning|deep learning|blockchain|microservices)\b/i,
];

function suggestLevel(topic: string, userLevel?: string): string {
  if (userLevel) return userLevel;

  const isTechnical = TECHNICAL_PATTERNS.some(p => p.test(topic));
  return isTechnical ? 'intermediate' : 'beginner';
}
```

### Modelo Preferido

**gemma2:9b** - Mejor para explicaciones claras y ejemplos creativos.

Fallback: qwen2.5:7b-instruct

---

## Extracción Robusta de JSON (Crítico)

Los modelos 7B frecuentemente retornan JSON malformado. **Todas las tools que esperan JSON deben usar extracción robusta:**

```typescript
// src/utils/json-extractor.ts

interface ExtractionResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  strategy?: 'direct' | 'code_fence' | 'substring' | 'repair';
}

function extractJSON<T>(response: string): ExtractionResult<T> {
  // Estrategia 1: Parse directo
  try {
    return { success: true, data: JSON.parse(response.trim()), strategy: 'direct' };
  } catch {}

  // Estrategia 2: Extraer de code fences ```json ... ```
  const codeFenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeFenceMatch) {
    try {
      return { success: true, data: JSON.parse(codeFenceMatch[1].trim()), strategy: 'code_fence' };
    } catch {}
  }

  // Estrategia 3: Encontrar primer { ... } o [ ... ]
  const jsonMatch = response.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      return { success: true, data: JSON.parse(jsonMatch[1]), strategy: 'substring' };
    } catch {}
  }

  // Estrategia 4: Reparar JSON común (trailing commas, single quotes)
  const repaired = response
    .replace(/,\s*([}\]])/g, '$1')        // Remove trailing commas
    .replace(/'/g, '"')                    // Single to double quotes
    .replace(/(\w+):/g, '"$1":');          // Unquoted keys

  const repairedMatch = repaired.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (repairedMatch) {
    try {
      return { success: true, data: JSON.parse(repairedMatch[1]), strategy: 'repair' };
    } catch {}
  }

  return { success: false, error: 'No se pudo extraer JSON válido de la respuesta' };
}
```

**Aplicar en:**
- `grammar_check` (espera `{ corrected, changes }`)
- `summarize` con format estructurado
- Cualquier tool que parsee respuesta del LLM

---

## Arquitectura: Learning Mode (DIFERIDO - Fuera de Scope)

> **⚠️ REMOVIDO DE FASE 3.6b:** Esta sección es documentación de referencia únicamente.
> El schema e interfaces se diseñarán cuando learning sea el feature activo.
> Razón: Infraestructura especulativa; el schema probablemente cambiará.

### Concepto

```
/learn english
/learn typescript
/learn system-design
```

Inicia una sesión interactiva donde el agente:
1. Hace preguntas sobre el tema
2. Corrige respuestas
3. Explica errores
4. Trackea progreso

### Schema de Datos (Preview)

```sql
-- Tabla para sesiones de aprendizaje
CREATE TABLE IF NOT EXISTS learning_sessions (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  questions_asked INTEGER DEFAULT 0,
  correct_answers INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active'  -- active, paused, completed
);

-- Tabla para progreso por topic
CREATE TABLE IF NOT EXISTS learning_progress (
  topic TEXT PRIMARY KEY,
  total_sessions INTEGER DEFAULT 0,
  total_questions INTEGER DEFAULT 0,
  total_correct INTEGER DEFAULT 0,
  last_session_at TEXT,
  proficiency_level TEXT DEFAULT 'beginner'  -- beginner, intermediate, advanced
);
```

### Interfaz (Preview)

```typescript
interface LearningSession {
  id: string;
  topic: string;
  startedAt: Date;
  questionsAsked: number;
  correctAnswers: number;
  status: 'active' | 'paused' | 'completed';
}

interface LearningTool {
  // Iniciar sesión
  startSession(topic: string): Promise<LearningSession>;

  // Generar pregunta
  generateQuestion(session: LearningSession): Promise<Question>;

  // Evaluar respuesta
  evaluateAnswer(session: LearningSession, answer: string): Promise<Evaluation>;

  // Terminar sesión
  endSession(session: LearningSession): Promise<SessionSummary>;
}
```

### Implementación Diferida

Para Fase 3.6b solo:
- [ ] Crear schema SQL
- [ ] Crear interfaces TypeScript
- [ ] Documentar flujo completo

Implementación real: Fase futura cuando learning sea prioridad.

---

## Estructura de Archivos

```
sidecar/
├── src/
│   ├── tools/
│   │   ├── translate.ts        # Tool de traducción
│   │   ├── grammar-check.ts    # Tool de corrección
│   │   ├── summarize.ts        # Tool de resumen
│   │   ├── explain.ts          # Tool de explicación
│   │   └── learning/           # Preview para learning mode
│   │       ├── types.ts        # Interfaces
│   │       └── schema.sql      # Schema SQLite
│   │
│   ├── agent/
│   │   └── local-router/
│   │       ├── prompts/
│   │       │   ├── translate.ts
│   │       │   ├── grammar.ts
│   │       │   ├── summarize.ts
│   │       │   └── explain.ts
│   │       └── local-executor.ts  # Actualizar con nuevas tools
│   │
│   └── ...
```

---

## Orden de Implementación

### Día 1: Tool `translate`

- [ ] `src/tools/translate.ts`
  - Definir schema (params, result)
  - Prompt template
  - Detección de idioma destino del input
  - Integración con Local Executor

- [ ] Actualizar clasificador
  - Intent `translate` con patrones

- [ ] Tests
  - Español → Inglés
  - Inglés → Español
  - Auto-detect source language
  - Idiomas no soportados → error claro

### Día 2: Tool `grammar_check`

- [ ] `src/tools/grammar-check.ts`
  - Definir schema
  - Prompt template que retorna JSON
  - Parser de cambios
  - Formateo de respuesta amigable

- [ ] Actualizar clasificador
  - Intent `grammar_check` con patrones

- [ ] Tests
  - Errores ortográficos español
  - Errores gramaticales español
  - Errores en inglés
  - Texto sin errores → respuesta apropiada

### Día 3: Tool `summarize`

- [ ] `src/tools/summarize.ts`
  - Definir schema
  - Prompt templates para cada formato
  - Validación de longitud mínima
  - Cálculo de compression ratio

- [ ] Actualizar clasificador
  - Intent `summarize` con patrones

- [ ] Tests
  - Resumen paragraph
  - Resumen bullets
  - TL;DR
  - Texto muy corto → error apropiado

### Día 4: Tool `explain` + JSON Extractor

- [ ] `src/tools/explain.ts`
  - Definir schema
  - Prompt templates por nivel
  - Detección de complejidad del topic

- [ ] `src/utils/json-extractor.ts` **(CRÍTICO)**
  - Implementar `extractJSON<T>()` con 4 estrategias
  - Tests con outputs reales de modelos 7B
  - Integrar en `grammar_check` y otras tools que esperan JSON

- [ ] Actualizar clasificador
  - Intent `explain` con patrones

- [ ] Tests
  - Explicación eli5
  - Explicación técnica
  - Conceptos en español e inglés
  - **JSON extraction con casos malformados**

### Día 5: Integración + Polish

- [ ] Integración con Smart Router v2
  - Todas las tools ruteadas correctamente
  - Fallback a API funciona

- [ ] Registro en tool registry
  - Tools disponibles para Brain (cuando API route)

- [ ] Edge cases
  - Modelo local no disponible → fallback
  - Timeout → mensaje apropiado
  - Input vacío → error claro

- [ ] Documentación
  - Actualizar PLAN.md
  - Ejemplos de uso en README

---

## Criterios de Verificación

### Tool: translate

- [ ] "Traduce al inglés: Hola mundo" → "Hello world"
- [ ] "Translate to Spanish: Good morning" → "Buenos días"
- [ ] Auto-detecta idioma origen
- [ ] Formality formal/informal afecta resultado
- [ ] Idioma no soportado → mensaje claro
- [ ] Timeout → fallback a API

### Tool: grammar_check

- [ ] Corrige errores ortográficos en español
- [ ] Corrige errores gramaticales en español
- [ ] Corrige errores en inglés
- [ ] Texto sin errores → "No se encontraron errores"
- [ ] Muestra lista de cambios realizados
- [ ] Explica cada corrección

### Tool: summarize

- [ ] Resume texto largo en párrafo
- [ ] Resume en bullet points
- [ ] Genera TL;DR de una línea
- [ ] Texto <50 palabras → error apropiado
- [ ] Muestra compression ratio
- [ ] Respeta idioma del input

### Tool: explain

- [ ] Explica conceptos simples (eli5)
- [ ] Explica conceptos técnicos (intermediate)
- [ ] Incluye ejemplos cuando es útil
- [ ] Sugiere conceptos relacionados
- [ ] Funciona en español e inglés

### Integración

- [ ] Todas las tools registradas en registry
- [ ] Smart Router clasifica correctamente
- [ ] Modelo local se selecciona según intent
- [ ] Fallback a API funciona en todos los casos
- [ ] Métricas se actualizan correctamente

---

## Patrones de Clasificación

### translate

```typescript
const TRANSLATE_PATTERNS = [
  /\b(traduc[ei]|translate|traduzir)\b/i,
  /\b(al|to|para)\s+(inglés|español|francés|english|spanish|french)\b/i,
  /\b(en|in)\s+(inglés|español|english|spanish)\b/i,
  /\b(cómo se dice|how do you say)\b/i,
];
```

### grammar_check

```typescript
const GRAMMAR_PATTERNS = [
  /\b(corrig[ea]|correct|fix)\b.*\b(ortografía|gramática|grammar|spelling)\b/i,
  /\b(revisar?|check|review)\b.*\b(errores?|errors?)\b/i,
  /\b(está bien escrito|is this correct)\b/i,
  /\b(corrige esto|fix this|correct this)\b/i,
];
```

### summarize

```typescript
const SUMMARIZE_PATTERNS = [
  /\b(resum[ei]|summarize|summary)\b/i,
  /\b(tl;?dr|tldr)\b/i,
  /\b(en resumen|in summary)\b/i,
  /\b(puntos (principales|clave)|key points|main points)\b/i,
  /\b(brevemente|briefly)\b/i,
];
```

### explain

```typescript
const EXPLAIN_PATTERNS = [
  /\b(explica|explain|explicar)\b/i,
  /\b(qué es|what is|what are)\b/i,
  /\b(cómo funciona|how does .* work)\b/i,
  /\b(qué significa|what does .* mean)\b/i,
  /\b(definición de|definition of)\b/i,
];
```

---

## Manejo de Errores

### Errores Comunes

| Error | Causa | Respuesta al Usuario |
|-------|-------|---------------------|
| Model not loaded | Modelo no disponible | "Cargando modelo... (puede tomar unos segundos)" |
| Timeout | Modelo tardó >30s | "La operación tardó demasiado. Intentando con servicio alternativo..." |
| Empty input | Usuario no dio texto | "Necesito el texto que quieres [traducir/corregir/resumir]" |
| Unsupported language | Idioma no soportado | "No puedo traducir a [idioma]. Idiomas soportados: ..." |
| Text too short | Para summarize | "El texto es muy corto para resumir. ¿Quieres que lo explique?" |

### Fallback Chain

```
1. Intenta con modelo local preferido (ej: gemma2:9b)
   ↓ (si falla o timeout)
2. Intenta con modelo local alternativo (ej: qwen2.5:7b)
   ↓ (si falla o timeout)
3. Fallback a Kimi K2.5 (API)
   ↓ (si falla)
4. Error al usuario con mensaje claro
```

---

## Changelog

### 2026-02-01 - Análisis de riesgos integrado
- Agregada sección "Extracción Robusta de JSON" con código de referencia
- Learning Mode marcado como DIFERIDO/FUERA DE SCOPE
- Día 4 actualizado: JSON Extractor reemplaza Learning Preview
- Tests de JSON extraction con casos malformados agregados

### 2026-02-01 - Documento inicial
- Especificación de 4 tools: translate, grammar_check, summarize, explain
- Prompts templates para cada tool
- Patrones de clasificación
- Preview de Learning Mode
- Orden de implementación (5 días)
- Criterios de verificación

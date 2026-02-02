# Adaptive Fast-Path: Sistema de Aprendizaje Automático de Keywords

## Resumen Ejecutivo

Sistema que permite al fast-path aprender automáticamente nuevos keywords a partir del uso real, validando implícitamente a través del comportamiento del usuario post-clasificación.

**Objetivo**: Reducir dependencia del LLM classifier sin intervención manual, manteniendo precisión alta.

---

## 1. Problema Actual

### Situación
```
Usuario: "haceme acordar en 20 minutos..."
         │
         ▼
    Fast-path: NO MATCH (keywords: recordame, avisame...)
         │
         ▼
    LLM Classifier: 9.6 segundos
         │
         ▼
    intent: reminder → ejecutar (7ms)
```

### Limitaciones
- Keywords hardcodeados no cubren variaciones regionales/personales
- Agregar keywords manualmente no escala
- No hay feedback loop para mejorar
- Cada idioma requiere mantenimiento separado

---

## 2. Solución Propuesta

### Principio Central
> Si el LLM clasificó correctamente Y el usuario no se quejó → los tokens del input son válidos para ese intent.

### Flujo Completo

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MENSAJE DEL USUARIO                         │
│                  "haceme acordar en 20 min del banco"               │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           FAST-PATH CHECK                           │
│  Keywords base: [recordame, avisame, remind, alertame...]          │
│  Keywords aprendidos: [...desde SQLite...]                          │
│  Resultado: NO MATCH                                                │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          LLM CLASSIFIER                             │
│  Input → Qwen2.5:7b → intent: reminder, confidence: 0.98           │
│  Latencia: ~5-10 segundos                                           │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         EJECUTAR INTENT                             │
│  set_reminder("banco", "20 min") → SUCCESS                         │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    KEYWORD LEARNER: BUFFER                          │
│  Guardar en pending_validation:                                     │
│  {                                                                  │
│    input: "haceme acordar en 20 min del banco",                    │
│    tokens: ["haceme", "acordar", "20", "min", "banco"],            │
│    intent: "reminder",                                              │
│    confidence: 0.98,                                                │
│    timestamp: 1706850000,                                           │
│    execution_success: true                                          │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    ESPERAR SIGUIENTE MENSAJE                        │
└─────────────────────────────────────────────────────────────────────┘
          │                         │                         │
          ▼                         ▼                         ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────────────┐
│ SEÑAL POSITIVA  │   │ SEÑAL NEGATIVA  │   │ TIMEOUT (2 min)         │
│ "gracias"       │   │ "no, eso no"    │   │ Sin interacción         │
│ "perfecto"      │   │ "cancelar"      │   │                         │
│ (nuevo tema)    │   │ (repite request)│   │                         │
└─────────────────┘   └─────────────────┘   └─────────────────────────┘
          │                         │                         │
          ▼                         ▼                         ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────────────┐
│ VALIDAR         │   │ RECHAZAR        │   │ VALIDAR (implicit OK)   │
│ Extraer keywords│   │ Descartar       │   │ Extraer keywords        │
│ Persistir       │   │ Log para review │   │ Persistir               │
└─────────────────┘   └─────────────────┘   └─────────────────────────┘

                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      PRÓXIMA VEZ                                    │
│  "haceme acordar de..." → FAST-PATH MATCH (keywords aprendidos)    │
│  Latencia: <5ms                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Arquitectura de Componentes

### 3.1 Estructura de Archivos

```
src/agent/local-router/
├── fast-path.ts              # [MODIFICAR] Cargar keywords dinámicos
├── keyword-learner.ts        # [NUEVO] Lógica de aprendizaje
├── keyword-store.ts          # [NUEVO] Persistencia SQLite
├── validation-signals.ts     # [NUEVO] Detectar señales +/-
└── router-v2.ts              # [MODIFICAR] Integrar learner

src/memory/
└── store.ts                  # [MODIFICAR] Agregar tabla learned_keywords
```

### 3.2 Esquema de Base de Datos

```sql
-- Nueva tabla: learned_keywords
CREATE TABLE IF NOT EXISTS learned_keywords (
    id TEXT PRIMARY KEY,
    intent TEXT NOT NULL,              -- 'reminder', 'translate', etc.
    keyword TEXT NOT NULL,             -- 'haceme', 'acordar', etc.
    normalized TEXT NOT NULL,          -- sin acentos, lowercase
    source TEXT NOT NULL,              -- 'auto_learned', 'manual'
    confidence REAL NOT NULL,          -- confianza del LLM al aprenderlo
    created_at TEXT NOT NULL,          -- ISO timestamp
    last_used_at TEXT,                 -- última vez que matcheó
    use_count INTEGER DEFAULT 0,       -- veces usado en fast-path
    validated_by TEXT,                 -- 'implicit_ok', 'explicit_thanks', 'timeout'

    UNIQUE(intent, normalized)         -- no duplicar keyword por intent
);

-- Índices para performance
CREATE INDEX idx_learned_keywords_intent ON learned_keywords(intent);
CREATE INDEX idx_learned_keywords_normalized ON learned_keywords(normalized);

-- Nueva tabla: learning_rejections (para análisis)
CREATE TABLE IF NOT EXISTS learning_rejections (
    id TEXT PRIMARY KEY,
    input TEXT NOT NULL,
    intent TEXT NOT NULL,
    confidence REAL NOT NULL,
    rejection_signal TEXT NOT NULL,    -- qué dijo el usuario
    created_at TEXT NOT NULL
);
```

### 3.3 Componente: KeywordStore

```typescript
// src/agent/local-router/keyword-store.ts

interface LearnedKeyword {
  id: string;
  intent: string;
  keyword: string;
  normalized: string;
  source: 'auto_learned' | 'manual';
  confidence: number;
  createdAt: Date;
  lastUsedAt: Date | null;
  useCount: number;
  validatedBy: 'implicit_ok' | 'explicit_thanks' | 'timeout' | 'manual';
}

interface KeywordStore {
  // Queries
  getKeywordsByIntent(intent: string): LearnedKeyword[];
  getAllKeywords(): Map<string, LearnedKeyword[]>;

  // Mutations
  saveKeyword(keyword: Omit<LearnedKeyword, 'id'>): void;
  incrementUseCount(intent: string, normalized: string): void;
  deleteKeyword(id: string): void;

  // Maintenance
  pruneUnusedKeywords(maxAgeDays: number): number;
  getStats(): KeywordStats;
}
```

### 3.4 Componente: ValidationSignals

```typescript
// src/agent/local-router/validation-signals.ts

type SignalType = 'positive' | 'negative' | 'neutral' | 'topic_change';

interface SignalResult {
  type: SignalType;
  confidence: number;
  reason: string;
}

// Señales positivas (validar aprendizaje)
const POSITIVE_PATTERNS = [
  /^(gracias|thanks|thx|ty|genial|perfecto|exacto|ok|bueno|dale)[\s!.]*$/i,
  /^(si|yes|sip|sep|eso|correcto)[\s!.]*$/i,
  /^👍|👌|✅|🙏$/,
];

// Señales negativas (rechazar aprendizaje)
const NEGATIVE_PATTERNS = [
  /^(no|nope|cancel|eso no|mal|incorrecto|error)[\s!.]*$/i,
  /\b(no (era|quería|quise|pedí)|cancela|borra)\b/i,
  /^👎|❌|🚫$/,
];

// Detectar si es el mismo intent (retry = error previo)
function isSameIntentRetry(prevIntent: string, newInput: string): boolean;

// Detectar cambio de tema (validación implícita)
function isTopicChange(prevIntent: string, newInput: string): boolean;

// Función principal
function analyzeSignal(
  input: string,
  prevIntent: string,
  prevInput: string
): SignalResult;
```

### 3.5 Componente: KeywordLearner

```typescript
// src/agent/local-router/keyword-learner.ts

interface PendingValidation {
  input: string;
  normalizedTokens: string[];
  intent: string;
  confidence: number;
  timestamp: number;
  executionSuccess: boolean;
}

interface KeywordLearnerConfig {
  minConfidenceToLearn: number;      // 0.90 - threshold para considerar aprendizaje
  validationTimeoutMs: number;        // 120000 (2 min) - timeout para implicit OK
  maxKeywordsPerIntent: number;       // 100 - límite para evitar bloat
  pruneAfterDays: number;             // 30 - eliminar keywords no usados
}

class KeywordLearner {
  private pending: PendingValidation | null = null;
  private timeoutId: NodeJS.Timeout | null = null;
  private config: KeywordLearnerConfig;
  private store: KeywordStore;

  constructor(store: KeywordStore, config?: Partial<KeywordLearnerConfig>);

  /**
   * Llamado cuando LLM classifier se usa (fast-path no matcheó)
   * y la ejecución fue exitosa.
   */
  onLLMClassificationSuccess(
    input: string,
    intent: string,
    confidence: number
  ): void {
    // Solo considerar si confianza es alta
    if (confidence < this.config.minConfidenceToLearn) {
      return;
    }

    // Cancelar pending anterior si existe
    this.cancelPending();

    // Tokenizar y normalizar input
    const tokens = this.extractCandidateKeywords(input, intent);

    // Guardar como pendiente
    this.pending = {
      input,
      normalizedTokens: tokens,
      intent,
      confidence,
      timestamp: Date.now(),
      executionSuccess: true,
    };

    // Iniciar timeout
    this.timeoutId = setTimeout(() => {
      this.validatePending('timeout');
    }, this.config.validationTimeoutMs);
  }

  /**
   * Llamado en cada mensaje nuevo del usuario.
   */
  onNewUserMessage(input: string): void {
    if (!this.pending) return;

    const signal = analyzeSignal(input, this.pending.intent, this.pending.input);

    switch (signal.type) {
      case 'positive':
        this.validatePending('explicit_thanks');
        break;
      case 'negative':
        this.rejectPending(input);
        break;
      case 'topic_change':
        this.validatePending('implicit_ok');
        break;
      // 'neutral': mantener pending, esperar más señales
    }
  }

  /**
   * Extrae keywords candidatos del input.
   * Filtra stopwords, números, palabras muy cortas.
   */
  private extractCandidateKeywords(input: string, intent: string): string[] {
    const tokens = tokenize(input);

    // Filtrar
    return tokens.filter(token => {
      // Ignorar stopwords
      if (STOPWORDS.has(token)) return false;
      // Ignorar números puros
      if (/^\d+$/.test(token)) return false;
      // Ignorar muy cortos
      if (token.length < 3) return false;
      // Ignorar si ya es keyword base
      if (isBaseKeyword(intent, token)) return false;
      // Ignorar si ya está aprendido
      if (this.store.hasKeyword(intent, token)) return false;

      return true;
    });
  }

  /**
   * Valida y persiste los keywords pendientes.
   */
  private validatePending(validatedBy: string): void {
    if (!this.pending) return;

    const { normalizedTokens, intent, confidence } = this.pending;

    // Seleccionar los mejores keywords (no todos)
    const keywordsToSave = this.selectBestKeywords(normalizedTokens, intent);

    for (const keyword of keywordsToSave) {
      this.store.saveKeyword({
        intent,
        keyword,
        normalized: keyword,
        source: 'auto_learned',
        confidence,
        createdAt: new Date(),
        lastUsedAt: null,
        useCount: 0,
        validatedBy,
      });
    }

    logger.info('Keywords learned', {
      intent,
      keywords: keywordsToSave,
      validatedBy,
    });

    this.cancelPending();
  }

  /**
   * Rechaza el aprendizaje y loguea para análisis.
   */
  private rejectPending(rejectionSignal: string): void {
    if (!this.pending) return;

    // Guardar para análisis posterior
    this.store.saveRejection({
      input: this.pending.input,
      intent: this.pending.intent,
      confidence: this.pending.confidence,
      rejectionSignal,
    });

    logger.info('Learning rejected', {
      intent: this.pending.intent,
      signal: rejectionSignal,
    });

    this.cancelPending();
  }

  private cancelPending(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.pending = null;
  }

  /**
   * Selecciona los mejores keywords para aprender.
   * No todos los tokens son buenos keywords.
   */
  private selectBestKeywords(tokens: string[], intent: string): string[] {
    // Priorizar tokens que:
    // 1. Son verbos (terminan en -ar, -er, -ir, -ing)
    // 2. Son sustantivos relacionados al intent
    // 3. No son demasiado genéricos

    const scored = tokens.map(token => ({
      token,
      score: this.scoreKeywordCandidate(token, intent),
    }));

    // Ordenar por score y tomar top N
    return scored
      .filter(s => s.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3) // Max 3 keywords por aprendizaje
      .map(s => s.token);
  }

  private scoreKeywordCandidate(token: string, intent: string): number {
    let score = 0.5; // Base

    // Bonus: parece verbo
    if (/[aei]r$|ing$|ando$|iendo$/.test(token)) score += 0.2;

    // Bonus: longitud razonable (4-10 chars)
    if (token.length >= 4 && token.length <= 10) score += 0.1;

    // Penalty: muy común/genérico
    if (GENERIC_WORDS.has(token)) score -= 0.3;

    return Math.max(0, Math.min(1, score));
  }
}
```

### 3.6 Integración en Fast-Path

```typescript
// src/agent/local-router/fast-path.ts (modificado)

import { getLearnedKeywords } from './keyword-store.js';

// Keywords base (hardcoded, probados)
const BASE_INTENT_SIGNATURES: Record<string, IntentSignature> = {
  // ... existing signatures
};

/**
 * Combina keywords base con keywords aprendidos.
 * Llamado al inicio y periódicamente para refrescar.
 */
function buildIntentSignatures(): Record<string, IntentSignature> {
  const signatures = { ...BASE_INTENT_SIGNATURES };

  // Cargar keywords aprendidos de SQLite
  const learnedByIntent = getLearnedKeywords();

  for (const [intent, learned] of learnedByIntent) {
    if (signatures[intent]) {
      // Merge: base + learned
      const learnedKeywords = learned.map(k => k.normalized);
      signatures[intent] = {
        ...signatures[intent],
        primaryKeywords: [
          ...signatures[intent].primaryKeywords,
          ...learnedKeywords,
        ],
      };
    }
  }

  return signatures;
}

// Cache con refresh periódico
let cachedSignatures: Record<string, IntentSignature> | null = null;
let lastRefresh = 0;
const REFRESH_INTERVAL_MS = 60_000; // 1 minuto

function getSignatures(): Record<string, IntentSignature> {
  const now = Date.now();
  if (!cachedSignatures || now - lastRefresh > REFRESH_INTERVAL_MS) {
    cachedSignatures = buildIntentSignatures();
    lastRefresh = now;
  }
  return cachedSignatures;
}

export function tryFastPath(input: string): FastPathResult | null {
  const signatures = getSignatures();
  // ... rest of matching logic using signatures
}

/**
 * Forzar refresh del cache (llamar después de aprender keywords).
 */
export function refreshKeywordCache(): void {
  cachedSignatures = null;
}
```

### 3.7 Integración en Brain

```typescript
// src/agent/brain.ts (modificado)

import { getKeywordLearner } from './local-router/keyword-learner.js';

private async doThink(options: ThinkOptions): Promise<string> {
  // ... existing code ...

  // Notificar al learner de nuevo mensaje (para validación)
  if (!isProactiveMode && options.userInput) {
    getKeywordLearner().onNewUserMessage(options.userInput);
  }

  // ... routing logic ...

  // Si usamos LLM classifier y tuvo éxito, notificar al learner
  if (usedLLMClassifier && executionSuccess) {
    getKeywordLearner().onLLMClassificationSuccess(
      options.userInput,
      classifiedIntent,
      classificationConfidence
    );
  }

  // ... rest of code ...
}
```

---

## 4. Stopwords y Palabras Genéricas

```typescript
// src/agent/local-router/stopwords.ts

export const STOPWORDS = new Set([
  // Español
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'de', 'del', 'al', 'a', 'en', 'con', 'por', 'para',
  'que', 'cual', 'quien', 'como', 'donde', 'cuando',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa',
  'mi', 'tu', 'su', 'mis', 'tus', 'sus',
  'me', 'te', 'se', 'nos', 'les',
  'y', 'o', 'pero', 'sino', 'ni',
  'si', 'no', 'ya', 'muy', 'mas', 'menos',

  // English
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'with',
  'that', 'this', 'it', 'is', 'are', 'was', 'were',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'me', 'you', 'him', 'her', 'us', 'them',
  'and', 'or', 'but', 'if', 'not',
]);

export const GENERIC_WORDS = new Set([
  // Palabras muy comunes que no ayudan a clasificar
  'hacer', 'tener', 'poder', 'decir', 'ir', 'ver', 'dar', 'saber',
  'querer', 'llegar', 'pasar', 'deber', 'poner', 'parecer',
  'do', 'make', 'have', 'be', 'get', 'go', 'see', 'say',
  'want', 'need', 'take', 'give', 'know', 'think',
  'cosa', 'algo', 'todo', 'nada', 'thing', 'something', 'anything',
]);
```

---

## 5. Comandos de Administración

```
/keywords                    - Ver estadísticas de keywords aprendidos
/keywords list [intent]      - Listar keywords de un intent
/keywords add <intent> <kw>  - Agregar keyword manualmente
/keywords remove <id>        - Eliminar keyword
/keywords prune              - Eliminar keywords no usados
/keywords export             - Exportar a JSON (backup)
/keywords import <file>      - Importar desde JSON
```

---

## 6. Métricas y Observabilidad

```typescript
interface KeywordLearnerMetrics {
  // Counters
  totalLearned: number;
  totalRejected: number;
  totalPruned: number;

  // Por intent
  byIntent: Record<string, {
    baseKeywords: number;
    learnedKeywords: number;
    fastPathHits: number;
    llmFallbacks: number;
  }>;

  // Effectiveness
  fastPathHitRate: number;  // % de requests que matchean fast-path
  learningRate: number;      // keywords aprendidos por día

  // Quality
  avgConfidenceOfLearned: number;
  rejectionRate: number;
}
```

Logs importantes:
```
[keyword-learner] Keywords learned { intent: "reminder", keywords: ["acordar", "haceme"], validatedBy: "implicit_ok" }
[keyword-learner] Learning rejected { intent: "reminder", signal: "no eso no" }
[fast-path] Using learned keyword { intent: "reminder", keyword: "acordar", source: "auto_learned" }
[keyword-store] Pruned unused keywords { count: 5, olderThan: "30 days" }
```

---

## 7. Plan de Implementación

### Fase 1: Infraestructura (1-2 horas)
- [ ] Crear tabla `learned_keywords` en SQLite
- [ ] Crear tabla `learning_rejections` en SQLite
- [ ] Implementar `keyword-store.ts`
- [ ] Implementar `stopwords.ts`

### Fase 2: Detección de Señales (1 hora)
- [ ] Implementar `validation-signals.ts`
- [ ] Tests para señales positivas/negativas
- [ ] Tests para detección de topic change

### Fase 3: Keyword Learner (2 horas)
- [ ] Implementar `keyword-learner.ts`
- [ ] Lógica de extracción de keywords candidatos
- [ ] Lógica de scoring de keywords
- [ ] Tests unitarios

### Fase 4: Integración (1-2 horas)
- [ ] Modificar `fast-path.ts` para cargar keywords dinámicos
- [ ] Modificar `brain.ts` para notificar al learner
- [ ] Modificar `router-v2.ts` si es necesario

### Fase 5: Comandos Admin (1 hora)
- [ ] Implementar `/keywords` y subcomandos
- [ ] Documentar en /help

### Fase 6: Testing E2E (1 hora)
- [ ] Test: keyword aprendido aparece en fast-path
- [ ] Test: rechazo no guarda keyword
- [ ] Test: timeout valida implícitamente
- [ ] Test: prune elimina keywords viejos

---

## 8. Configuración

```typescript
// src/utils/config.ts (agregar)

keywordLearning: {
  enabled: true,
  minConfidenceToLearn: 0.90,
  validationTimeoutMs: 120_000,  // 2 minutos
  maxKeywordsPerIntent: 100,
  pruneAfterDays: 30,
  maxKeywordsPerLearning: 3,
}
```

---

## 9. Riesgos y Mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| LLM clasifica mal → aprende keyword incorrecto | Threshold alto (0.90), validación por comportamiento |
| Demasiados keywords → fast-path lento | Límite por intent (100), pruning automático |
| Keywords muy genéricos | Stopwords, scoring, filtros |
| Usuario siempre dice "ok" → falsos positivos | Detectar retry como señal negativa |
| Spam de keywords similares | UNIQUE constraint en DB, normalización |

---

## 10. Futuras Mejoras

1. **Embeddings para similarity**: Detectar keywords semánticamente similares
2. **Clustering de keywords**: Agrupar variantes del mismo concepto
3. **A/B testing**: Comparar fast-path hit rate con/sin aprendizaje
4. **Export/Import**: Compartir keywords entre instalaciones
5. **Confidence decay**: Reducir confianza de keywords poco usados

---

## 11. Ejemplo de Uso Completo

```
# Primera vez
Usuario: "haceme acordar de llamar al doctor"
Sistema: [Fast-path miss → LLM 5s → reminder ejecutado]
         [Buffer: {input, tokens: [haceme, acordar, llamar, doctor], intent: reminder}]

Usuario: "gracias"
Sistema: [Señal positiva detectada]
         [Keywords aprendidos: "acordar", "haceme"]
         [Log: Keywords learned {intent: reminder, keywords: [acordar, haceme]}]

# Segunda vez
Usuario: "haceme acordar de comprar leche"
Sistema: [Fast-path HIT via keyword "acordar"]
         [Ejecutar reminder en <5ms]
         [Log: Using learned keyword {intent: reminder, keyword: acordar}]
```

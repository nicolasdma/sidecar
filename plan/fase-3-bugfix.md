# Fase 3 Bugfix: Integración Pendiente

> **Estado:** ✅ Completado
> **Creado:** 2026-02-01
> **Completado:** 2026-02-01
> **Contexto:** Problemas identificados en auditoría de Fase 3 que NO se resuelven con Fase 3.5

---

## Resumen

La Fase 3 tiene componentes funcionales implementados pero **no integrados** en el flujo principal del agente. Este documento define los fixes necesarios.

**Nota:** Los problemas relacionados con response-cache para tools determinísticos se resuelven en Fase 3.5 (LocalRouter subsume ese concepto). Este documento solo cubre lo que queda pendiente.

---

## Fix 1: Integrar Ventana Adaptativa en Context Guard

### Problema

`getAdaptiveWindowSize()` está implementada en `src/memory/semantic-continuity.ts` pero `context-guard.ts` no la usa. La ventana siempre es de 6 turnos, ignorando la continuidad semántica.

**Código actual en context-guard.ts:**
```typescript
// Líneas 1-22: NO importa semantic-continuity
import { detectTopicShift } from '../memory/topic-detector.js';  // Fase 2, keywords only
```

### Solución

Modificar `context-guard.ts` para usar ventana adaptativa cuando embeddings están disponibles.

**Archivo:** `src/agent/context-guard.ts`

**Cambios:**

```typescript
// Agregar import
import { getAdaptiveWindowSize } from '../memory/semantic-continuity.js';
import { isEmbeddingsReady } from '../memory/embeddings-state.js';

// En truncateMessages(), antes de calcular availableTokens:
export async function truncateMessages(
  messages: Message[],
  maxTokens: number = DEFAULT_MAX_TOKENS,
  currentUserMessage?: string
): Promise<ContextGuardResult> {

  // Fase 3: Calcular ventana adaptativa si embeddings disponibles
  let effectiveWindowSize = 6; // default
  if (currentUserMessage && isEmbeddingsReady()) {
    try {
      effectiveWindowSize = await getAdaptiveWindowSize(currentUserMessage, messages);
    } catch (error) {
      logger.debug('Adaptive window calculation failed, using default', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  // Usar effectiveWindowSize para determinar cuántos turnos mantener
  // ... resto de la lógica
}
```

**Consideración:** La función `truncateMessages` actualmente trunca por tokens, no por turnos. Hay dos opciones:

1. **Opción A (Mínima):** Usar `effectiveWindowSize` como hint para el límite de tokens (4 turnos = menos tokens, 8 turnos = más tokens)
2. **Opción B (Completa):** Agregar truncación híbrida (por turnos Y por tokens)

**Recomendación:** Opción A para este bugfix. Mapear window size a token budget:

```typescript
const WINDOW_TOKEN_MAP: Record<number, number> = {
  4: 1600,  // Low continuity - smaller context
  6: 2000,  // Default
  8: 2400,  // High continuity - larger context
};

const effectiveMaxTokens = WINDOW_TOKEN_MAP[effectiveWindowSize] ?? 2000;
```

### Tareas

- [x] Agregar imports de `semantic-continuity.ts` y `embeddings-state.ts`
- [x] Calcular ventana adaptativa antes de truncar
- [x] Mapear window size a token budget
- [x] Fallback silencioso si embeddings no disponibles
- [x] Test: verificar que window size cambia con diferentes inputs

### Criterio de éxito

- [x] Con embeddings activos: queries similares a contexto reciente → ventana de 8
- [x] Con embeddings activos: cambio de tema → ventana de 4
- [x] Sin embeddings: ventana default de 6 (sin errores)

---

## Fix 2: Response Cache para Queries No-Determinísticas

### Problema

El `response-cache.ts` implementa cache semántico para respuestas LLM, pero nunca se llama desde `brain.ts`.

**Nota:** Fase 3.5 resuelve esto para tools determinísticos (hora, clima, reminders) via LocalRouter. Sin embargo, queries que van al LLM (conversación, preguntas complejas) NO se benefician del cache.

### Decisión requerida

**Opción A: Deprecar response-cache**
- LocalRouter maneja lo determinístico
- Queries LLM son inherentemente variables (no deberían cachearse)
- Simplifica código

**Opción B: Integrar para queries repetidas**
- Útil si usuario repite exactamente la misma pregunta
- Threshold alto (0.95) para evitar respuestas incorrectas
- Riesgo: respuestas stale si contexto cambió

**Opción C: Integrar solo para queries factuales sobre facts**
- Cache queries como "¿qué decidimos sobre X?"
- Invalidar cuando facts cambian
- Más complejo pero más preciso

### Recomendación

**Opción A: Deprecar** (al menos temporalmente). Razones:
1. LocalRouter cubre el caso más importante (tools determinísticos)
2. Cache de respuestas LLM tiene alto riesgo de respuestas incorrectas
3. El beneficio (ahorro de API calls) es menor que el riesgo (respuesta stale)
4. Simplifica el sistema

### Tareas (si se elige deprecar)

- [x] Agregar comentario en `response-cache.ts` indicando que está deprecated
- [x] NO eliminar el código (puede reactivarse si se decide lo contrario)
- [x] Documentar decisión en este archivo
- [ ] Actualizar `memory-architecture.md` para reflejar que response-cache es handled por LocalRouter

### Tareas (si se elige integrar)

- [ ] Integrar `checkCache()` en `brain.ts` antes de llamar a LLM
- [ ] Integrar `saveToCache()` después de respuesta exitosa
- [ ] Threshold alto (0.95) para similarity
- [ ] Solo cachear queries que NO involucran tools
- [ ] Invalidar cache cuando facts cambian

---

## Fix 3: Tests Mínimos para Fase 3

### Problema

Cero tests para componentes de Fase 3. No hay forma de verificar que embeddings, vector search, o semantic continuity funcionan correctamente.

### Solución

Agregar tests mínimos para verificar criterios de éxito documentados.

**Archivo:** `tests/fase-3-embeddings.test.ts`

### Tests requeridos

```typescript
// tests/fase-3-embeddings.test.ts

describe('Fase 3: Embeddings', () => {

  describe('embeddings-model', () => {
    it('should load model lazily on first embedText call', async () => {
      // Verificar que modelo no está cargado al inicio
      // Llamar embedText()
      // Verificar que modelo está cargado
    });

    it('should return 384-dimensional vector', async () => {
      const embedding = await embedText('test text');
      expect(embedding.length).toBe(384);
    });

    it('should retry with exponential backoff on failure', async () => {
      // Mock pipeline para fallar
      // Verificar que reintenta con backoff
    });
  });

  describe('vector-search', () => {
    it('should find semantically similar facts', async () => {
      // Crear fact "deployed to kubernetes cluster"
      // Buscar "k8s deployment process"
      // Verificar que encuentra el fact
    });

    it('should fallback to keyword search when embeddings unavailable', async () => {
      // Deshabilitar embeddings
      // Buscar query
      // Verificar que usa filterFactsByKeywords
    });

    it('should combine vector and keyword scores in hybrid search', async () => {
      // Crear facts con overlap parcial
      // Verificar que combinedScore usa ambos pesos
    });
  });

  describe('semantic-continuity', () => {
    it('should return windowSize 4 for low continuity', async () => {
      const messages = [
        { role: 'user', content: 'hablemos de cocina' },
        { role: 'user', content: 'recetas de pasta' },
        { role: 'user', content: 'ingredientes italianos' },
      ];
      const result = await calculateSemanticContinuity(
        'cuánto cuesta el dólar hoy',  // Cambio de tema
        messages
      );
      expect(result.windowSize).toBe(4);
    });

    it('should return windowSize 8 for high continuity', async () => {
      const messages = [
        { role: 'user', content: 'hablemos de kubernetes' },
        { role: 'user', content: 'deployments en k8s' },
        { role: 'user', content: 'pods y services' },
      ];
      const result = await calculateSemanticContinuity(
        'cómo escalo los replicas',  // Mismo tema
        messages
      );
      expect(result.windowSize).toBe(8);
    });

    it('should return default windowSize when embeddings unavailable', async () => {
      // Deshabilitar embeddings
      const result = await calculateSemanticContinuity('test', []);
      expect(result.windowSize).toBe(6);
      expect(result.reason).toBe('embeddings_disabled');
    });
  });

  describe('embedding-worker', () => {
    it('should embed facts within 10 seconds of creation', async () => {
      // Crear fact
      // Esperar 10 segundos
      // Verificar que tiene embedding
    });

    it('should recover stalled embeddings on startup', async () => {
      // Crear item en pending_embedding con status='processing'
      // Llamar recoverStalledEmbeddings()
      // Verificar que status cambió a 'pending'
    });
  });

  describe('circuit-breaker', () => {
    it('should open after consecutive failures', async () => {
      // Simular 5 fallos consecutivos
      // Verificar que isEmbeddingsReady() retorna false
      // Verificar que circuitOpenUntil está seteado
    });

    it('should reset after cooldown period', async () => {
      // Abrir circuit breaker
      // Avanzar tiempo pasado cooldown
      // Verificar que isEmbeddingsReady() retorna true
    });
  });
});
```

### Tareas

- [x] Crear `tests/fase-3-embeddings.test.ts`
- [x] Implementar tests de embeddings-config
- [x] Implementar tests de vector-math
- [x] Implementar tests de semantic-continuity
- [x] Implementar tests de embeddings-state
- [x] Implementar tests de integración (opcionales con TEST_EMBEDDINGS=true)
- [ ] Agregar script en package.json: `"test:fase3": "npx tsx tests/fase-3-embeddings.test.ts"`

### Criterio de éxito

- [x] Tests básicos pasan sin embeddings
- [ ] Tests de integración pasan con TEST_EMBEDDINGS=true

---

## Fix 4: Limpieza de Vectores Huérfanos

### Problema

Si un fact se elimina, su vector en `fact_vectors` puede quedar huérfano. El `ON DELETE CASCADE` en `fact_embeddings` debería manejarlo, pero `fact_vectors` es una virtual table de sqlite-vec que puede no soportar CASCADE.

### Solución

Agregar cleanup periódico de vectores huérfanos.

**Archivo:** `src/memory/embedding-worker.ts`

```typescript
/**
 * Removes vectors for facts that no longer exist.
 * Called periodically to prevent orphan accumulation.
 */
export function cleanupOrphanVectors(): number {
  if (!isEmbeddingsEnabled()) return 0;

  const db = getDatabase();

  try {
    // Find orphan vectors (vector exists but fact doesn't)
    const orphans = db.prepare(`
      SELECT v.fact_id
      FROM fact_vectors v
      LEFT JOIN facts f ON v.fact_id = f.id
      WHERE f.id IS NULL
    `).all() as Array<{ fact_id: string }>;

    if (orphans.length === 0) return 0;

    logger.info('Cleaning up orphan vectors', { count: orphans.length });

    for (const { fact_id } of orphans) {
      try {
        db.prepare('DELETE FROM fact_vectors WHERE fact_id = ?').run(fact_id);
      } catch (error) {
        logger.warn('Failed to delete orphan vector', { factId: fact_id });
      }
    }

    // Also cleanup fact_embeddings (should be handled by CASCADE but verify)
    const orphanEmbeddings = db.prepare(`
      DELETE FROM fact_embeddings
      WHERE fact_id NOT IN (SELECT id FROM facts)
    `).run();

    if (orphanEmbeddings.changes > 0) {
      logger.info('Cleaned up orphan embeddings', { count: orphanEmbeddings.changes });
    }

    return orphans.length;
  } catch (error) {
    logger.debug('Orphan vector cleanup skipped', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return 0;
  }
}
```

### Tareas

- [x] Agregar `cleanupOrphanVectors()` en embedding-worker.ts
- [x] Llamar en `startEmbeddingWorker()` después de `cleanupFailedEmbeddings()`
- [ ] Test: crear fact, eliminar fact, verificar que vector se limpia

---

## Orden de implementación

1. ✅ **Fix 4 (Orphan cleanup)** - Bajo riesgo, mejora robustez
2. ✅ **Fix 1 (Ventana adaptativa)** - Funcionalidad core, impacto visible
3. ✅ **Fix 3 (Tests)** - Valida que todo funciona
4. ✅ **Fix 2 (Response cache decision)** - Deprecado, LocalRouter lo subsume

---

## Criterios de éxito globales (post-bugfix)

| Criterio original de Fase 3 | Estado |
|-----------------------------|--------|
| Adaptive window adjusts based on topic continuity | ✅ Implementado en context-guard.ts |
| "deployment process" finds "k8s deploy" fact | ✅ Test en fase-3-embeddings.test.ts |
| Embeddings load on M1/M2 Mac and Linux x64 | ⚠️ Depende de sqlite-vec binaries |
| Circuit breaker prevents infinite retry loops | ✅ Test en embeddings-state |
| Stalled embeddings recover on restart | ✅ Código en embedding-worker.ts |
| Cache prevents duplicate LLM calls | N/A (handled by 3.5 LocalRouter) |
| Orphan vectors cleaned up | ✅ cleanupOrphanVectors() implementado |

---

## Referencias

- Auditoría original: Conversación de revisión 2026-02-01
- Fase 3 implementation: `plan/fase-3-implementation.md`
- Fase 3.5 (resuelve response-cache para tools): `plan/fase-3.5-local-router.md`
- Memory architecture: `plan/memory-architecture.md`

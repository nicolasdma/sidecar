# Fase 3: Bugfixes and Hardening

> **Status:** Critical & Medium items DONE, Low items pending
> **Created:** 2026-02-01
> **Updated:** 2026-02-01
> **Priority:** High - Fix before Fase 4

---

## Summary

Post-implementation review of Fase 3 (Semantic Intelligence) identified several issues ranging from critical to low severity. This document specifies the fixes required.

---

## Critical Issues

### 1. Embedding Queue Unbounded Growth

**Problem:** If the embedding model never loads (e.g., network issues, disk full), the queue grows indefinitely because `processEmbeddingQueue()` exits early when `isEmbeddingsReady()` returns false, but `queueFactForEmbedding()` keeps adding items.

**Location:** `src/memory/embedding-worker.ts`

**Fix:**
```typescript
// Add to embedding-worker.ts

const MAX_PENDING_EMBEDDINGS = 1000;

/**
 * Enforces max queue size by removing oldest pending items.
 * Called when queue exceeds threshold.
 */
export function enforceEmbeddingQueueLimit(): number {
  const database = getDatabase();
  const count = getPendingEmbeddingCount();

  if (count <= MAX_PENDING_EMBEDDINGS) {
    return 0;
  }

  const toRemove = count - MAX_PENDING_EMBEDDINGS;
  const stmt = database.prepare(`
    DELETE FROM pending_embedding
    WHERE id IN (
      SELECT id FROM pending_embedding
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    )
  `);
  const result = stmt.run(toRemove);

  if (result.changes > 0) {
    logger.warn('Enforced embedding queue limit', {
      removed: result.changes,
      maxSize: MAX_PENDING_EMBEDDINGS,
    });
  }

  return result.changes;
}
```

**Integration:** Call `enforceEmbeddingQueueLimit()` in `startEmbeddingWorker()` after `queueMissingEmbeddings()`.

---

### 2. No Schema Version Tracking

**Problem:** There's no way to detect which migration version a user's database is at. Future schema changes will be risky.

**Location:** `src/memory/store.ts`

**Fix:** Add schema version table and migration runner.

```typescript
// Add to store.ts SCHEMA constant
const SCHEMA_VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`;

// Add migration runner
interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  // Future migrations go here
  // { version: 4, name: 'add-embedding-metadata', sql: '...' },
];

function getSchemaVersion(database: Database.Database): number {
  try {
    const row = database.prepare(
      'SELECT version FROM schema_version WHERE id = 1'
    ).get() as { version: number } | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

function setSchemaVersion(database: Database.Database, version: number): void {
  database.prepare(`
    INSERT INTO schema_version (id, version) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET version = ?, updated_at = datetime('now')
  `).run(version, version);
}

function runMigrations(database: Database.Database): void {
  const currentVersion = getSchemaVersion(database);

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      logger.info('Applying migration', {
        version: migration.version,
        name: migration.name
      });

      database.transaction(() => {
        database.exec(migration.sql);
        setSchemaVersion(database, migration.version);
      })();
    }
  }
}
```

**Integration:**
1. Add `SCHEMA_VERSION_TABLE` to SCHEMA constant
2. Call `runMigrations(db)` after `runFase2Migrations(db)` in `getDatabase()`
3. Set initial version to 3 for new databases

---

## Medium Issues

### 3. fact_embeddings ↔ fact_vectors Index Drift

**Problem:** If `upsertFactVector()` fails silently (caught error at `embedding-worker.ts:155-164`), the embedding exists in `fact_embeddings` but not in `fact_vectors`. Vector search will miss these facts.

**Location:** `src/memory/embedding-worker.ts`

**Fix:** Add reconciliation function and call on startup.

```typescript
// Add to embedding-worker.ts

/**
 * Reconciles fact_embeddings with fact_vectors.
 * Re-indexes any embeddings that exist but aren't in the vector index.
 */
export function reconcileVectorIndex(): number {
  if (!isEmbeddingsEnabled()) return 0;

  const database = getDatabase();

  try {
    // Find embeddings missing from vector index
    const missing = database.prepare(`
      SELECT e.fact_id, e.embedding
      FROM fact_embeddings e
      LEFT JOIN fact_vectors v ON e.fact_id = v.fact_id
      WHERE v.fact_id IS NULL
    `).all() as Array<{ fact_id: string; embedding: Buffer }>;

    if (missing.length === 0) return 0;

    logger.info('Reconciling vector index', { count: missing.length });

    let indexed = 0;
    for (const row of missing) {
      try {
        upsertFactVector(database, row.fact_id, row.embedding);
        indexed++;
      } catch (error) {
        // If vector index still unavailable, stop trying
        logger.warn('Vector index reconciliation failed', {
          factId: row.fact_id,
          error: error instanceof Error ? error.message : 'Unknown',
        });
        break;
      }
    }

    logger.info('Vector index reconciliation complete', { indexed });
    return indexed;
  } catch (error) {
    // fact_vectors table might not exist
    logger.debug('Vector index reconciliation skipped', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return 0;
  }
}
```

**Integration:** Call `reconcileVectorIndex()` in `startEmbeddingWorker()` after `recoverStalledEmbeddings()`.

---

### 4. Response Cache Never Auto-Cleaned

**Problem:** `cleanupExpiredCache()` exists but is never scheduled. The `response_cache` table grows unbounded.

**Location:** `src/memory/response-cache.ts`

**Fix:** Add cleanup to embedding worker tick (runs every 10 seconds, cleanup runs once per hour).

```typescript
// Add to embedding-worker.ts

let lastCacheCleanup = 0;
const CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function processEmbeddingQueue(): Promise<void> {
  // ... existing mutex check ...

  // Periodic cache cleanup (once per hour)
  if (Date.now() - lastCacheCleanup > CACHE_CLEANUP_INTERVAL_MS) {
    cleanupExpiredCache();
    cleanupFailedEmbeddings();
    lastCacheCleanup = Date.now();
  }

  // ... rest of existing code ...
}
```

**Integration:** Import `cleanupExpiredCache` from `response-cache.ts` in `embedding-worker.ts`.

---

### 5. SOUL.md Changes Not Detected During Session

**Problem:** `soulHash` is cached at module load. Changes to SOUL.md during a session aren't detected, leading to stale cache hits.

**Location:** `src/memory/response-cache.ts`

**Fix:** Add file watcher or check mtime on each cache lookup.

```typescript
// Modify response-cache.ts

import { statSync } from 'fs';

let soulHash: string | null = null;
let soulMtime: number = 0;

function computeSoulHash(): string {
  const soulPath = join(process.cwd(), 'SOUL.md');

  if (!existsSync(soulPath)) {
    return 'default';
  }

  try {
    const stat = statSync(soulPath);
    const currentMtime = stat.mtimeMs;

    // Recompute if file changed or first call
    if (soulHash === null || currentMtime !== soulMtime) {
      const content = readFileSync(soulPath, 'utf8');
      soulHash = createHash('md5').update(content).digest('hex').slice(0, 8);
      soulMtime = currentMtime;
      logger.debug('Computed SOUL hash', { hash: soulHash, mtime: currentMtime });
    }

    return soulHash;
  } catch (error) {
    logger.warn('Failed to read SOUL.md for hash', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return 'default';
  }
}
```

---

## Low Priority Issues

### 6. No Batch Embedding API

**Problem:** `embedTexts()` calls `embedText()` in a loop. Batch inference would be faster.

**Location:** `src/memory/embeddings-model.ts`

**Fix:** Use transformers.js batch API.

```typescript
// Replace embedTexts in embeddings-model.ts

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  await ensureModelLoaded();

  if (!embeddingPipeline) {
    throw new Error('Embedding model not loaded');
  }

  // Batch process all texts at once
  const outputs = await embeddingPipeline(texts, {
    pooling: 'mean',
    normalize: true,
  });

  // Handle both single and batch outputs
  if (texts.length === 1) {
    return [new Float32Array(outputs.data)];
  }

  // Split batch output into individual embeddings
  const dim = getEmbeddingsConfig().embeddingDimension;
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i++) {
    const start = i * dim;
    const end = start + dim;
    results.push(new Float32Array(outputs.data.slice(start, end)));
  }

  return results;
}
```

**Note:** Test this carefully - transformers.js batch API behavior may vary by model.

---

### 7. Transformers.js Memory Cleanup

**Problem:** The embedding pipeline is never disposed, potential memory leak in long-running processes.

**Location:** `src/memory/embeddings-model.ts`

**Fix:** Add dispose function and call on shutdown.

```typescript
// Add to embeddings-model.ts

/**
 * Disposes the embedding pipeline to free memory.
 * Call this on application shutdown.
 */
export async function disposePipeline(): Promise<void> {
  if (embeddingPipeline) {
    // transformers.js pipelines may have a dispose method
    if (typeof (embeddingPipeline as any).dispose === 'function') {
      await (embeddingPipeline as any).dispose();
    }
    embeddingPipeline = null;
    loadingPromise = null;
    logger.info('Embedding pipeline disposed');
  }
}
```

**Integration:** Call `disposePipeline()` in the shutdown handler in `index.ts`.

---

### 8. Verify Brain.ts Cache Integration

**Problem:** The plan specifies cache check/save in `brain.ts` but this wasn't verified as implemented.

**Location:** `src/agent/brain.ts`

**Fix:** Verify and add if missing.

```typescript
// In brain.ts think() method

import { checkCache, saveToCache, classifyQueryTTL } from '../memory/response-cache.js';

async think(optionsOrInput: string | ThinkOptions): Promise<string> {
  // ... build context, get relevantFacts ...

  const retrievedFactIds = relevantFacts.map(f => f.id);

  // Check cache before LLM call
  const cachedResponse = await checkCache(userInput, retrievedFactIds);
  if (cachedResponse) {
    logger.debug('Response cache hit');
    saveMessage({ role: 'assistant', content: cachedResponse });
    return cachedResponse;
  }

  // ... LLM call ...

  // Save to cache after successful response
  const ttl = classifyQueryTTL(userInput);
  saveToCache(userInput, retrievedFactIds, response, ttl).catch(err => {
    logger.warn('Failed to save to cache', { error: err.message });
  });

  return response;
}
```

---

## Implementation Checklist

### Critical (Must Fix)
- [x] Add `enforceEmbeddingQueueLimit()` to prevent unbounded queue growth ✓
- [x] Add `schema_version` table and migration runner ✓

### Medium (Should Fix)
- [x] Add `reconcileVectorIndex()` for fact_embeddings ↔ fact_vectors consistency ✓
- [x] Add periodic `cleanupExpiredCache()` to embedding worker ✓
- [x] Fix SOUL.md hash to check mtime on each lookup ✓

### Low (Nice to Have)
- [ ] Implement batch embedding in `embedTexts()`
- [ ] Add `disposePipeline()` for memory cleanup on shutdown
- [~] Verify brain.ts cache integration is wired up (VERIFIED: not implemented, deferred to future)

---

## Testing Plan

1. **Queue Limit Test**
   ```bash
   # Disable embeddings, create 2000 facts, re-enable
   # Verify queue is capped at 1000
   ```

2. **Migration Test**
   ```bash
   # Check schema_version table exists after startup
   sqlite3 data/sidecar.db "SELECT * FROM schema_version"
   ```

3. **Vector Index Reconciliation Test**
   ```bash
   # Delete some rows from fact_vectors manually
   # Restart app
   # Verify reconciliation log message
   ```

4. **Cache Cleanup Test**
   ```bash
   # Insert expired cache entry manually
   # Wait 1 hour or force cleanup
   # Verify entry is deleted
   ```

5. **SOUL.md Hot Reload Test**
   ```bash
   # Query something, get cached response
   # Modify SOUL.md
   # Same query should miss cache
   ```

---

## Rollback

All fixes are additive and defensive. If issues arise:
1. Set `EMBEDDINGS_ENABLED=false` to disable all semantic features
2. Revert to previous commit
3. System falls back to Fase 2 keyword search automatically

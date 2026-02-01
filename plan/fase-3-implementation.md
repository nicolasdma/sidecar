# Fase 3: Semantic Intelligence Implementation Plan

> **Status:** Implemented + Hardened
> **Created:** 2026-02-01
> **Updated:** 2026-02-01 (incorporated architecture review feedback)
> **Implemented:** 2026-02-01
> **Hardened:** 2026-02-01 (critical bugfixes applied)
> **Depends on:** Fase 2 (Complete)

---

## Table of Contents

1. [Decisions](#decisions-finalized)
2. [Scope](#scope)
3. [Architecture](#architecture)
4. [Configuration](#configuration)
5. [Critical Design Decisions](#critical-design-decisions)
6. [Implementation Tasks](#implementation-tasks)
7. [Database Migration](#database-migration)
8. [Prerequisites](#prerequisites)
9. [Verification Plan](#verification-plan)
10. [Success Criteria](#success-criteria)
11. [Risk Mitigation](#risk-mitigation-summary)
12. [Performance Targets](#performance-targets)
13. [Rollback Plan](#rollback-plan)
14. [Implementation Order](#implementation-order)
15. [Post-Implementation Hardening](#post-implementation-hardening)

---

## Decisions (Finalized)

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| **Embedding Model** | `all-MiniLM-L6-v2` via transformers.js | 80MB, 384-dim, runs in Node.js without Python |
| **Vector Storage** | `sqlite-vec` extension | Single file DB, no external deps, ~10ms search |
| **Distribution** | System path detection + bundled fallback | Prefer system install, bundle for convenience |
| **Fallback** | Keyword matching (Fase 2) | Graceful degradation if embeddings unavailable |
| **Cache Backend** | SQLite table with version tracking | Consistent with rest of memory system |
| **Model Loading** | Lazy (on first use) | Avoids blocking startup |
| **Feature Toggle** | `EMBEDDINGS_ENABLED` env var | Allows developers to disable for fast iteration |

---

## Scope

Fase 3 implements semantic retrieval from `memory-architecture.md`:

1. **Local Embeddings** - Embed facts at creation, embed queries at runtime
2. **Vector Search** - sqlite-vec for cosine similarity ranking
3. **Adaptive Window** - 4-8 turns based on semantic continuity
4. **Response Cache** - Deduplicate similar queries with version tracking
5. **Graceful Degradation** - Fall back to Fase 2 if embeddings fail

---

## Architecture

```
┌─────────────────┐
│  User Message   │
└────────┬────────┘
         ▼
┌─────────────────┐     ┌─────────────────────┐
│  Embed Query    │────▶│  Vector Search      │
│  (lazy load)    │     │  (sqlite-vec)       │
└────────┬────────┘     └─────────┬───────────┘
         │                        │
         │ If embeddings fail     │ Top-K with scores
         ▼                        ▼
┌─────────────────┐     ┌─────────────────────┐
│  Keyword Match  │     │  Weighted Merge     │
│  (Fase 2)       │     │  (vector + keyword) │
└────────┬────────┘     └─────────┬───────────┘
         │                        │
         ▼                        ▼
┌─────────────────────────────────────────────┐
│  Check Response Cache                        │
│  (similarity > threshold + version match)   │
└────────┬────────────────────────────────────┘
         │
         ▼ (cache miss)
┌─────────────────┐
│   Main LLM      │
│   (Kimi K2.5)   │
└─────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│  Async: Queue fact embedding (non-blocking) │
└─────────────────────────────────────────────┘
```

---

## Configuration

### Environment Variables

Create or update `.env` with these optional settings:

```bash
# Fase 3: Semantic Intelligence Configuration

# Master toggle - set to 'false' to disable embeddings entirely
# Useful for fast development iteration or debugging
EMBEDDINGS_ENABLED=true

# Cache similarity threshold (0.0 - 1.0)
# Lower = more cache hits, higher = more precise matching
CACHE_SIMILARITY_THRESHOLD=0.90

# Circuit breaker settings
CIRCUIT_BREAKER_THRESHOLD=5
CIRCUIT_BREAKER_RESET_MS=60000
```

### Configuration Module

**New file:** `src/config/embeddings-config.ts`

```typescript
// src/config/embeddings-config.ts

export interface EmbeddingsConfig {
  enabled: boolean;
  cacheSimilarityThreshold: number;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
  modelName: string;
  embeddingDimension: number;
}

export function loadEmbeddingsConfig(): EmbeddingsConfig {
  return {
    enabled: process.env.EMBEDDINGS_ENABLED !== 'false',
    cacheSimilarityThreshold: parseFloat(process.env.CACHE_SIMILARITY_THRESHOLD || '0.90'),
    circuitBreakerThreshold: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '5', 10),
    circuitBreakerResetMs: parseInt(process.env.CIRCUIT_BREAKER_RESET_MS || '60000', 10),
    modelName: 'Xenova/all-MiniLM-L6-v2',
    embeddingDimension: 384,
  };
}

// Singleton instance
let config: EmbeddingsConfig | null = null;

export function getEmbeddingsConfig(): EmbeddingsConfig {
  if (!config) {
    config = loadEmbeddingsConfig();
  }
  return config;
}
```

---

## Critical Design Decisions

### Decision 1: sqlite-vec Integration Strategy

**Problem:** sqlite-vec is a C extension, not available via npm.

**Solution:** Detect system installation first, fall back to bundled binaries.

```
/vendor/
  sqlite-vec/
    darwin-arm64/vec0.dylib
    darwin-x64/vec0.dylib
    linux-x64/vec0.so
    README.md  # Build instructions for unsupported platforms
```

**Loading strategy with system path detection:**

```typescript
// src/memory/embeddings-loader.ts
import { platform, arch } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';
import { logger } from '../utils/logger';

const EXTENSION_MAP: Record<string, string> = {
  'darwin-arm64': 'darwin-arm64/vec0.dylib',
  'darwin-x64': 'darwin-x64/vec0.dylib',
  'linux-x64': 'linux-x64/vec0.so',
};

// Common system paths where sqlite-vec might be installed
const SYSTEM_PATHS: Record<string, string[]> = {
  darwin: [
    '/opt/homebrew/lib/vec0.dylib',
    '/usr/local/lib/vec0.dylib',
  ],
  linux: [
    '/usr/lib/sqlite3/vec0.so',
    '/usr/local/lib/vec0.so',
  ],
};

function findSystemExtension(): string | null {
  const paths = SYSTEM_PATHS[platform()] || [];
  for (const p of paths) {
    if (existsSync(p)) {
      logger.debug('Found system sqlite-vec', { path: p });
      return p;
    }
  }
  return null;
}

function findBundledExtension(): string | null {
  const key = `${platform()}-${arch()}`;
  const relativePath = EXTENSION_MAP[key];

  if (!relativePath) {
    logger.warn('sqlite-vec not bundled for platform', { platform: key });
    return null;
  }

  const extensionPath = join(__dirname, '../../vendor/sqlite-vec', relativePath);

  if (!existsSync(extensionPath)) {
    logger.warn('sqlite-vec binary not found', { path: extensionPath });
    return null;
  }

  return extensionPath;
}

export interface LoadExtensionResult {
  success: boolean;
  source: 'system' | 'bundled' | 'none';
  error?: string;
}

export function loadSqliteVec(db: Database.Database): LoadExtensionResult {
  // Try system installation first (preferred for updates)
  const systemPath = findSystemExtension();
  if (systemPath) {
    try {
      db.loadExtension(systemPath);
      logger.info('sqlite-vec loaded from system', { path: systemPath });
      return { success: true, source: 'system' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('System sqlite-vec failed, trying bundled', { error: message });

      // Check for ABI mismatch
      if (message.includes('symbol') || message.includes('undefined')) {
        logger.warn('Possible SQLite version mismatch between sqlite-vec and better-sqlite3');
      }
    }
  }

  // Fall back to bundled binary
  const bundledPath = findBundledExtension();
  if (!bundledPath) {
    return { success: false, source: 'none', error: 'No compatible binary found' };
  }

  try {
    db.loadExtension(bundledPath);
    logger.info('sqlite-vec loaded from bundle', { path: bundledPath });
    return { success: true, source: 'bundled' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to load sqlite-vec', { error: message });
    return { success: false, source: 'none', error: message };
  }
}

/**
 * Create the vector virtual table after extension is loaded.
 */
export function createVectorIndex(db: Database.Database): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fact_vectors USING vec0(
        fact_id TEXT PRIMARY KEY,
        embedding FLOAT[384]
      );
    `);
    logger.info('Vector index created');
  } catch (error) {
    logger.error('Failed to create vector index', { error });
    throw error;
  }
}
```

**Fallback behavior:** If all loading attempts fail, `embeddingsEnabled = false` and system uses keyword matching.

---

### Decision 2: Semantic Continuity Formula

**Problem:** "semantic_continuity calculated by embeddings" is undefined.

**Solution:** Concrete formula with bootstrap handling.

```typescript
// src/memory/semantic-continuity.ts
import { embedText, isEmbeddingsReady } from './embeddings-model';
import { cosineSimilarity, calculateCentroid } from './vector-math';
import { logger } from '../utils/logger';
import { Message } from '../types';

interface ContinuityResult {
  score: number;        // 0.0 - 1.0
  windowSize: number;   // 4, 6, or 8
  reason: 'bootstrap' | 'embeddings_disabled' | 'calculated' | 'error';
}

/**
 * Calculates semantic continuity between current message and recent context.
 *
 * Formula: cosine(embed(currentMessage), embed(centroid(last3UserMessages)))
 *
 * Bootstrap behavior:
 * - turns < 3: return { score: 0.5, windowSize: 6, reason: 'bootstrap' }
 * - No embeddings: return { score: 0.5, windowSize: 6, reason: 'embeddings_disabled' }
 */
export async function calculateSemanticContinuity(
  currentMessage: string,
  previousMessages: Message[]
): Promise<ContinuityResult> {
  // Bootstrap case
  const userMessages = previousMessages.filter(m => m.role === 'user');
  if (userMessages.length < 3) {
    return { score: 0.5, windowSize: 6, reason: 'bootstrap' };
  }

  // Embeddings not ready case
  if (!isEmbeddingsReady()) {
    return { score: 0.5, windowSize: 6, reason: 'embeddings_disabled' };
  }

  try {
    // Get embeddings
    const currentEmbed = await embedText(currentMessage);
    const previousEmbeds = await Promise.all(
      userMessages.slice(-3).map(m => embedText(m.content || ''))
    );

    // Calculate centroid of last 3 user messages
    const centroid = calculateCentroid(previousEmbeds);

    // Cosine similarity
    const score = cosineSimilarity(currentEmbed, centroid);

    // Map score to window size
    const windowSize = scoreToWindowSize(score);

    return { score, windowSize, reason: 'calculated' };
  } catch (error) {
    logger.warn('Continuity calculation failed', { error });
    return { score: 0.5, windowSize: 6, reason: 'error' };
  }
}

function scoreToWindowSize(score: number): number {
  if (score < 0.3) return 4;   // Low continuity = smaller window
  if (score > 0.7) return 8;   // High continuity = larger window
  return 6;                     // Default
}
```

---

### Decision 3: Embedding Retry Queue with Recovery

**Problem:** Async fact embedding can fail, leaving facts without vectors.

**Solution:** `pending_embedding` table with proper stall recovery and cleanup.

```sql
-- Fase 3: Pending embedding queue
CREATE TABLE IF NOT EXISTS pending_embedding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id TEXT NOT NULL UNIQUE,
  attempts INTEGER DEFAULT 0,
  last_attempt_at TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_embedding_status ON pending_embedding(status);

-- Fact embeddings storage
CREATE TABLE IF NOT EXISTS fact_embeddings (
  fact_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,          -- 384 floats = 1536 bytes
  model_version TEXT NOT NULL,      -- 'all-MiniLM-L6-v2'
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
);
```

**Stall recovery implementation:**

```typescript
const STALL_TIMEOUT_MINUTES = 5;
const MAX_ATTEMPTS = 3;
const FAILED_RETENTION_DAYS = 7;  // Cleanup old failed items

/**
 * Recover items stuck in 'processing' status (from crashed workers).
 * Called on worker startup.
 */
export function recoverStalledEmbeddings(): number {
  const result = db.prepare(`
    UPDATE pending_embedding
    SET status = 'pending',
        attempts = attempts + 1
    WHERE status = 'processing'
      AND datetime(last_attempt_at, '+${STALL_TIMEOUT_MINUTES} minutes') < datetime('now')
  `).run();

  if (result.changes > 0) {
    logger.info('Recovered stalled embeddings', { count: result.changes });
  }

  // Mark items with too many attempts as failed
  const failed = db.prepare(`
    UPDATE pending_embedding
    SET status = 'failed',
        error = 'Max attempts exceeded'
    WHERE status = 'pending'
      AND attempts >= ?
  `).run(MAX_ATTEMPTS);

  if (failed.changes > 0) {
    logger.warn('Marked embeddings as failed (max attempts)', { count: failed.changes });
  }

  return result.changes;
}

/**
 * Cleanup old failed embedding records to prevent table bloat.
 */
export function cleanupFailedEmbeddings(): number {
  const result = db.prepare(`
    DELETE FROM pending_embedding
    WHERE status = 'failed'
      AND datetime(created_at, '+${FAILED_RETENTION_DAYS} days') < datetime('now')
  `).run();

  if (result.changes > 0) {
    logger.debug('Cleaned up old failed embeddings', { count: result.changes });
  }

  return result.changes;
}
```

**Re-embedding on model change:**

```typescript
const CURRENT_MODEL_VERSION = 'all-MiniLM-L6-v2';

async function ensureEmbeddingsUpToDate(): Promise<void> {
  const outdated = db.prepare(`
    SELECT f.id FROM facts f
    LEFT JOIN fact_embeddings e ON f.id = e.fact_id
    WHERE f.stale = 0 AND f.archived = 0
      AND (e.fact_id IS NULL OR e.model_version != ?)
  `).all(CURRENT_MODEL_VERSION);

  if (outdated.length > 0) {
    logger.info('Queueing facts for re-embedding', { count: outdated.length });
    for (const { id } of outdated) {
      queueFactForEmbedding(id);
    }
  }
}
```

---

### Decision 4: Cache Invalidation Strategy with Version Tracking

**Problem:** Stale cache after fact correction OR system prompt/model changes.

**Solution:** Cache key includes hash of relevant fact IDs AND system version (computed automatically).

```typescript
// src/memory/response-cache.ts
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { embedText, isEmbeddingsReady } from './embeddings-model';
import { cosineSimilarity, serializeEmbedding, deserializeEmbedding } from './vector-math';
import { getEmbeddingsConfig } from '../config/embeddings-config';
import { logger } from '../utils/logger';
import { getDatabase } from './store';

interface CacheEntry {
  query_hash: string;           // hash of normalized query
  query_embedding: Buffer;      // for similarity check
  fact_ids_hash: string;        // hash of sorted fact IDs used
  system_version: string;       // hash of system prompt + model ID
  response: string;
  created_at: string;
  ttl_seconds: number;
}

export const CACHE_TTL = {
  factual: 24 * 60 * 60,    // 24h for fact-based queries
  tool: 60 * 60,             // 1h for tool results
  greeting: 5 * 60,          // 5min for greetings (to vary)
};

// Compute SOUL hash at module load (cached for process lifetime)
let soulHash: string | null = null;

function computeSoulHash(): string {
  if (soulHash !== null) {
    return soulHash;
  }

  const soulPath = join(process.cwd(), 'SOUL.md');

  if (existsSync(soulPath)) {
    try {
      const content = readFileSync(soulPath, 'utf8');
      soulHash = createHash('md5').update(content).digest('hex').slice(0, 8);
      logger.debug('Computed SOUL hash', { hash: soulHash });
    } catch (error) {
      logger.warn('Failed to read SOUL.md for hash', { error });
      soulHash = 'default';
    }
  } else {
    soulHash = 'default';
  }

  return soulHash;
}

/**
 * Generate system version hash (invalidates cache on prompt/model changes).
 * Includes: LLM model, SOUL.md content hash
 */
function getSystemVersion(): string {
  const components = [
    process.env.LLM_MODEL || 'kimi-k2.5',
    computeSoulHash(),
  ];
  return createHash('md5').update(components.join('|')).digest('hex').slice(0, 16);
}

function hashString(s: string): string {
  return createHash('md5').update(s).digest('hex');
}

function hashSortedArray(arr: string[]): string {
  return hashString([...arr].sort().join(','));
}

function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .sort()
    .join(' ');
}

/**
 * Cache lookup with four-part validation:
 * 1. Query similarity > threshold
 * 2. Same facts would be retrieved
 * 3. Same system version (prompt/model)
 * 4. Not expired
 */
export async function checkCache(
  query: string,
  retrievedFactIds: string[]
): Promise<string | null> {
  if (!isEmbeddingsReady()) {
    return null;
  }

  try {
    const db = getDatabase();
    const config = getEmbeddingsConfig();
    const queryEmbed = await embedText(query);
    const factIdsHash = hashSortedArray(retrievedFactIds);
    const systemVersion = getSystemVersion();

    // Find candidates with matching fact hash AND system version
    const candidates = db.prepare(`
      SELECT query_hash, query_embedding, response FROM response_cache
      WHERE fact_ids_hash = ?
        AND system_version = ?
        AND datetime(created_at, '+' || ttl_seconds || ' seconds') > datetime('now')
    `).all(factIdsHash, systemVersion) as Array<{
      query_hash: string;
      query_embedding: Buffer;
      response: string;
    }>;

    // Check query similarity
    for (const candidate of candidates) {
      const candidateEmbed = deserializeEmbedding(candidate.query_embedding);
      const similarity = cosineSimilarity(queryEmbed, candidateEmbed);

      if (similarity > config.cacheSimilarityThreshold) {
        logger.debug('Cache hit', { similarity, query: query.slice(0, 50) });
        return candidate.response;
      }

      // Log near-misses for threshold tuning
      if (similarity > 0.80) {
        logger.debug('Cache near-miss', {
          similarity,
          threshold: config.cacheSimilarityThreshold,
          query: query.slice(0, 50),
        });
      }
    }

    return null;
  } catch (error) {
    logger.warn('Cache lookup failed', { error });
    return null;
  }
}

export async function saveToCache(
  query: string,
  retrievedFactIds: string[],
  response: string,
  ttlSeconds: number = CACHE_TTL.factual
): Promise<void> {
  if (!isEmbeddingsReady()) {
    return;
  }

  try {
    const db = getDatabase();
    const queryEmbed = await embedText(query);
    const queryHash = hashString(normalizeQuery(query));
    const factIdsHash = hashSortedArray(retrievedFactIds);
    const systemVersion = getSystemVersion();

    db.prepare(`
      INSERT INTO response_cache
        (query_hash, query_embedding, fact_ids_hash, system_version, response, ttl_seconds)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      queryHash,
      serializeEmbedding(queryEmbed),
      factIdsHash,
      systemVersion,
      response,
      ttlSeconds
    );
  } catch (error) {
    logger.warn('Failed to save to cache', { error });
  }
}

export function cleanupExpiredCache(): number {
  const db = getDatabase();
  const result = db.prepare(`
    DELETE FROM response_cache
    WHERE datetime(created_at, '+' || ttl_seconds || ' seconds') < datetime('now')
  `).run();

  if (result.changes > 0) {
    logger.debug('Cleaned expired cache entries', { count: result.changes });
  }
  return result.changes;
}
```

**Schema:**

```sql
-- Response cache with version tracking
CREATE TABLE IF NOT EXISTS response_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_hash TEXT NOT NULL,
  query_embedding BLOB NOT NULL,
  fact_ids_hash TEXT NOT NULL,
  system_version TEXT NOT NULL,
  response TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_response_cache_lookup
  ON response_cache(fact_ids_hash, system_version);
CREATE INDEX IF NOT EXISTS idx_response_cache_created
  ON response_cache(created_at);
```

---

### Decision 5: Graceful Degradation with Circuit Breaker

**Problem:** System must work without embeddings, and shouldn't keep retrying if model is broken.

**Solution:** Global flag with automatic fallback, circuit breaker, and user-facing status.

```typescript
// src/memory/embeddings-state.ts
import { logger } from '../utils/logger';
import { getEmbeddingsConfig } from '../config/embeddings-config';

type DisabledReason =
  | 'ok'
  | 'disabled_by_config'
  | 'extension_missing'
  | 'model_missing'
  | 'load_error'
  | 'circuit_breaker';

interface EmbeddingsState {
  enabled: boolean;
  ready: boolean;                    // Model actually loaded and working
  reason: DisabledReason;
  lastCheck: number;
  consecutiveFailures: number;       // For circuit breaker
  circuitOpenUntil: number | null;   // Timestamp when to retry
}

let state: EmbeddingsState = {
  enabled: false,
  ready: false,
  reason: 'extension_missing',
  lastCheck: 0,
  consecutiveFailures: 0,
  circuitOpenUntil: null,
};

export function isEmbeddingsEnabled(): boolean {
  return state.enabled;
}

export function isEmbeddingsReady(): boolean {
  const config = getEmbeddingsConfig();

  // Check circuit breaker
  if (state.circuitOpenUntil && Date.now() < state.circuitOpenUntil) {
    return false;
  }

  // Reset circuit if cooldown passed
  if (state.circuitOpenUntil && Date.now() >= state.circuitOpenUntil) {
    logger.info('Circuit breaker reset, retrying embeddings');
    state.circuitOpenUntil = null;
    state.consecutiveFailures = 0;
  }

  return state.enabled && state.ready;
}

export function recordEmbeddingSuccess(): void {
  state.consecutiveFailures = 0;
}

export function recordEmbeddingFailure(): void {
  const config = getEmbeddingsConfig();
  state.consecutiveFailures++;

  if (state.consecutiveFailures >= config.circuitBreakerThreshold) {
    state.circuitOpenUntil = Date.now() + config.circuitBreakerResetMs;
    state.reason = 'circuit_breaker';
    logger.warn('Circuit breaker opened for embeddings', {
      failures: state.consecutiveFailures,
      resetAt: new Date(state.circuitOpenUntil).toISOString(),
    });
  }
}

export function getEmbeddingsState(): Readonly<EmbeddingsState> {
  return { ...state };
}

/**
 * Get user-facing status message for embeddings.
 */
export function getEmbeddingsStatusMessage(): string {
  if (!state.enabled) {
    switch (state.reason) {
      case 'disabled_by_config':
        return 'Semantic search disabled by configuration';
      case 'extension_missing':
        return 'Semantic search unavailable (sqlite-vec not found)';
      case 'model_missing':
        return 'Semantic search unavailable (model not found)';
      case 'load_error':
        return 'Semantic search unavailable (initialization error)';
      default:
        return 'Semantic search unavailable';
    }
  }

  if (!state.ready) {
    if (state.reason === 'circuit_breaker') {
      return 'Semantic search temporarily disabled (will retry shortly)';
    }
    return 'Semantic search initializing...';
  }

  return 'Semantic search active';
}

/**
 * Initialize embeddings capability (extension loading).
 * Does NOT load the model - that happens lazily on first use.
 */
export async function initializeEmbeddings(): Promise<boolean> {
  const config = getEmbeddingsConfig();

  // Check if disabled by config
  if (!config.enabled) {
    state = {
      ...state,
      enabled: false,
      ready: false,
      reason: 'disabled_by_config',
      lastCheck: Date.now()
    };
    logger.info('Embeddings disabled by configuration (EMBEDDINGS_ENABLED=false)');
    return false;
  }

  const db = getDatabase();

  // Step 1: Load sqlite-vec extension
  const result = loadSqliteVec(db);
  if (!result.success) {
    state = {
      ...state,
      enabled: false,
      ready: false,
      reason: 'extension_missing',
      lastCheck: Date.now()
    };
    logger.warn('Embeddings disabled: sqlite-vec not available', { error: result.error });
    return false;
  }

  // Step 2: Create vector index
  try {
    createVectorIndex(db);
  } catch (error) {
    state = {
      ...state,
      enabled: false,
      ready: false,
      reason: 'load_error',
      lastCheck: Date.now()
    };
    logger.error('Embeddings disabled: failed to create vector index', { error });
    return false;
  }

  // Mark as enabled but not ready (model loads lazily)
  state = {
    ...state,
    enabled: true,
    ready: false,
    reason: 'ok',
    lastCheck: Date.now()
  };
  logger.info('Embeddings enabled (model will load on first use)');
  return true;
}

/**
 * Called after model successfully loads.
 */
export function markEmbeddingsReady(): void {
  state.ready = true;
  logger.info('Embeddings ready');
}
```

**Usage in retrieval:**

```typescript
async function retrieveRelevantFacts(query: string): Promise<StoredFact[]> {
  if (isEmbeddingsReady()) {
    try {
      const results = await vectorSearchFacts(query);
      recordEmbeddingSuccess();
      return results;
    } catch (error) {
      recordEmbeddingFailure();
      logger.warn('Vector search failed, falling back to keyword', { error });
      // Fall through to keyword
    }
  }

  // Fallback: keyword matching (Fase 2)
  return filterFactsByKeywords(query);
}
```

---

### Decision 6: Lazy Model Loading with Retry Backoff

**Problem:** 5-second model load blocks startup, and network failures cause spam.

**Solution:** Load model on first embedding request with exponential backoff.

```typescript
// src/memory/embeddings-model.ts
import { pipeline, Pipeline } from '@xenova/transformers';
import { logger } from '../utils/logger';
import { getEmbeddingsConfig } from '../config/embeddings-config';
import { markEmbeddingsReady, recordEmbeddingFailure } from './embeddings-state';

let embeddingPipeline: Pipeline | null = null;
let loadingPromise: Promise<void> | null = null;
let loadAttempts = 0;
let nextRetryTime = 0;

const MAX_LOAD_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 5000;  // 5 seconds

/**
 * Lazily load the embedding model on first use.
 * Returns immediately if already loaded or loading.
 * Implements exponential backoff for repeated failures.
 */
async function ensureModelLoaded(): Promise<void> {
  if (embeddingPipeline) return;

  // Check if we're in backoff period
  if (nextRetryTime > Date.now()) {
    const waitMs = nextRetryTime - Date.now();
    throw new Error(`Model loading in backoff period (retry in ${Math.ceil(waitMs / 1000)}s)`);
  }

  // Check max attempts
  if (loadAttempts >= MAX_LOAD_ATTEMPTS) {
    throw new Error('Model loading failed after max attempts');
  }

  if (loadingPromise) {
    // Another call is already loading
    return loadingPromise;
  }

  const config = getEmbeddingsConfig();

  loadingPromise = (async () => {
    loadAttempts++;
    logger.info('Loading embedding model (first use)', {
      model: config.modelName,
      attempt: loadAttempts
    });
    const startTime = Date.now();

    try {
      embeddingPipeline = await pipeline('feature-extraction', config.modelName, {
        quantized: true,
        progress_callback: (progress: { status: string; progress?: number }) => {
          if (progress.progress !== undefined) {
            logger.debug('Model download progress', {
              percent: Math.round(progress.progress)
            });
          }
        },
      });

      const elapsed = Date.now() - startTime;
      logger.info('Embedding model loaded', { elapsed_ms: elapsed });
      markEmbeddingsReady();

      // Reset attempts on success
      loadAttempts = 0;
      nextRetryTime = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to load embedding model', {
        error: message,
        attempt: loadAttempts,
        maxAttempts: MAX_LOAD_ATTEMPTS
      });

      // Set backoff time
      const backoffMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, loadAttempts - 1);
      nextRetryTime = Date.now() + backoffMs;

      logger.warn('Will retry model loading', {
        retryIn: `${backoffMs / 1000}s`,
        nextAttempt: loadAttempts + 1
      });

      recordEmbeddingFailure();
      loadingPromise = null;  // Allow retry after backoff
      throw error;
    }
  })();

  return loadingPromise;
}

export async function embedText(text: string): Promise<Float32Array> {
  await ensureModelLoaded();

  if (!embeddingPipeline) {
    throw new Error('Embedding model not loaded');
  }

  const output = await embeddingPipeline(text, {
    pooling: 'mean',
    normalize: true,
  });

  return new Float32Array(output.data);
}

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  await ensureModelLoaded();
  return Promise.all(texts.map(t => embedText(t)));
}

export function getEmbeddingDimension(): number {
  return getEmbeddingsConfig().embeddingDimension;
}

export function isEmbeddingsReady(): boolean {
  return embeddingPipeline !== null;
}
```

---

### Decision 7: Weighted Hybrid Search

**Problem:** Simple concatenation (vector first, then keyword) ignores relevance scores.

**Solution:** Weighted merge that combines both signals.

```typescript
// src/memory/vector-search.ts
import { embedText, isEmbeddingsReady } from './embeddings-model';
import { serializeEmbedding } from './vector-math';
import { recordEmbeddingSuccess, recordEmbeddingFailure } from './embeddings-state';
import { getDatabase } from './store';
import { logger } from '../utils/logger';

const TOP_K = 5;
const MIN_SIMILARITY = 0.4;

// Weights for hybrid scoring
const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;

interface ScoredFact {
  fact: StoredFact;
  vectorScore: number;    // 0-1, from cosine similarity
  keywordScore: number;   // 0-1, from keyword match ratio
  combinedScore: number;
}

/**
 * Search for facts similar to query using vector similarity.
 * Returns top-K facts with similarity above threshold.
 */
export async function vectorSearchFacts(query: string): Promise<ScoredFact[]> {
  if (!isEmbeddingsReady()) {
    return [];
  }

  const db = getDatabase();
  const queryEmbed = await embedText(query);

  const results = db.prepare(`
    SELECT
      fact_id,
      vec_distance_cosine(embedding, ?) as distance
    FROM fact_vectors
    ORDER BY distance ASC
    LIMIT ?
  `).all(serializeEmbedding(queryEmbed), TOP_K * 2) as Array<{ fact_id: string; distance: number }>;

  // Convert distance to similarity and filter
  const filtered = results
    .map(r => ({ factId: r.fact_id, similarity: 1 - r.distance }))
    .filter(r => r.similarity >= MIN_SIMILARITY)
    .slice(0, TOP_K);

  if (filtered.length === 0) {
    return [];
  }

  // Fetch full fact objects
  const factIds = filtered.map(r => r.factId);
  const facts = getFactsByIds(factIds);
  const factMap = new Map(facts.map(f => [f.id, f]));

  return filtered
    .map(r => {
      const fact = factMap.get(r.factId);
      if (!fact) return null;
      return {
        fact,
        vectorScore: r.similarity,
        keywordScore: 0,  // Will be filled by hybrid search
        combinedScore: r.similarity,
      };
    })
    .filter((f): f is ScoredFact => f !== null);
}

/**
 * Keyword search with scoring.
 */
export function keywordSearchFacts(query: string, limit: number = 10): ScoredFact[] {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const facts = filterFactsByKeywords(query, limit * 2);

  return facts.map(fact => {
    const matchCount = keywords.filter(kw =>
      fact.fact.toLowerCase().includes(kw.toLowerCase())
    ).length;
    const keywordScore = matchCount / keywords.length;

    return {
      fact,
      vectorScore: 0,
      keywordScore,
      combinedScore: keywordScore,
    };
  });
}

/**
 * Hybrid search: weighted combination of vector + keyword scores.
 */
export async function hybridSearchFacts(query: string): Promise<StoredFact[]> {
  const [vectorResults, keywordResults] = await Promise.all([
    vectorSearchFacts(query).catch((error) => {
      logger.warn('Vector search failed in hybrid', { error });
      recordEmbeddingFailure();
      return [];
    }),
    Promise.resolve(keywordSearchFacts(query, 10)),
  ]);

  // Record success if vector search worked
  if (vectorResults.length > 0) {
    recordEmbeddingSuccess();
  }

  // Create map of all facts with their scores
  const scoreMap = new Map<string, ScoredFact>();

  // Add vector results
  for (const result of vectorResults) {
    scoreMap.set(result.fact.id, result);
  }

  // Merge keyword results
  for (const result of keywordResults) {
    const existing = scoreMap.get(result.fact.id);
    if (existing) {
      // Combine scores
      existing.keywordScore = result.keywordScore;
      existing.combinedScore =
        (VECTOR_WEIGHT * existing.vectorScore) +
        (KEYWORD_WEIGHT * result.keywordScore);
    } else {
      // Keyword-only result
      result.combinedScore = KEYWORD_WEIGHT * result.keywordScore;
      scoreMap.set(result.fact.id, result);
    }
  }

  // Sort by combined score and return top results
  const sorted = Array.from(scoreMap.values())
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, 10);

  logger.debug('Hybrid search results', {
    vectorCount: vectorResults.length,
    keywordCount: keywordResults.length,
    mergedCount: sorted.length,
    topScore: sorted[0]?.combinedScore,
  });

  return sorted.map(s => s.fact);
}
```

---

## Implementation Tasks

### Task 1: Vector Math Utilities

**New file:** `src/memory/vector-math.ts`

**Purpose:** Reusable vector operations for embeddings.

```typescript
// src/memory/vector-math.ts

/**
 * Cosine similarity between two vectors.
 * Assumes vectors are already normalized (which transformers.js does).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }

  return dotProduct;  // Already normalized, so this is cosine similarity
}

/**
 * Calculate centroid (mean) of multiple vectors.
 */
export function calculateCentroid(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) {
    throw new Error('Cannot calculate centroid of empty array');
  }

  const dim = vectors[0].length;
  const centroid = new Float32Array(dim);

  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += vec[i];
    }
  }

  for (let i = 0; i < dim; i++) {
    centroid[i] /= vectors.length;
  }

  // Normalize the centroid
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += centroid[i] * centroid[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      centroid[i] /= norm;
    }
  }

  return centroid;
}

/**
 * Serialize Float32Array to Buffer for SQLite storage.
 */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Deserialize Buffer from SQLite to Float32Array.
 * Handles potential alignment issues by copying to aligned buffer.
 */
export function deserializeEmbedding(buffer: Buffer): Float32Array {
  // Create aligned ArrayBuffer to avoid alignment issues
  // Some environments require Float32Array to be 4-byte aligned
  const aligned = new ArrayBuffer(buffer.length);
  new Uint8Array(aligned).set(buffer);
  return new Float32Array(aligned);
}
```

---

### Task 2: Embedding Worker with Proper Concurrency

**New file:** `src/memory/embedding-worker.ts`

**Purpose:** Background worker to embed facts with mutex and monitoring.

```typescript
// src/memory/embedding-worker.ts
import { embedText, isEmbeddingsReady } from './embeddings-model';
import { isEmbeddingsEnabled, recordEmbeddingSuccess, recordEmbeddingFailure } from './embeddings-state';
import { serializeEmbedding } from './vector-math';
import { getDatabase } from './store';
import { getEmbeddingsConfig } from '../config/embeddings-config';
import { logger } from '../utils/logger';

const WORKER_INTERVAL_MS = 10_000;  // 10 seconds
const BATCH_SIZE = 10;
const MAX_QUEUE_DEPTH = 1000;       // Alert threshold
const CURRENT_MODEL_VERSION = 'all-MiniLM-L6-v2';

let workerTimer: ReturnType<typeof setInterval> | null = null;
let processingLock = false;         // Mutex for queue processing
// Note: processingLock works because Node.js is single-threaded.
// If migrating to worker_threads, replace with proper mutex.

interface PendingEmbedding {
  id: number;
  fact_id: string;
  attempts: number;
}

export async function startEmbeddingWorker(): Promise<void> {
  if (workerTimer) return;
  if (!isEmbeddingsEnabled()) {
    logger.info('Embedding worker not started (embeddings disabled)');
    return;
  }

  // Recover stalled items from previous runs
  recoverStalledEmbeddings();

  // Cleanup old failed items
  cleanupFailedEmbeddings();

  // Queue facts without embeddings
  await queueMissingEmbeddings();

  // Check queue depth
  const queueDepth = getPendingEmbeddingCount();
  if (queueDepth > MAX_QUEUE_DEPTH) {
    logger.warn('Embedding queue depth exceeds threshold', {
      depth: queueDepth,
      threshold: MAX_QUEUE_DEPTH
    });
  }

  logger.info('Starting embedding worker', { pendingCount: queueDepth });
  workerTimer = setInterval(processEmbeddingQueue, WORKER_INTERVAL_MS);

  // Run immediately if queue has items
  if (queueDepth > 0) {
    processEmbeddingQueue();
  }
}

export function stopEmbeddingWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    logger.info('Embedding worker stopped');
  }
}

async function processEmbeddingQueue(): Promise<void> {
  // Mutex check - skip if already processing
  if (processingLock) {
    logger.debug('Embedding worker already processing, skipping tick');
    return;
  }

  // Model not ready yet - wait for first user query to trigger load
  if (!isEmbeddingsReady()) {
    return;
  }

  processingLock = true;

  try {
    const items = getPendingEmbeddings(BATCH_SIZE);
    if (items.length === 0) return;

    logger.debug('Processing embedding queue', { count: items.length });

    for (const item of items) {
      await processEmbeddingItem(item);
    }

    // Log queue status periodically
    const remaining = getPendingEmbeddingCount();
    if (remaining > 0) {
      logger.debug('Embedding queue status', { remaining });
    }
  } catch (error) {
    logger.error('Embedding worker error', { error });
  } finally {
    processingLock = false;
  }
}

async function processEmbeddingItem(item: PendingEmbedding): Promise<void> {
  const db = getDatabase();
  markEmbeddingProcessing(db, item.id);

  try {
    const fact = getFactById(item.fact_id);
    if (!fact) {
      // Fact was deleted, mark as complete
      markEmbeddingCompleted(db, item.id);
      return;
    }

    const embedding = await embedText(fact.fact);
    saveFactEmbedding(db, item.fact_id, embedding, CURRENT_MODEL_VERSION);
    markEmbeddingCompleted(db, item.id);
    recordEmbeddingSuccess();

    logger.debug('Embedded fact', { factId: item.fact_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    markEmbeddingFailed(db, item.id, message);
    recordEmbeddingFailure();
    logger.warn('Embedding failed', { factId: item.fact_id, error: message });
  }
}

// Database operations

function getPendingEmbeddings(limit: number): PendingEmbedding[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, fact_id, attempts
    FROM pending_embedding
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit) as PendingEmbedding[];
}

function getPendingEmbeddingCount(): number {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM pending_embedding WHERE status = 'pending'
  `).get() as { count: number };
  return row.count;
}

function markEmbeddingProcessing(db: Database.Database, id: number): void {
  db.prepare(`
    UPDATE pending_embedding
    SET status = 'processing', last_attempt_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

function markEmbeddingCompleted(db: Database.Database, id: number): void {
  db.prepare(`DELETE FROM pending_embedding WHERE id = ?`).run(id);
}

function markEmbeddingFailed(db: Database.Database, id: number, error: string): void {
  db.prepare(`
    UPDATE pending_embedding
    SET status = CASE WHEN attempts >= 2 THEN 'failed' ELSE 'pending' END,
        attempts = attempts + 1,
        error = ?
    WHERE id = ?
  `).run(error, id);
}

export function queueFactForEmbedding(factId: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO pending_embedding (fact_id)
    VALUES (?)
  `).run(factId);
}

function saveFactEmbedding(
  db: Database.Database,
  factId: string,
  embedding: Float32Array,
  modelVersion: string
): void {
  const blob = serializeEmbedding(embedding);

  // Save to embeddings table
  db.prepare(`
    INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding, model_version)
    VALUES (?, ?, ?)
  `).run(factId, blob, modelVersion);

  // Update vector index
  db.prepare(`
    INSERT OR REPLACE INTO fact_vectors (fact_id, embedding)
    VALUES (?, ?)
  `).run(factId, blob);
}

async function queueMissingEmbeddings(): Promise<void> {
  const db = getDatabase();
  const missing = db.prepare(`
    SELECT f.id FROM facts f
    LEFT JOIN fact_embeddings e ON f.id = e.fact_id
    LEFT JOIN pending_embedding p ON f.id = p.fact_id
    WHERE f.stale = 0 AND f.archived = 0
      AND e.fact_id IS NULL
      AND p.fact_id IS NULL
  `).all() as Array<{ id: string }>;

  if (missing.length > 0) {
    logger.info('Queueing missing embeddings', { count: missing.length });
    for (const { id } of missing) {
      queueFactForEmbedding(id);
    }
  }
}
```

---

### Task 3: Schema Updates

**Modify:** `src/memory/store.ts`

Add new migration for Fase 3 tables:

```typescript
// Add to migrations array in store.ts

const FASE_3_MIGRATION = `
-- Fase 3: Semantic Intelligence Tables

-- Fact embeddings with vector data
CREATE TABLE IF NOT EXISTS fact_embeddings (
  fact_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model_version TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
);

-- Pending embedding queue
CREATE TABLE IF NOT EXISTS pending_embedding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id TEXT NOT NULL UNIQUE,
  attempts INTEGER DEFAULT 0,
  last_attempt_at TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_embedding_status ON pending_embedding(status);

-- Response cache with version tracking
CREATE TABLE IF NOT EXISTS response_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_hash TEXT NOT NULL,
  query_embedding BLOB NOT NULL,
  fact_ids_hash TEXT NOT NULL,
  system_version TEXT NOT NULL,
  response TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_response_cache_lookup
  ON response_cache(fact_ids_hash, system_version);
CREATE INDEX IF NOT EXISTS idx_response_cache_created
  ON response_cache(created_at);
`;
```

**Note:** The `fact_vectors` virtual table is created dynamically in `embeddings-loader.ts` after the extension is successfully loaded.

---

## Database Migration

### Migration Strategy

Fase 3 is additive - it only creates new tables and doesn't modify existing Fase 2 tables. However, proper migration handling is required.

**Migration file:** `src/memory/migrations/003-semantic-intelligence.ts`

```typescript
// src/memory/migrations/003-semantic-intelligence.ts
import Database from 'better-sqlite3';
import { logger } from '../../utils/logger';

const MIGRATION_VERSION = 3;
const MIGRATION_NAME = 'semantic-intelligence';

export function migrate(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db);

  if (currentVersion >= MIGRATION_VERSION) {
    logger.debug('Migration already applied', { migration: MIGRATION_NAME });
    return;
  }

  logger.info('Applying migration', {
    migration: MIGRATION_NAME,
    fromVersion: currentVersion,
    toVersion: MIGRATION_VERSION
  });

  db.transaction(() => {
    // Create fact_embeddings table
    db.exec(`
      CREATE TABLE IF NOT EXISTS fact_embeddings (
        fact_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        model_version TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
      );
    `);

    // Create pending_embedding queue
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_embedding (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_id TEXT NOT NULL UNIQUE,
        attempts INTEGER DEFAULT 0,
        last_attempt_at TEXT,
        status TEXT DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
        error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pending_embedding_status
        ON pending_embedding(status);
    `);

    // Create response_cache table
    db.exec(`
      CREATE TABLE IF NOT EXISTS response_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_hash TEXT NOT NULL,
        query_embedding BLOB NOT NULL,
        fact_ids_hash TEXT NOT NULL,
        system_version TEXT NOT NULL,
        response TEXT NOT NULL,
        ttl_seconds INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_response_cache_lookup
        ON response_cache(fact_ids_hash, system_version);
      CREATE INDEX IF NOT EXISTS idx_response_cache_created
        ON response_cache(created_at);
    `);

    // Update schema version
    setSchemaVersion(db, MIGRATION_VERSION);
  })();

  logger.info('Migration complete', { migration: MIGRATION_NAME });
}

function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    return row?.version || 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
    DELETE FROM schema_version;
    INSERT INTO schema_version (version) VALUES (${version});
  `);
}
```

### Handling Existing Databases

The migration system checks schema version before applying changes. For Fase 2 databases:

1. Migration detects `version < 3`
2. Creates new tables (fact_embeddings, pending_embedding, response_cache)
3. Updates schema version to 3
4. **Does not** create fact_vectors (happens dynamically if sqlite-vec loads)

If sqlite-vec is not available, the new tables exist but remain empty, and the system falls back to Fase 2 keyword matching.

---

### Task 4: Integration Points

**Modify: `src/index.ts`**

```typescript
import { initializeEmbeddings, getEmbeddingsStatusMessage } from './memory/embeddings-state';
import { startEmbeddingWorker, stopEmbeddingWorker } from './memory/embedding-worker';

async function main(): Promise<void> {
  // ... existing startup code ...

  // Fase 3: Initialize embeddings capability (non-blocking)
  // Model loads lazily on first query, so this is fast
  const embeddingsEnabled = await initializeEmbeddings();
  logger.info(getEmbeddingsStatusMessage());

  // Start background worker (will wait for model to be ready)
  if (embeddingsEnabled) {
    startEmbeddingWorker();
  }

  // ... rest of startup ...
}

// Graceful shutdown
function shutdown(): void {
  stopEmbeddingWorker();
  // ... other cleanup ...
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

**Modify: `src/memory/knowledge.ts`**

```typescript
import { hybridSearchFacts } from './vector-search';
import { isEmbeddingsReady } from './embeddings-state';

export async function formatFactsForPrompt(userQuery?: string): Promise<string> {
  let relevantFacts: StoredFact[];

  if (userQuery && isEmbeddingsReady()) {
    // Use hybrid search (vector + keyword)
    relevantFacts = await hybridSearchFacts(userQuery);
  } else if (userQuery) {
    // Fallback to keyword only (Fase 2)
    relevantFacts = filterFactsByKeywords(userQuery, 20);
  } else {
    // No query, get recent facts
    relevantFacts = getFacts({ limit: 20 });
  }

  // ... rest of formatting ...
}
```

**Modify: `src/agent/context-guard.ts`**

```typescript
import { calculateSemanticContinuity } from '../memory/semantic-continuity';

async function truncateMessages(
  messages: Message[],
  currentMessage: string,
  maxTokens: number
): Promise<ContextGuardResult> {
  // Calculate adaptive window size
  const continuity = await calculateSemanticContinuity(currentMessage, messages);

  logger.debug('Adaptive window', {
    continuity: continuity.score.toFixed(2),
    windowSize: continuity.windowSize,
    reason: continuity.reason,
  });

  // Use window size for truncation calculation
  const effectiveWindowSize = continuity.windowSize;

  // ... rest of truncation logic using effectiveWindowSize ...
}
```

**Modify: `src/agent/brain.ts`**

```typescript
import { checkCache, saveToCache, CACHE_TTL } from '../memory/response-cache';

async think(optionsOrInput: string | ThinkOptions): Promise<string> {
  // ... existing code to build context ...

  // Get retrieved fact IDs for cache key
  const retrievedFactIds = relevantFacts.map(f => f.id);

  // Check cache before LLM call
  const cachedResponse = await checkCache(userInput, retrievedFactIds);
  if (cachedResponse) {
    logger.debug('Response cache hit');
    saveMessage({ role: 'assistant', content: cachedResponse });
    return cachedResponse;
  }

  // ... LLM call ...

  // Save to cache after successful response (fire and forget)
  const ttl = this.classifyQueryType(userInput);
  saveToCache(userInput, retrievedFactIds, response, ttl).catch(err => {
    logger.warn('Failed to save to cache', { error: err.message });
  });

  return response;
}

private classifyQueryType(query: string): number {
  const greetings = /^(hi|hello|hey|good\s+(morning|afternoon|evening))/i;
  if (greetings.test(query.trim())) {
    return CACHE_TTL.greeting;
  }
  return CACHE_TTL.factual;
}
```

**Modify: `src/memory/facts-store.ts`**

```typescript
import { queueFactForEmbedding } from './embedding-worker';
import { isEmbeddingsEnabled } from './embeddings-state';

export function saveFact(newFact: NewFact): string {
  // ... existing save logic ...

  // Queue for embedding (async, best-effort)
  if (isEmbeddingsEnabled()) {
    queueFactForEmbedding(id);
  }

  return id;
}
```

---

## File Changes Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/config/embeddings-config.ts` | **Create** | Configuration management |
| `src/memory/vector-math.ts` | **Create** | Vector operations (cosine, centroid, serialize) |
| `src/memory/embeddings-loader.ts` | **Create** | Load sqlite-vec (system + bundled) |
| `src/memory/embeddings-model.ts` | **Create** | transformers.js with lazy loading + backoff |
| `src/memory/embeddings-state.ts` | **Create** | Global state + circuit breaker + status messages |
| `src/memory/vector-search.ts` | **Create** | Weighted hybrid search |
| `src/memory/embedding-worker.ts` | **Create** | Background queue with mutex |
| `src/memory/semantic-continuity.ts` | **Create** | Adaptive window calculation |
| `src/memory/response-cache.ts` | **Create** | Query deduplication with SOUL hash |
| `src/memory/migrations/003-semantic-intelligence.ts` | **Create** | Database migration |
| `src/memory/store.ts` | Modify | Run migrations |
| `src/memory/knowledge.ts` | Modify | Use hybrid search |
| `src/memory/facts-store.ts` | Modify | Queue embedding on save |
| `src/agent/brain.ts` | Modify | Cache check + save |
| `src/agent/context-guard.ts` | Modify | Adaptive window |
| `src/index.ts` | Modify | Startup/shutdown hooks |
| `vendor/sqlite-vec/*` | **Create** | Prebuilt binaries |

**New files:** 11 + binaries
**Modified files:** 5

---

## Prerequisites

```bash
# Install transformers.js
npm install @xenova/transformers

# Download sqlite-vec binaries (manual step)
# See: https://github.com/asg017/sqlite-vec/releases

# Create vendor directory structure
mkdir -p vendor/sqlite-vec/{darwin-arm64,darwin-x64,linux-x64}

# Download appropriate version for each platform
# darwin-arm64: vec0.dylib
# darwin-x64: vec0.dylib
# linux-x64: vec0.so

# Alternative: install system-wide via Homebrew (macOS)
brew install asg017/sqlite-vec/sqlite-vec
```

### First-Run Behavior

On first run, transformers.js downloads the model to `~/.cache/huggingface/`:
- **Size:** ~80MB for `all-MiniLM-L6-v2`
- **Location:** `~/.cache/huggingface/hub/models--Xenova--all-MiniLM-L6-v2`
- **Offline:** Will fail if no network and model not cached

Add to documentation:
```
Note: First query may take 10-30 seconds while downloading the embedding model.
Subsequent startups use the cached model (~5 seconds to load).
```

---

## Verification Plan

### 1. Configuration Toggle

```bash
# Test disabled mode
EMBEDDINGS_ENABLED=false npm run dev
# Check logs for: "Embeddings disabled by configuration"

# Test enabled mode (default)
npm run dev
# Check logs for: "Embeddings enabled (model will load on first use)"
```

### 2. sqlite-vec Loading

```bash
npm run dev
# Check logs for one of:
# - "sqlite-vec loaded from system"
# - "sqlite-vec loaded from bundle"
# - "Embeddings disabled: sqlite-vec not available" (graceful fallback)
```

### 3. Lazy Model Loading with Backoff

```bash
# First message in conversation triggers model load
# Check logs for:
# - "Loading embedding model (first use)"
# - "Model download progress" (if first run)
# - "Embedding model loaded" with elapsed_ms

# If network fails, check for:
# - "Failed to load embedding model"
# - "Will retry model loading" with backoff time
```

### 4. Vector Search

```sql
-- After saving facts with embeddings
SELECT fact_id, vec_distance_cosine(embedding, ?) as distance
FROM fact_vectors
ORDER BY distance ASC
LIMIT 5;
```

Expected: Returns relevant facts sorted by similarity

### 5. Hybrid Search Scoring

```bash
# Save facts about different topics
/remember I work at Acme Corp as a software engineer
/remember My deployment process uses Kubernetes

# Query that should match both vector and keyword
"Tell me about my k8s deployments"

# Check logs for:
# - "Hybrid search results" with vectorCount, keywordCount, mergedCount
```

### 6. Semantic Continuity

1. Start fresh session
2. First 2 messages: expect `windowSize: 6, reason: 'bootstrap'`
3. Messages 3+: expect calculated continuity score and dynamic window

### 7. Cache Hit/Miss with Near-Miss Logging

```bash
# First query
"What do you know about my work?"

# Similar query (should hit cache)
"Tell me about my job"

# Check logs for:
# - "Cache hit" with similarity score, OR
# - "Cache near-miss" if similarity between 0.80-0.90
```

### 8. SOUL.md Cache Invalidation

```bash
# Query something
"What's my name?"

# Modify SOUL.md
echo "# Updated" >> SOUL.md

# Restart app
npm run dev

# Same query should NOT hit cache (system_version changed)
```

### 9. Graceful Degradation

```bash
# Remove sqlite-vec binary
mv vendor/sqlite-vec/darwin-arm64/vec0.dylib /tmp/

# Restart app
npm run dev

# Verify:
# - "Embeddings disabled: sqlite-vec not available"
# - Keyword search still works
```

### 10. Circuit Breaker

```bash
# Force embedding failures (e.g., corrupt model cache)
# After 5 failures, check logs for:
# - "Circuit breaker opened for embeddings"

# After 1 minute, check logs for:
# - "Circuit breaker reset, retrying embeddings"
```

### 11. Stall Recovery

```bash
# Kill process mid-embedding
kill -9 <pid>

# Restart
npm run dev

# Check logs for:
# - "Recovered stalled embeddings"
```

### 12. Embedding Worker

```bash
# Create new fact
/remember My favorite color is blue

# Check pending_embedding table
sqlite3 data/sidecar.db "SELECT * FROM pending_embedding"

# Wait 10 seconds, check fact_embeddings
sqlite3 data/sidecar.db "SELECT fact_id FROM fact_embeddings"
```

### 13. Migration Test

```bash
# Backup existing database
cp data/sidecar.db data/sidecar.db.backup

# Run with new code
npm run dev

# Verify new tables exist
sqlite3 data/sidecar.db ".tables"
# Should show: fact_embeddings, pending_embedding, response_cache

# Verify schema version
sqlite3 data/sidecar.db "SELECT version FROM schema_version"
# Should show: 3
```

---

## Success Criteria

- [ ] `EMBEDDINGS_ENABLED=false` disables all embedding functionality
- [ ] Embeddings load on M1/M2 Mac and Linux x64
- [ ] System path detection works (Homebrew on macOS)
- [ ] Lazy model loading doesn't block startup
- [ ] Model loading retries with exponential backoff
- [ ] Graceful degradation to Fase 2 when unavailable
- [ ] Circuit breaker prevents infinite retry loops
- [ ] "deployment process" finds "k8s deploy" fact (semantic match)
- [ ] Hybrid search combines vector and keyword scores
- [ ] Cache prevents duplicate LLM calls for similar queries
- [ ] Cache invalidates on SOUL.md changes
- [ ] Cache invalidates on LLM model changes
- [ ] Adaptive window adjusts based on topic continuity
- [ ] Facts are embedded within 10 seconds of creation
- [ ] Stalled embeddings recover on restart
- [ ] Failed embeddings are cleaned up after 7 days
- [ ] Re-embedding triggers on model version change
- [ ] Database migration works from Fase 2 databases

---

## Risk Mitigation Summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| sqlite-vec incompatible | HIGH | System path detection + bundled fallback + graceful degradation |
| Model download fails | MEDIUM | Progress logging, lazy load, exponential backoff (3 attempts) |
| Model load slow | MEDIUM | Lazy loading (not at startup) |
| Buffer alignment issues | MEDIUM | Copy to aligned ArrayBuffer in deserializeEmbedding |
| Vector search slow | LOW | Limit to 384-dim, index, top-K limit |
| Cache stale | MEDIUM | Fact hash + system version (including SOUL hash) in key, TTL |
| Cache threshold too strict | LOW | Configurable via env var, near-miss logging for tuning |
| Embedding worker blocked | LOW | Mutex, separate queue, circuit breaker |
| Worker race conditions | LOW | Single-threaded assumption documented |
| Stalled items never recover | MEDIUM | recoverStalledEmbeddings() on startup |
| Queue backlog explosion | LOW | MAX_QUEUE_DEPTH monitoring, logging |
| Failed items accumulate | LOW | cleanupFailedEmbeddings() after 7 days |

---

## Performance Targets

| Operation | Target | Notes |
|-----------|--------|-------|
| Embed query | < 50ms | After model warm |
| Vector search (1k facts) | < 10ms | sqlite-vec is fast |
| Cache lookup | < 5ms | Index on fact_ids_hash |
| Model load (cold, first run) | < 30s | Includes download |
| Model load (cold, cached) | < 5s | Model files exist |
| Model load (warm) | 0ms | Already loaded |
| Startup impact | < 100ms | Lazy loading |

---

## Rollback Plan

1. Set `EMBEDDINGS_ENABLED=false` in `.env` (immediate, no restart needed for new sessions)
2. Or simply: embeddings degrade gracefully if extension missing
3. All changes are additive and gated by `isEmbeddingsEnabled()` / `isEmbeddingsReady()`
4. Keep tables (no data loss)
5. Revert to Fase 2 behavior (keyword only)

All features are behind capability checks. The system works identically to Fase 2 if embeddings fail to initialize.

---

## Implementation Order

1. **Task 1:** `embeddings-config.ts` - Configuration first
2. **Task 2:** `vector-math.ts` - No dependencies, pure functions
3. **Task 3:** Migration in `store.ts` - Tables needed by other modules
4. **Task 4:** `embeddings-loader.ts` - Extension loading
5. **Task 5:** `embeddings-state.ts` - State management + circuit breaker
6. **Task 6:** `embeddings-model.ts` - Lazy model loading with backoff
7. **Task 7:** `embedding-worker.ts` - Background processing
8. **Task 8:** `vector-search.ts` - Hybrid search
9. **Task 9:** `semantic-continuity.ts` - Adaptive window
10. **Task 10:** `response-cache.ts` - Query caching with SOUL hash
11. **Task 11:** Integration points (brain.ts, context-guard.ts, etc.)
12. **Task 12:** Verification tests

Each task produces working code. System remains functional after each step due to graceful degradation.

---

## Post-Implementation Hardening

After initial implementation, a code review identified several issues that were addressed to improve robustness and prevent edge case failures.

### Issues Identified and Fixed

#### Critical Fixes (Applied)

| Issue | Problem | Solution | File |
|-------|---------|----------|------|
| **Unbounded Queue Growth** | If embedding model never loads, `pending_embedding` queue grows indefinitely | Added `enforceEmbeddingQueueLimit()` with hard cap at 1000 items, called on worker startup | `embedding-worker.ts` |
| **No Schema Versioning** | No way to track which migration version a database is at | Added `schema_version` table with `runMigrations()` runner for future-proof migrations | `store.ts` |

#### Medium Fixes (Applied)

| Issue | Problem | Solution | File |
|-------|---------|----------|------|
| **Vector Index Drift** | If `upsertFactVector()` fails, embeddings exist in `fact_embeddings` but not in `fact_vectors` | Added `reconcileVectorIndex()` that re-indexes orphaned embeddings on startup | `embedding-worker.ts` |
| **Cache Never Cleaned** | `cleanupExpiredCache()` existed but was never scheduled | Added hourly cleanup call in `processEmbeddingQueue()` tick | `embedding-worker.ts` |
| **SOUL.md Hot Reload** | Hash cached at module load, changes during session not detected | Modified `computeSoulHash()` to check file mtime on each lookup | `response-cache.ts` |

#### Low Priority (Deferred)

| Issue | Status | Notes |
|-------|--------|-------|
| **Batch Embedding API** | Deferred | `embedTexts()` loops over `embedText()`. Batch API would improve performance but requires transformers.js testing. |
| **Pipeline Disposal** | Deferred | Embedding pipeline never disposed. Add `disposePipeline()` for memory cleanup on shutdown. |
| **brain.ts Cache Integration** | Not Implemented | `checkCache()` and `saveToCache()` exist but are not wired into `think()`. Response cache is available but unused. |

### Code Changes Summary

**embedding-worker.ts:**
```typescript
// New constant
const MAX_PENDING_EMBEDDINGS = 1000;
const CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// New tracking variable
let lastCacheCleanup = 0;

// New function: enforceEmbeddingQueueLimit()
// Caps queue at 1000 items by deleting oldest pending entries

// New function: reconcileVectorIndex()
// Re-indexes any fact_embeddings missing from fact_vectors

// Modified: processEmbeddingQueue()
// Added hourly cleanupExpiredCache() + cleanupFailedEmbeddings() calls

// Modified: startEmbeddingWorker()
// Calls reconcileVectorIndex() and enforceEmbeddingQueueLimit() on startup
```

**store.ts:**
```typescript
// New constant
const CURRENT_SCHEMA_VERSION = 3;

// New table in SCHEMA
CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

// New functions
function getSchemaVersion(database): number
function setSchemaVersion(database, version): void
function runMigrations(database): void

// Modified: getDatabase()
// Calls runMigrations() after runFase2Migrations()
```

**response-cache.ts:**
```typescript
// New tracking variable
let soulMtime: number = 0;

// Modified: computeSoulHash()
// Now checks file mtime and recomputes hash if file changed
// Uses statSync() to detect modifications during session
```

### Testing the Fixes

```bash
# 1. Queue Limit Test
# Create 2000 facts with embeddings disabled, then re-enable
# Verify queue capped at 1000 in logs

# 2. Schema Version Test
sqlite3 data/sidecar.db "SELECT * FROM schema_version"
# Expected: id=1, version=3

# 3. Vector Index Reconciliation Test
# Manually delete rows from fact_vectors
sqlite3 data/sidecar.db "DELETE FROM fact_vectors WHERE rowid % 2 = 0"
# Restart app and check logs for "Reconciling vector index"

# 4. Cache Cleanup Test
# Insert expired cache entry
sqlite3 data/sidecar.db "INSERT INTO response_cache
  (query_hash, query_embedding, fact_ids_hash, system_version, response, ttl_seconds, created_at)
  VALUES ('test', x'00', 'test', 'test', 'test', 1, datetime('now', '-1 hour'))"
# Wait for worker tick or force cleanup
# Verify entry deleted

# 5. SOUL.md Hot Reload Test
# Query something (triggers cache save with current SOUL hash)
# Modify SOUL.md: echo "# Modified" >> SOUL.md
# Same query should miss cache (different system_version)
```

### Remaining Work for Future Phases

1. **Wire brain.ts cache integration** - The response cache infrastructure is complete but the `think()` method doesn't call `checkCache()` or `saveToCache()`. This requires:
   - Importing cache functions in brain.ts
   - Adding cache check before LLM call
   - Adding cache save after successful response
   - Adding TTL classification based on query type

2. **Add batch embedding** - Replace `embedTexts()` loop with native batch API for better performance on large fact sets.

3. **Add pipeline disposal** - Call `disposePipeline()` in shutdown handler to free memory.

---

## Commit History

| Date | Commit | Description |
|------|--------|-------------|
| 2026-02-01 | `[Fase 3] Add semantic intelligence implementation plan` | Initial plan document |
| 2026-02-01 | `[Fase 3] Implement semantic intelligence: embeddings, vector search, caching` | Full implementation |
| 2026-02-01 | `[Fase 3] Fix critical bugs: queue limits, schema versioning, cache cleanup` | Post-review hardening |

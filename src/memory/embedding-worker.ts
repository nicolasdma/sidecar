/**
 * Fase 3: Embedding Worker
 *
 * Background worker that processes the embedding queue asynchronously.
 * Features:
 * - Mutex to prevent concurrent processing
 * - Stall recovery on startup
 * - Queue depth monitoring
 */

import { createLogger } from '../utils/logger.js';
import { embedText, isModelReady } from './embeddings-model.js';
import { isEmbeddingsEnabled, isEmbeddingsReady, recordEmbeddingSuccess, recordEmbeddingFailure } from './embeddings-state.js';
import { serializeEmbedding } from './vector-math.js';
import {
  getDatabase,
  getPendingEmbeddings,
  getPendingEmbeddingCount,
  markEmbeddingProcessing,
  markEmbeddingCompleted,
  markEmbeddingFailed,
  recoverStalledEmbeddings,
  cleanupFailedEmbeddings,
  saveFactEmbedding,
  getFactsNeedingEmbedding,
  queueFactForEmbedding,
  cleanupExpiredCache,
  type PendingEmbeddingRow,
} from './store.js';
import { getFactById } from './facts-store.js';
import { upsertFactVector } from './embeddings-loader.js';

const logger = createLogger('embedding-worker');

const WORKER_INTERVAL_MS = 10_000; // 10 seconds
const BATCH_SIZE = 10;
const MAX_QUEUE_DEPTH = 1000; // Alert threshold
const MAX_PENDING_EMBEDDINGS = 1000; // Hard cap to prevent unbounded growth
const CURRENT_MODEL_VERSION = 'all-MiniLM-L6-v2';
const CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let workerTimer: ReturnType<typeof setInterval> | null = null;
let processingLock = false; // Mutex for queue processing
let lastCacheCleanup = 0; // Track last cleanup time

/**
 * Starts the embedding worker.
 * Runs recovery tasks and begins periodic queue processing.
 */
export async function startEmbeddingWorker(): Promise<void> {
  if (workerTimer) return;

  if (!isEmbeddingsEnabled()) {
    logger.info('Embedding worker not started (embeddings disabled)');
    return;
  }

  // Recover stalled items from previous runs
  recoverStalledEmbeddings();

  // Reconcile vector index (fix any embeddings missing from fact_vectors)
  reconcileVectorIndex();

  // Cleanup old failed items
  cleanupFailedEmbeddings();

  // Fix #4: Cleanup orphan vectors/embeddings for deleted facts
  cleanupOrphanVectors();

  // Queue facts without embeddings
  await queueMissingEmbeddings();

  // Enforce queue limit to prevent unbounded growth
  enforceEmbeddingQueueLimit();

  // Check queue depth
  const queueDepth = getPendingEmbeddingCount();
  if (queueDepth > MAX_QUEUE_DEPTH) {
    logger.warn('Embedding queue depth exceeds threshold', {
      depth: queueDepth,
      threshold: MAX_QUEUE_DEPTH,
    });
  }

  logger.info('Starting embedding worker', { pendingCount: queueDepth });
  workerTimer = setInterval(processEmbeddingQueue, WORKER_INTERVAL_MS);

  // Run immediately if queue has items
  if (queueDepth > 0) {
    processEmbeddingQueue();
  }
}

/**
 * Stops the embedding worker.
 */
export function stopEmbeddingWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    logger.info('Embedding worker stopped');
  }
}

/**
 * Processes pending embeddings in the queue.
 * Uses a mutex to prevent concurrent processing.
 */
async function processEmbeddingQueue(): Promise<void> {
  // Mutex check - skip if already processing
  if (processingLock) {
    logger.debug('Embedding worker already processing, skipping tick');
    return;
  }

  // Periodic cache cleanup (once per hour)
  if (Date.now() - lastCacheCleanup > CACHE_CLEANUP_INTERVAL_MS) {
    cleanupExpiredCache();
    cleanupFailedEmbeddings();
    lastCacheCleanup = Date.now();
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
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Embedding worker error', { error: message });
  } finally {
    processingLock = false;
  }
}

/**
 * Processes a single embedding item.
 */
async function processEmbeddingItem(item: PendingEmbeddingRow): Promise<void> {
  markEmbeddingProcessing(item.id);

  try {
    const fact = getFactById(item.fact_id);
    if (!fact) {
      // Fact was deleted, mark as complete
      markEmbeddingCompleted(item.id);
      logger.debug('Fact deleted, skipping embedding', { factId: item.fact_id });
      return;
    }

    const embedding = await embedText(fact.fact);
    const embeddingBuffer = serializeEmbedding(embedding);

    // Save to fact_embeddings table
    saveFactEmbedding(item.fact_id, embeddingBuffer, CURRENT_MODEL_VERSION);

    // Update vector index (if available)
    try {
      const db = getDatabase();
      upsertFactVector(db, item.fact_id, embeddingBuffer);
    } catch (vectorError) {
      // Vector index might not be available (sqlite-vec not loaded)
      logger.debug('Could not update vector index', {
        factId: item.fact_id,
        error: vectorError instanceof Error ? vectorError.message : 'Unknown',
      });
    }

    markEmbeddingCompleted(item.id);
    recordEmbeddingSuccess();

    logger.debug('Embedded fact', { factId: item.fact_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    markEmbeddingFailed(item.id, message);
    recordEmbeddingFailure();
    logger.warn('Embedding failed', { factId: item.fact_id, error: message });
  }
}

/**
 * Queues facts that don't have embeddings yet.
 * Called at startup and when model version changes.
 */
async function queueMissingEmbeddings(): Promise<void> {
  const missing = getFactsNeedingEmbedding(CURRENT_MODEL_VERSION, 500);

  if (missing.length > 0) {
    logger.info('Queueing missing embeddings', { count: missing.length });
    for (const fact of missing) {
      queueFactForEmbedding(fact.id);
    }
  }
}

/**
 * Returns the current model version used for embeddings.
 */
export function getCurrentModelVersion(): string {
  return CURRENT_MODEL_VERSION;
}

/**
 * Returns worker status for monitoring.
 */
export function getWorkerStatus(): {
  running: boolean;
  processing: boolean;
  queueDepth: number;
  modelReady: boolean;
} {
  return {
    running: workerTimer !== null,
    processing: processingLock,
    queueDepth: getPendingEmbeddingCount(),
    modelReady: isModelReady(),
  };
}

/**
 * Forces immediate queue processing (for testing).
 */
export async function forceProcessQueue(): Promise<void> {
  await processEmbeddingQueue();
}

/**
 * Reconciles fact_embeddings with fact_vectors.
 * Re-indexes any embeddings that exist but aren't in the vector index.
 * Handles the case where upsertFactVector() failed silently.
 *
 * @returns Number of embeddings re-indexed
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
    // fact_vectors table might not exist (sqlite-vec not loaded)
    logger.debug('Vector index reconciliation skipped', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return 0;
  }
}

/**
 * Enforces max queue size by removing oldest pending items.
 * Called when queue exceeds MAX_PENDING_EMBEDDINGS to prevent unbounded growth
 * if the embedding model never loads.
 *
 * @returns Number of items removed
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

/**
 * Fix #4: Removes vectors and embeddings for facts that no longer exist.
 * Called periodically to prevent orphan accumulation.
 *
 * Note: fact_embeddings has ON DELETE CASCADE but fact_vectors is a sqlite-vec
 * virtual table that may not support CASCADE, so we clean both explicitly.
 *
 * @returns Number of orphan records removed
 */
export function cleanupOrphanVectors(): number {
  if (!isEmbeddingsEnabled()) return 0;

  const database = getDatabase();
  let totalCleaned = 0;

  // 1. Cleanup orphan fact_embeddings (should be rare due to CASCADE)
  try {
    const orphanEmbeddings = database.prepare(`
      DELETE FROM fact_embeddings
      WHERE fact_id NOT IN (SELECT id FROM facts)
    `).run();

    if (orphanEmbeddings.changes > 0) {
      logger.info('Cleaned up orphan embeddings', { count: orphanEmbeddings.changes });
      totalCleaned += orphanEmbeddings.changes;
    }
  } catch (error) {
    logger.debug('Orphan embeddings cleanup skipped', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
  }

  // 2. Cleanup orphan fact_vectors (sqlite-vec virtual table)
  try {
    // First find orphans
    const orphans = database.prepare(`
      SELECT v.fact_id
      FROM fact_vectors v
      LEFT JOIN facts f ON v.fact_id = f.id
      WHERE f.id IS NULL
    `).all() as Array<{ fact_id: string }>;

    if (orphans.length > 0) {
      logger.info('Cleaning up orphan vectors', { count: orphans.length });

      for (const { fact_id } of orphans) {
        try {
          database.prepare('DELETE FROM fact_vectors WHERE fact_id = ?').run(fact_id);
          totalCleaned++;
        } catch (deleteError) {
          logger.warn('Failed to delete orphan vector', {
            factId: fact_id,
            error: deleteError instanceof Error ? deleteError.message : 'Unknown',
          });
        }
      }
    }
  } catch (error) {
    // fact_vectors table might not exist (sqlite-vec not loaded)
    logger.debug('Orphan vector cleanup skipped (sqlite-vec not available)', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
  }

  return totalCleaned;
}

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
  type PendingEmbeddingRow,
} from './store.js';
import { getFactById } from './facts-store.js';
import { upsertFactVector } from './embeddings-loader.js';

const logger = createLogger('embedding-worker');

const WORKER_INTERVAL_MS = 10_000; // 10 seconds
const BATCH_SIZE = 10;
const MAX_QUEUE_DEPTH = 1000; // Alert threshold
const CURRENT_MODEL_VERSION = 'all-MiniLM-L6-v2';

let workerTimer: ReturnType<typeof setInterval> | null = null;
let processingLock = false; // Mutex for queue processing

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

  // Cleanup old failed items
  cleanupFailedEmbeddings();

  // Queue facts without embeddings
  await queueMissingEmbeddings();

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

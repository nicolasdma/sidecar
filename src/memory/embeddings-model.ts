/**
 * Fase 3: Embeddings Model
 *
 * Wraps transformers.js for local embedding generation.
 * Features:
 * - Lazy loading (doesn't block startup)
 * - Exponential backoff for retries
 * - Progress logging for model download
 */

import { createLogger } from '../utils/logger.js';
import { getEmbeddingsConfig } from '../config/embeddings-config.js';
import { markEmbeddingsReady, markEmbeddingsNotReady, recordEmbeddingFailure } from './embeddings-state.js';

const logger = createLogger('embeddings-model');

// Dynamic import type for transformers.js
type Pipeline = Awaited<ReturnType<typeof import('@xenova/transformers').pipeline>>;

// Model state
let embeddingPipeline: Pipeline | null = null;
let loadingPromise: Promise<void> | null = null;
let loadAttempts = 0;
let nextRetryTime = 0;

const MAX_LOAD_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 5000; // 5 seconds
const EMBEDDING_TIMEOUT_MS = 30000; // 30 seconds timeout for embedding operations

/**
 * Wraps a promise with a timeout.
 * Rejects with TimeoutError if the promise doesn't resolve within the specified time.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Progress callback type for model download.
 */
interface ProgressInfo {
  status: string;
  progress?: number;
  file?: string;
}

/**
 * Tracks whether we've shown download progress to avoid duplicate messages.
 */
let downloadProgressShown = false;

/**
 * Lazily loads the embedding model on first use.
 * Implements exponential backoff for repeated failures.
 *
 * @throws Error if model fails to load after max attempts or during backoff
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

  // If another call is already loading, wait for it
  if (loadingPromise) {
    return loadingPromise;
  }

  const config = getEmbeddingsConfig();

  loadingPromise = (async () => {
    loadAttempts++;
    logger.info('Loading embedding model (first use)', {
      model: config.modelName,
      attempt: loadAttempts,
    });
    const startTime = Date.now();

    try {
      // Dynamic import of transformers.js
      const { pipeline } = await import('@xenova/transformers');

      // Show user-friendly download message on first run
      let isDownloading = false;

      embeddingPipeline = await pipeline('feature-extraction', config.modelName, {
        quantized: true,
        progress_callback: (progress: ProgressInfo) => {
          if (progress.progress !== undefined) {
            // First time we see progress, show a helpful message
            if (!downloadProgressShown && progress.status === 'downloading') {
              console.log('\n⏳ Downloading embedding model (first time only)...');
              console.log('   This may take 10-30 seconds.\n');
              downloadProgressShown = true;
              isDownloading = true;
            }

            // Show progress bar for downloads
            if (progress.status === 'downloading' || progress.status === 'progress') {
              const percent = Math.round(progress.progress);
              const filled = Math.floor(percent / 5);
              const empty = 20 - filled;
              const bar = '█'.repeat(filled) + '░'.repeat(empty);
              process.stdout.write(`\r   [${bar}] ${percent}%`);
            }

            logger.debug('Model download progress', {
              percent: Math.round(progress.progress),
              file: progress.file,
            });
          }
        },
      });

      // Clear progress line and show completion if we were downloading
      if (isDownloading) {
        console.log('\n✓ Embedding model ready.\n');
      }

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
        maxAttempts: MAX_LOAD_ATTEMPTS,
      });

      // Set backoff time
      const backoffMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, loadAttempts - 1);
      nextRetryTime = Date.now() + backoffMs;

      logger.warn('Will retry model loading', {
        retryIn: `${backoffMs / 1000}s`,
        nextAttempt: loadAttempts + 1,
      });

      markEmbeddingsNotReady('model_missing');
      recordEmbeddingFailure();
      loadingPromise = null; // Allow retry after backoff
      throw error;
    }
  })();

  return loadingPromise;
}

/**
 * Embeds a single text string.
 *
 * @param text - Text to embed
 * @returns 384-dimensional embedding vector
 * @throws Error if model not loaded, embedding fails, or operation times out
 */
export async function embedText(text: string): Promise<Float32Array> {
  await ensureModelLoaded();

  if (!embeddingPipeline) {
    throw new Error('Embedding model not loaded');
  }

  // Wrap embedding operation with timeout to prevent hung workers
  const output = await withTimeout(
    embeddingPipeline(text, {
      pooling: 'mean',
      normalize: true,
    }),
    EMBEDDING_TIMEOUT_MS,
    'Embedding operation'
  );

  // Extract the data from the tensor
  return new Float32Array(output.data);
}

/**
 * Embeds multiple text strings.
 *
 * @param texts - Array of texts to embed
 * @returns Array of 384-dimensional embedding vectors
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  await ensureModelLoaded();
  return Promise.all(texts.map(t => embedText(t)));
}

/**
 * Returns the embedding dimension for the current model.
 */
export function getEmbeddingDimension(): number {
  return getEmbeddingsConfig().embeddingDimension;
}

/**
 * Returns whether the embedding model is loaded and ready.
 */
export function isModelReady(): boolean {
  return embeddingPipeline !== null;
}

/**
 * Returns the current model name.
 */
export function getModelName(): string {
  return getEmbeddingsConfig().modelName;
}

/**
 * Resets the model state.
 * Useful for testing.
 */
export function resetModel(): void {
  embeddingPipeline = null;
  loadingPromise = null;
  loadAttempts = 0;
  nextRetryTime = 0;
}

/**
 * Returns loading status information.
 */
export function getModelStatus(): {
  loaded: boolean;
  loading: boolean;
  attempts: number;
  nextRetryIn: number | null;
} {
  return {
    loaded: embeddingPipeline !== null,
    loading: loadingPromise !== null,
    attempts: loadAttempts,
    nextRetryIn: nextRetryTime > Date.now() ? nextRetryTime - Date.now() : null,
  };
}

/**
 * Disposes the embedding pipeline to free memory.
 * Should be called on application shutdown to prevent memory leaks.
 */
export async function disposePipeline(): Promise<void> {
  if (!embeddingPipeline) {
    return;
  }

  try {
    // transformers.js pipelines may have a dispose method
    if (typeof (embeddingPipeline as unknown as { dispose?: () => Promise<void> }).dispose === 'function') {
      await (embeddingPipeline as unknown as { dispose: () => Promise<void> }).dispose();
      logger.info('Embedding pipeline disposed via dispose()');
    }
  } catch (error) {
    logger.warn('Error disposing embedding pipeline', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
  } finally {
    // Always clear the reference to allow garbage collection
    embeddingPipeline = null;
    loadingPromise = null;
    logger.info('Embedding pipeline reference cleared');
  }
}

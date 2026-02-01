/**
 * Fase 3: Embeddings State Management
 *
 * Global state for embeddings system including:
 * - Enabled/disabled status tracking
 * - Circuit breaker for failure handling
 * - User-facing status messages
 */

import { createLogger } from '../utils/logger.js';
import { getEmbeddingsConfig } from '../config/embeddings-config.js';
import { getDatabase } from './store.js';
import { loadSqliteVec, createVectorIndex } from './embeddings-loader.js';

const logger = createLogger('embeddings-state');

/**
 * Reasons why embeddings might be disabled.
 */
export type DisabledReason =
  | 'ok'
  | 'disabled_by_config'
  | 'extension_missing'
  | 'model_missing'
  | 'load_error'
  | 'circuit_breaker';

/**
 * Internal state for the embeddings system.
 */
interface EmbeddingsState {
  /** Extension loaded and tables created */
  enabled: boolean;
  /** Model actually loaded and working */
  ready: boolean;
  /** Reason if not enabled/ready */
  reason: DisabledReason;
  /** Timestamp of last state check */
  lastCheck: number;
  /** Count of consecutive embedding failures */
  consecutiveFailures: number;
  /** Timestamp when circuit breaker will reset */
  circuitOpenUntil: number | null;
}

let state: EmbeddingsState = {
  enabled: false,
  ready: false,
  reason: 'extension_missing',
  lastCheck: 0,
  consecutiveFailures: 0,
  circuitOpenUntil: null,
};

/**
 * Returns whether embeddings infrastructure is enabled (extension loaded).
 */
export function isEmbeddingsEnabled(): boolean {
  return state.enabled;
}

/**
 * Returns whether embeddings are fully ready for use.
 * Checks circuit breaker status and resets if cooldown passed.
 */
export function isEmbeddingsReady(): boolean {
  // Check circuit breaker
  if (state.circuitOpenUntil && Date.now() < state.circuitOpenUntil) {
    return false;
  }

  // Reset circuit if cooldown passed
  if (state.circuitOpenUntil && Date.now() >= state.circuitOpenUntil) {
    logger.info('Circuit breaker reset, retrying embeddings');
    state.circuitOpenUntil = null;
    state.consecutiveFailures = 0;
    state.reason = 'ok';
  }

  return state.enabled && state.ready;
}

/**
 * Records a successful embedding operation.
 * Resets the failure counter.
 */
export function recordEmbeddingSuccess(): void {
  state.consecutiveFailures = 0;
}

/**
 * Records a failed embedding operation.
 * May trip the circuit breaker if threshold exceeded.
 */
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

/**
 * Returns a read-only copy of the current state.
 */
export function getEmbeddingsState(): Readonly<EmbeddingsState> {
  return { ...state };
}

/**
 * Returns a user-friendly status message about embeddings.
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
 * Marks the embedding model as ready.
 * Called after the model successfully loads.
 */
export function markEmbeddingsReady(): void {
  state.ready = true;
  state.reason = 'ok';
  logger.info('Embeddings ready');
}

/**
 * Marks the embedding model as not ready.
 * Called if model loading fails.
 */
export function markEmbeddingsNotReady(reason: DisabledReason): void {
  state.ready = false;
  state.reason = reason;
  logger.warn('Embeddings not ready', { reason });
}

/**
 * Initializes the embeddings capability.
 * Loads the sqlite-vec extension and creates the vector index.
 * Does NOT load the model - that happens lazily on first use.
 *
 * @returns true if embeddings infrastructure is ready
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
      lastCheck: Date.now(),
    };
    logger.info('Embeddings disabled by configuration (EMBEDDINGS_ENABLED=false)');
    return false;
  }

  const db = getDatabase();

  // Step 1: Load sqlite-vec extension
  const loadResult = await loadSqliteVec(db);
  if (!loadResult.success) {
    state = {
      ...state,
      enabled: false,
      ready: false,
      reason: 'extension_missing',
      lastCheck: Date.now(),
    };
    logger.warn('Embeddings disabled: sqlite-vec not available', { error: loadResult.error });
    return false;
  }

  // Step 2: Create vector index
  try {
    createVectorIndex(db, config.embeddingDimension);
  } catch (error) {
    state = {
      ...state,
      enabled: false,
      ready: false,
      reason: 'load_error',
      lastCheck: Date.now(),
    };
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Embeddings disabled: failed to create vector index', { error: message });
    return false;
  }

  // Mark as enabled but not ready (model loads lazily)
  state = {
    ...state,
    enabled: true,
    ready: false,
    reason: 'ok',
    lastCheck: Date.now(),
  };
  logger.info('Embeddings enabled (model will load on first use)', { source: loadResult.source });
  return true;
}

/**
 * Resets the embeddings state.
 * Useful for testing.
 */
export function resetEmbeddingsState(): void {
  state = {
    enabled: false,
    ready: false,
    reason: 'extension_missing',
    lastCheck: 0,
    consecutiveFailures: 0,
    circuitOpenUntil: null,
  };
}

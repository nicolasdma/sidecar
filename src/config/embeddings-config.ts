/**
 * Fase 3: Embeddings Configuration
 *
 * Centralized configuration for semantic intelligence features.
 * All settings can be overridden via environment variables.
 */

export interface EmbeddingsConfig {
  /** Master toggle - set to false to disable embeddings entirely */
  enabled: boolean;
  /** Similarity threshold for cache hits (0.0 - 1.0) */
  cacheSimilarityThreshold: number;
  /** Number of consecutive failures before circuit breaker opens */
  circuitBreakerThreshold: number;
  /** Milliseconds to wait before retrying after circuit breaker trips */
  circuitBreakerResetMs: number;
  /** Hugging Face model name for embeddings */
  modelName: string;
  /** Vector dimension (must match model output) */
  embeddingDimension: number;
}

/**
 * Loads configuration from environment variables with sensible defaults.
 */
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

// Singleton instance - loaded once and cached
let config: EmbeddingsConfig | null = null;

/**
 * Returns the embeddings configuration.
 * Loads from environment on first call, then returns cached value.
 */
export function getEmbeddingsConfig(): EmbeddingsConfig {
  if (!config) {
    config = loadEmbeddingsConfig();
  }
  return config;
}

/**
 * Resets the cached configuration.
 * Useful for testing or when environment changes.
 */
export function resetEmbeddingsConfig(): void {
  config = null;
}

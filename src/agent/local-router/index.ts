/**
 * LocalRouter - Fase 3.5
 *
 * Pre-Brain router that uses Qwen2.5-3B to classify intents and execute
 * deterministic tools directly, without calling the main LLM.
 *
 * This reduces costs, latency, and eliminates the risk of the LLM
 * "deciding" not to use a tool for deterministic operations.
 */

import { createLogger } from '../../utils/logger.js';
import { classifyIntent, warmupClassifier, validateModel } from './classifier.js';
import { executeIntent } from './direct-executor.js';
import type {
  Intent,
  Route,
  ClassificationResult,
  DirectExecutionResult,
  RoutingResult,
  LocalRouterConfig,
  LocalRouterStats,
} from './types.js';

// Re-export types
export type {
  Intent,
  Route,
  ClassificationResult,
  DirectExecutionResult,
  RoutingResult,
  LocalRouterConfig,
  LocalRouterStats,
};

const logger = createLogger('local-router');

/**
 * Default configuration for LocalRouter.
 */
const DEFAULT_CONFIG: LocalRouterConfig = {
  enabled: true,
  confidenceThreshold: 0.8,
  ollamaTimeout: 30000,
  maxLatencyBeforeBypass: 60000,  // 60 seconds - very generous for debugging
};

/**
 * Backoff thresholds for Ollama failure handling.
 */
const BACKOFF_THRESHOLDS = {
  failuresToTrigger: 3, // After 3 failures, enter backoff
  initialBackoffMs: 30_000, // 30 seconds
  maxBackoffMs: 300_000, // 5 minutes max
  backoffMultiplier: 2, // Double each time
};

/**
 * Internal backoff state tracking.
 */
interface BackoffState {
  consecutiveFailures: number;
  backoffUntil: number | null;
  lastError: string | null;
}

/**
 * LocalRouter class - manages intent classification and direct tool execution.
 */
export class LocalRouter {
  private config: LocalRouterConfig;
  private stats: LocalRouterStats;
  private warmedUp: boolean = false;
  private modelAvailable: boolean | null = null;
  private backoffState: BackoffState;

  constructor(config?: Partial<LocalRouterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stats = this.createEmptyStats();
    this.backoffState = {
      consecutiveFailures: 0,
      backoffUntil: null,
      lastError: null,
    };
  }

  /**
   * Create empty stats object.
   */
  private createEmptyStats(): LocalRouterStats {
    return {
      totalRequests: 0,
      routedLocal: 0,
      routedToLlm: 0,
      directSuccess: 0,
      directFailures: 0,
      fallbacksToBrain: 0,
      avgLocalLatencyMs: 0,
      resetAt: new Date(),
    };
  }

  /**
   * Check if currently in backoff mode.
   */
  private isInBackoff(): boolean {
    if (this.backoffState.backoffUntil === null) {
      return false;
    }
    if (Date.now() > this.backoffState.backoffUntil) {
      // Backoff expired, reset
      this.backoffState.backoffUntil = null;
      return false;
    }
    return true;
  }

  /**
   * Record a failure and potentially enter backoff.
   */
  private recordOllamaFailure(error: string): void {
    this.backoffState.consecutiveFailures++;
    this.backoffState.lastError = error;

    if (this.backoffState.consecutiveFailures >= BACKOFF_THRESHOLDS.failuresToTrigger) {
      const backoffMs = Math.min(
        BACKOFF_THRESHOLDS.initialBackoffMs *
          Math.pow(
            BACKOFF_THRESHOLDS.backoffMultiplier,
            this.backoffState.consecutiveFailures - BACKOFF_THRESHOLDS.failuresToTrigger
          ),
        BACKOFF_THRESHOLDS.maxBackoffMs
      );
      this.backoffState.backoffUntil = Date.now() + backoffMs;
      logger.warn('LocalRouter entering backoff', {
        failures: this.backoffState.consecutiveFailures,
        backoff_ms: backoffMs,
        until: new Date(this.backoffState.backoffUntil).toISOString(),
      });
    }
  }

  /**
   * Record a success and reset failure counter.
   */
  private recordOllamaSuccess(): void {
    if (this.backoffState.consecutiveFailures > 0) {
      logger.info('LocalRouter recovered from failures', {
        previous_failures: this.backoffState.consecutiveFailures,
      });
    }
    this.backoffState.consecutiveFailures = 0;
    this.backoffState.backoffUntil = null;
    this.backoffState.lastError = null;
  }

  /**
   * Check if the router is enabled and model is available.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    // Cache model availability check
    if (this.modelAvailable === null) {
      const result = await validateModel();
      this.modelAvailable = result.valid;

      if (!result.valid) {
        logger.warn('LocalRouter model not available', { error: result.error });
      }
    }

    return this.modelAvailable;
  }

  /**
   * Warm up the classifier by loading the model into memory.
   */
  async warmup(): Promise<void> {
    if (!this.config.enabled) {
      logger.debug('LocalRouter disabled, skipping warmup');
      return;
    }

    if (this.warmedUp) {
      logger.debug('LocalRouter already warmed up');
      return;
    }

    logger.info('Warming up LocalRouter...');
    const result = await warmupClassifier();

    if (result.success) {
      this.warmedUp = true;
      this.modelAvailable = true;
      logger.info('LocalRouter warm-up complete', { latency_ms: result.latencyMs });
    } else {
      this.modelAvailable = false;
      logger.warn('LocalRouter warm-up failed, will retry on first request', {
        latency_ms: result.latencyMs,
      });
    }
  }

  /**
   * Try to route a user message.
   * Returns routing decision without executing the tool.
   */
  async tryRoute(userInput: string): Promise<RoutingResult> {
    const startTime = Date.now();
    this.stats.totalRequests++;

    // Check backoff state FIRST - bypass immediately if in backoff
    if (this.isInBackoff()) {
      logger.debug('LocalRouter in backoff, bypassing to LLM', {
        until: this.backoffState.backoffUntil
          ? new Date(this.backoffState.backoffUntil).toISOString()
          : null,
      });
      this.stats.routedToLlm++;
      return {
        route: 'ROUTE_TO_LLM',
        intent: 'unknown',
        confidence: 0,
        latencyMs: 0, // No latency since we bypassed
      };
    }

    // Check availability
    const available = await this.isAvailable();
    if (!available) {
      logger.debug('LocalRouter not available, routing to LLM');
      this.stats.routedToLlm++;
      this.recordOllamaFailure('Model not available');
      return {
        route: 'ROUTE_TO_LLM',
        intent: 'unknown',
        confidence: 0,
        latencyMs: Date.now() - startTime,
      };
    }

    // Classify intent
    let classification;
    try {
      classification = await classifyIntent(userInput);
    } catch (error) {
      // Classification threw an error - record failure and route to LLM
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.recordOllamaFailure(errorMsg);
      this.stats.routedToLlm++;
      return {
        route: 'ROUTE_TO_LLM',
        intent: 'unknown',
        confidence: 0,
        latencyMs: Date.now() - startTime,
      };
    }

    const latencyMs = classification.latencyMs || Date.now() - startTime;

    // Check for classification failure (rawResponse indicates error)
    if (classification.intent === 'unknown' && classification.rawResponse?.includes('timeout')) {
      this.recordOllamaFailure(classification.rawResponse);
    } else if (classification.intent !== 'unknown') {
      // Success - reset failure counter
      this.recordOllamaSuccess();
    }

    // Check latency threshold
    if (latencyMs > this.config.maxLatencyBeforeBypass) {
      logger.warn('Classification latency exceeded threshold, routing to LLM', {
        latency_ms: latencyMs,
        threshold: this.config.maxLatencyBeforeBypass,
      });
      this.recordOllamaFailure(`Latency exceeded: ${latencyMs}ms`);
      this.stats.routedToLlm++;
      return {
        route: 'ROUTE_TO_LLM',
        intent: classification.intent,
        confidence: classification.confidence,
        params: classification.params,
        latencyMs,
      };
    }

    // Update stats
    if (classification.route === 'DIRECT_TOOL') {
      this.stats.routedLocal++;
      this.updateAvgLatency(latencyMs);
    } else {
      this.stats.routedToLlm++;
    }

    return {
      route: classification.route,
      intent: classification.intent,
      confidence: classification.confidence,
      params: classification.params,
      latencyMs,
    };
  }

  /**
   * Execute a direct tool based on intent and params.
   */
  async executeDirect(
    intent: Intent,
    params: Record<string, string>
  ): Promise<DirectExecutionResult> {
    const result = await executeIntent(intent, params);

    // Update stats
    if (result.success) {
      this.stats.directSuccess++;
    } else {
      this.stats.directFailures++;
    }

    return result;
  }

  /**
   * Mark a fallback to Brain (used when direct execution fails).
   */
  recordFallback(): void {
    this.stats.fallbacksToBrain++;
  }

  /**
   * Get current stats.
   */
  getStats(): LocalRouterStats {
    return {
      ...this.stats,
      backoff: {
        inBackoff: this.isInBackoff(),
        consecutiveFailures: this.backoffState.consecutiveFailures,
        backoffUntil: this.backoffState.backoffUntil
          ? new Date(this.backoffState.backoffUntil)
          : null,
        lastError: this.backoffState.lastError,
      },
    };
  }

  /**
   * Reset stats.
   */
  resetStats(): void {
    this.stats = this.createEmptyStats();
    logger.info('LocalRouter stats reset');
  }

  /**
   * Update average latency using incremental formula.
   */
  private updateAvgLatency(newLatency: number): void {
    const n = this.stats.routedLocal;
    if (n === 1) {
      this.stats.avgLocalLatencyMs = newLatency;
    } else {
      // Incremental average: new_avg = old_avg + (new_value - old_avg) / n
      this.stats.avgLocalLatencyMs =
        this.stats.avgLocalLatencyMs + (newLatency - this.stats.avgLocalLatencyMs) / n;
    }
  }

  /**
   * Get configuration.
   */
  getConfig(): LocalRouterConfig {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(updates: Partial<LocalRouterConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info('LocalRouter config updated', { config: this.config });
  }
}

// Singleton instance
let localRouterInstance: LocalRouter | null = null;

/**
 * Get or create the LocalRouter singleton.
 */
export function getLocalRouter(config?: Partial<LocalRouterConfig>): LocalRouter {
  if (!localRouterInstance) {
    localRouterInstance = new LocalRouter(config);
  }
  return localRouterInstance;
}

/**
 * Initialize LocalRouter with optional warmup.
 */
export async function initializeLocalRouter(
  config?: Partial<LocalRouterConfig>,
  warmup: boolean = true
): Promise<LocalRouter> {
  const router = getLocalRouter(config);

  if (warmup) {
    await router.warmup();
  }

  return router;
}

export default LocalRouter;

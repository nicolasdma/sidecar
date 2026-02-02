/**
 * Router Metrics - Fase 3.6a
 *
 * Tracks routing statistics, token savings, and system health metrics.
 * Persists to SQLite for historical analysis.
 */

import { createLogger } from '../utils/logger.js';
import { getSystemStateJson, setSystemStateJson } from '../memory/store.js';
import { RouterMetrics } from './types.js';

const logger = createLogger('router-metrics');

const METRICS_STATE_KEY = 'router_v2_metrics';

/**
 * Default metrics structure
 */
function createDefaultMetrics(): RouterMetrics {
  return {
    requestsTotal: 0,
    requestsDeterministic: 0,
    requestsLocal: 0,
    requestsApi: 0,
    localToApiFallbacks: 0,
    tokensProcessedLocal: 0,
    tokensSavedVsApi: 0,
    latencyDeterministicAvg: 0,
    latencyLocalAvg: 0,
    latencyApiAvg: 0,
    latencyLocalP99: 0,
    modelLoadCount: 0,
    modelLoadTimeAvg: 0,
    ollamaReconnects: 0,
    memoryPressureEvents: 0,
    intentBreakdown: {},
  };
}

/**
 * Internal state for computing averages
 */
interface MetricsState {
  metrics: RouterMetrics;
  latencyDeterministicSum: number;
  latencyDeterministicCount: number;
  latencyLocalSum: number;
  latencyLocalCount: number;
  latencyApiSum: number;
  latencyApiCount: number;
  latencyLocalSamples: number[];
  modelLoadTimeSum: number;
  lastSavedAt: number;
}

let state: MetricsState | null = null;

/**
 * Load metrics from SQLite
 */
function loadMetrics(): MetricsState {
  if (state) return state;

  const saved = getSystemStateJson<MetricsState>(METRICS_STATE_KEY);

  if (saved && saved.metrics) {
    state = {
      ...saved,
      latencyLocalSamples: saved.latencyLocalSamples || [],
    };
    logger.debug('Loaded router metrics from storage');
  } else {
    state = {
      metrics: createDefaultMetrics(),
      latencyDeterministicSum: 0,
      latencyDeterministicCount: 0,
      latencyLocalSum: 0,
      latencyLocalCount: 0,
      latencyApiSum: 0,
      latencyApiCount: 0,
      latencyLocalSamples: [],
      modelLoadTimeSum: 0,
      lastSavedAt: Date.now(),
    };
    logger.debug('Created new router metrics');
  }

  return state;
}

/**
 * Save metrics to SQLite (debounced)
 */
function saveMetrics(): void {
  if (!state) return;

  const now = Date.now();
  // Only save every 30 seconds to reduce I/O
  if (now - state.lastSavedAt < 30000) {
    return;
  }

  setSystemStateJson(METRICS_STATE_KEY, state);
  state.lastSavedAt = now;
}

/**
 * Force save metrics immediately
 */
export function flushMetrics(): void {
  if (!state) return;
  setSystemStateJson(METRICS_STATE_KEY, state);
  state.lastSavedAt = Date.now();
  logger.debug('Flushed router metrics to storage');
}

/**
 * Record a deterministic (direct tool) request
 */
export function recordDeterministicRequest(intent: string, latencyMs: number): void {
  const s = loadMetrics();

  s.metrics.requestsTotal++;
  s.metrics.requestsDeterministic++;

  s.latencyDeterministicSum += latencyMs;
  s.latencyDeterministicCount++;
  s.metrics.latencyDeterministicAvg = Math.round(
    s.latencyDeterministicSum / s.latencyDeterministicCount
  );

  updateIntentBreakdown(s.metrics, intent, true, latencyMs);
  saveMetrics();
}

/**
 * Record a local LLM request
 */
export function recordLocalRequest(
  intent: string,
  latencyMs: number,
  tokensGenerated: number,
  success: boolean
): void {
  const s = loadMetrics();

  s.metrics.requestsTotal++;
  s.metrics.requestsLocal++;

  s.latencyLocalSum += latencyMs;
  s.latencyLocalCount++;
  s.metrics.latencyLocalAvg = Math.round(s.latencyLocalSum / s.latencyLocalCount);

  // Track P99
  s.latencyLocalSamples.push(latencyMs);
  if (s.latencyLocalSamples.length > 100) {
    s.latencyLocalSamples.shift();
  }
  s.metrics.latencyLocalP99 = calculateP99(s.latencyLocalSamples);

  // Track tokens
  if (success) {
    s.metrics.tokensProcessedLocal += tokensGenerated;
    // Estimate savings (if this went to API, assume 2x cost)
    s.metrics.tokensSavedVsApi += tokensGenerated;
  }

  updateIntentBreakdown(s.metrics, intent, success, latencyMs);
  saveMetrics();
}

/**
 * Record an API request
 */
export function recordApiRequest(intent: string, latencyMs: number): void {
  const s = loadMetrics();

  s.metrics.requestsTotal++;
  s.metrics.requestsApi++;

  s.latencyApiSum += latencyMs;
  s.latencyApiCount++;
  s.metrics.latencyApiAvg = Math.round(s.latencyApiSum / s.latencyApiCount);

  updateIntentBreakdown(s.metrics, intent, true, latencyMs);
  saveMetrics();
}

/**
 * Record a fallback from local to API
 */
export function recordLocalToApiFallback(intent: string): void {
  const s = loadMetrics();
  s.metrics.localToApiFallbacks++;
  saveMetrics();

  logger.debug('Local to API fallback recorded', { intent });
}

/**
 * Record a model load event
 */
export function recordModelLoad(loadTimeMs: number): void {
  const s = loadMetrics();

  s.metrics.modelLoadCount++;
  s.modelLoadTimeSum += loadTimeMs;
  s.metrics.modelLoadTimeAvg = Math.round(s.modelLoadTimeSum / s.metrics.modelLoadCount);

  saveMetrics();
}

/**
 * Record an Ollama reconnect event
 */
export function recordOllamaReconnect(): void {
  const s = loadMetrics();
  s.metrics.ollamaReconnects++;
  saveMetrics();
}

/**
 * Record a memory pressure event
 */
export function recordMemoryPressureEvent(): void {
  const s = loadMetrics();
  s.metrics.memoryPressureEvents++;
  saveMetrics();

  logger.warn('Memory pressure event recorded');
}

/**
 * Get current metrics
 */
export function getRouterMetrics(): RouterMetrics {
  const s = loadMetrics();
  return { ...s.metrics };
}

/**
 * Reset metrics (for testing or daily reset)
 */
export function resetRouterMetrics(): void {
  state = {
    metrics: createDefaultMetrics(),
    latencyDeterministicSum: 0,
    latencyDeterministicCount: 0,
    latencyLocalSum: 0,
    latencyLocalCount: 0,
    latencyApiSum: 0,
    latencyApiCount: 0,
    latencyLocalSamples: [],
    modelLoadTimeSum: 0,
    lastSavedAt: Date.now(),
  };
  flushMetrics();
  logger.info('Router metrics reset');
}

/**
 * Update intent breakdown
 */
function updateIntentBreakdown(
  metrics: RouterMetrics,
  intent: string,
  success: boolean,
  latencyMs: number
): void {
  if (!metrics.intentBreakdown[intent]) {
    metrics.intentBreakdown[intent] = {
      count: 0,
      successRate: 1,
      avgLatency: 0,
    };
  }

  const breakdown = metrics.intentBreakdown[intent];
  const oldCount = breakdown.count;

  breakdown.count++;

  // Update success rate (rolling average)
  const successValue = success ? 1 : 0;
  breakdown.successRate =
    (breakdown.successRate * oldCount + successValue) / breakdown.count;

  // Update average latency
  breakdown.avgLatency =
    Math.round((breakdown.avgLatency * oldCount + latencyMs) / breakdown.count) || 0;
}

/**
 * Calculate P99 from samples
 */
function calculateP99(samples: number[]): number {
  if (samples.length === 0) return 0;

  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.floor(sorted.length * 0.99);
  const safeIndex = Math.min(index, sorted.length - 1);
  return sorted[safeIndex] ?? 0;
}

/**
 * Get metrics summary for display
 */
export function getMetricsSummary(): {
  localPercentage: number;
  deterministicPercentage: number;
  apiPercentage: number;
  fallbackRate: number;
  estimatedSavings: string;
} {
  const metrics = getRouterMetrics();

  const total = metrics.requestsTotal || 1;

  const localPercentage = Math.round((metrics.requestsLocal / total) * 100);
  const deterministicPercentage = Math.round(
    (metrics.requestsDeterministic / total) * 100
  );
  const apiPercentage = Math.round((metrics.requestsApi / total) * 100);

  const localAttempts = metrics.requestsLocal + metrics.localToApiFallbacks;
  const fallbackRate = localAttempts > 0
    ? Math.round((metrics.localToApiFallbacks / localAttempts) * 100 * 10) / 10
    : 0;

  // Rough cost estimate: $0.003 per 1K tokens for API
  const estimatedSavingsUsd = (metrics.tokensSavedVsApi / 1000) * 0.003;
  const estimatedSavings = `~$${estimatedSavingsUsd.toFixed(3)}`;

  return {
    localPercentage,
    deterministicPercentage,
    apiPercentage,
    fallbackRate,
    estimatedSavings,
  };
}

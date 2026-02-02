/**
 * Ollama Health Monitor
 *
 * Monitors Ollama availability and health, with periodic re-checks
 * when unavailable and memory pressure detection via latency.
 * Part of Fase 3.6a: Device Profiles + Smart Router
 */

import { EventEmitter } from 'events';
import { OllamaHealthStatus } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('device:ollama-health');

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_RECHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HEALTH_CHECK_TIMEOUT_MS = 3000; // 3 seconds
const LATENCY_PRESSURE_THRESHOLD = 3; // 3x baseline = memory pressure
const PRESSURE_CONSECUTIVE_THRESHOLD = 2; // Require 2 consecutive spikes to confirm pressure
const BASELINE_SAMPLE_SIZE = 5; // Use median of last N samples for baseline (sliding window)
const MIN_SAMPLES_FOR_BASELINE = 3; // Minimum samples before establishing baseline

type OllamaHealthEvent = 'available' | 'unavailable' | 'memoryPressure';

interface OllamaModelInfo {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaTagsResponse {
  models?: OllamaModelInfo[];
}

interface OllamaPsResponse {
  models?: Array<{
    name: string;
    model: string;
    size: number;
  }>;
}

export interface OllamaHealthMonitor {
  // State
  getStatus(): OllamaHealthStatus;
  isAvailable(): boolean;

  // Control
  start(): void;
  stop(): void;

  // Manual check
  checkHealth(): Promise<OllamaHealthStatus>;

  /**
   * Perform a health check and update internal state.
   * Use this instead of checkHealth() when you need the state to be updated.
   */
  checkAndUpdateHealth(): Promise<OllamaHealthStatus>;

  /**
   * Verify availability on-demand before critical routing decisions.
   * Returns cached status if checked recently (within staleness window),
   * otherwise performs a fresh check.
   * @param maxStalenessMs - Maximum age of cached status (default 30s)
   */
  verifyAvailable(maxStalenessMs?: number): Promise<boolean>;

  // Memory pressure
  checkMemoryPressure(currentLatency: number): Promise<boolean>;
  resetBaselineLatency(): void;

  // Events
  on(event: OllamaHealthEvent, callback: () => void): void;
  off(event: OllamaHealthEvent, callback: () => void): void;
}

const DEFAULT_MAX_STALENESS_MS = 30000; // 30 seconds for on-demand checks

class OllamaHealthMonitorImpl extends EventEmitter implements OllamaHealthMonitor {
  private status: OllamaHealthStatus = { available: false, modelsLoaded: [], modelsAvailable: [] };
  private checkInterval: NodeJS.Timeout | null = null;
  private recheckIntervalMs: number;
  private baselineLatency: number | null = null;
  private latencySamples: number[] = [];
  private consecutivePressureSpikes = 0; // Track consecutive spikes to avoid false positives
  private lastCheckTime = 0; // Timestamp of last health check (for staleness calculation)

  constructor(recheckIntervalMs: number = DEFAULT_RECHECK_INTERVAL_MS) {
    super();
    this.recheckIntervalMs = recheckIntervalMs;
  }

  getStatus(): OllamaHealthStatus {
    return { ...this.status };
  }

  isAvailable(): boolean {
    return this.status.available;
  }

  async checkHealth(): Promise<OllamaHealthStatus> {
    try {
      // Check available models
      const tagsResponse = await this.fetchWithTimeout(
        `${OLLAMA_BASE_URL}/api/tags`,
        HEALTH_CHECK_TIMEOUT_MS
      );

      if (!tagsResponse.ok) {
        this.lastCheckTime = Date.now();
        return {
          available: false,
          modelsLoaded: [],
          modelsAvailable: [],
          error: `HTTP ${tagsResponse.status}`,
        };
      }

      const tagsData = await tagsResponse.json() as OllamaTagsResponse;
      const modelsAvailable = tagsData.models?.map((m) => m.name) || [];

      // Check currently loaded models
      let modelsLoaded: string[] = [];
      try {
        const psResponse = await this.fetchWithTimeout(
          `${OLLAMA_BASE_URL}/api/ps`,
          HEALTH_CHECK_TIMEOUT_MS
        );
        if (psResponse.ok) {
          const psData = await psResponse.json() as OllamaPsResponse;
          modelsLoaded = psData.models?.map((m) => m.name) || [];
        }
      } catch {
        // ps endpoint might not be available on older versions
      }

      this.lastCheckTime = Date.now();
      return {
        available: true,
        modelsLoaded,
        modelsAvailable,
      };
    } catch (error) {
      this.lastCheckTime = Date.now();
      return {
        available: false,
        modelsLoaded: [],
        modelsAvailable: [],
        error: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  async checkAndUpdateHealth(): Promise<OllamaHealthStatus> {
    const health = await this.checkHealth();
    this.status = health;
    return health;
  }

  async verifyAvailable(maxStalenessMs: number = DEFAULT_MAX_STALENESS_MS): Promise<boolean> {
    const now = Date.now();
    const age = now - this.lastCheckTime;

    // If cached status is fresh enough, return it
    if (age < maxStalenessMs) {
      return this.status.available;
    }

    // Otherwise, perform fresh check
    logger.debug(`Health status stale (${age}ms old), performing fresh check`);
    await this.performCheck();
    return this.status.available;
  }

  private async fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  start(): void {
    // Initial check
    this.performCheck();

    // Periodic re-check
    this.checkInterval = setInterval(() => {
      // Always check to detect changes
      this.performCheck();
    }, this.recheckIntervalMs);

    logger.debug(`Ollama health monitor started (interval: ${this.recheckIntervalMs}ms)`);
  }

  private async performCheck(): Promise<void> {
    const wasAvailable = this.status.available;
    this.status = await this.checkHealth();

    // Emit events on state changes
    if (!wasAvailable && this.status.available) {
      logger.info('Ollama now available. Local LLM features enabled.');
      this.emit('available');
    } else if (wasAvailable && !this.status.available) {
      logger.warn(`Ollama no longer available: ${this.status.error}. Using API only.`);
      this.emit('unavailable');
    }
  }

  async checkMemoryPressure(currentLatency: number): Promise<boolean> {
    // Collect samples for baseline (sliding window)
    this.latencySamples.push(currentLatency);

    // Keep only last 10 samples
    if (this.latencySamples.length > 10) {
      this.latencySamples.shift();
    }

    // Need minimum samples to establish baseline
    if (this.latencySamples.length < MIN_SAMPLES_FOR_BASELINE) {
      return false;
    }

    // Calculate baseline as median of recent normal samples (sliding window approach)
    // This adapts as the system warms up, avoiding cold-start bias
    this.baselineLatency = this.calculateSlidingBaseline();

    if (this.baselineLatency === null) {
      return false;
    }

    // Check for pressure spike
    const ratio = currentLatency / this.baselineLatency;
    const isSpike = ratio > LATENCY_PRESSURE_THRESHOLD;

    if (isSpike) {
      this.consecutivePressureSpikes++;
      logger.debug(
        `Latency spike detected (${ratio.toFixed(1)}x baseline: ${currentLatency}ms vs ${this.baselineLatency}ms). ` +
        `Consecutive spikes: ${this.consecutivePressureSpikes}/${PRESSURE_CONSECUTIVE_THRESHOLD}`
      );

      // Only trigger memory pressure after consecutive spikes (avoids false positives from outliers)
      if (this.consecutivePressureSpikes >= PRESSURE_CONSECUTIVE_THRESHOLD) {
        logger.warn(
          `Memory pressure confirmed after ${this.consecutivePressureSpikes} consecutive spikes ` +
          `(latency ${ratio.toFixed(1)}x baseline: ${currentLatency}ms vs ${this.baselineLatency}ms)`
        );
        this.consecutivePressureSpikes = 0; // Reset after triggering
        this.emit('memoryPressure');
        return true;
      }
    } else {
      // Reset consecutive counter on normal latency
      if (this.consecutivePressureSpikes > 0) {
        logger.debug(`Latency normal, resetting consecutive spike counter`);
        this.consecutivePressureSpikes = 0;
      }
    }

    return false;
  }

  private calculateSlidingBaseline(): number | null {
    if (this.latencySamples.length < MIN_SAMPLES_FOR_BASELINE) {
      return null;
    }

    // Take the last N samples for baseline calculation
    const recentSamples = this.latencySamples.slice(-BASELINE_SAMPLE_SIZE);

    // Filter out extreme outliers (> 3 standard deviations) before calculating median
    const mean = recentSamples.reduce((a, b) => a + b, 0) / recentSamples.length;
    const stdDev = Math.sqrt(
      recentSamples.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / recentSamples.length
    );

    const filteredSamples = recentSamples.filter(
      (sample) => Math.abs(sample - mean) <= 3 * stdDev
    );

    // Use filtered samples if we have enough, otherwise use all
    const samplesToUse = filteredSamples.length >= MIN_SAMPLES_FOR_BASELINE
      ? filteredSamples
      : recentSamples;

    // Calculate median (more robust than mean for latency)
    const sorted = [...samplesToUse].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  }

  resetBaselineLatency(): void {
    this.baselineLatency = null;
    this.latencySamples = [];
    this.consecutivePressureSpikes = 0;
    logger.debug('Ollama baseline latency reset');
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.debug('Ollama health monitor stopped');
  }
}

// Singleton instance
let instance: OllamaHealthMonitorImpl | null = null;

/**
 * Get or create the Ollama health monitor singleton
 */
export function getOllamaHealthMonitor(
  recheckIntervalMs?: number
): OllamaHealthMonitor {
  if (!instance) {
    instance = new OllamaHealthMonitorImpl(recheckIntervalMs);
  }
  return instance;
}

/**
 * Initialize the Ollama health monitor and perform initial check
 * Returns the initial health status
 */
export async function initializeOllamaHealthMonitor(
  recheckIntervalMs?: number
): Promise<OllamaHealthStatus> {
  const monitor = getOllamaHealthMonitor(recheckIntervalMs);
  // Use checkAndUpdateHealth to ensure internal state is updated
  const health = await monitor.checkAndUpdateHealth();

  if (!health.available) {
    logger.warn('═══════════════════════════════════════════════════════════');
    logger.warn('  Ollama is not running. Local LLM features disabled.');
    logger.warn('  To enable: ollama serve');
    logger.warn('  All requests will go to API (with cost).');
    logger.warn(`  Re-checking every ${Math.round((recheckIntervalMs || DEFAULT_RECHECK_INTERVAL_MS) / 1000 / 60)} minutes...`);
    logger.warn('═══════════════════════════════════════════════════════════');
  } else if (health.modelsAvailable.length === 0) {
    logger.warn('Ollama is running but no models installed.');
    logger.warn('Install at least one: ollama pull qwen2.5:7b-instruct');
  } else {
    const loadedInfo = health.modelsLoaded.length > 0
      ? ` (${health.modelsLoaded.length} loaded in RAM)`
      : '';
    logger.info(
      `Ollama available with ${health.modelsAvailable.length} models${loadedInfo}`
    );
  }

  monitor.start();
  return health;
}

/**
 * Stop the Ollama health monitor
 */
export function stopOllamaHealthMonitor(): void {
  if (instance) {
    instance.stop();
  }
}

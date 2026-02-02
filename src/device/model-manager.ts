/**
 * Model Manager
 *
 * Manages Ollama model lifecycle: loading, unloading, hot-swap,
 * and request locking to prevent swap during active requests.
 * Part of Fase 3.6a: Device Profiles + Smart Router
 */

import { createLogger } from '../utils/logger.js';
import { getOllamaHealthMonitor } from './ollama-health.js';
import { DeviceProfile, ModelInfo, MemoryUsage } from './types.js';
import { estimateModelRam } from './tiers.js';

const logger = createLogger('device:model-manager');

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const WARMUP_TIMEOUT_MS = 60000; // 60 seconds for initial model load
const UNLOAD_TIMEOUT_MS = 10000; // 10 seconds for unload

export interface ModelManager {
  // State
  getLoadedModels(): Promise<string[]>;
  isModelLoaded(model: string): Promise<boolean>;
  isModelAvailable(model: string): Promise<boolean>;

  // Operations
  preloadClassifier(): Promise<void>;
  ensureLoaded(model: string): Promise<void>;
  unload(model: string): Promise<void>;
  unloadNonEssential(): Promise<void>;

  /**
   * Schedule background preload of a model after a delay.
   * Non-blocking - returns immediately.
   * @param model - Model to preload
   * @param delayMs - Delay before starting preload (default 10s)
   */
  scheduleBackgroundPreload(model: string, delayMs?: number): void;

  /**
   * Check if a model needs loading (not currently in RAM).
   * Use this to show "loading" UX before calling ensureLoaded.
   */
  needsLoading(model: string): Promise<boolean>;

  // Request lock
  acquireLock(model: string): () => void;
  hasActiveLocks(): boolean;

  // Info
  getModelInfo(model: string): ModelInfo;
  getMemoryUsage(): Promise<MemoryUsage>;
}

class ModelManagerImpl implements ModelManager {
  private locks = new Map<string, number>(); // model -> active request count
  private loadingInProgress = new Map<string, Promise<void>>(); // model -> loading promise (prevents race condition)
  private classifierModel: string;
  private backgroundPreloadTimer: NodeJS.Timeout | null = null;

  constructor(profile: DeviceProfile) {
    this.classifierModel = profile.classifierModel;
  }

  // ═══════════════════════════════════════════════════════════════════
  // STATE QUERIES
  // ═══════════════════════════════════════════════════════════════════

  async getLoadedModels(): Promise<string[]> {
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/ps`);
      if (!response.ok) return [];

      const data = await response.json() as { models?: Array<{ name: string }> };
      return data.models?.map((m) => m.name) || [];
    } catch {
      return [];
    }
  }

  async isModelLoaded(model: string): Promise<boolean> {
    const loaded = await this.getLoadedModels();
    return loaded.some((m) => this.normalizeModelName(m) === this.normalizeModelName(model));
  }

  async isModelAvailable(model: string): Promise<boolean> {
    const monitor = getOllamaHealthMonitor();
    const status = monitor.getStatus();
    return status.modelsAvailable.some(
      (m) => this.normalizeModelName(m) === this.normalizeModelName(model)
    );
  }

  private normalizeModelName(name: string): string {
    // Normalize model names for comparison
    // e.g., "qwen2.5:7b-instruct" === "qwen2.5:7b-instruct"
    // but also handle cases like "qwen2.5:latest" vs "qwen2.5"
    return name.toLowerCase().replace(':latest', '');
  }

  // ═══════════════════════════════════════════════════════════════════
  // OPERATIONS
  // ═══════════════════════════════════════════════════════════════════

  async preloadClassifier(): Promise<void> {
    if (this.classifierModel === 'none') {
      logger.debug('Classifier model is "none", skipping preload');
      return;
    }

    const available = await this.isModelAvailable(this.classifierModel);
    if (!available) {
      logger.warn(
        `Classifier model ${this.classifierModel} not installed. ` +
        `Install with: ollama pull ${this.classifierModel}`
      );
      return;
    }

    logger.debug(`Preloading classifier model: ${this.classifierModel}`);
    await this.warmup(this.classifierModel);
    logger.info(`Classifier model ${this.classifierModel} loaded`);
  }

  scheduleBackgroundPreload(model: string, delayMs: number = 10000): void {
    // Cancel any existing scheduled preload
    if (this.backgroundPreloadTimer) {
      clearTimeout(this.backgroundPreloadTimer);
    }

    logger.debug(`Scheduling background preload of ${model} in ${delayMs}ms`);

    this.backgroundPreloadTimer = setTimeout(async () => {
      try {
        // Check if model is already loaded
        if (await this.isModelLoaded(model)) {
          logger.debug(`Background preload skipped: ${model} already loaded`);
          return;
        }

        // Check if model is available
        if (!(await this.isModelAvailable(model))) {
          logger.debug(`Background preload skipped: ${model} not installed`);
          return;
        }

        logger.info(`Background preloading ${model}...`);
        await this.warmup(model);
        logger.info(`Background preload complete: ${model}`);
      } catch (error) {
        logger.warn(`Background preload failed for ${model}:`, error);
      }
    }, delayMs);
  }

  async needsLoading(model: string): Promise<boolean> {
    return !(await this.isModelLoaded(model));
  }

  async ensureLoaded(model: string): Promise<void> {
    const normalizedModel = this.normalizeModelName(model);

    // Check if already loaded
    if (await this.isModelLoaded(model)) {
      return;
    }

    // Check if load is already in progress (prevents race condition)
    const existingLoad = this.loadingInProgress.get(normalizedModel);
    if (existingLoad) {
      logger.debug(`Waiting for existing load of ${model}`);
      return existingLoad;
    }

    // Create loading promise to coordinate concurrent requests
    const loadPromise = this.performLoad(model);
    this.loadingInProgress.set(normalizedModel, loadPromise);

    try {
      await loadPromise;
    } finally {
      this.loadingInProgress.delete(normalizedModel);
    }
  }

  private async performLoad(model: string): Promise<void> {
    // Check if model is available
    if (!(await this.isModelAvailable(model))) {
      throw new Error(
        `Model ${model} not installed. Install with: ollama pull ${model}`
      );
    }

    // Check RAM availability and unload if needed
    const memUsage = await this.getMemoryUsage();
    const modelInfo = this.getModelInfo(model);

    if (memUsage.available < modelInfo.ramRequired) {
      // Unload models that are not the classifier AND don't have active requests
      const toUnload = memUsage.modelsLoaded
        .filter((m) => !this.isClassifier(m.name))
        .filter((m) => !this.locks.has(m.name))
        .sort((a, b) => b.ram - a.ram); // Largest first

      for (const m of toUnload) {
        logger.debug(`Unloading ${m.name} to make room for ${model}`);
        await this.unload(m.name);

        const newUsage = await this.getMemoryUsage();
        if (newUsage.available >= modelInfo.ramRequired) break;
      }
    }

    // Load the model
    await this.warmup(model);
    logger.info(`Model ${model} loaded`);
  }

  private isClassifier(modelName: string): boolean {
    return this.normalizeModelName(modelName) === this.normalizeModelName(this.classifierModel);
  }

  private async warmup(model: string): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);

    try {
      // Send a minimal request to trigger model loading
      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: 'Hi',
          stream: false,
          options: {
            num_predict: 1, // Minimal generation
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to load model: ${text}`);
      }

      // Wait for response to ensure model is loaded
      await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async unload(model: string): Promise<void> {
    // Check for active locks
    if (this.locks.has(model)) {
      logger.warn(`Cannot unload ${model}: ${this.locks.get(model)} active requests`);
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UNLOAD_TIMEOUT_MS);

    try {
      // Use keep_alive: 0 to unload immediately
      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: '',
          keep_alive: 0, // Unload immediately
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn(`Failed to unload ${model}: HTTP ${response.status}`);
      } else {
        logger.debug(`Model ${model} unloaded`);
      }
    } catch (error) {
      logger.warn(`Error unloading ${model}:`, error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async unloadNonEssential(): Promise<void> {
    const loaded = await this.getLoadedModels();

    for (const model of loaded) {
      if (!this.isClassifier(model) && !this.locks.has(model)) {
        await this.unload(model);
      }
    }

    logger.info('Non-essential models unloaded due to memory pressure');
  }

  // ═══════════════════════════════════════════════════════════════════
  // REQUEST LOCKING
  // ═══════════════════════════════════════════════════════════════════

  acquireLock(model: string): () => void {
    const current = this.locks.get(model) || 0;
    this.locks.set(model, current + 1);
    logger.debug(`Lock acquired for ${model} (count: ${current + 1})`);

    // Return release function
    return () => {
      const count = this.locks.get(model) || 1;
      if (count <= 1) {
        this.locks.delete(model);
        logger.debug(`Lock released for ${model} (count: 0)`);
      } else {
        this.locks.set(model, count - 1);
        logger.debug(`Lock released for ${model} (count: ${count - 1})`);
      }
    };
  }

  hasActiveLocks(): boolean {
    return this.locks.size > 0;
  }

  // ═══════════════════════════════════════════════════════════════════
  // INFO
  // ═══════════════════════════════════════════════════════════════════

  getModelInfo(model: string): ModelInfo {
    // Parse model name for size info
    const match = model.match(/(\d+)b/i);
    const sizeStr = match ? `${match[1]}b` : 'unknown';

    return {
      name: model,
      size: sizeStr,
      quantization: 'q4_0', // Assume Q4 for estimates
      ramRequired: estimateModelRam(model),
    };
  }

  async getMemoryUsage(): Promise<MemoryUsage> {
    const os = await import('os');
    const totalMem = os.totalmem() / (1024 * 1024 * 1024);
    const freeMem = os.freemem() / (1024 * 1024 * 1024);

    const loaded = await this.getLoadedModels();
    const modelsLoaded = loaded.map((name) => ({
      name,
      ram: estimateModelRam(name),
    }));

    const modelsRam = modelsLoaded.reduce((sum, m) => sum + m.ram, 0);

    return {
      total: Math.round(totalMem * 10) / 10,
      used: Math.round((totalMem - freeMem) * 10) / 10,
      available: Math.round((freeMem - modelsRam) * 10) / 10, // Subtract loaded models
      modelsLoaded,
    };
  }
}

// Singleton instance
let instance: ModelManagerImpl | null = null;

/**
 * Get or create the model manager singleton
 */
export function getModelManager(): ModelManager {
  if (!instance) {
    throw new Error('ModelManager not initialized. Call initializeModelManager first.');
  }
  return instance;
}

/**
 * Initialize the model manager with a device profile
 */
export function initializeModelManager(profile: DeviceProfile): ModelManager {
  instance = new ModelManagerImpl(profile);
  return instance;
}

/**
 * Check if model manager is initialized
 */
export function isModelManagerInitialized(): boolean {
  return instance !== null;
}

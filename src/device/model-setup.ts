/**
 * Model Setup - Fase 3.6b
 *
 * Handles automatic model installation and setup.
 * Ensures essential models are available on first run.
 */

import { createLogger } from '../utils/logger.js';
import { getSystemStateJson, setSystemStateJson } from '../memory/store.js';
import { DeviceTier } from './types.js';

const logger = createLogger('model-setup');

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const PULL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for large models
const SETUP_STATE_KEY = 'model_setup_state';

/**
 * Essential models by tier.
 * These will be auto-pulled on first run if not present.
 */
const ESSENTIAL_MODELS: Record<DeviceTier, string[]> = {
  minimal: [], // No local models needed
  basic: ['qwen2.5:3b-instruct'], // Classifier only
  standard: ['qwen2.5:3b-instruct', 'qwen2.5:7b-instruct'], // Classifier + productivity
  power: ['qwen2.5:3b-instruct', 'qwen2.5:7b-instruct', 'gemma2:9b'], // Full set
  server: ['qwen2.5:3b-instruct', 'qwen2.5:7b-instruct', 'gemma2:9b', 'mistral:7b-instruct'],
};

/**
 * Model sizes for progress estimation (in GB)
 */
const MODEL_SIZES: Record<string, number> = {
  'qwen2.5:3b-instruct': 2.0,
  'qwen2.5:7b-instruct': 4.7,
  'gemma2:9b': 5.4,
  'mistral:7b-instruct': 4.1,
};

interface SetupState {
  setupCompleted: boolean;
  modelsInstalled: string[];
  lastSetupAt: string;
  tier: DeviceTier;
}

interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/**
 * Check if setup has been completed for this tier
 */
function getSetupState(): SetupState | null {
  return getSystemStateJson<SetupState>(SETUP_STATE_KEY);
}

/**
 * Save setup state
 */
function saveSetupState(state: SetupState): void {
  setSystemStateJson(SETUP_STATE_KEY, state);
}

/**
 * Check which models are installed
 */
async function getInstalledModels(): Promise<string[]> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) return [];

    const data = await response.json() as { models?: Array<{ name: string }> };
    return data.models?.map((m) => m.name) || [];
  } catch {
    return [];
  }
}

/**
 * Check if a specific model is installed
 */
function isModelInstalled(modelName: string, installedModels: string[]): boolean {
  const normalized = modelName.toLowerCase().replace(':latest', '');

  return installedModels.some((m) => {
    const installedNorm = m.toLowerCase().replace(':latest', '');

    // Exact match
    if (installedNorm === normalized) return true;

    // Handle cases like "qwen2.5:7b-instruct" matching "qwen2.5:7b"
    // But NOT "qwen2.5:3b-instruct" matching "qwen2.5:7b-instruct"
    const [installedBase, installedTag] = installedNorm.split(':');
    const [wantedBase, wantedTag] = normalized.split(':');

    // Base must match exactly
    if (installedBase !== wantedBase) return false;

    // If no tag specified in wanted, any tag of that base is fine
    if (!wantedTag) return true;

    // Tags must start the same (e.g., "7b-instruct" matches "7b")
    if (installedTag && wantedTag) {
      return installedTag.startsWith(wantedTag) || wantedTag.startsWith(installedTag);
    }

    return false;
  });
}

/**
 * Pull a model with progress callback
 */
async function pullModel(
  modelName: string,
  onProgress?: (progress: { percent: number; status: string }) => void
): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.error(`Failed to pull ${modelName}: HTTP ${response.status}`);
      return false;
    }

    // Stream progress
    const reader = response.body?.getReader();
    if (!reader) {
      logger.error(`No response body for pull ${modelName}`);
      return false;
    }

    const decoder = new TextDecoder();
    let lastPercent = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n').filter((l) => l.trim());

      for (const line of lines) {
        try {
          const progress = JSON.parse(line) as PullProgress;

          if (progress.status === 'success') {
            onProgress?.({ percent: 100, status: 'Completado' });
            return true;
          }

          if (progress.total && progress.completed) {
            const percent = Math.round((progress.completed / progress.total) * 100);
            if (percent > lastPercent) {
              lastPercent = percent;
              onProgress?.({
                percent,
                status: progress.status || 'Descargando',
              });
            }
          } else if (progress.status) {
            onProgress?.({ percent: lastPercent, status: progress.status });
          }
        } catch {
          // Ignore malformed JSON lines
        }
      }
    }

    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.error(`Pull timeout for ${modelName}`);
    } else {
      logger.error(`Failed to pull ${modelName}:`, error);
    }
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Format model size for display
 */
function formatSize(sizeGb: number): string {
  return `${sizeGb.toFixed(1)}GB`;
}

/**
 * Calculate total size of models to download
 */
function calculateTotalSize(models: string[]): number {
  return models.reduce((sum, m) => sum + (MODEL_SIZES[m] || 4), 0);
}

export interface SetupResult {
  success: boolean;
  modelsInstalled: string[];
  modelsFailed: string[];
  skipped: boolean;
  message: string;
}

/**
 * Ensure essential models are installed.
 *
 * On first run (or when tier changes), prompts user and auto-pulls
 * essential models for their device tier.
 *
 * @param tier - Device tier
 * @param skipPrompt - Skip user prompt and auto-install (for CI/testing)
 * @param onProgress - Progress callback for UI updates
 * @returns Setup result
 */
export async function ensureModelsInstalled(
  tier: DeviceTier,
  skipPrompt: boolean = false,
  onProgress?: (model: string, progress: { percent: number; status: string }) => void
): Promise<SetupResult> {
  // Check if Ollama is available
  const installedModels = await getInstalledModels();

  if (installedModels.length === 0) {
    // Can't reach Ollama or it has no models at all
    try {
      await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    } catch {
      return {
        success: false,
        modelsInstalled: [],
        modelsFailed: [],
        skipped: true,
        message: 'Ollama no está corriendo. Iniciá con: ollama serve',
      };
    }
  }

  // Get essential models for this tier
  const essential = ESSENTIAL_MODELS[tier];
  if (essential.length === 0) {
    return {
      success: true,
      modelsInstalled: [],
      modelsFailed: [],
      skipped: true,
      message: 'Tier minimal no requiere modelos locales',
    };
  }

  // Check which are missing
  const missing = essential.filter((m) => !isModelInstalled(m, installedModels));

  if (missing.length === 0) {
    // All models already installed
    const state: SetupState = {
      setupCompleted: true,
      modelsInstalled: essential,
      lastSetupAt: new Date().toISOString(),
      tier,
    };
    saveSetupState(state);

    return {
      success: true,
      modelsInstalled: essential,
      modelsFailed: [],
      skipped: true,
      message: 'Todos los modelos ya están instalados',
    };
  }

  // Check if we've already completed setup for this tier
  const previousState = getSetupState();
  if (previousState?.setupCompleted && previousState.tier === tier) {
    // Setup was completed but models are missing - user may have deleted them
    // Don't auto-reinstall, just warn
    logger.warn(`Missing models: ${missing.join(', ')}. Reinstall with: ollama pull <model>`);
    return {
      success: false,
      modelsInstalled: essential.filter((m) => isModelInstalled(m, installedModels)),
      modelsFailed: missing,
      skipped: true,
      message: `Faltan modelos: ${missing.join(', ')}`,
    };
  }

  // First-time setup - need to install models
  const totalSize = calculateTotalSize(missing);

  if (!skipPrompt) {
    // Show what we're about to download
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║            Primera configuración de modelos               ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  Tier: ${tier.padEnd(52)}║`);
    console.log(`║  Modelos a descargar: ${missing.length.toString().padEnd(37)}║`);
    console.log(`║  Tamaño total: ~${formatSize(totalSize).padEnd(43)}║`);
    console.log('╠═══════════════════════════════════════════════════════════╣');
    for (const model of missing) {
      const size = MODEL_SIZES[model] || 4;
      console.log(`║  • ${model.padEnd(35)} (~${formatSize(size).padEnd(10)})║`);
    }
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log('Descargando modelos... (esto solo ocurre una vez)\n');
  }

  // Pull each model
  const installed: string[] = [];
  const failed: string[] = [];
  const totalModels = missing.length;

  for (const [index, model] of missing.entries()) {
    const modelNum = index + 1;

    console.log(`[${modelNum}/${totalModels}] Descargando ${model}...`);

    const success = await pullModel(model, (progress) => {
      // Update progress in place
      process.stdout.write(`\r  ${progress.status}: ${progress.percent}%    `);
      onProgress?.(model, progress);
    });

    console.log(''); // New line after progress

    if (success) {
      installed.push(model);
      console.log(`✓ ${model} instalado\n`);
    } else {
      failed.push(model);
      console.log(`✗ ${model} falló\n`);
    }
  }

  // Save state
  const state: SetupState = {
    setupCompleted: failed.length === 0,
    modelsInstalled: [...essential.filter((m) => isModelInstalled(m, installedModels)), ...installed],
    lastSetupAt: new Date().toISOString(),
    tier,
  };
  saveSetupState(state);

  // Summary
  if (failed.length === 0) {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║  ✓ Todos los modelos instalados correctamente            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
  } else {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log(`║  ⚠ ${installed.length} modelos instalados, ${failed.length} fallaron                      ║`);
    console.log('╠═══════════════════════════════════════════════════════════╣');
    for (const model of failed) {
      console.log(`║  Reinstalar manualmente: ollama pull ${model.substring(0, 20).padEnd(20)}║`);
    }
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
  }

  return {
    success: failed.length === 0,
    modelsInstalled: state.modelsInstalled,
    modelsFailed: failed,
    skipped: false,
    message: failed.length === 0
      ? `${installed.length} modelos instalados`
      : `${installed.length} instalados, ${failed.length} fallaron`,
  };
}

/**
 * Reset setup state (for testing or to force re-setup)
 */
export function resetSetupState(): void {
  setSystemStateJson(SETUP_STATE_KEY, null);
  logger.info('Model setup state reset');
}

/**
 * Get list of essential models for a tier
 */
export function getEssentialModels(tier: DeviceTier): string[] {
  return [...ESSENTIAL_MODELS[tier]];
}

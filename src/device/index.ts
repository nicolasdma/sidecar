/**
 * Device Module - Fase 3.6a
 *
 * Main entry point for device detection, profiling, and management.
 * Exports all device-related functionality.
 */

import { createLogger } from '../utils/logger.js';
import { detectCapabilities, formatCapabilities, isDiskSpaceLow, isDiskSpaceWarning } from './capabilities.js';
import { assignTier, getProfileWithOverrides, getTierDescription } from './tiers.js';
import { initializeOllamaHealthMonitor, stopOllamaHealthMonitor, getOllamaHealthMonitor } from './ollama-health.js';
import { initializeModelManager, getModelManager, isModelManagerInitialized } from './model-manager.js';
import { recordOllamaReconnect, recordMemoryPressureEvent, flushMetrics, getRouterMetrics, getMetricsSummary } from './metrics.js';
import { ensureModelsInstalled } from './model-setup.js';
import type { DeviceCapabilities, DeviceProfile, DeviceTier, DeviceConfig, OllamaHealthStatus } from './types.js';

const logger = createLogger('device');

// Re-export types
export type {
  DeviceCapabilities,
  DeviceProfile,
  DeviceTier,
  DeviceConfig,
  OllamaHealthStatus,
  RouterMetrics,
  RouteDecision,
  ModelInfo,
  MemoryUsage,
} from './types.js';

// Re-export functions
export {
  detectCapabilities,
  formatCapabilities,
  isDiskSpaceLow,
  isDiskSpaceWarning,
} from './capabilities.js';

export {
  assignTier,
  getProfile,
  getProfileWithOverrides,
  getTierDescription,
  estimateModelRam,
  isModelCompatible,
} from './tiers.js';

export {
  getOllamaHealthMonitor,
  initializeOllamaHealthMonitor,
  stopOllamaHealthMonitor,
} from './ollama-health.js';

export {
  getModelManager,
  initializeModelManager,
  isModelManagerInitialized,
} from './model-manager.js';

export {
  ensureModelsInstalled,
  getEssentialModels,
  resetSetupState,
} from './model-setup.js';

export {
  recordDeterministicRequest,
  recordLocalRequest,
  recordApiRequest,
  recordLocalToApiFallback,
  recordModelLoad,
  recordOllamaReconnect,
  recordMemoryPressureEvent,
  getRouterMetrics,
  getMetricsSummary,
  resetRouterMetrics,
  flushMetrics,
} from './metrics.js';

/**
 * Current device state
 */
let currentCapabilities: DeviceCapabilities | null = null;
let currentProfile: DeviceProfile | null = null;

/**
 * Get current device capabilities
 */
export function getDeviceCapabilities(): DeviceCapabilities | null {
  return currentCapabilities;
}

/**
 * Get current device profile
 */
export function getDeviceProfile(): DeviceProfile | null {
  return currentProfile;
}

/**
 * Initialize the device module
 *
 * This should be called early in startup to:
 * 1. Detect device capabilities
 * 2. Assign tier based on capabilities
 * 3. Initialize Ollama health monitor
 * 4. Initialize model manager
 *
 * @param config - Optional configuration overrides
 * @returns The device profile
 */
export async function initializeDevice(config?: DeviceConfig): Promise<{
  capabilities: DeviceCapabilities;
  profile: DeviceProfile;
  ollamaHealth: OllamaHealthStatus;
}> {
  logger.info('Initializing device module...');

  // 1. Detect capabilities
  currentCapabilities = detectCapabilities();
  logger.info(`Device: ${formatCapabilities(currentCapabilities)}`);

  // 2. Assign tier (with optional override)
  let tier: DeviceTier;
  if (config?.tierOverride) {
    tier = config.tierOverride;
    logger.info(`Tier override: ${tier}`);
  } else {
    tier = assignTier(currentCapabilities);
  }

  // 3. Get profile
  currentProfile = getProfileWithOverrides(tier, config);
  logger.info(`Tier: ${tier} (${getTierDescription(tier)})`);

  // 4. Initialize Ollama health monitor
  const recheckInterval = config?.ollamaRecheckIntervalMs;
  const ollamaHealth = await initializeOllamaHealthMonitor(recheckInterval);

  // 5. Set up health monitor callbacks
  const monitor = getOllamaHealthMonitor();

  monitor.on('available', () => {
    recordOllamaReconnect();
    // Re-preload classifier if we have a model manager
    if (isModelManagerInitialized()) {
      getModelManager().preloadClassifier().catch((error) => {
        logger.warn('Failed to preload classifier after reconnect:', error);
      });
    }
  });

  monitor.on('memoryPressure', () => {
    recordMemoryPressureEvent();
    // Unload non-essential models
    if (isModelManagerInitialized()) {
      getModelManager().unloadNonEssential().catch((error) => {
        logger.warn('Failed to unload models on memory pressure:', error);
      });
    }
  });

  // 6. Auto-install essential models (first run only)
  if (ollamaHealth.available && currentProfile.tier !== 'minimal') {
    const setupResult = await ensureModelsInstalled(
      currentProfile.tier,
      config?.skipModelSetup ?? false
    );

    if (!setupResult.success && !setupResult.skipped) {
      logger.warn('Model setup incomplete', {
        installed: setupResult.modelsInstalled,
        failed: setupResult.modelsFailed,
      });
    }
  }

  // 7. Initialize model manager (only if Ollama available and not minimal tier)
  if (ollamaHealth.available && currentProfile.tier !== 'minimal') {
    initializeModelManager(currentProfile);

    // Preload classifier if available (mitigates cold start for classification)
    if (currentProfile.classifierModel !== 'none') {
      try {
        await getModelManager().preloadClassifier();
      } catch (error) {
        logger.warn('Failed to preload classifier:', error);
      }
    }

    // OPTIMIZATION: Schedule background preload of productivity model
    // Reduced from 15s to 3s since classifier warmup is now non-blocking
    if (currentProfile.tier !== 'basic') {
      const primaryModel = currentProfile.recommendedModels[0];
      if (primaryModel) {
        getModelManager().scheduleBackgroundPreload(primaryModel, 3000);
      }
    }
  }

  // 8. Log summary
  logDeviceSummary(currentCapabilities, currentProfile, ollamaHealth);

  return {
    capabilities: currentCapabilities,
    profile: currentProfile,
    ollamaHealth,
  };
}

/**
 * Log device summary at startup
 */
function logDeviceSummary(
  capabilities: DeviceCapabilities,
  profile: DeviceProfile,
  ollamaHealth: OllamaHealthStatus
): void {
  const lines = [
    '═══════════════════════════════════════════════════════════',
    '  Device Profile',
    '═══════════════════════════════════════════════════════════',
    `  Tier:        ${profile.tier} (${getTierDescription(profile.tier)})`,
    `  RAM:         ${capabilities.ram}GB total, ${capabilities.ramAvailable}GB available`,
    `  CPU:         ${capabilities.cpu} (${capabilities.cores} cores)`,
    `  Accelerator: ${capabilities.accelerator}`,
    `  Disk:        ${capabilities.diskFree}GB free`,
  ];

  if (isDiskSpaceLow(capabilities)) {
    lines.push(`  ⚠️  Disk space critically low!`);
  } else if (isDiskSpaceWarning(capabilities)) {
    lines.push(`  ⚠️  Disk space low`);
  }

  lines.push('───────────────────────────────────────────────────────────');

  if (ollamaHealth.available) {
    lines.push(`  Ollama:      Available (${ollamaHealth.modelsAvailable.length} models installed)`);
    if (ollamaHealth.modelsLoaded.length > 0) {
      lines.push(`  Loaded:      ${ollamaHealth.modelsLoaded.join(', ')}`);
    }
    lines.push(`  Classifier:  ${profile.classifierModel}`);
    if (profile.recommendedModels.length > 0) {
      lines.push(`  Recommended: ${profile.recommendedModels.slice(0, 3).join(', ')}`);
    }
  } else {
    lines.push(`  Ollama:      Not available (${ollamaHealth.error || 'not running'})`);
    lines.push(`  Mode:        API only (with cost)`);
  }

  lines.push('═══════════════════════════════════════════════════════════');

  // Log as single block
  logger.info('\n' + lines.join('\n'));
}

/**
 * Shutdown the device module
 */
export function shutdownDevice(): void {
  logger.info('Shutting down device module...');

  // Flush metrics
  flushMetrics();

  // Stop health monitor
  stopOllamaHealthMonitor();

  // Clear state
  currentCapabilities = null;
  currentProfile = null;

  logger.info('Device module shutdown complete');
}

/**
 * Get formatted device info for display
 */
export function getDeviceInfoDisplay(): string {
  if (!currentCapabilities || !currentProfile) {
    return 'Device module not initialized';
  }

  const monitor = getOllamaHealthMonitor();
  const status = monitor.getStatus();
  const metrics = getRouterMetrics();
  const summary = getMetricsSummary();

  const lines = [
    `Device: ${currentCapabilities.os} ${currentCapabilities.cpu}`,
    `Tier: ${currentProfile.tier} (${getTierDescription(currentProfile.tier)})`,
    `RAM: ${currentCapabilities.ram}GB (${currentCapabilities.ramAvailable}GB available)`,
    `Disk: ${currentCapabilities.diskFree}GB free`,
    `Ollama: ${status.available ? 'Available' : 'Not available'}`,
    '',
    `Requests (total): ${metrics.requestsTotal}`,
    `  Deterministic: ${metrics.requestsDeterministic} (${summary.deterministicPercentage}%)`,
    `  Local LLM:     ${metrics.requestsLocal} (${summary.localPercentage}%)`,
    `  API:           ${metrics.requestsApi} (${summary.apiPercentage}%)`,
    '',
    `Fallback rate: ${summary.fallbackRate}%`,
    `Est. savings:  ${summary.estimatedSavings}`,
    '',
    `Health:`,
    `  Reconnects:        ${metrics.ollamaReconnects}`,
    `  Memory pressure:   ${metrics.memoryPressureEvents}`,
  ];

  return lines.join('\n');
}

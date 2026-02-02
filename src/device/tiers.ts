/**
 * Device Tiers
 *
 * Defines device tiers and profiles based on hardware capabilities.
 * Part of Fase 3.6a: Device Profiles + Smart Router
 *
 * Tier Summary:
 * - minimal (<4GB RAM): API only, no local LLM
 * - basic (4-8GB RAM): 3B models, 1 concurrent
 * - standard (8-16GB RAM): 7B models, 1 concurrent
 * - power (16-32GB RAM): 13B models, 2 concurrent
 * - server (32GB+ RAM): 70B models, 3+ concurrent
 */

import { DeviceCapabilities, DeviceTier, DeviceProfile, DeviceConfig } from './types.js';
import { createLogger } from '../utils/logger.js';
import { isDiskSpaceLow, isDiskSpaceWarning } from './capabilities.js';

const logger = createLogger('device:tiers');

/**
 * Profile definitions for each tier
 */
/**
 * Simplified model strategy (Fase 3.6b):
 * - basic: Single 3b model for everything
 * - standard: Single 7b model for everything
 * - power: 7b for classification, 9b for productivity (2 models total)
 * - server: Same as power + mistral for variety
 *
 * This reduces disk usage and cold start times.
 */
const TIER_PROFILES: Record<DeviceTier, DeviceProfile> = {
  minimal: {
    tier: 'minimal',
    maxModelSize: '1b',
    concurrentModels: 0,
    recommendedModels: [],
    embeddingsLocal: false,
    classifierModel: 'none', // API only
  },
  basic: {
    tier: 'basic',
    maxModelSize: '3b',
    concurrentModels: 1,
    recommendedModels: ['qwen2.5:3b-instruct'],
    embeddingsLocal: true,
    classifierModel: 'qwen2.5:3b-instruct', // Same model for classification + productivity
  },
  standard: {
    tier: 'standard',
    maxModelSize: '7b',
    concurrentModels: 1,
    recommendedModels: ['qwen2.5:7b-instruct'],
    embeddingsLocal: true,
    classifierModel: 'qwen2.5:7b-instruct', // Same model for classification + productivity
  },
  power: {
    tier: 'power',
    maxModelSize: '13b',
    concurrentModels: 2,
    recommendedModels: ['gemma2:9b', 'qwen2.5:7b-instruct'],
    embeddingsLocal: true,
    classifierModel: 'qwen2.5:7b-instruct', // 7b for classification, 9b for productivity
  },
  server: {
    tier: 'server',
    maxModelSize: '70b',
    concurrentModels: 3,
    recommendedModels: ['gemma2:9b', 'mistral:7b-instruct', 'qwen2.5:7b-instruct'],
    embeddingsLocal: true,
    classifierModel: 'qwen2.5:7b-instruct',
  },
};

/**
 * Assign a tier based on device capabilities
 */
export function assignTier(capabilities: DeviceCapabilities): DeviceTier {
  const { ram } = capabilities;

  // Warn about disk space
  if (isDiskSpaceLow(capabilities)) {
    logger.warn('Disk space critically low (<5GB). Local models may fail to load.');
  } else if (isDiskSpaceWarning(capabilities)) {
    logger.warn('Disk space low (<20GB). Consider freeing space for model downloads.');
  }

  // RAM is the primary factor
  if (ram < 4) return 'minimal';
  if (ram < 8) return 'basic';
  if (ram < 16) return 'standard';
  if (ram < 32) return 'power';
  return 'server';
}

/**
 * Get the profile for a given tier
 */
export function getProfile(tier: DeviceTier): DeviceProfile {
  const base = TIER_PROFILES[tier];
  return {
    ...base,
    recommendedModels: [...base.recommendedModels], // Deep copy array
  };
}

/**
 * Get profile with optional config overrides
 */
export function getProfileWithOverrides(
  tier: DeviceTier,
  config?: DeviceConfig
): DeviceProfile {
  const profile = getProfile(tier);

  if (!config) return profile;

  // Apply overrides
  if (config.preferredModels && config.preferredModels.length > 0) {
    profile.recommendedModels = config.preferredModels;
  }

  if (config.disableLocalLLM) {
    profile.recommendedModels = [];
    profile.concurrentModels = 0;
    profile.classifierModel = 'none';
  }

  return profile;
}

/**
 * Get tier description for display
 */
export function getTierDescription(tier: DeviceTier): string {
  const descriptions: Record<DeviceTier, string> = {
    minimal: 'API only (no local LLM)',
    basic: 'Local 3B models',
    standard: 'Local 7B models',
    power: 'Local 13B+ models',
    server: 'Local 70B models',
  };
  return descriptions[tier];
}

/**
 * Get RAM range for a tier
 */
export function getTierRamRange(tier: DeviceTier): string {
  const ranges: Record<DeviceTier, string> = {
    minimal: '<4GB',
    basic: '4-8GB',
    standard: '8-16GB',
    power: '16-32GB',
    server: '32GB+',
  };
  return ranges[tier];
}

/**
 * Estimate RAM required for a model size
 */
export function estimateModelRam(size: string): number {
  // Rough estimates for Q4 quantized models
  const estimates: Record<string, number> = {
    '1b': 1,
    '3b': 2,
    '7b': 5,
    '9b': 7,
    '13b': 9,
    '14b': 10,
    '70b': 45,
    '72b': 48,
  };

  // Extract number from size string (e.g., "7b" -> "7b", "qwen2.5:7b-instruct" -> "7b")
  const match = size.match(/(\d+)b/i);
  if (match && match[1]) {
    const sizeKey = `${match[1]}b`.toLowerCase();
    return estimates[sizeKey] || parseInt(match[1], 10);
  }

  return 5; // Default estimate
}

/**
 * Check if a model size is compatible with a tier
 */
export function isModelCompatible(modelSize: string, profile: DeviceProfile): boolean {
  const modelRam = estimateModelRam(modelSize);
  const maxRam = estimateModelRam(profile.maxModelSize);
  return modelRam <= maxRam;
}

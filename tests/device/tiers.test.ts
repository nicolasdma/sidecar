/**
 * Device Tiers Tests - Fase 3.6a
 *
 * Tests for tier assignment and profile logic.
 * No Ollama required - pure unit tests.
 */

import { describe, it, expect } from 'vitest';
import {
  assignTier,
  getProfile,
  getProfileWithOverrides,
  getTierDescription,
  estimateModelRam,
  isModelCompatible,
} from '../../src/device/tiers.js';
import { DeviceCapabilities } from '../../src/device/types.js';

// Helper to create mock capabilities
function mockCapabilities(overrides: Partial<DeviceCapabilities> = {}): DeviceCapabilities {
  return {
    ram: 16,
    ramAvailable: 12,
    cpu: 'arm64',
    accelerator: 'metal',
    cores: 8,
    diskFree: 100,
    os: 'darwin',
    ...overrides,
  };
}

describe('Device Tiers', () => {
  describe('assignTier', () => {
    it('assigns "minimal" tier for <4GB RAM', () => {
      expect(assignTier(mockCapabilities({ ram: 2 }))).toBe('minimal');
      expect(assignTier(mockCapabilities({ ram: 3.9 }))).toBe('minimal');
    });

    it('assigns "basic" tier for 4-8GB RAM', () => {
      expect(assignTier(mockCapabilities({ ram: 4 }))).toBe('basic');
      expect(assignTier(mockCapabilities({ ram: 6 }))).toBe('basic');
      expect(assignTier(mockCapabilities({ ram: 7.9 }))).toBe('basic');
    });

    it('assigns "standard" tier for 8-16GB RAM', () => {
      expect(assignTier(mockCapabilities({ ram: 8 }))).toBe('standard');
      expect(assignTier(mockCapabilities({ ram: 12 }))).toBe('standard');
      expect(assignTier(mockCapabilities({ ram: 15.9 }))).toBe('standard');
    });

    it('assigns "power" tier for 16-32GB RAM', () => {
      expect(assignTier(mockCapabilities({ ram: 16 }))).toBe('power');
      expect(assignTier(mockCapabilities({ ram: 24 }))).toBe('power');
      expect(assignTier(mockCapabilities({ ram: 31.9 }))).toBe('power');
    });

    it('assigns "server" tier for 32GB+ RAM', () => {
      expect(assignTier(mockCapabilities({ ram: 32 }))).toBe('server');
      expect(assignTier(mockCapabilities({ ram: 64 }))).toBe('server');
      expect(assignTier(mockCapabilities({ ram: 128 }))).toBe('server');
    });

    // Boundary tests
    it('handles exact boundary values correctly', () => {
      expect(assignTier(mockCapabilities({ ram: 4 }))).toBe('basic');
      expect(assignTier(mockCapabilities({ ram: 8 }))).toBe('standard');
      expect(assignTier(mockCapabilities({ ram: 16 }))).toBe('power');
      expect(assignTier(mockCapabilities({ ram: 32 }))).toBe('server');
    });
  });

  describe('getProfile', () => {
    it('returns correct profile for minimal tier', () => {
      const profile = getProfile('minimal');
      expect(profile.tier).toBe('minimal');
      expect(profile.maxModelSize).toBe('1b');
      expect(profile.concurrentModels).toBe(0);
      expect(profile.recommendedModels).toEqual([]);
      expect(profile.embeddingsLocal).toBe(false);
      expect(profile.classifierModel).toBe('none');
    });

    it('returns correct profile for basic tier', () => {
      const profile = getProfile('basic');
      expect(profile.tier).toBe('basic');
      expect(profile.maxModelSize).toBe('3b');
      expect(profile.concurrentModels).toBe(1);
      expect(profile.recommendedModels).toContain('qwen2.5:3b-instruct');
      expect(profile.embeddingsLocal).toBe(true);
    });

    it('returns correct profile for standard tier', () => {
      const profile = getProfile('standard');
      expect(profile.tier).toBe('standard');
      expect(profile.maxModelSize).toBe('7b');
      expect(profile.concurrentModels).toBe(1);
      expect(profile.recommendedModels).toContain('qwen2.5:7b-instruct');
    });

    it('returns correct profile for power tier', () => {
      const profile = getProfile('power');
      expect(profile.tier).toBe('power');
      expect(profile.maxModelSize).toBe('13b');
      expect(profile.concurrentModels).toBe(2);
    });

    it('returns correct profile for server tier', () => {
      const profile = getProfile('server');
      expect(profile.tier).toBe('server');
      expect(profile.maxModelSize).toBe('70b');
      expect(profile.concurrentModels).toBe(3);
    });

    it('returns a copy, not the original object', () => {
      const profile1 = getProfile('standard');
      const profile2 = getProfile('standard');
      profile1.recommendedModels.push('custom-model');
      expect(profile2.recommendedModels).not.toContain('custom-model');
    });
  });

  describe('getProfileWithOverrides', () => {
    it('returns base profile when no config provided', () => {
      const profile = getProfileWithOverrides('standard');
      expect(profile.recommendedModels).toContain('qwen2.5:7b-instruct');
    });

    it('applies preferredModels override', () => {
      const profile = getProfileWithOverrides('standard', {
        preferredModels: ['custom:7b', 'another:7b'],
      });
      expect(profile.recommendedModels).toEqual(['custom:7b', 'another:7b']);
    });

    it('disables local LLM when configured', () => {
      const profile = getProfileWithOverrides('power', {
        disableLocalLLM: true,
      });
      expect(profile.recommendedModels).toEqual([]);
      expect(profile.concurrentModels).toBe(0);
      expect(profile.classifierModel).toBe('none');
    });

    it('ignores empty preferredModels array', () => {
      const profile = getProfileWithOverrides('standard', {
        preferredModels: [],
      });
      expect(profile.recommendedModels).toContain('qwen2.5:7b-instruct');
    });
  });

  describe('getTierDescription', () => {
    it('returns correct descriptions', () => {
      expect(getTierDescription('minimal')).toBe('API only (no local LLM)');
      expect(getTierDescription('basic')).toBe('Local 3B models');
      expect(getTierDescription('standard')).toBe('Local 7B models');
      expect(getTierDescription('power')).toBe('Local 13B+ models');
      expect(getTierDescription('server')).toBe('Local 70B models');
    });
  });

  describe('estimateModelRam', () => {
    it('estimates RAM for standard sizes', () => {
      expect(estimateModelRam('3b')).toBe(2);
      expect(estimateModelRam('7b')).toBe(5);
      expect(estimateModelRam('13b')).toBe(9);
      expect(estimateModelRam('70b')).toBe(45);
    });

    it('extracts size from full model names', () => {
      expect(estimateModelRam('qwen2.5:7b-instruct')).toBe(5);
      expect(estimateModelRam('llama3:13b')).toBe(9);
      expect(estimateModelRam('mistral:7b-instruct-q4')).toBe(5);
    });

    it('returns default for unknown sizes', () => {
      expect(estimateModelRam('unknown-model')).toBe(5);
    });

    it('handles case insensitivity', () => {
      expect(estimateModelRam('7B')).toBe(5);
      expect(estimateModelRam('model:7B-INSTRUCT')).toBe(5);
    });
  });

  describe('isModelCompatible', () => {
    it('allows models within tier limit', () => {
      const standardProfile = getProfile('standard');
      expect(isModelCompatible('3b', standardProfile)).toBe(true);
      expect(isModelCompatible('7b', standardProfile)).toBe(true);
      expect(isModelCompatible('qwen2.5:7b-instruct', standardProfile)).toBe(true);
    });

    it('rejects models exceeding tier limit', () => {
      const standardProfile = getProfile('standard');
      expect(isModelCompatible('13b', standardProfile)).toBe(false);
      expect(isModelCompatible('70b', standardProfile)).toBe(false);
    });

    it('minimal tier rejects all models', () => {
      const minimalProfile = getProfile('minimal');
      expect(isModelCompatible('1b', minimalProfile)).toBe(true);
      expect(isModelCompatible('3b', minimalProfile)).toBe(false);
    });

    it('server tier accepts all models', () => {
      const serverProfile = getProfile('server');
      expect(isModelCompatible('7b', serverProfile)).toBe(true);
      expect(isModelCompatible('13b', serverProfile)).toBe(true);
      expect(isModelCompatible('70b', serverProfile)).toBe(true);
    });
  });
});

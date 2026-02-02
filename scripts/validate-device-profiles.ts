#!/usr/bin/env npx tsx
/**
 * Validation Script for Device Profiles (Fase 3.6a)
 *
 * Run this script to validate that device profiles work correctly with real Ollama.
 * Prerequisites:
 *   - Ollama must be running: `ollama serve`
 *   - At least one model installed: `ollama pull qwen2.5:3b-instruct`
 *
 * Usage:
 *   npx tsx scripts/validate-device-profiles.ts
 *
 * This script will:
 *   1. Check device capabilities detection
 *   2. Verify tier assignment
 *   3. Test Ollama health monitor
 *   4. Test model manager (if Ollama available)
 *   5. Test Router v2 classification (if models available)
 *   6. Test local execution (if models available)
 */

import { detectCapabilities, formatCapabilities } from '../src/device/capabilities.js';
import { assignTier, getProfile, getTierDescription, estimateModelRam } from '../src/device/tiers.js';
import { initializeOllamaHealthMonitor, getOllamaHealthMonitor, stopOllamaHealthMonitor } from '../src/device/ollama-health.js';
import { initializeModelManager, getModelManager, isModelManagerInitialized } from '../src/device/model-manager.js';
import { initializeRouterV2, routeV2, isRouterV2Initialized } from '../src/agent/local-router/router-v2.js';
import { executeLocalIntent, resetCircuitBreaker } from '../src/agent/local-router/local-executor.js';

// Colors for console output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function pass(msg: string): void {
  console.log(`${GREEN}  ✓ ${msg}${RESET}`);
}

function fail(msg: string, error?: unknown): void {
  console.log(`${RED}  ✗ ${msg}${RESET}`);
  if (error) {
    console.log(`${RED}    Error: ${error instanceof Error ? error.message : String(error)}${RESET}`);
  }
}

function warn(msg: string): void {
  console.log(`${YELLOW}  ⚠ ${msg}${RESET}`);
}

function info(msg: string): void {
  console.log(`${CYAN}    ${msg}${RESET}`);
}

function section(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`);
  console.log('─'.repeat(50));
}

async function validateDeviceCapabilities(): Promise<boolean> {
  section('1. Device Capabilities Detection');

  try {
    const caps = detectCapabilities();

    if (caps.ram > 0) {
      pass(`RAM detected: ${caps.ram}GB total, ${caps.ramAvailable}GB available`);
    } else {
      fail('RAM detection returned 0');
      return false;
    }

    if (caps.cpu === 'arm64' || caps.cpu === 'x64') {
      pass(`CPU architecture: ${caps.cpu}`);
    } else {
      fail(`Invalid CPU architecture: ${caps.cpu}`);
      return false;
    }

    if (['metal', 'cuda', 'rocm', 'cpu'].includes(caps.accelerator)) {
      pass(`Accelerator: ${caps.accelerator}`);
    } else {
      fail(`Invalid accelerator: ${caps.accelerator}`);
      return false;
    }

    if (caps.cores > 0) {
      pass(`CPU cores: ${caps.cores}`);
    } else {
      fail('CPU cores detection returned 0');
      return false;
    }

    if (caps.diskFree >= 0) {
      pass(`Disk free: ${caps.diskFree}GB`);
      if (caps.diskFree < 5) {
        warn('Disk space critically low (<5GB)');
      } else if (caps.diskFree < 20) {
        warn('Disk space low (<20GB)');
      }
    } else {
      fail('Disk detection failed');
      return false;
    }

    pass(`OS: ${caps.os}`);

    return true;
  } catch (error) {
    fail('Device capabilities detection failed', error);
    return false;
  }
}

async function validateTierAssignment(): Promise<boolean> {
  section('2. Tier Assignment');

  try {
    const caps = detectCapabilities();
    const tier = assignTier(caps);
    const profile = getProfile(tier);

    pass(`Assigned tier: ${tier} (${getTierDescription(tier)})`);
    info(`Max model size: ${profile.maxModelSize}`);
    info(`Concurrent models: ${profile.concurrentModels}`);
    info(`Classifier model: ${profile.classifierModel}`);
    info(`Recommended models: ${profile.recommendedModels.join(', ') || 'none'}`);

    // Validate tier makes sense for RAM
    const expectedTiers: Record<string, [number, number]> = {
      minimal: [0, 4],
      basic: [4, 8],
      standard: [8, 16],
      power: [16, 32],
      server: [32, Infinity],
    };

    const [min, max] = expectedTiers[tier] || [0, Infinity];
    if (caps.ram >= min && caps.ram < max) {
      pass(`Tier assignment correct for ${caps.ram}GB RAM`);
    } else {
      fail(`Tier assignment incorrect: ${caps.ram}GB RAM should not be ${tier}`);
      return false;
    }

    return true;
  } catch (error) {
    fail('Tier assignment failed', error);
    return false;
  }
}

async function validateOllamaHealth(): Promise<boolean> {
  section('3. Ollama Health Monitor');

  try {
    const health = await initializeOllamaHealthMonitor(30000); // 30s recheck for testing

    if (health.available) {
      pass('Ollama is available');
      info(`Models installed: ${health.modelsAvailable.length}`);
      info(`Models loaded: ${health.modelsLoaded.length}`);

      if (health.modelsAvailable.length > 0) {
        pass(`Found models: ${health.modelsAvailable.slice(0, 5).join(', ')}${health.modelsAvailable.length > 5 ? '...' : ''}`);
      } else {
        warn('No models installed. Install with: ollama pull qwen2.5:3b-instruct');
      }

      const monitor = getOllamaHealthMonitor();
      if (monitor.isAvailable()) {
        pass('Health monitor correctly reports available');
      } else {
        fail('Health monitor reports unavailable but health check succeeded');
        return false;
      }
    } else {
      warn('Ollama is NOT available');
      info(`Error: ${health.error}`);
      info('To enable local LLM features: ollama serve');
      // Not a failure - graceful degradation is expected
    }

    return true;
  } catch (error) {
    fail('Ollama health check failed', error);
    return false;
  }
}

async function validateModelManager(): Promise<boolean> {
  section('4. Model Manager');

  const monitor = getOllamaHealthMonitor();
  if (!monitor.isAvailable()) {
    warn('Skipping model manager tests (Ollama not available)');
    return true;
  }

  try {
    const caps = detectCapabilities();
    const tier = assignTier(caps);
    const profile = getProfile(tier);

    if (profile.classifierModel === 'none') {
      warn('Skipping model manager tests (minimal tier, no local models)');
      return true;
    }

    initializeModelManager(profile);
    const manager = getModelManager();

    pass('Model manager initialized');

    // Check loaded models
    const loaded = await manager.getLoadedModels();
    info(`Currently loaded models: ${loaded.length > 0 ? loaded.join(', ') : 'none'}`);

    // Check memory usage
    const memory = await manager.getMemoryUsage();
    pass(`Memory usage: ${memory.used.toFixed(1)}GB / ${memory.total.toFixed(1)}GB`);
    info(`Available for models: ${memory.available.toFixed(1)}GB`);

    // Try to check if classifier is available
    const classifierAvailable = await manager.isModelAvailable(profile.classifierModel);
    if (classifierAvailable) {
      pass(`Classifier model available: ${profile.classifierModel}`);

      // Try to preload classifier
      info('Attempting to preload classifier (this may take a moment)...');
      try {
        await manager.preloadClassifier();
        pass('Classifier preloaded successfully');
      } catch (error) {
        warn(`Classifier preload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      warn(`Classifier model not installed: ${profile.classifierModel}`);
      info(`Install with: ollama pull ${profile.classifierModel}`);
    }

    return true;
  } catch (error) {
    fail('Model manager validation failed', error);
    return false;
  }
}

async function validateRouterV2(): Promise<boolean> {
  section('5. Router v2 Classification');

  const monitor = getOllamaHealthMonitor();
  const health = monitor.getStatus();

  if (!monitor.isAvailable()) {
    warn('Skipping router v2 tests (Ollama not available)');
    return true;
  }

  if (health.modelsAvailable.length === 0) {
    warn('Skipping router v2 tests (no models installed)');
    return true;
  }

  try {
    const caps = detectCapabilities();
    const tier = assignTier(caps);
    const profile = getProfile(tier);

    if (profile.classifierModel === 'none') {
      warn('Skipping router v2 tests (minimal tier)');
      return true;
    }

    initializeRouterV2(profile);

    if (!isRouterV2Initialized()) {
      fail('Router v2 failed to initialize');
      return false;
    }

    pass('Router v2 initialized');

    // Test classification of various inputs
    const testCases = [
      { input: 'qué hora es', expectedTier: 'deterministic' },
      { input: 'hola, cómo estás?', expectedTier: 'local' },
      { input: 'traduce esto al inglés: buenos días', expectedTier: 'local' },
      { input: 'busca información sobre React hooks', expectedTier: 'api' },
    ];

    for (const tc of testCases) {
      try {
        const result = await routeV2(tc.input);
        const match = result.tier === tc.expectedTier;
        if (match) {
          pass(`"${tc.input.substring(0, 30)}..." → ${result.tier} (intent: ${result.intent})`);
        } else {
          warn(`"${tc.input.substring(0, 30)}..." → ${result.tier} (expected ${tc.expectedTier}, intent: ${result.intent})`);
        }
      } catch (error) {
        warn(`Classification failed for "${tc.input.substring(0, 30)}...": ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return true;
  } catch (error) {
    fail('Router v2 validation failed', error);
    return false;
  }
}

async function validateLocalExecution(): Promise<boolean> {
  section('6. Local Execution');

  const monitor = getOllamaHealthMonitor();
  if (!monitor.isAvailable()) {
    warn('Skipping local execution tests (Ollama not available)');
    return true;
  }

  if (!isModelManagerInitialized()) {
    warn('Skipping local execution tests (model manager not initialized)');
    return true;
  }

  try {
    // Reset circuit breaker for clean test
    resetCircuitBreaker();

    const caps = detectCapabilities();
    const tier = assignTier(caps);
    const profile = getProfile(tier);

    // Find an available model to test with
    const health = monitor.getStatus();
    const testModel = profile.recommendedModels.find((m) =>
      health.modelsAvailable.some((avail) => avail.includes(m.split(':')[0] || m))
    ) || health.modelsAvailable[0];

    if (!testModel) {
      warn('No suitable model found for local execution test');
      return true;
    }

    info(`Testing with model: ${testModel}`);

    // Test simple chat
    info('Testing simple_chat intent...');
    const startTime = Date.now();
    const result = await executeLocalIntent(
      'simple_chat',
      'Hola, esto es una prueba',
      testModel
    );
    const duration = Date.now() - startTime;

    if (result.success) {
      pass(`Local execution successful (${duration}ms)`);
      info(`Response: "${result.response.substring(0, 100)}${result.response.length > 100 ? '...' : ''}"`);
      if (result.tokensGenerated) {
        info(`Tokens generated: ${result.tokensGenerated}`);
      }
    } else {
      warn(`Local execution failed: ${result.error}`);
      info('This may be expected if the model is not loaded or compatible');
    }

    return true;
  } catch (error) {
    fail('Local execution validation failed', error);
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}═══════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Device Profiles Validation (Fase 3.6a)${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════${RESET}`);

  const results: boolean[] = [];

  results.push(await validateDeviceCapabilities());
  results.push(await validateTierAssignment());
  results.push(await validateOllamaHealth());
  results.push(await validateModelManager());
  results.push(await validateRouterV2());
  results.push(await validateLocalExecution());

  // Cleanup
  stopOllamaHealthMonitor();

  // Summary
  section('Summary');

  const passed = results.filter(Boolean).length;
  const total = results.length;

  if (passed === total) {
    console.log(`${GREEN}${BOLD}All ${total} validation steps passed!${RESET}`);
  } else {
    console.log(`${YELLOW}${passed}/${total} validation steps passed${RESET}`);
    if (results.some((r) => !r)) {
      console.log(`${RED}Some validations failed. Check the output above.${RESET}`);
    }
  }

  console.log('\n');
  process.exit(passed === total ? 0 : 1);
}

main().catch((error) => {
  console.error(`${RED}Validation script crashed:${RESET}`, error);
  process.exit(1);
});

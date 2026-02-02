/**
 * Device Module Startup Integration - Fase 3.6a
 *
 * This file contains the integration code that should be added to src/index.ts
 * to initialize the device module at startup.
 *
 * INSTRUCTIONS FOR INTEGRATION:
 *
 * 1. Add import at the top of src/index.ts:
 *
 *    import { initializeDevice, shutdownDevice } from './device/index.js';
 *
 * 2. Add initialization after initializeLocalRouter (around line 200):
 *
 *    // Fase 3.6a: Initialize device module
 *    try {
 *      const deviceResult = await initializeDevice();
 *      logger.info('Device module initialized', {
 *        tier: deviceResult.profile.tier,
 *        ollamaAvailable: deviceResult.ollamaHealth.available,
 *      });
 *    } catch (error) {
 *      logger.warn('Device module initialization failed', {
 *        error: error instanceof Error ? error.message : 'Unknown error',
 *      });
 *      // Non-fatal: continue without device features
 *    }
 *
 * 3. Add shutdown in cleanup (in signal handlers, around line 230):
 *
 *    // In the cleanup sequence:
 *    shutdownDevice();
 */

import { initializeDevice, shutdownDevice, DeviceConfig } from './index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('device:startup');

/**
 * Initialize device module for startup.
 * Call this after LocalRouter initialization.
 */
export async function initializeDeviceModule(config?: DeviceConfig): Promise<boolean> {
  try {
    const result = await initializeDevice(config);

    logger.info('Device module initialized', {
      tier: result.profile.tier,
      ollamaAvailable: result.ollamaHealth.available,
      modelsAvailable: result.ollamaHealth.modelsAvailable.length,
    });

    return true;
  } catch (error) {
    logger.warn('Device module initialization failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

/**
 * Shutdown device module.
 * Call this during cleanup.
 */
export function shutdownDeviceModule(): void {
  shutdownDevice();
}

export { initializeDevice, shutdownDevice };

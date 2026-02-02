/**
 * Device Capabilities Detection
 *
 * Detects hardware capabilities to determine the appropriate device tier.
 * Part of Fase 3.6a: Device Profiles + Smart Router
 */

import os from 'os';
import { execSync } from 'child_process';
import { statfsSync } from 'fs';
import { DeviceCapabilities } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('device:capabilities');

const BYTES_TO_GB = 1024 * 1024 * 1024;

/**
 * Detect CPU architecture
 */
function detectCpuArch(): 'x64' | 'arm64' {
  const arch = os.arch();
  if (arch === 'arm64' || arch === 'arm') {
    return 'arm64';
  }
  return 'x64';
}

/**
 * Detect GPU accelerator type
 */
function detectAccelerator(): 'metal' | 'cuda' | 'rocm' | 'cpu' {
  const platform = os.platform();

  // macOS with Apple Silicon = Metal
  if (platform === 'darwin') {
    const arch = os.arch();
    if (arch === 'arm64') {
      return 'metal';
    }
    // Intel Mac - no GPU acceleration for LLMs typically
    return 'cpu';
  }

  // Linux/Windows - check for NVIDIA GPU
  if (platform === 'linux' || platform === 'win32') {
    try {
      execSync('nvidia-smi', { stdio: 'ignore' });
      return 'cuda';
    } catch {
      // No NVIDIA GPU
    }

    // Check for AMD ROCm (Linux only)
    if (platform === 'linux') {
      try {
        execSync('rocm-smi', { stdio: 'ignore' });
        return 'rocm';
      } catch {
        // No AMD GPU
      }
    }
  }

  return 'cpu';
}

/**
 * Get free disk space for the current working directory
 */
function getDiskFreeGb(): number {
  try {
    const stats = statfsSync(process.cwd());
    const freeBytes = stats.bfree * stats.bsize;
    return Math.round((freeBytes / BYTES_TO_GB) * 10) / 10;
  } catch (error) {
    logger.warn('Could not detect disk free space:', error);
    return 0;
  }
}

/**
 * Get OS platform normalized
 */
function getOsPlatform(): 'darwin' | 'linux' | 'win32' {
  const platform = os.platform();
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform;
  }
  // Default to linux for other Unix-like systems
  return 'linux';
}

/**
 * Detect all device capabilities
 */
export function detectCapabilities(): DeviceCapabilities {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  const capabilities: DeviceCapabilities = {
    ram: Math.round((totalMem / BYTES_TO_GB) * 10) / 10,
    ramAvailable: Math.round((freeMem / BYTES_TO_GB) * 10) / 10,
    cpu: detectCpuArch(),
    accelerator: detectAccelerator(),
    cores: os.cpus().length,
    diskFree: getDiskFreeGb(),
    os: getOsPlatform(),
  };

  return capabilities;
}

/**
 * Format capabilities for logging
 */
export function formatCapabilities(capabilities: DeviceCapabilities): string {
  const acceleratorLabel = {
    metal: 'Apple Metal',
    cuda: 'NVIDIA CUDA',
    rocm: 'AMD ROCm',
    cpu: 'CPU only',
  };

  return [
    `RAM: ${capabilities.ram}GB (${capabilities.ramAvailable}GB available)`,
    `CPU: ${capabilities.cpu} (${capabilities.cores} cores)`,
    `GPU: ${acceleratorLabel[capabilities.accelerator]}`,
    `Disk: ${capabilities.diskFree}GB free`,
    `OS: ${capabilities.os}`,
  ].join(', ');
}

/**
 * Check if disk space is critically low
 */
export function isDiskSpaceLow(capabilities: DeviceCapabilities): boolean {
  return capabilities.diskFree < 5;
}

/**
 * Check if disk space is warning level
 */
export function isDiskSpaceWarning(capabilities: DeviceCapabilities): boolean {
  return capabilities.diskFree < 20 && capabilities.diskFree >= 5;
}

/**
 * Device Profiles Types
 *
 * Type definitions for device capability detection and tier assignment.
 * Part of Fase 3.6a: Device Profiles + Smart Router
 */

export interface DeviceCapabilities {
  ram: number;                              // GB total
  ramAvailable: number;                     // GB available
  cpu: 'x64' | 'arm64';                     // Architecture
  accelerator: 'metal' | 'cuda' | 'rocm' | 'cpu';  // GPU acceleration
  cores: number;                            // CPU cores
  diskFree: number;                         // GB free
  os: 'darwin' | 'linux' | 'win32';
}

export type DeviceTier = 'minimal' | 'basic' | 'standard' | 'power' | 'server';

export type ModelSize = '1b' | '3b' | '7b' | '13b' | '70b';

export interface DeviceProfile {
  tier: DeviceTier;
  maxModelSize: ModelSize;
  concurrentModels: number;
  recommendedModels: string[];
  embeddingsLocal: boolean;
  classifierModel: string;
}

export interface DeviceConfig {
  tierOverride?: DeviceTier;
  maxRamForModels?: number;
  preferredModels?: string[];
  disableLocalLLM?: boolean;
  ollamaRecheckIntervalMs?: number;
  /** Skip automatic model installation (useful for CI/testing) */
  skipModelSetup?: boolean;
}

export interface OllamaHealthStatus {
  available: boolean;
  version?: string;
  modelsLoaded: string[];
  modelsAvailable: string[];
  error?: string;
}

export interface ModelInfo {
  name: string;
  size: string;        // "7b", "13b"
  quantization: string; // "q4_0", "q8_0"
  ramRequired: number; // GB estimated
}

export interface MemoryUsage {
  total: number;
  used: number;
  available: number;
  modelsLoaded: { name: string; ram: number }[];
}

export interface RouterMetrics {
  // Counters
  requestsTotal: number;
  requestsDeterministic: number;
  requestsLocal: number;
  requestsApi: number;

  // Fallbacks
  localToApiFallbacks: number;

  // Tokens (estimated)
  tokensProcessedLocal: number;
  tokensSavedVsApi: number;

  // Latency
  latencyDeterministicAvg: number;
  latencyLocalAvg: number;
  latencyApiAvg: number;
  latencyLocalP99: number;

  // Models
  modelLoadCount: number;
  modelLoadTimeAvg: number;

  // Health
  ollamaReconnects: number;
  memoryPressureEvents: number;

  // Per intent
  intentBreakdown: Record<string, {
    count: number;
    successRate: number;
    avgLatency: number;
  }>;
}

export interface RouteDecision {
  tier: 'deterministic' | 'local' | 'api';
  model?: string;
  intent: string;
  confidence: number;
  reason?: string;
}

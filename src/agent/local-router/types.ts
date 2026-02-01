/**
 * Local Router Types - Fase 3.5
 *
 * Type definitions for the intent classifier and direct tool execution.
 */

/**
 * Valid intents that can be classified.
 */
export type Intent =
  | 'reminder'
  | 'time'
  | 'weather'
  | 'list_reminders'
  | 'cancel_reminder'
  | 'conversation'
  | 'question'
  | 'ambiguous'
  | 'multi_intent'
  | 'fact_memory'
  | 'search'
  | 'task'
  | 'unknown';

/**
 * Routing decision.
 */
export type Route = 'DIRECT_TOOL' | 'ROUTE_TO_LLM';

/**
 * Intents that can be handled directly without the main LLM.
 */
export const DIRECT_TOOL_INTENTS: Intent[] = [
  'reminder',
  'time',
  'weather',
  'list_reminders',
  'cancel_reminder',
];

/**
 * Map intent to tool name.
 */
export const INTENT_TO_TOOL: Partial<Record<Intent, string>> = {
  time: 'get_current_time',
  weather: 'get_weather',
  list_reminders: 'list_reminders',
  reminder: 'set_reminder',
  cancel_reminder: 'cancel_reminder',
};

/**
 * Result of intent classification.
 */
export interface ClassificationResult {
  intent: Intent;
  confidence: number;
  route: Route;
  params?: Record<string, string>;
  rawResponse?: string;
  latencyMs?: number;
  validationOverride?: boolean;
}

/**
 * Result of direct tool execution.
 */
export interface DirectExecutionResult {
  success: boolean;
  response: string;
  error?: string;
  toolName?: string;
  latencyMs?: number;
}

/**
 * Routing result returned by tryRoute().
 */
export interface RoutingResult {
  route: Route;
  intent: Intent;
  confidence: number;
  params?: Record<string, string>;
  latencyMs: number;
}

/**
 * LocalRouter configuration.
 */
export interface LocalRouterConfig {
  /** Feature flag to enable/disable LocalRouter */
  enabled: boolean;
  /** Minimum confidence for direct tool execution (default: 0.8) */
  confidenceThreshold: number;
  /** Timeout for Ollama requests in ms (default: 30000) */
  ollamaTimeout: number;
  /** Max latency before bypassing to Brain in ms (default: 2000) */
  maxLatencyBeforeBypass: number;
}

/**
 * Aggregated metrics for LocalRouter.
 */
export interface LocalRouterStats {
  totalRequests: number;
  routedLocal: number;
  routedToLlm: number;
  directSuccess: number;
  directFailures: number;
  fallbacksToBrain: number;
  avgLocalLatencyMs: number;
  /** Timestamp when stats were last reset */
  resetAt: Date;
  /** Current backoff state */
  backoff?: {
    inBackoff: boolean;
    consecutiveFailures: number;
    backoffUntil: Date | null;
    lastError: string | null;
  };
}

/**
 * Minimum confidence thresholds per intent.
 */
export const CONFIDENCE_THRESHOLDS: Partial<Record<Intent, number>> = {
  time: 0.7,
  list_reminders: 0.7,
  reminder: 0.8,
  weather: 0.75,
  cancel_reminder: 0.8,
};

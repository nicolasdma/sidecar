/**
 * Local LLM Executor - Fase 3.6a
 *
 * Executes prompts with local Ollama models for intents like
 * translate, grammar_check, summarize, explain, simple_chat.
 */

import { createLogger } from '../../utils/logger.js';
import { getModelManager, isModelManagerInitialized } from '../../device/model-manager.js';
import { getOllamaHealthMonitor } from '../../device/ollama-health.js';
import { LocalLLMIntent, LocalExecutionResult } from './types-v2.js';

const logger = createLogger('local-executor');

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds
const MAX_TOKENS_PER_INTENT: Record<LocalLLMIntent, number> = {
  translate: 512,
  grammar_check: 512,
  summarize: 1024,
  explain: 1024,
  simple_chat: 256,
};

// ═══════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER - Prevents cascading failures when Ollama is degraded
// ═══════════════════════════════════════════════════════════════════

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number | null;
  successCount: number; // For half-open recovery
}

const CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 3,      // Open circuit after 3 consecutive failures
  resetTimeoutMs: 60000,    // Try again after 1 minute
  halfOpenSuccessThreshold: 2, // Require 2 successes in half-open to fully close
};

const circuitBreaker: CircuitBreakerState = {
  state: 'CLOSED',
  failureCount: 0,
  lastFailureTime: null,
  successCount: 0,
};

// Exported for testing
export function shouldAllowRequest(): boolean {
  const now = Date.now();

  switch (circuitBreaker.state) {
    case 'CLOSED':
      return true;

    case 'OPEN':
      // Check if timeout has elapsed
      if (circuitBreaker.lastFailureTime &&
          now - circuitBreaker.lastFailureTime >= CIRCUIT_BREAKER_CONFIG.resetTimeoutMs) {
        logger.info('Circuit breaker: transitioning to HALF_OPEN state');
        circuitBreaker.state = 'HALF_OPEN';
        circuitBreaker.successCount = 0;
        return true;
      }
      return false;

    case 'HALF_OPEN':
      return true;
  }
}

// Exported for testing
export function recordSuccess(): void {
  if (circuitBreaker.state === 'HALF_OPEN') {
    circuitBreaker.successCount++;
    if (circuitBreaker.successCount >= CIRCUIT_BREAKER_CONFIG.halfOpenSuccessThreshold) {
      logger.info('Circuit breaker: recovered, transitioning to CLOSED state');
      circuitBreaker.state = 'CLOSED';
      circuitBreaker.failureCount = 0;
      circuitBreaker.successCount = 0;
    }
  } else if (circuitBreaker.state === 'CLOSED') {
    // Reset failure count on success
    circuitBreaker.failureCount = 0;
  }
}

// Exported for testing
export function recordFailure(): void {
  circuitBreaker.failureCount++;
  circuitBreaker.lastFailureTime = Date.now();

  if (circuitBreaker.state === 'HALF_OPEN') {
    logger.warn('Circuit breaker: failure in HALF_OPEN, reopening circuit');
    circuitBreaker.state = 'OPEN';
  } else if (circuitBreaker.failureCount >= CIRCUIT_BREAKER_CONFIG.failureThreshold) {
    logger.warn(
      `Circuit breaker: OPEN after ${circuitBreaker.failureCount} consecutive failures. ` +
      `Local execution disabled for ${CIRCUIT_BREAKER_CONFIG.resetTimeoutMs / 1000}s`
    );
    circuitBreaker.state = 'OPEN';
  }
}

export function getCircuitBreakerState(): CircuitBreakerState {
  return { ...circuitBreaker };
}

export function resetCircuitBreaker(): void {
  circuitBreaker.state = 'CLOSED';
  circuitBreaker.failureCount = 0;
  circuitBreaker.lastFailureTime = null;
  circuitBreaker.successCount = 0;
  logger.debug('Circuit breaker reset');
}

/**
 * System prompts per intent
 */
const INTENT_SYSTEM_PROMPTS: Record<LocalLLMIntent, string> = {
  translate: `You are a professional translator. Translate the text accurately while preserving:
- Original meaning and tone
- Formatting (paragraphs, lists, etc.)
- Technical terms when appropriate
Respond ONLY with the translation, no explanations.`,

  grammar_check: `You are a professional editor. Correct grammar, spelling, and punctuation errors.
- Fix all errors while preserving meaning
- Maintain the original language
- Keep the original style and tone
Respond ONLY with the corrected text, no explanations.`,

  summarize: `You are an expert at summarization. Create a concise summary that:
- Captures the main points
- Preserves key information
- Is about 20-30% of original length
Respond ONLY with the summary.`,

  explain: `You are a helpful teacher. Explain concepts clearly:
- Use simple language
- Give examples when helpful
- Be concise but thorough
- Target a general audience`,

  simple_chat: `You are a friendly assistant having a casual conversation.
- Be warm and personable
- Keep responses brief and natural
- Match the user's language (Spanish/English)
- Be helpful but not overly formal`,
};

/**
 * Build the prompt for a specific intent
 */
function buildPrompt(intent: LocalLLMIntent, userInput: string, params?: Record<string, string>): string {
  const systemPrompt = INTENT_SYSTEM_PROMPTS[intent];

  // Add specific instructions based on params
  let additionalInstructions = '';

  if (intent === 'translate' && params?.target_language) {
    additionalInstructions = `\nTranslate to: ${params.target_language}`;
  }

  if (intent === 'grammar_check' && params?.language) {
    additionalInstructions = `\nLanguage: ${params.language}`;
  }

  return `${systemPrompt}${additionalInstructions}\n\nUser: ${userInput}`;
}

/**
 * Execute a prompt with a local model
 */
async function executeWithModel(
  model: string,
  prompt: string,
  maxTokens: number,
  timeoutMs: number
): Promise<{ response: string; tokensGenerated?: number }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          num_predict: maxTokens,
          temperature: 0.7,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama request failed: ${text}`);
    }

    const data = await response.json() as { response?: string; eval_count?: number };

    return {
      response: data.response?.trim() || '',
      tokensGenerated: data.eval_count,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Execute a local LLM intent
 *
 * @param intent - The intent to execute
 * @param userInput - The user's original input
 * @param model - The model to use
 * @param params - Optional extracted parameters
 * @param timeoutMs - Optional timeout override
 * @returns Execution result with response or error
 */
export async function executeLocalIntent(
  intent: LocalLLMIntent,
  userInput: string,
  model: string,
  params?: Record<string, string>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<LocalExecutionResult> {
  const startTime = Date.now();

  // Check circuit breaker first (prevents cascading failures)
  if (!shouldAllowRequest()) {
    const state = getCircuitBreakerState();
    const remainingMs = state.lastFailureTime
      ? CIRCUIT_BREAKER_CONFIG.resetTimeoutMs - (Date.now() - state.lastFailureTime)
      : 0;
    return {
      success: false,
      response: '',
      error: `Circuit breaker OPEN (local execution disabled for ${Math.ceil(remainingMs / 1000)}s after repeated failures)`,
      model,
      latencyMs: Date.now() - startTime,
    };
  }

  // Check Ollama availability (on-demand verification to avoid stale status)
  const monitor = getOllamaHealthMonitor();
  const isAvailable = await monitor.verifyAvailable(30000); // 30s staleness window
  if (!isAvailable) {
    recordFailure(); // Count as failure for circuit breaker
    return {
      success: false,
      response: '',
      error: 'Ollama not available',
      model,
      latencyMs: Date.now() - startTime,
    };
  }

  // Acquire lock if model manager is available
  let releaseLock: (() => void) | null = null;
  if (isModelManagerInitialized()) {
    const manager = getModelManager();
    try {
      // Check if model needs loading and notify user
      const needsLoad = await manager.needsLoading(model);
      if (needsLoad) {
        // Show loading message to user (non-blocking UX)
        console.log(`\n🔄 Cargando modelo local (${model})... esto puede tomar unos segundos.\n`);
        logger.info(`Loading model ${model} (cold start)`);
      }

      await manager.ensureLoaded(model);
      releaseLock = manager.acquireLock(model);

      if (needsLoad) {
        logger.info(`Model ${model} ready`);
      }
    } catch (error) {
      return {
        success: false,
        response: '',
        error: error instanceof Error ? error.message : 'Failed to load model',
        model,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  try {
    // Build prompt
    const prompt = buildPrompt(intent, userInput, params);
    const maxTokens = MAX_TOKENS_PER_INTENT[intent];

    // Execute
    const result = await executeWithModel(model, prompt, maxTokens, timeoutMs);

    const latencyMs = Date.now() - startTime;

    // Check for memory pressure
    if (isModelManagerInitialized()) {
      await monitor.checkMemoryPressure(latencyMs);
    }

    logger.info('Local execution complete', {
      intent,
      model,
      latencyMs,
      tokensGenerated: result.tokensGenerated,
    });

    // Record success for circuit breaker
    recordSuccess();

    return {
      success: true,
      response: result.response,
      model,
      latencyMs,
      tokensGenerated: result.tokensGenerated,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    logger.error('Local execution failed', {
      intent,
      model,
      error: errorMessage,
      latencyMs,
    });

    // Record failure for circuit breaker
    recordFailure();

    // Check if it's a timeout
    if (errorMessage.includes('abort') || errorMessage.includes('timeout')) {
      return {
        success: false,
        response: '',
        error: `Timeout after ${timeoutMs}ms`,
        model,
        latencyMs,
      };
    }

    return {
      success: false,
      response: '',
      error: errorMessage,
      model,
      latencyMs,
    };
  } finally {
    // Release lock
    if (releaseLock) {
      releaseLock();
    }
  }
}

/**
 * Execute simple chat with minimal overhead
 */
export async function executeSimpleChat(
  userInput: string,
  model: string
): Promise<LocalExecutionResult> {
  return executeLocalIntent('simple_chat', userInput, model);
}

/**
 * Execute translation
 */
export async function executeTranslation(
  text: string,
  targetLanguage: string,
  model: string
): Promise<LocalExecutionResult> {
  return executeLocalIntent('translate', text, model, {
    target_language: targetLanguage,
  });
}

/**
 * Execute grammar check
 */
export async function executeGrammarCheck(
  text: string,
  model: string
): Promise<LocalExecutionResult> {
  return executeLocalIntent('grammar_check', text, model);
}

/**
 * Execute summarization
 */
export async function executeSummarize(
  text: string,
  model: string
): Promise<LocalExecutionResult> {
  return executeLocalIntent('summarize', text, model);
}

/**
 * Execute explanation
 */
export async function executeExplain(
  text: string,
  model: string
): Promise<LocalExecutionResult> {
  return executeLocalIntent('explain', text, model);
}

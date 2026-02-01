/**
 * Intent Classifier - Fase 3.5
 *
 * Uses Qwen2.5-3B via Ollama to classify user intents and decide routing.
 * Ported from spike implementation with production-ready error handling.
 */

import { generateWithOllama, checkOllamaAvailability } from '../../llm/ollama.js';
import { createLogger } from '../../utils/logger.js';
import type { Intent, Route, ClassificationResult } from './types.js';
import { DIRECT_TOOL_INTENTS, CONFIDENCE_THRESHOLDS } from './types.js';
import { applyValidationRules } from './validation-rules.js';

const logger = createLogger('local-router:classifier');

/**
 * Expected Ollama model name.
 * We validate the exact model, not just prefix.
 */
const EXPECTED_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b-instruct';

/**
 * Classification prompt optimized for Qwen2.5-3B.
 * v2: Improved handling of negations, incomplete commands, mass actions, suggestions.
 */
const CLASSIFICATION_PROMPT = `You are an intent classifier. Classify the user message into ONE intent.

INTENTS:
- reminder: User COMMANDS to be reminded. Must have BOTH a time AND a message/task.
  YES: "recordame en 10 min de X", "avisame mañana a las 9 de Y"
  NO: "recordame" (incomplete), "deberías recordarme" (suggestion)
- time: User asks for current time, date, day, or month.
  YES: "qué hora es", "qué día es hoy", "en qué mes estamos"
- weather: User asks about weather, temperature, rain, or if they need umbrella/jacket.
  YES: "clima en X", "hace frío?", "va a llover?", "necesito paraguas?", "cuántos grados hay?"
- list_reminders: User wants to see their reminders.
  YES: "qué recordatorios tengo", "mis reminders"
- cancel_reminder: User wants to cancel ONE SPECIFIC reminder.
  YES: "cancela el recordatorio de X", "borra el reminder del banco"
  NO: "elimina todos mis recordatorios" (mass action → conversation)
- conversation: Greetings, chat, thanks, jokes, suggestions, negations, mass actions.
  YES: "hola", "gracias", "no me recuerdes nada", "deberías recordarme algo", "elimina todos"
- question: User asks for information, explanation, or opinion.
  YES: "qué es X", "explicame Y", "cuál es la capital de Z"
- fact_memory: User wants you to REMEMBER a permanent fact (not a timed reminder).
  YES: "recordame que soy alérgico", "acordate que trabajo en X"
- search: User wants to search the web.
  YES: "busca información sobre X"
- task: User wants help with a task.
  YES: "ayudame a escribir un email"
- multi_intent: Multiple distinct intents in one message.
  YES: "qué hora es y recordame de X"
- ambiguous: Cannot determine intent, single word without context, incomplete.
  YES: "pastas", "ok" (without prior context)

CRITICAL RULES:
1. NEGATIONS: "no me...", "no quiero...", "no necesito..." → conversation (NOT the negated action)
2. SUGGESTIONS: "deberías...", "podrías...", "quizás..." → conversation (NOT a command)
3. MASS ACTIONS: "todos", "todas", "todo" with delete/cancel → conversation (needs confirmation)
4. INCOMPLETE: "recordame" alone without time AND message → ambiguous
5. WEATHER includes: temperature questions, rain, umbrella, jacket, cold, hot
6. TIME includes: hour, day, date, month, year questions

OUTPUT FORMAT (JSON only, no explanation):
{"intent": "...", "confidence": 0.0-1.0, "params": {"key": "value"}}

USER MESSAGE: `;

/**
 * Parses the LLM response into a ClassificationResult.
 * Handles malformed JSON gracefully.
 */
function parseClassificationResponse(raw: string): Partial<ClassificationResult> {
  try {
    // Try to extract JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('No JSON found in classification response', { raw: raw.slice(0, 200) });
      return { intent: 'unknown', confidence: 0 };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      intent?: string;
      confidence?: number;
      params?: Record<string, string>;
    };

    return {
      intent: (parsed.intent as Intent) || 'unknown',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      params: parsed.params,
    };
  } catch (error) {
    logger.warn('Failed to parse classification response', {
      raw: raw.slice(0, 200),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return { intent: 'unknown', confidence: 0 };
  }
}

/**
 * Determines the route based on intent and confidence.
 */
function determineRoute(intent: Intent, confidence: number): Route {
  if (!DIRECT_TOOL_INTENTS.includes(intent)) {
    return 'ROUTE_TO_LLM';
  }

  const threshold = CONFIDENCE_THRESHOLDS[intent] || 0.8;
  return confidence >= threshold ? 'DIRECT_TOOL' : 'ROUTE_TO_LLM';
}

/**
 * Validates that the expected model is available.
 * Checks exact model name, not just prefix.
 */
export async function validateModel(): Promise<{ valid: boolean; error?: string }> {
  const availability = await checkOllamaAvailability();

  if (!availability.available) {
    return { valid: false, error: availability.error };
  }

  // The model field from checkOllamaAvailability is set if model was found
  if (availability.model) {
    return { valid: true };
  }

  return {
    valid: false,
    error: `Model ${EXPECTED_MODEL} not available`,
  };
}

/**
 * Classifies a user message using Qwen2.5-3B.
 *
 * @param message - The user's input message
 * @param timeout - Optional timeout override in ms
 * @returns Classification result with intent, confidence, and route
 */
export async function classifyIntent(
  message: string,
  _timeout?: number
): Promise<ClassificationResult> {
  const startTime = Date.now();

  // Check Ollama availability first
  const modelValid = await validateModel();
  if (!modelValid.valid) {
    logger.warn('Ollama/model not available, routing to LLM', { error: modelValid.error });
    return {
      intent: 'unknown',
      confidence: 0,
      route: 'ROUTE_TO_LLM',
      rawResponse: `Model not available: ${modelValid.error}`,
      latencyMs: Date.now() - startTime,
    };
  }

  try {
    const prompt = CLASSIFICATION_PROMPT + message;
    const response = await generateWithOllama(prompt, {
      temperature: 0.1, // Low temp for consistent classification
      num_predict: 256, // Short response expected
    });

    const parsed = parseClassificationResponse(response);
    let intent = parsed.intent || 'unknown';
    const confidence = parsed.confidence || 0;
    let route = determineRoute(intent, confidence);
    let validationOverride = false;

    // Apply post-classification validation rules
    const override = applyValidationRules(message, intent, parsed.params);
    if (override) {
      if (override.intent) {
        intent = override.intent;
      }
      route = override.route;
      validationOverride = true;
      logger.debug('Validation rules applied override', {
        originalIntent: parsed.intent,
        newIntent: intent,
        newRoute: route,
      });
    }

    const latencyMs = Date.now() - startTime;

    logger.info('local_router_decision', {
      route,
      intent,
      confidence,
      latency_ms: latencyMs,
      validation_override: validationOverride,
    });

    return {
      intent,
      confidence,
      route,
      params: parsed.params,
      rawResponse: response,
      latencyMs,
      validationOverride,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    logger.error('Classification failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      latency_ms: latencyMs,
    });

    return {
      intent: 'unknown',
      confidence: 0,
      route: 'ROUTE_TO_LLM',
      rawResponse: error instanceof Error ? error.message : 'Unknown error',
      latencyMs,
    };
  }
}

/**
 * Warm-up the classifier by making a dummy classification.
 * This loads the model into memory for faster subsequent requests.
 */
export async function warmupClassifier(): Promise<{ success: boolean; latencyMs: number }> {
  const startTime = Date.now();

  try {
    logger.info('Warming up classifier...');
    await classifyIntent('test warmup');
    const latencyMs = Date.now() - startTime;
    logger.info('Classifier warm-up complete', { latency_ms: latencyMs });
    return { success: true, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    logger.warn('Classifier warm-up failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      latency_ms: latencyMs,
    });
    return { success: false, latencyMs };
  }
}

export default classifyIntent;

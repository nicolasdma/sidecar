/**
 * Local Router Intent Classifier - Spike Implementation
 *
 * Uses Qwen2.5-3B to classify user intents and decide routing.
 * This is a standalone spike - not integrated with brain.ts yet.
 */

import { generateWithOllama, checkOllamaAvailability } from '../../llm/ollama.js';

// Valid intents
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

export type Route = 'DIRECT_TOOL' | 'ROUTE_TO_LLM';

export interface ClassificationResult {
  intent: Intent;
  confidence: number;
  route: Route;
  params?: Record<string, string>;
  raw_response?: string;
  latency_ms?: number;
}

// Intents that can be handled directly (without Kimi)
const DIRECT_TOOL_INTENTS: Intent[] = [
  'reminder',
  'time',
  'weather',
  'list_reminders',
  'cancel_reminder',
];

// Classification prompt - optimized for Qwen2.5-3B
// v2: Improved handling of negations, incomplete commands, mass actions, suggestions
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
  } catch {
    return { intent: 'unknown', confidence: 0 };
  }
}

/**
 * Post-classification validation rules.
 * These are hardcoded rules that override LLM classification for known edge cases.
 * Returns the corrected route, or null if no override needed.
 */
function applyValidationRules(
  originalMessage: string,
  intent: Intent,
  params?: Record<string, string>
): { intent?: Intent; route: Route } | null {
  const lower = originalMessage.toLowerCase().trim();

  // Rule 1: Negations - "no me...", "no quiero...", "no necesito..."
  if (/^no\s+(me|quiero|necesito|te)\b/.test(lower)) {
    return { intent: 'conversation', route: 'ROUTE_TO_LLM' };
  }

  // Rule 2: Mass actions - "todos/todas" with cancel/delete/eliminar
  if (/\b(todos?|todas?)\b/.test(lower) &&
      /\b(elimina|borra|cancela|delete|remove)\b/.test(lower)) {
    return { route: 'ROUTE_TO_LLM' }; // Keep intent, but route to LLM for confirmation
  }

  // Rule 3: Incomplete reminder - classified as reminder but no time param
  if (intent === 'reminder') {
    const hasTime = params?.time && params.time.trim().length > 0;
    const hasMessage = params?.message && params.message.trim().length > 0;

    if (!hasTime || !hasMessage) {
      return { intent: 'ambiguous', route: 'ROUTE_TO_LLM' };
    }
  }

  // Rule 4: Fact memory pattern - "recordame que [fact about user]"
  // Patterns: "soy", "tengo", "trabajo", "vivo", "estoy", "me gusta", "prefiero"
  if (intent === 'reminder' && /\brecord[aá]me\s+que\s+(soy|tengo|trabajo|vivo|estoy|me\s+gusta|prefiero|no\s+puedo|no\s+me\s+gusta)\b/i.test(lower)) {
    return { intent: 'fact_memory', route: 'ROUTE_TO_LLM' };
  }

  // Rule 5: Suggestions - "deberías...", "podrías...", "quizás..."
  if (/^(deberías|podrías|quizás|tal\s*vez|capaz\s+que)\b/.test(lower)) {
    return { intent: 'conversation', route: 'ROUTE_TO_LLM' };
  }

  // Rule 6: Single word without clear intent (extra safety)
  const wordCount = lower.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount === 1 && !['hora', 'clima', 'tiempo', 'recordatorios', 'reminders'].includes(lower)) {
    return { intent: 'ambiguous', route: 'ROUTE_TO_LLM' };
  }

  return null; // No override needed
}

/**
 * Determines the route based on intent and confidence.
 */
function determineRoute(intent: Intent, confidence: number): Route {
  // Minimum confidence thresholds per intent
  const thresholds: Record<string, number> = {
    time: 0.7,
    list_reminders: 0.7,
    reminder: 0.8,
    weather: 0.75,
    cancel_reminder: 0.8,
  };

  if (!DIRECT_TOOL_INTENTS.includes(intent)) {
    return 'ROUTE_TO_LLM';
  }

  const threshold = thresholds[intent] || 0.8;
  return confidence >= threshold ? 'DIRECT_TOOL' : 'ROUTE_TO_LLM';
}

/**
 * Classifies a user message using Qwen2.5-3B.
 *
 * @param message - The user's input message
 * @returns Classification result with intent, confidence, and route
 */
export async function classifyIntent(message: string): Promise<ClassificationResult> {
  const startTime = Date.now();

  // Check Ollama availability
  const availability = await checkOllamaAvailability();
  if (!availability.available) {
    return {
      intent: 'unknown',
      confidence: 0,
      route: 'ROUTE_TO_LLM',
      raw_response: `Ollama not available: ${availability.error}`,
      latency_ms: Date.now() - startTime,
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

    // Apply post-classification validation rules
    const override = applyValidationRules(message, intent, parsed.params);
    if (override) {
      if (override.intent) {
        intent = override.intent;
      }
      route = override.route;
    }

    return {
      intent,
      confidence,
      route,
      params: parsed.params,
      raw_response: response,
      latency_ms: Date.now() - startTime,
    };
  } catch (error) {
    return {
      intent: 'unknown',
      confidence: 0,
      route: 'ROUTE_TO_LLM',
      raw_response: error instanceof Error ? error.message : 'Unknown error',
      latency_ms: Date.now() - startTime,
    };
  }
}

/**
 * Batch classification for testing.
 */
export async function classifyBatch(
  messages: string[]
): Promise<ClassificationResult[]> {
  const results: ClassificationResult[] = [];

  for (const message of messages) {
    const result = await classifyIntent(message);
    results.push(result);

    // Small delay between requests to avoid overwhelming Ollama
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return results;
}

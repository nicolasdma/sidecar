/**
 * Local Router Types v2 - Fase 3.6a
 *
 * Extended type definitions for the Smart Router v2 with 3-tier routing:
 * Deterministic → Local LLM → API
 */

import { Intent } from './types.js';

/**
 * Extended intents for local LLM processing.
 * These are handled by local models, not direct tools.
 */
export type LocalLLMIntent =
  | 'translate'
  | 'grammar_check'
  | 'summarize'
  | 'explain'
  | 'simple_chat';

/**
 * All intents including new local LLM intents.
 */
export type ExtendedIntent = Intent | LocalLLMIntent;

/**
 * Extended routing tiers.
 */
export type RoutingTier = 'deterministic' | 'local' | 'api';

/**
 * Intents that can be processed by local LLM (not direct tools).
 */
export const LOCAL_LLM_INTENTS: LocalLLMIntent[] = [
  'translate',
  'grammar_check',
  'summarize',
  'explain',
  'simple_chat',
];

/**
 * Intents handled deterministically without any LLM.
 */
export const DETERMINISTIC_INTENTS: Intent[] = [
  'time',
  'weather',
  'reminder',
  'list_reminders',
  'cancel_reminder',
];

/**
 * Model preferences per intent.
 * First available model in the list will be used.
 */
export const INTENT_MODEL_PREFERENCES: Record<LocalLLMIntent, string[]> = {
  translate: ['gemma2:9b', 'qwen2.5:7b-instruct', 'mistral:7b-instruct'],
  grammar_check: ['qwen2.5:7b-instruct', 'mistral:7b-instruct'],
  summarize: ['qwen2.5:7b-instruct', 'mistral:7b-instruct'],
  explain: ['gemma2:9b', 'qwen2.5:7b-instruct'],
  simple_chat: ['mistral:7b-instruct', 'qwen2.5:7b-instruct'],
};

/**
 * Extended classification prompt for new intents.
 */
export const EXTENDED_CLASSIFICATION_PROMPT = `You are an intent classifier. Classify the user message into ONE intent.

INTENTS:
- time: User asks for current time, date, day, or month.
  YES: "qué hora es", "qué día es hoy"
- weather: User asks about weather, temperature, rain.
  YES: "clima en X", "va a llover?", "necesito paraguas?"
- reminder: User COMMANDS to be reminded. Must have BOTH a time AND a message.
  YES: "recordame en 10 min de X"
- list_reminders: User wants to see their reminders.
  YES: "qué recordatorios tengo"
- cancel_reminder: User wants to cancel ONE SPECIFIC reminder.
  YES: "cancela el recordatorio de X"
- translate: User wants to translate text to another language.
  YES: "traduce esto al inglés", "how do you say X in English"
- grammar_check: User wants spelling or grammar corrected.
  YES: "corrige este texto", "check my grammar", "fix the spelling"
- summarize: User wants a text summarized.
  YES: "resume este artículo", "summarize this"
- explain: User wants a concept or term explained simply.
  YES: "explícame qué es X", "what is Y"
- simple_chat: Casual conversation, greetings, small talk.
  YES: "hola", "cómo estás", "gracias", "buenos días"
- conversation: Complex discussion, suggestions, negations.
  YES: "no me recuerdes nada", "deberías...", "qué opinas de..."
- question: User asks for information requiring web search or deep knowledge.
  YES: "quién ganó el partido", "noticias de hoy"
- fact_memory: User wants you to REMEMBER a permanent fact.
  YES: "recordame que soy alérgico"
- search: User wants to search the web.
  YES: "busca información sobre X"
- task: User wants help with a complex task.
  YES: "ayudame a escribir un email profesional"
- multi_intent: Multiple distinct intents.
  YES: "qué hora es y traduce esto"
- ambiguous: Cannot determine intent.
  YES: "ok" (without context)
- complex: Requires multi-step reasoning, tool chains, or web search + analysis.
  YES: "investiga sobre X y hazme un resumen", "compara precios de..."

CRITICAL RULES:
1. NEGATIONS → conversation
2. SUGGESTIONS ("deberías...", "podrías...") → conversation
3. MASS ACTIONS ("todos", "elimina todo") → conversation
4. INCOMPLETE commands → ambiguous
5. Simple greetings/thanks → simple_chat
6. Translation requests → translate
7. Grammar/spelling correction → grammar_check
8. Summarization → summarize
9. Explanation requests → explain
10. Requires web search → question or search
11. Multi-step reasoning → complex

OUTPUT FORMAT (JSON only):
{"intent": "...", "confidence": 0.0-1.0, "params": {"key": "value"}}

USER MESSAGE: `;

/**
 * Result of router v2 decision.
 */
export interface RouterV2Decision {
  tier: RoutingTier;
  intent: ExtendedIntent;
  confidence: number;
  model?: string;
  reason?: string;
  params?: Record<string, string>;
}

/**
 * Result of local LLM execution.
 */
export interface LocalExecutionResult {
  success: boolean;
  response: string;
  error?: string;
  model: string;
  latencyMs: number;
  tokensGenerated?: number;
}

/**
 * Confidence thresholds for local LLM intents.
 */
export const LOCAL_LLM_CONFIDENCE_THRESHOLDS: Record<LocalLLMIntent, number> = {
  translate: 0.75,
  grammar_check: 0.75,
  summarize: 0.70,
  explain: 0.70,
  simple_chat: 0.65,
};

/**
 * Validation rules for local LLM intents.
 */
export interface LocalIntentValidation {
  minInputLength?: number;
  maxInputLength?: number;
  requiredKeywords?: RegExp;
  excludeKeywords?: RegExp;
}

/**
 * Input validation rules per intent.
 */
export const LOCAL_INTENT_VALIDATIONS: Partial<Record<LocalLLMIntent, LocalIntentValidation>> = {
  translate: {
    minInputLength: 10, // Very short might be ambiguous
  },
  grammar_check: {
    minInputLength: 5,
  },
  summarize: {
    minInputLength: 100, // Text too short doesn't need summarizing
  },
  simple_chat: {
    excludeKeywords: /\b(busca|encuentra|googlea|investiga)\b/i, // Should go to search
  },
};

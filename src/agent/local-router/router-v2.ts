/**
 * Smart Router v2 - Fase 3.6a + Optimization
 *
 * UNIFIED 3-tier routing system (replaces dual LocalRouter + RouterV2 flow):
 * 1. Deterministic (0ms, $0): Direct tool execution (time, weather, reminders)
 * 2. Local LLM (~2-5s, $0): Local model processing (translate, grammar, summarize)
 * 3. API (~1-3s, $$): Cloud LLM for complex tasks
 *
 * OPTIMIZATION: Fast-path regex patterns skip LLM classification for obvious intents.
 */

import { createLogger } from '../../utils/logger.js';
import { getOllamaHealthMonitor } from '../../device/ollama-health.js';
import { getModelManager, isModelManagerInitialized } from '../../device/model-manager.js';
import { DeviceProfile } from '../../device/types.js';
import { generateWithOllama, checkOllamaAvailability } from '../../llm/ollama.js';
import { Intent, CONFIDENCE_THRESHOLDS } from './types.js';
import { applyValidationRules } from './validation-rules.js';
import {
  RouterV2Decision,
  ExtendedIntent,
  LocalLLMIntent,
  RoutingTier,
  LOCAL_LLM_INTENTS,
  DETERMINISTIC_INTENTS,
  INTENT_MODEL_PREFERENCES,
  EXTENDED_CLASSIFICATION_PROMPT,
  LOCAL_LLM_CONFIDENCE_THRESHOLDS,
  LOCAL_INTENT_VALIDATIONS,
} from './types-v2.js';

const logger = createLogger('router-v2');

/**
 * Fast-path patterns for common intents.
 * These skip LLM classification entirely, saving 1-5 seconds per request.
 * Order matters: more specific patterns should come first.
 */
interface FastPathRule {
  pattern: RegExp;
  intent: ExtendedIntent;
  tier: RoutingTier;
  confidence: number;
  extractParams?: (input: string) => Record<string, string> | undefined;
}

const FAST_PATH_RULES: FastPathRule[] = [
  // Translation - high priority, very common
  {
    pattern: /\b(traduc[eíi]r?|translate|traducción|traducime|traduzca)\b/i,
    intent: 'translate',
    tier: 'local',
    confidence: 0.95,
    extractParams: (input) => {
      // Try to extract target language
      const langMatch = input.match(/\b(al?|to|en)\s+(español|english|inglés|francés|french|portugués|portuguese|alemán|german|italiano|italian)\b/i);
      if (langMatch && langMatch[2]) {
        const langMap: Record<string, string> = {
          español: 'es', spanish: 'es',
          english: 'en', inglés: 'en',
          francés: 'fr', french: 'fr',
          portugués: 'pt', portuguese: 'pt',
          alemán: 'de', german: 'de',
          italiano: 'it', italian: 'it',
        };
        const lang = langMap[langMatch[2].toLowerCase()] || langMatch[2];
        return { targetLang: lang };
      }
      return undefined;
    },
  },
  // Time queries
  {
    pattern: /\b(qué hora|what time|hora actual|current time|qué día|what day|fecha actual|today'?s date)\b/i,
    intent: 'time',
    tier: 'deterministic',
    confidence: 0.98,
  },
  // Weather queries
  {
    pattern: /\b(clima|weather|temperatura|temperature|va a llover|will it rain|lluvia|rain|necesito paraguas|need umbrella|hace (fr[ií]o|calor))\b/i,
    intent: 'weather',
    tier: 'deterministic',
    confidence: 0.95,
    extractParams: (input) => {
      // Try to extract location: "clima en X", "weather in X"
      const locationMatch = input.match(/\b(clima|weather|temperatura)\s+(en|in|de|for)\s+([^,?.!]+)/i);
      if (locationMatch && locationMatch[3]) {
        return { location: locationMatch[3].trim() };
      }
      return undefined;
    },
  },
  // List reminders
  {
    pattern: /\b(mis recordatorios|my reminders|listar? recordatorios|list reminders|qué tengo pendiente|recordatorios activos)\b/i,
    intent: 'list_reminders',
    tier: 'deterministic',
    confidence: 0.98,
  },
  // Cancel reminder (be careful: needs to be specific, not mass action)
  {
    pattern: /\b(cancel[ae]r?|borrar?|eliminar?)\s+(el\s+)?recordatorio\s+(de|del|sobre)\s+/i,
    intent: 'cancel_reminder',
    tier: 'deterministic',
    confidence: 0.90,
    extractParams: (input) => {
      const match = input.match(/recordatorio\s+(?:de|del|sobre)\s+(.+)/i);
      if (match && match[1]) {
        return { query: match[1].trim() };
      }
      return undefined;
    },
  },
  // Set reminder (must have both time and message indicators)
  {
    pattern: /\b(record[aá]me|remind me|avis[aá]me|alert[aá]me)\b.*\b(en|in|a las?|at|mañana|tomorrow|dentro de)\b/i,
    intent: 'reminder',
    tier: 'deterministic',
    confidence: 0.85, // Lower confidence, let LLM extract params
  },
  // Grammar check - multiple patterns for flexibility
  {
    pattern: /\b(correg[ií]r?|corrig[eéia]|fix|check|revisar?)\s*(la\s+)?(ortograf[ií]a|gram[aá]tica|grammar|spelling)\b/i,
    intent: 'grammar_check',
    tier: 'local',
    confidence: 0.92,
  },
  {
    pattern: /\b(ortograf[ií]a|gram[aá]tica|spelling|grammar)\s+(de|del|check|fix)\b/i,
    intent: 'grammar_check',
    tier: 'local',
    confidence: 0.88,
  },
  // Summarize
  {
    pattern: /\b(resum[eéi]|summarize|haz(me)?\s+un\s+resumen|make\s+a\s+summary)\b/i,
    intent: 'summarize',
    tier: 'local',
    confidence: 0.90,
  },
  // Simple greetings (very high confidence, very common)
  {
    pattern: /^(hola|hi|hello|hey|buenos?\s*(d[ií]as?|tardes?|noches?)|good\s*(morning|afternoon|evening))[\s!.,]*$/i,
    intent: 'simple_chat',
    tier: 'local',
    confidence: 0.99,
  },
  // Thanks
  {
    pattern: /^(gracias|thanks?|thank\s+you|thx|ty)[\s!.,]*$/i,
    intent: 'simple_chat',
    tier: 'local',
    confidence: 0.99,
  },
];

/**
 * Try fast-path matching before LLM classification.
 * Returns null if no fast-path match found.
 */
function tryFastPath(input: string): RouterV2Decision | null {
  const trimmed = input.trim();

  for (const rule of FAST_PATH_RULES) {
    if (rule.pattern.test(trimmed)) {
      const params = rule.extractParams?.(trimmed);

      logger.debug('Fast-path match', {
        intent: rule.intent,
        tier: rule.tier,
        confidence: rule.confidence,
        hasParams: !!params,
      });

      return {
        tier: rule.tier,
        intent: rule.intent,
        confidence: rule.confidence,
        params,
        reason: 'Fast-path pattern match',
      };
    }
  }

  return null;
}

/**
 * Current device profile (set during initialization)
 */
let deviceProfile: DeviceProfile | null = null;

/**
 * Initialize router v2 with device profile
 */
export function initializeRouterV2(profile: DeviceProfile): void {
  deviceProfile = profile;
  logger.info('Router v2 initialized', { tier: profile.tier });
}

/**
 * Check if router v2 is initialized
 */
export function isRouterV2Initialized(): boolean {
  return deviceProfile !== null;
}

/**
 * Get the current device profile
 */
export function getDeviceProfile(): DeviceProfile | null {
  return deviceProfile;
}

/**
 * Parse extended classification response
 */
function parseExtendedClassification(raw: string): {
  intent: ExtendedIntent;
  confidence: number;
  params?: Record<string, string>;
} {
  try {
    const start = raw.indexOf('{');
    if (start === -1) {
      return { intent: 'unknown', confidence: 0 };
    }

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < raw.length; i++) {
      const char = raw[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\' && inString) {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') depth++;
      if (char === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = raw.slice(start, i + 1);
          const parsed = JSON.parse(jsonStr);
          return {
            intent: parsed.intent || 'unknown',
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
            params: parsed.params,
          };
        }
      }
    }

    return { intent: 'unknown', confidence: 0 };
  } catch (error) {
    logger.warn('Failed to parse extended classification', { raw: raw.slice(0, 200) });
    return { intent: 'unknown', confidence: 0 };
  }
}

/**
 * Classify with extended prompt for v2 intents
 */
async function classifyExtended(message: string): Promise<{
  intent: ExtendedIntent;
  confidence: number;
  params?: Record<string, string>;
  latencyMs: number;
}> {
  const startTime = Date.now();

  // Check Ollama availability
  const availability = await checkOllamaAvailability();
  if (!availability.available) {
    return {
      intent: 'unknown',
      confidence: 0,
      latencyMs: Date.now() - startTime,
    };
  }

  try {
    const prompt = EXTENDED_CLASSIFICATION_PROMPT + message;
    const response = await generateWithOllama(prompt, {
      temperature: 0.1,
      num_predict: 256,
    });

    const parsed = parseExtendedClassification(response);
    return {
      ...parsed,
      latencyMs: Date.now() - startTime,
    };
  } catch (error) {
    logger.error('Extended classification failed', { error });
    return {
      intent: 'unknown',
      confidence: 0,
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Check if intent is a local LLM intent
 */
function isLocalLLMIntent(intent: ExtendedIntent): intent is LocalLLMIntent {
  return LOCAL_LLM_INTENTS.includes(intent as LocalLLMIntent);
}

/**
 * Check if intent is a deterministic intent
 */
function isDeterministicIntent(intent: ExtendedIntent): boolean {
  return DETERMINISTIC_INTENTS.includes(intent as Intent);
}

/**
 * Validate local intent input
 */
function validateLocalIntentInput(intent: LocalLLMIntent, input: string): boolean {
  const validation = LOCAL_INTENT_VALIDATIONS[intent];
  if (!validation) return true;

  if (validation.minInputLength && input.length < validation.minInputLength) {
    logger.debug(`Input too short for ${intent}`, { length: input.length });
    return false;
  }

  if (validation.maxInputLength && input.length > validation.maxInputLength) {
    logger.debug(`Input too long for ${intent}`, { length: input.length });
    return false;
  }

  if (validation.excludeKeywords && validation.excludeKeywords.test(input)) {
    logger.debug(`Input contains excluded keywords for ${intent}`);
    return false;
  }

  return true;
}

/**
 * Select the best available model for an intent
 */
async function selectModelForIntent(
  intent: LocalLLMIntent,
  profile: DeviceProfile
): Promise<string | null> {
  const preferences = INTENT_MODEL_PREFERENCES[intent] || profile.recommendedModels;

  // Check model manager if available
  if (isModelManagerInitialized()) {
    const manager = getModelManager();

    // Try preferred models first
    for (const model of preferences) {
      if (await manager.isModelAvailable(model)) {
        return model;
      }
    }

    // Fall back to any recommended model
    for (const model of profile.recommendedModels) {
      if (await manager.isModelAvailable(model)) {
        return model;
      }
    }
  } else {
    // Fallback: check Ollama health monitor
    const monitor = getOllamaHealthMonitor();
    const status = monitor.getStatus();

    for (const model of preferences) {
      if (status.modelsAvailable.includes(model)) {
        return model;
      }
    }

    for (const model of profile.recommendedModels) {
      if (status.modelsAvailable.includes(model)) {
        return model;
      }
    }
  }

  return null;
}

/**
 * Route a user message through the 3-tier system.
 *
 * OPTIMIZATION: Uses fast-path patterns before LLM classification.
 * This saves 1-5 seconds for common intents like translate, time, weather.
 *
 * @param input - The user's input message
 * @returns Routing decision with tier, intent, model selection
 */
export async function routeV2(input: string): Promise<RouterV2Decision> {
  const startTime = Date.now();

  // Check if initialized
  if (!deviceProfile) {
    return {
      tier: 'api',
      intent: 'unknown',
      confidence: 0,
      reason: 'Router v2 not initialized',
    };
  }

  // OPTIMIZATION: Try fast-path FIRST (no LLM call needed)
  const fastPathResult = tryFastPath(input);
  if (fastPathResult) {
    // For local tier intents, we need to select a model
    if (fastPathResult.tier === 'local' && isLocalLLMIntent(fastPathResult.intent)) {
      const model = await selectModelForIntent(
        fastPathResult.intent as LocalLLMIntent,
        deviceProfile
      );

      if (model) {
        logger.info('fast_path_route', {
          intent: fastPathResult.intent,
          tier: 'local',
          model,
          latencyMs: Date.now() - startTime,
        });

        return {
          ...fastPathResult,
          model,
        };
      }
      // No model available, fall through to API
      logger.debug('Fast-path local intent but no model available, falling back to API');
    } else if (fastPathResult.tier === 'deterministic') {
      // Deterministic intents don't need a model
      logger.info('fast_path_route', {
        intent: fastPathResult.intent,
        tier: 'deterministic',
        latencyMs: Date.now() - startTime,
      });

      return fastPathResult;
    }
  }

  // Tier: minimal = API only (skip LLM classification)
  if (deviceProfile.tier === 'minimal') {
    return {
      tier: 'api',
      intent: 'unknown',
      confidence: 0,
      reason: 'Device tier is minimal (API only)',
    };
  }

  // Check Ollama availability for LLM classification
  const monitor = getOllamaHealthMonitor();
  if (!monitor.isAvailable()) {
    return {
      tier: 'api',
      intent: 'unknown',
      confidence: 0,
      reason: 'Ollama not available',
    };
  }

  // Full LLM classification (fallback when fast-path doesn't match)
  const classification = await classifyExtended(input);

  // Apply validation rules from existing LocalRouter
  const validationOverride = applyValidationRules(
    input,
    classification.intent as Intent,
    classification.params
  );

  let intent = classification.intent;
  if (validationOverride?.intent) {
    intent = validationOverride.intent;
  }

  // Tier 1: Deterministic
  if (isDeterministicIntent(intent)) {
    const threshold = CONFIDENCE_THRESHOLDS[intent as Intent] || 0.8;

    if (classification.confidence >= threshold) {
      return {
        tier: 'deterministic',
        intent,
        confidence: classification.confidence,
        params: classification.params,
        reason: 'Direct tool execution',
      };
    }
  }

  // Tier 2: Local LLM
  if (isLocalLLMIntent(intent)) {
    const threshold = LOCAL_LLM_CONFIDENCE_THRESHOLDS[intent];

    // Check confidence
    if (classification.confidence < threshold) {
      return {
        tier: 'api',
        intent,
        confidence: classification.confidence,
        reason: `Confidence ${classification.confidence.toFixed(2)} below threshold ${threshold}`,
      };
    }

    // Validate input for this intent
    if (!validateLocalIntentInput(intent, input)) {
      return {
        tier: 'api',
        intent,
        confidence: classification.confidence,
        reason: 'Input validation failed for local processing',
      };
    }

    // Select model
    const model = await selectModelForIntent(intent, deviceProfile);
    if (!model) {
      return {
        tier: 'api',
        intent,
        confidence: classification.confidence,
        reason: 'No suitable local model available',
      };
    }

    return {
      tier: 'local',
      intent,
      confidence: classification.confidence,
      model,
      params: classification.params,
      reason: `Local processing with ${model}`,
    };
  }

  // Tier 3: API (default)
  return {
    tier: 'api',
    intent,
    confidence: classification.confidence,
    params: classification.params,
    reason: 'Complex intent requires API',
  };
}

/**
 * Quick check if input might be a simple chat (without full classification)
 */
export function isLikelySimpleChat(input: string): boolean {
  const simplePatterns = [
    /^(hola|hi|hello|hey|buenos?\s*(días?|tardes?|noches?))/i,
    /^(gracias|thanks|thank you|thx)/i,
    /^(cómo estás|how are you|qué tal)/i,
    /^(adios|bye|hasta luego|chau)/i,
    /^(ok|okay|vale|genial|perfecto|bien)/i,
  ];

  return simplePatterns.some((pattern) => pattern.test(input.trim()));
}

/**
 * Quick check if input might need web search
 */
export function likelyNeedsWebSearch(input: string): boolean {
  const searchPatterns = [
    /\b(busca|search|googlea|find|encuentra)\b/i,
    /\b(noticias?|news)\b/i,
    /\b(precio|price|cost)\b.*\b(de|of|for)\b/i,
    /\b(quién ganó|who won)\b/i,
    /\b(últim[oa]s?|latest|recent)\b/i,
  ];

  return searchPatterns.some((pattern) => pattern.test(input));
}

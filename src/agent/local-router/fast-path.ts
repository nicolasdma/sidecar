/**
 * Fast-path Intent Detection - Keyword-based
 *
 * Replaces fragile regex patterns with robust keyword matching.
 * Uses text normalization and scoring for reliable intent detection.
 *
 * Architecture:
 * - Normalize input (lowercase, remove accents, basic stemming)
 * - Score against intent signatures (primary + secondary keywords)
 * - Return match only if confidence threshold met
 * - Otherwise, let LLM classifier handle it
 */

import { createLogger } from '../../utils/logger.js';
import type { ExtendedIntent, RoutingTier } from './types-v2.js';

const logger = createLogger('fast-path');

// ============================================================================
// Types
// ============================================================================

export interface IntentSignature {
  /** Keywords that strongly indicate this intent */
  primaryKeywords: string[];
  /** Keywords that support this intent (boost score) */
  secondaryKeywords?: string[];
  /** Minimum primary keyword matches required */
  minPrimaryMatches: number;
  /** Minimum score to trigger fast-path (0-1) */
  minScore: number;
  /** Routing tier for this intent */
  tier: RoutingTier;
  /** Optional: extract params from matched keywords */
  paramExtractor?: (input: string, normalizedInput: string) => Record<string, string> | undefined;
}

export interface FastPathResult {
  intent: ExtendedIntent;
  tier: RoutingTier;
  confidence: number;
  params?: Record<string, string>;
  reason: string;
}

// ============================================================================
// Text Normalization
// ============================================================================

/**
 * Accent/diacritic removal map
 */
const ACCENT_MAP: Record<string, string> = {
  'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a', 'ã': 'a',
  'é': 'e', 'è': 'e', 'ë': 'e', 'ê': 'e',
  'í': 'i', 'ì': 'i', 'ï': 'i', 'î': 'i',
  'ó': 'o', 'ò': 'o', 'ö': 'o', 'ô': 'o', 'õ': 'o',
  'ú': 'u', 'ù': 'u', 'ü': 'u', 'û': 'u',
  'ñ': 'n',
  'ç': 'c',
};

/**
 * Remove accents/diacritics from text
 */
function removeAccents(text: string): string {
  return text.split('').map(char => ACCENT_MAP[char] || char).join('');
}

/**
 * Basic Spanish/English stemming (remove common suffixes)
 */
function basicStem(word: string): string {
  // Spanish suffixes
  if (word.endsWith('ando') || word.endsWith('iendo')) {
    return word.slice(0, -4);
  }
  if (word.endsWith('cion') || word.endsWith('sion')) {
    return word.slice(0, -4);
  }
  if (word.endsWith('ar') || word.endsWith('er') || word.endsWith('ir')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('mente')) {
    return word.slice(0, -5);
  }
  // English suffixes
  if (word.endsWith('ing')) {
    return word.slice(0, -3);
  }
  if (word.endsWith('tion') || word.endsWith('sion')) {
    return word.slice(0, -4);
  }
  if (word.endsWith('ly')) {
    return word.slice(0, -2);
  }
  return word;
}

/**
 * Normalize text for keyword matching
 */
export function normalizeText(text: string): string {
  return removeAccents(text.toLowerCase().trim());
}

/**
 * Normalize and tokenize text into words with optional stemming
 */
export function tokenize(text: string, stem: boolean = false): string[] {
  const normalized = normalizeText(text);
  const words = normalized.split(/\s+/).filter(w => w.length > 1);
  return stem ? words.map(basicStem) : words;
}

// ============================================================================
// Intent Signatures
// ============================================================================

const INTENT_SIGNATURES: Record<string, IntentSignature> = {
  translate: {
    primaryKeywords: ['traducir', 'traduce', 'traducime', 'translate', 'traduccion', 'traduzca'],
    secondaryKeywords: ['al', 'to', 'en', 'espanol', 'ingles', 'english', 'spanish', 'french', 'frances', 'portugues', 'aleman', 'german', 'italiano', 'italian'],
    minPrimaryMatches: 1,
    minScore: 0.5,
    tier: 'local',
    paramExtractor: extractTranslateParams,
  },

  grammar_check: {
    primaryKeywords: ['corregir', 'corrige', 'ortografia', 'gramatica', 'grammar', 'spelling', 'revisar'],
    secondaryKeywords: ['texto', 'errores', 'fix', 'check', 'escribi', 'escrito'],
    minPrimaryMatches: 1,
    minScore: 0.4,
    tier: 'local',
  },

  summarize: {
    primaryKeywords: ['resumir', 'resume', 'resumen', 'summarize', 'summary', 'resumime'],
    secondaryKeywords: ['texto', 'articulo', 'parrafo', 'text', 'article'],
    minPrimaryMatches: 1,
    minScore: 0.5,
    tier: 'local',
  },

  time: {
    primaryKeywords: ['hora', 'time', 'fecha', 'date', 'dia', 'day'],
    secondaryKeywords: ['que', 'what', 'cual', 'current', 'actual', 'hoy', 'today', 'ahora', 'now'],
    minPrimaryMatches: 1,
    minScore: 0.5,
    tier: 'deterministic',
  },

  weather: {
    primaryKeywords: ['clima', 'weather', 'temperatura', 'temperature', 'lluvia', 'rain', 'llover'],
    secondaryKeywords: ['en', 'in', 'de', 'frio', 'calor', 'paraguas', 'umbrella', 'pronostico', 'forecast', 'hace', 'va'],
    minPrimaryMatches: 1,
    minScore: 0.4,
    tier: 'deterministic',
    paramExtractor: extractWeatherParams,
  },

  list_reminders: {
    primaryKeywords: ['recordatorios', 'reminders', 'pendientes', 'alarmas'],
    secondaryKeywords: ['mis', 'my', 'listar', 'list', 'ver', 'mostrar', 'show', 'tengo', 'activos'],
    minPrimaryMatches: 1,
    minScore: 0.5,
    tier: 'deterministic',
  },

  reminder: {
    primaryKeywords: ['recordame', 'recordar', 'remind', 'reminder', 'avisame', 'alertame'],
    secondaryKeywords: ['en', 'in', 'a las', 'at', 'manana', 'tomorrow', 'minutos', 'minutes', 'horas', 'hours', 'dentro'],
    minPrimaryMatches: 1,
    minScore: 0.6, // Higher threshold - needs time indicator
    tier: 'deterministic',
  },

  cancel_reminder: {
    primaryKeywords: ['cancelar', 'cancel', 'borrar', 'delete', 'eliminar', 'quitar', 'remove'],
    secondaryKeywords: ['recordatorio', 'reminder', 'alarma', 'alarm'],
    minPrimaryMatches: 1,
    minScore: 0.6, // Need both action + target
    tier: 'deterministic',
  },

  simple_chat: {
    primaryKeywords: ['hola', 'hello', 'hi', 'hey', 'gracias', 'thanks', 'chau', 'bye', 'adios'],
    secondaryKeywords: ['buenos', 'dias', 'tardes', 'noches', 'morning', 'afternoon', 'evening', 'good'],
    minPrimaryMatches: 1,
    minScore: 0.8, // High threshold - only very clear greetings
    tier: 'local',
  },
};

// ============================================================================
// Parameter Extractors
// ============================================================================

function extractTranslateParams(input: string, _normalized: string): Record<string, string> | undefined {
  // Match "al/to LANGUAGE" patterns
  const langPatterns: Record<string, string> = {
    'espanol': 'es', 'spanish': 'es',
    'ingles': 'en', 'english': 'en',
    'frances': 'fr', 'french': 'fr',
    'portugues': 'pt', 'portuguese': 'pt',
    'aleman': 'de', 'german': 'de',
    'italiano': 'it', 'italian': 'it',
  };

  const normalized = normalizeText(input);

  for (const [keyword, code] of Object.entries(langPatterns)) {
    if (normalized.includes(keyword)) {
      return { targetLang: code };
    }
  }

  return undefined;
}

function extractWeatherParams(input: string, _normalized: string): Record<string, string> | undefined {
  const normalized = normalizeText(input);

  // Pattern: "clima/weather en/in LOCATION"
  const patterns = [
    /(?:clima|weather|temperatura)\s+(?:en|in|de|for)\s+(.+?)(?:\?|$|,)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      return { location: match[1].trim() };
    }
  }

  return undefined;
}

// ============================================================================
// Scoring
// ============================================================================

interface ScoreResult {
  score: number;
  primaryMatches: number;
  secondaryMatches: number;
  matchedPrimary: string[];
  matchedSecondary: string[];
}

/**
 * Calculate intent match score
 */
function calculateScore(
  tokens: string[],
  signature: IntentSignature
): ScoreResult {
  const tokenSet = new Set(tokens);
  const normalizedPrimary = signature.primaryKeywords.map(normalizeText);
  const normalizedSecondary = (signature.secondaryKeywords || []).map(normalizeText);

  const matchedPrimary: string[] = [];
  const matchedSecondary: string[] = [];

  // Check primary keywords (also check if token starts with keyword for partial matches)
  for (const keyword of normalizedPrimary) {
    for (const token of tokenSet) {
      if (token === keyword || token.startsWith(keyword) || keyword.startsWith(token)) {
        matchedPrimary.push(keyword);
        break;
      }
    }
  }

  // Check secondary keywords
  for (const keyword of normalizedSecondary) {
    for (const token of tokenSet) {
      if (token === keyword || token.startsWith(keyword) || keyword.startsWith(token)) {
        matchedSecondary.push(keyword);
        break;
      }
    }
  }

  const primaryMatches = matchedPrimary.length;
  const secondaryMatches = matchedSecondary.length;

  // Score calculation:
  // - Primary matches are weighted heavily (0.7 of score)
  // - Secondary matches boost the score (0.3 of score)
  const primaryScore = Math.min(primaryMatches / Math.max(signature.minPrimaryMatches, 1), 1);
  const secondaryScore = secondaryMatches > 0
    ? Math.min(secondaryMatches / (normalizedSecondary.length || 1), 1)
    : 0;

  const score = (primaryScore * 0.7) + (secondaryScore * 0.3);

  return {
    score,
    primaryMatches,
    secondaryMatches,
    matchedPrimary,
    matchedSecondary,
  };
}

// ============================================================================
// Main Fast-Path Function
// ============================================================================

/**
 * Try to match input against known intent patterns using keywords.
 * Returns null if no confident match found (should fallback to LLM).
 */
export function tryFastPath(input: string): FastPathResult | null {
  const tokens = tokenize(input, false); // No stemming for now, keep it simple

  if (tokens.length === 0) {
    return null;
  }

  let bestMatch: { intent: string; signature: IntentSignature; score: ScoreResult } | null = null;

  // Score against all intents
  for (const [intentName, signature] of Object.entries(INTENT_SIGNATURES)) {
    const score = calculateScore(tokens, signature);

    // Check minimum requirements
    if (score.primaryMatches < signature.minPrimaryMatches) {
      continue;
    }

    if (score.score < signature.minScore) {
      continue;
    }

    // Track best match
    if (!bestMatch || score.score > bestMatch.score.score) {
      bestMatch = { intent: intentName, signature, score };
    }
  }

  if (!bestMatch) {
    return null;
  }

  // Extract params if extractor exists
  const params = bestMatch.signature.paramExtractor?.(input, normalizeText(input));

  logger.debug('Fast-path keyword match', {
    intent: bestMatch.intent,
    score: bestMatch.score.score.toFixed(2),
    primaryMatches: bestMatch.score.matchedPrimary,
    secondaryMatches: bestMatch.score.matchedSecondary,
  });

  return {
    intent: bestMatch.intent as ExtendedIntent,
    tier: bestMatch.signature.tier,
    confidence: bestMatch.score.score,
    params,
    reason: `Keyword match: ${bestMatch.score.matchedPrimary.join(', ')}`,
  };
}

/**
 * Get all registered intent signatures (for debugging/testing)
 */
export function getIntentSignatures(): Record<string, IntentSignature> {
  return { ...INTENT_SIGNATURES };
}

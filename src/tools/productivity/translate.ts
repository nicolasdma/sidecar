/**
 * Translate Tool - Fase 3.6b
 *
 * Translation between languages using local LLMs.
 * Prefers gemma2:9b for quality, falls back to qwen2.5:7b.
 */

import { createLogger } from '../../utils/logger.js';
import { executeLocalIntent } from '../../agent/local-router/local-executor.js';
import type { ProductivityToolResult, TranslateParams, TranslateResult } from './types.js';

const logger = createLogger('tool:translate');

/**
 * Supported languages for translation.
 */
export const SUPPORTED_LANGUAGES: Record<string, string> = {
  es: 'Spanish',
  en: 'English',
  fr: 'French',
  pt: 'Portuguese',
  de: 'German',
  it: 'Italian',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  ar: 'Arabic',
};

/**
 * Language detection patterns.
 */
const LANGUAGE_PATTERNS: Record<string, RegExp> = {
  en: /\b(english|inglés|ingles)\b/i,
  es: /\b(spanish|español|espanol)\b/i,
  fr: /\b(french|francés|frances)\b/i,
  pt: /\b(portuguese|portugués|portugues)\b/i,
  de: /\b(german|alemán|aleman)\b/i,
  it: /\b(italian|italiano)\b/i,
  zh: /\b(chinese|chino|mandarín|mandarin)\b/i,
  ja: /\b(japanese|japonés|japones)\b/i,
  ko: /\b(korean|coreano)\b/i,
  ru: /\b(russian|ruso)\b/i,
  ar: /\b(arabic|árabe|arabe)\b/i,
};

/**
 * Formality patterns.
 */
const FORMALITY_PATTERNS = {
  formal: /\b(formal|profesional|usted)\b/i,
  informal: /\b(informal|casual|tú|tu)\b/i,
};

/**
 * Detect target language from user input.
 */
export function detectTargetLanguage(input: string): string | null {
  for (const [code, pattern] of Object.entries(LANGUAGE_PATTERNS)) {
    if (pattern.test(input)) {
      return code;
    }
  }
  return null;
}

/**
 * Detect formality from user input.
 */
export function detectFormality(input: string): 'formal' | 'informal' | undefined {
  if (FORMALITY_PATTERNS.formal.test(input)) return 'formal';
  if (FORMALITY_PATTERNS.informal.test(input)) return 'informal';
  return undefined;
}

/**
 * Extract text to translate from user input.
 * Handles patterns like:
 * - "Traduce al inglés: Hello world"
 * - "Translate to Spanish: Hola mundo"
 * - "Cómo se dice 'hello' en español?"
 * - "traducí 'hello world' al español"
 */
export function extractTextToTranslate(input: string): string {
  // Pattern 1: "traduce/translate X: [text]"
  const colonMatch = input.match(/(?:traduc[eaií]|translate)[^:]*:\s*(.+)/is);
  if (colonMatch && colonMatch[1]) return colonMatch[1].trim();

  // Pattern 2: Text in quotes - "traducí 'text' al español" or "translate "text" to english"
  const quotedMatch = input.match(/["'""']([^"'""']+)["'""']/);
  if (quotedMatch && quotedMatch[1]) return quotedMatch[1].trim();

  // Pattern 3: "cómo se dice [text] en X"
  const comoMatch = input.match(/(?:cómo se dice|how do you say)\s+(.+?)\s+(?:en|in|al|to)\s+\w+/i);
  if (comoMatch && comoMatch[1]) return comoMatch[1].trim();

  // Pattern 4: Remove instruction words and language specification
  const cleaned = input
    // Remove leading "traduce/translate/traducí"
    .replace(/^(?:traduc[eaií]|translate|por favor traduc[eaií])\s*/i, '')
    // Remove "al/to/a [language]" at the end
    .replace(/\s+(?:al|to|a|en|in)\s+(?:español|spanish|inglés|english|francés|french|portugués|portuguese|alemán|german|italiano|italian|chino|chinese|japonés|japanese|coreano|korean|ruso|russian|árabe|arabic)\s*$/i, '')
    .trim();

  return cleaned || input;
}

/**
 * Build the translation prompt.
 */
function buildTranslatePrompt(params: TranslateParams): string {
  const targetLangName = SUPPORTED_LANGUAGES[params.targetLang] || params.targetLang;
  const sourceLangName = params.sourceLang
    ? SUPPORTED_LANGUAGES[params.sourceLang] || params.sourceLang
    : 'auto-detect';

  let prompt = `You are a professional translator. Translate the following text.

Source language: ${sourceLangName}
Target language: ${targetLangName}`;

  if (params.formality) {
    prompt += `\nFormality: ${params.formality}`;
  }

  prompt += `

Text to translate:
"""
${params.text}
"""

Respond with ONLY the translated text, nothing else. Preserve formatting.`;

  return prompt;
}

/**
 * Execute translation with local LLM.
 */
export async function executeTranslate(
  params: TranslateParams,
  model: string
): Promise<ProductivityToolResult<TranslateResult>> {
  const startTime = Date.now();

  // Validate target language
  const targetLangName = SUPPORTED_LANGUAGES[params.targetLang];
  if (!targetLangName) {
    const supported = Object.entries(SUPPORTED_LANGUAGES)
      .map(([code, name]) => `${code} (${name})`)
      .join(', ');

    return {
      success: false,
      error: `Idioma no soportado: ${params.targetLang}. Idiomas disponibles: ${supported}`,
      latencyMs: Date.now() - startTime,
    };
  }

  // Validate text is not empty
  if (!params.text.trim()) {
    return {
      success: false,
      error: 'No hay texto para traducir',
      latencyMs: Date.now() - startTime,
    };
  }

  const prompt = buildTranslatePrompt(params);

  logger.debug('Executing translation', {
    targetLang: params.targetLang,
    textLength: params.text.length,
    model,
  });

  const result = await executeLocalIntent(
    'translate',
    prompt,
    model,
    { target_language: targetLangName }
  );

  if (!result.success) {
    return {
      success: false,
      error: result.error || 'Error en la traducción',
      latencyMs: result.latencyMs,
    };
  }

  // Translation returns plain text, no JSON needed
  const translated = result.response.trim();

  // Sanity check: if translation is empty or same as original
  if (!translated) {
    return {
      success: false,
      error: 'La traducción resultó vacía',
      latencyMs: result.latencyMs,
    };
  }

  logger.info('Translation complete', {
    sourceLength: params.text.length,
    translatedLength: translated.length,
    latencyMs: result.latencyMs,
  });

  return {
    success: true,
    data: {
      original: params.text,
      translated,
      targetLang: params.targetLang,
      detectedLang: params.sourceLang ? undefined : 'auto',
    },
    latencyMs: result.latencyMs,
  };
}

/**
 * Format translation result for user display.
 */
export function formatTranslateResult(result: TranslateResult): string {
  return result.translated;
}

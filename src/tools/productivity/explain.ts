/**
 * Explain Tool - Fase 3.6b
 *
 * Concept explanation using local LLMs.
 * Supports different complexity levels (eli5, beginner, intermediate, expert).
 * Prefers gemma2:9b for quality explanations.
 */

import { createLogger } from '../../utils/logger.js';
import { executeLocalIntent } from '../../agent/local-router/local-executor.js';
import type { ProductivityToolResult, ExplainParams, ExplainResult } from './types.js';

const logger = createLogger('tool:explain');

/**
 * Patterns that suggest a technical topic.
 */
const TECHNICAL_PATTERNS = [
  /\b(algorithm|kubernetes|neural|quantum|cryptograph|protocol)\b/i,
  /\b(machine learning|deep learning|blockchain|microservices)\b/i,
  /\b(api|sdk|framework|library|database|server)\b/i,
  /\b(algoritmo|red neuronal|criptografía|protocolo)\b/i,
];

/**
 * Level descriptions in Spanish for prompts.
 */
const LEVEL_DESCRIPTIONS: Record<NonNullable<ExplainParams['level']>, string> = {
  eli5: 'Explain like I\'m 5 years old. Use simple analogies and everyday examples. No jargon.',
  beginner: 'Basic understanding level. Define technical terms. Use simple, concrete examples.',
  intermediate: 'Assume some background knowledge. More depth and nuance allowed.',
  expert: 'Technical and detailed. Assume expertise. Cover nuances and edge cases.',
};

/**
 * Build the explanation prompt.
 */
function buildExplainPrompt(params: ExplainParams): string {
  const level = params.level || 'beginner';
  const language = params.language || 'Spanish';
  const levelDesc = LEVEL_DESCRIPTIONS[level];

  let prompt = `Explain the following concept.

Topic: ${params.topic}
Level: ${level} - ${levelDesc}`;

  if (params.context) {
    prompt += `\nContext: ${params.context}`;
  }

  prompt += `
Language: ${language}

Respond with:
1. A clear explanation appropriate for the level (2-4 paragraphs)
2. 1-2 concrete examples if helpful
3. Optionally mention 2-3 related concepts they might want to explore

Keep it concise but complete. Do not include headers or labels like "Explanation:" - just provide the content directly.`;

  return prompt;
}

/**
 * Detect complexity level from user input.
 */
export function detectLevel(input: string): ExplainParams['level'] {
  if (/\b(eli5|como.*5|five.*old|niño)\b/i.test(input)) return 'eli5';
  if (/\b(simple|básico|basic|principiante|beginner)\b/i.test(input)) return 'beginner';
  if (/\b(técnico|technical|avanzado|advanced|expert)\b/i.test(input)) return 'expert';
  if (/\b(intermedio|intermediate)\b/i.test(input)) return 'intermediate';
  return undefined;
}

/**
 * Suggest appropriate level based on topic.
 */
export function suggestLevel(topic: string, userLevel?: ExplainParams['level']): NonNullable<ExplainParams['level']> {
  if (userLevel) return userLevel;

  const isTechnical = TECHNICAL_PATTERNS.some(p => p.test(topic));
  return isTechnical ? 'intermediate' : 'beginner';
}

/**
 * Extract topic from user input.
 */
export function extractTopic(input: string): string {
  // Pattern: "explica qué es X" or "explain what is X"
  const whatIsMatch = input.match(/(?:qué es|what is|what are|qué son)\s+(.+)/i);
  if (whatIsMatch && whatIsMatch[1]) return whatIsMatch[1].trim().replace(/[?]$/, '');

  // Pattern: "explícame X" or "explain X"
  const explainMatch = input.match(/(?:explica|explicame|explícame|explain)\s+(.+)/i);
  if (explainMatch && explainMatch[1]) return explainMatch[1].trim().replace(/[?]$/, '');

  // Pattern: "cómo funciona X" or "how does X work"
  const howMatch = input.match(/(?:cómo funciona|how does .* work|how do .* work)\s*(.+)?/i);
  if (howMatch && howMatch[1]) return howMatch[1].trim().replace(/[?]$/, '');

  // Pattern: "qué significa X" or "what does X mean"
  const meaningMatch = input.match(/(?:qué significa|what does .* mean)\s*(.+)?/i);
  if (meaningMatch && meaningMatch[1]) return meaningMatch[1].trim().replace(/[?]$/, '');

  // Fallback: clean common prefixes
  const cleaned = input
    .replace(/^(?:explica|explicame|explícame|explain|dime|tell me|qué es|what is)\s*/i, '')
    .replace(/[?]$/, '')
    .trim();

  return cleaned || input;
}

/**
 * Detect language from user input.
 */
export function detectLanguage(input: string): string {
  // If input is primarily in English, respond in English
  const englishPatterns = /\b(explain|what is|how does|tell me about)\b/i;
  const spanishPatterns = /\b(explica|qué es|cómo funciona|dime)\b/i;

  if (englishPatterns.test(input) && !spanishPatterns.test(input)) {
    return 'English';
  }

  return 'Spanish';
}

/**
 * Execute explanation with local LLM.
 */
export async function executeExplain(
  params: ExplainParams,
  model: string
): Promise<ProductivityToolResult<ExplainResult>> {
  const startTime = Date.now();

  // Validate topic is not empty
  if (!params.topic.trim()) {
    return {
      success: false,
      error: 'No especificaste qué quieres que explique',
      latencyMs: Date.now() - startTime,
    };
  }

  // Suggest level if not provided
  const level = suggestLevel(params.topic, params.level);
  const paramsWithLevel = { ...params, level };

  const prompt = buildExplainPrompt(paramsWithLevel);

  logger.debug('Executing explanation', {
    topic: params.topic,
    level,
    model,
  });

  const result = await executeLocalIntent('explain', prompt, model);

  if (!result.success) {
    return {
      success: false,
      error: result.error || 'Error al explicar',
      latencyMs: result.latencyMs,
    };
  }

  const explanation = result.response.trim();

  // Sanity check
  if (!explanation) {
    return {
      success: false,
      error: 'La explicación resultó vacía',
      latencyMs: result.latencyMs,
    };
  }

  logger.info('Explanation complete', {
    topic: params.topic,
    level,
    explanationLength: explanation.length,
    latencyMs: result.latencyMs,
  });

  return {
    success: true,
    data: {
      topic: params.topic,
      explanation,
      // Note: examples and related concepts would need JSON extraction
      // For now, they're embedded in the explanation text
    },
    latencyMs: result.latencyMs,
  };
}

/**
 * Format explanation result for user display.
 */
export function formatExplainResult(result: ExplainResult): string {
  return result.explanation;
}

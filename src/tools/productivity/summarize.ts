/**
 * Summarize Tool - Fase 3.6b
 *
 * Text summarization using local LLMs.
 * Supports different lengths (brief, medium, detailed) and formats (paragraph, bullets, tldr).
 * Prefers qwen2.5:7b for efficiency.
 */

import { createLogger } from '../../utils/logger.js';
import { executeLocalIntent } from '../../agent/local-router/local-executor.js';
import type { ProductivityToolResult, SummarizeParams, SummarizeResult } from './types.js';

const logger = createLogger('tool:summarize');

/** Minimum word count for text to be worth summarizing */
const MIN_WORDS_FOR_SUMMARY = 50;

/**
 * Count words in text.
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Build the summarization prompt.
 */
function buildSummarizePrompt(params: SummarizeParams): string {
  const length = params.length || 'medium';
  const format = params.format || 'paragraph';
  const language = params.language || 'same as input';

  return `Summarize the following text.

Length: ${length}
Format: ${format}
Language: ${language}

Text to summarize:
"""
${params.text}
"""

Guidelines:
- brief: 1-2 sentences, only the most essential point
- medium: 3-5 sentences, main points
- detailed: comprehensive summary, all important points

- paragraph: flowing prose
- bullets: bullet points (use • for each point)
- tldr: single sentence starting with "TL;DR:"

Respond with ONLY the summary, no preamble or explanation.`;
}

/**
 * Detect summary format from user input.
 */
export function detectFormat(input: string): SummarizeParams['format'] {
  if (/\b(tl;?dr|tldr)\b/i.test(input)) return 'tldr';
  if (/\b(bullet|puntos|viñetas|lista)\b/i.test(input)) return 'bullets';
  return 'paragraph';
}

/**
 * Detect summary length from user input.
 */
export function detectLength(input: string): SummarizeParams['length'] {
  if (/\b(breve|brief|corto|short)\b/i.test(input)) return 'brief';
  if (/\b(detallado|detailed|completo|comprehensive|largo)\b/i.test(input)) return 'detailed';
  return 'medium';
}

/**
 * Extract text to summarize from user input.
 */
export function extractTextToSummarize(input: string): string {
  // Pattern: "resume esto: [text]" or "summarize this: [text]"
  const colonMatch = input.match(/(?:resum[ei]|summarize|summary)[^:]*:\s*(.+)/is);
  if (colonMatch && colonMatch[1]) return colonMatch[1].trim();

  // Pattern: "TL;DR: [text]" - the text follows
  const tldrMatch = input.match(/tl;?dr:?\s*(.+)/is);
  if (tldrMatch && tldrMatch[1]) return tldrMatch[1].trim();

  // Pattern: just "resume [text]"
  const simpleMatch = input.match(/(?:resum[ei]|summarize)\s+(.+)/is);
  if (simpleMatch && simpleMatch[1]) return simpleMatch[1].trim();

  return input;
}

/**
 * Execute summarization with local LLM.
 */
export async function executeSummarize(
  params: SummarizeParams,
  model: string
): Promise<ProductivityToolResult<SummarizeResult>> {
  const startTime = Date.now();

  // Validate text is not empty
  if (!params.text.trim()) {
    return {
      success: false,
      error: 'No hay texto para resumir',
      latencyMs: Date.now() - startTime,
    };
  }

  // Check minimum length
  const wordCount = countWords(params.text);
  if (wordCount < MIN_WORDS_FOR_SUMMARY) {
    return {
      success: false,
      error: `El texto es muy corto para resumir (${wordCount} palabras, mínimo ${MIN_WORDS_FOR_SUMMARY}). ¿Quieres que lo explique o reformule?`,
      latencyMs: Date.now() - startTime,
    };
  }

  const prompt = buildSummarizePrompt(params);

  logger.debug('Executing summarization', {
    wordCount,
    length: params.length,
    format: params.format,
    model,
  });

  const result = await executeLocalIntent('summarize', prompt, model);

  if (!result.success) {
    return {
      success: false,
      error: result.error || 'Error al resumir',
      latencyMs: result.latencyMs,
    };
  }

  const summary = result.response.trim();

  // Sanity check: summary shouldn't be empty
  if (!summary) {
    return {
      success: false,
      error: 'El resumen resultó vacío',
      latencyMs: result.latencyMs,
    };
  }

  const summaryWordCount = countWords(summary);
  const compressionRatio = summaryWordCount / wordCount;

  logger.info('Summarization complete', {
    originalWords: wordCount,
    summaryWords: summaryWordCount,
    compressionRatio: compressionRatio.toFixed(2),
    latencyMs: result.latencyMs,
  });

  return {
    success: true,
    data: {
      originalLength: wordCount,
      summary,
      summaryLength: summaryWordCount,
      compressionRatio,
    },
    latencyMs: result.latencyMs,
  };
}

/**
 * Format summarization result for user display.
 */
export function formatSummarizeResult(result: SummarizeResult): string {
  let output = result.summary;

  // Add compression info for longer summaries
  if (result.originalLength > 100) {
    const percentage = Math.round(result.compressionRatio * 100);
    output += `\n\n📊 Compresión: ${result.summaryLength} de ${result.originalLength} palabras (${percentage}%)`;
  }

  return output;
}

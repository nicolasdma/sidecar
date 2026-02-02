/**
 * Grammar Check Tool - Fase 3.6b
 *
 * Spelling and grammar correction using local LLMs.
 * Uses JSON extraction with graceful fallback to raw text.
 * Prefers qwen2.5:7b for speed, falls back to mistral:7b.
 */

import { createLogger } from '../../utils/logger.js';
import { executeLocalIntent } from '../../agent/local-router/local-executor.js';
import { extractJSON, recordExtractionFailure } from '../../utils/json-extractor.js';
import type {
  ProductivityToolResult,
  GrammarCheckParams,
  GrammarCheckResult,
  GrammarCheckLLMResponse,
  GrammarChange,
} from './types.js';

const logger = createLogger('tool:grammar');

/**
 * Build the grammar check prompt.
 * Requests structured JSON response for detailed corrections.
 */
function buildGrammarPrompt(params: GrammarCheckParams): string {
  const language = params.language || 'auto-detect';
  const style = params.style || 'neutral';

  return `You are a professional editor. Correct the following text for spelling, grammar, and punctuation errors.

Language: ${language}
Target style: ${style}

Text to correct:
"""
${params.text}
"""

Respond in this exact JSON format:
{
  "corrected": "the corrected text here",
  "changes": [
    {
      "type": "spelling|grammar|punctuation|style",
      "original": "wrong word",
      "corrected": "correct word",
      "explanation": "brief explanation"
    }
  ]
}

If there are no errors, return the original text with empty changes array.
IMPORTANT: Respond ONLY with valid JSON, no other text.`;
}

/**
 * Validate that the extracted data matches expected structure.
 */
function isValidGrammarResponse(data: unknown): data is GrammarCheckLLMResponse {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.corrected === 'string';
}

/**
 * Format raw LLM response into GrammarCheckResult.
 */
function formatGrammarResult(
  llmResponse: GrammarCheckLLMResponse,
  originalText: string
): GrammarCheckResult {
  const changes: GrammarChange[] = [];

  // Process changes if present
  if (Array.isArray(llmResponse.changes)) {
    for (const change of llmResponse.changes) {
      if (change.original && change.corrected) {
        changes.push({
          type: (change.type as GrammarChange['type']) || 'grammar',
          original: change.original,
          corrected: change.corrected,
          explanation: change.explanation,
        });
      }
    }
  }

  // Build summary
  let summary: string;
  if (changes.length === 0) {
    summary = 'No se encontraron errores.';
  } else {
    const byType: Record<string, number> = {};
    for (const c of changes) {
      byType[c.type] = (byType[c.type] || 0) + 1;
    }
    const typeSummary = Object.entries(byType)
      .map(([type, count]) => `${count} ${type}`)
      .join(', ');
    summary = `${changes.length} corrección${changes.length > 1 ? 'es' : ''}: ${typeSummary}`;
  }

  return {
    original: originalText,
    corrected: llmResponse.corrected,
    changes,
    summary,
  };
}

/**
 * Execute grammar check with local LLM.
 */
export async function executeGrammarCheck(
  params: GrammarCheckParams,
  model: string
): Promise<ProductivityToolResult<GrammarCheckResult>> {
  const startTime = Date.now();

  // Validate text is not empty
  if (!params.text.trim()) {
    return {
      success: false,
      error: 'No hay texto para corregir',
      latencyMs: Date.now() - startTime,
    };
  }

  const prompt = buildGrammarPrompt(params);

  logger.debug('Executing grammar check', {
    textLength: params.text.length,
    language: params.language,
    model,
  });

  const result = await executeLocalIntent(
    'grammar_check',
    prompt,
    model,
    params.language ? { language: params.language } : undefined
  );

  if (!result.success) {
    return {
      success: false,
      error: result.error || 'Error en la corrección gramatical',
      latencyMs: result.latencyMs,
    };
  }

  // Try to extract JSON from response
  const extraction = extractJSON<GrammarCheckLLMResponse>(result.response, 'grammar_check');

  if (extraction.success && extraction.data && isValidGrammarResponse(extraction.data)) {
    // JSON extracted successfully
    const formatted = formatGrammarResult(extraction.data, params.text);

    logger.info('Grammar check complete', {
      changes: formatted.changes.length,
      strategy: extraction.strategy,
      latencyMs: result.latencyMs,
    });

    return {
      success: true,
      data: formatted,
      latencyMs: result.latencyMs,
    };
  }

  // JSON extraction failed - use raw text as corrected version
  logger.warn('Grammar check JSON extraction failed, using raw text fallback', {
    strategy: extraction.strategy,
    error: extraction.error,
  });

  recordExtractionFailure('grammar_check');

  // Use the raw response as the corrected text
  const fallbackResult: GrammarCheckResult = {
    original: params.text,
    corrected: extraction.rawText || result.response.trim(),
    changes: [],
    summary: '(Corrección aplicada, pero no pude detallar los cambios específicos)',
  };

  return {
    success: true,
    data: fallbackResult,
    latencyMs: result.latencyMs,
    disclaimer: 'No pude analizar los cambios específicos, pero el texto fue corregido.',
  };
}

/**
 * Format grammar check result for user display.
 */
export function formatGrammarCheckResult(result: GrammarCheckResult): string {
  let output = result.corrected;

  if (result.changes.length > 0) {
    output += '\n\n📝 Cambios realizados:';
    for (const change of result.changes) {
      output += `\n• "${change.original}" → "${change.corrected}"`;
      if (change.explanation) {
        output += ` (${change.explanation})`;
      }
    }
  }

  return output;
}

/**
 * Extract text to check from user input.
 */
export function extractTextToCheck(input: string): string {
  // Pattern: "corrige esto: [text]" or "fix this: [text]"
  const colonMatch = input.match(/(?:corrig[ea]|correct|fix|revisar?|check)[^:]*:\s*(.+)/is);
  if (colonMatch && colonMatch[1]) return colonMatch[1].trim();

  // Pattern: "corrige: [text]"
  const simpleMatch = input.match(/(?:corrig[ea]|correct|fix)\s+(.+)/is);
  if (simpleMatch && simpleMatch[1]) return simpleMatch[1].trim();

  // Fall back to full input
  return input;
}

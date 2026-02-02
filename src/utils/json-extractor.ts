/**
 * JSON Extractor - Fase 3.6b
 *
 * Robust JSON extraction from LLM responses.
 * Local 7B models often return malformed JSON, so we need multiple
 * extraction strategies with graceful fallback to raw text.
 */

import { createLogger } from './logger.js';

const logger = createLogger('json-extract');

/**
 * Extraction strategy used to parse the response.
 */
export type ExtractionStrategy =
  | 'direct'      // JSON.parse(response) worked directly
  | 'code_fence'  // Extracted from ```json ... ``` block
  | 'substring'   // Found { ... } or [ ... ] substring
  | 'repair'      // Fixed common issues (trailing commas, single quotes)
  | 'fallback_raw'; // Could not extract JSON, returning raw text

/**
 * Result of JSON extraction attempt.
 */
export interface ExtractionResult<T> {
  /** Whether JSON was successfully extracted */
  success: boolean;
  /** Parsed data (if success) */
  data?: T;
  /** Raw text (if JSON extraction failed) */
  rawText?: string;
  /** Error message (if failed) */
  error?: string;
  /** Strategy that succeeded (or fallback_raw if all failed) */
  strategy: ExtractionStrategy;
}

/**
 * Metrics for JSON extraction tracking.
 */
export interface JSONExtractionMetrics {
  total: number;
  byStrategy: Record<ExtractionStrategy, number>;
  failuresByTool: Record<string, number>;
}

// Global metrics tracker
const metrics: JSONExtractionMetrics = {
  total: 0,
  byStrategy: {
    direct: 0,
    code_fence: 0,
    substring: 0,
    repair: 0,
    fallback_raw: 0,
  },
  failuresByTool: {},
};

/**
 * Get current extraction metrics.
 */
export function getExtractionMetrics(): JSONExtractionMetrics {
  return { ...metrics, byStrategy: { ...metrics.byStrategy }, failuresByTool: { ...metrics.failuresByTool } };
}

/**
 * Reset extraction metrics.
 */
export function resetExtractionMetrics(): void {
  metrics.total = 0;
  metrics.byStrategy = {
    direct: 0,
    code_fence: 0,
    substring: 0,
    repair: 0,
    fallback_raw: 0,
  };
  metrics.failuresByTool = {};
}

/**
 * Record a failure for a specific tool.
 */
export function recordExtractionFailure(toolName: string): void {
  metrics.failuresByTool[toolName] = (metrics.failuresByTool[toolName] || 0) + 1;
}

/**
 * Try to parse JSON directly.
 */
function tryDirect<T>(response: string): T | null {
  try {
    return JSON.parse(response) as T;
  } catch {
    return null;
  }
}

/**
 * Try to extract JSON from markdown code fence.
 * Matches: ```json ... ``` or ``` ... ```
 */
function tryCodeFence<T>(response: string): T | null {
  const codeFenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!codeFenceMatch || !codeFenceMatch[1]) return null;

  try {
    return JSON.parse(codeFenceMatch[1].trim()) as T;
  } catch {
    return null;
  }
}

/**
 * Try to extract JSON from first { ... } or [ ... ] found.
 */
function trySubstring<T>(response: string): T | null {
  // Find the first { or [
  const objectStart = response.indexOf('{');
  const arrayStart = response.indexOf('[');

  let start: number;
  let endChar: string;

  if (objectStart === -1 && arrayStart === -1) return null;

  if (objectStart === -1) {
    start = arrayStart;
    endChar = ']';
  } else if (arrayStart === -1) {
    start = objectStart;
    endChar = '}';
  } else {
    // Take the first one
    if (objectStart < arrayStart) {
      start = objectStart;
      endChar = '}';
    } else {
      start = arrayStart;
      endChar = ']';
    }
  }

  // Find matching closing bracket using depth counting
  let depth = 0;
  let inString = false;
  let escape = false;
  const startChar = response[start];

  for (let i = start; i < response.length; i++) {
    const char = response[i];

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

    if (char === startChar) depth++;
    if (char === endChar) {
      depth--;
      if (depth === 0) {
        const jsonStr = response.slice(start, i + 1);
        try {
          return JSON.parse(jsonStr) as T;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Try to repair common JSON issues and parse.
 * Fixes: trailing commas, single quotes, unquoted keys.
 */
function tryRepair<T>(response: string): T | null {
  // Extract potential JSON first
  const jsonMatch = response.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!jsonMatch || !jsonMatch[1]) return null;

  let repaired = jsonMatch[1];

  // Fix trailing commas: }, } or ], ]
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  // Fix single quotes to double quotes (careful with apostrophes in text)
  // Only replace quotes that look like JSON string delimiters
  repaired = repaired.replace(/:\s*'([^']*)'/g, ': "$1"');
  repaired = repaired.replace(/,\s*'([^']*)'/g, ', "$1"');
  repaired = repaired.replace(/\[\s*'([^']*)'/g, '[ "$1"');

  // Fix unquoted keys: {key: or , key:
  repaired = repaired.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

  try {
    return JSON.parse(repaired) as T;
  } catch {
    return null;
  }
}

/**
 * Extract JSON from an LLM response using multiple strategies.
 *
 * Strategies are tried in order:
 * 1. direct - Direct JSON.parse()
 * 2. code_fence - Extract from ```json ... ```
 * 3. substring - Find first { ... } or [ ... ]
 * 4. repair - Fix common issues (trailing commas, quotes)
 * 5. fallback_raw - Return raw text with error
 *
 * @param response - Raw LLM response string
 * @param toolName - Optional tool name for failure tracking
 * @returns ExtractionResult with data or rawText
 */
export function extractJSON<T>(response: string, toolName?: string): ExtractionResult<T> {
  metrics.total++;

  const trimmed = response.trim();

  // Strategy 1: Direct parse
  const direct = tryDirect<T>(trimmed);
  if (direct !== null) {
    metrics.byStrategy.direct++;
    logger.debug('JSON extracted via direct parse');
    return { success: true, data: direct, strategy: 'direct' };
  }

  // Strategy 2: Code fence
  const codeFence = tryCodeFence<T>(response);
  if (codeFence !== null) {
    metrics.byStrategy.code_fence++;
    logger.debug('JSON extracted via code fence');
    return { success: true, data: codeFence, strategy: 'code_fence' };
  }

  // Strategy 3: Substring
  const substring = trySubstring<T>(response);
  if (substring !== null) {
    metrics.byStrategy.substring++;
    logger.debug('JSON extracted via substring');
    return { success: true, data: substring, strategy: 'substring' };
  }

  // Strategy 4: Repair
  const repaired = tryRepair<T>(response);
  if (repaired !== null) {
    metrics.byStrategy.repair++;
    logger.debug('JSON extracted via repair');
    return { success: true, data: repaired, strategy: 'repair' };
  }

  // Strategy 5: Fallback to raw text
  metrics.byStrategy.fallback_raw++;
  if (toolName) {
    recordExtractionFailure(toolName);
  }
  logger.warn('JSON extraction failed, falling back to raw text', {
    responsePreview: trimmed.slice(0, 100),
    toolName,
  });

  return {
    success: false,
    rawText: trimmed,
    error: 'No se pudo extraer JSON válido',
    strategy: 'fallback_raw',
  };
}

/**
 * Extract JSON with type validation.
 * Allows specifying a validator function to ensure the extracted data
 * matches the expected structure.
 *
 * @param response - Raw LLM response string
 * @param validator - Function to validate the parsed data
 * @param toolName - Optional tool name for failure tracking
 * @returns ExtractionResult with validated data or rawText
 */
export function extractJSONWithValidation<T>(
  response: string,
  validator: (data: unknown) => data is T,
  toolName?: string
): ExtractionResult<T> {
  const result = extractJSON<unknown>(response, toolName);

  if (!result.success) {
    return result as ExtractionResult<T>;
  }

  if (validator(result.data)) {
    return { ...result, data: result.data } as ExtractionResult<T>;
  }

  // Data was extracted but doesn't match expected structure
  metrics.byStrategy.fallback_raw++;
  if (toolName) {
    recordExtractionFailure(toolName);
  }
  logger.warn('JSON validation failed', {
    data: result.data,
    toolName,
  });

  return {
    success: false,
    rawText: response.trim(),
    error: 'JSON extraído pero no coincide con la estructura esperada',
    strategy: 'fallback_raw',
  };
}

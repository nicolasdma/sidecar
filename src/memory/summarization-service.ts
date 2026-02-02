/**
 * Summarization Service (Fase 2)
 *
 * Creates structured summaries of conversation segments when messages
 * exit the context window or when a topic shift is detected.
 *
 * Summaries are stored in 4 slots (FIFO eviction) and injected into
 * the system prompt to provide conversation continuity.
 */

import type { Message } from '../llm/types.js';
import {
  saveSummary,
  getActiveSummaries,
  getSummaryCount,
  getSystemStateJson,
  setSystemStateJson,
  type SummaryRow,
  type SummaryData,
} from './store.js';
import { generateWithOllama, checkOllamaAvailability, cleanJsonResponse } from '../llm/ollama.js';
import { createLogger } from '../utils/logger.js';
import { parseSummary, safeJsonParse, type Summary as ZodSummary } from './schemas.js';

const logger = createLogger('summarization');

// Summarization prompt (English for token efficiency)
const SUMMARIZATION_PROMPT = `Summarize these conversation messages into structured JSON.
Output ONLY valid JSON, no markdown, no explanations.

Format:
{"topic": "main topic (2-3 words)", "discussed": ["point1", "point2"], "outcome": "conclusion if any", "decisions": ["decision made"], "open_questions": ["unresolved question"]}

Use null for fields with no content (outcome, decisions, open_questions).
Keep discussed points concise (max 10 words each).
Maximum 5 discussed points, 3 decisions, 3 open questions.

Messages:
`;

// ============================================================================
// Circuit Breaker (Fase 3.6 - Track B hardening)
// Prevents excessive summarization attempts when Ollama is consistently failing.
// ============================================================================

interface SummarizationCircuitState {
  consecutiveFailures: number;
  circuitOpenUntil: number | null;
  lastError: string | null;
}

const CIRCUIT_CONFIG = {
  failureThreshold: 5,    // Open circuit after 5 consecutive failures
  resetTimeMs: 60_000,    // Keep circuit open for 1 minute
};

let circuitState: SummarizationCircuitState = {
  consecutiveFailures: 0,
  circuitOpenUntil: null,
  lastError: null,
};

let circuitRestored = false;

/**
 * Checks if the circuit breaker is open (blocking requests).
 * Also restores state on first call if not already done.
 */
function isCircuitOpen(): boolean {
  // Lazy restore on first check
  if (!circuitRestored) {
    restoreCircuitState();
    circuitRestored = true;
  }

  if (!circuitState.circuitOpenUntil) return false;

  if (Date.now() >= circuitState.circuitOpenUntil) {
    // Reset circuit - allow retry
    circuitState.circuitOpenUntil = null;
    circuitState.consecutiveFailures = 0;
    circuitState.lastError = null;
    persistCircuitState();
    logger.info('Summarization circuit breaker reset, allowing retries');
    return false;
  }

  return true;
}

/**
 * Records a successful summarization, resetting the circuit breaker.
 */
function recordCircuitSuccess(): void {
  if (circuitState.consecutiveFailures > 0) {
    logger.debug('Summarization circuit success, resetting failure count');
  }
  circuitState.consecutiveFailures = 0;
  circuitState.lastError = null;
  if (circuitState.circuitOpenUntil !== null) {
    circuitState.circuitOpenUntil = null;
    persistCircuitState();
  }
}

/**
 * Records a summarization failure. Opens circuit if threshold exceeded.
 */
function recordCircuitFailure(error: string): void {
  circuitState.consecutiveFailures++;
  circuitState.lastError = error;

  if (circuitState.consecutiveFailures >= CIRCUIT_CONFIG.failureThreshold) {
    circuitState.circuitOpenUntil = Date.now() + CIRCUIT_CONFIG.resetTimeMs;
    logger.warn('Summarization circuit breaker OPENED', {
      failures: circuitState.consecutiveFailures,
      resetAt: new Date(circuitState.circuitOpenUntil).toISOString(),
      lastError: error,
    });
    persistCircuitState();
  }
}

/**
 * Persists circuit breaker state to SQLite (survives restarts).
 */
function persistCircuitState(): void {
  try {
    setSystemStateJson('summarization_circuit_breaker', {
      consecutiveFailures: circuitState.consecutiveFailures,
      circuitOpenUntil: circuitState.circuitOpenUntil,
      lastError: circuitState.lastError,
    });
  } catch (error) {
    logger.warn('Failed to persist summarization circuit state', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
  }
}

/**
 * Restores circuit breaker state from SQLite on startup.
 */
function restoreCircuitState(): void {
  try {
    const persisted = getSystemStateJson<{
      consecutiveFailures: number;
      circuitOpenUntil: number | null;
      lastError: string | null;
    }>('summarization_circuit_breaker');

    if (persisted) {
      if (persisted.circuitOpenUntil && persisted.circuitOpenUntil > Date.now()) {
        circuitState = {
          consecutiveFailures: persisted.consecutiveFailures,
          circuitOpenUntil: persisted.circuitOpenUntil,
          lastError: persisted.lastError,
        };
        logger.info('Restored summarization circuit breaker state', {
          failures: persisted.consecutiveFailures,
          openUntil: new Date(persisted.circuitOpenUntil).toISOString(),
        });
      } else if (persisted.consecutiveFailures > 0) {
        circuitState.consecutiveFailures = persisted.consecutiveFailures;
        circuitState.lastError = persisted.lastError;
        logger.debug('Restored summarization failure count (circuit expired)', {
          failures: persisted.consecutiveFailures,
        });
      }
    }
  } catch (error) {
    logger.warn('Failed to restore summarization circuit state', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
  }
}

/**
 * Formats messages for the summarization prompt.
 */
function formatMessagesForPrompt(messages: Message[]): string {
  return messages
    .map(m => {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Tool';
      const content = m.content?.slice(0, 500) || '[no content]';
      return `${role}: ${content}`;
    })
    .join('\n\n');
}

/**
 * Converts Zod-validated summary to SummaryData for storage.
 */
function toSummaryData(summary: ZodSummary): SummaryData {
  return {
    topic: summary.topic,
    discussed: summary.discussed,
    outcome: summary.outcome ?? undefined,
    decisions: summary.decisions ?? undefined,
    openQuestions: summary.open_questions ?? undefined,
    turnStart: 0, // Will be set by caller
    turnEnd: 0,   // Will be set by caller
  };
}

/**
 * Extracts message IDs for turn tracking.
 * Since messages may not have IDs in the Message type, we use position.
 */
function getMessageRange(messages: Message[], offset: number = 0): { start: number; end: number } {
  return {
    start: offset,
    end: offset + messages.length - 1,
  };
}

/**
 * Summarizes a batch of messages and stores the summary.
 * Fire-and-forget: errors are logged but don't propagate.
 *
 * @param messages - Messages to summarize
 * @param turnOffset - Offset for turn numbering
 */
export async function summarizeMessages(
  messages: Message[],
  turnOffset: number = 0
): Promise<void> {
  try {
    // Skip if too few messages
    if (messages.length < 2) {
      logger.debug('Too few messages to summarize', { count: messages.length });
      return;
    }

    // Check circuit breaker first
    if (isCircuitOpen()) {
      logger.debug('Summarization circuit open, skipping');
      return;
    }

    // Check Ollama availability
    const availability = await checkOllamaAvailability();
    if (!availability.available) {
      logger.warn('Ollama not available, skipping summarization');
      return;
    }

    // Format messages
    const formattedMessages = formatMessagesForPrompt(messages);
    const prompt = SUMMARIZATION_PROMPT + formattedMessages;

    // Generate response from Ollama
    const rawResponse = await generateWithOllama(prompt);
    const cleanedResponse = cleanJsonResponse(rawResponse);

    // Parse JSON
    const parsed = safeJsonParse(cleanedResponse);
    if (parsed === null) {
      logger.warn('Failed to parse JSON from summary response', {
        response: cleanedResponse.slice(0, 200),
      });
      recordCircuitFailure('JSON parse error');
      return;
    }

    // Validate with Zod schema
    const validatedSummary = parseSummary(parsed, logger);
    if (!validatedSummary) {
      logger.warn('Invalid summary from LLM');
      recordCircuitFailure('Schema validation error');
      return;
    }

    // Convert to storage format
    const summary = toSummaryData(validatedSummary);

    // Set turn range
    const range = getMessageRange(messages, turnOffset);
    summary.turnStart = range.start;
    summary.turnEnd = range.end;

    // Save
    const slot = saveSummary(summary);
    logger.info('Summary saved', {
      slot,
      topic: summary.topic,
      points: summary.discussed.length,
    });

    // Success - reset circuit breaker
    recordCircuitSuccess();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Summarization failed', { error: message });
    recordCircuitFailure(message);
  }
}

/**
 * Formats stored summaries for inclusion in the system prompt.
 * Returns empty string if no summaries exist.
 */
export function formatSummariesForPrompt(): string {
  const summaries = getActiveSummaries();

  if (summaries.length === 0) {
    return '';
  }

  const lines: string[] = ['## Previous Conversation Context'];

  for (const summary of summaries) {
    lines.push('');
    lines.push(`### ${summary.topic}`);

    // Discussed points
    const discussed = parseJsonArray(summary.discussed);
    if (discussed.length > 0) {
      lines.push('Discussed:');
      for (const point of discussed) {
        lines.push(`- ${point}`);
      }
    }

    // Outcome
    if (summary.outcome) {
      lines.push(`Outcome: ${summary.outcome}`);
    }

    // Decisions
    const decisions = summary.decisions ? parseJsonArray(summary.decisions) : [];
    if (decisions.length > 0) {
      lines.push('Decisions:');
      for (const decision of decisions) {
        lines.push(`- ${decision}`);
      }
    }

    // Open questions
    const openQuestions = summary.open_questions ? parseJsonArray(summary.open_questions) : [];
    if (openQuestions.length > 0) {
      lines.push('Open questions:');
      for (const question of openQuestions) {
        lines.push(`- ${question}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Parses a JSON string array, handling errors gracefully.
 */
function parseJsonArray(jsonStr: string): string[] {
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return parsed.filter(item => typeof item === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Gets summary statistics including circuit breaker state.
 */
export function getSummaryStats(): {
  count: number;
  maxSlots: number;
  circuitBreaker: {
    isOpen: boolean;
    consecutiveFailures: number;
    openUntil: string | null;
    lastError: string | null;
  };
} {
  return {
    count: getSummaryCount(),
    maxSlots: 4,
    circuitBreaker: {
      isOpen: isCircuitOpen(),
      consecutiveFailures: circuitState.consecutiveFailures,
      openUntil: circuitState.circuitOpenUntil
        ? new Date(circuitState.circuitOpenUntil).toISOString()
        : null,
      lastError: circuitState.lastError,
    },
  };
}

/**
 * Converts a SummaryRow to a more usable format.
 */
export function parseSummaryRow(row: SummaryRow): {
  slot: number;
  topic: string;
  discussed: string[];
  outcome: string | null;
  decisions: string[];
  openQuestions: string[];
  turnStart: number;
  turnEnd: number;
} {
  return {
    slot: row.slot,
    topic: row.topic,
    discussed: parseJsonArray(row.discussed),
    outcome: row.outcome,
    decisions: row.decisions ? parseJsonArray(row.decisions) : [],
    openQuestions: row.open_questions ? parseJsonArray(row.open_questions) : [],
    turnStart: row.turn_start,
    turnEnd: row.turn_end,
  };
}

/**
 * Gets all summaries in parsed format.
 */
export function getParsedSummaries(): ReturnType<typeof parseSummaryRow>[] {
  const rows = getActiveSummaries();
  return rows.map(parseSummaryRow);
}

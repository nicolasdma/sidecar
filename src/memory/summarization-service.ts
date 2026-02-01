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
  type SummaryRow,
  type SummaryData,
} from './store.js';
import { generateJsonWithOllama, checkOllamaAvailability } from '../llm/ollama.js';
import { createLogger } from '../utils/logger.js';

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

interface RawSummary {
  topic: string;
  discussed: string[];
  outcome?: string | null;
  decisions?: string[] | null;
  open_questions?: string[] | null;
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
 * Validates and normalizes a raw summary from LLM.
 */
function validateSummary(raw: RawSummary): SummaryData | null {
  if (!raw.topic || typeof raw.topic !== 'string') {
    logger.warn('Invalid summary: missing topic');
    return null;
  }

  if (!raw.discussed || !Array.isArray(raw.discussed) || raw.discussed.length === 0) {
    logger.warn('Invalid summary: missing discussed points');
    return null;
  }

  // Normalize and limit arrays
  const discussed = raw.discussed
    .filter(d => typeof d === 'string' && d.trim())
    .slice(0, 5)
    .map(d => d.trim().slice(0, 100));

  const decisions = raw.decisions
    ?.filter(d => typeof d === 'string' && d.trim())
    .slice(0, 3)
    .map(d => d.trim().slice(0, 100));

  const openQuestions = raw.open_questions
    ?.filter(q => typeof q === 'string' && q.trim())
    .slice(0, 3)
    .map(q => q.trim().slice(0, 100));

  return {
    topic: raw.topic.trim().slice(0, 50),
    discussed,
    outcome: raw.outcome?.trim().slice(0, 200) || undefined,
    decisions: decisions?.length ? decisions : undefined,
    openQuestions: openQuestions?.length ? openQuestions : undefined,
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

    // Check Ollama availability
    const availability = await checkOllamaAvailability();
    if (!availability.available) {
      logger.warn('Ollama not available, skipping summarization');
      return;
    }

    // Format messages
    const formattedMessages = formatMessagesForPrompt(messages);
    const prompt = SUMMARIZATION_PROMPT + formattedMessages;

    // Generate summary
    const rawSummary = await generateJsonWithOllama<RawSummary>(prompt);

    if (!rawSummary) {
      logger.warn('Failed to generate summary');
      return;
    }

    // Validate
    const summary = validateSummary(rawSummary);
    if (!summary) {
      logger.warn('Invalid summary from LLM');
      return;
    }

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
  } catch (error) {
    logger.error('Summarization failed', { error });
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
 * Gets summary statistics.
 */
export function getSummaryStats(): {
  count: number;
  maxSlots: number;
} {
  return {
    count: getSummaryCount(),
    maxSlots: 4,
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

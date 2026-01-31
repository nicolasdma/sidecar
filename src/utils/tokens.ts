/**
 * Issue #6: Centralized token estimation utilities.
 *
 * All token estimation should use these functions to ensure consistency
 * across the codebase.
 */

import type { Message } from '../llm/types.js';

/**
 * Approximate characters per token.
 * This is a rough estimate that works reasonably well for mixed content.
 * Real tokenization varies by model and content type.
 */
const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Estimates the number of tokens in a text string.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

/**
 * Estimates the number of tokens in a message.
 * Accounts for message overhead and tool calls.
 *
 * @param message - The message to estimate tokens for
 * @returns Estimated token count including overhead
 */
export function estimateMessageTokens(message: Message): number {
  let tokens = estimateTokens(message.content);

  // Message format overhead (role, separators, etc.)
  tokens += 4;

  // Tool calls add additional tokens
  if (message.role === 'assistant' && message.tool_calls) {
    tokens += estimateTokens(JSON.stringify(message.tool_calls));
  }

  return tokens;
}

/**
 * Estimates the total tokens for an array of messages.
 *
 * @param messages - Array of messages to estimate
 * @returns Total estimated token count
 */
export function estimateTotalTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/**
 * Token budget constants for context window management.
 */
export const TOKEN_BUDGETS = {
  /** Reserved tokens for system prompt */
  SYSTEM_PROMPT_RESERVE: 4000,
  /** Reserved tokens for response generation */
  RESPONSE_RESERVE: 4000,
  /** Default max context tokens */
  DEFAULT_MAX_CONTEXT: 100000,
  /** Max tokens for learnings in prompt */
  MAX_LEARNINGS_TOKENS: 600,
} as const;

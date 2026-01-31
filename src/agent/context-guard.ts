import type { Message } from '../llm/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('context');

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 100000;
const SYSTEM_PROMPT_RESERVE = 4000;
const RESPONSE_RESERVE = 4000;

function estimateTokens(text: string | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function estimateMessageTokens(message: Message): number {
  let tokens = estimateTokens(message.content);

  tokens += 4;

  if (message.role === 'assistant' && message.tool_calls) {
    tokens += estimateTokens(JSON.stringify(message.tool_calls));
  }

  return tokens;
}

function estimateTotalTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

export interface ContextGuardResult {
  messages: Message[];
  truncated: boolean;
  originalCount: number;
  finalCount: number;
  estimatedTokens: number;
}

export function truncateMessages(
  messages: Message[],
  maxTokens: number = DEFAULT_MAX_TOKENS
): ContextGuardResult {
  const availableTokens = maxTokens - SYSTEM_PROMPT_RESERVE - RESPONSE_RESERVE;

  const totalTokens = estimateTotalTokens(messages);

  if (totalTokens <= availableTokens) {
    return {
      messages,
      truncated: false,
      originalCount: messages.length,
      finalCount: messages.length,
      estimatedTokens: totalTokens,
    };
  }

  logger.info(`Context too large (${totalTokens} tokens), truncating...`);

  const truncated: Message[] = [];
  let currentTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    const msgTokens = estimateMessageTokens(msg);

    if (currentTokens + msgTokens > availableTokens) {
      break;
    }

    truncated.unshift(msg);
    currentTokens += msgTokens;
  }

  if (truncated.length === 0 && messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      truncated.push(lastMsg);
      currentTokens = estimateMessageTokens(lastMsg);
    }
  }

  logger.info(`Truncated from ${messages.length} to ${truncated.length} messages`);

  return {
    messages: truncated,
    truncated: true,
    originalCount: messages.length,
    finalCount: truncated.length,
    estimatedTokens: currentTokens,
  };
}

export function checkContextSize(
  messages: Message[],
  maxTokens: number = DEFAULT_MAX_TOKENS
): { withinLimit: boolean; estimatedTokens: number; availableTokens: number } {
  const availableTokens = maxTokens - SYSTEM_PROMPT_RESERVE - RESPONSE_RESERVE;
  const estimatedTokens = estimateTotalTokens(messages);

  return {
    withinLimit: estimatedTokens <= availableTokens,
    estimatedTokens,
    availableTokens,
  };
}

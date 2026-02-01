/**
 * Fase 3: Semantic Continuity
 *
 * Calculates conversation continuity for adaptive context window sizing.
 * Uses embeddings to measure topic similarity between current and recent messages.
 */

import type { Message } from '../llm/types.js';
import { createLogger } from '../utils/logger.js';
import { embedText, isModelReady } from './embeddings-model.js';
import { isEmbeddingsReady } from './embeddings-state.js';
import { cosineSimilarity, calculateCentroid } from './vector-math.js';

const logger = createLogger('semantic-continuity');

/**
 * Result of continuity calculation.
 */
export interface ContinuityResult {
  /** Continuity score between 0.0 and 1.0 */
  score: number;
  /** Recommended window size: 4, 6, or 8 turns */
  windowSize: number;
  /** Reason for the result */
  reason: 'bootstrap' | 'embeddings_disabled' | 'calculated' | 'error';
}

/**
 * Default result for bootstrap or error cases.
 */
const DEFAULT_RESULT: ContinuityResult = {
  score: 0.5,
  windowSize: 6,
  reason: 'bootstrap',
};

/**
 * Maps continuity score to recommended window size.
 *
 * - Low continuity (< 0.3): Topic changed, smaller window
 * - Medium continuity (0.3 - 0.7): Normal window
 * - High continuity (> 0.7): Same topic, larger window
 */
function scoreToWindowSize(score: number): number {
  if (score < 0.3) return 4;   // Low continuity = smaller window
  if (score > 0.7) return 8;   // High continuity = larger window
  return 6;                     // Default
}

/**
 * Extracts user message content from a Message array.
 */
function getUserMessages(messages: Message[]): string[] {
  return messages
    .filter(m => m.role === 'user' && m.content)
    .map(m => m.content as string);
}

/**
 * Calculates semantic continuity between current message and recent context.
 *
 * Formula: cosine(embed(currentMessage), centroid(embed(last3UserMessages)))
 *
 * Bootstrap behavior:
 * - turns < 3: return { score: 0.5, windowSize: 6, reason: 'bootstrap' }
 * - No embeddings: return { score: 0.5, windowSize: 6, reason: 'embeddings_disabled' }
 *
 * @param currentMessage - The current user message
 * @param previousMessages - Previous messages in the conversation
 * @returns Continuity result with score, window size, and reason
 */
export async function calculateSemanticContinuity(
  currentMessage: string,
  previousMessages: Message[]
): Promise<ContinuityResult> {
  // Extract user messages only
  const userMessages = getUserMessages(previousMessages);

  // Bootstrap case: need at least 3 previous user messages
  if (userMessages.length < 3) {
    logger.debug('Continuity: bootstrap mode', { userMessageCount: userMessages.length });
    return { ...DEFAULT_RESULT, reason: 'bootstrap' };
  }

  // Embeddings not ready case
  if (!isEmbeddingsReady() || !isModelReady()) {
    logger.debug('Continuity: embeddings not ready');
    return { ...DEFAULT_RESULT, reason: 'embeddings_disabled' };
  }

  try {
    // Get last 3 user messages
    const recentMessages = userMessages.slice(-3);

    // Embed current message and recent messages
    const currentEmbed = await embedText(currentMessage);
    const recentEmbeds = await Promise.all(
      recentMessages.map(msg => embedText(msg))
    );

    // Calculate centroid of recent messages
    const centroid = calculateCentroid(recentEmbeds);

    // Calculate cosine similarity
    const score = cosineSimilarity(currentEmbed, centroid);

    // Normalize score to 0-1 range (cosine can be negative)
    const normalizedScore = (score + 1) / 2;

    // Map to window size
    const windowSize = scoreToWindowSize(normalizedScore);

    logger.debug('Continuity calculated', {
      score: normalizedScore.toFixed(3),
      rawScore: score.toFixed(3),
      windowSize,
    });

    return {
      score: normalizedScore,
      windowSize,
      reason: 'calculated',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('Continuity calculation failed', { error: message });
    return { ...DEFAULT_RESULT, reason: 'error' };
  }
}

/**
 * Gets the recommended context window size for the current conversation state.
 * Simplified interface for context-guard.ts.
 *
 * @param currentMessage - The current user message
 * @param previousMessages - Previous messages in the conversation
 * @returns Recommended window size (4, 6, or 8)
 */
export async function getAdaptiveWindowSize(
  currentMessage: string | undefined,
  previousMessages: Message[]
): Promise<number> {
  if (!currentMessage) {
    return DEFAULT_RESULT.windowSize;
  }

  const result = await calculateSemanticContinuity(currentMessage, previousMessages);
  return result.windowSize;
}

/**
 * Detects if the current message represents a topic shift.
 * A topic shift occurs when continuity score is below threshold.
 *
 * @param currentMessage - The current user message
 * @param previousMessages - Previous messages in the conversation
 * @param threshold - Score below which indicates topic shift (default: 0.3)
 * @returns true if topic shift detected
 */
export async function detectTopicShiftByEmbeddings(
  currentMessage: string,
  previousMessages: Message[],
  threshold: number = 0.3
): Promise<boolean> {
  const result = await calculateSemanticContinuity(currentMessage, previousMessages);

  if (result.reason !== 'calculated') {
    // Can't determine topic shift without embeddings
    return false;
  }

  return result.score < threshold;
}

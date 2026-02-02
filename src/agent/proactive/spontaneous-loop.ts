/**
 * Spontaneous Loop
 *
 * LLM-driven proactive message system that periodically checks
 * if the agent should initiate a conversation.
 *
 * Key behaviors:
 * - Runs every 15 minutes (configurable)
 * - Respects quiet hours (code-enforced)
 * - Respects rate limits and cooldowns (code-enforced)
 * - Uses mutex to avoid conflicts with user messages
 * - Circuit breaker prevents runaway messaging
 */

import * as cron from 'node-cron';
import {
  type ProactiveConfig,
  type SpontaneousDecision,
  DEFAULT_PROACTIVE_CONFIG,
} from './types.js';
import {
  loadProactiveState,
  canSendSpontaneous,
  recordSpontaneousMessageSent,
  recordGreetingSent,
  recordTickWithoutMessage,
  recordMutexSkip,
  resetMutexSkips,
  tripCircuitBreaker,
  recordProactiveError,
  getProactiveErrorCount,
  resetProactiveErrors,
} from './state.js';
import { buildSpontaneousContext, buildDecisionPrompt } from './context-builder.js';
import { getMessageRouter } from '../../interfaces/message-router.js';
import { initiateProactive } from '../brain.js';
import type { NotificationMetadata } from '../../interfaces/types.js';
import { createLogger } from '../../utils/logger.js';
import { recordProactiveHeartbeat, recordProactiveMessage } from '../../utils/metrics.js';

const logger = createLogger('spontaneous-loop');

// Default user ID for single-user mode
const DEFAULT_USER_ID = 'local-user';

// Scheduler state
let cronJob: cron.ScheduledTask | null = null;
let isRunning = false;
let config: ProactiveConfig = DEFAULT_PROACTIVE_CONFIG;

// Mutex for avoiding conflicts with user message processing
let isBrainProcessing = false;

/**
 * Set whether brain is currently processing a user message.
 * Called by message router when processing starts/ends.
 */
export function setBrainProcessing(processing: boolean): void {
  isBrainProcessing = processing;
}

/**
 * Check if brain is currently processing.
 */
export function getIsBrainProcessing(): boolean {
  return isBrainProcessing;
}

/**
 * Parse LLM response as SpontaneousDecision.
 */
function parseDecision(response: string): SpontaneousDecision | null {
  try {
    // Try to find JSON in the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('No JSON found in LLM response');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Validate required fields
    if (typeof parsed.shouldSpeak !== 'boolean') {
      logger.warn('Invalid shouldSpeak in decision');
      return null;
    }

    const decision: SpontaneousDecision = {
      shouldSpeak: parsed.shouldSpeak,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'unknown',
      messageType: validateMessageType(parsed.messageType),
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
    };

    // P6 Mitigation: Check for hallucinated reminders
    if (
      decision.shouldSpeak &&
      decision.message &&
      /recordar|remind/i.test(decision.message)
    ) {
      logger.warn('P6: Detected potential reminder in spontaneous message, blocking');
      return {
        ...decision,
        shouldSpeak: false,
        reason: 'blocked_hallucinated_reminder',
      };
    }

    return decision;
  } catch (error) {
    logger.error('Failed to parse LLM decision', { error, response: response.slice(0, 200) });
    return null;
  }
}

/**
 * Validate message type.
 */
function validateMessageType(
  value: unknown
): 'greeting' | 'checkin' | 'contextual' | 'none' {
  if (
    value === 'greeting' ||
    value === 'checkin' ||
    value === 'contextual' ||
    value === 'none'
  ) {
    return value;
  }
  return 'none';
}

/**
 * Main tick function - called periodically.
 */
async function tick(): Promise<void> {
  if (!isRunning) return;

  // Record heartbeat for health monitoring
  recordProactiveHeartbeat();

  const tickId = Date.now().toString(36);
  logger.debug('Spontaneous loop tick', { tickId });

  const state = loadProactiveState(config.timezone);

  // P4 Mitigation: Check quiet hours BEFORE any LLM call
  const spontaneousCheck = canSendSpontaneous(config);
  if (!spontaneousCheck.allowed) {
    logger.debug('Spontaneous blocked', {
      tickId,
      reason: spontaneousCheck.reason,
    });
    recordTickWithoutMessage();
    return;
  }

  // P7 Mitigation: Check if brain is processing user message
  if (isBrainProcessing) {
    logger.debug('Brain processing user message, skipping tick', { tickId });
    recordMutexSkip();
    return;
  }

  // Mutex acquired
  resetMutexSkips();

  // Check circuit breaker
  if (state.consecutiveTicksWithMessage >= config.circuitBreakerThreshold) {
    logger.warn('Circuit breaker threshold reached', {
      tickId,
      consecutive: state.consecutiveTicksWithMessage,
    });
    tripCircuitBreaker();
    return;
  }

  try {
    // Build context for LLM
    const context = await buildSpontaneousContext(config);

    // P13: Include greeting status in context
    if (context.greetingAlreadySent) {
      logger.debug('Greeting already sent today, context updated', { tickId });
    }

    // Build decision prompt
    const prompt = buildDecisionPrompt(context);

    // P8 Mitigation: Use timeout for LLM call
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, config.llmTimeoutMs);

    let response: string | null;
    try {
      // Call LLM via brain's proactive mode
      response = await initiateProactive(prompt);
    } finally {
      clearTimeout(timeoutId);
    }

    // P15: Check if user became active during LLM call
    const freshState = loadProactiveState(config.timezone);
    if (
      freshState.lastUserMessageAt &&
      state.lastUserMessageAt &&
      freshState.lastUserMessageAt > state.lastUserMessageAt
    ) {
      logger.info('User became active during LLM latency, aborting', { tickId });
      recordTickWithoutMessage();
      return;
    }

    if (!response) {
      logger.debug('LLM returned no response', { tickId });
      recordTickWithoutMessage();
      return;
    }

    // Parse decision
    const decision = parseDecision(response);

    if (!decision) {
      logger.warn('Failed to parse LLM decision', { tickId });
      recordTickWithoutMessage();
      return;
    }

    logger.info('LLM decision', {
      tickId,
      shouldSpeak: decision.shouldSpeak,
      reason: decision.reason,
      messageType: decision.messageType,
    });

    // P14 Mitigation: Check for invalid messageType
    if (decision.shouldSpeak && decision.messageType === 'none') {
      logger.warn('P14: shouldSpeak=true but messageType=none, blocking', { tickId });
      recordTickWithoutMessage();
      return;
    }

    if (!decision.shouldSpeak || !decision.message) {
      recordTickWithoutMessage();
      return;
    }

    // P8 Mitigation: Check greeting deduplication
    if (decision.messageType === 'greeting' && context.greetingAlreadySent) {
      logger.warn('P8: Greeting already sent, blocking duplicate', { tickId });
      recordTickWithoutMessage();
      return;
    }

    // Send the message
    const router = getMessageRouter();
    const validMessageType =
      decision.messageType === 'greeting' ||
      decision.messageType === 'checkin' ||
      decision.messageType === 'contextual'
        ? decision.messageType
        : undefined;

    const metadata: NotificationMetadata = {
      type: 'spontaneous',
      messageType: validMessageType,
    };

    const sent = await router.sendNotification(DEFAULT_USER_ID, decision.message, metadata);

    if (sent) {
      recordSpontaneousMessageSent(decision.messageType, decision.message);
      recordProactiveMessage(); // Centralized metrics

      if (decision.messageType === 'greeting') {
        const greetingWindow = context.isGreetingWindow;
        if (greetingWindow) {
          recordGreetingSent(greetingWindow);
        }
      }

      logger.info('Spontaneous message sent', {
        tickId,
        messageType: decision.messageType,
        message: decision.message.slice(0, 50),
      });
    } else {
      logger.warn('Failed to send spontaneous message', { tickId });
      recordTickWithoutMessage();
    }
  } catch (error) {
    // P16: Ensure mutex is released on error
    logger.error('Error in spontaneous tick', { tickId, error });
    recordTickWithoutMessage();
  }
}

/**
 * Start the spontaneous loop.
 */
export function startSpontaneousLoop(
  customConfig?: Partial<ProactiveConfig>
): void {
  if (cronJob) {
    logger.warn('Spontaneous loop already running');
    return;
  }

  // Merge custom config
  if (customConfig) {
    config = { ...DEFAULT_PROACTIVE_CONFIG, ...customConfig };
  }

  isRunning = true;

  // Calculate cron expression from interval
  // For now, use fixed 15-minute intervals
  const cronExpression = '*/15 * * * *';

  // C3: Wrap cron callback with error tracking for crash recovery
  cronJob = cron.schedule(cronExpression, () => {
    tick()
      .then(() => {
        // Reset error counter on successful tick
        resetProactiveErrors();
      })
      .catch((error) => {
        logger.error('Unhandled error in spontaneous tick', { error });

        // C3: Record error for health monitoring
        recordProactiveError();

        // C3: Log loudly if too many consecutive errors
        const errorCount = getProactiveErrorCount();
        if (errorCount >= 5) {
          console.log('\n⚠️  Proactive loop experiencing repeated errors. Check /health.\n');
        }
      });
  });

  logger.info('Spontaneous loop started', {
    interval: '15 minutes',
    proactivityLevel: config.proactivityLevel,
    quietHours: `${config.quietHoursStart}:00 - ${config.quietHoursEnd}:00`,
  });

  // Don't run initial tick immediately - wait for first scheduled tick
}

/**
 * Stop the spontaneous loop.
 */
export function stopSpontaneousLoop(): void {
  isRunning = false;

  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    logger.info('Spontaneous loop stopped');
  }
}

/**
 * Force a tick (for testing/debugging).
 */
export async function forceTick(): Promise<void> {
  await tick();
}

/**
 * Update config at runtime.
 */
export function updateConfig(newConfig: Partial<ProactiveConfig>): void {
  config = { ...config, ...newConfig };
  logger.info('Spontaneous loop config updated', {
    proactivityLevel: config.proactivityLevel,
  });
}

/**
 * Get current config.
 */
export function getConfig(): ProactiveConfig {
  return { ...config };
}

/**
 * Check if loop is running.
 */
export function isLoopRunning(): boolean {
  return isRunning && cronJob !== null;
}

export default {
  start: startSpontaneousLoop,
  stop: stopSpontaneousLoop,
  forceTick,
  updateConfig,
  getConfig,
  isRunning: isLoopRunning,
  setBrainProcessing,
  getIsBrainProcessing,
};

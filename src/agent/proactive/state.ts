/**
 * Proactive State Management
 *
 * Manages persistent state for the proactive system:
 * - Rate limiting counters
 * - Circuit breaker state
 * - Activity tracking
 * - Greeting deduplication
 */

import {
  getProactiveState,
  initializeProactiveState,
  updateProactiveState as dbUpdateProactiveState,
  countSpontaneousMessagesInLastHour,
  countSpontaneousMessagesToday,
  getLastSpontaneousMessageTime,
  recordSpontaneousMessage,
  type ProactiveStateRow,
} from '../../memory/store.js';
import {
  type ProactiveState,
  type ProactiveConfig,
  INITIAL_PROACTIVE_STATE,
  DEFAULT_PROACTIVE_CONFIG,
  isWithinQuietHours,
  getGreetingWindow,
} from './types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('proactive-state');

/**
 * Convert database row to ProactiveState object.
 */
function rowToState(row: ProactiveStateRow): ProactiveState {
  return {
    lastSpontaneousMessageAt: row.last_spontaneous_message_at
      ? new Date(row.last_spontaneous_message_at)
      : null,
    lastReminderMessageAt: row.last_reminder_message_at
      ? new Date(row.last_reminder_message_at)
      : null,
    spontaneousCountToday: row.spontaneous_count_today,
    spontaneousCountThisHour: row.spontaneous_count_this_hour,
    dateOfLastDailyCount: row.date_of_last_daily_count,
    hourOfLastHourlyCount: row.hour_of_last_hourly_count,
    consecutiveTicksWithMessage: row.consecutive_ticks_with_message,
    circuitBreakerTrippedUntil: row.circuit_breaker_tripped_until
      ? new Date(row.circuit_breaker_tripped_until)
      : null,
    consecutiveMutexSkips: row.consecutive_mutex_skips,
    lastUserMessageAt: row.last_user_message_at
      ? new Date(row.last_user_message_at)
      : null,
    lastUserActivityAt: row.last_user_activity_at
      ? new Date(row.last_user_activity_at)
      : null,
    lastGreetingType: row.last_greeting_type as ProactiveState['lastGreetingType'],
    lastGreetingDate: row.last_greeting_date,
    quietModeUntil: row.quiet_mode_until
      ? new Date(row.quiet_mode_until)
      : null,
  };
}

/**
 * Load proactive state from database.
 * Initializes if not exists.
 * Performs lazy reset of counters if date/hour changed.
 */
export function loadProactiveState(_timezone: string = 'UTC'): ProactiveState {
  // Ensure table has initial row
  initializeProactiveState();

  const row = getProactiveState();
  if (!row) {
    logger.warn('Failed to load proactive state, using initial state');
    return { ...INITIAL_PROACTIVE_STATE };
  }

  const state = rowToState(row);

  // Lazy reset of counters
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const currentHour = now.getHours();

  let needsUpdate = false;
  const updates: Partial<ProactiveState> = {};

  // Reset daily counter if date changed
  if (state.dateOfLastDailyCount !== todayStr) {
    logger.debug('Resetting daily spontaneous counter (new day)');
    updates.spontaneousCountToday = 0;
    updates.dateOfLastDailyCount = todayStr;
    needsUpdate = true;
  }

  // Reset hourly counter if hour changed
  if (state.hourOfLastHourlyCount !== currentHour) {
    logger.debug('Resetting hourly spontaneous counter (new hour)');
    updates.spontaneousCountThisHour = 0;
    updates.hourOfLastHourlyCount = currentHour;
    needsUpdate = true;
  }

  // Check if circuit breaker should be cleared
  if (
    state.circuitBreakerTrippedUntil &&
    state.circuitBreakerTrippedUntil <= now
  ) {
    logger.info('Circuit breaker cooldown expired, clearing');
    updates.circuitBreakerTrippedUntil = null;
    updates.consecutiveTicksWithMessage = 0;
    needsUpdate = true;
  }

  // Check if quiet mode should be cleared
  if (state.quietModeUntil && state.quietModeUntil <= now) {
    logger.info('Quiet mode expired, clearing');
    updates.quietModeUntil = null;
    needsUpdate = true;
  }

  if (needsUpdate) {
    updateProactiveState(updates);
    Object.assign(state, updates);
  }

  return state;
}

/**
 * Update proactive state in database.
 */
export function updateProactiveState(
  updates: Partial<ProactiveState>
): void {
  // Convert ProactiveState keys to snake_case for DB
  const dbUpdates: Record<string, unknown> = {};

  if (updates.lastSpontaneousMessageAt !== undefined) {
    dbUpdates.last_spontaneous_message_at = updates.lastSpontaneousMessageAt?.toISOString() ?? null;
  }
  if (updates.lastReminderMessageAt !== undefined) {
    dbUpdates.last_reminder_message_at = updates.lastReminderMessageAt?.toISOString() ?? null;
  }
  if (updates.spontaneousCountToday !== undefined) {
    dbUpdates.spontaneous_count_today = updates.spontaneousCountToday;
  }
  if (updates.spontaneousCountThisHour !== undefined) {
    dbUpdates.spontaneous_count_this_hour = updates.spontaneousCountThisHour;
  }
  if (updates.dateOfLastDailyCount !== undefined) {
    dbUpdates.date_of_last_daily_count = updates.dateOfLastDailyCount;
  }
  if (updates.hourOfLastHourlyCount !== undefined) {
    dbUpdates.hour_of_last_hourly_count = updates.hourOfLastHourlyCount;
  }
  if (updates.consecutiveTicksWithMessage !== undefined) {
    dbUpdates.consecutive_ticks_with_message = updates.consecutiveTicksWithMessage;
  }
  if (updates.circuitBreakerTrippedUntil !== undefined) {
    dbUpdates.circuit_breaker_tripped_until = updates.circuitBreakerTrippedUntil?.toISOString() ?? null;
  }
  if (updates.consecutiveMutexSkips !== undefined) {
    dbUpdates.consecutive_mutex_skips = updates.consecutiveMutexSkips;
  }
  if (updates.lastUserMessageAt !== undefined) {
    dbUpdates.last_user_message_at = updates.lastUserMessageAt?.toISOString() ?? null;
  }
  if (updates.lastUserActivityAt !== undefined) {
    dbUpdates.last_user_activity_at = updates.lastUserActivityAt?.toISOString() ?? null;
  }
  if (updates.lastGreetingType !== undefined) {
    dbUpdates.last_greeting_type = updates.lastGreetingType;
  }
  if (updates.lastGreetingDate !== undefined) {
    dbUpdates.last_greeting_date = updates.lastGreetingDate;
  }
  if (updates.quietModeUntil !== undefined) {
    dbUpdates.quiet_mode_until = updates.quietModeUntil?.toISOString() ?? null;
  }

  if (Object.keys(dbUpdates).length > 0) {
    dbUpdateProactiveState(dbUpdates);
  }
}

/**
 * Record that the user sent a message.
 */
export function recordUserMessage(): void {
  const now = new Date();
  updateProactiveState({
    lastUserMessageAt: now,
    lastUserActivityAt: now,
  });
  logger.debug('Recorded user message');
}

/**
 * Record that a spontaneous message was sent.
 */
export function recordSpontaneousMessageSent(
  messageType: string,
  content: string
): void {
  const now = new Date();
  const state = loadProactiveState();

  // Record in messages log table
  recordSpontaneousMessage(messageType, content);

  // Update state
  updateProactiveState({
    lastSpontaneousMessageAt: now,
    spontaneousCountToday: state.spontaneousCountToday + 1,
    spontaneousCountThisHour: state.spontaneousCountThisHour + 1,
    consecutiveTicksWithMessage: state.consecutiveTicksWithMessage + 1,
  });

  logger.info('Recorded spontaneous message', { messageType });
}

/**
 * Record that a reminder was sent.
 */
export function recordReminderSent(): void {
  const now = new Date();
  updateProactiveState({
    lastReminderMessageAt: now,
  });
  logger.debug('Recorded reminder sent');
}

/**
 * Record a greeting was sent.
 */
export function recordGreetingSent(
  type: 'morning' | 'afternoon' | 'evening'
): void {
  const todayStr = new Date().toISOString().split('T')[0];
  updateProactiveState({
    lastGreetingType: type,
    lastGreetingDate: todayStr,
  });
  logger.debug('Recorded greeting sent', { type });
}

/**
 * Record a tick without message (reset consecutive counter).
 */
export function recordTickWithoutMessage(): void {
  updateProactiveState({
    consecutiveTicksWithMessage: 0,
  });
}

/**
 * Record a mutex skip.
 */
export function recordMutexSkip(): void {
  const state = loadProactiveState();
  const newCount = state.consecutiveMutexSkips + 1;

  updateProactiveState({
    consecutiveMutexSkips: newCount,
  });

  if (newCount >= 6) {
    logger.error('Spontaneous loop starved - 6+ consecutive mutex skips', {
      count: newCount,
    });
  } else {
    logger.warn('Mutex skip recorded', { count: newCount });
  }
}

/**
 * Reset mutex skip counter (called when mutex acquired).
 */
export function resetMutexSkips(): void {
  updateProactiveState({
    consecutiveMutexSkips: 0,
  });
}

/**
 * Trip the circuit breaker.
 */
export function tripCircuitBreaker(
  cooldownMs: number = 30 * 60 * 1000 // 30 minutes
): void {
  const until = new Date(Date.now() + cooldownMs);
  updateProactiveState({
    circuitBreakerTrippedUntil: until,
    consecutiveTicksWithMessage: 0,
  });
  logger.warn('Circuit breaker tripped', { until: until.toISOString() });
}

/**
 * Enable quiet mode for a duration.
 */
export function enableQuietMode(durationMs: number): void {
  const until = new Date(Date.now() + durationMs);
  updateProactiveState({
    quietModeUntil: until,
  });
  logger.info('Quiet mode enabled', { until: until.toISOString() });
}

/**
 * Disable quiet mode.
 */
export function disableQuietMode(): void {
  updateProactiveState({
    quietModeUntil: null,
  });
  logger.info('Quiet mode disabled');
}

/**
 * Check if spontaneous messages are allowed right now.
 * Returns { allowed: boolean, reason: string }
 */
export function canSendSpontaneous(
  config: ProactiveConfig = DEFAULT_PROACTIVE_CONFIG
): { allowed: boolean; reason: string } {
  const state = loadProactiveState(config.timezone);
  const now = new Date();
  const currentHour = now.getHours();

  // Check proactivity level
  if (config.proactivityLevel === 'low') {
    return { allowed: false, reason: 'proactivity_level_low' };
  }

  // Check quiet hours
  if (isWithinQuietHours(currentHour, config.quietHoursStart, config.quietHoursEnd)) {
    return { allowed: false, reason: 'quiet_hours' };
  }

  // Check manual quiet mode
  if (state.quietModeUntil && state.quietModeUntil > now) {
    return { allowed: false, reason: 'quiet_mode_manual' };
  }

  // Check circuit breaker
  if (state.circuitBreakerTrippedUntil && state.circuitBreakerTrippedUntil > now) {
    return { allowed: false, reason: 'circuit_breaker_active' };
  }

  // Check hourly rate limit (use rolling window)
  const hourlyCount = countSpontaneousMessagesInLastHour();
  if (hourlyCount >= config.maxSpontaneousPerHour) {
    return { allowed: false, reason: 'hourly_limit_reached' };
  }

  // Check daily rate limit (use rolling window)
  const dailyCount = countSpontaneousMessagesToday(config.timezone);
  if (dailyCount >= config.maxSpontaneousPerDay) {
    return { allowed: false, reason: 'daily_limit_reached' };
  }

  // Check cooldown
  const lastMessage = getLastSpontaneousMessageTime();
  if (lastMessage) {
    const elapsed = now.getTime() - lastMessage.getTime();
    if (elapsed < config.minCooldownBetweenSpontaneousMs) {
      return { allowed: false, reason: 'cooldown_active' };
    }
  }

  return { allowed: true, reason: 'allowed' };
}

/**
 * Check if a greeting is allowed right now.
 */
export function canSendGreeting(
  config: ProactiveConfig = DEFAULT_PROACTIVE_CONFIG
): { allowed: boolean; window: 'morning' | 'afternoon' | 'evening' | false; reason: string } {
  const now = new Date();
  const currentHour = now.getHours();
  const todayStr = now.toISOString().split('T')[0];

  // First check if spontaneous is allowed at all
  const spontaneousCheck = canSendSpontaneous(config);
  if (!spontaneousCheck.allowed) {
    return { allowed: false, window: false, reason: spontaneousCheck.reason };
  }

  // Check greeting window
  const window = getGreetingWindow(currentHour, config);
  if (!window) {
    return { allowed: false, window: false, reason: 'not_greeting_window' };
  }

  // Check if already greeted today
  const state = loadProactiveState(config.timezone);
  if (state.lastGreetingDate === todayStr && state.lastGreetingType === window) {
    return { allowed: false, window, reason: 'already_greeted' };
  }

  return { allowed: true, window, reason: 'allowed' };
}

/**
 * Get proactive status for debugging.
 */
export function getProactiveStatus(
  config: ProactiveConfig = DEFAULT_PROACTIVE_CONFIG
): Record<string, unknown> {
  const state = loadProactiveState(config.timezone);
  const spontaneousCheck = canSendSpontaneous(config);
  const greetingCheck = canSendGreeting(config);

  return {
    state: {
      ...state,
      lastSpontaneousMessageAt: state.lastSpontaneousMessageAt?.toISOString(),
      lastReminderMessageAt: state.lastReminderMessageAt?.toISOString(),
      lastUserMessageAt: state.lastUserMessageAt?.toISOString(),
      lastUserActivityAt: state.lastUserActivityAt?.toISOString(),
      circuitBreakerTrippedUntil: state.circuitBreakerTrippedUntil?.toISOString(),
      quietModeUntil: state.quietModeUntil?.toISOString(),
    },
    limits: {
      hourlyCount: countSpontaneousMessagesInLastHour(),
      dailyCount: countSpontaneousMessagesToday(config.timezone),
      maxPerHour: config.maxSpontaneousPerHour,
      maxPerDay: config.maxSpontaneousPerDay,
    },
    canSendSpontaneous: spontaneousCheck,
    canSendGreeting: greetingCheck,
    config: {
      proactivityLevel: config.proactivityLevel,
      quietHours: `${config.quietHoursStart}:00 - ${config.quietHoursEnd}:00`,
      timezone: config.timezone,
    },
  };
}

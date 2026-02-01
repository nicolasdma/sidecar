/**
 * Types and configuration for the proactive system.
 *
 * The proactive system has two components:
 * 1. Reminder Scheduler - Deterministic, time-based reminders
 * 2. Spontaneous Loop - LLM-driven proactive messages
 *
 * Both respect rate limits, quiet hours, and circuit breaker.
 */

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('proactive-types');

/**
 * Proactivity level controls how often the agent initiates conversations.
 */
export type ProactivityLevel = 'low' | 'medium' | 'high';

/**
 * Type of proactive message.
 */
export type MessageType = 'greeting' | 'checkin' | 'contextual' | 'reminder';

/**
 * Configuration for the proactive system.
 * These are code-enforced limits that the LLM cannot override.
 */
export interface ProactiveConfig {
  // Spontaneous loop timing
  tickIntervalMs: number;                   // How often to check (default: 15 min)
  minCooldownBetweenSpontaneousMs: number;  // Min time between spontaneous messages (default: 30 min)

  // Rate limits (rolling window)
  maxSpontaneousPerHour: number;            // Max spontaneous per hour (default: 2)
  maxSpontaneousPerDay: number;             // Max spontaneous per day (default: 8)

  // Quiet hours (no spontaneous, reminders still sent)
  quietHoursStart: number;                  // Hour to start quiet (default: 22)
  quietHoursEnd: number;                    // Hour to end quiet (default: 8)

  // Safety
  circuitBreakerThreshold: number;          // Consecutive ticks with message before pause (default: 5)
  llmTimeoutMs: number;                     // Timeout for LLM decisions (default: 10s)

  // User preferences
  proactivityLevel: ProactivityLevel;       // User's chosen level
  timezone: string;                         // IANA timezone
  language: string;                         // Language code (e.g., 'es')

  // Greeting windows (when greetings are allowed)
  morningGreetingStart: number;             // Hour (default: 8)
  morningGreetingEnd: number;               // Hour (default: 10)
  afternoonGreetingStart: number;           // Hour (default: 14)
  afternoonGreetingEnd: number;             // Hour (default: 15)
  eveningGreetingStart: number;             // Hour (default: 18)
  eveningGreetingEnd: number;               // Hour (default: 19)
}

/**
 * Default configuration with conservative values.
 */
export const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
  tickIntervalMs: 15 * 60 * 1000,             // 15 minutes
  minCooldownBetweenSpontaneousMs: 30 * 60 * 1000,  // 30 minutes
  maxSpontaneousPerHour: 2,
  maxSpontaneousPerDay: 8,
  quietHoursStart: 22,
  quietHoursEnd: 8,
  circuitBreakerThreshold: 5,
  llmTimeoutMs: 10000,
  proactivityLevel: 'low',                    // Conservative default
  timezone: 'UTC',
  language: 'es',
  morningGreetingStart: 8,
  morningGreetingEnd: 10,
  afternoonGreetingStart: 14,
  afternoonGreetingEnd: 15,
  eveningGreetingStart: 18,
  eveningGreetingEnd: 19,
};

/**
 * Persistent state of the proactive system.
 * Stored in SQLite proactive_state table.
 */
export interface ProactiveState {
  // Tracking of messages sent
  lastSpontaneousMessageAt: Date | null;
  lastReminderMessageAt: Date | null;

  // Rate limiting counters (reset lazily)
  spontaneousCountToday: number;
  spontaneousCountThisHour: number;

  // For lazy reset of counters
  dateOfLastDailyCount: string | null;       // YYYY-MM-DD
  hourOfLastHourlyCount: number | null;      // 0-23

  // Circuit breaker
  consecutiveTicksWithMessage: number;
  circuitBreakerTrippedUntil: Date | null;

  // Mutex starvation tracking
  consecutiveMutexSkips: number;

  // Activity tracking
  lastUserMessageAt: Date | null;
  lastUserActivityAt: Date | null;

  // Greeting deduplication
  lastGreetingType: 'morning' | 'afternoon' | 'evening' | null;
  lastGreetingDate: string | null;           // YYYY-MM-DD

  // Manual quiet mode
  quietModeUntil: Date | null;
}

/**
 * Initial state with all values zeroed/null.
 */
export const INITIAL_PROACTIVE_STATE: ProactiveState = {
  lastSpontaneousMessageAt: null,
  lastReminderMessageAt: null,
  spontaneousCountToday: 0,
  spontaneousCountThisHour: 0,
  dateOfLastDailyCount: null,
  hourOfLastHourlyCount: null,
  consecutiveTicksWithMessage: 0,
  circuitBreakerTrippedUntil: null,
  consecutiveMutexSkips: 0,
  lastUserMessageAt: null,
  lastUserActivityAt: null,
  lastGreetingType: null,
  lastGreetingDate: null,
  quietModeUntil: null,
};

/**
 * Context provided to LLM for spontaneous message decisions.
 */
export interface SpontaneousContext {
  // Time context
  currentTime: string;                       // "14:35"
  currentDay: string;                        // "viernes"
  currentDate: string;                       // "2026-02-01"

  // Activity context
  minutesSinceLastUserMessage: number | null;
  hoursSinceLastUserActivity: number | null;

  // Constraints (informational - code still enforces)
  isQuietHours: boolean;
  isGreetingWindow: 'morning' | 'afternoon' | 'evening' | false;
  greetingAlreadySent: boolean;
  remainingSpontaneousToday: number;
  remainingSpontaneousThisHour: number;
  cooldownActive: boolean;

  // Memory context
  relevantFacts: string[];                   // Top 5 relevant facts

  // User preferences
  proactivityLevel: ProactivityLevel;
}

/**
 * LLM's decision about whether to send a spontaneous message.
 */
export interface SpontaneousDecision {
  shouldSpeak: boolean;
  reason: string;
  messageType: MessageType | 'none';
  message?: string;                          // Only if shouldSpeak is true
}

/**
 * Reminder stored in the database.
 */
export interface Reminder {
  id: string;
  message: string;
  triggerAt: Date;
  createdAt: Date;
  triggered: 0 | 1 | 2;                      // 0=pending, 1=attempting, 2=delivered
  triggeredAt: Date | null;
  cancelled: boolean;
}

/**
 * Result of creating a reminder.
 */
export interface ReminderCreateResult {
  success: boolean;
  reminder?: Reminder;
  error?: string;
  formattedTime?: string;
}

/**
 * Parse proactivity level from string.
 */
export function parseProactivityLevel(value: string): ProactivityLevel {
  const normalized = value.toLowerCase().trim();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  logger.warn(`Invalid proactivity level: "${value}", defaulting to "low"`);
  return 'low';
}

/**
 * Validate IANA timezone string.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse quiet hours string like "22:00 - 08:00".
 */
export function parseQuietHours(
  value: string
): { start: number; end: number } | null {
  const match = value.match(/^(\d{1,2})(?::00)?\s*-\s*(\d{1,2})(?::00)?$/);
  if (!match) return null;

  const start = parseInt(match[1]!, 10);
  const end = parseInt(match[2]!, 10);

  if (start < 0 || start > 23 || end < 0 || end > 23) {
    return null;
  }

  return { start, end };
}

/**
 * Check if current hour is within quiet hours.
 * Handles overnight ranges (e.g., 22:00 - 08:00).
 */
export function isWithinQuietHours(
  hour: number,
  quietStart: number,
  quietEnd: number
): boolean {
  if (quietStart <= quietEnd) {
    // Same-day range (e.g., 13:00 - 15:00)
    return hour >= quietStart && hour < quietEnd;
  } else {
    // Overnight range (e.g., 22:00 - 08:00)
    return hour >= quietStart || hour < quietEnd;
  }
}

/**
 * Get the current greeting window based on hour.
 */
export function getGreetingWindow(
  hour: number,
  config: ProactiveConfig
): 'morning' | 'afternoon' | 'evening' | false {
  if (hour >= config.morningGreetingStart && hour < config.morningGreetingEnd) {
    return 'morning';
  }
  if (hour >= config.afternoonGreetingStart && hour < config.afternoonGreetingEnd) {
    return 'afternoon';
  }
  if (hour >= config.eveningGreetingStart && hour < config.eveningGreetingEnd) {
    return 'evening';
  }
  return false;
}

/**
 * Format duration for display.
 */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) {
    return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) {
    return `${hours} hora${hours === 1 ? '' : 's'}`;
  }
  return `${hours}h ${remainingMinutes}m`;
}

export default DEFAULT_PROACTIVE_CONFIG;

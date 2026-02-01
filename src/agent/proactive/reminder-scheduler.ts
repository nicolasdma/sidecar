/**
 * Reminder Scheduler
 *
 * Deterministic scheduler that checks for due reminders
 * and dispatches them via NotificationSink.
 *
 * Key behaviors:
 * - Runs every 60 seconds
 * - Marks reminder as triggered BEFORE sending (P2 mitigation)
 * - Uses ±5 minute window for matching
 * - Reminders are sent even during quiet hours (only spontaneous is blocked)
 */

import * as cron from 'node-cron';
import {
  getDueReminders,
  markReminderTriggered,
  getLostReminders,
  type ReminderRow,
} from '../../memory/store.js';
import { recordReminderSent } from './state.js';
import { getMessageRouter } from '../../interfaces/message-router.js';
import type { NotificationMetadata } from '../../interfaces/types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('reminder-scheduler');

// Default user ID for single-user mode
const DEFAULT_USER_ID = 'local-user';

// Scheduler state
let cronJob: cron.ScheduledTask | null = null;
let isRunning = false;

/**
 * Format reminder message for display.
 */
function formatReminderMessage(reminder: ReminderRow): string {
  return `🔔 Recordatorio: ${reminder.message}`;
}

/**
 * Process a single due reminder.
 * Returns true if successfully delivered.
 */
async function processReminder(reminder: ReminderRow): Promise<boolean> {
  logger.info('Processing due reminder', {
    id: reminder.id,
    message: reminder.message.slice(0, 50),
    triggerAt: reminder.trigger_at,
  });

  // P2 Mitigation: Mark as triggered (status=1) BEFORE attempting send
  // This prevents duplicate sends if we crash during delivery
  markReminderTriggered(reminder.id, 1);

  try {
    const router = getMessageRouter();
    const metadata: NotificationMetadata = {
      type: 'reminder',
      reminderId: reminder.id,
      priority: 'high',
    };

    const message = formatReminderMessage(reminder);
    const sent = await router.sendNotification(DEFAULT_USER_ID, message, metadata);

    if (sent) {
      // Mark as delivered (status=2)
      markReminderTriggered(reminder.id, 2);
      recordReminderSent();

      logger.info('Reminder delivered', { id: reminder.id });
      return true;
    } else {
      logger.warn('Failed to send reminder - no available sinks', {
        id: reminder.id,
      });
      // Keep status=1 so it can be retried or detected as stuck
      return false;
    }
  } catch (error) {
    logger.error('Error sending reminder', { id: reminder.id, error });
    // Keep status=1 so it can be detected as stuck
    return false;
  }
}

/**
 * Check for and process due reminders.
 * Called every tick (60 seconds).
 */
async function tick(): Promise<void> {
  if (!isRunning) return;

  logger.debug('Reminder scheduler tick');

  try {
    // Get reminders due within ±5 minutes
    const dueReminders = getDueReminders(5);

    if (dueReminders.length === 0) {
      logger.debug('No due reminders');
      return;
    }

    logger.info(`Found ${dueReminders.length} due reminder(s)`);

    // Process each reminder
    for (const reminder of dueReminders) {
      await processReminder(reminder);
    }
  } catch (error) {
    logger.error('Error in reminder scheduler tick', { error });
  }
}

/**
 * Check for reminders that got stuck (triggered=1 but not delivered).
 * These are reminders that were being sent when a crash occurred.
 */
export function checkLostReminders(): ReminderRow[] {
  const lost = getLostReminders();

  if (lost.length > 0) {
    logger.warn('Found lost reminders (stuck in triggered=1 state)', {
      count: lost.length,
      ids: lost.map((r) => r.id.slice(0, 8)),
    });
  }

  return lost;
}

/**
 * Recover lost reminders by re-attempting delivery.
 */
export async function recoverLostReminders(): Promise<void> {
  const lost = checkLostReminders();

  if (lost.length === 0) return;

  logger.info('Attempting to recover lost reminders', { count: lost.length });

  for (const reminder of lost) {
    // These were already marked as triggered=1, so just retry send
    try {
      const router = getMessageRouter();
      const metadata: NotificationMetadata = {
        type: 'reminder',
        reminderId: reminder.id,
        priority: 'high',
      };

      const message = `${formatReminderMessage(reminder)} (recuperado)`;
      const sent = await router.sendNotification(DEFAULT_USER_ID, message, metadata);

      if (sent) {
        markReminderTriggered(reminder.id, 2);
        logger.info('Recovered lost reminder', { id: reminder.id });
      } else {
        logger.warn('Could not recover lost reminder', { id: reminder.id });
      }
    } catch (error) {
      logger.error('Error recovering lost reminder', { id: reminder.id, error });
    }
  }
}

/**
 * Start the reminder scheduler.
 */
export function startReminderScheduler(): void {
  if (cronJob) {
    logger.warn('Reminder scheduler already running');
    return;
  }

  isRunning = true;

  // Run every minute
  cronJob = cron.schedule('* * * * *', () => {
    tick().catch((error) => {
      logger.error('Unhandled error in reminder tick', { error });
    });
  });

  logger.info('Reminder scheduler started (every 60 seconds)');

  // Check for lost reminders on startup
  recoverLostReminders().catch((error) => {
    logger.error('Error recovering lost reminders at startup', { error });
  });

  // Run first tick immediately
  tick().catch((error) => {
    logger.error('Error in initial reminder tick', { error });
  });
}

/**
 * Stop the reminder scheduler.
 */
export function stopReminderScheduler(): void {
  isRunning = false;

  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    logger.info('Reminder scheduler stopped');
  }
}

/**
 * Force a tick (for testing/debugging).
 */
export async function forceTick(): Promise<void> {
  await tick();
}

/**
 * Check if scheduler is running.
 */
export function isSchedulerRunning(): boolean {
  return isRunning && cronJob !== null;
}

export default {
  start: startReminderScheduler,
  stop: stopReminderScheduler,
  forceTick,
  isRunning: isSchedulerRunning,
  checkLostReminders,
  recoverLostReminders,
};

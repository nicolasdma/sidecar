/**
 * Reminder Scheduler V2
 *
 * Event-driven scheduler using in-memory queue + precise setTimeout.
 *
 * Architecture:
 * - SQLite is source of truth (reminders table)
 * - In-memory queue for fast next-reminder lookup
 * - Single setTimeout to the next reminder
 * - Catch-up on startup for missed reminders
 * - No polling (event-driven only)
 *
 * Key behaviors:
 * - Precision: dispatches within ±100ms of triggerAt
 * - Efficiency: 0 queries while waiting (timer-based)
 * - Robustness: catch-up handles app-was-closed scenario
 * - Rate limiting: catch-up doesn't spam notifications
 */

import { ReminderQueue, type QueuedReminder } from './reminder-queue.js';
import {
  getPendingReminders,
  getPastDueReminders,
  markReminderTriggered,
  type ReminderRow,
} from '../../memory/store.js';
import { recordReminderSent } from './state.js';
import { getMessageRouter } from '../../interfaces/message-router.js';
import type { NotificationMetadata } from '../../interfaces/types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('reminder-scheduler-v2');

// Default user ID for single-user mode
const DEFAULT_USER_ID = 'local-user';

// Rate limiting for catch-up
const CATCHUP_DELAY_MS = 500; // Delay between catch-up dispatches

/**
 * Convert ReminderRow to QueuedReminder.
 */
function toQueuedReminder(row: ReminderRow): QueuedReminder {
  return {
    id: row.id,
    message: row.message,
    triggerAt: new Date(row.trigger_at),
  };
}

/**
 * Singleton instance.
 */
let instance: ReminderSchedulerV2 | null = null;

/**
 * ReminderSchedulerV2 - Event-driven reminder scheduling.
 */
export class ReminderSchedulerV2 {
  private queue: ReminderQueue;
  private currentTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private currentScheduledId: string | null = null;

  constructor() {
    this.queue = new ReminderQueue();
  }

  /**
   * Start the scheduler.
   * 1. Load pending reminders from DB into queue
   * 2. Catch-up any past-due reminders
   * 3. Schedule the next reminder
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Scheduler already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting reminder scheduler V2');

    // Load all pending reminders into queue
    this.loadFromDb();

    // Catch-up past-due reminders
    await this.catchUp();

    // Schedule next
    this.scheduleNext();

    logger.info('Reminder scheduler V2 started', {
      queueSize: this.queue.size(),
    });
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    this.isRunning = false;
    this.clearCurrentTimer();
    this.queue.clear();
    logger.info('Reminder scheduler V2 stopped');
  }

  /**
   * Called when a new reminder is created.
   * Adds to queue and reschedules if needed.
   */
  onReminderCreated(id: string, message: string, triggerAt: Date): void {
    if (!this.isRunning) return;

    const reminder: QueuedReminder = { id, message, triggerAt };
    this.queue.add(reminder);

    logger.info('reminder_queued', {
      id,
      triggerAt: triggerAt.toISOString(),
      msFromNow: triggerAt.getTime() - Date.now(),
    });

    // If this reminder is sooner than the currently scheduled one, reschedule
    const next = this.queue.peek();
    if (next && next.id === id) {
      logger.debug('New reminder is next, rescheduling');
      this.scheduleNext();
    }
  }

  /**
   * Called when a reminder is cancelled.
   * Removes from queue and reschedules if needed.
   */
  onReminderCancelled(id: string): void {
    if (!this.isRunning) return;

    const wasNext = this.currentScheduledId === id;
    const removed = this.queue.remove(id);

    if (removed) {
      logger.info('reminder_dequeued', { id, wasNext });

      if (wasNext) {
        this.scheduleNext();
      }
    }
  }

  /**
   * Load pending reminders from DB into queue.
   */
  private loadFromDb(): void {
    const rows = getPendingReminders();
    const reminders = rows.map(toQueuedReminder);
    this.queue.load(reminders);
    logger.debug('Loaded reminders from DB', { count: reminders.length });
  }

  /**
   * Catch up on past-due reminders (app was closed).
   */
  private async catchUp(): Promise<void> {
    const pastDue = getPastDueReminders();

    if (pastDue.length === 0) {
      logger.debug('No past-due reminders');
      return;
    }

    const oldestAge = Date.now() - new Date(pastDue[0]!.trigger_at).getTime();

    logger.info('reminder_catchup_start', {
      count: pastDue.length,
      oldestAgeMs: oldestAge,
      oldestAgeMin: Math.round(oldestAge / 60000),
    });

    // Rate-limited dispatch
    for (let i = 0; i < pastDue.length; i++) {
      const row = pastDue[i]!;
      const reminder = toQueuedReminder(row);

      await this.dispatch(reminder, true);

      // Delay between dispatches (except last one)
      if (i < pastDue.length - 1) {
        await this.sleep(CATCHUP_DELAY_MS);
      }
    }

    logger.info('reminder_catchup_complete', { count: pastDue.length });
  }

  /**
   * Schedule setTimeout for the next reminder.
   */
  private scheduleNext(): void {
    this.clearCurrentTimer();

    const next = this.queue.peek();

    if (!next) {
      logger.debug('No reminders in queue, nothing to schedule');
      this.currentScheduledId = null;
      return;
    }

    const now = Date.now();
    const triggerAtMs = next.triggerAt.getTime();
    const msUntilTrigger = Math.max(0, triggerAtMs - now);

    this.currentScheduledId = next.id;

    logger.info('reminder_scheduled', {
      id: next.id,
      triggerAt: next.triggerAt.toISOString(),
      msFromNow: msUntilTrigger,
      humanTime: this.formatMs(msUntilTrigger),
    });

    // If already past due, dispatch immediately
    if (msUntilTrigger === 0) {
      setImmediate(() => this.onTimerFired());
      return;
    }

    this.currentTimer = setTimeout(() => {
      this.onTimerFired();
    }, msUntilTrigger);
  }

  /**
   * Timer callback - dispatch the reminder.
   */
  private async onTimerFired(): Promise<void> {
    if (!this.isRunning) return;

    const reminder = this.queue.pop();

    if (!reminder) {
      logger.warn('Timer fired but queue is empty');
      this.scheduleNext();
      return;
    }

    await this.dispatch(reminder, false);
    this.scheduleNext();
  }

  /**
   * Dispatch a reminder notification.
   */
  private async dispatch(reminder: QueuedReminder, isCatchUp: boolean): Promise<void> {
    const now = Date.now();
    const lateByMs = now - reminder.triggerAt.getTime();

    logger.info('reminder_dispatching', {
      id: reminder.id,
      message: reminder.message.slice(0, 50),
      lateByMs,
      isCatchUp,
    });

    // Mark as attempting (status=1)
    markReminderTriggered(reminder.id, 1);

    try {
      const router = getMessageRouter();
      const metadata: NotificationMetadata = {
        type: 'reminder',
        reminderId: reminder.id,
        priority: 'high',
      };

      const message = this.formatReminderMessage(reminder, isCatchUp, lateByMs);
      const sent = await router.sendNotification(DEFAULT_USER_ID, message, metadata);

      if (sent) {
        // Mark as delivered (status=2)
        markReminderTriggered(reminder.id, 2);
        recordReminderSent();

        // Remove from queue if still there (catch-up case)
        this.queue.remove(reminder.id);

        logger.info('reminder_dispatched', {
          id: reminder.id,
          lateByMs,
          isCatchUp,
        });
      } else {
        logger.warn('reminder_dispatch_failed', {
          id: reminder.id,
          reason: 'no_sinks_available',
        });
      }
    } catch (error) {
      logger.error('reminder_dispatch_error', {
        id: reminder.id,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /**
   * Format the reminder message for display.
   */
  private formatReminderMessage(
    reminder: QueuedReminder,
    isCatchUp: boolean,
    lateByMs: number
  ): string {
    let message = `🔔 Recordatorio: ${reminder.message}`;

    if (isCatchUp && lateByMs > 60000) {
      const lateMin = Math.round(lateByMs / 60000);
      message += ` (de hace ${lateMin} min)`;
    }

    return message;
  }

  /**
   * Clear the current timer if exists.
   */
  private clearCurrentTimer(): void {
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
  }

  /**
   * Sleep helper.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Format milliseconds for logging.
   */
  private formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${(ms / 60000).toFixed(1)}min`;
    return `${(ms / 3600000).toFixed(1)}h`;
  }

  /**
   * Check if running.
   */
  isSchedulerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get queue size (for debugging).
   */
  getQueueSize(): number {
    return this.queue.size();
  }
}

/**
 * Get or create the singleton scheduler instance.
 */
export function getReminderScheduler(): ReminderSchedulerV2 {
  if (!instance) {
    instance = new ReminderSchedulerV2();
  }
  return instance;
}

/**
 * Start the reminder scheduler.
 */
export async function startReminderScheduler(): Promise<void> {
  const scheduler = getReminderScheduler();
  await scheduler.start();
}

/**
 * Stop the reminder scheduler.
 */
export function stopReminderScheduler(): void {
  if (instance) {
    instance.stop();
  }
}

/**
 * Notify scheduler of new reminder.
 */
export function notifyReminderCreated(id: string, message: string, triggerAt: Date): void {
  if (instance && instance.isSchedulerRunning()) {
    instance.onReminderCreated(id, message, triggerAt);
  }
}

/**
 * Notify scheduler of cancelled reminder.
 */
export function notifyReminderCancelled(id: string): void {
  if (instance && instance.isSchedulerRunning()) {
    instance.onReminderCancelled(id);
  }
}

export default {
  start: startReminderScheduler,
  stop: stopReminderScheduler,
  notifyCreated: notifyReminderCreated,
  notifyCancelled: notifyReminderCancelled,
  getInstance: getReminderScheduler,
};

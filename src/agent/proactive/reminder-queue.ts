/**
 * Reminder Queue - In-memory sorted queue for pending reminders
 *
 * Maintains a sorted list of reminders by triggerAt (ASC).
 * Used by ReminderSchedulerV2 for efficient next-reminder lookup.
 */

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('reminder-queue');

export interface QueuedReminder {
  id: string;
  message: string;
  triggerAt: Date;
}

/**
 * In-memory queue of pending reminders, sorted by triggerAt.
 */
export class ReminderQueue {
  private queue: QueuedReminder[] = [];

  /**
   * Get the next reminder without removing it.
   */
  peek(): QueuedReminder | null {
    return this.queue[0] ?? null;
  }

  /**
   * Get and remove the next reminder.
   */
  pop(): QueuedReminder | null {
    return this.queue.shift() ?? null;
  }

  /**
   * Add a reminder to the queue, maintaining sort order.
   */
  add(reminder: QueuedReminder): void {
    // Binary search for insertion point
    let left = 0;
    let right = this.queue.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.queue[mid]!.triggerAt.getTime() < reminder.triggerAt.getTime()) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    this.queue.splice(left, 0, reminder);
    logger.debug('Added reminder to queue', {
      id: reminder.id,
      position: left,
      queueSize: this.queue.length,
    });
  }

  /**
   * Remove a reminder by ID.
   * Returns true if found and removed.
   */
  remove(id: string): boolean {
    const index = this.queue.findIndex((r) => r.id === id);
    if (index === -1) {
      return false;
    }

    this.queue.splice(index, 1);
    logger.debug('Removed reminder from queue', { id, queueSize: this.queue.length });
    return true;
  }

  /**
   * Check if a reminder is in the queue.
   */
  has(id: string): boolean {
    return this.queue.some((r) => r.id === id);
  }

  /**
   * Get all reminders that are past due (triggerAt <= now).
   * Does NOT remove them from the queue.
   */
  getPastDue(now: Date = new Date()): QueuedReminder[] {
    const pastDue: QueuedReminder[] = [];
    const nowMs = now.getTime();

    for (const reminder of this.queue) {
      if (reminder.triggerAt.getTime() <= nowMs) {
        pastDue.push(reminder);
      } else {
        // Queue is sorted, so we can stop here
        break;
      }
    }

    return pastDue;
  }

  /**
   * Remove multiple reminders by ID.
   */
  removeMany(ids: string[]): void {
    const idSet = new Set(ids);
    this.queue = this.queue.filter((r) => !idSet.has(r.id));
  }

  /**
   * Clear the queue.
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Get queue size.
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Load reminders into the queue (replaces existing).
   * Sorts by triggerAt automatically.
   */
  load(reminders: QueuedReminder[]): void {
    this.queue = [...reminders].sort(
      (a, b) => a.triggerAt.getTime() - b.triggerAt.getTime()
    );
    logger.info('Loaded reminders into queue', { count: this.queue.length });
  }
}

export default ReminderQueue;

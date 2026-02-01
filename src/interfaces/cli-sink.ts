/**
 * CLI Notification Sink
 *
 * Implements NotificationSink for the terminal interface.
 * Outputs proactive messages with appropriate prefixes.
 */

import type {
  NotificationSink,
  NotificationMetadata,
  NotificationPreference,
  ChannelType,
} from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cli-sink');

/**
 * CLI Notification Sink implementation.
 */
export class CLINotificationSink implements NotificationSink {
  readonly channel: ChannelType = 'cli';

  private available: boolean = true;
  private preference: NotificationPreference = 'all';

  /**
   * Set the notification preference.
   */
  setPreference(pref: NotificationPreference): void {
    this.preference = pref;
    logger.debug('CLI sink preference set', { preference: pref });
  }

  /**
   * Set availability.
   */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /**
   * Send a proactive notification.
   */
  async send(
    _userId: string,
    message: string,
    metadata?: NotificationMetadata
  ): Promise<boolean> {
    if (!this.available) {
      logger.debug('CLI sink not available, skipping notification');
      return false;
    }

    // Check preference
    if (this.preference === 'none') {
      logger.debug('CLI notifications disabled, skipping');
      return false;
    }

    if (this.preference === 'reminders-only' && metadata?.type !== 'reminder') {
      logger.debug('CLI set to reminders-only, skipping spontaneous');
      return false;
    }

    // Determine prefix based on type
    const prefix = this.getPrefix(metadata);

    // Print the notification
    // Clear current line first (in case there's a prompt)
    process.stdout.write('\r\x1b[K');
    console.log(`\n${prefix} ${message}\n`);

    logger.debug('Notification sent via CLI', {
      type: metadata?.type,
      messageType: metadata?.messageType,
    });

    return true;
  }

  /**
   * Get prefix emoji based on notification type.
   */
  private getPrefix(metadata?: NotificationMetadata): string {
    if (!metadata) {
      return '\x1b[33m💬\x1b[0m';
    }

    if (metadata.type === 'reminder') {
      return '\x1b[33m🔔\x1b[0m';
    }

    // Spontaneous types
    switch (metadata.messageType) {
      case 'greeting':
        return '\x1b[33m👋\x1b[0m';
      case 'checkin':
        return '\x1b[33m💭\x1b[0m';
      case 'contextual':
        return '\x1b[33m💡\x1b[0m';
      default:
        return '\x1b[33m💬\x1b[0m';
    }
  }

  /**
   * Check if available.
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Get current preference.
   */
  getPreference(): NotificationPreference {
    return this.preference;
  }
}

export default CLINotificationSink;

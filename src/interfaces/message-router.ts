/**
 * Message Router
 *
 * Central coordinator for messages between channels and the brain.
 * Handles:
 * - Message source registration
 * - Notification sink registration
 * - Command interception (/quiet, /reminders, etc.)
 * - Routing based on channel preferences
 */

import type {
  MessageSource,
  NotificationSink,
  IncomingMessage,
  NotificationMetadata,
  CommandHandler,
  ChannelType,
  ChannelPreferences,
} from './types.js';
import { DEFAULT_CHANNEL_PREFERENCES } from './types.js';
import { think } from '../agent/brain.js';
import { recordUserMessage } from '../agent/proactive/state.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('router');

/**
 * Implementation of MessageRouter.
 */
export class MessageRouterImpl {
  private sources: Map<ChannelType, MessageSource> = new Map();
  private sinks: Map<ChannelType, NotificationSink> = new Map();
  private commandHandlers: CommandHandler[] = [];
  private lastActiveChannel: Map<string, ChannelType> = new Map();
  private preferences: ChannelPreferences = DEFAULT_CHANNEL_PREFERENCES;
  private started: boolean = false;

  /**
   * Register a message source.
   */
  registerSource(source: MessageSource): void {
    this.sources.set(source.channel, source);
    logger.info('Registered message source', { channel: source.channel });

    // Set up message handler
    source.onMessage(async (msg) => {
      await this.handleIncoming(msg);
    });
  }

  /**
   * Register a notification sink.
   */
  registerSink(sink: NotificationSink): void {
    this.sinks.set(sink.channel, sink);
    logger.info('Registered notification sink', { channel: sink.channel });
  }

  /**
   * Register a command handler.
   */
  registerCommandHandler(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
    logger.debug('Registered command handler');
  }

  /**
   * Set channel preferences.
   */
  setPreferences(prefs: ChannelPreferences): void {
    this.preferences = prefs;
    logger.info('Updated channel preferences', { primary: prefs.primaryChannel });
  }

  /**
   * Handle incoming message from any source.
   */
  async handleIncoming(msg: IncomingMessage): Promise<void> {
    logger.debug('Handling incoming message', {
      source: msg.source,
      userId: msg.userId,
      contentPreview: msg.content.slice(0, 50),
    });

    // Update last active channel for user
    this.lastActiveChannel.set(msg.userId, msg.source);

    // Record user activity for proactive system
    recordUserMessage();

    // Check for command
    if (msg.content.startsWith('/')) {
      const handled = await this.handleCommand(msg);
      if (handled) return;
    }

    // Get the source to send response
    const source = this.sources.get(msg.source);
    if (!source) {
      logger.error('No source found for channel', { channel: msg.source });
      return;
    }

    // Process with brain
    try {
      const response = await think(msg.content);
      await source.sendResponse(msg.userId, response, msg.id);
    } catch (error) {
      logger.error('Error processing message', { error });
      await source.sendResponse(
        msg.userId,
        'Ocurrió un error procesando tu mensaje.',
        msg.id
      );
    }
  }

  /**
   * Handle command message.
   * Returns true if command was handled.
   */
  private async handleCommand(msg: IncomingMessage): Promise<boolean> {
    const parts = msg.content.slice(1).split(/\s+/);
    const command = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1).join(' ');

    // Try registered handlers first
    for (const handler of this.commandHandlers) {
      const response = await handler.handle(command, args, msg.source);
      if (response !== null) {
        const source = this.sources.get(msg.source);
        if (source) {
          await source.sendResponse(msg.userId, response, msg.id);
        }
        return true;
      }
    }

    // Not handled - return false to process as regular message
    return false;
  }

  /**
   * Send a notification using routing policy.
   */
  async sendNotification(
    userId: string,
    message: string,
    metadata: NotificationMetadata
  ): Promise<boolean> {
    logger.debug('Sending notification', { userId, type: metadata.type });

    // Get sinks to notify based on type
    const sinksToUse = this.getSinksForNotification(userId, metadata);

    if (sinksToUse.length === 0) {
      logger.warn('No sinks available for notification', { userId, type: metadata.type });
      return false;
    }

    let success = false;
    for (const sink of sinksToUse) {
      try {
        const sent = await sink.send(userId, message, metadata);
        if (sent) {
          success = true;
          logger.debug('Notification sent via sink', { channel: sink.channel });
        }
      } catch (error) {
        logger.error('Error sending notification via sink', {
          channel: sink.channel,
          error,
        });
      }
    }

    return success;
  }

  /**
   * Get sinks to use for a notification based on routing policy.
   */
  private getSinksForNotification(
    _userId: string,
    metadata: NotificationMetadata
  ): NotificationSink[] {
    const result: NotificationSink[] = [];

    // For reminders: primary + all with 'all' or 'reminders-only'
    if (metadata.type === 'reminder') {
      for (const [channel, sink] of this.sinks) {
        if (!sink.isAvailable()) continue;

        const pref = this.preferences.channels.get(channel) ?? 'none';
        if (pref === 'all' || pref === 'reminders-only') {
          result.push(sink);
        }
      }
    }

    // For spontaneous: only primary with 'all'
    if (metadata.type === 'spontaneous') {
      const primarySink = this.sinks.get(this.preferences.primaryChannel);
      if (primarySink?.isAvailable()) {
        const pref = this.preferences.channels.get(this.preferences.primaryChannel) ?? 'none';
        if (pref === 'all') {
          result.push(primarySink);
        }
      }
    }

    return result;
  }

  /**
   * Get the preferred sink for notifications.
   */
  getPreferredSink(_userId: string): NotificationSink | null {
    const sink = this.sinks.get(this.preferences.primaryChannel);
    return sink?.isAvailable() ? sink : null;
  }

  /**
   * Get the last active channel for a user.
   */
  getLastActiveChannel(userId: string): ChannelType | null {
    return this.lastActiveChannel.get(userId) ?? null;
  }

  /**
   * Get all active sources.
   */
  getActiveSources(): MessageSource[] {
    return Array.from(this.sources.values()).filter((s) => s.isConnected());
  }

  /**
   * Get all active sinks.
   */
  getActiveSinks(): NotificationSink[] {
    return Array.from(this.sinks.values()).filter((s) => s.isAvailable());
  }

  /**
   * Start the router.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    logger.info('Message router started', {
      sources: Array.from(this.sources.keys()),
      sinks: Array.from(this.sinks.keys()),
    });
  }

  /**
   * Stop the router and cleanup.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    logger.info('Stopping message router...');

    // Disconnect all sources
    for (const source of this.sources.values()) {
      try {
        await source.disconnect();
      } catch (error) {
        logger.error('Error disconnecting source', { channel: source.channel, error });
      }
    }

    this.sources.clear();
    this.sinks.clear();
    this.commandHandlers = [];
    this.started = false;

    logger.info('Message router stopped');
  }
}

// Singleton instance
let routerInstance: MessageRouterImpl | null = null;

/**
 * Get the message router singleton.
 */
export function getMessageRouter(): MessageRouterImpl {
  if (!routerInstance) {
    routerInstance = new MessageRouterImpl();
  }
  return routerInstance;
}

export default getMessageRouter;

/**
 * Channel Layer Types
 *
 * Abstractions for multi-channel communication (CLI, WhatsApp, Telegram, etc.)
 * Implemented in Fase 3, used fully in Fase 4+.
 */

/**
 * Supported channel types.
 */
export type ChannelType = 'cli' | 'whatsapp' | 'telegram' | 'desktop';

/**
 * Preference for notifications on a channel.
 */
export type NotificationPreference = 'all' | 'reminders-only' | 'none';

/**
 * Message received from a channel.
 */
export interface IncomingMessage {
  id: string;                                // Unique message ID
  source: ChannelType;                       // Which channel it came from
  userId: string;                            // User identifier in that channel
  content: string;                           // Message text
  timestamp: Date;                           // When received
  replyTo?: string;                          // ID of message being replied to (threading)
  metadata: Record<string, unknown>;         // Channel-specific data
}

/**
 * Metadata for proactive notifications.
 */
export interface NotificationMetadata {
  type: 'reminder' | 'spontaneous';
  messageType?: 'greeting' | 'checkin' | 'contextual';
  reminderId?: string;
  priority?: 'low' | 'normal' | 'high';
}

/**
 * Interface for receiving messages from a channel.
 */
export interface MessageSource {
  /** The channel type this source handles */
  readonly channel: ChannelType;

  /**
   * Register a handler for incoming messages.
   * @param handler - Async function called for each message
   */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;

  /**
   * Send a response to the user (reply to their message).
   * @param userId - User to respond to
   * @param content - Response text
   * @param replyTo - Optional message ID to reply to (for threading)
   */
  sendResponse(userId: string, content: string, replyTo?: string): Promise<void>;

  /** Check if the channel is connected */
  isConnected(): boolean;

  /** Disconnect and cleanup */
  disconnect(): Promise<void>;
}

/**
 * Interface for sending proactive notifications.
 */
export interface NotificationSink {
  /** The channel type this sink outputs to */
  readonly channel: ChannelType;

  /**
   * Send a proactive notification to the user.
   * @param userId - User to notify
   * @param message - Notification text
   * @param metadata - Type of notification and other info
   * @returns true if sent successfully
   */
  send(
    userId: string,
    message: string,
    metadata?: NotificationMetadata
  ): Promise<boolean>;

  /** Check if the channel can receive notifications now */
  isAvailable(): boolean;

  /** Get user's preference for this channel */
  getPreference(): NotificationPreference;
}

/**
 * Handler for routing commands.
 */
export interface CommandHandler {
  /**
   * Handle a command.
   * @param command - Command name (e.g., "quiet", "reminders")
   * @param args - Arguments after the command
   * @param source - Which channel the command came from
   * @returns Response message, or null if command not handled
   */
  handle(command: string, args: string, source: ChannelType): Promise<string | null>;
}

/**
 * Central message router interface.
 * Coordinates messages between channels and the brain.
 */
export interface MessageRouter {
  /** Register a message source */
  registerSource(source: MessageSource): void;

  /** Register a notification sink */
  registerSink(sink: NotificationSink): void;

  /** Register a command handler */
  registerCommandHandler(handler: CommandHandler): void;

  /** Get the preferred sink for notifications */
  getPreferredSink(userId: string): NotificationSink | null;

  /** Get the last active channel for a user */
  getLastActiveChannel(userId: string): ChannelType | null;

  /**
   * Send a notification using configured routing policy.
   * @param userId - User to notify
   * @param message - Notification text
   * @param metadata - Type of notification
   * @returns true if sent successfully to at least one channel
   */
  sendNotification(
    userId: string,
    message: string,
    metadata: NotificationMetadata
  ): Promise<boolean>;

  /** Get all active sources */
  getActiveSources(): MessageSource[];

  /** Get all active sinks */
  getActiveSinks(): NotificationSink[];

  /** Start processing messages */
  start(): void;

  /** Stop processing and cleanup */
  stop(): Promise<void>;
}

/**
 * Channel preferences from user.md.
 */
export interface ChannelPreferences {
  primaryChannel: ChannelType;
  channels: Map<ChannelType, NotificationPreference>;
}

/**
 * Default channel preferences (CLI only).
 */
export const DEFAULT_CHANNEL_PREFERENCES: ChannelPreferences = {
  primaryChannel: 'cli',
  channels: new Map([['cli', 'all']]),
};

/**
 * Parse channel preferences from user.md content.
 */
export function parseChannelPreferences(content: string): ChannelPreferences {
  const prefs = { ...DEFAULT_CHANNEL_PREFERENCES };
  prefs.channels = new Map(DEFAULT_CHANNEL_PREFERENCES.channels);

  // Parse primary channel (handles both "primary channel:" and "**Primary channel**:")
  const primaryMatch = content.match(/\*?\*?primary\s+channel\*?\*?:\s*(\w+)/i);
  if (primaryMatch?.[1]) {
    const channel = primaryMatch[1].toLowerCase();
    if (isValidChannel(channel)) {
      prefs.primaryChannel = channel;
    }
  }

  // Parse CLI notifications (handles both "cli notifications:" and "**CLI notifications**:")
  const cliMatch = content.match(/\*?\*?cli\s+notifications\*?\*?:\s*(\S+)/i);
  if (cliMatch?.[1]) {
    const pref = parseNotificationPreference(cliMatch[1]);
    if (pref) prefs.channels.set('cli', pref);
  }

  // Parse WhatsApp notifications (handles both "whatsapp notifications:" and "**WhatsApp notifications**:")
  const waMatch = content.match(/\*?\*?whatsapp\s+notifications\*?\*?:\s*(\S+)/i);
  if (waMatch?.[1]) {
    const pref = parseNotificationPreference(waMatch[1]);
    if (pref) prefs.channels.set('whatsapp', pref);
  }

  return prefs;
}

/**
 * Check if string is a valid channel type.
 */
function isValidChannel(value: string): value is ChannelType {
  return ['cli', 'whatsapp', 'telegram', 'desktop'].includes(value);
}

/**
 * Parse notification preference string.
 */
function parseNotificationPreference(value: string): NotificationPreference | null {
  const normalized = value.toLowerCase().replace('-', '');
  if (normalized === 'all') return 'all';
  if (normalized === 'remindersonly') return 'reminders-only';
  if (normalized === 'none') return 'none';
  return null;
}

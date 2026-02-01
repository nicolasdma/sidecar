import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import type { Message, ToolCall } from '../llm/types.js';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('memory');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content TEXT,
    tool_calls TEXT,
    tool_call_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

  -- Reminders table for Fase 3 proactive system
  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    trigger_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    triggered INTEGER NOT NULL DEFAULT 0,
    triggered_at TEXT,
    cancelled INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_trigger_at ON reminders(trigger_at);
  CREATE INDEX IF NOT EXISTS idx_reminders_triggered ON reminders(triggered);

  -- Proactive state table (single row)
  CREATE TABLE IF NOT EXISTS proactive_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_spontaneous_message_at TEXT,
    last_reminder_message_at TEXT,
    spontaneous_count_today INTEGER NOT NULL DEFAULT 0,
    spontaneous_count_this_hour INTEGER NOT NULL DEFAULT 0,
    date_of_last_daily_count TEXT,
    hour_of_last_hourly_count INTEGER,
    consecutive_ticks_with_message INTEGER NOT NULL DEFAULT 0,
    circuit_breaker_tripped_until TEXT,
    consecutive_mutex_skips INTEGER NOT NULL DEFAULT 0,
    last_user_message_at TEXT,
    last_user_activity_at TEXT,
    last_greeting_type TEXT,
    last_greeting_date TEXT,
    quiet_mode_until TEXT
  );

  -- Spontaneous messages log for rate limiting
  CREATE TABLE IF NOT EXISTS spontaneous_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    message_type TEXT NOT NULL,
    content TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spontaneous_sent_at ON spontaneous_messages(sent_at);
`;

interface MessageRow {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: string;
}

let db: Database.Database | null = null;

/**
 * Issue #10: Simple health check to verify SQLite connection is functional.
 */
function isConnectionHealthy(database: Database.Database): boolean {
  try {
    database.prepare('SELECT 1').get();
    return true;
  } catch (error) {
    logger.warn('SQLite connection unhealthy', { error });
    return false;
  }
}

function getDatabase(): Database.Database {
  // Issue #10: Check if existing connection is healthy
  if (db) {
    if (isConnectionHealthy(db)) {
      return db;
    }
    // Connection is unhealthy, close and reconnect
    logger.warn('SQLite connection failed health check, reconnecting...');
    try {
      db.close();
    } catch {
      // Ignore close errors
    }
    db = null;
  }

  const dataDir = config.paths.data;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    logger.info(`Created data directory: ${dataDir}`);
  }

  // Issue #5: Use centralized path from config
  const dbPath = config.paths.database;
  db = new Database(dbPath);
  db.exec(SCHEMA);

  // Enable WAL mode for crash safety (per memory-architecture.md §9)
  db.exec('PRAGMA journal_mode=WAL;');

  logger.info(`Database initialized: ${dbPath}`);
  return db;
}

export function saveMessage(message: Message): number {
  const database = getDatabase();

  if (message.role === 'system') {
    throw new Error('System messages should not be saved to history');
  }

  let toolCalls: string | null = null;
  let toolCallId: string | null = null;

  if (message.role === 'assistant' && message.tool_calls) {
    toolCalls = JSON.stringify(message.tool_calls);
  }

  if (message.role === 'tool') {
    toolCallId = message.tool_call_id;
  }

  const stmt = database.prepare(`
    INSERT INTO messages (role, content, tool_calls, tool_call_id)
    VALUES (?, ?, ?, ?)
  `);

  const result = stmt.run(message.role, message.content, toolCalls, toolCallId);
  logger.debug(`Saved message`, { id: result.lastInsertRowid, role: message.role });

  return Number(result.lastInsertRowid);
}

// Default window size per memory-architecture.md §9 Phase 1
const DEFAULT_WINDOW_SIZE = 6;

export function loadHistory(limit: number = DEFAULT_WINDOW_SIZE): Message[] {
  const database = getDatabase();

  const stmt = database.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      ORDER BY id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `);

  const rows = stmt.all(limit) as MessageRow[];

  return rows.map((row): Message => {
    if (row.role === 'tool') {
      return {
        role: 'tool',
        content: row.content ?? '',
        tool_call_id: row.tool_call_id ?? '',
      };
    }

    if (row.role === 'assistant') {
      const msg: Message = {
        role: 'assistant',
        content: row.content,
      };

      if (row.tool_calls) {
        try {
          (msg as { tool_calls?: ToolCall[] }).tool_calls = JSON.parse(row.tool_calls) as ToolCall[];
        } catch (error) {
          // Issue #11: Make corrupted JSON visible instead of silently ignoring
          logger.error('CRÍTICO: tool_calls JSON corrupto en DB', {
            messageId: row.id,
            raw: row.tool_calls.slice(0, 100),
            error,
          });
          // Mark the message content to indicate corruption
          msg.content = `[ERROR: tool_calls corrupto - id:${row.id}] ${msg.content || ''}`;
        }
      }

      return msg;
    }

    return {
      role: 'user',
      content: row.content ?? '',
    };
  });
}

export function clearHistory(): void {
  const database = getDatabase();
  database.exec('DELETE FROM messages');
  logger.info('Message history cleared');
}

export function getMessageCount(): number {
  const database = getDatabase();
  const stmt = database.prepare('SELECT COUNT(*) as count FROM messages');
  const result = stmt.get() as { count: number };
  return result.count;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

// ============= Reminder Functions (Fase 3) =============

export interface ReminderRow {
  id: string;
  message: string;
  trigger_at: string;
  created_at: string;
  triggered: number;
  triggered_at: string | null;
  cancelled: number;
}

export function saveReminder(reminder: {
  id: string;
  message: string;
  triggerAt: Date;
}): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO reminders (id, message, trigger_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(reminder.id, reminder.message, reminder.triggerAt.toISOString());
  logger.debug('Saved reminder', { id: reminder.id, triggerAt: reminder.triggerAt });
}

export function getReminder(id: string): ReminderRow | null {
  const database = getDatabase();
  const stmt = database.prepare('SELECT * FROM reminders WHERE id = ?');
  return (stmt.get(id) as ReminderRow) ?? null;
}

export function getPendingReminders(): ReminderRow[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM reminders
    WHERE triggered = 0 AND cancelled = 0
    ORDER BY trigger_at ASC
  `);
  return stmt.all() as ReminderRow[];
}

export function getDueReminders(windowMinutes: number = 5): ReminderRow[] {
  const database = getDatabase();
  const now = new Date();
  const windowMs = windowMinutes * 60 * 1000;
  const windowStart = new Date(now.getTime() - windowMs);
  const windowEnd = new Date(now.getTime() + windowMs);

  const stmt = database.prepare(`
    SELECT * FROM reminders
    WHERE triggered = 0 AND cancelled = 0
      AND trigger_at >= ? AND trigger_at <= ?
    ORDER BY trigger_at ASC
  `);
  return stmt.all(windowStart.toISOString(), windowEnd.toISOString()) as ReminderRow[];
}

export function markReminderTriggered(id: string, status: 1 | 2): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE reminders
    SET triggered = ?, triggered_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(status, id);
  logger.debug('Marked reminder triggered', { id, status });
}

export function cancelReminder(id: string): boolean {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE reminders
    SET cancelled = 1
    WHERE id = ? AND triggered = 0
  `);
  const result = stmt.run(id);
  if (result.changes > 0) {
    logger.debug('Cancelled reminder', { id });
    return true;
  }
  return false;
}

export function cancelAllReminders(): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE reminders
    SET cancelled = 1
    WHERE triggered = 0 AND cancelled = 0
  `);
  const result = stmt.run();
  logger.info('Cancelled all pending reminders', { count: result.changes });
  return result.changes;
}

export function findRemindersByContent(query: string): ReminderRow[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM reminders
    WHERE triggered = 0 AND cancelled = 0
      AND message LIKE ?
    ORDER BY trigger_at ASC
  `);
  return stmt.all(`%${query}%`) as ReminderRow[];
}

export function getLostReminders(): ReminderRow[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM reminders
    WHERE triggered = 1 AND triggered_at IS NOT NULL
  `);
  return stmt.all() as ReminderRow[];
}

// ============= Proactive State Functions (Fase 3) =============

export interface ProactiveStateRow {
  id: number;
  last_spontaneous_message_at: string | null;
  last_reminder_message_at: string | null;
  spontaneous_count_today: number;
  spontaneous_count_this_hour: number;
  date_of_last_daily_count: string | null;
  hour_of_last_hourly_count: number | null;
  consecutive_ticks_with_message: number;
  circuit_breaker_tripped_until: string | null;
  consecutive_mutex_skips: number;
  last_user_message_at: string | null;
  last_user_activity_at: string | null;
  last_greeting_type: string | null;
  last_greeting_date: string | null;
  quiet_mode_until: string | null;
}

export function getProactiveState(): ProactiveStateRow | null {
  const database = getDatabase();
  const stmt = database.prepare('SELECT * FROM proactive_state WHERE id = 1');
  return (stmt.get() as ProactiveStateRow) ?? null;
}

export function initializeProactiveState(): void {
  const database = getDatabase();
  const existing = getProactiveState();
  if (!existing) {
    const stmt = database.prepare(`
      INSERT OR IGNORE INTO proactive_state (id)
      VALUES (1)
    `);
    stmt.run();
    logger.info('Initialized proactive state');
  }
}

export function updateProactiveState(
  updates: Partial<Omit<ProactiveStateRow, 'id'>>
): void {
  const database = getDatabase();

  // Build dynamic UPDATE statement
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    // Convert camelCase to snake_case
    const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    fields.push(`${snakeKey} = ?`);
    values.push(value);
  }

  if (fields.length === 0) return;

  const sql = `UPDATE proactive_state SET ${fields.join(', ')} WHERE id = 1`;
  const stmt = database.prepare(sql);
  stmt.run(...values);
  logger.debug('Updated proactive state', { fields: Object.keys(updates) });
}

export function recordSpontaneousMessage(
  messageType: string,
  content: string
): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO spontaneous_messages (message_type, content)
    VALUES (?, ?)
  `);
  stmt.run(messageType, content);
}

export function countSpontaneousMessagesInLastHour(): number {
  const database = getDatabase();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const stmt = database.prepare(`
    SELECT COUNT(*) as count FROM spontaneous_messages
    WHERE sent_at >= ?
  `);
  const result = stmt.get(oneHourAgo.toISOString()) as { count: number };
  return result.count;
}

/**
 * Gets midnight in the specified timezone as a UTC ISO string.
 * Handles timezone offsets correctly, including those with non-hour offsets (e.g., GMT+5:30).
 */
function getMidnightInTimezoneAsUTC(timezone: string): string {
  const now = new Date();

  // Get today's date in the target timezone (YYYY-MM-DD format)
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = dateFormatter.format(now);

  // Get timezone offset string (e.g., "GMT-3", "GMT+5:30")
  const offsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  });
  const parts = offsetFormatter.formatToParts(now);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName');

  if (!offsetPart) {
    // Fallback: parse in UTC (conservative - may over-count)
    logger.warn('Could not determine timezone offset, using UTC', { timezone });
    return new Date(`${todayStr}T00:00:00Z`).toISOString();
  }

  // Parse offset from "GMT-3" or "GMT+5:30" format
  const offsetValue = offsetPart.value;
  const match = offsetValue.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);

  if (!match) {
    // Fallback for unexpected format
    logger.warn('Unexpected timezone offset format, using UTC', {
      timezone,
      offsetValue,
    });
    return new Date(`${todayStr}T00:00:00Z`).toISOString();
  }

  const sign = match[1];
  const hours = match[2]?.padStart(2, '0') ?? '00';
  const minutes = match[3] ?? '00';
  const isoOffset = `${sign}${hours}:${minutes}`;

  // Create midnight in the target timezone and convert to UTC
  const midnightWithOffset = new Date(`${todayStr}T00:00:00${isoOffset}`);
  return midnightWithOffset.toISOString();
}

export function countSpontaneousMessagesToday(timezone: string): number {
  const database = getDatabase();

  // Get midnight in user's timezone, correctly converted to UTC
  const midnightUTC = getMidnightInTimezoneAsUTC(timezone);

  const stmt = database.prepare(`
    SELECT COUNT(*) as count FROM spontaneous_messages
    WHERE sent_at >= ?
  `);
  const result = stmt.get(midnightUTC) as { count: number };
  return result.count;
}

export function getLastSpontaneousMessageTime(): Date | null {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT sent_at FROM spontaneous_messages
    ORDER BY sent_at DESC
    LIMIT 1
  `);
  const result = stmt.get() as { sent_at: string } | undefined;
  return result ? new Date(result.sent_at) : null;
}

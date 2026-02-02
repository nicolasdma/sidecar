import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import type { Message, ToolCall } from '../llm/types.js';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('memory');

// Current schema version (increment when adding new migrations)
const CURRENT_SCHEMA_VERSION = 4;

const SCHEMA = `
  -- Schema version tracking for migrations
  CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

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

  -- Facts table for SQLite-based memory (Fase 1 Memory Architecture)
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL CHECK (domain IN ('work', 'preferences', 'decisions', 'personal', 'projects', 'health', 'relationships', 'schedule', 'goals', 'general')),
    fact TEXT NOT NULL,
    confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')) DEFAULT 'medium',
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'session')) DEFAULT 'global',
    supersedes TEXT REFERENCES facts(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL CHECK (source IN ('explicit', 'inferred', 'migrated')) DEFAULT 'explicit',
    stale INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_facts_domain ON facts(domain);
  CREATE INDEX IF NOT EXISTS idx_facts_last_confirmed ON facts(last_confirmed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_facts_stale ON facts(stale);

  -- Fase 2: Pending extraction queue for async fact extraction
  CREATE TABLE IF NOT EXISTS pending_extraction (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    role TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pending_extraction_status ON pending_extraction(status);

  -- Fase 2: Structured summaries (4 slots max, FIFO eviction)
  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slot INTEGER NOT NULL CHECK (slot >= 1 AND slot <= 4),
    topic TEXT NOT NULL,
    discussed TEXT NOT NULL,
    outcome TEXT,
    decisions TEXT,
    open_questions TEXT,
    turn_start INTEGER NOT NULL,
    turn_end INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(slot)
  );
  CREATE INDEX IF NOT EXISTS idx_summaries_slot ON summaries(slot);

  -- Fase 3: Fact embeddings with vector data
  CREATE TABLE IF NOT EXISTS fact_embeddings (
    fact_id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    model_version TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
  );

  -- Fase 3: Pending embedding queue for async processing
  CREATE TABLE IF NOT EXISTS pending_embedding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id TEXT NOT NULL UNIQUE,
    attempts INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pending_embedding_status ON pending_embedding(status);

  -- Fase 3: Response cache with version tracking
  CREATE TABLE IF NOT EXISTS response_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_hash TEXT NOT NULL,
    query_embedding BLOB NOT NULL,
    fact_ids_hash TEXT NOT NULL,
    system_version TEXT NOT NULL,
    response TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_response_cache_lookup
    ON response_cache(fact_ids_hash, system_version);
  CREATE INDEX IF NOT EXISTS idx_response_cache_created
    ON response_cache(created_at);

  -- Fase 3.6: System state persistence for crash recovery
  -- Stores state that should survive restarts (backoff, circuit breakers, etc.)
  CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`;

/**
 * Fase 2 schema migrations.
 * NOTE: aging/priority columns were removed per plan review.
 * Decay is now computed at runtime via getDecayStatus() using last_confirmed_at.
 * Empty array kept for backwards compatibility with migration runner.
 */
const FASE2_MIGRATIONS: string[] = [];

// ============= Schema Versioning and Migrations =============

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Database migrations for schema changes.
 * Each migration runs once when version is greater than stored version.
 */
const MIGRATIONS: Migration[] = [
  // Fase 3.6: Add system_state table for crash recovery
  {
    version: 4,
    name: 'add-system-state',
    sql: `
      CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `,
  },
];

/**
 * Gets the current schema version from the database.
 */
function getSchemaVersion(database: Database.Database): number {
  try {
    const row = database.prepare(
      'SELECT version FROM schema_version WHERE id = 1'
    ).get() as { version: number } | undefined;
    return row?.version ?? 0;
  } catch {
    // Table might not exist yet
    return 0;
  }
}

/**
 * Sets the schema version in the database.
 */
function setSchemaVersion(database: Database.Database, version: number): void {
  database.prepare(`
    INSERT INTO schema_version (id, version) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET version = ?, updated_at = datetime('now')
  `).run(version, version);
}

/**
 * Runs pending migrations and updates schema version.
 */
function runMigrations(database: Database.Database): void {
  const currentVersion = getSchemaVersion(database);

  // Initialize schema version for new databases
  if (currentVersion === 0) {
    setSchemaVersion(database, CURRENT_SCHEMA_VERSION);
    logger.info('Initialized schema version', { version: CURRENT_SCHEMA_VERSION });
    return;
  }

  // Run pending migrations
  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      logger.info('Applying migration', {
        version: migration.version,
        name: migration.name,
      });

      database.transaction(() => {
        database.exec(migration.sql);
        setSchemaVersion(database, migration.version);
      })();

      logger.info('Migration applied', { version: migration.version });
    }
  }
}

interface MessageRow {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: string;
}

// ============= Fact Types (Fase 1 Memory Architecture) =============

export type FactDomain = 'work' | 'preferences' | 'decisions' | 'personal' | 'projects' | 'health' | 'relationships' | 'schedule' | 'goals' | 'general';
export type FactConfidence = 'high' | 'medium' | 'low';
export type FactScope = 'global' | 'project' | 'session';
export type FactSource = 'explicit' | 'inferred' | 'migrated';

export interface FactRow {
  id: string;
  domain: FactDomain;
  fact: string;
  confidence: FactConfidence;
  scope: FactScope;
  supersedes: string | null;
  created_at: string;
  last_confirmed_at: string;
  source: FactSource;
  stale: number;
  archived: number;
}

// ============= Fase 2: Pending Extraction Types =============

export type ExtractionStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface PendingExtractionRow {
  id: number;
  message_id: number;
  content: string;
  role: string;
  attempts: number;
  last_attempt_at: string | null;
  status: ExtractionStatus;
  error: string | null;
  created_at: string;
}

// ============= Fase 2: Summary Types =============

export interface SummaryRow {
  id: number;
  slot: number;
  topic: string;
  discussed: string; // JSON array
  outcome: string | null;
  decisions: string | null; // JSON array
  open_questions: string | null; // JSON array
  turn_start: number;
  turn_end: number;
  created_at: string;
}

let db: Database.Database | null = null;

/**
 * Runs Fase 2 migrations idempotently.
 * Each migration can fail if already applied (column exists).
 */
function runFase2Migrations(database: Database.Database): void {
  for (const migration of FASE2_MIGRATIONS) {
    try {
      database.exec(migration);
      logger.debug('Migration applied', { sql: migration.slice(0, 50) });
    } catch (error) {
      // Ignore "duplicate column" errors - migration already applied
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('duplicate column')) {
        logger.debug('Migration already applied (column exists)', { sql: migration.slice(0, 50) });
      } else {
        // Log but don't fail for other errors (be defensive)
        logger.warn('Migration failed (continuing)', { sql: migration.slice(0, 50), error: message });
      }
    }
  }
}

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

export function getDatabase(): Database.Database {
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

  // Enable foreign key enforcement (required for ON DELETE CASCADE to work)
  // SQLite has foreign keys disabled by default for historical compatibility
  db.exec('PRAGMA foreign_keys = ON;');

  // Fase 2: Run migrations for new columns
  runFase2Migrations(db);

  // Run schema version migrations
  runMigrations(db);

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

/**
 * @deprecated Use getPastDueReminders() instead for V2 scheduler
 */
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

/**
 * Get all reminders that are past due (trigger_at <= now).
 * Used by V2 scheduler for catch-up on startup.
 */
export function getPastDueReminders(): ReminderRow[] {
  const database = getDatabase();
  const now = new Date().toISOString();

  const stmt = database.prepare(`
    SELECT * FROM reminders
    WHERE triggered = 0 AND cancelled = 0
      AND trigger_at <= ?
    ORDER BY trigger_at ASC
  `);
  return stmt.all(now) as ReminderRow[];
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

// ============= Fase 2: Pending Extraction Functions =============

/**
 * Adds a message to the extraction queue.
 * Uses INSERT OR IGNORE to handle duplicate message_ids gracefully.
 */
export function queueMessageForExtraction(
  messageId: number,
  content: string,
  role: string
): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO pending_extraction (message_id, content, role)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(messageId, content, role);
  if (result.changes > 0) {
    logger.debug('Queued message for extraction', { messageId });
  }
}

/**
 * Gets pending messages for extraction, ordered by creation time.
 */
export function getPendingExtractions(limit: number = 10): PendingExtractionRow[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM pending_extraction
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `);
  return stmt.all(limit) as PendingExtractionRow[];
}

/**
 * Marks an extraction as in-progress.
 */
export function markExtractionProcessing(id: number): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE pending_extraction
    SET status = 'processing', last_attempt_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(id);
}

/**
 * Marks an extraction as completed.
 */
export function markExtractionCompleted(id: number): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE pending_extraction
    SET status = 'completed'
    WHERE id = ?
  `);
  stmt.run(id);
  logger.debug('Extraction completed', { id });
}

/**
 * Marks an extraction as failed and increments attempt count.
 */
export function markExtractionFailed(id: number, error: string): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE pending_extraction
    SET status = CASE WHEN attempts >= 2 THEN 'failed' ELSE 'pending' END,
        attempts = attempts + 1,
        last_attempt_at = datetime('now'),
        error = ?
    WHERE id = ?
  `);
  stmt.run(error, id);
  logger.debug('Extraction attempt failed', { id, error });
}

/**
 * Gets count of pending extractions.
 */
export function getPendingExtractionCount(): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT COUNT(*) as count FROM pending_extraction
    WHERE status = 'pending'
  `);
  const result = stmt.get() as { count: number };
  return result.count;
}

/**
 * Cleans up old completed/failed extractions (older than 7 days).
 */
export function cleanupOldExtractions(): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    DELETE FROM pending_extraction
    WHERE status IN ('completed', 'failed')
      AND created_at < datetime('now', '-7 days')
  `);
  const result = stmt.run();
  if (result.changes > 0) {
    logger.info('Cleaned up old extractions', { count: result.changes });
  }
  return result.changes;
}

/**
 * Recovers stalled extractions (stuck in 'processing' status).
 * Called at startup to reset items that were being processed when the app crashed.
 * Items stuck in 'processing' status would never be retried otherwise.
 */
export function recoverStalledExtractions(): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE pending_extraction
    SET status = 'pending',
        attempts = attempts + 1,
        error = 'Recovered from stalled processing state'
    WHERE status = 'processing'
  `);
  const result = stmt.run();
  if (result.changes > 0) {
    logger.warn('Recovered stalled extractions', { count: result.changes });
  }
  return result.changes;
}

/**
 * Health-related keywords that should never be dropped from queue.
 * These are critical facts that could affect user safety.
 */
const HEALTH_KEYWORDS = [
  // Spanish
  'alergia', 'alergico', 'alérgico', 'alergica', 'alérgica',
  'medicamento', 'medicina', 'pastilla', 'remedio',
  'enfermedad', 'enfermo', 'enferma',
  'diabetes', 'diabético', 'diabetico', 'diabética', 'diabetica',
  'hipertensión', 'hipertension', 'presión', 'presion',
  'asma', 'asmático', 'asmatico',
  'epilepsia', 'epiléptico', 'epileptico',
  'cirugía', 'cirugia', 'operación', 'operacion',
  'embarazo', 'embarazada',
  'doctor', 'médico', 'medico', 'hospital', 'clínica', 'clinica',
  // English
  'allergy', 'allergic', 'medication', 'medicine', 'pill',
  'disease', 'diabetes', 'diabetic', 'hypertension', 'asthma',
  'epilepsy', 'surgery', 'pregnant', 'pregnancy', 'hospital',
];

/**
 * Checks if content contains health-related keywords.
 */
function containsHealthKeywords(content: string): boolean {
  const lower = content.toLowerCase();
  return HEALTH_KEYWORDS.some(keyword => lower.includes(keyword));
}

/**
 * Enforces max queue size by removing oldest pending items.
 * IMPORTANT: Items containing health keywords are never dropped.
 * Called when queue exceeds MAX_QUEUE_SIZE to prevent unbounded growth.
 *
 * @param maxSize - Maximum number of pending items to keep (default: 1000)
 * @returns Number of items removed
 */
export function enforceQueueSizeLimit(maxSize: number = 1000): number {
  const database = getDatabase();

  // Count current pending items
  const countStmt = database.prepare(`
    SELECT COUNT(*) as count FROM pending_extraction
    WHERE status = 'pending'
  `);
  const { count } = countStmt.get() as { count: number };

  if (count <= maxSize) {
    return 0;
  }

  // Get oldest pending items to evaluate for deletion
  const toRemove = count - maxSize;
  const selectStmt = database.prepare(`
    SELECT id, content FROM pending_extraction
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `);
  const candidates = selectStmt.all(toRemove * 2) as Array<{ id: number; content: string }>;

  // Filter out health-related items
  const idsToDelete: number[] = [];
  let healthProtected = 0;

  for (const item of candidates) {
    if (idsToDelete.length >= toRemove) break;

    if (containsHealthKeywords(item.content)) {
      healthProtected++;
      continue;
    }

    idsToDelete.push(item.id);
  }

  if (idsToDelete.length === 0) {
    if (healthProtected > 0) {
      logger.warn('Queue overflow but all items contain health keywords - keeping all', {
        queueSize: count,
        healthProtected,
      });
    }
    return 0;
  }

  // Delete non-health items
  const placeholders = idsToDelete.map(() => '?').join(',');
  const deleteStmt = database.prepare(`
    DELETE FROM pending_extraction
    WHERE id IN (${placeholders})
  `);

  const result = deleteStmt.run(...idsToDelete);
  if (result.changes > 0) {
    logger.warn('Enforced queue size limit - dropped oldest non-health items', {
      removed: result.changes,
      healthProtected,
      maxSize,
    });
  }
  return result.changes;
}

/**
 * Retries failed extractions by resetting their status to pending.
 * Useful for manual recovery when extraction logic has been fixed.
 *
 * @param maxRetries - Maximum attempts before leaving as failed (default: 5)
 * @returns Number of items reset for retry
 */
export function retryFailedExtractions(maxRetries: number = 5): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE pending_extraction
    SET status = 'pending',
        error = NULL
    WHERE status = 'failed'
      AND attempts < ?
  `);
  const result = stmt.run(maxRetries);
  if (result.changes > 0) {
    logger.info('Reset failed extractions for retry', { count: result.changes });
  }
  return result.changes;
}

/**
 * Purges the entire extraction queue.
 * Use with caution - removes all pending, processing, and failed items.
 *
 * @returns Number of items purged
 */
export function purgeExtractionQueue(): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    DELETE FROM pending_extraction
    WHERE status IN ('pending', 'processing', 'failed')
  `);
  const result = stmt.run();
  if (result.changes > 0) {
    logger.warn('Purged extraction queue', { count: result.changes });
  }
  return result.changes;
}

// ============= Fase 2: Summary Functions =============

export interface SummaryData {
  topic: string;
  discussed: string[];
  outcome?: string;
  decisions?: string[];
  openQuestions?: string[];
  turnStart: number;
  turnEnd: number;
}

/**
 * Saves a new summary to the next available slot.
 * Implements FIFO eviction when all 4 slots are full.
 *
 * IMPORTANT: The entire operation (slot selection + insert) is wrapped in
 * a transaction to prevent race conditions when two summaries are saved
 * concurrently.
 */
export function saveSummary(data: SummaryData): number {
  const database = getDatabase();

  // Wrap slot selection and insertion in a single transaction
  // to prevent concurrent writes from getting the same slot
  const saveWithSlotAllocation = database.transaction(() => {
    // Find first empty slot (inline to keep transaction short)
    const emptySlot = database.prepare(`
      SELECT s.slot FROM (SELECT 1 as slot UNION SELECT 2 UNION SELECT 3 UNION SELECT 4) s
      LEFT JOIN summaries ON s.slot = summaries.slot
      WHERE summaries.id IS NULL
      ORDER BY s.slot
      LIMIT 1
    `).get() as { slot: number } | undefined;

    let slot: number;
    let evicted = false;

    if (emptySlot) {
      slot = emptySlot.slot;
    } else {
      // All slots full - evict slot 1 and shift others
      database.prepare('DELETE FROM summaries WHERE slot = 1').run();
      database.prepare('UPDATE summaries SET slot = slot - 1 WHERE slot > 1').run();
      slot = 4;
      evicted = true;
    }

    // Insert the new summary
    database.prepare(`
      INSERT OR REPLACE INTO summaries (slot, topic, discussed, outcome, decisions, open_questions, turn_start, turn_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      slot,
      data.topic,
      JSON.stringify(data.discussed),
      data.outcome ?? null,
      data.decisions ? JSON.stringify(data.decisions) : null,
      data.openQuestions ? JSON.stringify(data.openQuestions) : null,
      data.turnStart,
      data.turnEnd
    );

    return { slot, evicted };
  });

  const { slot, evicted } = saveWithSlotAllocation();

  if (evicted) {
    logger.info('Evicted oldest summary for new one');
  }
  logger.info('Saved summary', { slot, topic: data.topic });
  return slot;
}

/**
 * Gets all active summaries, ordered by slot.
 */
export function getActiveSummaries(): SummaryRow[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM summaries
    ORDER BY slot ASC
  `);
  return stmt.all() as SummaryRow[];
}

/**
 * Gets summary count.
 */
export function getSummaryCount(): number {
  const database = getDatabase();
  const stmt = database.prepare('SELECT COUNT(*) as count FROM summaries');
  const result = stmt.get() as { count: number };
  return result.count;
}

/**
 * Clears all summaries (for testing or reset).
 */
export function clearSummaries(): void {
  const database = getDatabase();
  database.exec('DELETE FROM summaries');
  logger.info('Cleared all summaries');
}

// ============= Fase 2: Fact Decay Functions =============

/**
 * Gets facts that need decay check (not stale, not archived).
 * @deprecated Use getFactsForDecayCheckPaginated for large datasets
 */
export function getFactsForDecayCheck(): FactRow[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM facts
    WHERE stale = 0 AND archived = 0
    ORDER BY last_confirmed_at ASC
  `);
  return stmt.all() as FactRow[];
}

/**
 * Gets facts for decay check with pagination.
 * Use this for large datasets to avoid blocking the event loop.
 *
 * @param limit - Maximum facts to return (default: 100)
 * @param offset - Number of facts to skip (default: 0)
 * @returns Array of facts for decay check
 */
export function getFactsForDecayCheckPaginated(limit: number = 100, offset: number = 0): FactRow[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM facts
    WHERE stale = 0 AND archived = 0
    ORDER BY last_confirmed_at ASC
    LIMIT ? OFFSET ?
  `);
  return stmt.all(limit, offset) as FactRow[];
}

/**
 * Gets total count of facts that need decay check.
 */
export function getFactsForDecayCount(): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT COUNT(*) as count FROM facts
    WHERE stale = 0 AND archived = 0
  `);
  const result = stmt.get() as { count: number };
  return result.count;
}

/**
 * Gets decay statistics using SQL date math.
 * Computes decay stages at query time based on last_confirmed_at.
 *
 * Decay stages:
 * - aging: 60-89 days since confirmation
 * - lowPriority: 90-119 days since confirmation
 * - stale: 120+ days (uses stale column for efficiency)
 */
export function getDecayStatsFromDb(): {
  aging: number;
  lowPriority: number;
  stale: number;
} {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT
      SUM(CASE
        WHEN stale = 0 AND archived = 0
          AND julianday('now') - julianday(last_confirmed_at) >= 60
          AND julianday('now') - julianday(last_confirmed_at) < 90
        THEN 1 ELSE 0
      END) as aging,
      SUM(CASE
        WHEN stale = 0 AND archived = 0
          AND julianday('now') - julianday(last_confirmed_at) >= 90
          AND julianday('now') - julianday(last_confirmed_at) < 120
        THEN 1 ELSE 0
      END) as lowPriority,
      SUM(CASE WHEN stale = 1 AND archived = 0 THEN 1 ELSE 0 END) as stale
    FROM facts
  `);
  const result = stmt.get() as { aging: number | null; lowPriority: number | null; stale: number | null };
  return {
    aging: result.aging ?? 0,
    lowPriority: result.lowPriority ?? 0,
    stale: result.stale ?? 0,
  };
}

/**
 * Marks a fact as stale.
 */
export function markFactAsStale(id: string): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE facts SET stale = 1 WHERE id = ?
  `);
  stmt.run(id);
  logger.info('Marked fact as stale due to decay', { id });
}

// ============= Fase 3: Pending Embedding Functions =============

export type EmbeddingStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface PendingEmbeddingRow {
  id: number;
  fact_id: string;
  attempts: number;
  last_attempt_at: string | null;
  status: EmbeddingStatus;
  error: string | null;
  created_at: string;
}

/**
 * Queues a fact for embedding.
 * Uses INSERT OR IGNORE to handle duplicates gracefully.
 */
export function queueFactForEmbedding(factId: string): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO pending_embedding (fact_id)
    VALUES (?)
  `);
  const result = stmt.run(factId);
  if (result.changes > 0) {
    logger.debug('Queued fact for embedding', { factId });
  }
}

/**
 * Gets pending embeddings for processing.
 */
export function getPendingEmbeddings(limit: number = 10): PendingEmbeddingRow[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM pending_embedding
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `);
  return stmt.all(limit) as PendingEmbeddingRow[];
}

/**
 * Gets count of pending embeddings.
 */
export function getPendingEmbeddingCount(): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT COUNT(*) as count FROM pending_embedding
    WHERE status = 'pending'
  `);
  const result = stmt.get() as { count: number };
  return result.count;
}

/**
 * Marks an embedding as in-progress.
 */
export function markEmbeddingProcessing(id: number): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE pending_embedding
    SET status = 'processing', last_attempt_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(id);
}

/**
 * Marks an embedding as completed and removes from queue.
 */
export function markEmbeddingCompleted(id: number): void {
  const database = getDatabase();
  const stmt = database.prepare(`DELETE FROM pending_embedding WHERE id = ?`);
  stmt.run(id);
  logger.debug('Embedding completed', { id });
}

/**
 * Marks an embedding as failed and increments attempt count.
 */
export function markEmbeddingFailed(id: number, error: string): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE pending_embedding
    SET status = CASE WHEN attempts >= 2 THEN 'failed' ELSE 'pending' END,
        attempts = attempts + 1,
        last_attempt_at = datetime('now'),
        error = ?
    WHERE id = ?
  `);
  stmt.run(error, id);
  logger.debug('Embedding attempt failed', { id, error });
}

/**
 * Recovers stalled embeddings (stuck in 'processing' status).
 * Called at startup to reset items that were being processed when the app crashed.
 */
export function recoverStalledEmbeddings(): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE pending_embedding
    SET status = 'pending',
        attempts = attempts + 1,
        error = 'Recovered from stalled processing state'
    WHERE status = 'processing'
  `);
  const result = stmt.run();
  if (result.changes > 0) {
    logger.warn('Recovered stalled embeddings', { count: result.changes });
  }
  return result.changes;
}

/**
 * Cleans up old failed embedding records.
 */
export function cleanupFailedEmbeddings(retentionDays: number = 7): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    DELETE FROM pending_embedding
    WHERE status = 'failed'
      AND datetime(created_at, '+' || ? || ' days') < datetime('now')
  `);
  const result = stmt.run(retentionDays);
  if (result.changes > 0) {
    logger.debug('Cleaned up old failed embeddings', { count: result.changes });
  }
  return result.changes;
}

// ============= Fase 3: Fact Embeddings Storage =============

export interface FactEmbeddingRow {
  fact_id: string;
  embedding: Buffer;
  model_version: string;
  created_at: string;
}

/**
 * Saves a fact embedding to the database.
 */
export function saveFactEmbedding(
  factId: string,
  embedding: Buffer,
  modelVersion: string
): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding, model_version)
    VALUES (?, ?, ?)
  `);
  stmt.run(factId, embedding, modelVersion);
  logger.debug('Saved fact embedding', { factId, modelVersion });
}

/**
 * Gets a fact embedding by fact ID.
 */
export function getFactEmbedding(factId: string): FactEmbeddingRow | null {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM fact_embeddings WHERE fact_id = ?
  `);
  return (stmt.get(factId) as FactEmbeddingRow) ?? null;
}

/**
 * Gets all fact embeddings for a list of fact IDs.
 */
export function getFactEmbeddings(factIds: string[]): FactEmbeddingRow[] {
  if (factIds.length === 0) return [];

  const database = getDatabase();
  const placeholders = factIds.map(() => '?').join(',');
  const stmt = database.prepare(`
    SELECT * FROM fact_embeddings WHERE fact_id IN (${placeholders})
  `);
  return stmt.all(...factIds) as FactEmbeddingRow[];
}

/**
 * Gets facts that need embedding (no embedding or outdated model).
 */
export function getFactsNeedingEmbedding(modelVersion: string, limit: number = 100): FactRow[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT f.* FROM facts f
    LEFT JOIN fact_embeddings e ON f.id = e.fact_id
    LEFT JOIN pending_embedding p ON f.id = p.fact_id
    WHERE f.stale = 0 AND f.archived = 0
      AND (e.fact_id IS NULL OR e.model_version != ?)
      AND (p.fact_id IS NULL OR p.status = 'failed')
    LIMIT ?
  `);
  return stmt.all(modelVersion, limit) as FactRow[];
}

/**
 * Deletes a fact embedding.
 */
export function deleteFactEmbedding(factId: string): boolean {
  const database = getDatabase();
  const stmt = database.prepare(`DELETE FROM fact_embeddings WHERE fact_id = ?`);
  const result = stmt.run(factId);
  return result.changes > 0;
}

/**
 * Fase 3.6: Gets embedding version statistics for drift detection.
 */
export function getEmbeddingVersionStats(): { version: string; count: number }[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT model_version as version, COUNT(*) as count
    FROM fact_embeddings
    GROUP BY model_version
    ORDER BY count DESC
  `);
  return stmt.all() as { version: string; count: number }[];
}

/**
 * Fase 3.6: Counts embeddings with outdated model version.
 */
export function countOutdatedEmbeddings(currentVersion: string): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT COUNT(*) as count FROM fact_embeddings
    WHERE model_version != ?
  `);
  const row = stmt.get(currentVersion) as { count: number };
  return row.count;
}

// ============= Fase 3: Response Cache Functions =============

export interface ResponseCacheRow {
  id: number;
  query_hash: string;
  query_embedding: Buffer;
  fact_ids_hash: string;
  system_version: string;
  response: string;
  ttl_seconds: number;
  created_at: string;
}

/**
 * Saves a response to the cache.
 */
export function saveResponseCache(entry: {
  queryHash: string;
  queryEmbedding: Buffer;
  factIdsHash: string;
  systemVersion: string;
  response: string;
  ttlSeconds: number;
}): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO response_cache
      (query_hash, query_embedding, fact_ids_hash, system_version, response, ttl_seconds)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    entry.queryHash,
    entry.queryEmbedding,
    entry.factIdsHash,
    entry.systemVersion,
    entry.response,
    entry.ttlSeconds
  );
  logger.debug('Saved response to cache', { queryHash: entry.queryHash });
}

/**
 * Gets cache candidates with matching fact hash and system version.
 * Returns entries that haven't expired yet.
 */
export function getResponseCacheCandidates(
  factIdsHash: string,
  systemVersion: string
): ResponseCacheRow[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM response_cache
    WHERE fact_ids_hash = ?
      AND system_version = ?
      AND datetime(created_at, '+' || ttl_seconds || ' seconds') > datetime('now')
  `);
  return stmt.all(factIdsHash, systemVersion) as ResponseCacheRow[];
}

/**
 * Cleans up expired cache entries.
 */
export function cleanupExpiredCache(): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    DELETE FROM response_cache
    WHERE datetime(created_at, '+' || ttl_seconds || ' seconds') < datetime('now')
  `);
  const result = stmt.run();
  if (result.changes > 0) {
    logger.debug('Cleaned expired cache entries', { count: result.changes });
  }
  return result.changes;
}

/**
 * Clears the entire response cache.
 */
export function clearResponseCache(): number {
  const database = getDatabase();
  const stmt = database.prepare(`DELETE FROM response_cache`);
  const result = stmt.run();
  if (result.changes > 0) {
    logger.info('Cleared response cache', { count: result.changes });
  }
  return result.changes;
}

// ============= Fase 3.6: System State Persistence =============

/**
 * Gets a value from the system state store.
 * Returns null if the key doesn't exist.
 */
export function getSystemState(key: string): string | null {
  const database = getDatabase();
  const row = database.prepare(
    'SELECT value FROM system_state WHERE key = ?'
  ).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Gets a JSON value from the system state store.
 * Returns null if the key doesn't exist or JSON is invalid.
 */
export function getSystemStateJson<T>(key: string): T | null {
  const value = getSystemState(key);
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    logger.warn('Invalid JSON in system state', { key });
    return null;
  }
}

/**
 * Sets a value in the system state store.
 */
export function setSystemState(key: string, value: string): void {
  const database = getDatabase();
  database.prepare(`
    INSERT INTO system_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}

/**
 * Sets a JSON value in the system state store.
 */
export function setSystemStateJson(key: string, value: unknown): void {
  setSystemState(key, JSON.stringify(value));
}

/**
 * Deletes a key from the system state store.
 */
export function deleteSystemState(key: string): boolean {
  const database = getDatabase();
  const result = database.prepare(
    'DELETE FROM system_state WHERE key = ?'
  ).run(key);
  return result.changes > 0;
}

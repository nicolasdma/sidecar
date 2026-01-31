import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
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

function getDatabase(): Database.Database {
  if (db) {
    return db;
  }

  const dataDir = config.paths.data;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    logger.info(`Created data directory: ${dataDir}`);
  }

  const dbPath = join(dataDir, 'memory.db');
  db = new Database(dbPath);
  db.exec(SCHEMA);

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

export function loadHistory(limit: number = 50): Message[] {
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
        } catch {
          logger.warn('Failed to parse tool_calls JSON');
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

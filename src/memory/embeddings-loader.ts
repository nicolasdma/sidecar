/**
 * Fase 3: SQLite-vec Extension Loader
 *
 * Handles loading the sqlite-vec extension for vector operations.
 * Tries system paths first, then falls back to bundled binaries.
 */

import { platform, arch } from 'os';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('embeddings-loader');

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Map of platform-arch to bundled binary path.
 */
const EXTENSION_MAP: Record<string, string> = {
  'darwin-arm64': 'darwin-arm64/vec0.dylib',
  'darwin-x64': 'darwin-x64/vec0.dylib',
  'linux-x64': 'linux-x64/vec0.so',
  'linux-arm64': 'linux-arm64/vec0.so',
};

/**
 * Common system paths where sqlite-vec might be installed.
 */
const SYSTEM_PATHS: Record<string, string[]> = {
  darwin: [
    '/opt/homebrew/lib/vec0.dylib',        // Homebrew on Apple Silicon
    '/usr/local/lib/vec0.dylib',           // Homebrew on Intel
    '/opt/homebrew/opt/sqlite-vec/lib/vec0.dylib',
    '/usr/local/opt/sqlite-vec/lib/vec0.dylib',
  ],
  linux: [
    '/usr/lib/sqlite3/vec0.so',
    '/usr/local/lib/vec0.so',
    '/usr/lib/x86_64-linux-gnu/vec0.so',
  ],
};

export interface LoadExtensionResult {
  success: boolean;
  source: 'system' | 'bundled' | 'none';
  path?: string;
  error?: string;
}

/**
 * Finds sqlite-vec extension in system paths.
 */
function findSystemExtension(): string | null {
  const paths = SYSTEM_PATHS[platform()] || [];
  for (const p of paths) {
    if (existsSync(p)) {
      logger.debug('Found system sqlite-vec', { path: p });
      return p;
    }
  }
  return null;
}

/**
 * Finds bundled sqlite-vec extension for current platform.
 */
function findBundledExtension(): string | null {
  const key = `${platform()}-${arch()}`;
  const relativePath = EXTENSION_MAP[key];

  if (!relativePath) {
    logger.warn('sqlite-vec not bundled for platform', { platform: key });
    return null;
  }

  // Look in vendor directory relative to project root
  const projectRoot = join(__dirname, '..', '..');
  const extensionPath = join(projectRoot, 'vendor', 'sqlite-vec', relativePath);

  if (!existsSync(extensionPath)) {
    logger.debug('Bundled sqlite-vec not found', { path: extensionPath });
    return null;
  }

  return extensionPath;
}

/**
 * Attempts to load sqlite-vec extension into the database.
 * Tries system installation first, then bundled binaries.
 *
 * @param db - better-sqlite3 database instance
 * @returns Result indicating success/failure and source
 */
export function loadSqliteVec(db: Database.Database): LoadExtensionResult {
  // Try system installation first (preferred for updates)
  const systemPath = findSystemExtension();
  if (systemPath) {
    try {
      db.loadExtension(systemPath);
      logger.info('sqlite-vec loaded from system', { path: systemPath });
      return { success: true, source: 'system', path: systemPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('System sqlite-vec failed, trying bundled', { error: message });

      // Check for ABI mismatch
      if (message.includes('symbol') || message.includes('undefined')) {
        logger.warn('Possible SQLite version mismatch between sqlite-vec and better-sqlite3');
      }
    }
  }

  // Fall back to bundled binary
  const bundledPath = findBundledExtension();
  if (!bundledPath) {
    return {
      success: false,
      source: 'none',
      error: 'No compatible sqlite-vec binary found. Install via Homebrew: brew install asg017/sqlite-vec/sqlite-vec',
    };
  }

  try {
    db.loadExtension(bundledPath);
    logger.info('sqlite-vec loaded from bundle', { path: bundledPath });
    return { success: true, source: 'bundled', path: bundledPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to load sqlite-vec', { error: message });
    return { success: false, source: 'none', error: message };
  }
}

/**
 * Creates the fact_vectors virtual table for vector search.
 * This table uses the vec0 module from sqlite-vec.
 *
 * Note: This must be called AFTER loadSqliteVec succeeds.
 *
 * @param db - better-sqlite3 database instance with vec0 loaded
 * @param dimension - Vector dimension (default: 384 for all-MiniLM-L6-v2)
 */
export function createVectorIndex(db: Database.Database, dimension: number = 384): void {
  try {
    // Create virtual table for vector similarity search
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fact_vectors USING vec0(
        fact_id TEXT PRIMARY KEY,
        embedding FLOAT[${dimension}]
      );
    `);
    logger.info('Vector index created', { dimension });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to create vector index', { error: message });
    throw error;
  }
}

/**
 * Checks if vec0 extension is available.
 *
 * @param db - better-sqlite3 database instance
 * @returns true if vec0 functions are available
 */
export function isVec0Available(db: Database.Database): boolean {
  try {
    // Try to use a vec0 function
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Inserts or updates a vector in the fact_vectors table.
 *
 * @param db - better-sqlite3 database instance
 * @param factId - Fact identifier
 * @param embedding - Vector as Buffer (serialized Float32Array)
 */
export function upsertFactVector(
  db: Database.Database,
  factId: string,
  embedding: Buffer
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO fact_vectors (fact_id, embedding)
    VALUES (?, ?)
  `);
  stmt.run(factId, embedding);
}

/**
 * Deletes a vector from the fact_vectors table.
 *
 * @param db - better-sqlite3 database instance
 * @param factId - Fact identifier
 */
export function deleteFactVector(db: Database.Database, factId: string): void {
  const stmt = db.prepare(`DELETE FROM fact_vectors WHERE fact_id = ?`);
  stmt.run(factId);
}

/**
 * Performs vector similarity search using cosine distance.
 *
 * @param db - better-sqlite3 database instance
 * @param queryEmbedding - Query vector as Buffer
 * @param limit - Maximum results to return
 * @returns Array of {fact_id, distance} sorted by distance (lowest = most similar)
 */
export function searchVectors(
  db: Database.Database,
  queryEmbedding: Buffer,
  limit: number = 10
): Array<{ fact_id: string; distance: number }> {
  const stmt = db.prepare(`
    SELECT
      fact_id,
      vec_distance_cosine(embedding, ?) as distance
    FROM fact_vectors
    ORDER BY distance ASC
    LIMIT ?
  `);
  return stmt.all(queryEmbedding, limit) as Array<{ fact_id: string; distance: number }>;
}

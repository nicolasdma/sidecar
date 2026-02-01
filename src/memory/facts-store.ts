/**
 * Facts Store - SQLite-based facts storage (Fase 1 Memory Architecture)
 *
 * Provides CRUD operations for facts with keyword filtering support.
 * Migrates from file-based learnings.md to structured SQLite storage.
 */

import { randomUUID } from 'crypto';
import {
  getDatabase,
  type FactRow,
  type FactDomain,
  type FactConfidence,
  type FactScope,
  type FactSource,
} from './store.js';
import { extractSignificantWords } from './stopwords.js';
import { createLogger } from '../utils/logger.js';
import { getDecayStatus } from './decay-service.js';

const logger = createLogger('facts-store');

// ============= Type Definitions =============

export interface NewFact {
  domain: FactDomain;
  fact: string;
  confidence?: FactConfidence;
  scope?: FactScope;
  source?: FactSource;
  supersedes?: string;
}

export interface FactFilter {
  domain?: FactDomain;
  includeStale?: boolean;
  includeArchived?: boolean;
  limit?: number;
}

export interface StoredFact {
  id: string;
  domain: FactDomain;
  fact: string;
  confidence: FactConfidence;
  scope: FactScope;
  supersedes: string | null;
  createdAt: Date;
  lastConfirmedAt: Date;
  source: FactSource;
  stale: boolean;
  archived: boolean;
}

// ============= Domain Mapping =============

/**
 * Maps old category names (from learnings.md) to new domain names.
 */
export const CATEGORY_TO_DOMAIN: Record<string, FactDomain> = {
  'Health': 'health',
  'Preferences': 'preferences',
  'Work': 'work',
  'Relationships': 'relationships',
  'Schedule': 'schedule',
  'Goals': 'goals',
  'General': 'general',
  'Unparsed': 'general',
};

/**
 * Maps weight (1-10) to confidence level.
 */
export function weightToConfidence(weight: number): FactConfidence {
  if (weight >= 7) return 'high';
  if (weight >= 4) return 'medium';
  return 'low';
}

// ============= CRUD Operations =============

/**
 * Converts a database row to a StoredFact object.
 */
function rowToFact(row: FactRow): StoredFact {
  return {
    id: row.id,
    domain: row.domain,
    fact: row.fact,
    confidence: row.confidence,
    scope: row.scope,
    supersedes: row.supersedes,
    createdAt: new Date(row.created_at),
    lastConfirmedAt: new Date(row.last_confirmed_at),
    source: row.source,
    stale: row.stale === 1,
    archived: row.archived === 1,
  };
}

/**
 * Saves a new fact to the database.
 * Returns the generated fact ID.
 */
export function saveFact(newFact: NewFact): string {
  const db = getDatabase();
  const id = randomUUID();

  const stmt = db.prepare(`
    INSERT INTO facts (id, domain, fact, confidence, scope, source, supersedes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    newFact.domain,
    newFact.fact,
    newFact.confidence ?? 'medium',
    newFact.scope ?? 'global',
    newFact.source ?? 'explicit',
    newFact.supersedes ?? null
  );

  logger.info('Saved new fact', { id, domain: newFact.domain });
  return id;
}

/**
 * Retrieves facts with optional filtering.
 */
export function getFacts(options: FactFilter = {}): StoredFact[] {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.domain) {
    conditions.push('domain = ?');
    params.push(options.domain);
  }

  if (!options.includeStale) {
    conditions.push('stale = 0');
  }

  if (!options.includeArchived) {
    conditions.push('archived = 0');
  }

  let sql = 'SELECT * FROM facts';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY last_confirmed_at DESC';

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as FactRow[];

  return rows.map(rowToFact);
}

/**
 * Retrieves facts filtered by domain.
 */
export function getFactsByDomain(domain: FactDomain): StoredFact[] {
  return getFacts({ domain });
}

/**
 * Updates the last_confirmed_at timestamp for a fact.
 */
export function updateFactConfirmation(id: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE facts
    SET last_confirmed_at = datetime('now')
    WHERE id = ?
  `);
  const result = stmt.run(id);

  if (result.changes > 0) {
    logger.debug('Updated fact confirmation', { id });
  } else {
    logger.warn('Fact not found for confirmation update', { id });
  }
}

/**
 * Marks a fact as stale.
 */
export function markFactStale(id: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE facts
    SET stale = 1
    WHERE id = ?
  `);
  const result = stmt.run(id);

  if (result.changes > 0) {
    logger.info('Marked fact as stale', { id });
  } else {
    logger.warn('Fact not found for stale marking', { id });
  }
}

/**
 * Creates a new fact that supersedes an existing one.
 * The old fact is marked as archived, and the new fact references it.
 */
export function supersedeFact(oldId: string, newFact: NewFact): string {
  const db = getDatabase();

  // Archive the old fact
  const archiveStmt = db.prepare(`
    UPDATE facts
    SET archived = 1
    WHERE id = ?
  `);
  archiveStmt.run(oldId);

  // Create new fact with supersedes reference
  const newId = saveFact({
    ...newFact,
    supersedes: oldId,
  });

  logger.info('Superseded fact', { oldId, newId });
  return newId;
}

/**
 * Deletes a fact by ID.
 */
export function deleteFact(id: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM facts WHERE id = ?');
  const result = stmt.run(id);

  if (result.changes > 0) {
    logger.info('Deleted fact', { id });
    return true;
  }

  logger.warn('Fact not found for deletion', { id });
  return false;
}

/**
 * Gets a single fact by ID.
 */
export function getFactById(id: string): StoredFact | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM facts WHERE id = ?');
  const row = stmt.get(id) as FactRow | undefined;

  return row ? rowToFact(row) : null;
}

// ============= Keyword Filtering =============

/**
 * Filters facts by keyword matching against a query.
 * Uses word overlap scoring to rank relevance.
 * Fase 2: Uses getDecayStatus() to filter aging/low-priority facts.
 *
 * Algorithm:
 * 1. Extract significant words from query (remove stopwords)
 * 2. For each fact, count matching words and compute relevance score
 * 3. Apply decay filtering: old facts need higher relevance to be included
 * 4. Return facts with at least one match, sorted by match count
 */
export function filterFactsByKeywords(
  query: string,
  limit: number = 10
): StoredFact[] {
  const db = getDatabase();

  // Get all active facts
  const stmt = db.prepare(`
    SELECT * FROM facts
    WHERE stale = 0 AND archived = 0
    ORDER BY last_confirmed_at DESC
  `);
  const rows = stmt.all() as FactRow[];

  if (rows.length === 0) {
    return [];
  }

  // Extract significant words from query
  const queryWords = extractSignificantWords(query);

  if (queryWords.size === 0) {
    // No significant words - return most recent facts that pass decay filter
    return rows
      .filter(row => {
        const decay = getDecayStatus(row.last_confirmed_at);
        // Without query relevance, only include fresh/aging facts
        return decay.inject && decay.relevanceThreshold <= 0.3;
      })
      .slice(0, limit)
      .map(rowToFact);
  }

  // Score each fact by word overlap
  const scored: Array<{ row: FactRow; score: number }> = [];

  for (const row of rows) {
    const factWords = extractSignificantWords(row.fact);
    let matchCount = 0;

    for (const word of queryWords) {
      if (factWords.has(word)) {
        matchCount++;
      }
    }

    if (matchCount > 0) {
      // Normalize score by query word count for fair comparison
      const score = matchCount / queryWords.size;

      // Fase 2: Apply decay filtering based on relevance score
      const decay = getDecayStatus(row.last_confirmed_at);
      if (!decay.inject || score < decay.relevanceThreshold) {
        continue;
      }

      scored.push({ row, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Return top matches
  return scored.slice(0, limit).map(({ row }) => rowToFact(row));
}

/**
 * Gets all health facts (always included in context).
 */
export function getHealthFacts(): StoredFact[] {
  return getFactsByDomain('health');
}

/**
 * Gets facts count by domain for stats.
 */
export function getFactsStats(): Record<FactDomain, number> {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT domain, COUNT(*) as count
    FROM facts
    WHERE stale = 0 AND archived = 0
    GROUP BY domain
  `);
  const rows = stmt.all() as Array<{ domain: FactDomain; count: number }>;

  const stats: Record<FactDomain, number> = {
    work: 0,
    preferences: 0,
    decisions: 0,
    personal: 0,
    projects: 0,
    health: 0,
    relationships: 0,
    schedule: 0,
    goals: 0,
    general: 0,
  };

  for (const row of rows) {
    stats[row.domain] = row.count;
  }

  return stats;
}

/**
 * Gets total count of active facts.
 */
export function getTotalFactsCount(): number {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM facts
    WHERE stale = 0 AND archived = 0
  `);
  const result = stmt.get() as { count: number };
  return result.count;
}

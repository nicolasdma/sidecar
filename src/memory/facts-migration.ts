/**
 * Facts Migration - Migrate from file-based learnings.md to SQLite
 *
 * Handles one-time migration of existing facts and provides
 * sync-back functionality for human-readable backup.
 */

import { existsSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { loadLearnings } from './knowledge.js';
import {
  getFacts,
  CATEGORY_TO_DOMAIN,
  weightToConfidence,
  type StoredFact,
} from './facts-store.js';
import { getDatabase, type FactDomain } from './store.js';
import type { Fact } from './fact-parser.js';

const logger = createLogger('facts-migration');

// ============= Migration Types =============

export interface MigrationResult {
  success: boolean;
  migratedCount: number;
  skippedCount: number;
  errors: string[];
  warnings: string[];
}

// ============= Migration State =============

/**
 * Checks if there are any facts in the learnings.md file to migrate.
 */
async function hasFactsToMigrate(): Promise<boolean> {
  const { facts } = await loadLearnings();
  return facts.length > 0;
}

// ============= Migration Functions =============

/**
 * Migrates facts from learnings.md to SQLite.
 *
 * Domain mapping:
 * - Health -> health
 * - Preferences -> preferences
 * - Work -> work
 * - Relationships -> relationships
 * - Schedule -> schedule
 * - Goals -> goals
 * - General -> general
 *
 * Weight to confidence mapping:
 * - weight >= 7 -> high
 * - weight >= 4 -> medium
 * - weight < 4 -> low
 */
export async function migrateFromLearningsMd(): Promise<MigrationResult> {
  const result: MigrationResult = {
    success: true,
    migratedCount: 0,
    skippedCount: 0,
    errors: [],
    warnings: [],
  };

  // Check if there are facts to migrate
  const hasFacts = await hasFactsToMigrate();
  if (!hasFacts) {
    logger.info('No facts to migrate in learnings.md');
    result.warnings.push('No facts found in learnings.md');
    return result;
  }

  // Note: We don't early-exit based on isMigrationComplete() anymore.
  // Migration is now idempotent - each fact is checked before insert.
  // This handles partial migrations from previous crashes.

  // Load existing facts from file
  const { facts, unparsed, warnings } = await loadLearnings();

  // Add parsing warnings
  for (const warning of warnings) {
    result.warnings.push(`Parse: ${warning}`);
  }

  // Add unparsed lines as warnings
  for (const line of unparsed) {
    result.warnings.push(`Unparsed: ${line}`);
  }

  logger.info(`Starting migration of ${facts.length} facts`);

  // Migrate each fact (idempotent - skips already migrated)
  for (const fact of facts) {
    try {
      const id = migrateSingleFact(fact);
      if (id) {
        result.migratedCount++;
      } else {
        result.skippedCount++; // Already existed
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to migrate "${fact.text.slice(0, 50)}": ${errorMsg}`);
      result.skippedCount++;
    }
  }

  if (result.errors.length > 0) {
    result.success = false;
    logger.error(`Migration completed with ${result.errors.length} errors`);
  } else {
    logger.info(`Migration complete: ${result.migratedCount} facts migrated`);
  }

  return result;
}

/**
 * Migrates a single fact from file format to SQLite.
 * Returns the fact ID if migrated, or null if already exists (idempotent).
 */
function migrateSingleFact(fact: Fact): string | null {
  const category = fact.category ?? 'General';
  const domain = CATEGORY_TO_DOMAIN[category] ?? 'general';
  const confidence = weightToConfidence(fact.weight);

  // Parse dates from the fact
  const createdAt = new Date(fact.learned);
  const confirmedAt = new Date(fact.confirmed);

  const db = getDatabase();

  // Check if fact already exists (idempotent migration)
  const existingStmt = db.prepare(
    'SELECT id FROM facts WHERE fact = ? AND source = ?'
  );
  const existing = existingStmt.get(fact.text, 'migrated') as { id: string } | undefined;

  if (existing) {
    logger.debug('Fact already migrated, skipping', { id: existing.id, text: fact.text.slice(0, 50) });
    return null;
  }

  // Use a direct insert to preserve dates
  const id = crypto.randomUUID();
  const stmt = db.prepare(`
    INSERT INTO facts (
      id, domain, fact, confidence, scope, source,
      created_at, last_confirmed_at, stale, archived
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `);

  stmt.run(
    id,
    domain,
    fact.text,
    confidence,
    'global',
    'migrated',
    createdAt.toISOString(),
    confirmedAt.toISOString()
  );

  logger.debug('Migrated fact', { id, domain, text: fact.text.slice(0, 50) });
  return id;
}

// ============= Sync Back Functions =============

/**
 * Domain to category mapping for sync back.
 */
const DOMAIN_TO_CATEGORY: Record<FactDomain, string> = {
  health: 'Health',
  preferences: 'Preferences',
  work: 'Work',
  relationships: 'Relationships',
  schedule: 'Schedule',
  goals: 'Goals',
  general: 'General',
  decisions: 'General',
  personal: 'General',
  projects: 'Work',
};

/**
 * Confidence to weight mapping for sync back.
 */
function confidenceToWeight(confidence: string): number {
  switch (confidence) {
    case 'high':
      return 8;
    case 'medium':
      return 5;
    case 'low':
      return 2;
    default:
      return 5;
  }
}

/**
 * Formats a date as YYYY-MM-DD.
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0] ?? date.toISOString().slice(0, 10);
}

/**
 * Syncs SQLite facts back to learnings.md for human readability.
 * This is a backup/export function, not the primary storage.
 */
export async function syncToLearningsMd(): Promise<void> {
  // Get all active facts
  const facts = getFacts({ includeStale: false, includeArchived: false });

  if (facts.length === 0) {
    logger.info('No facts to sync to learnings.md');
    return;
  }

  // Group by category (using domain -> category mapping)
  const byCategory = new Map<string, StoredFact[]>();

  for (const fact of facts) {
    const category = DOMAIN_TO_CATEGORY[fact.domain] ?? 'General';
    const existing = byCategory.get(category) ?? [];
    existing.push(fact);
    byCategory.set(category, existing);
  }

  // Generate file content
  const lines: string[] = ['# Learnings', ''];

  const categories = ['Health', 'Preferences', 'Work', 'Relationships', 'Schedule', 'Goals', 'General'];

  for (const category of categories) {
    lines.push(`## ${category}`);

    const categoryFacts = byCategory.get(category) ?? [];

    if (categoryFacts.length === 0) {
      lines.push(`<!-- Facts sobre ${category.toLowerCase()} -->`);
    } else {
      for (const fact of categoryFacts) {
        const weight = confidenceToWeight(fact.confidence);
        const learned = formatDate(fact.createdAt);
        const confirmed = formatDate(fact.lastConfirmedAt);
        lines.push(`- [weight:${weight}] ${fact.fact} | learned:${learned} | confirmed:${confirmed}`);
      }
    }

    lines.push('');
  }

  // Ensure directory exists
  const knowledgeDir = config.paths.knowledge;
  if (!existsSync(knowledgeDir)) {
    await mkdir(knowledgeDir, { recursive: true });
  }

  // Write to file
  await writeFile(config.paths.learningsMd, lines.join('\n'), 'utf-8');

  logger.info(`Synced ${facts.length} facts to learnings.md`);
}

// ============= Auto-Migration =============

/**
 * Counts migrated facts in SQLite.
 */
function getMigratedFactsCount(): number {
  const db = getDatabase();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM facts WHERE source = ?');
  const result = stmt.get('migrated') as { count: number };
  return result.count;
}

/**
 * Runs migration automatically on first access if needed.
 * Safe to call multiple times - migration is idempotent.
 *
 * Handles partial migrations: if learnings.md has more facts than
 * SQLite has migrated, runs migration to catch up.
 */
export async function ensureMigration(): Promise<void> {
  const { facts } = await loadLearnings();

  if (facts.length === 0) {
    return; // Nothing to migrate
  }

  const migratedCount = getMigratedFactsCount();

  // If all facts are already migrated, skip
  if (migratedCount >= facts.length) {
    return;
  }

  // Some facts need migration (first run or partial migration recovery)
  logger.info('Running migration from learnings.md', {
    inFile: facts.length,
    alreadyMigrated: migratedCount,
  });

  const result = await migrateFromLearningsMd();

  if (!result.success) {
    logger.error('Migration had errors', { errors: result.errors });
  } else if (result.migratedCount > 0) {
    logger.info('Migration complete', {
      migrated: result.migratedCount,
      skipped: result.skippedCount,
    });
  }
}

/**
 * Confidence Decay Service (Fase 2)
 *
 * Gradually ages facts based on `last_confirmed_at` timestamp.
 * Facts that haven't been confirmed in a while become less relevant.
 *
 * Decay is computed at runtime via getDecayStatus() - no columns needed.
 * Only the `stale` column is written (for 120+ days) to optimize queries.
 *
 * Decay Stages (computed from last_confirmed_at):
 * | Days since confirmed | Stage        | Behavior                       |
 * |---------------------|--------------|--------------------------------|
 * | 0-59                | fresh        | Always inject                  |
 * | 60-89               | aging        | Inject with slight threshold   |
 * | 90-119              | low_priority | Only if query highly relevant  |
 * | 120+                | stale        | Never inject (stale=1 in DB)   |
 *
 * Run: At startup + optionally daily
 */

import {
  getFactsForDecayCheckPaginated,
  getFactsForDecayCount,
  getDecayStatsFromDb,
  markFactAsStale,
  type FactRow,
} from './store.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('decay');

// Decay thresholds in days
const AGING_THRESHOLD_DAYS = 60;
const LOW_PRIORITY_THRESHOLD_DAYS = 90;
const STALE_THRESHOLD_DAYS = 120;

// Milliseconds per day
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Pagination config for large datasets
const DECAY_BATCH_SIZE = 100;

export interface DecayResult {
  /** Total facts checked */
  checked: number;
  /** Facts newly marked as stale (120+ days) */
  markedStale: number;
}

/**
 * Decay status computed at runtime from last_confirmed_at.
 * This is the plan-specified approach for determining fact injection behavior.
 */
export interface DecayStatus {
  /** Whether the fact should be injected into prompts */
  inject: boolean;
  /** Minimum relevance score required for injection (0.0-1.0) */
  relevanceThreshold: number;
  /** Human-readable decay stage */
  stage: 'fresh' | 'aging' | 'low_priority' | 'stale';
}

/**
 * Computes decay status at runtime based on days since confirmation.
 * Per plan: compute at query time, don't rely solely on stored columns.
 *
 * | Days since confirmed | inject | relevanceThreshold | stage        |
 * |---------------------|--------|-------------------|--------------|
 * | 0-59                | true   | 0.0               | fresh        |
 * | 60-89               | true   | 0.3               | aging        |
 * | 90-119              | true   | 0.7               | low_priority |
 * | 120+                | false  | 1.0               | stale        |
 */
export function getDecayStatus(lastConfirmedAt: string | Date): DecayStatus {
  const lastConfirmed = typeof lastConfirmedAt === 'string'
    ? new Date(lastConfirmedAt)
    : lastConfirmedAt;
  const now = new Date();
  const diffMs = now.getTime() - lastConfirmed.getTime();
  const days = Math.floor(diffMs / MS_PER_DAY);

  if (days >= STALE_THRESHOLD_DAYS) {
    return { inject: false, relevanceThreshold: 1.0, stage: 'stale' };
  }

  if (days >= LOW_PRIORITY_THRESHOLD_DAYS) {
    return { inject: true, relevanceThreshold: 0.7, stage: 'low_priority' };
  }

  if (days >= AGING_THRESHOLD_DAYS) {
    return { inject: true, relevanceThreshold: 0.3, stage: 'aging' };
  }

  return { inject: true, relevanceThreshold: 0.0, stage: 'fresh' };
}

/**
 * Calculates days since a timestamp.
 * Useful for external callers who need the raw days value.
 */
export function getDaysSince(timestamp: string | Date): number {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  return Math.floor(diffMs / MS_PER_DAY);
}

/**
 * Calculates days since a fact was last confirmed.
 */
export function getDaysSinceConfirmed(fact: FactRow): number {
  const lastConfirmed = new Date(fact.last_confirmed_at);
  const now = new Date();
  const diffMs = now.getTime() - lastConfirmed.getTime();
  return Math.floor(diffMs / MS_PER_DAY);
}

/**
 * Helper to yield event loop between batches.
 * Prevents blocking on large fact sets.
 */
function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Checks if a fact should be marked as stale.
 * Only facts >= 120 days need the stale column set.
 * Other decay stages are computed at query time.
 */
function shouldMarkStale(fact: FactRow): boolean {
  // Already stale? Skip.
  if (fact.stale === 1) return false;

  const days = getDaysSinceConfirmed(fact);
  return days >= STALE_THRESHOLD_DAYS;
}

/**
 * Processes a batch of facts, marking stale ones.
 */
function processBatch(facts: FactRow[], result: DecayResult): void {
  for (const fact of facts) {
    if (shouldMarkStale(fact)) {
      markFactAsStale(fact.id);
      result.markedStale++;
      logger.info('Fact marked stale', {
        id: fact.id,
        days: getDaysSinceConfirmed(fact),
        fact: fact.fact.slice(0, 50),
      });
    }
  }
}

/**
 * Runs the decay check on all active facts with pagination.
 * Uses setImmediate yields between batches to avoid blocking the event loop.
 *
 * @returns Summary of decay actions taken
 */
export async function runDecayCheck(): Promise<DecayResult> {
  const result: DecayResult = {
    checked: 0,
    markedStale: 0,
  };

  try {
    // Get total count first
    const totalCount = getFactsForDecayCount();
    result.checked = totalCount;

    if (totalCount === 0) {
      logger.debug('No facts to check for decay');
      return result;
    }

    // Process in batches with event loop yields
    let offset = 0;
    while (offset < totalCount) {
      const batch = getFactsForDecayCheckPaginated(DECAY_BATCH_SIZE, offset);

      if (batch.length === 0) break;

      processBatch(batch, result);

      offset += batch.length;

      // Yield to event loop between batches (if more batches remain)
      if (offset < totalCount) {
        await yieldEventLoop();
      }
    }

    if (result.markedStale > 0) {
      logger.info('Decay check completed', result);
    } else {
      logger.debug('Decay check: no changes needed', { checked: result.checked });
    }

    return result;
  } catch (error) {
    logger.error('Decay check failed', { error });
    throw error;
  }
}

/**
 * Gets decay statistics for reporting.
 * Uses SQL aggregation - efficient for large datasets.
 */
export function getDecayStats(): {
  aging: number;
  lowPriority: number;
  stale: number;
} {
  return getDecayStatsFromDb();
}

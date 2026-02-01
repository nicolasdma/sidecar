/**
 * Confidence Decay Service (Fase 2)
 *
 * Gradually ages facts based on `last_confirmed_at` timestamp.
 * Facts that haven't been confirmed in a while become less relevant.
 *
 * Decay Rules:
 * | Days since confirmed | Action                                    |
 * |---------------------|-------------------------------------------|
 * | 60+                 | aging=1 (still injected, flagged for UI)  |
 * | 90+                 | priority='low' (only inject if relevant)  |
 * | 120+                | stale=1 (never inject automatically)      |
 *
 * Run: At startup + optionally daily
 */

import {
  getFactsForDecayCheck,
  updateFactAging,
  updateFactPriority,
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

export interface DecayResult {
  checked: number;
  markedAging: number;
  markedLowPriority: number;
  markedStale: number;
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
 * Determines what decay action should be applied to a fact.
 */
function determineDecayAction(
  fact: FactRow,
  daysSinceConfirmed: number
): 'stale' | 'low_priority' | 'aging' | null {
  // Already at the target state? Skip.
  if (daysSinceConfirmed >= STALE_THRESHOLD_DAYS) {
    // Should be stale
    if (fact.stale === 1) return null;
    return 'stale';
  }

  if (daysSinceConfirmed >= LOW_PRIORITY_THRESHOLD_DAYS) {
    // Should be low priority
    if (fact.priority === 'low') return null;
    return 'low_priority';
  }

  if (daysSinceConfirmed >= AGING_THRESHOLD_DAYS) {
    // Should be aging
    if (fact.aging === 1) return null;
    return 'aging';
  }

  return null;
}

/**
 * Runs the decay check on all active facts.
 * Updates aging, priority, and stale status based on age.
 *
 * @returns Summary of decay actions taken
 */
export async function runDecayCheck(): Promise<DecayResult> {
  const result: DecayResult = {
    checked: 0,
    markedAging: 0,
    markedLowPriority: 0,
    markedStale: 0,
  };

  try {
    const facts = getFactsForDecayCheck();
    result.checked = facts.length;

    if (facts.length === 0) {
      logger.debug('No facts to check for decay');
      return result;
    }

    for (const fact of facts) {
      const daysSinceConfirmed = getDaysSinceConfirmed(fact);
      const action = determineDecayAction(fact, daysSinceConfirmed);

      if (action === null) continue;

      switch (action) {
        case 'stale':
          markFactAsStale(fact.id);
          result.markedStale++;
          logger.info('Fact marked stale', {
            id: fact.id,
            days: daysSinceConfirmed,
            fact: fact.fact.slice(0, 50),
          });
          break;

        case 'low_priority':
          updateFactPriority(fact.id, 'low');
          result.markedLowPriority++;
          logger.debug('Fact marked low priority', {
            id: fact.id,
            days: daysSinceConfirmed,
          });
          break;

        case 'aging':
          updateFactAging(fact.id, 1);
          result.markedAging++;
          logger.debug('Fact marked aging', {
            id: fact.id,
            days: daysSinceConfirmed,
          });
          break;
      }
    }

    if (result.markedAging > 0 || result.markedLowPriority > 0 || result.markedStale > 0) {
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
 * Resets decay status when a fact is confirmed.
 * Called when user re-confirms a fact through /remember or natural conversation.
 */
export function resetFactDecay(factId: string): void {
  try {
    updateFactAging(factId, 0);
    updateFactPriority(factId, 'normal');
    logger.debug('Reset decay for fact', { factId });
  } catch (error) {
    logger.warn('Failed to reset fact decay', { factId, error });
  }
}

/**
 * Gets decay statistics for reporting.
 */
export function getDecayStats(): {
  aging: number;
  lowPriority: number;
  stale: number;
} {
  const facts = getFactsForDecayCheck();
  let aging = 0;
  let lowPriority = 0;

  for (const fact of facts) {
    if (fact.aging === 1) aging++;
    if (fact.priority === 'low') lowPriority++;
  }

  // For stale count, we need to query separately since getFactsForDecayCheck excludes stale
  // We'll just return 0 here and let the caller query if needed
  return { aging, lowPriority, stale: 0 };
}

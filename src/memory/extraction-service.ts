/**
 * Fact Extraction Service (Fase 2)
 *
 * Extracts facts from user messages using local Ollama model (Qwen2.5:3b).
 * Runs asynchronously in the background to avoid impacting latency.
 *
 * Components:
 * - queueForExtraction(): Add message to pending queue
 * - startExtractionWorker(): Background worker that processes queue
 * - extractFactsFromText(): LLM call for fact extraction
 *
 * Queue Processing:
 * - Runs every 5 seconds if items pending
 * - Max 3 attempts per message
 * - Backoff: immediate, 5s, 30s
 * - After 3 failures: status='failed'
 */

import {
  queueMessageForExtraction,
  getPendingExtractions,
  markExtractionProcessing,
  markExtractionCompleted,
  markExtractionFailed,
  getPendingExtractionCount,
  cleanupOldExtractions,
  recoverStalledExtractions,
  enforceQueueSizeLimit,
  retryFailedExtractions,
  purgeExtractionQueue,
  getSystemStateJson,
  setSystemStateJson,
  type PendingExtractionRow,
} from './store.js';
import { saveFact, type NewFact } from './facts-store.js';
import { generateWithOllama, checkOllamaAvailability, cleanJsonResponse } from '../llm/ollama.js';
import { createLogger } from '../utils/logger.js';
import {
  parseExtractedFacts,
  safeJsonParse,
  type ExtractedFact,
} from './schemas.js';
import {
  recordFactExtracted,
  recordExtractionFailure,
  resetExtractionFailures,
} from '../utils/metrics.js';

const logger = createLogger('extraction');

// Worker configuration
const WORKER_INTERVAL_MS = 5_000; // 5 seconds
const BATCH_SIZE = 5; // Process up to 5 items per tick
const BACKOFF_DELAYS = [0, 5_000, 30_000]; // Retry delays in ms
const MAX_QUEUE_SIZE = 1000; // Maximum pending items before dropping oldest
const OLLAMA_RECHECK_INTERVAL_MS = 60_000; // Re-check Ollama every 60 seconds

// Worker state
let workerTimer: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;
let ollamaAvailable = false;
let lastOllamaCheck = 0;

// ============================================================================
// Circuit Breaker (Fase 3.6 - Track B hardening)
// Prevents excessive retries when Ollama is consistently failing.
// ============================================================================

interface ExtractionCircuitState {
  consecutiveFailures: number;
  circuitOpenUntil: number | null;
  lastError: string | null;
}

const CIRCUIT_CONFIG = {
  failureThreshold: 5,    // Open circuit after 5 consecutive failures
  resetTimeMs: 60_000,    // Keep circuit open for 1 minute
};

let circuitState: ExtractionCircuitState = {
  consecutiveFailures: 0,
  circuitOpenUntil: null,
  lastError: null,
};

/**
 * Checks if the circuit breaker is open (blocking requests).
 * If the reset time has passed, closes the circuit and allows retry.
 */
function isCircuitOpen(): boolean {
  if (!circuitState.circuitOpenUntil) return false;

  if (Date.now() >= circuitState.circuitOpenUntil) {
    // Reset circuit - allow retry
    circuitState.circuitOpenUntil = null;
    circuitState.consecutiveFailures = 0;
    circuitState.lastError = null;
    persistCircuitState();
    logger.info('Extraction circuit breaker reset, allowing retries');
    return false;
  }

  return true;
}

/**
 * Records a successful extraction, resetting the circuit breaker.
 */
function recordCircuitSuccess(): void {
  if (circuitState.consecutiveFailures > 0) {
    logger.debug('Extraction circuit success, resetting failure count');
  }
  circuitState.consecutiveFailures = 0;
  circuitState.lastError = null;
  // Only persist if circuit was previously open
  if (circuitState.circuitOpenUntil !== null) {
    circuitState.circuitOpenUntil = null;
    persistCircuitState();
  }
}

/**
 * Records an extraction failure. Opens circuit if threshold exceeded.
 */
function recordCircuitFailure(error: string): void {
  circuitState.consecutiveFailures++;
  circuitState.lastError = error;

  if (circuitState.consecutiveFailures >= CIRCUIT_CONFIG.failureThreshold) {
    circuitState.circuitOpenUntil = Date.now() + CIRCUIT_CONFIG.resetTimeMs;
    logger.warn('Extraction circuit breaker OPENED', {
      failures: circuitState.consecutiveFailures,
      resetAt: new Date(circuitState.circuitOpenUntil).toISOString(),
      lastError: error,
    });
    persistCircuitState();
  }
}

/**
 * Persists circuit breaker state to SQLite (survives restarts).
 */
function persistCircuitState(): void {
  try {
    setSystemStateJson('extraction_circuit_breaker', {
      consecutiveFailures: circuitState.consecutiveFailures,
      circuitOpenUntil: circuitState.circuitOpenUntil,
      lastError: circuitState.lastError,
    });
  } catch (error) {
    logger.warn('Failed to persist extraction circuit state', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
  }
}

/**
 * Restores circuit breaker state from SQLite on startup.
 */
function restoreCircuitState(): void {
  try {
    const persisted = getSystemStateJson<{
      consecutiveFailures: number;
      circuitOpenUntil: number | null;
      lastError: string | null;
    }>('extraction_circuit_breaker');

    if (persisted) {
      // Only restore if circuit is still open (not expired)
      if (persisted.circuitOpenUntil && persisted.circuitOpenUntil > Date.now()) {
        circuitState = {
          consecutiveFailures: persisted.consecutiveFailures,
          circuitOpenUntil: persisted.circuitOpenUntil,
          lastError: persisted.lastError,
        };
        logger.info('Restored extraction circuit breaker state', {
          failures: persisted.consecutiveFailures,
          openUntil: new Date(persisted.circuitOpenUntil).toISOString(),
        });
      } else if (persisted.consecutiveFailures > 0) {
        // Circuit expired but remember failure history
        circuitState.consecutiveFailures = persisted.consecutiveFailures;
        circuitState.lastError = persisted.lastError;
        logger.debug('Restored extraction failure count (circuit expired)', {
          failures: persisted.consecutiveFailures,
        });
      }
    }
  } catch (error) {
    logger.warn('Failed to restore extraction circuit state', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
  }
}

// Extraction prompt (English for token efficiency)
const EXTRACTION_PROMPT = `Extract facts about the user from this message.
Output ONLY valid JSON array, no explanations.

Format:
[{"fact": "text", "domain": "work|preferences|decisions|personal|projects|health|relationships|schedule|goals|general", "confidence": "high|medium|low"}]

If no facts found, output: []

Look for:
- Identity: "I am...", "I work at..."
- Preferences: "I like...", "I prefer..."
- Decisions: "I decided...", "from now on..."
- Personal info: family, health, routines
- Work: job, projects, colleagues
- Goals: plans, objectives, intentions

Message:
`;

/**
 * Converts a Zod-validated ExtractedFact to NewFact for storage.
 */
function toNewFact(extracted: ExtractedFact): NewFact {
  return {
    domain: extracted.domain,
    fact: extracted.fact,
    confidence: extracted.confidence,
    source: 'inferred',
  };
}

/**
 * Extracts facts from text using Ollama.
 * Returns Zod-validated facts ready for storage.
 */
async function extractFactsFromText(text: string): Promise<NewFact[]> {
  const prompt = EXTRACTION_PROMPT + text;

  // Generate response from Ollama
  const rawResponse = await generateWithOllama(prompt);
  const cleanedResponse = cleanJsonResponse(rawResponse);

  // Parse JSON
  const parsed = safeJsonParse(cleanedResponse);
  if (parsed === null) {
    logger.debug('Failed to parse JSON from extraction response', {
      response: cleanedResponse.slice(0, 200),
    });
    return [];
  }

  // Validate with Zod schema (handles partial success gracefully)
  const validatedFacts = parseExtractedFacts(parsed, logger);

  if (validatedFacts.length === 0) {
    logger.debug('No valid facts extracted', { input: text.slice(0, 100) });
    return [];
  }

  logger.debug('Extracted facts', {
    input: text.slice(0, 100),
    extracted: validatedFacts.length,
  });

  return validatedFacts.map(toNewFact);
}

/**
 * Processes a single extraction item.
 * Returns true if successful, false if should retry.
 */
async function processExtractionItem(item: PendingExtractionRow): Promise<boolean> {
  try {
    markExtractionProcessing(item.id);

    const facts = await extractFactsFromText(item.content);

    if (facts.length > 0) {
      for (const fact of facts) {
        saveFact(fact);
        recordFactExtracted(); // Track auto-extracted facts
      }
      logger.info('Facts extracted and saved', {
        messageId: item.message_id,
        count: facts.length,
      });
    }

    markExtractionCompleted(item.id);
    resetExtractionFailures(); // Reset metrics counter on success
    recordCircuitSuccess();    // Reset circuit breaker on success
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    markExtractionFailed(item.id, message);
    recordExtractionFailure();      // Track metrics failures
    recordCircuitFailure(message);  // Track circuit breaker failures

    logger.warn('Extraction failed', {
      id: item.id,
      attempt: item.attempts + 1,
      error: message,
    });
    return false;
  }
}

/**
 * Checks Ollama availability with caching to avoid excessive checks.
 */
async function checkOllamaWithCache(): Promise<boolean> {
  const now = Date.now();
  if (now - lastOllamaCheck < OLLAMA_RECHECK_INTERVAL_MS && lastOllamaCheck > 0) {
    return ollamaAvailable;
  }

  const availability = await checkOllamaAvailability();
  ollamaAvailable = availability.available;
  lastOllamaCheck = now;

  if (!ollamaAvailable) {
    logger.debug('Ollama not available, will retry later', { error: availability.error });
  } else if (lastOllamaCheck > 0) {
    // Only log recovery if we've checked before
    logger.info('Ollama became available');
  }

  return ollamaAvailable;
}

/**
 * Processes the extraction queue.
 * Called by the worker timer.
 */
async function processExtractionQueue(): Promise<void> {
  // Prevent concurrent processing
  if (isProcessing) {
    return;
  }

  // Check circuit breaker first
  if (isCircuitOpen()) {
    logger.debug('Extraction circuit open, skipping tick');
    return;
  }

  isProcessing = true;

  try {
    // Periodically check Ollama availability (may have become available after startup)
    const isOllamaUp = await checkOllamaWithCache();
    if (!isOllamaUp) {
      return;
    }

    // Enforce queue size limit to prevent unbounded growth
    enforceQueueSizeLimit(MAX_QUEUE_SIZE);

    const items = getPendingExtractions(BATCH_SIZE);

    if (items.length === 0) {
      return;
    }

    let processed = 0;
    let skippedBackoff = 0;

    for (const item of items) {
      // Check if we should wait based on backoff
      if (item.attempts > 0 && item.last_attempt_at) {
        const lastAttempt = new Date(item.last_attempt_at).getTime();
        const backoffDelay = BACKOFF_DELAYS[Math.min(item.attempts, BACKOFF_DELAYS.length - 1)] || 0;
        const timeSinceAttempt = Date.now() - lastAttempt;
        const shouldWait = timeSinceAttempt < backoffDelay;

        if (shouldWait) {
          const retryIn = Math.ceil((backoffDelay - timeSinceAttempt) / 1000);
          logger.debug('Extraction item in backoff', {
            id: item.id,
            attempt: item.attempts,
            retryInSeconds: retryIn,
          });
          skippedBackoff++;
          continue;
        }
      }

      await processExtractionItem(item);
      processed++;
    }

    // Log summary
    if (processed > 0 || skippedBackoff > 0) {
      logger.debug('Extraction queue tick', {
        total: items.length,
        processed,
        skippedBackoff,
      });
    }
  } catch (error) {
    logger.error('Queue processing error', { error });
  } finally {
    isProcessing = false;
  }
}

/**
 * Queues a message for fact extraction.
 * Fire-and-forget: errors are logged but don't propagate.
 *
 * @param messageId - Database ID of the message
 * @param content - Text content to extract facts from
 * @param role - Message role (usually 'user')
 */
export async function queueForExtraction(
  messageId: number,
  content: string,
  role: string
): Promise<void> {
  try {
    // Skip very short messages
    if (!content || content.trim().length < 10) {
      return;
    }

    // Skip messages that are unlikely to contain facts
    if (isUnlikelyToContainFacts(content)) {
      return;
    }

    queueMessageForExtraction(messageId, content, role);
    logger.debug('Queued for extraction', { messageId });
  } catch (error) {
    logger.warn('Failed to queue extraction', { messageId, error });
  }
}

/**
 * Heuristic check for messages unlikely to contain facts.
 */
function isUnlikelyToContainFacts(content: string): boolean {
  const lower = content.toLowerCase().trim();

  // Very short or single word
  if (lower.split(/\s+/).length <= 2) {
    return true;
  }

  // Pure questions without personal info
  const questionPatterns = [
    /^(qué|que|cómo|como|cuándo|cuando|dónde|donde|por qué|porque|quién|quien)\s/,
    /^(what|how|when|where|why|who)\s/,
    /\?$/,
  ];

  if (questionPatterns.some(p => p.test(lower)) && !containsPersonalIndicators(lower)) {
    return true;
  }

  // Greetings and short responses
  const skipPatterns = [
    /^(hola|hey|buenas|chau|gracias|ok|dale|bien|genial|perfecto|sí|si|no|claro)$/,
    /^(hello|hi|thanks|ok|great|perfect|yes|no|sure)$/,
  ];

  if (skipPatterns.some(p => p.test(lower))) {
    return true;
  }

  return false;
}

/**
 * Checks if content has personal indicators worth extracting.
 */
function containsPersonalIndicators(content: string): boolean {
  const indicators = [
    /\b(yo|me|mi|mis|mío)\b/,
    /\b(i am|i'm|my|mine|i have|i've|i like|i prefer|i work|i decided)\b/,
    /\b(soy|tengo|trabajo|prefiero|decidí|vivo|estoy)\b/,
  ];
  return indicators.some(p => p.test(content));
}

/**
 * Starts the background extraction worker.
 * Safe to call multiple times - will only start one worker.
 *
 * The worker starts regardless of Ollama availability and will
 * periodically re-check, allowing extraction to work after Ollama
 * becomes available.
 */
export async function startExtractionWorker(): Promise<void> {
  if (workerTimer) {
    logger.debug('Extraction worker already running');
    return;
  }

  // Restore circuit breaker state from previous session
  restoreCircuitState();

  // Recover stalled extractions from previous crash
  const recovered = recoverStalledExtractions();
  if (recovered > 0) {
    logger.info('Recovered stalled extractions from previous crash', { count: recovered });
  }

  // Cleanup old extractions on startup
  cleanupOldExtractions();

  // Warn about large backlog (Track B.3 - error visibility)
  const pendingCount = getPendingExtractionCount();
  if (pendingCount > 100) {
    console.log(`\u26a0\ufe0f  Large extraction backlog: ${pendingCount} items pending`);
    logger.warn('Large extraction backlog detected at startup', { pending: pendingCount });
  }

  // Initial Ollama availability check (non-blocking - worker will retry)
  const availability = await checkOllamaAvailability();
  ollamaAvailable = availability.available;
  lastOllamaCheck = Date.now();

  if (availability.available) {
    logger.info('Starting extraction worker', { model: availability.model });
  } else {
    // INFO level since this is expected during startup - worker will retry automatically
    logger.info('Starting extraction worker (Ollama not yet available, will retry)');
  }

  // Start the worker - it will periodically re-check Ollama
  workerTimer = setInterval(() => {
    processExtractionQueue().catch(error => {
      logger.error('Worker tick failed', { error });
    });
  }, WORKER_INTERVAL_MS);

  // Also run immediately if there are pending items and Ollama is available
  if (pendingCount > 0 && ollamaAvailable) {
    logger.info('Processing existing queue', { pending: pendingCount });
    processExtractionQueue().catch(error => {
      logger.error('Initial queue processing failed', { error });
    });
  }
}

/**
 * Stops the extraction worker.
 * Called during shutdown.
 */
export function stopExtractionWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    logger.info('Extraction worker stopped');
  }
}

/**
 * Gets extraction service status including circuit breaker state.
 */
export function getExtractionStatus(): {
  running: boolean;
  pending: number;
  ollamaAvailable: boolean;
  circuitBreaker: {
    isOpen: boolean;
    consecutiveFailures: number;
    openUntil: string | null;
    lastError: string | null;
  };
} {
  return {
    running: workerTimer !== null,
    pending: getPendingExtractionCount(),
    ollamaAvailable,
    circuitBreaker: {
      isOpen: isCircuitOpen(),
      consecutiveFailures: circuitState.consecutiveFailures,
      openUntil: circuitState.circuitOpenUntil
        ? new Date(circuitState.circuitOpenUntil).toISOString()
        : null,
      lastError: circuitState.lastError,
    },
  };
}

/**
 * Manually retries failed extractions.
 * Useful after fixing extraction logic or Ollama issues.
 *
 * @param maxRetries - Maximum attempts before leaving as failed (default: 5)
 * @returns Number of items reset for retry
 */
export function retryFailed(maxRetries: number = 5): number {
  return retryFailedExtractions(maxRetries);
}

/**
 * Purges the entire extraction queue.
 * Use with caution - removes all pending, processing, and failed items.
 *
 * @returns Number of items purged
 */
export function purgeQueue(): number {
  return purgeExtractionQueue();
}

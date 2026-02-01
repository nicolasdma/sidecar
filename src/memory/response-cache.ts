/**
 * Fase 3: Response Cache
 *
 * Caches LLM responses to avoid redundant API calls for similar queries.
 * Uses embeddings for semantic similarity matching.
 *
 * Cache invalidation:
 * - Query similarity (must be above threshold)
 * - Fact hash (same facts would be retrieved)
 * - System version (SOUL.md + model changes)
 * - TTL expiration
 */

import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { embedText, isModelReady } from './embeddings-model.js';
import { isEmbeddingsReady } from './embeddings-state.js';
import { cosineSimilarity, serializeEmbedding, deserializeEmbedding } from './vector-math.js';
import { getEmbeddingsConfig } from '../config/embeddings-config.js';
import {
  saveResponseCache,
  getResponseCacheCandidates,
  cleanupExpiredCache,
} from './store.js';

const logger = createLogger('response-cache');

/**
 * TTL values for different query types.
 */
export const CACHE_TTL = {
  factual: 24 * 60 * 60,    // 24h for fact-based queries
  tool: 60 * 60,             // 1h for tool results
  greeting: 5 * 60,          // 5min for greetings (to vary)
} as const;

// Cache SOUL hash at module load
let soulHash: string | null = null;

/**
 * Computes a hash of SOUL.md content.
 * Cached for process lifetime.
 */
function computeSoulHash(): string {
  if (soulHash !== null) {
    return soulHash;
  }

  const soulPath = join(process.cwd(), 'SOUL.md');

  if (existsSync(soulPath)) {
    try {
      const content = readFileSync(soulPath, 'utf8');
      soulHash = createHash('md5').update(content).digest('hex').slice(0, 8);
      logger.debug('Computed SOUL hash', { hash: soulHash });
    } catch (error) {
      logger.warn('Failed to read SOUL.md for hash', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      soulHash = 'default';
    }
  } else {
    soulHash = 'default';
  }

  return soulHash;
}

/**
 * Generates system version hash for cache invalidation.
 * Includes: LLM model, SOUL.md content hash
 */
function getSystemVersion(): string {
  const components = [
    process.env.LLM_MODEL || 'kimi-k2.5',
    computeSoulHash(),
  ];
  return createHash('md5').update(components.join('|')).digest('hex').slice(0, 16);
}

/**
 * Hashes a string using MD5.
 */
function hashString(s: string): string {
  return createHash('md5').update(s).digest('hex');
}

/**
 * Hashes a sorted array of strings.
 */
function hashSortedArray(arr: string[]): string {
  return hashString([...arr].sort().join(','));
}

/**
 * Normalizes a query for consistent hashing.
 * Lowercases, removes punctuation, sorts words.
 */
function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .sort()
    .join(' ');
}

/**
 * Checks the cache for a similar query.
 *
 * Four-part validation:
 * 1. Query similarity > threshold (embeddings)
 * 2. Same facts would be retrieved (fact_ids_hash)
 * 3. Same system version (prompt/model)
 * 4. Not expired (TTL)
 *
 * @param query - User query
 * @param retrievedFactIds - IDs of facts that would be used
 * @returns Cached response or null if cache miss
 */
export async function checkCache(
  query: string,
  retrievedFactIds: string[]
): Promise<string | null> {
  if (!isEmbeddingsReady() || !isModelReady()) {
    return null;
  }

  try {
    const config = getEmbeddingsConfig();
    const queryEmbed = await embedText(query);
    const factIdsHash = hashSortedArray(retrievedFactIds);
    const systemVersion = getSystemVersion();

    // Find candidates with matching fact hash AND system version
    const candidates = getResponseCacheCandidates(factIdsHash, systemVersion);

    // Check query similarity
    for (const candidate of candidates) {
      const candidateEmbed = deserializeEmbedding(candidate.query_embedding);
      const similarity = cosineSimilarity(queryEmbed, candidateEmbed);

      if (similarity > config.cacheSimilarityThreshold) {
        logger.debug('Cache hit', {
          similarity: similarity.toFixed(3),
          query: query.slice(0, 50),
        });
        return candidate.response;
      }

      // Log near-misses for threshold tuning
      if (similarity > 0.80) {
        logger.debug('Cache near-miss', {
          similarity: similarity.toFixed(3),
          threshold: config.cacheSimilarityThreshold,
          query: query.slice(0, 50),
        });
      }
    }

    return null;
  } catch (error) {
    logger.warn('Cache lookup failed', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return null;
  }
}

/**
 * Saves a response to the cache.
 *
 * @param query - User query
 * @param retrievedFactIds - IDs of facts used
 * @param response - LLM response to cache
 * @param ttlSeconds - Time-to-live in seconds
 */
export async function saveToCache(
  query: string,
  retrievedFactIds: string[],
  response: string,
  ttlSeconds: number = CACHE_TTL.factual
): Promise<void> {
  if (!isEmbeddingsReady() || !isModelReady()) {
    return;
  }

  try {
    const queryEmbed = await embedText(query);
    const queryHash = hashString(normalizeQuery(query));
    const factIdsHash = hashSortedArray(retrievedFactIds);
    const systemVersion = getSystemVersion();

    saveResponseCache({
      queryHash,
      queryEmbedding: serializeEmbedding(queryEmbed),
      factIdsHash,
      systemVersion,
      response,
      ttlSeconds,
    });

    logger.debug('Saved response to cache', { queryHash: queryHash.slice(0, 8) });
  } catch (error) {
    logger.warn('Failed to save to cache', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
  }
}

/**
 * Classifies a query to determine appropriate cache TTL.
 *
 * @param query - User query
 * @returns TTL in seconds
 */
export function classifyQueryTTL(query: string): number {
  const greetings = /^(hi|hello|hey|good\s+(morning|afternoon|evening)|hola|buenos?\s+(días?|tardes?|noches?))/i;
  if (greetings.test(query.trim())) {
    return CACHE_TTL.greeting;
  }

  // Could add more heuristics here (tool-related queries, etc.)
  return CACHE_TTL.factual;
}

/**
 * Cleans up expired cache entries.
 * Should be called periodically (e.g., daily).
 */
export function cleanupCache(): number {
  return cleanupExpiredCache();
}

/**
 * Resets the SOUL hash cache.
 * Useful for testing or after SOUL.md changes.
 */
export function resetSoulHash(): void {
  soulHash = null;
}

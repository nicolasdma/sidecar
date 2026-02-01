/**
 * Fase 3: Vector Search
 *
 * Hybrid search combining vector similarity and keyword matching.
 * Falls back gracefully to keyword-only search if embeddings unavailable.
 */

import { createLogger } from '../utils/logger.js';
import { embedText, isModelReady } from './embeddings-model.js';
import { isEmbeddingsReady, recordEmbeddingSuccess, recordEmbeddingFailure } from './embeddings-state.js';
import { serializeEmbedding } from './vector-math.js';
import { searchVectors } from './embeddings-loader.js';
import { getDatabase } from './store.js';
import { getFactById, filterFactsByKeywords, type StoredFact } from './facts-store.js';
import { extractSignificantWords } from './stopwords.js';

const logger = createLogger('vector-search');

// Search configuration
const TOP_K = 5;
const MIN_SIMILARITY = 0.4;

// Weights for hybrid scoring
const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;

/**
 * A fact with associated relevance scores.
 */
export interface ScoredFact {
  fact: StoredFact;
  vectorScore: number;   // 0-1, from cosine similarity
  keywordScore: number;  // 0-1, from keyword match ratio
  combinedScore: number; // Weighted combination
}

/**
 * Searches for facts similar to query using vector similarity.
 * Returns top-K facts with similarity above threshold.
 *
 * @param query - Search query
 * @param limit - Maximum results to return
 * @returns Array of scored facts
 */
export async function vectorSearchFacts(
  query: string,
  limit: number = TOP_K
): Promise<ScoredFact[]> {
  if (!isEmbeddingsReady() || !isModelReady()) {
    return [];
  }

  try {
    const db = getDatabase();
    const queryEmbed = await embedText(query);
    const queryBuffer = serializeEmbedding(queryEmbed);

    // Search in vector index
    const results = searchVectors(db, queryBuffer, limit * 2);

    // Convert distance to similarity and filter
    const filtered = results
      .map(r => ({ factId: r.fact_id, similarity: 1 - r.distance }))
      .filter(r => r.similarity >= MIN_SIMILARITY)
      .slice(0, limit);

    if (filtered.length === 0) {
      return [];
    }

    // Fetch full fact objects
    const scoredFacts: ScoredFact[] = [];
    for (const result of filtered) {
      const fact = getFactById(result.factId);
      if (fact) {
        scoredFacts.push({
          fact,
          vectorScore: result.similarity,
          keywordScore: 0, // Will be filled by hybrid search
          combinedScore: result.similarity,
        });
      }
    }

    return scoredFacts;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('Vector search failed', { error: message });
    recordEmbeddingFailure();
    return [];
  }
}

/**
 * Searches for facts using keyword matching with scoring.
 *
 * @param query - Search query
 * @param limit - Maximum results to return
 * @returns Array of scored facts
 */
export function keywordSearchFacts(query: string, limit: number = 10): ScoredFact[] {
  const keywords = extractSignificantWords(query);
  if (keywords.size === 0) return [];

  const facts = filterFactsByKeywords(query, limit * 2);

  return facts.map(fact => {
    const factWords = extractSignificantWords(fact.fact);
    let matchCount = 0;

    for (const kw of keywords) {
      if (factWords.has(kw)) {
        matchCount++;
      }
    }

    const keywordScore = matchCount / keywords.size;

    return {
      fact,
      vectorScore: 0,
      keywordScore,
      combinedScore: keywordScore,
    };
  });
}

/**
 * Performs hybrid search combining vector and keyword scores.
 * Falls back to keyword-only if vector search fails.
 *
 * @param query - Search query
 * @param limit - Maximum results to return
 * @returns Array of facts sorted by combined score
 */
export async function hybridSearchFacts(
  query: string,
  limit: number = 10
): Promise<StoredFact[]> {
  // Run both searches in parallel
  const [vectorResults, keywordResults] = await Promise.all([
    vectorSearchFacts(query, limit).catch((error) => {
      logger.warn('Vector search failed in hybrid', { error: error instanceof Error ? error.message : 'Unknown' });
      recordEmbeddingFailure();
      return [] as ScoredFact[];
    }),
    Promise.resolve(keywordSearchFacts(query, limit)),
  ]);

  // Record success if vector search worked
  if (vectorResults.length > 0) {
    recordEmbeddingSuccess();
  }

  // Create map of all facts with their scores
  const scoreMap = new Map<string, ScoredFact>();

  // Add vector results
  for (const result of vectorResults) {
    scoreMap.set(result.fact.id, result);
  }

  // Merge keyword results
  for (const result of keywordResults) {
    const existing = scoreMap.get(result.fact.id);
    if (existing) {
      // Combine scores
      existing.keywordScore = result.keywordScore;
      existing.combinedScore =
        (VECTOR_WEIGHT * existing.vectorScore) +
        (KEYWORD_WEIGHT * result.keywordScore);
    } else {
      // Keyword-only result
      result.combinedScore = KEYWORD_WEIGHT * result.keywordScore;
      scoreMap.set(result.fact.id, result);
    }
  }

  // Sort by combined score and return top results
  const sorted = Array.from(scoreMap.values())
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);

  logger.debug('Hybrid search results', {
    vectorCount: vectorResults.length,
    keywordCount: keywordResults.length,
    mergedCount: sorted.length,
    topScore: sorted[0]?.combinedScore ?? 0,
  });

  return sorted.map(s => s.fact);
}

/**
 * Retrieves relevant facts for a query.
 * Uses hybrid search if embeddings available, otherwise keyword only.
 *
 * @param query - Search query
 * @param limit - Maximum results to return
 * @returns Array of relevant facts
 */
export async function retrieveRelevantFacts(
  query: string,
  limit: number = 10
): Promise<StoredFact[]> {
  if (isEmbeddingsReady() && isModelReady()) {
    try {
      return await hybridSearchFacts(query, limit);
    } catch (error) {
      logger.warn('Hybrid search failed, falling back to keyword', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      recordEmbeddingFailure();
    }
  }

  // Fallback: keyword matching (Fase 2)
  return filterFactsByKeywords(query, limit);
}

/**
 * Returns search configuration for monitoring.
 */
export function getSearchConfig(): {
  vectorWeight: number;
  keywordWeight: number;
  minSimilarity: number;
  topK: number;
} {
  return {
    vectorWeight: VECTOR_WEIGHT,
    keywordWeight: KEYWORD_WEIGHT,
    minSimilarity: MIN_SIMILARITY,
    topK: TOP_K,
  };
}

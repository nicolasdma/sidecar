/**
 * Fase 3: Vector Math Utilities
 *
 * Reusable vector operations for embeddings.
 * All functions work with Float32Array for memory efficiency.
 */

/**
 * Computes cosine similarity between two vectors.
 * Assumes vectors are already normalized (which transformers.js does).
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Similarity score between -1 and 1 (1 = identical)
 * @throws Error if vectors have different dimensions
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
  }

  // Vectors are already normalized, so dot product = cosine similarity
  return dotProduct;
}

/**
 * Calculates the centroid (mean) of multiple vectors.
 * Result is normalized to unit length.
 *
 * @param vectors - Array of vectors to average
 * @returns Normalized centroid vector
 * @throws Error if array is empty or vectors have different dimensions
 */
export function calculateCentroid(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) {
    throw new Error('Cannot calculate centroid of empty array');
  }

  const first = vectors[0]!;
  const dim = first.length;
  const centroid = new Float32Array(dim);

  // Sum all vectors
  for (const vec of vectors) {
    if (vec.length !== dim) {
      throw new Error(`Vector dimension mismatch: expected ${dim}, got ${vec.length}`);
    }
    for (let i = 0; i < dim; i++) {
      centroid[i]! += vec[i]!;
    }
  }

  // Divide by count to get mean
  for (let i = 0; i < dim; i++) {
    centroid[i]! /= vectors.length;
  }

  // Normalize the centroid to unit length
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += centroid[i]! * centroid[i]!;
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      centroid[i]! /= norm;
    }
  }

  return centroid;
}

/**
 * Serializes Float32Array to Buffer for SQLite BLOB storage.
 *
 * @param embedding - Vector to serialize
 * @returns Buffer ready for database storage
 */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Deserializes Buffer from SQLite BLOB to Float32Array.
 * Creates an aligned copy to avoid alignment issues on some platforms.
 *
 * @param buffer - Buffer from database
 * @returns Float32Array ready for vector operations
 */
export function deserializeEmbedding(buffer: Buffer): Float32Array {
  // Create aligned ArrayBuffer to avoid alignment issues
  // Some environments require Float32Array to be 4-byte aligned
  const aligned = new ArrayBuffer(buffer.length);
  new Uint8Array(aligned).set(buffer);
  return new Float32Array(aligned);
}

/**
 * Computes the Euclidean distance between two vectors.
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Euclidean distance (0 = identical)
 */
export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i]! - b[i]!;
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

/**
 * Normalizes a vector to unit length in place.
 *
 * @param vector - Vector to normalize (modified in place)
 * @returns The same vector, normalized
 */
export function normalizeInPlace(vector: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i]! * vector[i]!;
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i]! /= norm;
    }
  }

  return vector;
}

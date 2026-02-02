/**
 * Unit Tests: Vector Math Utilities
 *
 * Tests for pure vector math functions used in embeddings.
 * Covers serialization, similarity calculations, and edge cases.
 *
 * Run with: npx tsx tests/unit/vector-math.test.ts
 */

import {
  serializeEmbedding,
  deserializeEmbedding,
  cosineSimilarity,
  euclideanDistance,
  normalizeInPlace,
  calculateCentroid,
} from '../../src/memory/vector-math.js';

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name: string, fn: () => void | Promise<void>): void {
  Promise.resolve()
    .then(() => fn())
    .then(() => {
      console.log(`✓ ${name}`);
      passed++;
    })
    .catch((e) => {
      console.error(`✗ ${name}`);
      console.error(`  ${e instanceof Error ? e.message : e}`);
      failed++;
    });
}

function skip(name: string, reason: string): void {
  console.log(`⊘ ${name} (skipped: ${reason})`);
  skipped++;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertAlmostEqual(actual: number, expected: number, tolerance: number = 1e-6, message?: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(message || `Expected ${expected} (±${tolerance}), got ${actual}`);
  }
}

function assertThrows(fn: () => void, expectedMessage?: string): void {
  let threw = false;
  let thrownMessage = '';
  try {
    fn();
  } catch (e) {
    threw = true;
    thrownMessage = e instanceof Error ? e.message : String(e);
  }
  if (!threw) {
    throw new Error('Expected function to throw, but it did not');
  }
  if (expectedMessage && !thrownMessage.includes(expectedMessage)) {
    throw new Error(`Expected error containing "${expectedMessage}", got "${thrownMessage}"`);
  }
}

// ==================== Setup ====================

console.log('\n=== Vector Math Unit Tests ===\n');

// ==================== Serialization Tests ====================

test('serialize/deserialize: roundtrip preserves values', () => {
  const original = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
  const serialized = serializeEmbedding(original);
  const deserialized = deserializeEmbedding(serialized);

  assertEqual(deserialized.length, original.length, 'Length should match');
  for (let i = 0; i < original.length; i++) {
    assertAlmostEqual(deserialized[i]!, original[i]!, 1e-7, `Element ${i} should match`);
  }
});

test('serialize/deserialize: handles empty array', () => {
  const original = new Float32Array([]);
  const serialized = serializeEmbedding(original);
  const deserialized = deserializeEmbedding(serialized);

  assertEqual(deserialized.length, 0, 'Empty array should stay empty');
});

test('serialize/deserialize: handles large vectors (384 dimensions)', () => {
  // 384 is a common embedding dimension
  const original = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    original[i] = Math.random() * 2 - 1; // Random values between -1 and 1
  }

  const serialized = serializeEmbedding(original);
  const deserialized = deserializeEmbedding(serialized);

  assertEqual(deserialized.length, 384, 'Length should be 384');
  for (let i = 0; i < 384; i++) {
    assertAlmostEqual(deserialized[i]!, original[i]!, 1e-7, `Element ${i} should match`);
  }
});

test('serialize/deserialize: preserves special values', () => {
  const original = new Float32Array([0, -0, 1, -1, 0.5, -0.5]);
  const serialized = serializeEmbedding(original);
  const deserialized = deserializeEmbedding(serialized);

  assertEqual(deserialized[0], 0, 'Zero should be preserved');
  assertEqual(deserialized[2], 1, 'One should be preserved');
  assertEqual(deserialized[3], -1, 'Negative one should be preserved');
});

test('serialize: returns Buffer type', () => {
  const embedding = new Float32Array([1, 2, 3]);
  const serialized = serializeEmbedding(embedding);

  assert(Buffer.isBuffer(serialized), 'Should return a Buffer');
  assertEqual(serialized.length, 12, 'Buffer should be 3 floats * 4 bytes = 12 bytes');
});

// ==================== Cosine Similarity Tests ====================

test('cosineSimilarity: identical vectors return ~1.0', () => {
  // Normalized vector
  const v = new Float32Array([0.6, 0.8, 0]); // norm = 1
  const similarity = cosineSimilarity(v, v);

  assertAlmostEqual(similarity, 1.0, 1e-6, 'Identical normalized vectors should have similarity ~1.0');
});

test('cosineSimilarity: orthogonal vectors return 0', () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  const similarity = cosineSimilarity(a, b);

  assertAlmostEqual(similarity, 0, 1e-6, 'Orthogonal vectors should have similarity 0');
});

test('cosineSimilarity: opposite vectors return -1', () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([-1, 0, 0]);
  const similarity = cosineSimilarity(a, b);

  assertAlmostEqual(similarity, -1.0, 1e-6, 'Opposite vectors should have similarity -1');
});

test('cosineSimilarity: known similar vectors', () => {
  // Two vectors at 45 degrees: cos(45°) ≈ 0.707
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([1 / Math.sqrt(2), 1 / Math.sqrt(2)]);
  const similarity = cosineSimilarity(a, b);

  assertAlmostEqual(similarity, 0.7071067811865476, 1e-6, 'Should be cos(45°)');
});

test('cosineSimilarity: throws on dimension mismatch', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([1, 2]);

  assertThrows(() => cosineSimilarity(a, b), 'dimension mismatch');
});

test('cosineSimilarity: handles zero vector', () => {
  const zero = new Float32Array([0, 0, 0]);
  const normal = new Float32Array([1, 0, 0]);
  const similarity = cosineSimilarity(zero, normal);

  // Dot product of zero vector with anything is 0
  assertEqual(similarity, 0, 'Zero vector should have similarity 0');
});

test('cosineSimilarity: handles both zero vectors', () => {
  const zero = new Float32Array([0, 0, 0]);
  const similarity = cosineSimilarity(zero, zero);

  assertEqual(similarity, 0, 'Two zero vectors should have similarity 0');
});

test('cosineSimilarity: single dimension', () => {
  const a = new Float32Array([1]);
  const b = new Float32Array([1]);
  const similarity = cosineSimilarity(a, b);

  assertEqual(similarity, 1, 'Single dimension same direction should be 1');
});

// ==================== Euclidean Distance Tests ====================

test('euclideanDistance: identical vectors return 0', () => {
  const v = new Float32Array([1, 2, 3]);
  const distance = euclideanDistance(v, v);

  assertEqual(distance, 0, 'Distance to self should be 0');
});

test('euclideanDistance: known distance', () => {
  const a = new Float32Array([0, 0]);
  const b = new Float32Array([3, 4]);
  const distance = euclideanDistance(a, b);

  assertEqual(distance, 5, '3-4-5 triangle should have hypotenuse 5');
});

test('euclideanDistance: unit distance', () => {
  const a = new Float32Array([0, 0, 0]);
  const b = new Float32Array([1, 0, 0]);
  const distance = euclideanDistance(a, b);

  assertEqual(distance, 1, 'Unit distance along axis should be 1');
});

test('euclideanDistance: throws on dimension mismatch', () => {
  const a = new Float32Array([1, 2]);
  const b = new Float32Array([1, 2, 3]);

  assertThrows(() => euclideanDistance(a, b), 'dimension mismatch');
});

test('euclideanDistance: negative values', () => {
  const a = new Float32Array([-1, -1]);
  const b = new Float32Array([1, 1]);
  const distance = euclideanDistance(a, b);

  // sqrt((2)^2 + (2)^2) = sqrt(8) ≈ 2.828
  assertAlmostEqual(distance, Math.sqrt(8), 1e-6, 'Distance with negatives');
});

// ==================== Normalize In Place Tests ====================

test('normalizeInPlace: creates unit vector', () => {
  const v = new Float32Array([3, 4, 0]);
  normalizeInPlace(v);

  // Check norm is 1
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    norm += v[i]! * v[i]!;
  }
  norm = Math.sqrt(norm);

  assertAlmostEqual(norm, 1.0, 1e-6, 'Normalized vector should have norm 1');
});

test('normalizeInPlace: preserves direction', () => {
  const v = new Float32Array([6, 8, 0]); // Same direction as [3,4,0]
  normalizeInPlace(v);

  // Should be [0.6, 0.8, 0]
  assertAlmostEqual(v[0]!, 0.6, 1e-6, 'X component');
  assertAlmostEqual(v[1]!, 0.8, 1e-6, 'Y component');
  assertAlmostEqual(v[2]!, 0, 1e-6, 'Z component');
});

test('normalizeInPlace: handles zero vector gracefully', () => {
  const v = new Float32Array([0, 0, 0]);
  normalizeInPlace(v);

  // Should remain zero (no NaN from division by zero)
  assertEqual(v[0], 0, 'Should remain 0');
  assertEqual(v[1], 0, 'Should remain 0');
  assertEqual(v[2], 0, 'Should remain 0');
});

test('normalizeInPlace: returns same array', () => {
  const v = new Float32Array([1, 2, 3]);
  const result = normalizeInPlace(v);

  assert(result === v, 'Should return the same array reference');
});

test('normalizeInPlace: already normalized vector', () => {
  const v = new Float32Array([0.6, 0.8, 0]); // Already normalized
  normalizeInPlace(v);

  assertAlmostEqual(v[0]!, 0.6, 1e-6, 'Should stay 0.6');
  assertAlmostEqual(v[1]!, 0.8, 1e-6, 'Should stay 0.8');
});

// ==================== Calculate Centroid Tests ====================

test('calculateCentroid: single vector returns itself normalized', () => {
  const vectors = [new Float32Array([3, 4, 0])];
  const centroid = calculateCentroid(vectors);

  // Should be normalized [0.6, 0.8, 0]
  assertAlmostEqual(centroid[0]!, 0.6, 1e-6, 'X should be 0.6');
  assertAlmostEqual(centroid[1]!, 0.8, 1e-6, 'Y should be 0.8');
  assertAlmostEqual(centroid[2]!, 0, 1e-6, 'Z should be 0');
});

test('calculateCentroid: two vectors', () => {
  const vectors = [
    new Float32Array([1, 0, 0]),
    new Float32Array([0, 1, 0]),
  ];
  const centroid = calculateCentroid(vectors);

  // Mean is [0.5, 0.5, 0], normalized is [1/sqrt(2), 1/sqrt(2), 0]
  const expected = 1 / Math.sqrt(2);
  assertAlmostEqual(centroid[0]!, expected, 1e-6, 'X should be 1/sqrt(2)');
  assertAlmostEqual(centroid[1]!, expected, 1e-6, 'Y should be 1/sqrt(2)');
  assertAlmostEqual(centroid[2]!, 0, 1e-6, 'Z should be 0');
});

test('calculateCentroid: throws on empty array', () => {
  assertThrows(() => calculateCentroid([]), 'empty array');
});

test('calculateCentroid: throws on dimension mismatch', () => {
  const vectors = [
    new Float32Array([1, 0]),
    new Float32Array([1, 0, 0]),
  ];

  assertThrows(() => calculateCentroid(vectors), 'dimension mismatch');
});

test('calculateCentroid: result is normalized', () => {
  const vectors = [
    new Float32Array([1, 1, 1]),
    new Float32Array([2, 2, 2]),
    new Float32Array([3, 3, 3]),
  ];
  const centroid = calculateCentroid(vectors);

  // Check norm is 1
  let norm = 0;
  for (let i = 0; i < centroid.length; i++) {
    norm += centroid[i]! * centroid[i]!;
  }
  norm = Math.sqrt(norm);

  assertAlmostEqual(norm, 1.0, 1e-6, 'Centroid should be normalized');
});

test('calculateCentroid: canceling vectors', () => {
  const vectors = [
    new Float32Array([1, 0, 0]),
    new Float32Array([-1, 0, 0]),
  ];
  const centroid = calculateCentroid(vectors);

  // Mean is [0, 0, 0], should stay zero after normalize
  assertEqual(centroid[0], 0, 'X should be 0');
  assertEqual(centroid[1], 0, 'Y should be 0');
  assertEqual(centroid[2], 0, 'Z should be 0');
});

// ==================== Summary ====================

setTimeout(() => {
  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Total: ${passed + failed + skipped}`);

  if (failed > 0) {
    process.exit(1);
  }
}, 500);

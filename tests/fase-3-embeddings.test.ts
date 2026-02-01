/**
 * Tests para Fase 3: Semantic Intelligence
 *
 * Ejecutar con: npx tsx tests/fase-3-embeddings.test.ts
 *
 * NOTA: Estos tests requieren que el modelo de embeddings esté disponible.
 * Algunos tests se saltean automáticamente si embeddings no están listos.
 */

import { isEmbeddingsReady, isEmbeddingsEnabled, getEmbeddingsState } from '../src/memory/embeddings-state.js';
import { calculateSemanticContinuity, getAdaptiveWindowSize } from '../src/memory/semantic-continuity.js';
import { cosineSimilarity, calculateCentroid, serializeEmbedding, deserializeEmbedding } from '../src/memory/vector-math.js';
import { getEmbeddingsConfig } from '../src/config/embeddings-config.js';
import type { Message } from '../src/llm/types.js';

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

function assertInRange(actual: number, min: number, max: number, message?: string): void {
  if (actual < min || actual > max) {
    throw new Error(message || `Expected ${actual} to be between ${min} and ${max}`);
  }
}

// ==================== Config Tests ====================

test('embeddings-config: loads default config', () => {
  const config = getEmbeddingsConfig();
  assert(typeof config.enabled === 'boolean', 'enabled should be boolean');
  assert(typeof config.cacheSimilarityThreshold === 'number', 'threshold should be number');
  assertEqual(config.embeddingDimension, 384, 'dimension should be 384');
  assertEqual(config.modelName, 'Xenova/all-MiniLM-L6-v2', 'model should be MiniLM');
});

test('embeddings-config: threshold is in valid range', () => {
  const config = getEmbeddingsConfig();
  assertInRange(config.cacheSimilarityThreshold, 0.0, 1.0, 'threshold should be 0-1');
});

// ==================== Vector Math Tests ====================

test('vector-math: cosineSimilarity identical vectors', () => {
  const v1 = new Float32Array([1, 0, 0]);
  const v2 = new Float32Array([1, 0, 0]);
  const sim = cosineSimilarity(v1, v2);
  assertInRange(sim, 0.99, 1.01, 'identical vectors should have similarity ~1');
});

test('vector-math: cosineSimilarity orthogonal vectors', () => {
  const v1 = new Float32Array([1, 0, 0]);
  const v2 = new Float32Array([0, 1, 0]);
  const sim = cosineSimilarity(v1, v2);
  assertInRange(sim, -0.01, 0.01, 'orthogonal vectors should have similarity ~0');
});

test('vector-math: cosineSimilarity opposite vectors', () => {
  const v1 = new Float32Array([1, 0, 0]);
  const v2 = new Float32Array([-1, 0, 0]);
  const sim = cosineSimilarity(v1, v2);
  assertInRange(sim, -1.01, -0.99, 'opposite vectors should have similarity ~-1');
});

test('vector-math: calculateCentroid single vector is normalized', () => {
  const v1 = new Float32Array([1, 2, 3]);
  const centroid = calculateCentroid([v1]);

  // Centroid should be normalized (unit length)
  let norm = 0;
  for (let i = 0; i < centroid.length; i++) {
    norm += centroid[i]! * centroid[i]!;
  }
  norm = Math.sqrt(norm);
  assertInRange(norm, 0.99, 1.01, 'centroid should be unit length');

  // Direction should be preserved (proportions)
  const ratio12 = centroid[1]! / centroid[0]!;
  const ratio13 = centroid[2]! / centroid[0]!;
  assertInRange(ratio12, 1.99, 2.01, 'ratio 1:2 should be preserved');
  assertInRange(ratio13, 2.99, 3.01, 'ratio 1:3 should be preserved');
});

test('vector-math: calculateCentroid multiple vectors is normalized', () => {
  const v1 = new Float32Array([0, 0, 0]);
  const v2 = new Float32Array([2, 4, 6]);
  const centroid = calculateCentroid([v1, v2]);

  // Mean is [1, 2, 3], then normalized
  let norm = 0;
  for (let i = 0; i < centroid.length; i++) {
    norm += centroid[i]! * centroid[i]!;
  }
  norm = Math.sqrt(norm);
  assertInRange(norm, 0.99, 1.01, 'centroid should be unit length');

  // Direction should match [1, 2, 3] (proportions)
  const ratio12 = centroid[1]! / centroid[0]!;
  const ratio13 = centroid[2]! / centroid[0]!;
  assertInRange(ratio12, 1.99, 2.01, 'ratio 1:2 should be preserved');
  assertInRange(ratio13, 2.99, 3.01, 'ratio 1:3 should be preserved');
});

test('vector-math: serialize/deserialize roundtrip', () => {
  const original = new Float32Array([1.5, -2.5, 3.5, 0.0]);
  const serialized = serializeEmbedding(original);
  const deserialized = deserializeEmbedding(serialized);

  assertEqual(deserialized.length, original.length, 'length should match');
  for (let i = 0; i < original.length; i++) {
    assertInRange(deserialized[i]!, original[i]! - 0.001, original[i]! + 0.001, `element ${i} should match`);
  }
});

// ==================== Semantic Continuity Tests ====================

test('semantic-continuity: bootstrap with < 3 messages returns default', async () => {
  const messages: Message[] = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'hola!' },
  ];

  const result = await calculateSemanticContinuity('test', messages);
  assertEqual(result.reason, 'bootstrap', 'should return bootstrap reason');
  assertEqual(result.windowSize, 6, 'should return default window size');
  assertEqual(result.score, 0.5, 'should return default score');
});

test('semantic-continuity: returns embeddings_disabled when not ready', async () => {
  // This test checks behavior when embeddings aren't ready
  // The actual behavior depends on whether embeddings are loaded
  const messages: Message[] = [
    { role: 'user', content: 'tema uno' },
    { role: 'user', content: 'tema uno continuacion' },
    { role: 'user', content: 'tema uno mas' },
  ];

  const result = await calculateSemanticContinuity('tema uno final', messages);

  // Should be either 'calculated' (if embeddings ready) or 'embeddings_disabled'
  assert(
    result.reason === 'calculated' || result.reason === 'embeddings_disabled' || result.reason === 'bootstrap',
    `reason should be valid, got: ${result.reason}`
  );
  assertInRange(result.windowSize, 4, 8, 'window size should be 4, 6, or 8');
});

test('semantic-continuity: getAdaptiveWindowSize returns valid size', async () => {
  const messages: Message[] = [
    { role: 'user', content: 'mensaje uno' },
    { role: 'user', content: 'mensaje dos' },
    { role: 'user', content: 'mensaje tres' },
  ];

  const windowSize = await getAdaptiveWindowSize('mensaje cuatro', messages);
  assert([4, 6, 8].includes(windowSize), `window size should be 4, 6, or 8, got: ${windowSize}`);
});

test('semantic-continuity: undefined message returns default', async () => {
  const messages: Message[] = [];
  const windowSize = await getAdaptiveWindowSize(undefined, messages);
  assertEqual(windowSize, 6, 'undefined message should return default window size');
});

// ==================== Embeddings State Tests ====================

test('embeddings-state: getEmbeddingsState returns valid structure', () => {
  const state = getEmbeddingsState();
  assert(typeof state.enabled === 'boolean', 'enabled should be boolean');
  assert(typeof state.ready === 'boolean', 'ready should be boolean');
  assert(typeof state.reason === 'string', 'reason should be string');
  assert(typeof state.consecutiveFailures === 'number', 'consecutiveFailures should be number');
});

test('embeddings-state: isEmbeddingsEnabled returns boolean', () => {
  const enabled = isEmbeddingsEnabled();
  assert(typeof enabled === 'boolean', 'should return boolean');
});

test('embeddings-state: isEmbeddingsReady returns boolean', () => {
  const ready = isEmbeddingsReady();
  assert(typeof ready === 'boolean', 'should return boolean');
});

// ==================== Integration Tests (require embeddings) ====================

// These tests only run if embeddings are available
const EMBEDDINGS_TESTS_ENABLED = process.env.TEST_EMBEDDINGS === 'true';

if (EMBEDDINGS_TESTS_ENABLED) {
  test('integration: embedText returns 384-dim vector', async () => {
    const { embedText } = await import('../src/memory/embeddings-model.js');
    const embedding = await embedText('test text');
    assertEqual(embedding.length, 384, 'should return 384-dimensional vector');
  });

  test('integration: similar texts have high similarity', async () => {
    const { embedText } = await import('../src/memory/embeddings-model.js');
    const e1 = await embedText('deployed to kubernetes cluster');
    const e2 = await embedText('k8s deployment process');
    const sim = cosineSimilarity(e1, e2);
    assert(sim > 0.5, `similar texts should have similarity > 0.5, got: ${sim}`);
  });

  test('integration: different texts have low similarity', async () => {
    const { embedText } = await import('../src/memory/embeddings-model.js');
    const e1 = await embedText('deployed to kubernetes cluster');
    const e2 = await embedText('receta de pasta italiana');
    const sim = cosineSimilarity(e1, e2);
    assert(sim < 0.5, `different texts should have similarity < 0.5, got: ${sim}`);
  });

  test('integration: topic shift detected with embeddings', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'hablemos de kubernetes' },
      { role: 'user', content: 'deployments en k8s' },
      { role: 'user', content: 'pods y services' },
    ];

    const result = await calculateSemanticContinuity('receta de milanesas', messages);
    if (result.reason === 'calculated') {
      assert(result.score < 0.5, `topic shift should have low score, got: ${result.score}`);
      assertEqual(result.windowSize, 4, 'topic shift should reduce window to 4');
    }
  });

  test('integration: same topic maintains high continuity', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'hablemos de kubernetes' },
      { role: 'user', content: 'deployments en k8s' },
      { role: 'user', content: 'pods y services' },
    ];

    const result = await calculateSemanticContinuity('cómo escalo los replicas en kubernetes', messages);
    if (result.reason === 'calculated') {
      assert(result.score > 0.5, `same topic should have high score, got: ${result.score}`);
      assertEqual(result.windowSize, 8, 'same topic should expand window to 8');
    }
  });
} else {
  skip('integration: embedText returns 384-dim vector', 'TEST_EMBEDDINGS=true not set');
  skip('integration: similar texts have high similarity', 'TEST_EMBEDDINGS=true not set');
  skip('integration: different texts have low similarity', 'TEST_EMBEDDINGS=true not set');
  skip('integration: topic shift detected with embeddings', 'TEST_EMBEDDINGS=true not set');
  skip('integration: same topic maintains high continuity', 'TEST_EMBEDDINGS=true not set');
}

// ==================== Summary ====================

// Wait for all async tests to complete
setTimeout(() => {
  console.log('\n' + '='.repeat(50));
  console.log(`Tests: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('='.repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}, 2000);

/**
 * Integration Tests: State Persistence
 *
 * Tests that critical state (backoff, circuit breakers) survives restarts.
 *
 * Run with: npx tsx tests/integration/state-persistence.test.ts
 */

import {
  getDatabase,
  getSystemStateJson,
  setSystemStateJson,
  deleteSystemState,
} from '../../src/memory/store.js';

let passed = 0;
let failed = 0;

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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertNotNull<T>(value: T | null | undefined, message?: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message || 'Expected value to not be null/undefined');
  }
}

// ==================== Setup ====================

console.log('\n=== State Persistence Integration Tests ===\n');

// Initialize database
getDatabase();

// ==================== LocalRouter Backoff Persistence ====================

interface BackoffState {
  consecutiveFailures: number;
  backoffUntil: number | null;
  lastError: string | null;
}

test('localrouter-backoff: persist and restore active backoff', () => {
  const key = 'localrouter_backoff';
  const backoffUntil = Date.now() + 60000; // 1 minute in future

  const state: BackoffState = {
    consecutiveFailures: 5,
    backoffUntil,
    lastError: 'Connection timeout',
  };

  setSystemStateJson(key, state);

  const restored = getSystemStateJson<BackoffState>(key);
  assertNotNull(restored, 'State should be restored');
  assertEqual(restored.consecutiveFailures, 5, 'Failures should match');
  assertEqual(restored.backoffUntil, backoffUntil, 'BackoffUntil should match');
  assertEqual(restored.lastError, 'Connection timeout', 'Error should match');

  // Cleanup
  deleteSystemState(key);
});

test('localrouter-backoff: expired backoff is detectable', () => {
  const key = 'localrouter_backoff_expired';
  const backoffUntil = Date.now() - 60000; // 1 minute in past

  const state: BackoffState = {
    consecutiveFailures: 3,
    backoffUntil,
    lastError: 'Old error',
  };

  setSystemStateJson(key, state);

  const restored = getSystemStateJson<BackoffState>(key);
  assertNotNull(restored, 'State should be restored');

  // Check if backoff is expired
  const isExpired = restored.backoffUntil !== null && restored.backoffUntil < Date.now();
  assert(isExpired, 'Backoff should be detected as expired');

  // Cleanup
  deleteSystemState(key);
});

test('localrouter-backoff: null backoffUntil means no active backoff', () => {
  const key = 'localrouter_backoff_none';

  const state: BackoffState = {
    consecutiveFailures: 2,
    backoffUntil: null,
    lastError: 'Some error',
  };

  setSystemStateJson(key, state);

  const restored = getSystemStateJson<BackoffState>(key);
  assertNotNull(restored, 'State should be restored');
  assert(restored.backoffUntil === null, 'BackoffUntil should be null');
  assertEqual(restored.consecutiveFailures, 2, 'Failures should be preserved');

  // Cleanup
  deleteSystemState(key);
});

// ==================== Embeddings Circuit Breaker Persistence ====================

interface CircuitBreakerState {
  consecutiveFailures: number;
  circuitOpenUntil: number | null;
}

test('embeddings-circuit: persist and restore open circuit', () => {
  const key = 'embeddings_circuit_breaker';
  const circuitOpenUntil = Date.now() + 120000; // 2 minutes in future

  const state: CircuitBreakerState = {
    consecutiveFailures: 10,
    circuitOpenUntil,
  };

  setSystemStateJson(key, state);

  const restored = getSystemStateJson<CircuitBreakerState>(key);
  assertNotNull(restored, 'State should be restored');
  assertEqual(restored.consecutiveFailures, 10, 'Failures should match');
  assertEqual(restored.circuitOpenUntil, circuitOpenUntil, 'CircuitOpenUntil should match');

  // Cleanup
  deleteSystemState(key);
});

test('embeddings-circuit: closed circuit has null circuitOpenUntil', () => {
  const key = 'embeddings_circuit_closed';

  const state: CircuitBreakerState = {
    consecutiveFailures: 2,
    circuitOpenUntil: null,
  };

  setSystemStateJson(key, state);

  const restored = getSystemStateJson<CircuitBreakerState>(key);
  assertNotNull(restored, 'State should be restored');
  assert(restored.circuitOpenUntil === null, 'CircuitOpenUntil should be null');

  // Cleanup
  deleteSystemState(key);
});

test('embeddings-circuit: expired circuit is detectable', () => {
  const key = 'embeddings_circuit_expired';
  const circuitOpenUntil = Date.now() - 30000; // 30 seconds in past

  const state: CircuitBreakerState = {
    consecutiveFailures: 5,
    circuitOpenUntil,
  };

  setSystemStateJson(key, state);

  const restored = getSystemStateJson<CircuitBreakerState>(key);
  assertNotNull(restored, 'State should be restored');

  // Check if circuit is expired
  const isExpired = restored.circuitOpenUntil !== null && restored.circuitOpenUntil < Date.now();
  assert(isExpired, 'Circuit should be detected as expired');

  // Cleanup
  deleteSystemState(key);
});

// ==================== State Isolation ====================

test('state-isolation: different keys are independent', () => {
  const key1 = 'test_state_1';
  const key2 = 'test_state_2';

  setSystemStateJson(key1, { value: 'one' });
  setSystemStateJson(key2, { value: 'two' });

  const restored1 = getSystemStateJson<{ value: string }>(key1);
  const restored2 = getSystemStateJson<{ value: string }>(key2);

  assertNotNull(restored1, 'State 1 should exist');
  assertNotNull(restored2, 'State 2 should exist');
  assertEqual(restored1.value, 'one', 'State 1 should be independent');
  assertEqual(restored2.value, 'two', 'State 2 should be independent');

  // Cleanup
  deleteSystemState(key1);
  deleteSystemState(key2);
});

test('state-isolation: delete one key doesnt affect others', () => {
  const key1 = 'test_delete_1';
  const key2 = 'test_delete_2';

  setSystemStateJson(key1, { keep: false });
  setSystemStateJson(key2, { keep: true });

  deleteSystemState(key1);

  const restored1 = getSystemStateJson<{ keep: boolean }>(key1);
  const restored2 = getSystemStateJson<{ keep: boolean }>(key2);

  assert(restored1 === null, 'Deleted key should be null');
  assertNotNull(restored2, 'Other key should still exist');
  assertEqual(restored2.keep, true, 'Other key value should be intact');

  // Cleanup
  deleteSystemState(key2);
});

// ==================== Edge Cases ====================

test('edge-case: complex nested JSON', () => {
  const key = 'test_complex';
  const complex = {
    level1: {
      level2: {
        array: [1, 2, 3],
        string: 'test',
        number: 42.5,
        boolean: true,
        nullValue: null,
      },
    },
    timestamp: Date.now(),
  };

  setSystemStateJson(key, complex);
  const restored = getSystemStateJson<typeof complex>(key);

  assertNotNull(restored, 'Complex state should be restored');
  assertEqual(restored.level1.level2.string, 'test', 'Nested string should match');
  assertEqual(restored.level1.level2.array.length, 3, 'Array should be preserved');
  assertEqual(restored.level1.level2.boolean, true, 'Boolean should be preserved');
  assert(restored.level1.level2.nullValue === null, 'Null should be preserved');

  // Cleanup
  deleteSystemState(key);
});

test('edge-case: empty object', () => {
  const key = 'test_empty';

  setSystemStateJson(key, {});
  const restored = getSystemStateJson<Record<string, never>>(key);

  assertNotNull(restored, 'Empty object should be restored');
  assertEqual(Object.keys(restored).length, 0, 'Object should be empty');

  // Cleanup
  deleteSystemState(key);
});

test('edge-case: update preserves only new value', () => {
  const key = 'test_update';

  setSystemStateJson(key, { version: 1, data: 'old' });
  setSystemStateJson(key, { version: 2, data: 'new' });

  const restored = getSystemStateJson<{ version: number; data: string }>(key);
  assertNotNull(restored, 'Updated state should be restored');
  assertEqual(restored.version, 2, 'Version should be updated');
  assertEqual(restored.data, 'new', 'Data should be updated');

  // Cleanup
  deleteSystemState(key);
});

// ==================== Summary ====================

setTimeout(() => {
  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}, 500);

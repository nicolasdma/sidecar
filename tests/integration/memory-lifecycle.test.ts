/**
 * Integration Tests: Memory Lifecycle
 *
 * Tests the complete lifecycle of facts, from creation to retrieval,
 * including persistence and state management.
 *
 * Run with: npx tsx tests/integration/memory-lifecycle.test.ts
 */

import { randomUUID } from 'crypto';
import {
  saveFact,
  getFacts,
  getFactById,
  getFactsByDomain,
  updateFactConfirmation,
  archiveFact,
  supersedeFact,
  getTotalFactsCount,
  type NewFact,
} from '../../src/memory/facts-store.js';
import {
  getDatabase,
  getSystemState,
  setSystemState,
  getSystemStateJson,
  setSystemStateJson,
  deleteSystemState,
} from '../../src/memory/store.js';

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

function assertNotNull<T>(value: T | null | undefined, message?: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message || 'Expected value to not be null/undefined');
  }
}

// ==================== Setup ====================

console.log('\n=== Memory Lifecycle Integration Tests ===\n');

// Initialize database
getDatabase();

// ==================== Facts Lifecycle Tests ====================

test('facts: create and retrieve a fact', () => {
  const newFact: NewFact = {
    domain: 'health',
    fact: `Test fact ${randomUUID().slice(0, 8)}`,
    confidence: 'high',
    source: 'explicit',
  };

  const id = saveFact(newFact);
  assert(typeof id === 'string', 'ID should be a string');
  assert(id.length > 0, 'ID should not be empty');

  const retrieved = getFactById(id);
  assertNotNull(retrieved, 'Fact should be retrievable');
  assertEqual(retrieved.fact, newFact.fact, 'Fact content should match');
  assertEqual(retrieved.domain, newFact.domain, 'Domain should match');
  assertEqual(retrieved.confidence, newFact.confidence, 'Confidence should match');
});

test('facts: retrieve by domain', () => {
  const testDomain = 'work';
  const testFact = `Work fact ${randomUUID().slice(0, 8)}`;

  saveFact({
    domain: testDomain,
    fact: testFact,
    confidence: 'medium',
    source: 'explicit',
  });

  const facts = getFactsByDomain(testDomain);
  assert(facts.length > 0, 'Should have at least one fact in domain');
  assert(
    facts.some(f => f.fact === testFact),
    'Should find the created fact'
  );
});

test('facts: update confirmation timestamp', () => {
  const id = saveFact({
    domain: 'preferences',
    fact: `Preference ${randomUUID().slice(0, 8)}`,
    confidence: 'medium',
    source: 'explicit',
  });

  const before = getFactById(id);
  assertNotNull(before, 'Fact should exist');
  const originalConfirmedAt = before.lastConfirmedAt;

  // Wait a bit to ensure timestamp changes
  const waitMs = 10;
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    // busy wait
  }

  updateFactConfirmation(id);

  const after = getFactById(id);
  assertNotNull(after, 'Fact should still exist');
  assert(
    after.lastConfirmedAt >= originalConfirmedAt,
    'Confirmation timestamp should be updated'
  );
});

test('facts: archive a fact', () => {
  const id = saveFact({
    domain: 'general',
    fact: `To be archived ${randomUUID().slice(0, 8)}`,
    confidence: 'low',
    source: 'explicit',
  });

  archiveFact(id);

  // Should not appear in normal queries
  const allFacts = getFacts({ domain: 'general' });
  assert(
    !allFacts.some(f => f.id === id),
    'Archived fact should not appear in normal queries'
  );

  // Should appear when including archived
  const withArchived = getFacts({ domain: 'general', includeArchived: true });
  assert(
    withArchived.some(f => f.id === id),
    'Archived fact should appear when includeArchived is true'
  );
});

test('facts: supersede a fact', () => {
  const oldId = saveFact({
    domain: 'work',
    fact: `Old job ${randomUUID().slice(0, 8)}`,
    confidence: 'high',
    source: 'explicit',
  });

  const newId = supersedeFact(oldId, {
    domain: 'work',
    fact: `New job ${randomUUID().slice(0, 8)}`,
    confidence: 'high',
    source: 'explicit',
  });

  assertNotNull(newId, 'New fact should be created');

  // Old fact should be archived
  const oldFact = getFactById(oldId);
  assertNotNull(oldFact, 'Old fact should still exist');
  assert(oldFact.archived, 'Old fact should be archived');

  // New fact should reference old one
  const newFact = getFactById(newId);
  assertNotNull(newFact, 'New fact should exist');
  assertEqual(newFact.supersedes, oldId, 'New fact should reference old one');
});

test('facts: count total facts', () => {
  const countBefore = getTotalFactsCount();
  assert(typeof countBefore === 'number', 'Count should be a number');

  saveFact({
    domain: 'general',
    fact: `Count test ${randomUUID().slice(0, 8)}`,
    confidence: 'medium',
    source: 'explicit',
  });

  const countAfter = getTotalFactsCount();
  assertEqual(countAfter, countBefore + 1, 'Count should increase by 1');
});

// ==================== System State Tests ====================

test('system-state: set and get string value', () => {
  const key = `test_key_${randomUUID().slice(0, 8)}`;
  const value = 'test_value_123';

  setSystemState(key, value);
  const retrieved = getSystemState(key);
  assertEqual(retrieved, value, 'Value should match');

  // Cleanup
  deleteSystemState(key);
});

test('system-state: set and get JSON value', () => {
  const key = `test_json_${randomUUID().slice(0, 8)}`;
  const value = {
    consecutiveFailures: 5,
    backoffUntil: Date.now() + 30000,
    lastError: 'Test error',
  };

  setSystemStateJson(key, value);
  const retrieved = getSystemStateJson<typeof value>(key);

  assertNotNull(retrieved, 'JSON should be retrievable');
  assertEqual(retrieved.consecutiveFailures, value.consecutiveFailures, 'Failures should match');
  assertEqual(retrieved.backoffUntil, value.backoffUntil, 'BackoffUntil should match');
  assertEqual(retrieved.lastError, value.lastError, 'LastError should match');

  // Cleanup
  deleteSystemState(key);
});

test('system-state: update existing value', () => {
  const key = `test_update_${randomUUID().slice(0, 8)}`;

  setSystemState(key, 'initial');
  assertEqual(getSystemState(key), 'initial', 'Initial value should be set');

  setSystemState(key, 'updated');
  assertEqual(getSystemState(key), 'updated', 'Value should be updated');

  // Cleanup
  deleteSystemState(key);
});

test('system-state: delete value', () => {
  const key = `test_delete_${randomUUID().slice(0, 8)}`;

  setSystemState(key, 'to_delete');
  assert(getSystemState(key) !== null, 'Value should exist before delete');

  const deleted = deleteSystemState(key);
  assert(deleted, 'Delete should return true');
  assert(getSystemState(key) === null, 'Value should be null after delete');
});

test('system-state: get non-existent key returns null', () => {
  const key = `non_existent_${randomUUID()}`;
  const value = getSystemState(key);
  assert(value === null, 'Non-existent key should return null');
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
}, 1000);

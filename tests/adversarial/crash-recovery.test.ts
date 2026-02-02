/**
 * Adversarial Tests: Crash Recovery
 *
 * Tests that system state persists correctly across simulated restarts
 * and that recovery mechanisms work as expected.
 *
 * Run with: npx tsx tests/adversarial/crash-recovery.test.ts
 */

import { randomUUID } from 'crypto';
import {
  getDatabase,
  getSystemState,
  setSystemState,
  getSystemStateJson,
  setSystemStateJson,
  deleteSystemState,
  recoverStalledExtractions,
  recoverStalledEmbeddings,
  queueMessageForExtraction,
  markExtractionProcessing,
  getPendingExtractions,
  getPendingExtractionCount,
  queueFactForEmbedding,
  markEmbeddingProcessing,
  getPendingEmbeddings,
  getPendingEmbeddingCount,
} from '../../src/memory/store.js';
import { saveFact } from '../../src/memory/facts-store.js';

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

console.log('\n=== Crash Recovery Adversarial Tests ===\n');

// Initialize database
getDatabase();

// ==================== System State Persistence ====================

test('crash-recovery: backoff state persists across simulated restart', () => {
  const testKey = `test_backoff_${randomUUID().slice(0, 8)}`;
  const backoffState = {
    consecutiveFailures: 3,
    backoffUntil: Date.now() + 30000,
    lastError: 'Connection refused',
  };

  // Step 1: Save backoff state (simulating what LocalRouter does)
  setSystemStateJson(testKey, backoffState);

  // Step 2: Simulate restart by getting fresh DB reference
  const freshDb = getDatabase();
  assert(freshDb !== null, 'Database should be accessible');

  // Step 3: Restore state (simulating what LocalRouter does on startup)
  const restored = getSystemStateJson<typeof backoffState>(testKey);

  assertNotNull(restored, 'State should be restored after restart');
  assertEqual(restored.consecutiveFailures, 3, 'Failures count should match');
  assertEqual(restored.backoffUntil, backoffState.backoffUntil, 'BackoffUntil should match');
  assertEqual(restored.lastError, 'Connection refused', 'Error message should match');

  // Cleanup
  deleteSystemState(testKey);
});

test('crash-recovery: circuit breaker state persists', () => {
  const testKey = `test_circuit_${randomUUID().slice(0, 8)}`;
  const circuitState = {
    circuitOpen: true,
    openedAt: Date.now(),
    resetAt: Date.now() + 60000,
    failureCount: 5,
  };

  // Save state
  setSystemStateJson(testKey, circuitState);

  // Simulate restart
  const freshDb = getDatabase();
  assert(freshDb !== null, 'Database should be accessible');

  // Restore and verify
  const restored = getSystemStateJson<typeof circuitState>(testKey);
  assertNotNull(restored, 'Circuit state should be restored');
  assertEqual(restored.circuitOpen, true, 'Circuit open status should match');
  assertEqual(restored.failureCount, 5, 'Failure count should match');

  // Cleanup
  deleteSystemState(testKey);
});

test('crash-recovery: expired backoff state is still accessible', () => {
  const testKey = `test_expired_${randomUUID().slice(0, 8)}`;
  const expiredBackoff = {
    consecutiveFailures: 5,
    backoffUntil: Date.now() - 60000, // Expired 1 minute ago
    lastError: 'Old error',
  };

  // Save expired state
  setSystemStateJson(testKey, expiredBackoff);

  // Simulate restart and restore
  const restored = getSystemStateJson<typeof expiredBackoff>(testKey);

  assertNotNull(restored, 'Expired state should still be readable');
  assert(
    restored.backoffUntil < Date.now(),
    'backoffUntil should be in the past'
  );
  // Application code should check if backoff has expired and reset accordingly

  // Cleanup
  deleteSystemState(testKey);
});

// ==================== Queue Recovery ====================

test('crash-recovery: stalled extractions are recovered', () => {
  // Simulate messages stuck in 'processing' status (app crashed during extraction)
  const uniqueMsg = randomUUID().slice(0, 8);
  const db = getDatabase();

  // Insert a message to get a valid ID
  const msgResult = db.prepare(`
    INSERT INTO messages (role, content)
    VALUES ('user', ?)
  `).run(`Test message for extraction ${uniqueMsg}`);
  const messageId = Number(msgResult.lastInsertRowid);

  // Queue it for extraction
  queueMessageForExtraction(messageId, `Test content ${uniqueMsg}`, 'user');

  // Mark as processing (simulating app was in the middle of processing)
  const pending = getPendingExtractions(1);
  if (pending.length > 0 && pending[0]!.message_id === messageId) {
    markExtractionProcessing(pending[0]!.id);
  }

  // Verify it's stuck in processing
  const processingBefore = db.prepare(`
    SELECT COUNT(*) as count FROM pending_extraction WHERE status = 'processing'
  `).get() as { count: number };
  assert(processingBefore.count >= 1, 'Should have at least one processing item');

  // Run recovery (simulating startup)
  const recovered = recoverStalledExtractions();

  // Verify recovery happened
  assert(recovered >= 0, 'Recovery should return number of items recovered');

  // Verify items are back to pending status
  const processingAfter = db.prepare(`
    SELECT COUNT(*) as count FROM pending_extraction WHERE status = 'processing'
  `).get() as { count: number };
  assertEqual(processingAfter.count, 0, 'No items should remain in processing status');
});

test('crash-recovery: stalled embeddings are recovered', () => {
  // Create a fact to embed
  const factId = saveFact({
    domain: 'general',
    fact: `Test fact for embedding recovery - ${randomUUID().slice(0, 8)}`,
    confidence: 'medium',
    source: 'explicit',
  });

  const db = getDatabase();

  // Queue fact for embedding (may already be queued by saveFact if embeddings enabled)
  try {
    queueFactForEmbedding(factId);
  } catch {
    // Ignore if already queued
  }

  // Force it to processing status
  db.prepare(`
    UPDATE pending_embedding SET status = 'processing' WHERE fact_id = ?
  `).run(factId);

  // Verify it's in processing
  const processingBefore = db.prepare(`
    SELECT COUNT(*) as count FROM pending_embedding WHERE status = 'processing'
  `).get() as { count: number };
  assert(processingBefore.count >= 1, 'Should have at least one processing embedding');

  // Run recovery
  const recovered = recoverStalledEmbeddings();

  assert(recovered >= 0, 'Recovery should return number of items recovered');

  // Verify recovery
  const processingAfter = db.prepare(`
    SELECT COUNT(*) as count FROM pending_embedding WHERE status = 'processing'
  `).get() as { count: number };
  assertEqual(processingAfter.count, 0, 'No embeddings should remain in processing');
});

test('crash-recovery: queue survives restart', () => {
  const db = getDatabase();

  // Get current queue sizes
  const extractionCountBefore = getPendingExtractionCount();
  const embeddingCountBefore = getPendingEmbeddingCount();

  // Add items to queues
  const msgResult = db.prepare(`
    INSERT INTO messages (role, content)
    VALUES ('user', ?)
  `).run(`Queue test message ${randomUUID().slice(0, 8)}`);
  queueMessageForExtraction(
    Number(msgResult.lastInsertRowid),
    'Queue test content',
    'user'
  );

  const factId = saveFact({
    domain: 'general',
    fact: `Queue test fact - ${randomUUID().slice(0, 8)}`,
    confidence: 'low',
    source: 'explicit',
  });

  // Simulate restart
  const freshDb = getDatabase();
  assert(freshDb !== null, 'Database should be accessible');

  // Verify queues still have items
  assert(
    getPendingExtractionCount() >= extractionCountBefore,
    'Extraction queue should persist'
  );
});

// ==================== State Management Edge Cases ====================

test('crash-recovery: handles corrupted JSON gracefully', () => {
  const testKey = `test_corrupted_${randomUUID().slice(0, 8)}`;

  // Save corrupted JSON directly
  setSystemState(testKey, 'not valid json {{{');

  // Attempt to read as JSON should return null, not throw
  const result = getSystemStateJson<object>(testKey);
  assertEqual(result, null, 'Corrupted JSON should return null');

  // Cleanup
  deleteSystemState(testKey);
});

test('crash-recovery: handles missing state gracefully', () => {
  const nonExistentKey = `nonexistent_${randomUUID()}`;

  // Reading non-existent key should return null
  const stringResult = getSystemState(nonExistentKey);
  assertEqual(stringResult, null, 'Non-existent string key should return null');

  const jsonResult = getSystemStateJson<object>(nonExistentKey);
  assertEqual(jsonResult, null, 'Non-existent JSON key should return null');
});

test('crash-recovery: state can be updated after restore', () => {
  const testKey = `test_update_${randomUUID().slice(0, 8)}`;
  const initialState = { count: 1, status: 'initial' };

  // Save initial state
  setSystemStateJson(testKey, initialState);

  // Simulate restart
  getDatabase();

  // Restore state
  const restored = getSystemStateJson<typeof initialState>(testKey);
  assertNotNull(restored, 'State should be restored');

  // Update state (simulating continued operation after restart)
  const updatedState = { count: restored.count + 1, status: 'updated' };
  setSystemStateJson(testKey, updatedState);

  // Verify update persisted
  const finalState = getSystemStateJson<typeof updatedState>(testKey);
  assertNotNull(finalState, 'Updated state should be readable');
  assertEqual(finalState.count, 2, 'Count should be incremented');
  assertEqual(finalState.status, 'updated', 'Status should be updated');

  // Cleanup
  deleteSystemState(testKey);
});

test('crash-recovery: multiple keys can coexist', () => {
  const key1 = `test_multi1_${randomUUID().slice(0, 8)}`;
  const key2 = `test_multi2_${randomUUID().slice(0, 8)}`;

  // Save multiple states
  setSystemStateJson(key1, { type: 'backoff', failures: 3 });
  setSystemStateJson(key2, { type: 'circuit', open: true });

  // Simulate restart
  getDatabase();

  // Verify both are restored correctly
  const state1 = getSystemStateJson<{ type: string; failures: number }>(key1);
  const state2 = getSystemStateJson<{ type: string; open: boolean }>(key2);

  assertNotNull(state1, 'State 1 should be restored');
  assertNotNull(state2, 'State 2 should be restored');
  assertEqual(state1.type, 'backoff', 'State 1 type should match');
  assertEqual(state2.type, 'circuit', 'State 2 type should match');
  assertEqual(state1.failures, 3, 'State 1 failures should match');
  assertEqual(state2.open, true, 'State 2 open should match');

  // Cleanup
  deleteSystemState(key1);
  deleteSystemState(key2);
});

test('crash-recovery: state deletion is permanent', () => {
  const testKey = `test_delete_${randomUUID().slice(0, 8)}`;

  // Save state
  setSystemState(testKey, 'to be deleted');
  assert(getSystemState(testKey) !== null, 'State should exist before delete');

  // Delete state
  const deleted = deleteSystemState(testKey);
  assertEqual(deleted, true, 'Delete should return true');

  // Verify state is gone
  assertEqual(getSystemState(testKey), null, 'State should be null after delete');

  // Simulate restart and verify still gone
  getDatabase();
  assertEqual(getSystemState(testKey), null, 'State should remain deleted after restart');
});

// ==================== Proactive State Recovery ====================

test('crash-recovery: proactive state persists', () => {
  const db = getDatabase();

  // Update proactive state directly
  db.prepare(`
    INSERT OR REPLACE INTO proactive_state (id, spontaneous_count_today, last_user_message_at)
    VALUES (1, 5, datetime('now'))
  `).run();

  // Simulate restart
  getDatabase();

  // Verify state persists
  const state = db.prepare('SELECT * FROM proactive_state WHERE id = 1').get() as {
    spontaneous_count_today: number;
    last_user_message_at: string;
  } | undefined;

  assertNotNull(state, 'Proactive state should persist');
  assertEqual(state.spontaneous_count_today, 5, 'Count should be preserved');
  assert(state.last_user_message_at !== null, 'Timestamp should be preserved');
});

// ==================== Reminder Recovery ====================

test('crash-recovery: pending reminders survive restart', () => {
  const db = getDatabase();
  const reminderId = randomUUID();
  const triggerAt = new Date(Date.now() + 3600000); // 1 hour from now

  // Create a reminder
  db.prepare(`
    INSERT INTO reminders (id, message, trigger_at)
    VALUES (?, ?, ?)
  `).run(reminderId, 'Test reminder for crash recovery', triggerAt.toISOString());

  // Simulate restart
  getDatabase();

  // Verify reminder persists
  const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(reminderId) as {
    id: string;
    message: string;
    triggered: number;
  } | undefined;

  assertNotNull(reminder, 'Reminder should survive restart');
  assertEqual(reminder.triggered, 0, 'Reminder should still be pending');
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

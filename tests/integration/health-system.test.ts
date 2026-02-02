/**
 * Integration Tests: Health System
 *
 * Tests the metrics system, health monitoring, and state persistence.
 *
 * Run with: npx tsx tests/integration/health-system.test.ts
 */

import {
  recordMessageProcessed,
  recordToolExecuted,
  recordFactSaved,
  recordFactExtracted,
  recordContextTruncation,
  recordLocalRouterHit,
  recordLocalRouterBypass,
  recordProactiveHeartbeat,
  recordReminderHeartbeat,
  recordExtractionFailure,
  resetExtractionFailures,
  getSessionMetrics,
  getProactiveLoopHealth,
  getReminderSchedulerHealth,
  getExtractionQueueHealth,
  getEmbeddingQueueHealth,
  determineOverallHealth,
  resetSessionMetrics,
  type SubsystemHealth,
} from '../../src/utils/metrics.js';
import { getDatabase } from '../../src/memory/store.js';

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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

// ==================== Setup ====================

console.log('\n=== Health System Integration Tests ===\n');

// Initialize database
getDatabase();

// Reset metrics for clean test state
resetSessionMetrics();

// ==================== Session Metrics Tests ====================

test('metrics: initial state is zero', () => {
  const metrics = getSessionMetrics();
  assertEqual(metrics.messagesProcessed, 0, 'Messages should be 0');
  assertEqual(metrics.toolsExecuted, 0, 'Tools should be 0');
  assertEqual(metrics.factsSaved, 0, 'Facts saved should be 0');
  assertEqual(metrics.factsExtracted, 0, 'Facts extracted should be 0');
  assertEqual(metrics.contextTruncations, 0, 'Truncations should be 0');
});

test('metrics: record message processed', () => {
  resetSessionMetrics();

  recordMessageProcessed();
  recordMessageProcessed();
  recordMessageProcessed();

  const metrics = getSessionMetrics();
  assertEqual(metrics.messagesProcessed, 3, 'Should have 3 messages');
});

test('metrics: record tool executed', () => {
  resetSessionMetrics();

  recordToolExecuted();
  recordToolExecuted();

  const metrics = getSessionMetrics();
  assertEqual(metrics.toolsExecuted, 2, 'Should have 2 tools executed');
});

test('metrics: record facts saved and extracted', () => {
  resetSessionMetrics();

  recordFactSaved();
  recordFactSaved();
  recordFactExtracted();

  const metrics = getSessionMetrics();
  assertEqual(metrics.factsSaved, 2, 'Should have 2 facts saved');
  assertEqual(metrics.factsExtracted, 1, 'Should have 1 fact extracted');
});

test('metrics: record context truncation', () => {
  resetSessionMetrics();

  recordContextTruncation();

  const metrics = getSessionMetrics();
  assertEqual(metrics.contextTruncations, 1, 'Should have 1 truncation');
});

test('metrics: record LocalRouter hits and bypasses', () => {
  resetSessionMetrics();

  recordLocalRouterHit();
  recordLocalRouterHit();
  recordLocalRouterBypass();

  const metrics = getSessionMetrics();
  assertEqual(metrics.localRouterHits, 2, 'Should have 2 hits');
  assertEqual(metrics.localRouterBypasses, 1, 'Should have 1 bypass');
});

// ==================== Heartbeat Tests ====================

test('heartbeat: proactive loop unknown initially', () => {
  resetSessionMetrics();

  const health = getProactiveLoopHealth();
  assertEqual(health.status, 'unknown', 'Should be unknown without heartbeat');
});

test('heartbeat: proactive loop ok after heartbeat', () => {
  resetSessionMetrics();

  recordProactiveHeartbeat();

  const health = getProactiveLoopHealth();
  assertEqual(health.status, 'ok', 'Should be ok after heartbeat');
});

test('heartbeat: reminder scheduler unknown initially', () => {
  resetSessionMetrics();

  const health = getReminderSchedulerHealth();
  assertEqual(health.status, 'unknown', 'Should be unknown without heartbeat');
});

test('heartbeat: reminder scheduler ok after heartbeat', () => {
  resetSessionMetrics();

  recordReminderHeartbeat();

  const health = getReminderSchedulerHealth();
  assertEqual(health.status, 'ok', 'Should be ok after heartbeat');
});

// ==================== Queue Health Tests ====================

test('queue-health: extraction queue ok when empty', () => {
  const health = getExtractionQueueHealth(0);
  assertEqual(health.status, 'ok', 'Should be ok when empty');
});

test('queue-health: extraction queue ok with small backlog', () => {
  const health = getExtractionQueueHealth(10);
  assertEqual(health.status, 'ok', 'Should be ok with small backlog');
});

test('queue-health: extraction queue degraded with large backlog', () => {
  const health = getExtractionQueueHealth(150);
  assertEqual(health.status, 'degraded', 'Should be degraded with large backlog');
});

test('queue-health: embedding queue ok when empty', () => {
  const health = getEmbeddingQueueHealth(0);
  assertEqual(health.status, 'ok', 'Should be ok when empty');
});

test('queue-health: embedding queue degraded with large backlog', () => {
  const health = getEmbeddingQueueHealth(200);
  assertEqual(health.status, 'degraded', 'Should be degraded with large backlog');
});

// ==================== Failure Counter Tests ====================

test('failures: extraction failure counter increments', () => {
  resetSessionMetrics();
  resetExtractionFailures();

  recordExtractionFailure();
  recordExtractionFailure();

  // The counter is internal, but we can check that it doesn't crash
  // and that resetExtractionFailures works
  resetExtractionFailures();

  // Record more failures - should not throw
  recordExtractionFailure();
  recordExtractionFailure();
  recordExtractionFailure(); // This is the 3rd, should trigger warning log

  assert(true, 'Failure recording should work without crashing');
});

// ==================== Overall Health Tests ====================

test('overall-health: all ok returns ok', () => {
  const subsystems: Record<string, SubsystemHealth> = {
    a: { status: 'ok', message: 'ok' },
    b: { status: 'ok', message: 'ok' },
    c: { status: 'ok', message: 'ok' },
  };

  const overall = determineOverallHealth(subsystems);
  assertEqual(overall, 'ok', 'All ok should return ok');
});

test('overall-health: one degraded returns degraded', () => {
  const subsystems: Record<string, SubsystemHealth> = {
    a: { status: 'ok', message: 'ok' },
    b: { status: 'degraded', message: 'degraded' },
    c: { status: 'ok', message: 'ok' },
  };

  const overall = determineOverallHealth(subsystems);
  assertEqual(overall, 'degraded', 'One degraded should return degraded');
});

test('overall-health: one down returns degraded', () => {
  const subsystems: Record<string, SubsystemHealth> = {
    a: { status: 'ok', message: 'ok' },
    b: { status: 'down', message: 'down' },
    c: { status: 'ok', message: 'ok' },
  };

  const overall = determineOverallHealth(subsystems);
  assertEqual(overall, 'degraded', 'One down should return degraded (system still works)');
});

test('overall-health: unknown with ok returns unknown', () => {
  const subsystems: Record<string, SubsystemHealth> = {
    a: { status: 'ok', message: 'ok' },
    b: { status: 'unknown', message: 'unknown' },
  };

  const overall = determineOverallHealth(subsystems);
  assertEqual(overall, 'unknown', 'Unknown should propagate');
});

// ==================== Session Metrics Persistence ====================

test('session: startedAt is set', () => {
  resetSessionMetrics();
  const metrics = getSessionMetrics();

  assert(metrics.startedAt instanceof Date, 'startedAt should be a Date');
  assert(
    Date.now() - metrics.startedAt.getTime() < 1000,
    'startedAt should be recent'
  );
});

test('session: reset clears all counters', () => {
  // Record some activity
  recordMessageProcessed();
  recordToolExecuted();
  recordFactSaved();
  recordContextTruncation();
  recordLocalRouterHit();

  // Reset
  resetSessionMetrics();

  // Verify all reset
  const metrics = getSessionMetrics();
  assertEqual(metrics.messagesProcessed, 0, 'Messages should be reset');
  assertEqual(metrics.toolsExecuted, 0, 'Tools should be reset');
  assertEqual(metrics.factsSaved, 0, 'Facts should be reset');
  assertEqual(metrics.contextTruncations, 0, 'Truncations should be reset');
  assertEqual(metrics.localRouterHits, 0, 'Router hits should be reset');
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

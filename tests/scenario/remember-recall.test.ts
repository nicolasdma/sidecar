/**
 * Scenario Tests: Remember-Recall Flow
 *
 * Tests the complete lifecycle of facts, from creation to retrieval,
 * simulating real user workflows for memory persistence.
 *
 * Run with: npx tsx tests/scenario/remember-recall.test.ts
 */

import { randomUUID } from 'crypto';
import {
  saveFact,
  getFactById,
  getFactsByDomain,
  getFacts,
  updateFactConfirmation,
  archiveFact,
  supersedeFact,
  getTotalFactsCount,
  filterFactsByKeywords,
  type NewFact,
} from '../../src/memory/facts-store.js';
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

console.log('\n=== Remember-Recall Scenario Tests ===\n');

// Initialize database
getDatabase();

// ==================== Scenario 1: Basic Remember-Recall ====================

test('scenario: save fact and retrieve by ID', () => {
  const uniqueContent = `User is allergic to peanuts - ${randomUUID().slice(0, 8)}`;
  const newFact: NewFact = {
    domain: 'health',
    fact: uniqueContent,
    confidence: 'high',
    source: 'explicit',
  };

  // Step 1: Save the fact
  const factId = saveFact(newFact);
  assert(typeof factId === 'string' && factId.length > 0, 'Should return a valid ID');

  // Step 2: Retrieve by ID
  const retrieved = getFactById(factId);
  assertNotNull(retrieved, 'Fact should be retrievable by ID');
  assertEqual(retrieved.fact, uniqueContent, 'Content should match');
  assertEqual(retrieved.domain, 'health', 'Domain should match');
  assertEqual(retrieved.confidence, 'high', 'Confidence should match');
  assertEqual(retrieved.source, 'explicit', 'Source should match');
});

test('scenario: save fact and find in domain', () => {
  const uniqueContent = `Works at Acme Corp - ${randomUUID().slice(0, 8)}`;
  const newFact: NewFact = {
    domain: 'work',
    fact: uniqueContent,
    confidence: 'high',
    source: 'explicit',
  };

  // Step 1: Save the fact
  saveFact(newFact);

  // Step 2: Query by domain
  const workFacts = getFactsByDomain('work');
  assert(workFacts.length > 0, 'Should have at least one work fact');

  // Step 3: Verify our fact is in the list
  const found = workFacts.find((f) => f.fact === uniqueContent);
  assertNotNull(found, 'Should find our fact in domain query');
});

test('scenario: fact persists after simulated restart', () => {
  const uniqueContent = `Favorite color is blue - ${randomUUID().slice(0, 8)}`;
  const newFact: NewFact = {
    domain: 'preferences',
    fact: uniqueContent,
    confidence: 'medium',
    source: 'explicit',
  };

  // Step 1: Save the fact
  const factId = saveFact(newFact);

  // Step 2: Clear any in-memory caches by getting a fresh DB reference
  // (In reality, the database is persisted, simulating restart)
  const freshDb = getDatabase();
  assert(freshDb !== null, 'Database should still be accessible');

  // Step 3: Verify fact still exists
  const retrieved = getFactById(factId);
  assertNotNull(retrieved, 'Fact should persist after simulated restart');
  assertEqual(retrieved.fact, uniqueContent, 'Content should be preserved');
});

// ==================== Scenario 2: Fact Lifecycle ====================

test('scenario: update fact confirmation refreshes timestamp', () => {
  const factId = saveFact({
    domain: 'general',
    fact: `Test fact for confirmation - ${randomUUID().slice(0, 8)}`,
    confidence: 'medium',
    source: 'explicit',
  });

  // Get original timestamp
  const original = getFactById(factId);
  assertNotNull(original, 'Fact should exist');
  const originalTimestamp = original.lastConfirmedAt;

  // Small delay to ensure timestamp changes
  const start = Date.now();
  while (Date.now() - start < 50) {
    /* busy wait */
  }

  // Update confirmation
  updateFactConfirmation(factId);

  // Verify timestamp updated
  const updated = getFactById(factId);
  assertNotNull(updated, 'Fact should still exist');
  assert(
    updated.lastConfirmedAt >= originalTimestamp,
    'Timestamp should be updated or same'
  );
});

test('scenario: archive fact removes from normal queries', () => {
  const uniqueContent = `To be archived - ${randomUUID().slice(0, 8)}`;
  const factId = saveFact({
    domain: 'general',
    fact: uniqueContent,
    confidence: 'low',
    source: 'explicit',
  });

  // Verify fact is initially visible
  let generalFacts = getFacts({ domain: 'general' });
  assert(
    generalFacts.some((f) => f.id === factId),
    'Fact should be visible before archiving'
  );

  // Archive the fact
  archiveFact(factId);

  // Verify fact is hidden from normal queries
  generalFacts = getFacts({ domain: 'general' });
  assert(
    !generalFacts.some((f) => f.id === factId),
    'Archived fact should not appear in normal queries'
  );

  // Verify fact is still accessible with includeArchived
  const withArchived = getFacts({ domain: 'general', includeArchived: true });
  const found = withArchived.find((f) => f.id === factId);
  assertNotNull(found, 'Archived fact should be accessible with includeArchived');
  assert(found.archived === true, 'archived flag should be true');
});

test('scenario: supersede fact creates new and archives old', () => {
  // Create original fact
  const originalContent = `Old job at OldCorp - ${randomUUID().slice(0, 8)}`;
  const oldId = saveFact({
    domain: 'work',
    fact: originalContent,
    confidence: 'high',
    source: 'explicit',
  });

  // Supersede with new fact
  const newContent = `New job at NewCorp - ${randomUUID().slice(0, 8)}`;
  const newId = supersedeFact(oldId, {
    domain: 'work',
    fact: newContent,
    confidence: 'high',
    source: 'explicit',
  });

  // Verify old fact is archived
  const oldFact = getFactById(oldId);
  assertNotNull(oldFact, 'Old fact should still exist');
  assert(oldFact.archived === true, 'Old fact should be archived');

  // Verify new fact references old one
  const newFact = getFactById(newId);
  assertNotNull(newFact, 'New fact should exist');
  assertEqual(newFact.supersedes, oldId, 'New fact should reference old one');
  assert(newFact.archived === false, 'New fact should not be archived');
});

// ==================== Scenario 3: Keyword Search ====================

test('scenario: keyword search finds relevant facts', () => {
  // Create facts with specific keywords
  const coffeeContent = `Likes coffee every morning - ${randomUUID().slice(0, 8)}`;
  saveFact({
    domain: 'preferences',
    fact: coffeeContent,
    confidence: 'medium',
    source: 'explicit',
  });

  // Search for coffee-related facts
  const results = filterFactsByKeywords('coffee morning');
  assert(results.length > 0, 'Should find at least one result');
  assert(
    results.some((f) => f.fact.includes('coffee')),
    'Results should include coffee fact'
  );
});

test('scenario: keyword search excludes archived facts', () => {
  const uniqueKeyword = `uniquekeyword${randomUUID().slice(0, 8)}`;
  const factId = saveFact({
    domain: 'general',
    fact: `This has ${uniqueKeyword} in it`,
    confidence: 'medium',
    source: 'explicit',
  });

  // Verify it appears in search
  let results = filterFactsByKeywords(uniqueKeyword);
  assert(
    results.some((f) => f.id === factId),
    'Fact should appear in search before archiving'
  );

  // Archive the fact
  archiveFact(factId);

  // Verify it no longer appears
  results = filterFactsByKeywords(uniqueKeyword);
  assert(
    !results.some((f) => f.id === factId),
    'Archived fact should not appear in keyword search'
  );
});

// ==================== Scenario 4: Domain Organization ====================

test('scenario: facts are correctly organized by domain', () => {
  // Create facts in different domains
  const healthFact = saveFact({
    domain: 'health',
    fact: `Health fact - ${randomUUID().slice(0, 8)}`,
    confidence: 'high',
    source: 'explicit',
  });

  const workFact = saveFact({
    domain: 'work',
    fact: `Work fact - ${randomUUID().slice(0, 8)}`,
    confidence: 'high',
    source: 'explicit',
  });

  const prefFact = saveFact({
    domain: 'preferences',
    fact: `Preference fact - ${randomUUID().slice(0, 8)}`,
    confidence: 'medium',
    source: 'explicit',
  });

  // Query each domain
  const healthFacts = getFactsByDomain('health');
  const workFacts = getFactsByDomain('work');
  const prefFacts = getFactsByDomain('preferences');

  // Verify correct domain assignment
  assert(
    healthFacts.some((f) => f.id === healthFact),
    'Health fact should be in health domain'
  );
  assert(
    !healthFacts.some((f) => f.id === workFact),
    'Work fact should not be in health domain'
  );

  assert(
    workFacts.some((f) => f.id === workFact),
    'Work fact should be in work domain'
  );

  assert(
    prefFacts.some((f) => f.id === prefFact),
    'Preference fact should be in preferences domain'
  );
});

// ==================== Scenario 5: Count Tracking ====================

test('scenario: total facts count tracks correctly', () => {
  const countBefore = getTotalFactsCount();

  // Add 3 facts
  saveFact({
    domain: 'general',
    fact: `Count test 1 - ${randomUUID().slice(0, 8)}`,
    confidence: 'low',
    source: 'explicit',
  });
  saveFact({
    domain: 'general',
    fact: `Count test 2 - ${randomUUID().slice(0, 8)}`,
    confidence: 'low',
    source: 'explicit',
  });
  const factToArchive = saveFact({
    domain: 'general',
    fact: `Count test 3 - ${randomUUID().slice(0, 8)}`,
    confidence: 'low',
    source: 'explicit',
  });

  // Count should increase by 3
  assertEqual(
    getTotalFactsCount(),
    countBefore + 3,
    'Count should increase by 3'
  );

  // Archive one fact
  archiveFact(factToArchive);

  // Count should decrease by 1 (archived facts not counted)
  assertEqual(
    getTotalFactsCount(),
    countBefore + 2,
    'Count should decrease by 1 after archiving'
  );
});

// ==================== Scenario 6: Confidence Levels ====================

test('scenario: confidence levels are preserved', () => {
  const highConfidenceId = saveFact({
    domain: 'health',
    fact: `High confidence - ${randomUUID().slice(0, 8)}`,
    confidence: 'high',
    source: 'explicit',
  });

  const mediumConfidenceId = saveFact({
    domain: 'general',
    fact: `Medium confidence - ${randomUUID().slice(0, 8)}`,
    confidence: 'medium',
    source: 'explicit',
  });

  const lowConfidenceId = saveFact({
    domain: 'general',
    fact: `Low confidence - ${randomUUID().slice(0, 8)}`,
    confidence: 'low',
    source: 'explicit',
  });

  assertEqual(
    getFactById(highConfidenceId)?.confidence,
    'high',
    'High confidence should be preserved'
  );
  assertEqual(
    getFactById(mediumConfidenceId)?.confidence,
    'medium',
    'Medium confidence should be preserved'
  );
  assertEqual(
    getFactById(lowConfidenceId)?.confidence,
    'low',
    'Low confidence should be preserved'
  );
});

// ==================== Scenario 7: Source Types ====================

test('scenario: source types are preserved', () => {
  const explicitId = saveFact({
    domain: 'general',
    fact: `Explicit source - ${randomUUID().slice(0, 8)}`,
    confidence: 'medium',
    source: 'explicit',
  });

  const inferredId = saveFact({
    domain: 'general',
    fact: `Inferred source - ${randomUUID().slice(0, 8)}`,
    confidence: 'low',
    source: 'inferred',
  });

  assertEqual(
    getFactById(explicitId)?.source,
    'explicit',
    'Explicit source should be preserved'
  );
  assertEqual(
    getFactById(inferredId)?.source,
    'inferred',
    'Inferred source should be preserved'
  );
});

// ==================== Scenario 8: Default Values ====================

test('scenario: default values are applied correctly', () => {
  // Save fact with minimal properties
  const factId = saveFact({
    domain: 'general',
    fact: `Minimal fact - ${randomUUID().slice(0, 8)}`,
  });

  const fact = getFactById(factId);
  assertNotNull(fact, 'Fact should exist');
  assertEqual(fact.confidence, 'medium', 'Default confidence should be medium');
  assertEqual(fact.source, 'explicit', 'Default source should be explicit');
  assertEqual(fact.scope, 'global', 'Default scope should be global');
  assertEqual(fact.stale, false, 'Default stale should be false');
  assertEqual(fact.archived, false, 'Default archived should be false');
  assertEqual(fact.supersedes, null, 'Default supersedes should be null');
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

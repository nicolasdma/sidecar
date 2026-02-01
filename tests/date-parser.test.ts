/**
 * TDD Tests for date-parser.ts
 * Written BEFORE implementation per FASE 3 pre-requisites.
 *
 * Run with: npx tsx tests/date-parser.test.ts
 *
 * These tests define the expected behavior based on PLAN.md specification.
 */

import {
  parseDateTime,
  type DateParseResult,
} from '../src/agent/proactive/date-parser.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(`  ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertDateEqual(actual: Date | undefined, expected: Date, message?: string): void {
  if (!actual) throw new Error(message || 'Expected date but got undefined');
  // Compare to minute precision (ignore seconds/ms)
  const actualMinutes = Math.floor(actual.getTime() / 60000);
  const expectedMinutes = Math.floor(expected.getTime() / 60000);
  if (actualMinutes !== expectedMinutes) {
    throw new Error(
      message ||
        `Expected ${expected.toISOString()}, got ${actual.toISOString()}`
    );
  }
}

// Helper to create a fixed "now" for testing
function createTestNow(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

// Default timezone for tests
const TEST_TIMEZONE = 'America/Argentina/Buenos_Aires';

// ==================== ISO 8601 Tests ====================

console.log('\n=== ISO 8601 Format ===');

test('ISO 8601: valid datetime', () => {
  const result = parseDateTime('2026-02-01T15:00', TEST_TIMEZONE);
  assert(result.success, 'Should parse successfully');
  assert(result.datetime !== undefined, 'Should have datetime');
  // Note: The actual date check depends on timezone handling
});

test('ISO 8601: with seconds', () => {
  const result = parseDateTime('2026-02-01T15:00:00', TEST_TIMEZONE);
  assert(result.success, 'Should parse ISO with seconds');
});

test('ISO 8601: invalid format', () => {
  const result = parseDateTime('2026-02-01 15:00', TEST_TIMEZONE);
  // This might be supported or not - depends on implementation decision
});

// ==================== Relative Time Tests ====================

console.log('\n=== Relative Time: "en N minutos/horas" ===');

test('en 30 minutos', () => {
  const now = createTestNow(2026, 2, 1, 14, 0); // 14:00
  const result = parseDateTime('en 30 minutos', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse "en 30 minutos"');
  const expected = createTestNow(2026, 2, 1, 14, 30); // 14:30
  assertDateEqual(result.datetime, expected);
});

test('en 1 minuto (singular)', () => {
  const now = createTestNow(2026, 2, 1, 14, 0);
  const result = parseDateTime('en 1 minuto', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse "en 1 minuto"');
  const expected = createTestNow(2026, 2, 1, 14, 1);
  assertDateEqual(result.datetime, expected);
});

test('en 2 horas', () => {
  const now = createTestNow(2026, 2, 1, 14, 0); // 14:00
  const result = parseDateTime('en 2 horas', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse "en 2 horas"');
  const expected = createTestNow(2026, 2, 1, 16, 0); // 16:00
  assertDateEqual(result.datetime, expected);
});

test('en 1 hora (singular)', () => {
  const now = createTestNow(2026, 2, 1, 14, 0);
  const result = parseDateTime('en 1 hora', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse "en 1 hora"');
  const expected = createTestNow(2026, 2, 1, 15, 0);
  assertDateEqual(result.datetime, expected);
});

test('en 1 hora y 30 minutos', () => {
  const now = createTestNow(2026, 2, 1, 14, 0); // 14:00
  const result = parseDateTime('en 1 hora y 30 minutos', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse "en 1 hora y 30 minutos"');
  const expected = createTestNow(2026, 2, 1, 15, 30); // 15:30
  assertDateEqual(result.datetime, expected);
});

test('en 2 horas y 15 minutos', () => {
  const now = createTestNow(2026, 2, 1, 14, 0);
  const result = parseDateTime('en 2 horas y 15 minutos', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse compound time');
  const expected = createTestNow(2026, 2, 1, 16, 15);
  assertDateEqual(result.datetime, expected);
});

// ==================== "mañana a las X" Tests ====================

console.log('\n=== "mañana a las X" ===');

test('mañana a las 9', () => {
  const now = createTestNow(2026, 2, 1, 14, 0); // Feb 1, 14:00
  const result = parseDateTime('mañana a las 9', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse "mañana a las 9"');
  const expected = createTestNow(2026, 2, 2, 9, 0); // Feb 2, 09:00
  assertDateEqual(result.datetime, expected);
});

test('mañana a las 9:30', () => {
  const now = createTestNow(2026, 2, 1, 14, 0);
  const result = parseDateTime('mañana a las 9:30', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse "mañana a las 9:30"');
  const expected = createTestNow(2026, 2, 2, 9, 30);
  assertDateEqual(result.datetime, expected);
});

test('mañana a las 15', () => {
  const now = createTestNow(2026, 2, 1, 14, 0);
  const result = parseDateTime('mañana a las 15', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse 24h format');
  const expected = createTestNow(2026, 2, 2, 15, 0);
  assertDateEqual(result.datetime, expected);
});

test('mañana a las 21:45', () => {
  const now = createTestNow(2026, 2, 1, 14, 0);
  const result = parseDateTime('mañana a las 21:45', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse evening time with minutes');
  const expected = createTestNow(2026, 2, 2, 21, 45);
  assertDateEqual(result.datetime, expected);
});

// ==================== "hoy a las X" Tests ====================

console.log('\n=== "hoy a las X" ===');

test('hoy a las 15 (future)', () => {
  const now = createTestNow(2026, 2, 1, 10, 0); // 10:00
  const result = parseDateTime('hoy a las 15', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse "hoy a las 15"');
  const expected = createTestNow(2026, 2, 1, 15, 0);
  assertDateEqual(result.datetime, expected);
});

test('hoy a las 9 when its 15:00 (past) - A2', () => {
  const now = createTestNow(2026, 2, 1, 15, 0); // 15:00
  const result = parseDateTime('hoy a las 9', TEST_TIMEZONE, now);
  assert(!result.success, 'Should fail for past time');
  assert(result.error !== undefined, 'Should have error message');
  assert(result.suggestion !== undefined, 'Should suggest tomorrow');
  assert(
    result.suggestion?.includes('mañana'),
    'Suggestion should mention mañana'
  );
});

test('hoy a las 15:30', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('hoy a las 15:30', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse with minutes');
  const expected = createTestNow(2026, 2, 1, 15, 30);
  assertDateEqual(result.datetime, expected);
});

// ==================== "el WEEKDAY a las X" Tests ====================

console.log('\n=== "el WEEKDAY a las X" ===');

test('el lunes a las 10 (today is Sunday)', () => {
  // Feb 1, 2026 is a Sunday
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('el lunes a las 10', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse weekday');
  const expected = createTestNow(2026, 2, 2, 10, 0); // Monday Feb 2
  assertDateEqual(result.datetime, expected);
});

test('el lunes a las 10 when today IS Monday - A1', () => {
  // Feb 2, 2026 is a Monday
  const now = createTestNow(2026, 2, 2, 10, 0);
  const result = parseDateTime('el lunes a las 10', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse to NEXT Monday');
  const expected = createTestNow(2026, 2, 9, 10, 0); // Next Monday Feb 9
  assertDateEqual(result.datetime, expected);
});

test('el viernes a las 18', () => {
  // Feb 1, 2026 is a Sunday
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('el viernes a las 18', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse Friday');
  const expected = createTestNow(2026, 2, 6, 18, 0); // Friday Feb 6
  assertDateEqual(result.datetime, expected);
});

test('el martes a las 9:30', () => {
  // Feb 1, 2026 is a Sunday
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('el martes a las 9:30', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse with minutes');
  const expected = createTestNow(2026, 2, 3, 9, 30); // Tuesday Feb 3
  assertDateEqual(result.datetime, expected);
});

test('el domingo a las 12 when today is Sunday', () => {
  // Feb 1, 2026 is a Sunday
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('el domingo a las 12', TEST_TIMEZONE, now);
  assert(result.success, 'Should parse to NEXT Sunday');
  const expected = createTestNow(2026, 2, 8, 12, 0); // Next Sunday Feb 8
  assertDateEqual(result.datetime, expected);
});

// ==================== NOT SUPPORTED - Should Error ====================

console.log('\n=== NOT SUPPORTED (should error) ===');

test('a las 3 (sin día) - AMBIGUOUS', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('a las 3', TEST_TIMEZONE, now);
  assert(!result.success, 'Should fail for ambiguous time without day');
  assert(result.error !== undefined, 'Should have error');
  assert(result.suggestion !== undefined, 'Should have suggestion');
});

test('en un rato - TOO VAGUE', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('en un rato', TEST_TIMEZONE, now);
  assert(!result.success, 'Should fail for vague time');
  assert(result.error !== undefined, 'Should have error');
});

test('la semana que viene - NO TIME', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('la semana que viene', TEST_TIMEZONE, now);
  assert(!result.success, 'Should fail without specific time');
});

test('el próximo martes - NO TIME', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('el próximo martes', TEST_TIMEZONE, now);
  assert(!result.success, 'Should fail without hour');
  assert(result.suggestion !== undefined, 'Should suggest adding time');
});

test('pasado mañana - AMBIGUOUS', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('pasado mañana', TEST_TIMEZONE, now);
  assert(!result.success, 'Should fail for ambiguous');
});

test('empty string', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('', TEST_TIMEZONE, now);
  assert(!result.success, 'Should fail for empty input');
});

test('random text', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('recordame algo', TEST_TIMEZONE, now);
  assert(!result.success, 'Should fail for non-time text');
});

// ==================== Edge Cases ====================

console.log('\n=== Edge Cases ===');

test('midnight crossing with "en X horas"', () => {
  const now = createTestNow(2026, 2, 1, 23, 0); // 23:00
  const result = parseDateTime('en 3 horas', TEST_TIMEZONE, now);
  assert(result.success, 'Should handle midnight crossing');
  const expected = createTestNow(2026, 2, 2, 2, 0); // 02:00 next day
  assertDateEqual(result.datetime, expected);
});

test('mañana near midnight', () => {
  const now = createTestNow(2026, 2, 1, 23, 59); // 23:59
  const result = parseDateTime('mañana a las 9', TEST_TIMEZONE, now);
  assert(result.success, 'Should handle near-midnight correctly');
  const expected = createTestNow(2026, 2, 2, 9, 0);
  assertDateEqual(result.datetime, expected);
});

test('case insensitive - MAÑANA A LAS 9', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('MAÑANA A LAS 9', TEST_TIMEZONE, now);
  assert(result.success, 'Should be case insensitive');
});

test('extra whitespace', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('  en  30  minutos  ', TEST_TIMEZONE, now);
  assert(result.success, 'Should handle extra whitespace');
});

test('hoy a las 15 at exactly 15:00 (edge)', () => {
  const now = createTestNow(2026, 2, 1, 15, 0); // Exactly 15:00
  const result = parseDateTime('hoy a las 15', TEST_TIMEZONE, now);
  // At exactly the time, it's technically "now" which is valid
  // Implementation decision: accept or reject?
  // Per A2, past time should error, but exact time is ambiguous
  // Let's say exact time is allowed (it's not past yet)
  assert(result.success, 'Exact current time should be allowed');
});

test('hoy a las 15 at 15:01 (just past)', () => {
  const now = createTestNow(2026, 2, 1, 15, 1); // 15:01
  const result = parseDateTime('hoy a las 15', TEST_TIMEZONE, now);
  assert(!result.success, 'Just past time should error');
});

// ==================== Hour Disambiguation ====================

console.log('\n=== Hour Disambiguation ===');

test('hour 1-11 interpreted as PM if reasonable', () => {
  // This test documents expected behavior for ambiguous hours
  // "hoy a las 3" without AM/PM
  // Per spec: 1-11 → PM if future, but "a las 3" sin día is ERROR
  // So this case should error due to missing day, not hour ambiguity
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('a las 3', TEST_TIMEZONE, now);
  assert(!result.success, 'Without day should error');
});

test('24h format unambiguous: hoy a las 15', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('hoy a las 15', TEST_TIMEZONE, now);
  assert(result.success, '24h format should be clear');
  const expected = createTestNow(2026, 2, 1, 15, 0);
  assertDateEqual(result.datetime, expected);
});

test('24h format: hoy a las 3 (3am)', () => {
  // If user says "hoy a las 3" and it's 10am, 3 could mean 3am (past) or 3pm (future)
  // Per spec: hours 1-11 → PM if future
  // So "hoy a las 3" at 10am should be 15:00
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('hoy a las 3', TEST_TIMEZONE, now);
  assert(result.success, 'Should interpret 3 as 15:00');
  const expected = createTestNow(2026, 2, 1, 15, 0);
  assertDateEqual(result.datetime, expected);
});

// ==================== Timezone Validation ====================

console.log('\n=== Timezone Handling ===');

test('invalid timezone should error', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('en 30 minutos', 'Invalid/Timezone', now);
  assert(!result.success, 'Invalid timezone should error');
  assert(result.error?.includes('timezone'), 'Error should mention timezone');
});

test('valid IANA timezone', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('en 30 minutos', 'America/New_York', now);
  assert(result.success, 'Valid timezone should work');
});

// ==================== Result Format ====================

console.log('\n=== Result Format ===');

test('successful result has all fields', () => {
  const now = createTestNow(2026, 2, 1, 10, 0);
  const result = parseDateTime('en 30 minutos', TEST_TIMEZONE, now);
  assert(result.success === true, 'Should have success=true');
  assert(result.datetime instanceof Date, 'Should have Date object');
  assert(result.error === undefined, 'Should not have error');
});

test('error result has required fields', () => {
  const now = createTestNow(2026, 2, 1, 15, 0);
  const result = parseDateTime('hoy a las 9', TEST_TIMEZONE, now);
  assert(result.success === false, 'Should have success=false');
  assert(result.datetime === undefined, 'Should not have datetime');
  assert(typeof result.error === 'string', 'Should have error string');
});

// ==================== Summary ====================

console.log('\n========================================');
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}

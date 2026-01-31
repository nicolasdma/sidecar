/**
 * Tests para fact-parser.ts
 * Ejecutar con: npx tsx tests/fact-parser.test.ts
 */

import {
  parseFact,
  parseLearningsFile,
  formatFact,
  createFact,
  recencyFactor,
  calculateScore,
  daysSince,
  type Fact,
} from '../src/memory/fact-parser.js';

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

// ==================== parseFact tests ====================

test('parseFact: formato válido básico', () => {
  const line = '- [weight:1] Es alérgico al maní | learned:2026-01-10 | confirmed:2026-01-28';
  const fact = parseFact(line);
  assert(fact !== null, 'Debería parsear');
  assertEqual(fact!.weight, 1);
  assertEqual(fact!.text, 'Es alérgico al maní');
  assertEqual(fact!.learned, '2026-01-10');
  assertEqual(fact!.confirmed, '2026-01-28');
});

test('parseFact: weight alto (10)', () => {
  const line = '- [weight:10] Fact importante | learned:2026-01-01 | confirmed:2026-01-31';
  const fact = parseFact(line);
  assert(fact !== null, 'Debería parsear');
  assertEqual(fact!.weight, 10);
});

test('parseFact: sin guión inicial', () => {
  const line = '[weight:1] Fact sin guión | learned:2026-01-01 | confirmed:2026-01-01';
  const fact = parseFact(line);
  assert(fact !== null, 'Debería parsear sin guión');
});

test('parseFact: weight inválido (0)', () => {
  const line = '- [weight:0] Fact inválido | learned:2026-01-01 | confirmed:2026-01-01';
  const fact = parseFact(line);
  assert(fact === null, 'Weight 0 debería ser inválido');
});

test('parseFact: weight inválido (11)', () => {
  const line = '- [weight:11] Fact inválido | learned:2026-01-01 | confirmed:2026-01-01';
  const fact = parseFact(line);
  assert(fact === null, 'Weight 11 debería ser inválido');
});

test('parseFact: fecha inválida (formato malo)', () => {
  const line = '- [weight:1] Fact | learned:2026/01/01 | confirmed:2026-01-01';
  const fact = parseFact(line);
  assert(fact === null, 'Fecha con / debería ser inválida');
});

test('parseFact: fecha inválida (mes 13)', () => {
  const line = '- [weight:1] Fact | learned:2026-13-01 | confirmed:2026-01-01';
  const fact = parseFact(line);
  assert(fact === null, 'Mes 13 debería ser inválido');
});

test('parseFact: texto con caracteres especiales', () => {
  const line = '- [weight:3] Prefiere café "sin azúcar" (100%) | learned:2026-01-15 | confirmed:2026-01-30';
  const fact = parseFact(line);
  assert(fact !== null, 'Debería parsear con caracteres especiales');
  assertEqual(fact!.text, 'Prefiere café "sin azúcar" (100%)');
});

test('parseFact: texto con pipe escapado no debería romper', () => {
  const line = '- [weight:1] Le gusta A y B | learned:2026-01-01 | confirmed:2026-01-01';
  const fact = parseFact(line);
  assert(fact !== null, 'Debería parsear');
  assertEqual(fact!.text, 'Le gusta A y B');
});

test('parseFact: línea vacía retorna null', () => {
  const fact = parseFact('');
  assert(fact === null, 'Línea vacía debería retornar null');
});

test('parseFact: comentario retorna null', () => {
  const fact = parseFact('# Esto es un comentario');
  assert(fact === null, 'Comentario debería retornar null');
});

test('parseFact: respeta categoría pasada', () => {
  const line = '- [weight:1] Fact | learned:2026-01-01 | confirmed:2026-01-01';
  const fact = parseFact(line, 'Health');
  assert(fact !== null, 'Debería parsear');
  assertEqual(fact!.category, 'Health');
});

// ==================== parseLearningsFile tests ====================

test('parseLearningsFile: archivo completo', () => {
  const content = `# Learnings

## Health
- [weight:5] Es alérgico al maní | learned:2026-01-10 | confirmed:2026-01-28

## Preferences
- [weight:3] Prefiere café sin azúcar | learned:2026-01-15 | confirmed:2026-01-30
- [weight:1] Le gusta el rock | learned:2026-01-20 | confirmed:2026-01-20
`;
  const result = parseLearningsFile(content);
  assertEqual(result.facts.length, 3);
  assertEqual(result.unparsed.length, 0);
  assertEqual(result.facts[0].category, 'Health');
  assertEqual(result.facts[1].category, 'Preferences');
  assertEqual(result.facts[2].category, 'Preferences');
});

test('parseLearningsFile: línea con formato malo va a unparsed', () => {
  const content = `## General
- [weight:1] Fact válido | learned:2026-01-01 | confirmed:2026-01-01
- Esto no tiene el formato correcto
- [weight:abc] Tampoco válido | learned:2026-01-01 | confirmed:2026-01-01
`;
  const result = parseLearningsFile(content);
  assertEqual(result.facts.length, 1);
  assertEqual(result.unparsed.length, 2);
  assert(result.warnings.length >= 2, 'Debería tener warnings');
});

test('parseLearningsFile: categoría desconocida usa General', () => {
  const content = `## CategoríaInventada
- [weight:1] Fact | learned:2026-01-01 | confirmed:2026-01-01
`;
  const result = parseLearningsFile(content);
  assertEqual(result.facts.length, 1);
  assertEqual(result.facts[0].category, 'General');
  assert(result.warnings.length >= 1, 'Debería tener warning de categoría');
});

// ==================== formatFact tests ====================

test('formatFact: formato correcto', () => {
  const fact: Fact = {
    weight: 3,
    text: 'Prefiere café sin azúcar',
    learned: '2026-01-15',
    confirmed: '2026-01-30',
    category: 'Preferences',
  };
  const formatted = formatFact(fact);
  assertEqual(formatted, '- [weight:3] Prefiere café sin azúcar | learned:2026-01-15 | confirmed:2026-01-30');
});

test('formatFact → parseFact roundtrip', () => {
  const original: Fact = {
    weight: 5,
    text: 'Texto con "comillas" y números 123',
    learned: '2026-01-10',
    confirmed: '2026-01-25',
    category: 'General',
  };
  const formatted = formatFact(original);
  const parsed = parseFact(formatted, 'General');
  assert(parsed !== null, 'Debería parsear el formato generado');
  assertEqual(parsed!.weight, original.weight);
  assertEqual(parsed!.text, original.text);
  assertEqual(parsed!.learned, original.learned);
  assertEqual(parsed!.confirmed, original.confirmed);
});

// ==================== recencyFactor tests ====================

test('recencyFactor: hoy = 1.0', () => {
  const today = new Date().toISOString().split('T')[0];
  const factor = recencyFactor(today);
  assertEqual(factor, 1.0);
});

test('recencyFactor: hace 5 días = 1.0', () => {
  const date = new Date();
  date.setDate(date.getDate() - 5);
  const dateStr = date.toISOString().split('T')[0];
  const factor = recencyFactor(dateStr);
  assertEqual(factor, 1.0);
});

test('recencyFactor: hace 15 días = 0.8', () => {
  const date = new Date();
  date.setDate(date.getDate() - 15);
  const dateStr = date.toISOString().split('T')[0];
  const factor = recencyFactor(dateStr);
  assertEqual(factor, 0.8);
});

test('recencyFactor: hace 60 días = 0.5', () => {
  const date = new Date();
  date.setDate(date.getDate() - 60);
  const dateStr = date.toISOString().split('T')[0];
  const factor = recencyFactor(dateStr);
  assertEqual(factor, 0.5);
});

test('recencyFactor: hace 100 días = 0.3', () => {
  const date = new Date();
  date.setDate(date.getDate() - 100);
  const dateStr = date.toISOString().split('T')[0];
  const factor = recencyFactor(dateStr);
  assertEqual(factor, 0.3);
});

// ==================== calculateScore tests ====================

test('calculateScore: weight * recency', () => {
  const today = new Date().toISOString().split('T')[0];
  const fact: Fact = {
    weight: 5,
    text: 'Test',
    learned: today,
    confirmed: today,
    category: 'General',
  };
  const score = calculateScore(fact);
  assertEqual(score, 5.0); // 5 * 1.0
});

test('calculateScore: fact viejo tiene score reducido', () => {
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 100);
  const fact: Fact = {
    weight: 10,
    text: 'Test viejo',
    learned: oldDate.toISOString().split('T')[0],
    confirmed: oldDate.toISOString().split('T')[0],
    category: 'General',
  };
  const score = calculateScore(fact);
  assertEqual(score, 3.0); // 10 * 0.3
});

// ==================== createFact tests ====================

test('createFact: valores por defecto', () => {
  const fact = createFact('Nuevo fact');
  const today = new Date().toISOString().split('T')[0];
  assertEqual(fact.weight, 1);
  assertEqual(fact.text, 'Nuevo fact');
  assertEqual(fact.learned, today);
  assertEqual(fact.confirmed, today);
  assertEqual(fact.category, 'General');
});

test('createFact: con categoría', () => {
  const fact = createFact('Alergia', 'Health');
  assertEqual(fact.category, 'Health');
});

// ==================== Resumen ====================

console.log('\n' + '='.repeat(50));
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}

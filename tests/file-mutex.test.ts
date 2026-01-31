/**
 * Tests para file-mutex.ts
 * Ejecutar con: npx tsx tests/file-mutex.test.ts
 */

import { fileMutex, acquireLock, withLock, isLocked } from '../src/utils/file-mutex.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ==================== Tests ====================

await test('acquire y release básico', async () => {
  const release = await acquireLock('/test/path1');
  assert(isLocked('/test/path1'), 'Debería estar locked');
  release();
  assert(!isLocked('/test/path1'), 'Debería estar unlocked');
});

await test('múltiples locks en secuencia', async () => {
  const results: number[] = [];

  const task1 = async () => {
    const release = await acquireLock('/test/path2');
    results.push(1);
    await sleep(50);
    release();
  };

  const task2 = async () => {
    await sleep(10); // Empezar un poco después
    const release = await acquireLock('/test/path2');
    results.push(2);
    release();
  };

  await Promise.all([task1(), task2()]);

  assertEqual(results[0], 1, 'Task 1 debería ejecutar primero');
  assertEqual(results[1], 2, 'Task 2 debería ejecutar segundo');
});

await test('withLock ejecuta función y libera', async () => {
  let executed = false;
  await withLock('/test/path3', async () => {
    executed = true;
    return 'result';
  });
  assert(executed, 'Función debería haberse ejecutado');
  assert(!isLocked('/test/path3'), 'Lock debería haberse liberado');
});

await test('withLock libera en caso de error', async () => {
  try {
    await withLock('/test/path4', async () => {
      throw new Error('Test error');
    });
  } catch {
    // Esperado
  }
  assert(!isLocked('/test/path4'), 'Lock debería haberse liberado después de error');
});

await test('withLock retorna valor', async () => {
  const result = await withLock('/test/path5', async () => {
    return 42;
  });
  assertEqual(result, 42, 'Debería retornar el valor de la función');
});

await test('locks en diferentes paths son independientes', async () => {
  const release1 = await acquireLock('/test/pathA');
  const release2 = await acquireLock('/test/pathB');

  assert(isLocked('/test/pathA'), 'PathA debería estar locked');
  assert(isLocked('/test/pathB'), 'PathB debería estar locked');

  release1();
  assert(!isLocked('/test/pathA'), 'PathA debería estar unlocked');
  assert(isLocked('/test/pathB'), 'PathB debería seguir locked');

  release2();
  assert(!isLocked('/test/pathB'), 'PathB debería estar unlocked');
});

await test('queueLength refleja cantidad de waiters', async () => {
  const release1 = await acquireLock('/test/path6');
  assertEqual(fileMutex.queueLength('/test/path6'), 1, 'Debería tener 1 en cola');

  // Empezar segundo acquire (quedará esperando)
  const promise2 = acquireLock('/test/path6');
  await sleep(10); // Dar tiempo a que se encole

  assertEqual(fileMutex.queueLength('/test/path6'), 2, 'Debería tener 2 en cola');

  release1();
  const release2 = await promise2;
  release2();

  assertEqual(fileMutex.queueLength('/test/path6'), 0, 'Cola debería estar vacía');
});

await test('garantiza orden FIFO', async () => {
  const order: number[] = [];

  const task = async (id: number, delayStart: number) => {
    await sleep(delayStart);
    await withLock('/test/path7', async () => {
      order.push(id);
      await sleep(20);
    });
  };

  // Lanzar 3 tasks con delays escalonados
  await Promise.all([
    task(1, 0),
    task(2, 5),
    task(3, 10),
  ]);

  assertEqual(order[0], 1, 'Task 1 primero');
  assertEqual(order[1], 2, 'Task 2 segundo');
  assertEqual(order[2], 3, 'Task 3 tercero');
});

// ==================== Resumen ====================

console.log('\n' + '='.repeat(50));
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}

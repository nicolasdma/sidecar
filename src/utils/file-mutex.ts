/**
 * Mutex simple basado en Promises para escrituras atómicas de archivos.
 * Diseñado para uso single-process (CLI local).
 *
 * Para multi-process, usar proper-lockfile en su lugar.
 */

import { createLogger } from './logger.js';

const log = createLogger('mutex');

interface LockEntry {
  promise: Promise<void>;
  resolve: () => void;
}

/**
 * Mutex para archivos.
 * Garantiza que solo una operación de escritura ocurra a la vez por path.
 */
class FileMutex {
  private locks = new Map<string, LockEntry[]>();

  /**
   * Adquiere un lock para el path dado.
   * Retorna una función release que DEBE llamarse cuando termine la operación.
   *
   * Uso:
   * ```
   * const release = await mutex.acquire('/path/to/file');
   * try {
   *   // operaciones de escritura
   * } finally {
   *   release();
   * }
   * ```
   */
  async acquire(path: string, timeoutMs: number = 30000): Promise<() => void> {
    // Crear nuevo lock entry PRIMERO (antes de esperar)
    let resolveFunc: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveFunc = resolve;
    });

    const entry: LockEntry = {
      promise,
      resolve: resolveFunc!,
    };

    // Obtener cola existente o crear nueva
    let queue = this.locks.get(path);
    if (!queue) {
      queue = [];
      this.locks.set(path, queue);
    }

    // Si hay locks anteriores, necesitamos esperar al anterior (no al último)
    const waitFor = queue.length > 0 ? queue[queue.length - 1] : null;

    // Agregar a la cola ANTES de esperar
    queue.push(entry);

    // Si hay lock anterior, esperar
    if (waitFor) {
      log.debug(`Esperando lock para ${path}`, { queueLength: queue.length });

      // Esperar con timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Lock timeout después de ${timeoutMs}ms`)), timeoutMs);
      });

      try {
        await Promise.race([waitFor.promise, timeoutPromise]);
      } catch (e) {
        // Si hay timeout, remover de la cola
        if (e instanceof Error && e.message.includes('Lock timeout')) {
          const currentQueue = this.locks.get(path);
          if (currentQueue) {
            const index = currentQueue.indexOf(entry);
            if (index > -1) {
              currentQueue.splice(index, 1);
            }
            if (currentQueue.length === 0) {
              this.locks.delete(path);
            }
          }
          log.warn(`Timeout esperando lock para ${path}`);
          throw e;
        }
      }
    }

    log.debug(`Lock adquirido para ${path}`);

    // Retornar función release
    return () => {
      entry.resolve();
      const currentQueue = this.locks.get(path);
      if (currentQueue) {
        const index = currentQueue.indexOf(entry);
        if (index > -1) {
          currentQueue.splice(index, 1);
        }
        if (currentQueue.length === 0) {
          this.locks.delete(path);
        }
      }
      log.debug(`Lock liberado para ${path}`);
    };
  }

  /**
   * Ejecuta una función con lock adquirido.
   * Garantiza que release() se llame incluso si hay error.
   */
  async withLock<T>(path: string, fn: () => Promise<T>, timeoutMs: number = 30000): Promise<T> {
    const release = await this.acquire(path, timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Verifica si hay un lock activo para el path.
   */
  isLocked(path: string): boolean {
    const queue = this.locks.get(path);
    return queue !== undefined && queue.length > 0;
  }

  /**
   * Retorna el número de locks en espera para un path.
   */
  queueLength(path: string): number {
    return this.locks.get(path)?.length || 0;
  }
}

// Singleton global
export const fileMutex = new FileMutex();

// Exports individuales para conveniencia
export const acquireLock = (path: string, timeoutMs?: number) =>
  fileMutex.acquire(path, timeoutMs);

export const withLock = <T>(path: string, fn: () => Promise<T>, timeoutMs?: number) =>
  fileMutex.withLock(path, fn, timeoutMs);

export const isLocked = (path: string) => fileMutex.isLocked(path);

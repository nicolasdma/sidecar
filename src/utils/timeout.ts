/**
 * Timeout utilities for async operations.
 *
 * Provides a wrapper to add timeout protection to any promise-based operation.
 */

/**
 * Wraps a promise with a timeout.
 * If the promise doesn't resolve within the specified time, rejects with an error.
 *
 * @param promise - The promise to wrap
 * @param ms - Timeout in milliseconds
 * @param errorMessage - Error message to use when timeout occurs
 * @returns The result of the promise if it resolves in time
 * @throws Error if the timeout is reached before the promise resolves
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  errorMessage: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, ms);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/**
 * Default timeout values for different operation types.
 */
export const TIMEOUTS = {
  /** Default timeout for tool execution (30 seconds) */
  TOOL_EXECUTION: 30_000,
  /** Timeout for network operations (60 seconds) */
  NETWORK: 60_000,
  /** Timeout for file operations (10 seconds) */
  FILE: 10_000,
} as const;

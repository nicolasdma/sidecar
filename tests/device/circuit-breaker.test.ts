/**
 * Circuit Breaker Tests - Fase 3.6a Second Round
 *
 * Tests for circuit breaker logic that prevents cascading failures.
 * No Ollama required - pure unit tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCircuitBreakerState,
  resetCircuitBreaker,
  shouldAllowRequest,
  recordSuccess,
  recordFailure,
} from '../../src/agent/local-router/local-executor.js';

describe('Circuit Breaker', () => {
  beforeEach(() => {
    // Reset to known state before each test
    resetCircuitBreaker();
  });

  describe('initial state', () => {
    it('starts in CLOSED state', () => {
      const state = getCircuitBreakerState();
      expect(state.state).toBe('CLOSED');
      expect(state.failureCount).toBe(0);
      expect(state.lastFailureTime).toBeNull();
      expect(state.successCount).toBe(0);
    });

    it('allows requests when CLOSED', () => {
      expect(shouldAllowRequest()).toBe(true);
    });
  });

  describe('failure handling', () => {
    it('increments failure count on failure', () => {
      recordFailure();
      expect(getCircuitBreakerState().failureCount).toBe(1);

      recordFailure();
      expect(getCircuitBreakerState().failureCount).toBe(2);
    });

    it('records last failure time', () => {
      const before = Date.now();
      recordFailure();
      const after = Date.now();

      const state = getCircuitBreakerState();
      expect(state.lastFailureTime).toBeGreaterThanOrEqual(before);
      expect(state.lastFailureTime).toBeLessThanOrEqual(after);
    });

    it('opens circuit after 3 consecutive failures (threshold)', () => {
      expect(getCircuitBreakerState().state).toBe('CLOSED');

      recordFailure();
      expect(getCircuitBreakerState().state).toBe('CLOSED');

      recordFailure();
      expect(getCircuitBreakerState().state).toBe('CLOSED');

      recordFailure(); // 3rd failure triggers OPEN
      expect(getCircuitBreakerState().state).toBe('OPEN');
    });

    it('blocks requests when OPEN', () => {
      // Force OPEN state
      recordFailure();
      recordFailure();
      recordFailure();

      expect(getCircuitBreakerState().state).toBe('OPEN');
      expect(shouldAllowRequest()).toBe(false);
    });
  });

  describe('success handling', () => {
    it('resets failure count on success in CLOSED state', () => {
      recordFailure();
      recordFailure();
      expect(getCircuitBreakerState().failureCount).toBe(2);

      recordSuccess();
      expect(getCircuitBreakerState().failureCount).toBe(0);
    });

    it('does not change state on success in CLOSED state', () => {
      recordSuccess();
      expect(getCircuitBreakerState().state).toBe('CLOSED');
    });
  });

  describe('half-open state', () => {
    it('transitions to HALF_OPEN after timeout', () => {
      // Open the circuit
      recordFailure();
      recordFailure();
      recordFailure();
      expect(getCircuitBreakerState().state).toBe('OPEN');

      // Mock time passing (60 seconds)
      const originalNow = Date.now;
      vi.spyOn(Date, 'now').mockReturnValue(originalNow() + 61000);

      // shouldAllowRequest should transition to HALF_OPEN
      const allowed = shouldAllowRequest();
      expect(allowed).toBe(true);
      expect(getCircuitBreakerState().state).toBe('HALF_OPEN');

      vi.restoreAllMocks();
    });

    it('stays OPEN if timeout not elapsed', () => {
      recordFailure();
      recordFailure();
      recordFailure();

      // Time hasn't passed enough
      expect(shouldAllowRequest()).toBe(false);
      expect(getCircuitBreakerState().state).toBe('OPEN');
    });

    it('allows requests in HALF_OPEN state', () => {
      // Open the circuit
      recordFailure();
      recordFailure();
      recordFailure();

      // Mock time passing
      const originalNow = Date.now;
      vi.spyOn(Date, 'now').mockReturnValue(originalNow() + 61000);
      shouldAllowRequest(); // Transition to HALF_OPEN

      expect(shouldAllowRequest()).toBe(true);

      vi.restoreAllMocks();
    });

    it('closes circuit after 2 successes in HALF_OPEN', () => {
      // Get to HALF_OPEN state
      recordFailure();
      recordFailure();
      recordFailure();

      const originalNow = Date.now;
      vi.spyOn(Date, 'now').mockReturnValue(originalNow() + 61000);
      shouldAllowRequest(); // Transition to HALF_OPEN

      expect(getCircuitBreakerState().state).toBe('HALF_OPEN');

      recordSuccess();
      expect(getCircuitBreakerState().state).toBe('HALF_OPEN');
      expect(getCircuitBreakerState().successCount).toBe(1);

      recordSuccess(); // 2nd success closes circuit
      expect(getCircuitBreakerState().state).toBe('CLOSED');
      expect(getCircuitBreakerState().failureCount).toBe(0);
      expect(getCircuitBreakerState().successCount).toBe(0);

      vi.restoreAllMocks();
    });

    it('reopens circuit on failure in HALF_OPEN', () => {
      // Get to HALF_OPEN state
      recordFailure();
      recordFailure();
      recordFailure();

      const originalNow = Date.now;
      vi.spyOn(Date, 'now').mockReturnValue(originalNow() + 61000);
      shouldAllowRequest(); // Transition to HALF_OPEN

      expect(getCircuitBreakerState().state).toBe('HALF_OPEN');

      recordFailure(); // Single failure reopens
      expect(getCircuitBreakerState().state).toBe('OPEN');

      vi.restoreAllMocks();
    });
  });

  describe('reset', () => {
    it('resets all state to initial values', () => {
      // Get into a messy state
      recordFailure();
      recordFailure();
      recordFailure();

      resetCircuitBreaker();

      const state = getCircuitBreakerState();
      expect(state.state).toBe('CLOSED');
      expect(state.failureCount).toBe(0);
      expect(state.lastFailureTime).toBeNull();
      expect(state.successCount).toBe(0);
    });
  });

  describe('state isolation', () => {
    it('getCircuitBreakerState returns a copy', () => {
      const state1 = getCircuitBreakerState();
      state1.failureCount = 999;

      const state2 = getCircuitBreakerState();
      expect(state2.failureCount).toBe(0);
    });
  });
});

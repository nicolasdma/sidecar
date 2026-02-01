# Fase 3.5: LocalRouter Bugfixes

> **Status:** Completado (Issues 2, 3, 5 + validation rule order fix + direct-executor bugfix)
> **Created:** 2026-02-01
> **Updated:** 2026-02-01
> **Priority:** HIGH - Fix before production use
> **Prerequisite:** Ollama + Qwen2.5:3b-instruct running locally

## Fixes Applied

1. **Issue 2**: Created 90 unit tests in `tests/local-router/` with full mocking
2. **Issue 3**: Implemented exponential backoff for Ollama failures (3 failures → 30s backoff, doubles up to 5min max)
3. **Issue 5**: Added `/router-stats` CLI command with comprehensive statistics display
4. **Validation rules order bug**: Reordered rules so fact_memory detection comes before incomplete reminder check
5. **Direct executor bugfix**: Fixed `cancel_reminder` returning `success: true` for invalid params (line 284 in direct-executor.ts)

---

## Executive Summary

Fase 3.5 (LocalRouter) has all infrastructure code but is **NOT production ready**:

1. Zero tests exist
2. Critical invariant violated (fallback context not passed)
3. No resilience for Ollama failures
4. Spike results (100% accuracy) are from controlled test set, not real usage

**This document specifies fixes required for real-world use.**

---

## Critical Issues (Must Fix)

### Issue 1: Fallback Context NOT Passed to Brain

**Problem:** The plan specified that when direct execution fails, Brain should receive context about the failed attempt:

```typescript
// Plan specified this:
return this.agenticLoopWithContext(options.userInput, {
  previousAttempt: {
    intent: routingResult.intent,
    error: execResult.error,
  }
});
```

**Actual code (`brain.ts:131-132`):**
```typescript
// Continue to agentic loop - the message will be saved below
// Note: We don't pass previous attempt context yet (could be added later)
```

**Impact:** Brain doesn't know a direct execution was attempted. It may retry the same tool or give confusing responses.

**Fix:**

```typescript
// brain.ts - Modify the fallback handling

// Option A: Simple - Add hint to user message
if (!execResult.success) {
  this.localRouter.recordFallback();
  logger.warn('Direct execution failed, falling back to Brain', {
    intent: routingResult.intent,
    error: execResult.error,
  });

  // Add context to the agentic loop via modified options
  // The system prompt or user message includes the failed attempt info
  const enhancedInput = options.userInput;
  // Note: We let Brain handle it naturally - the user message is unchanged
  // but we could add system context in the future
}
```

**Option B (Full Implementation):** Add `previousAttempt` to ThinkOptions and inject into system prompt:

```typescript
// types update
export interface ThinkOptions {
  userInput?: string;
  proactiveContext?: string;
  saveUserMessage?: boolean;
  // NEW: Context from failed LocalRouter attempt
  failedDirectAttempt?: {
    intent: string;
    error: string;
  };
}

// In think(), after building system prompt:
if (options.failedDirectAttempt) {
  const hint = `[Nota: Se intentó ejecutar ${options.failedDirectAttempt.intent} directamente pero falló: ${options.failedDirectAttempt.error}. Manejá el request completo.]`;
  // Prepend to workingMessages or append to system prompt
}
```

**Recommendation:** Start with Option A (document that context is not passed, accept the limitation). Implement Option B when we have data showing it causes issues.

**Files to modify:**
- `src/agent/brain.ts` - Document current behavior OR implement context passing

**Acceptance criteria:**
- [ ] Behavior is documented in code comments
- [ ] OR context is actually passed to Brain

---

### Issue 2: Zero Tests for LocalRouter

**Problem:** No tests exist for any LocalRouter component:

```
tests/local-router.test.ts        ← DOES NOT EXIST
tests/classifier.test.ts          ← DOES NOT EXIST
tests/direct-executor.test.ts     ← DOES NOT EXIST
tests/validation-rules.test.ts    ← DOES NOT EXIST
```

**Impact:** No way to verify correctness. Regressions will go undetected.

**Fix:** Create test files:

#### 2a. Classifier Tests (`tests/local-router/classifier.test.ts`)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyIntent } from '../../src/agent/local-router/classifier.js';

// Mock Ollama
vi.mock('../../src/llm/ollama.js', () => ({
  checkOllamaAvailability: vi.fn(),
  generateWithOllama: vi.fn(),
}));

describe('Intent Classifier', () => {
  describe('when Ollama unavailable', () => {
    it('returns ROUTE_TO_LLM with unknown intent', async () => {
      const { checkOllamaAvailability } = await import('../../src/llm/ollama.js');
      vi.mocked(checkOllamaAvailability).mockResolvedValue({
        available: false,
        error: 'Connection refused',
      });

      const result = await classifyIntent('qué hora es');

      expect(result.route).toBe('ROUTE_TO_LLM');
      expect(result.intent).toBe('unknown');
    });
  });

  describe('intent classification', () => {
    beforeEach(async () => {
      const { checkOllamaAvailability, generateWithOllama } = await import('../../src/llm/ollama.js');
      vi.mocked(checkOllamaAvailability).mockResolvedValue({ available: true, model: 'qwen2.5:3b-instruct' });
    });

    it('classifies time queries correctly', async () => {
      const { generateWithOllama } = await import('../../src/llm/ollama.js');
      vi.mocked(generateWithOllama).mockResolvedValue('{"intent": "time", "confidence": 0.95}');

      const result = await classifyIntent('qué hora es');

      expect(result.intent).toBe('time');
      expect(result.route).toBe('DIRECT_TOOL');
    });

    it('routes low confidence to LLM', async () => {
      const { generateWithOllama } = await import('../../src/llm/ollama.js');
      vi.mocked(generateWithOllama).mockResolvedValue('{"intent": "time", "confidence": 0.5}');

      const result = await classifyIntent('hora?');

      expect(result.route).toBe('ROUTE_TO_LLM');
    });
  });
});
```

#### 2b. Validation Rules Tests (`tests/local-router/validation-rules.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { applyValidationRules } from '../../src/agent/local-router/validation-rules.js';

describe('Validation Rules', () => {
  describe('negation handling', () => {
    it('routes "no me recuerdes" to LLM', () => {
      const result = applyValidationRules('no me recuerdes nada', 'reminder', {});
      expect(result?.route).toBe('ROUTE_TO_LLM');
      expect(result?.intent).toBe('conversation');
    });

    it('allows "no me dejes olvidar" as reminder', () => {
      const result = applyValidationRules('no me dejes olvidar llamar', 'reminder', {
        time: 'en 1 hora',
        message: 'llamar',
      });
      expect(result).toBeNull(); // No override
    });
  });

  describe('incomplete reminders', () => {
    it('rejects reminder without time', () => {
      const result = applyValidationRules('recordame algo', 'reminder', {
        message: 'algo',
      });
      expect(result?.intent).toBe('ambiguous');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('rejects reminder without message', () => {
      const result = applyValidationRules('recordame en 5 min', 'reminder', {
        time: 'en 5 min',
      });
      expect(result?.intent).toBe('ambiguous');
    });
  });

  describe('fact memory detection', () => {
    it('detects "recordame que soy" as fact_memory', () => {
      const result = applyValidationRules('recordame que soy alérgico', 'reminder', {});
      expect(result?.intent).toBe('fact_memory');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });
  });

  describe('mass actions', () => {
    it('routes "elimina todos" to LLM for confirmation', () => {
      const result = applyValidationRules('elimina todos los recordatorios', 'cancel_reminder', {});
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });
  });
});
```

#### 2c. Direct Executor Tests (`tests/local-router/direct-executor.test.ts`)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { executeIntent } from '../../src/agent/local-router/direct-executor.js';

// Mock tools
vi.mock('../../src/tools/index.js', () => ({
  executeTool: vi.fn(),
  createExecutionContext: vi.fn(() => ({ turnId: 'test-turn', toolCallCount: new Map() })),
}));

describe('Direct Executor', () => {
  it('calls executeTool for time intent', async () => {
    const { executeTool } = await import('../../src/tools/index.js');
    vi.mocked(executeTool).mockResolvedValue({
      success: true,
      data: { time: '14:30', date: 'Sábado 1 de Febrero', day: 'Sábado' },
    });

    const result = await executeIntent('time', {});

    expect(executeTool).toHaveBeenCalledWith('get_current_time', {}, expect.any(Object));
    expect(result.success).toBe(true);
    expect(result.response).toMatch(/14:30/);
  });

  it('returns error response when tool fails', async () => {
    const { executeTool } = await import('../../src/tools/index.js');
    vi.mocked(executeTool).mockResolvedValue({
      success: false,
      error: 'Network error',
    });

    const result = await executeIntent('weather', { location: 'Buenos Aires' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
```

**Files to create:**
- `tests/local-router/classifier.test.ts`
- `tests/local-router/validation-rules.test.ts`
- `tests/local-router/direct-executor.test.ts`
- `tests/local-router/response-templates.test.ts`

**Package.json update:**
```json
"scripts": {
  "test:local-router": "vitest run tests/local-router/",
  "test:local-router:watch": "vitest tests/local-router/"
}
```

**Acceptance criteria:**
- [ ] All test files created
- [ ] `npm run test:local-router` passes
- [ ] Tests cover: classification, validation rules, execution, templates
- [ ] Tests mock Ollama (don't require running instance)

---

### Issue 3: No Backoff for Ollama Failures

**Problem:** If Ollama is slow or down:
- Every request waits for timeout (~30s)
- No failure tracking
- No automatic bypass after N failures

Plan Fix #3 stated: *"si Ollama está en backoff, bypass silencioso a Brain sin penalizar"*

**NOT IMPLEMENTED.**

**Impact:** If Ollama goes down during a conversation, every message will be delayed by 30 seconds.

**Fix:**

```typescript
// Add to src/agent/local-router/index.ts

interface BackoffState {
  consecutiveFailures: number;
  backoffUntil: number | null;
  lastError: string | null;
}

const BACKOFF_THRESHOLDS = {
  failuresToTrigger: 3,       // After 3 failures, enter backoff
  initialBackoffMs: 30_000,   // 30 seconds
  maxBackoffMs: 300_000,      // 5 minutes max
  backoffMultiplier: 2,       // Double each time
};

export class LocalRouter {
  private backoffState: BackoffState = {
    consecutiveFailures: 0,
    backoffUntil: null,
    lastError: null,
  };

  private isInBackoff(): boolean {
    if (this.backoffState.backoffUntil === null) return false;
    if (Date.now() > this.backoffState.backoffUntil) {
      // Backoff expired, reset
      this.backoffState.backoffUntil = null;
      return false;
    }
    return true;
  }

  private recordFailure(error: string): void {
    this.backoffState.consecutiveFailures++;
    this.backoffState.lastError = error;

    if (this.backoffState.consecutiveFailures >= BACKOFF_THRESHOLDS.failuresToTrigger) {
      const backoffMs = Math.min(
        BACKOFF_THRESHOLDS.initialBackoffMs *
          Math.pow(BACKOFF_THRESHOLDS.backoffMultiplier, this.backoffState.consecutiveFailures - BACKOFF_THRESHOLDS.failuresToTrigger),
        BACKOFF_THRESHOLDS.maxBackoffMs
      );
      this.backoffState.backoffUntil = Date.now() + backoffMs;
      logger.warn('LocalRouter entering backoff', {
        failures: this.backoffState.consecutiveFailures,
        backoffMs,
        until: new Date(this.backoffState.backoffUntil).toISOString(),
      });
    }
  }

  private recordSuccess(): void {
    if (this.backoffState.consecutiveFailures > 0) {
      logger.info('LocalRouter recovered from failures', {
        previousFailures: this.backoffState.consecutiveFailures,
      });
    }
    this.backoffState.consecutiveFailures = 0;
    this.backoffState.backoffUntil = null;
    this.backoffState.lastError = null;
  }

  async tryRoute(userInput: string): Promise<RoutingResult> {
    // Check backoff FIRST
    if (this.isInBackoff()) {
      logger.debug('LocalRouter in backoff, bypassing to LLM', {
        until: this.backoffState.backoffUntil,
      });
      this.stats.routedToLlm++;
      return {
        route: 'ROUTE_TO_LLM',
        intent: 'unknown',
        confidence: 0,
        latencyMs: 0,
      };
    }

    // ... existing classification logic ...

    // On success:
    this.recordSuccess();

    // On failure (timeout, error):
    // this.recordFailure(error.message);
  }
}
```

**Files to modify:**
- `src/agent/local-router/index.ts` - Add backoff state and logic

**Acceptance criteria:**
- [ ] After 3 consecutive failures, LocalRouter enters backoff
- [ ] During backoff, all requests bypass to Brain immediately (0ms delay)
- [ ] Backoff expires and retries automatically
- [ ] Success resets failure counter
- [ ] Backoff state visible in stats

---

## Medium Issues (Should Fix)

### Issue 4: Ollama Model Validation May Be Incorrect

**Problem:** The validation logic may not match Ollama's actual API response format:

```typescript
// Current code (ollama.ts)
const hasModel = models.some(
  m => m.name === MEMORY_MODEL || m.name === `${MEMORY_MODEL}:latest`
);
```

If `MEMORY_MODEL = "qwen2.5:3b-instruct"`:
- `m.name === "qwen2.5:3b-instruct"` ← probably correct
- `m.name === "qwen2.5:3b-instruct:latest"` ← probably wrong (`:latest` doesn't stack)

**Fix:** Test with actual Ollama and fix format:

```bash
# Check actual format
curl http://localhost:11434/api/tags | jq '.models[].name'
```

Then update validation to match actual format.

**Files to modify:**
- `src/llm/ollama.ts` - Fix model name matching

**Acceptance criteria:**
- [ ] Validation tested against real Ollama API
- [ ] Works with `qwen2.5:3b-instruct` pulled via `ollama pull`

---

### Issue 5: No /router-stats Command

**Problem:** Stats are collected but there's no way to view them in the CLI.

**Fix:** Add CLI command:

```typescript
// In cli.ts, add command handler
if (input.trim() === '/router-stats') {
  const router = getLocalRouter();
  const stats = router.getStats();
  const config = router.getConfig();

  console.log('\n┌─────────────────────────────────────┐');
  console.log('│ LocalRouter Statistics              │');
  console.log('├─────────────────────────────────────┤');
  console.log(`│ Enabled:         ${config.enabled ? 'Yes' : 'No'}`.padEnd(38) + '│');
  console.log(`│ Total requests:  ${stats.totalRequests}`.padEnd(38) + '│');
  console.log(`│ Routed local:    ${stats.routedLocal} (${((stats.routedLocal / stats.totalRequests) * 100 || 0).toFixed(1)}%)`.padEnd(38) + '│');
  console.log(`│ Routed to LLM:   ${stats.routedToLlm}`.padEnd(38) + '│');
  console.log(`│ Direct success:  ${stats.directSuccess}`.padEnd(38) + '│');
  console.log(`│ Direct failures: ${stats.directFailures}`.padEnd(38) + '│');
  console.log(`│ Fallbacks:       ${stats.fallbacksToBrain}`.padEnd(38) + '│');
  console.log(`│ Avg latency:     ${stats.avgLocalLatencyMs.toFixed(0)}ms`.padEnd(38) + '│');
  console.log('└─────────────────────────────────────┘\n');
  return;
}
```

**Files to modify:**
- `src/interfaces/cli.ts` - Add `/router-stats` command

**Acceptance criteria:**
- [ ] `/router-stats` displays current statistics
- [ ] Shows percentage of local vs LLM routing
- [ ] Shows average latency

---

## Low Priority (Nice to Have)

### Issue 6: Integration Test with Real Ollama

**Problem:** All tests mock Ollama. No verification that real integration works.

**Fix:** Add optional integration test:

```typescript
// tests/local-router/integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';

describe('LocalRouter Integration (requires Ollama)', () => {
  beforeAll(async () => {
    if (!process.env.TEST_OLLAMA) {
      console.log('Skipping Ollama integration tests. Set TEST_OLLAMA=true to run.');
      return;
    }
  });

  it.skipIf(!process.env.TEST_OLLAMA)('classifies real time query', async () => {
    const { classifyIntent } = await import('../../src/agent/local-router/classifier.js');
    const result = await classifyIntent('qué hora es');

    expect(result.intent).toBe('time');
    expect(result.route).toBe('DIRECT_TOOL');
    expect(result.latencyMs).toBeLessThan(2000);
  });
});
```

**Acceptance criteria:**
- [ ] Integration tests exist
- [ ] Skip gracefully when Ollama not running
- [ ] Document how to run: `TEST_OLLAMA=true npm run test:local-router`

---

### Issue 7: Edge Cases Not Tested

**Problem:** Unknown behavior for:
- Concurrent requests during warm-up
- Malformed JSON from Qwen
- Partial tool execution success
- Very long user messages

**Fix:** Add edge case tests and fix any issues found.

---

## Implementation Checklist

### Critical (Must Fix Before Use)
- [ ] Issue 1: Document or implement fallback context
- [x] Issue 2: Create all test files (90 tests passing)
- [x] Issue 3: Implement backoff logic (with exponential backoff)

### Medium (Should Fix)
- [ ] Issue 4: Verify Ollama model validation
- [x] Issue 5: Add `/router-stats` command

### Low (Nice to Have)
- [ ] Issue 6: Integration tests with real Ollama
- [ ] Issue 7: Edge case testing

---

## Verification

After fixes, run:

```bash
# 1. Unit tests (no Ollama needed)
npm run test:local-router
# Expected: All pass

# 2. Manual test with Ollama
ollama serve &
npm run dev
> qué hora es
# Expected: Direct response, no Kimi call

# 3. Test backoff
# Stop Ollama, send messages, verify quick bypass

# 4. Check stats
> /router-stats
# Expected: Shows statistics
```

---

## References

- Implementation: `src/agent/local-router/`
- Plan: `plan/fase-3.5-local-router.md`
- Spike: `src/experiments/local-router-spike/`
- Strict audit: Conversation 2026-02-01

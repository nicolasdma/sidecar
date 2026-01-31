# Pre-Ship Fixes for Phase 1

> Status: Completed
> Created: 2026-01-31

---

## Fix 1: Add spinner while waiting for LLM response

**Priority:** Mandatory for Phase 1
**Reason:** Without feedback, users think the app froze during 5-10s LLM calls.

### Files to touch
- `src/interfaces/cli.ts`

### Changes required

**1. Add spinner utility at top of file:**
```typescript
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function createSpinner(message: string): { stop: () => void } {
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]} ${message}`);
  }, 80);

  return {
    stop: () => {
      clearInterval(interval);
      process.stdout.write('\r\x1b[K'); // Clear line
    }
  };
}
```

**2. Wrap the `think()` call in cli.ts:80-82:**
```typescript
// Before
const response = await think(trimmedInput);

// After
const spinner = createSpinner('Pensando...');
try {
  const response = await think(trimmedInput);
  spinner.stop();
  printResponse(response);
} catch (error) {
  spinner.stop();
  // ... error handling
}
```

### Verification
- Run app, send message, confirm spinner appears
- Confirm spinner clears when response prints

---

## Fix 2: Return explicit error to LLM on malformed tool arguments

**Priority:** Mandatory for Phase 1
**Reason:** Silent `args = {}` causes confusing tool failures and potential infinite loops.

### Files to touch
- `src/agent/brain.ts`

### Changes required

**1. Replace the catch block at brain.ts:74-80:**
```typescript
// Before
let args: Record<string, unknown>;
try {
  args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
} catch {
  logger.error('Failed to parse tool arguments', toolCall.function.arguments);
  args = {};
}

const result = await executeTool(toolCall.function.name, args);

// After
let result: ToolResult;
try {
  const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
  result = await executeTool(toolCall.function.name, args);
} catch (parseError) {
  logger.error('Failed to parse tool arguments', toolCall.function.arguments);
  result = {
    success: false,
    error: `Invalid tool arguments: expected valid JSON but got: ${toolCall.function.arguments.slice(0, 100)}`,
  };
}
```

**2. Add import for ToolResult at top of brain.ts:**
```typescript
import { getToolDefinitions, executeTool, initializeTools, type ToolResult } from '../tools/index.js';
```

**3. Update tools/index.ts to export ToolResult:**
```typescript
export type { Tool, ToolResult } from './types.js';
```

### Verification
- Manually corrupt a tool call response (mock or modify kimi.ts temporarily)
- Confirm LLM receives explicit error message instead of empty result

---

## Fix 3: Add request timeout to Kimi client

**Priority:** Mandatory for Phase 1
**Reason:** Hung connections freeze the app forever. Users must Ctrl+C.

### Files to touch
- `src/llm/kimi.ts`

### Changes required

**1. Add AbortController with timeout in makeRequest() at kimi.ts:109-118:**
```typescript
// Before
let response: Response;
try {
  response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

// After
const REQUEST_TIMEOUT_MS = 60000; // 60 seconds

let response: Response;
try {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  clearTimeout(timeoutId);
}
```

**2. Handle AbortError specifically in the catch block at kimi.ts:119-135:**
```typescript
} catch (error) {
  if (error instanceof Error && error.name === 'AbortError') {
    logger.error('Request timed out');
    throw createLLMError('Request timed out after 60 seconds', 'TIMEOUT_ERROR', undefined, true);
  }

  const networkError = error instanceof Error ? error.message : 'Unknown network error';
  // ... rest of existing retry logic
}
```

### Verification
- Temporarily set timeout to 1ms
- Confirm timeout error is thrown and logged properly
- Restore to 60000ms

---

## Fix 4: Truncate context in message-sequence units

**Priority:** Can be postponed to Phase 2
**Reason:** Edge case that only triggers with heavy tool use AND context overflow. Less likely in MVP usage patterns.

### Files to touch
- `src/agent/context-guard.ts`

### Changes required

**1. Add helper to identify message sequence boundaries:**
```typescript
interface MessageSequence {
  messages: Message[];
  tokens: number;
}

function groupIntoSequences(messages: Message[]): MessageSequence[] {
  const sequences: MessageSequence[] = [];
  let current: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && current.length > 0) {
      // User message starts a new sequence
      sequences.push({
        messages: current,
        tokens: current.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
      });
      current = [];
    }
    current.push(msg);
  }

  if (current.length > 0) {
    sequences.push({
      messages: current,
      tokens: current.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
    });
  }

  return sequences;
}
```

**2. Replace truncation logic in truncateMessages():**
```typescript
// Instead of truncating individual messages, truncate whole sequences
const sequences = groupIntoSequences(messages);
const kept: MessageSequence[] = [];
let currentTokens = 0;

for (let i = sequences.length - 1; i >= 0; i--) {
  const seq = sequences[i];
  if (!seq) continue;

  if (currentTokens + seq.tokens > availableTokens) {
    break;
  }

  kept.unshift(seq);
  currentTokens += seq.tokens;
}

const truncated = kept.flatMap(s => s.messages);
```

### Verification
- Create test with: user → assistant (with tool_calls) → tool → assistant
- Truncate and verify either all 4 messages are kept or all are dropped
- Never partial sequences

---

## Fix 5: schema.sql not found when running compiled code

**Priority:** Mandatory for Phase 1
**Reason:** Hard crash on `npm start`. Blocks any production deployment.

### Files to touch
- `src/memory/store.ts`

### Changes required

**Option A: Inline the schema (recommended for simplicity)**

Replace file read with inline SQL in `store.ts:37-39`:
```typescript
// Before
const schemaPath = join(__dirname, 'schema.sql');
const schema = readFileSync(schemaPath, 'utf-8');
db.exec(schema);

// After
const schema = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content TEXT,
    tool_calls TEXT,
    tool_call_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
`;
db.exec(schema);
```

Then delete `src/memory/schema.sql`.

**Option B: Copy schema.sql in build step**

Add to `package.json`:
```json
"scripts": {
  "build": "tsc && cp src/memory/schema.sql dist/memory/"
}
```

### Verification
- Run `npm run build && npm start`
- Confirm app starts without ENOENT error

---

## Fix 6: Empty LLM response causes silent failure

**Priority:** Mandatory for Phase 1
**Reason:** User sees blank response, no error, conversation history becomes inconsistent.

### Files to touch
- `src/agent/brain.ts`

### Changes required

**1. Check for empty response and handle explicitly at brain.ts:96-107:**
```typescript
// Before
const finalContent = response.content ?? '';

if (finalContent) {
  const assistantMessage: AssistantMessage = {
    role: 'assistant',
    content: finalContent,
  };
  saveMessage(assistantMessage);
}

logger.info(`Response generated after ${iterations} iteration(s)`);
return finalContent;

// After
const finalContent = response.content ?? '';

if (!finalContent) {
  logger.warn('LLM returned empty response', { finishReason: response.finishReason });
  const fallbackContent = 'No pude generar una respuesta. ¿Podés reformular tu pregunta?';
  const assistantMessage: AssistantMessage = {
    role: 'assistant',
    content: fallbackContent,
  };
  saveMessage(assistantMessage);
  return fallbackContent;
}

const assistantMessage: AssistantMessage = {
  role: 'assistant',
  content: finalContent,
};
saveMessage(assistantMessage);

logger.info(`Response generated after ${iterations} iteration(s)`);
return finalContent;
```

### Verification
- Mock Kimi to return `{ content: null, toolCalls: null }`
- Confirm user sees fallback message, not blank
- Confirm fallback is saved to DB

---

## Fix 7: finish_reason='length' causes truncated output

**Priority:** Mandatory for Phase 1
**Reason:** Truncated tool calls cause parse failures. Truncated text confuses users.

### Files to touch
- `src/agent/brain.ts`

### Changes required

**1. Check finish_reason after LLM response at brain.ts:60:**
```typescript
const response = await this.client.complete(systemPrompt, workingMessages, tools);

// Add this check
if (response.finishReason === 'length') {
  logger.warn('Response was truncated due to max_tokens limit');

  // If there are tool calls, they're likely malformed - don't process them
  if (response.toolCalls && response.toolCalls.length > 0) {
    const errorMessage = 'La respuesta fue cortada. Intentá con una pregunta más específica.';
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: errorMessage,
    };
    saveMessage(assistantMessage);
    return errorMessage;
  }

  // For text responses, append indicator that it was truncated
  const truncatedContent = (response.content ?? '') + '\n\n[Respuesta truncada por límite de longitud]';
  const assistantMessage: AssistantMessage = {
    role: 'assistant',
    content: truncatedContent,
  };
  saveMessage(assistantMessage);
  return truncatedContent;
}
```

### Verification
- Temporarily set `maxTokens: 50` in KimiClient
- Send a question requiring long response
- Confirm truncation indicator appears
- Restore maxTokens to 4096

---

## Summary

| Fix | Files | Priority | Effort |
|-----|-------|----------|--------|
| 1. Spinner | `cli.ts` | Mandatory | ~15 lines |
| 2. Tool arg error | `brain.ts`, `tools/index.ts` | Mandatory | ~10 lines |
| 3. Request timeout | `kimi.ts` | Mandatory | ~15 lines |
| 4. Sequence truncation | `context-guard.ts` | Phase 2 | ~40 lines |
| 5. Inline schema.sql | `store.ts` | Mandatory | ~10 lines |
| 6. Empty response fallback | `brain.ts` | Mandatory | ~15 lines |
| 7. Handle finish_reason=length | `brain.ts` | Mandatory | ~20 lines |

**Total mandatory fixes: 6 (~85 lines)**

---

## Checklist

- [x] Fix 1: Spinner in CLI
- [x] Fix 2: Explicit tool argument errors
- [x] Fix 3: Request timeout
- [ ] Fix 4: Sequence-aware truncation (Phase 2)
- [x] Fix 5: Inline schema.sql
- [x] Fix 6: Empty response fallback
- [x] Fix 7: Handle truncated responses
- [x] Verify all fixes work together
- [x] Run `npm run build && npm start` to verify compiled version works
- [x] Update PLAN.md status

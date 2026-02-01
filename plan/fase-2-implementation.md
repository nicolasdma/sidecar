# Fase 2: Memory Architecture Implementation Plan

> **Status:** Ready for implementation (Revised after architecture review)
> **Created:** 2026-02-01
> **Revised:** 2026-02-01
> **Depends on:** Fase 1 (Complete)

---

## Decisions (Finalized)

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| **Memory Agent Model** | Qwen2.5:3b-instruct via Ollama | Validated in spike, runs locally, ~0.4-1.2s latency |
| **Processing Mode** | Async background | Fire-and-forget, no impact on response latency |
| **Summary Language** | English | Token savings, user sees native language in final output |
| **Endpoint** | localhost:11434 | Standard Ollama port |

---

## Scope

Fase 2 implements four components from `memory-architecture.md`:

1. **Automatic Fact Extraction** - LLM extracts facts from user messages
2. **Structured Summaries** - Key-value JSON summaries when messages exit window
3. **Topic Shift Detection** - Heuristic detection of conversation topic changes
4. **Confidence Decay** - Gradual aging of facts based on `last_confirmed_at`

---

## Architecture

```
┌─────────────────┐
│  User Message   │
└────────┬────────┘
         ▼
┌─────────────────┐     ┌─────────────────────┐
│   brain.think() │────▶│ Extraction Service  │
└────────┬────────┘     │ (async background)  │
         │              └─────────┬───────────┘
         │                        ▼
         │              ┌─────────────────────┐
         ▼              │    MemoryAgent      │
┌─────────────────┐     │   (Ollama impl)     │
│  loadHistory(6) │     └─────────────────────┘
└────────┬────────┘              │
         ▼                       ▼
┌─────────────────────────────────────────────┐
│ truncateMessages                            │
│ 1. Detect topic shift BEFORE truncation     │
│ 2. Summarize removed messages               │
└────────┬────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│   Main LLM      │
│   (Kimi K2.5)   │
└─────────────────┘
```

---

## Critical Fixes from Architecture Review

### Fix 1: Slot Shift with Transaction (HIGH)

**Problem:** FIFO slot shift without transaction can corrupt summary data on crash.

**Solution:** Wrap all slot operations in SQLite transaction:

```typescript
async function shiftSlotsAndInsert(newSummary: Summary): Promise<void> {
  const db = getDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    // Delete slot 1
    db.prepare('DELETE FROM summaries WHERE slot = 1').run();
    // Shift all slots down
    db.prepare('UPDATE summaries SET slot = slot - 1 WHERE slot > 1').run();
    // Insert new summary at slot 4
    db.prepare(`
      INSERT INTO summaries (slot, topic, discussed, outcome, decisions, open_questions, turn_start, turn_end)
      VALUES (4, ?, ?, ?, ?, ?, ?, ?)
    `).run(newSummary.topic, ...);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

### Fix 2: Worker Recovery on Startup (HIGH)

**Problem:** If worker crashes while processing, records stay stuck in `processing` forever.

**Solution:** Reset stale processing records at startup:

```typescript
async function recoverStalledExtractions(): Promise<number> {
  const STALE_THRESHOLD_MINUTES = 5;
  const result = db.prepare(`
    UPDATE pending_extraction
    SET status = 'pending', attempts = attempts
    WHERE status = 'processing'
    AND last_attempt_at < datetime('now', '-${STALE_THRESHOLD_MINUTES} minutes')
  `).run();

  if (result.changes > 0) {
    logger.warn(`Recovered ${result.changes} stalled extractions`);
  }
  return result.changes;
}

// Call at startup before starting worker
await recoverStalledExtractions();
startExtractionWorker();
```

### Fix 3: JSON Schema Validation (MEDIUM)

**Problem:** Invalid domain from LLM crashes INSERT.

**Solution:** Validate with Zod before insert:

```typescript
import { z } from 'zod';

const ExtractedFactSchema = z.object({
  fact: z.string().min(1).max(500),
  domain: z.enum([
    'work', 'preferences', 'decisions', 'personal',
    'projects', 'health', 'relationships', 'schedule', 'goals', 'general'
  ]),
  confidence: z.enum(['high', 'medium', 'low'])
});

const ExtractedFactsArraySchema = z.array(ExtractedFactSchema);

function parseExtractedFacts(jsonString: string): ExtractedFact[] {
  try {
    const parsed = JSON.parse(jsonString);
    return ExtractedFactsArraySchema.parse(parsed);
  } catch (error) {
    logger.warn('Invalid extraction response', { error: error.message, raw: jsonString });
    return []; // Graceful degradation
  }
}
```

### Fix 4: Bounded Queue with TTL (MEDIUM)

**Problem:** Failed extractions accumulate forever.

**Solution:** Add cleanup for old failed records:

```typescript
const FAILED_TTL_DAYS = 7;
const MAX_PENDING_QUEUE = 1000;

async function cleanupExtractionQueue(): Promise<void> {
  // Delete failed records older than TTL
  db.prepare(`
    DELETE FROM pending_extraction
    WHERE status = 'failed'
    AND created_at < datetime('now', '-${FAILED_TTL_DAYS} days')
  `).run();

  // If queue is too large, delete oldest pending (emergency valve)
  const count = db.prepare('SELECT COUNT(*) as c FROM pending_extraction WHERE status = "pending"').get().c;
  if (count > MAX_PENDING_QUEUE) {
    db.prepare(`
      DELETE FROM pending_extraction
      WHERE id IN (
        SELECT id FROM pending_extraction
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT ${count - MAX_PENDING_QUEUE}
      )
    `).run();
    logger.warn(`Extraction queue overflow, dropped ${count - MAX_PENDING_QUEUE} oldest items`);
  }
}

// Run cleanup with each worker tick
```

### Fix 5: Simplify Decay Columns (MEDIUM)

**Problem:** `stale`, `aging`, `priority` are redundant overlapping states.

**Solution:** Keep only `stale` (existing), use computed logic:

```typescript
// Instead of 3 columns, compute at query time:
function getDecayStatus(lastConfirmedAt: string): { inject: boolean; relevanceThreshold: number } {
  const days = getDaysSinceConfirmed(lastConfirmedAt);

  if (days >= 120) return { inject: false, relevanceThreshold: 1.0 }; // Never inject
  if (days >= 90)  return { inject: true, relevanceThreshold: 0.7 };  // High relevance only
  if (days >= 60)  return { inject: true, relevanceThreshold: 0.3 };  // Slightly deprioritized
  return { inject: true, relevanceThreshold: 0.0 };                   // Always inject
}

// Update stale=1 for 120+ days in decay service
// Don't add aging/priority columns - compute at runtime
```

**Schema change:** Only add the index, don't add `aging` and `priority` columns.

### Fix 6: Topic Shift Order of Operations (MEDIUM)

**Problem:** Ambiguous when topic shift detection runs relative to truncation.

**Solution:** Clarify order in context-guard.ts:

```typescript
async function truncateMessages(
  messages: Message[],
  currentMessage: string,  // NEW: pass current message
  maxTokens: number
): Promise<ContextGuardResult> {

  // STEP 1: Detect topic shift BEFORE any truncation
  const topicShift = detectTopicShift(currentMessage, messages);

  // STEP 2: Calculate which messages to remove
  const { keepMessages, removeMessages } = calculateTruncation(messages, maxTokens);

  // STEP 3: If topic shift detected, include all remaining context in summarization
  const messagesToSummarize = topicShift.shifted
    ? messages  // Summarize entire context on topic shift
    : removeMessages;

  // STEP 4: Trigger summarization (async, best-effort)
  if (messagesToSummarize.length > 0) {
    summarizeMessages(messagesToSummarize).catch(err => {
      logger.warn('Summarization failed', { error: err.message });
    });
  }

  // STEP 5: Return truncated result
  return { messages: keepMessages, ... };
}
```

### Fix 7: Decay Check Async (LOW)

**Problem:** Decay check with 10k facts blocks startup.

**Solution:** Run async, paginated:

```typescript
async function runDecayCheck(): Promise<DecayResult> {
  const BATCH_SIZE = 100;
  let offset = 0;
  let totalUpdated = 0;

  while (true) {
    const facts = db.prepare(`
      SELECT id, last_confirmed_at
      FROM facts
      WHERE stale = 0
      LIMIT ? OFFSET ?
    `).all(BATCH_SIZE, offset);

    if (facts.length === 0) break;

    for (const fact of facts) {
      const days = getDaysSinceConfirmed(fact.last_confirmed_at);
      if (days >= 120) {
        db.prepare('UPDATE facts SET stale = 1 WHERE id = ?').run(fact.id);
        totalUpdated++;
      }
    }

    offset += BATCH_SIZE;
    // Yield to event loop between batches
    await new Promise(resolve => setImmediate(resolve));
  }

  return { checked: offset, updated: totalUpdated };
}
```

---

## Implementation Tasks (Revised)

### Task 1: MemoryAgent Interface + Ollama Implementation

**New files:**
- `src/llm/memory-agent.ts` (interface)
- `src/llm/ollama.ts` (implementation)

**Purpose:** Abstract memory agent transport for testability and future extensibility.

**Interface:**
```typescript
// src/llm/memory-agent.ts
export interface MemoryAgent {
  extractFacts(content: string): Promise<ExtractedFact[]>;
  summarize(messages: FormattedMessage[]): Promise<Summary>;
  isAvailable(): Promise<boolean>;
}

export interface ExtractedFact {
  fact: string;
  domain: FactDomain;
  confidence: 'high' | 'medium' | 'low';
}

export interface Summary {
  topic: string;
  discussed: string[];
  outcome: string | null;
  decisions: string[];
  openQuestions: string[];
}
```

**Ollama implementation:**
```typescript
// src/llm/ollama.ts
import { MemoryAgent, ExtractedFact, Summary } from './memory-agent';

const OLLAMA_BASE_URL = 'http://localhost:11434';
const MEMORY_MODEL = 'qwen2.5:3b-instruct';
const TIMEOUT_MS = 30000;

export class OllamaMemoryAgent implements MemoryAgent {
  private lastHealthCheck: { available: boolean; at: number } | null = null;

  async isAvailable(): Promise<boolean> {
    // Cache health check for 30 seconds
    if (this.lastHealthCheck && Date.now() - this.lastHealthCheck.at < 30000) {
      return this.lastHealthCheck.available;
    }

    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(5000)
      });
      const available = response.ok;
      this.lastHealthCheck = { available, at: Date.now() };
      return available;
    } catch {
      this.lastHealthCheck = { available: false, at: Date.now() };
      return false;
    }
  }

  async extractFacts(content: string): Promise<ExtractedFact[]> {
    if (!await this.isAvailable()) {
      throw new Error('Ollama not available');
    }
    // ... implementation with Zod validation
  }

  async summarize(messages: FormattedMessage[]): Promise<Summary> {
    if (!await this.isAvailable()) {
      throw new Error('Ollama not available');
    }
    // ... implementation with Zod validation
  }
}

// Singleton
let instance: OllamaMemoryAgent | null = null;
export function getMemoryAgent(): MemoryAgent {
  if (!instance) instance = new OllamaMemoryAgent();
  return instance;
}
```

---

### Task 2: Schema Extensions

**File:** `src/memory/store.ts`

**New tables:**

```sql
-- Buffer for pending fact extractions
CREATE TABLE IF NOT EXISTS pending_extraction (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  role TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  last_attempt_at TEXT,
  status TEXT DEFAULT 'pending',  -- pending | processing | completed | failed
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(message_id)
);

-- Index for worker queries
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_extraction(status, created_at);

-- Structured summaries (4 slots max)
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot INTEGER NOT NULL CHECK (slot >= 1 AND slot <= 4),
  topic TEXT NOT NULL,
  discussed TEXT NOT NULL,      -- JSON array
  outcome TEXT,
  decisions TEXT,               -- JSON array
  open_questions TEXT,          -- JSON array
  turn_start INTEGER NOT NULL,
  turn_end INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(slot)
);
```

**New index on facts (NO new columns):**
```sql
CREATE INDEX IF NOT EXISTS idx_facts_last_confirmed ON facts(last_confirmed_at);
```

**Note:** We do NOT add `aging` or `priority` columns. Decay status is computed at query time from `last_confirmed_at` and existing `stale` column.

---

### Task 3: Confidence Decay Service

**New file:** `src/memory/decay-service.ts`

**Purpose:** Mark facts as `stale=1` when 120+ days old. Other thresholds computed at query time.

**Decay thresholds (computed, not stored):**

| Days since confirmed | stale | Query behavior |
|---------------------|-------|----------------|
| 0-59 | 0 | Always inject |
| 60-89 | 0 | Inject, slight deprioritization |
| 90-119 | 0 | Only if query highly relevant |
| 120+ | 1 | Never inject automatically |

**API:**
```typescript
interface DecayResult {
  checked: number;
  updated: number;
  newlyStale: number;
}

export async function runDecayCheck(): Promise<DecayResult>;
export function getDaysSinceConfirmed(lastConfirmedAt: string): number;
export function getDecayStatus(lastConfirmedAt: string): { inject: boolean; relevanceThreshold: number };
```

**Processing:** Async, paginated (100 facts/tick) to avoid blocking startup.

---

### Task 4: Topic Shift Detector

**New file:** `src/memory/topic-detector.ts`

**Purpose:** Detect when conversation topic changes (heuristic, no LLM)

**Configuration file:** `data/topic-config.json` (optional, falls back to defaults)

```json
{
  "explicitPhrases": [
    "otra cosa", "cambiando de tema", "te quería preguntar sobre",
    "dejando eso de lado", "hablando de otra cosa", "por cierto",
    "now about", "speaking of", "anyway", "by the way"
  ],
  "domains": {
    "work": ["trabajo", "proyecto", "código", "deploy", "bug", "feature", "sprint", "jira"],
    "personal": ["familia", "amigos", "casa", "vida", "fin de semana"],
    "health": ["salud", "médico", "ejercicio", "dieta", "dormir", "alergia"],
    "tech": ["programar", "base de datos", "api", "servidor", "docker", "kubernetes"]
  }
}
```

**API:**
```typescript
interface TopicShiftResult {
  shifted: boolean;
  reason?: 'explicit_phrase' | 'domain_change';
  phrase?: string;
  previousDomain?: string;
  newDomain?: string;
}

export function detectTopicShift(
  currentMessage: string,
  previousMessages: Message[]
): TopicShiftResult;

export function detectDomain(text: string): string | null;
export function loadTopicConfig(): TopicConfig;
```

---

### Task 5: Fact Extraction Service

**New file:** `src/memory/extraction-service.ts`

**Purpose:** Extract facts from user messages using MemoryAgent

**Components:**

1. **Queue management:**
   - `queueForExtraction(messageId, content, role)` - Add to pending_extraction
   - `getPendingExtractions(limit)` - Get items to process (pending only)
   - `markExtractionStatus(id, status, error?)` - Update status

2. **Background worker:**
   - `startExtractionWorker()` - Start interval-based processing
   - `stopExtractionWorker()` - Stop worker
   - `processExtractionQueue()` - Process pending items
   - `recoverStalledExtractions()` - Reset stuck processing records

3. **Cleanup:**
   - `cleanupExtractionQueue()` - Remove old failed records, enforce max queue size

**Extraction prompt (handles Spanish input → English output):**
```
Extract facts about the user from this message. The message may be in any language.
Output ONLY valid JSON array in English, no explanations.

Format:
[{"fact": "fact in English", "domain": "work|preferences|decisions|personal|projects|health|relationships|schedule|goals|general", "confidence": "high|medium|low"}]

If no facts found, output: []

Look for statements about:
- Identity: job, role, company, location
- Preferences: likes, dislikes, preferred styles
- Decisions: choices made, commitments
- Personal: family, health, routines, schedules

Message:
{content}
```

**Retry logic (with internal backoff):**
```typescript
const BACKOFF_MS = [1000, 5000, 30000]; // 1s, 5s, 30s

async function processWithRetry(item: PendingExtraction): Promise<void> {
  const backoff = BACKOFF_MS[item.attempts] || BACKOFF_MS[BACKOFF_MS.length - 1];

  // Wait backoff time before this attempt
  await sleep(backoff);

  // Mark as processing
  markExtractionStatus(item.id, 'processing');

  try {
    const facts = await memoryAgent.extractFacts(item.content);
    for (const fact of facts) {
      await saveFact({ ...fact, source: 'inferred' });
    }
    markExtractionStatus(item.id, 'completed');
  } catch (error) {
    const newAttempts = item.attempts + 1;
    if (newAttempts >= 3) {
      markExtractionStatus(item.id, 'failed', error.message);
    } else {
      markExtractionStatus(item.id, 'pending'); // Will retry next tick
      updateAttemptCount(item.id, newAttempts);
    }
  }
}
```

**Worker behavior:**
- Interval: 5 seconds
- Checks `isOllamaAvailable()` before processing batch
- Runs cleanup with each tick
- Logs health warning if queue > 50 pending items

---

### Task 6: Summarization Service

**New file:** `src/memory/summarization-service.ts`

**Purpose:** Create structured summaries when messages exit window

**Trigger:** Called from `truncateMessages()` when messages are removed

**Summarization prompt:**
```
Summarize these conversation messages into structured JSON.
The messages may be in any language. Output JSON in English.
Output ONLY valid JSON, no markdown, no explanations.

Format:
{"topic": "main topic (2-3 words)", "discussed": ["point1", "point2"], "outcome": "conclusion if any or null", "decisions": ["decision made"], "open_questions": ["unresolved question"]}

Messages:
{formatted_messages}
```

**Slot management (with transaction):**
```typescript
async function saveSummary(summary: Summary, turnStart: number, turnEnd: number): Promise<void> {
  const db = getDatabase();
  const currentSlotCount = db.prepare('SELECT COUNT(*) as c FROM summaries').get().c;

  if (currentSlotCount >= 4) {
    // Need to shift - use transaction
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM summaries WHERE slot = 1').run();
      db.prepare('UPDATE summaries SET slot = slot - 1').run();
      db.prepare(`
        INSERT INTO summaries (slot, topic, discussed, outcome, decisions, open_questions, turn_start, turn_end)
        VALUES (4, ?, ?, ?, ?, ?, ?, ?)
      `).run(summary.topic, JSON.stringify(summary.discussed), summary.outcome,
             JSON.stringify(summary.decisions), JSON.stringify(summary.openQuestions),
             turnStart, turnEnd);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else {
    // Simple insert
    const newSlot = currentSlotCount + 1;
    db.prepare(`
      INSERT INTO summaries (slot, topic, discussed, outcome, decisions, open_questions, turn_start, turn_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newSlot, summary.topic, JSON.stringify(summary.discussed), summary.outcome,
           JSON.stringify(summary.decisions), JSON.stringify(summary.openQuestions),
           turnStart, turnEnd);
  }
}
```

**API (with status return):**
```typescript
interface SummarizationResult {
  success: boolean;
  slot?: number;
  error?: string;
}

export async function summarizeMessages(messages: Message[]): Promise<SummarizationResult>;
export function getActiveSummaries(): Summary[];
export function formatSummariesForPrompt(): string;
```

---

### Task 7: Integration Points

**Modify: `src/agent/brain.ts`**

After processing user message:
```typescript
import { queueForExtraction } from '../memory/extraction-service';

// In think(), after saving user message:
if (userInput && typeof userInput === 'string') {
  queueForExtraction(lastMessageId, userInput, 'user').catch(err => {
    logger.warn('Failed to queue extraction', { error: err.message });
  });
}
```

**Modify: `src/agent/context-guard.ts`**

Revised truncation flow:
```typescript
import { summarizeMessages } from '../memory/summarization-service';
import { detectTopicShift } from '../memory/topic-detector';

async function truncateMessages(
  messages: Message[],
  currentMessage: string,
  maxTokens: number
): Promise<ContextGuardResult> {

  // 1. Detect topic shift FIRST (before any truncation)
  const topicShift = detectTopicShift(currentMessage, messages);
  if (topicShift.shifted) {
    logger.info('Topic shift detected', { reason: topicShift.reason, newDomain: topicShift.newDomain });
  }

  // 2. Calculate truncation
  const { keepMessages, removeMessages } = calculateTruncation(messages, maxTokens);

  // 3. Determine what to summarize
  const messagesToSummarize = topicShift.shifted
    ? messages  // Full context on topic shift
    : removeMessages;

  // 4. Trigger summarization (async, best-effort)
  if (messagesToSummarize.length > 0) {
    summarizeMessages(messagesToSummarize)
      .then(result => {
        if (!result.success) {
          logger.warn('Summarization failed', { error: result.error });
        }
      })
      .catch(err => {
        logger.warn('Summarization threw', { error: err.message });
      });
  }

  return { messages: keepMessages, truncated: removeMessages.length > 0, ... };
}
```

**Modify: `src/memory/knowledge.ts`**

In `formatFactsForPrompt()`:
```typescript
import { formatSummariesForPrompt } from './summarization-service';
import { getDecayStatus } from './decay-service';

// Filter facts respecting decay
function filterFactsRespectingDecay(facts: Fact[], queryRelevance: number): Fact[] {
  return facts.filter(fact => {
    const decay = getDecayStatus(fact.lastConfirmedAt);
    return decay.inject && queryRelevance >= decay.relevanceThreshold;
  });
}

// After facts section, add summaries
const summariesSection = formatSummariesForPrompt();
if (summariesSection) {
  sections.push(summariesSection);
}
```

**Modify: `src/index.ts`**

At startup:
```typescript
import { runDecayCheck } from './memory/decay-service';
import { startExtractionWorker, recoverStalledExtractions } from './memory/extraction-service';

// Run decay check (async, non-blocking)
runDecayCheck().then(result => {
  logger.info('Decay check complete', result);
}).catch(err => {
  logger.warn('Decay check failed', { error: err.message });
});

// Recover any stalled extractions from previous crash
await recoverStalledExtractions();

// Start background extraction worker
startExtractionWorker();
```

---

## File Changes Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/llm/memory-agent.ts` | **Create** | MemoryAgent interface |
| `src/llm/ollama.ts` | **Create** | Ollama implementation |
| `src/memory/store.ts` | Modify | Add tables + index |
| `src/memory/decay-service.ts` | **Create** | Confidence decay logic |
| `src/memory/topic-detector.ts` | **Create** | Topic shift detection |
| `src/memory/extraction-service.ts` | **Create** | Fact extraction with queue |
| `src/memory/summarization-service.ts` | **Create** | Summary generation |
| `src/agent/brain.ts` | Modify | Queue extraction post-turn |
| `src/agent/context-guard.ts` | Modify | Trigger summarization with topic shift |
| `src/memory/knowledge.ts` | Modify | Include summaries + decay filter |
| `src/index.ts` | Modify | Startup hooks |
| `data/topic-config.json` | **Create** | Configurable topic detection phrases |

**New files:** 7
**Modified files:** 5

---

## Unit Tests Required

| Function | Location | Test Cases |
|----------|----------|------------|
| `detectTopicShift()` | topic-detector.ts | Explicit phrases, domain changes, no shift |
| `getDaysSinceConfirmed()` | decay-service.ts | Edge cases: today, 60, 90, 120 days |
| `getDecayStatus()` | decay-service.ts | All threshold boundaries |
| `parseExtractedFacts()` | extraction-service.ts | Valid JSON, invalid schema, malformed JSON |
| `cleanJsonResponse()` | ollama.ts | Markdown wrappers, clean JSON |
| `detectDomain()` | topic-detector.ts | Each domain, mixed, unknown |

---

## Implementation Order

1. **MemoryAgent interface + Ollama client** - Foundation with abstraction
2. **Schema extensions** - Tables and index only
3. **Zod schemas** - Validation for LLM responses
4. **Decay service** - Simplest, async paginated
5. **Topic detector** - Heuristic with config file
6. **Extraction service** - With queue management and recovery
7. **Summarization service** - With transaction-safe slot management
8. **Integration** - Wire everything together
9. **Unit tests** - Pure functions
10. **End-to-end testing**

---

## Verification Plan

### 1. Ollama Connectivity
```bash
curl http://localhost:11434/api/tags
```
Expected: Lists `qwen2.5:3b-instruct`

### 2. Extraction Test
1. Send: "Recordá que trabajo en una fintech"
2. Check: `SELECT * FROM pending_extraction` → status='pending'
3. Wait 10 seconds
4. Check: `SELECT * FROM facts WHERE source='inferred'` → has fintech fact
5. Check: `SELECT * FROM pending_extraction` → status='completed'

### 3. Extraction Recovery Test
1. Manually set: `UPDATE pending_extraction SET status='processing', last_attempt_at=datetime('now', '-10 minutes')`
2. Restart app
3. Check: status reset to 'pending'

### 4. Summarization Test
1. Have 7+ turn conversation
2. Check: `SELECT * FROM summaries` → has entry
3. Verify prompt includes summary section

### 5. Slot Shift Test
1. Create 4 summaries manually
2. Trigger 5th summarization
3. Check: slot 1 content moved to slot 1, old slot 1 deleted
4. Kill process mid-transaction (simulate crash)
5. Verify no corruption (all or nothing)

### 6. Decay Test
1. Insert fact: `last_confirmed_at = datetime('now', '-130 days')`
2. Run decay check
3. Verify: `stale=1`
4. Verify: fact not in prompt

### 7. Topic Shift Test
1. Say: "otra cosa, hablemos de algo diferente"
2. Check logs for topic shift detection
3. Verify summarization of full context triggered

### 8. Queue Overflow Test
1. Disable Ollama
2. Queue 1001 extractions
3. Verify oldest 1 is dropped
4. Check warning log

### 9. End-to-End
```bash
npm run build && npm start
```
- Multi-turn conversation with extractable facts
- Check no errors in logs
- Verify SQLite state

---

## Health Monitoring

Add periodic health check in extraction worker:
```typescript
const HEALTH_WARNING_THRESHOLD = 50;

function checkExtractionHealth(): void {
  const pending = db.prepare('SELECT COUNT(*) as c FROM pending_extraction WHERE status = "pending"').get().c;
  const failed = db.prepare('SELECT COUNT(*) as c FROM pending_extraction WHERE status = "failed"').get().c;

  if (pending > HEALTH_WARNING_THRESHOLD) {
    logger.warn('Extraction queue growing', { pending, failed, message: 'Ollama may be degraded' });
  }
}
```

---

## Prerequisites

```bash
# Ensure Ollama is installed
brew install ollama

# Start Ollama server
ollama serve &

# Download the model
ollama pull qwen2.5:3b-instruct

# Verify
curl http://localhost:11434/api/tags

# Install Zod for validation
npm install zod
```

---

## Success Criteria

- [ ] Facts are extracted without data loss (Zod validation prevents corruption)
- [ ] Summaries are parseable and stable (transaction-safe slot management)
- [ ] Memory doesn't grow linearly (bounded queue, TTL cleanup)
- [ ] Decay prevents stale facts from cluttering prompts
- [ ] Topic shifts create clean segment boundaries
- [ ] System recovers from crashes (stalled extraction recovery)
- [ ] Health is observable (queue size warnings)

---

## Risk Mitigation Summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| Slot shift corruption | HIGH | SQLite transaction |
| Worker stuck processing | HIGH | Startup recovery, 5-min timeout |
| Invalid JSON from LLM | MEDIUM | Zod schema validation |
| Unbounded queue growth | MEDIUM | TTL + max size limit |
| Startup blocking | LOW | Async paginated decay check |
| Summarization race | LOW | Best-effort, logged failures |

---

## Rollback Plan

If issues arise:
1. Disable extraction worker in `index.ts`
2. Remove summarization call from `context-guard.ts`
3. Keep Fase 1 behavior (manual `/remember` only)
4. Schema changes are additive (no data loss)
5. `pending_extraction` and `summaries` tables can be dropped without affecting core functionality

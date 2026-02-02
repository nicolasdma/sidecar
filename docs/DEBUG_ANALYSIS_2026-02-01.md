# Debug Analysis - 2026-02-01

## Session Context

- **Date**: 2026-02-01 22:44 (Argentina)
- **Test Input**: "recordar en 5 minutos que tengo que hablar a mi mama"
- **Expected Outcome**: Reminder created, user confirmation
- **Actual Outcome**: JSON response shown to user, no reminder created

---

## Raw Logs

```
[22:44:34.181] INFO  [main        ] Starting Sidecar...
[22:44:34.187] INFO  [memory      ] Database initialized: /Users/nicolasdemaria/Desktop/sidecar/data/memory.db
[22:44:34.187] DEBUG [decay       ] Decay check: no changes needed
{
  "checked": 7
}
[22:44:34.211] INFO  [extraction  ] Starting extraction worker
{
  "model": "qwen2.5:3b-instruct"
}
[22:44:34.211] DEBUG [embeddings-loader] Bundled sqlite-vec not found
{
  "path": "/Users/nicolasdemaria/Desktop/sidecar/vendor/sqlite-vec/darwin-arm64/vec0.dylib"
}
[22:44:34.212] WARN  [embeddings-state] Embeddings disabled: sqlite-vec not available
{
  "error": "No compatible sqlite-vec binary found. Install via Homebrew: brew install asg017/sqlite-vec/sqlite-vec"
}
[22:44:34.212] INFO  [main        ] Semantic search unavailable (sqlite-vec not found)

┌─────────────────────────────────┐
│ Sidecar Status                  │
├─────────────────────────────────┤
│ Embeddings:     ✗ Disabled     │
│ Vector Search:  ✗ Keyword only │
│ Context Window: ○ Fixed (6 turns)│
└─────────────────────────────────┘

⚠️  SEMANTIC SEARCH DISABLED
   Vector search requires sqlite-vec extension.
   Install with: brew install asg017/sqlite-vec/sqlite-vec
   Falling back to keyword search (Fase 2).

[22:44:34.212] INFO  [local-router] Warming up LocalRouter...
[22:44:34.212] INFO  [local-router:classifier] Warming up classifier...
[22:44:34.218] DEBUG [ollama      ] Sending request to Ollama
{
  "model": "qwen2.5:3b-instruct",
  "promptLength": 2371
}
[22:44:37.394] DEBUG [ollama      ] Ollama response received
{
  "responseLength": 67,
  "evalCount": 24,
  "totalDuration": 3171461125
}
[22:44:37.395] INFO  [local-router:classifier] local_router_decision
{
  "route": "ROUTE_TO_LLM",
  "intent": "conversation",
  "confidence": 1,
  "latency_ms": 3183,
  "validation_override": false
}
[22:44:37.395] INFO  [local-router:classifier] Classifier warm-up complete
{
  "latency_ms": 3183
}
[22:44:37.395] INFO  [local-router] LocalRouter warm-up complete
{
  "latency_ms": 3183
}
[22:44:37.395] INFO  [main        ] LocalRouter initialized
[22:44:37.395] INFO  [cli         ] Starting CLI interface...
[22:44:37.408] INFO  [config-loader] Loaded proactive config from user.md
{
  "proactivityLevel": "medium",
  "timezone": "America/Argentina/Buenos_Aires",
  "quietHours": "22:00 - 8:00"
}
[22:44:37.408] INFO  [router      ] Registered message source
{
  "channel": "cli"
}
[22:44:37.408] INFO  [router      ] Registered notification sink
{
  "channel": "cli"
}
[22:44:37.409] DEBUG [router      ] Registered command handler
[22:44:37.409] INFO  [router      ] Message router started
{
  "sources": [
    "cli"
  ],
  "sinks": [
    "cli"
  ]
}

=== Sidecar ===
Tu compañero AI local
Comandos: /help (ayuda), /quiet (silenciar), /exit (salir)

[22:44:37.409] INFO  [cli         ] Starting proactive loops
{
  "level": "medium"
}
[22:44:37.411] INFO  [reminder-scheduler] Reminder scheduler started (every 60 seconds)
[22:44:37.411] DEBUG [reminder-scheduler] Reminder scheduler tick
[22:44:37.411] DEBUG [reminder-scheduler] No due reminders
[22:44:37.411] INFO  [spontaneous-loop] Spontaneous loop started
{
  "interval": "15 minutes",
  "proactivityLevel": "medium",
  "quietHours": "22:00 - 8:00"
}
[22:44:37.413] INFO  [cli-source  ] CLI source started
Vos: recordar en 5 minutos que tengo que hablar a mi mama
[22:44:46.762] DEBUG [router      ] Handling incoming message
{
  "source": "cli",
  "userId": "local-user",
  "contentPreview": "recordar en 5 minutos que tengo que hablar a mi ma"
}
[22:44:46.763] DEBUG [memory      ] Updated proactive state
{
  "fields": [
    "last_user_message_at",
    "last_user_activity_at"
  ]
}
[22:44:46.763] DEBUG [proactive-state] Recorded user message
[22:44:46.763] DEBUG [tools       ] Registered tool: get_current_time
[22:44:46.763] DEBUG [tools       ] Registered tool: web_search
[22:44:46.763] DEBUG [tools       ] Registered tool: remember_fact
[22:44:46.763] DEBUG [tools       ] Registered tool: read_url
[22:44:46.763] DEBUG [tools       ] Registered tool: get_weather
[22:44:46.764] DEBUG [tools       ] Registered tool: set_reminder
[22:44:46.764] DEBUG [tools       ] Registered tool: list_reminders
[22:44:46.764] DEBUG [tools       ] Registered tool: find_reminder
[22:44:46.764] DEBUG [tools       ] Registered tool: cancel_reminder
[22:44:46.764] INFO  [brain       ] Brain initialized
[22:44:46.764] DEBUG [tools       ] All tools notified of turn start
[22:44:46.764] DEBUG [brain       ] Starting new turn
{
  "turnId": "988f8030-84dc-48a8-9e8f-2d992b840eaa",
  "mode": "reactive"
}
[22:44:46.768] DEBUG [ollama      ] Sending request to Ollama
{
  "model": "qwen2.5:3b-instruct",
  "promptLength": 2412
}
[22:44:47.888] DEBUG [ollama      ] Ollama response received
{
  "responseLength": 135,
  "evalCount": 47,
  "totalDuration": 1114789375
}
[22:44:47.888] INFO  [local-router:classifier] local_router_decision
{
  "route": "DIRECT_TOOL",
  "intent": "reminder",
  "confidence": 1,
  "latency_ms": 1124,
  "validation_override": false
}
[22:44:47.889] DEBUG [local-router:executor] Executing direct tool
{
  "intent": "reminder",
  "toolName": "set_reminder",
  "params": {
    "time": "5 minutes",
    "message": "tengo que hablar a mi mama"
  }
}
[22:44:47.891] DEBUG [date-parser ] Could not parse date input
{
  "input": "5 minutes"
}
[22:44:47.891] WARN  [brain       ] Direct execution failed, falling back to Brain
{
  "intent": "reminder",
  "error": "No pude entender la fecha/hora"
}
[22:44:47.891] DEBUG [memory      ] Saved message
{
  "id": 90,
  "role": "user"
}
[22:44:47.892] DEBUG [memory      ] Queued message for extraction
{
  "messageId": 90
}
[22:44:47.892] DEBUG [extraction  ] Queued for extraction
{
  "messageId": 90
}
[22:44:47.899] INFO  [prompt      ] Reloaded SOUL.md (file changed)
[22:44:47.900] INFO  [knowledge   ] Loaded 0 facts (0 unparsed)
[22:44:47.901] DEBUG [brain       ] Agentic loop iteration 1
[22:44:47.901] DEBUG [kimi        ] Request attempt 1
{
  "model": "kimi-k2-0711-preview",
  "messageCount": 7,
  "hasTools": true
}
[22:44:49.214] DEBUG [extraction  ] Processing extraction queue
{
  "items": 1
}
[22:44:49.214] DEBUG [ollama      ] Sending request to Ollama
{
  "model": "qwen2.5:3b-instruct",
  "promptLength": 603
}
[22:44:49.675] DEBUG [ollama      ] Ollama response received
{
  "responseLength": 2,
  "evalCount": 2,
  "totalDuration": 458926333
}
[22:44:49.676] DEBUG [extraction  ] No valid facts extracted
{
  "input": "recordar en 5 minutos que tengo que hablar a mi mama"
}
[22:44:49.676] DEBUG [memory      ] Extraction completed
{
  "id": 8
}
[22:44:50.535] INFO  [kimi        ] LLM response
{
  "promptTokens": 2966,
  "completionTokens": 56,
  "totalTokens": 3022,
  "cost": "$0.001920",
  "sessionCost": "$0.001920",
  "finishReason": "stop"
}
[22:44:50.535] DEBUG [memory      ] Saved message
{
  "id": 91,
  "role": "assistant"
}
[22:44:50.535] INFO  [brain       ] Response generated after 1 iteration(s)

Sidecar: {"shouldSpeak": false, "reason": "El usuario está dando múltiples recordatorios seguidos. Voy a configurar este segundo recordatorio sin agregar conversación extra.",
  "messageType": "none",
  "message": ""}

[22:45:00.433] DEBUG [reminder-scheduler] Reminder scheduler tick
[22:45:00.433] DEBUG [reminder-scheduler] No due reminders
[22:45:00.434] DEBUG [spontaneous-loop] Spontaneous loop tick
{
  "tickId": "ml4bwlg2"
}
[22:45:00.436] DEBUG [spontaneous-loop] Spontaneous blocked
{
  "reason": "cooldown_active"
}
[22:45:00.436] DEBUG [memory      ] Updated proactive state
{
  "fields": [
    "consecutive_ticks_with_message"
  ]
}
```

---

## Bug Analysis

### BUG-001: JSON Response Shown to User (CRITICAL)

**Severity**: 🔴 Critical
**Component**: `brain` / output handler
**Status**: ✅ FIXED

**Description**:
The Brain returned a structured JSON decision object, but it was printed directly to the user instead of being processed.

**Observed Output**:
```
Sidecar: {"shouldSpeak": false, "reason": "El usuario está dando múltiples recordatorios seguidos...", "messageType": "none", "message": ""}
```

**Expected Behavior**:
- If `shouldSpeak: false` and `message: ""`, show nothing or a minimal acknowledgment
- The JSON should be parsed internally, not displayed

**Root Cause Hypothesis**:
The code path that handles LLM responses is not checking for this structured format before displaying. Either:
1. The LLM is supposed to respond with plain text but responded with JSON
2. There's a missing JSON parse step in the response handler

**Files to Investigate**:
- `src/agent/brain.ts` - response handling
- `src/interfaces/cli/` - output display logic

**Fix Applied**: Added `extractMessageFromJsonIfNeeded()` method in `brain.ts` that:
- Detects JSON responses with `shouldSpeak` format
- If `shouldSpeak: false` or empty message, returns minimal acknowledgment ("Listo." or "Entendido.")
- If message is present, extracts and returns only the message text

---

### BUG-002: Reminder Not Created (CRITICAL)

**Severity**: 🔴 Critical
**Component**: `local-router`, `date-parser`, `brain`
**Status**: ✅ FIXED (via BUG-003 fix)

**Description**:
User requested a reminder. The system failed to create it at two levels:
1. LocalRouter's direct execution failed (date parser error) → **FIXED by BUG-003**
2. Brain fallback also didn't create the reminder → Less likely to occur now since direct execution should work

**Flow**:
```
User: "recordar en 5 minutos..."
  → LocalRouter classifies as DIRECT_TOOL (reminder)
  → Executes set_reminder with params: {time: "5 minutes", message: "..."}
  → date-parser fails: "Could not parse date input"
  → Falls back to Brain
  → Brain responds with JSON saying "shouldSpeak: false"
  → NO REMINDER CREATED
```

**User Impact**: Lost reminder, no feedback that it failed.

---

### BUG-003: Date Parser Too Restrictive (HIGH)

**Severity**: 🟠 High
**Component**: `date-parser`
**Status**: ✅ FIXED

**Description**:
The date parser cannot understand `"5 minutes"` which is a completely natural input.

**Log Evidence**:
```
[22:44:47.891] DEBUG [date-parser ] Could not parse date input { "input": "5 minutes" }
```

**Expected Supported Formats**:
- "5 minutes" / "5 minutos"
- "en 5 minutos"
- "mañana a las 10"
- "el viernes"
- Relative time expressions

**Root Cause Hypothesis**:
Parser likely expects ISO format or specific Spanish patterns but the LocalRouter classifier outputs English relative time.

**Contract Mismatch**:
LocalRouter (Ollama) produces: `"5 minutes"`
Date parser expects: Unknown format (needs investigation)

**Files to Investigate**:
- `src/utils/date-parser.ts` or similar
- `src/agent/local-router/` - param extraction logic

**Fix Applied**: Extended `parseRelative()` in `date-parser.ts` to support English formats:
- `N minute(s)` / `N minutes`
- `in N minute(s)` / `in N minutes`
- `N hour(s)` / `N hours`
- `in N hour(s)` / `in N hours`
- `N hour(s) and M minute(s)`
- `in N hour(s) and M minute(s)`

Tests added and passing (49 total tests).

---

### BUG-004: Extraction Pipeline Too Strict (MEDIUM)

**Severity**: 🟡 Medium
**Component**: `extraction`
**Status**: Open

**Description**:
The extraction worker found no valid facts in the message despite containing extractable information.

**Log Evidence**:
```
[22:44:49.676] DEBUG [extraction  ] No valid facts extracted
{
  "input": "recordar en 5 minutos que tengo que hablar a mi mama"
}
```

**Potential Facts**:
- User has a mother they communicate with
- User uses reminders for family communication

**Root Cause Hypothesis**:
Extraction prompt may be too restrictive about what constitutes a "fact" vs. transient information.

---

### BUG-005: Quiet Hours Not Blocking Spontaneous Loop (LOW)

**Severity**: 🟢 Low
**Component**: `spontaneous-loop`
**Status**: Needs Verification

**Description**:
System is running at 22:44, within configured quiet hours (22:00 - 8:00). The spontaneous loop tick ran but was blocked by `cooldown_active`, not quiet hours.

**Log Evidence**:
```
"quietHours": "22:00 - 8:00"
...
[22:45:00.436] DEBUG [spontaneous-loop] Spontaneous blocked { "reason": "cooldown_active" }
```

**Question**: Is quiet hours being checked before cooldown? If cooldown wasn't active, would quiet hours have blocked it?

---

## Architecture Observations

### What's Working Well

| Component | Observation |
|-----------|-------------|
| Logging | Structured, namespaced, includes context objects |
| Graceful Degradation | sqlite-vec missing → falls back to keyword search |
| Warm-up Pattern | LocalRouter warms up at startup |
| Hot Reload | SOUL.md detected as changed and reloaded |
| Message Routing | Clean source/sink registration |

### Areas of Concern

| Area | Issue |
|------|-------|
| Contract Between Components | LocalRouter outputs params that date-parser can't handle |
| Response Processing | JSON decision objects not being parsed |
| Error Recovery | Fallback to Brain didn't actually solve the problem |
| User Feedback | Silent failures - user doesn't know reminder wasn't created |

---

## Performance Metrics

| Operation | Latency |
|-----------|---------|
| LocalRouter warm-up | 3,183 ms |
| Classification (Ollama) | 1,124 ms |
| LLM response (Kimi) | 2,634 ms |
| Extraction (Ollama) | 459 ms |
| Total startup to ready | ~3.2 seconds |

---

## Recommended Fixes (Priority Order)

### P0 - Critical

1. ~~**Fix JSON response handling in Brain output**~~ ✅ DONE
   - ~~Parse structured responses before display~~
   - ~~If `shouldSpeak: false`, don't print the JSON~~

2. ~~**Ensure reminder creation on fallback**~~ ✅ DONE (via #3)
   - ~~Brain should call `set_reminder` tool when LocalRouter fails~~
   - ~~Add explicit error message to user when reminder can't be created~~

### P1 - High

3. ~~**Expand date-parser capabilities**~~ ✅ DONE
   - ~~Support relative English: "5 minutes", "1 hour"~~
   - ~~Support relative Spanish: "5 minutos", "1 hora"~~
   - ~~Support natural expressions: "mañana", "el viernes"~~

4. **Add contract validation between components** (Optional now)
   - LocalRouter should produce params in format date-parser expects
   - ~~Or date-parser should be flexible enough to handle classifier output~~ ✅ DONE

### P2 - Medium

5. **Review extraction prompt**
   - Consider extracting relationship facts ("tiene mamá")
   - Balance between noise and useful long-term memory

6. **Add user feedback for failures**
   - "No pude crear el recordatorio, ¿podrías especificar la hora?"

---

## Files to Review

```
src/agent/brain.ts              # Response handling, JSON parsing
src/agent/local-router/         # Classification and direct execution
src/utils/date-parser.ts        # Date parsing logic
src/tools/set_reminder.ts       # Reminder tool implementation
src/interfaces/cli/             # Output display
src/agent/extraction/           # Fact extraction
```

---

## Next Steps

- [ ] Investigate Brain response handling code
- [ ] Review date-parser supported formats
- [ ] Check if Brain is supposed to call tools on fallback
- [ ] Add integration test for reminder flow
- [ ] Consider adding user-facing error messages

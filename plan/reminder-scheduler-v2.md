# Reminder Scheduler V2 - Plan de Implementación

## Contexto

El scheduler actual usa polling cada 60s con ventana de ±5 minutos. Problemas:
- Impreciso (puede disparar 4 minutos antes o después)
- Ineficiente (queries cada minuto aunque no haya reminders)
- El "safety polling" es en realidad el sistema principal

## Arquitectura Propuesta

```
┌─────────────────────────────────────────────────────────────┐
│                      SQLite (verdad)                         │
│  reminders: id, message, trigger_at, triggered, cancelled   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   ReminderScheduler V2                       │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │ In-memory   │  │ Single       │  │ Event-driven      │   │
│  │ sorted queue│─▶│ setTimeout   │─▶│ dispatch + next   │   │
│  └─────────────┘  └──────────────┘  └───────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Componentes

### 1. ReminderQueue (in-memory)
```typescript
interface QueuedReminder {
  id: string;
  triggerAt: Date;  // Ya parseado, no string
}

class ReminderQueue {
  private queue: QueuedReminder[] = [];  // Sorted by triggerAt ASC

  peek(): QueuedReminder | null;     // Próximo sin remover
  pop(): QueuedReminder | null;      // Próximo y remover
  add(reminder: QueuedReminder): void;
  remove(id: string): void;
  loadFromDb(): void;                // Sync inicial
}
```

### 2. ReminderScheduler V2
```typescript
class ReminderSchedulerV2 {
  private queue: ReminderQueue;
  private currentTimer: NodeJS.Timeout | null = null;

  start(): void {
    // 1. Load queue from DB
    // 2. Catch-up de perdidos
    // 3. Schedule next
  }

  scheduleNext(): void {
    // 1. Clear current timer if exists
    // 2. Peek next from queue
    // 3. If exists: setTimeout(dispatch, msUntilTrigger)
  }

  onReminderCreated(id: string, triggerAt: Date): void {
    // 1. Add to queue
    // 2. If new reminder is sooner than current → reschedule
  }

  onReminderCancelled(id: string): void {
    // 1. Remove from queue
    // 2. If was next → reschedule
  }

  private dispatch(reminder: QueuedReminder): void {
    // 1. Mark triggered in DB
    // 2. Send notification
    // 3. Pop from queue
    // 4. Schedule next
    // 5. Log structured event
  }

  private catchUp(): void {
    // 1. Query: trigger_at <= NOW AND triggered = 0
    // 2. If count > 5: log summary, batch dispatch
    // 3. Else: dispatch each with 500ms delay
  }
}
```

### 3. Logging estructurado
```typescript
// Eventos a loggear:
logger.info('reminder_scheduled', { id, triggerAt, scheduledFor: msFromNow });
logger.info('reminder_dispatched', { id, triggerAt, dispatchedAt: now, lateByMs });
logger.info('reminder_catchup', { count, oldestAge: msOld });
logger.warn('reminder_dispatch_failed', { id, error });
```

## Cambios en archivos existentes

### Archivos a modificar:
1. `src/agent/proactive/reminder-scheduler.ts` - Rewrite completo
2. `src/memory/store.ts` - Agregar `getNextPendingReminder()`, `getPastDueReminders()`
3. `src/tools/reminders.ts` - Notificar al scheduler cuando se crea/cancela

### Archivos nuevos:
1. `src/agent/proactive/reminder-queue.ts` - Cola en memoria

## Flujo detallado

### Startup
```
1. ReminderSchedulerV2.start()
2. → queue.loadFromDb()  // SELECT * FROM reminders WHERE triggered=0 AND cancelled=0
3. → catchUp()           // Dispara los que ya pasaron
4. → scheduleNext()      // Programa el próximo
```

### Crear reminder
```
1. User: "recordarme X en 5 min"
2. → set_reminder tool saves to DB
3. → scheduler.onReminderCreated(id, triggerAt)
4. → queue.add({id, triggerAt})
5. → if triggerAt < currentNext: scheduleNext()
```

### Timer fires
```
1. setTimeout callback ejecuta
2. → dispatch(reminder)
3.   → markReminderTriggered(id, 1)
4.   → sendNotification(message)
5.   → markReminderTriggered(id, 2)
6.   → queue.pop()
7.   → logger.info('reminder_dispatched', {...})
8. → scheduleNext()
```

### Catch-up (app estuvo cerrada)
```
1. Query: SELECT * FROM reminders WHERE trigger_at <= NOW AND triggered = 0
2. If count == 0: return
3. If count <= 5:
   - For each: dispatch with 500ms delay between
4. If count > 5:
   - Show: "Tenés 12 recordatorios pendientes de mientras no estuve"
   - List summaries
   - Dispatch all (con rate limit)
```

## Edge cases

| Caso | Comportamiento |
|------|---------------|
| App cerrada 1 hora, 3 reminders perdidos | Catch-up los dispara al abrir con 500ms entre cada uno |
| App cerrada 1 semana, 50 reminders | Log warning, dispatch con rate limit, no spam |
| Crear reminder para hace 5 min (error de usuario) | Se dispara inmediatamente en catch-up |
| Cancelar el reminder que está programado | Remove de queue + clear timer + scheduleNext |
| Crear reminder más cercano que el programado | Reschedule al nuevo |
| Timer drift (1-2s en timers largos) | Aceptable, log el `lateByMs` para monitorear |

## Tests requeridos

```typescript
// test/reminder-scheduler-v2.test.ts

test('schedules next reminder on start')
test('dispatches at correct time (±100ms)')
test('reschedules when closer reminder created')
test('catches up missed reminders on start')
test('rate limits catch-up when many missed')
test('handles cancel of scheduled reminder')
test('handles empty queue gracefully')
test('logs structured events')
```

## Migración

1. El schema de DB no cambia
2. Eliminar cron job del scheduler v1
3. Instanciar scheduler v2 en su lugar
4. Los reminders existentes se cargan en la queue al iniciar

## Métricas de éxito

- **Precisión**: Dispatch dentro de ±500ms del triggerAt
- **Eficiencia**: 0 queries mientras no hay reminders pendientes
- **Robustez**: 100% de reminders se disparan (en catch-up si app cerrada)
- **Observabilidad**: Cada dispatch tiene log con latencia

---

## Checklist de implementación

- [ ] Crear `reminder-queue.ts`
- [ ] Rewrite `reminder-scheduler.ts` → V2
- [ ] Agregar queries en `store.ts`
- [ ] Integrar notificación desde `reminders.ts` tools
- [ ] Agregar logging estructurado
- [ ] Tests
- [ ] Limpiar código viejo (cron, polling)

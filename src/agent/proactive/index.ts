/**
 * Proactive System
 *
 * Exports for the proactive messaging system (Fase 3).
 */

export * from './types.js';
export * from './date-parser.js';
export * from './state.js';
export * from './context-builder.js';
export {
  startReminderScheduler,
  stopReminderScheduler,
  checkLostReminders,
  recoverLostReminders,
  isSchedulerRunning,
  forceTick as forceReminderTick,
} from './reminder-scheduler.js';
export {
  startSpontaneousLoop,
  stopSpontaneousLoop,
  updateConfig,
  getConfig,
  isLoopRunning,
  setBrainProcessing,
  getIsBrainProcessing,
  forceTick as forceSpontaneousTick,
} from './spontaneous-loop.js';

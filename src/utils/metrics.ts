/**
 * Fase 3.6: Centralized Metrics System
 *
 * Provides visibility into system health by aggregating metrics from all components.
 * This addresses the "Visibilidad de Fallas" gap identified in the system audit.
 *
 * Key features:
 * - Centralized health status for all subsystems
 * - Queue depth monitoring
 * - Failure counters with timestamps
 * - Session-level statistics
 */

import { createLogger } from './logger.js';

const logger = createLogger('metrics');

/**
 * Health status for a subsystem.
 */
export type HealthStatus = 'ok' | 'degraded' | 'down' | 'unknown';

/**
 * Individual subsystem health report.
 */
export interface SubsystemHealth {
  status: HealthStatus;
  message: string;
  lastCheck?: Date;
  details?: Record<string, unknown>;
}

/**
 * Session-level counters that track activity since startup.
 */
export interface SessionMetrics {
  startedAt: Date;
  factsExtracted: number;
  factsSaved: number;
  embeddingsGenerated: number;
  messagesProcessed: number;
  toolsExecuted: number;
  localRouterHits: number;
  localRouterBypasses: number;
  contextTruncations: number;
  proactiveMessagesSent: number;
  remindersSent: number;
}

/**
 * Complete system health report.
 */
export interface SystemHealth {
  overall: HealthStatus;
  subsystems: {
    ollama: SubsystemHealth;
    embeddings: SubsystemHealth;
    localRouter: SubsystemHealth;
    extractionQueue: SubsystemHealth;
    embeddingQueue: SubsystemHealth;
    proactiveLoop: SubsystemHealth;
    reminderScheduler: SubsystemHealth;
  };
  queues: {
    extractionPending: number;
    embeddingPending: number;
  };
  session: SessionMetrics;
}

// Session metrics - reset on startup
let sessionMetrics: SessionMetrics = {
  startedAt: new Date(),
  factsExtracted: 0,
  factsSaved: 0,
  embeddingsGenerated: 0,
  messagesProcessed: 0,
  toolsExecuted: 0,
  localRouterHits: 0,
  localRouterBypasses: 0,
  contextTruncations: 0,
  proactiveMessagesSent: 0,
  remindersSent: 0,
};

// Heartbeat timestamps for loops
let lastProactiveHeartbeat: Date | null = null;
let lastReminderHeartbeat: Date | null = null;

// Failure counters
let extractionFailures = 0;
let embeddingFailures = 0;

/**
 * Record a fact extraction success.
 */
export function recordFactExtracted(): void {
  sessionMetrics.factsExtracted++;
}

/**
 * Record a fact save.
 */
export function recordFactSaved(): void {
  sessionMetrics.factsSaved++;
}

/**
 * Record an embedding generation.
 */
export function recordEmbeddingGenerated(): void {
  sessionMetrics.embeddingsGenerated++;
}

/**
 * Record a message processed.
 */
export function recordMessageProcessed(): void {
  sessionMetrics.messagesProcessed++;
}

/**
 * Record a tool execution.
 */
export function recordToolExecuted(): void {
  sessionMetrics.toolsExecuted++;
}

/**
 * Record LocalRouter hit (direct execution).
 */
export function recordLocalRouterHit(): void {
  sessionMetrics.localRouterHits++;
}

/**
 * Record LocalRouter bypass (went to LLM).
 */
export function recordLocalRouterBypass(): void {
  sessionMetrics.localRouterBypasses++;
}

/**
 * Record context truncation.
 */
export function recordContextTruncation(): void {
  sessionMetrics.contextTruncations++;
  logger.warn('Context truncation occurred', {
    total: sessionMetrics.contextTruncations,
  });
}

/**
 * Record proactive message sent.
 */
export function recordProactiveMessage(): void {
  sessionMetrics.proactiveMessagesSent++;
}

/**
 * Record reminder sent.
 */
export function recordReminderSent(): void {
  sessionMetrics.remindersSent++;
}

/**
 * Record proactive loop heartbeat.
 */
export function recordProactiveHeartbeat(): void {
  lastProactiveHeartbeat = new Date();
}

/**
 * Record reminder scheduler heartbeat.
 */
export function recordReminderHeartbeat(): void {
  lastReminderHeartbeat = new Date();
}

/**
 * Record extraction failure.
 */
export function recordExtractionFailure(): void {
  extractionFailures++;
  if (extractionFailures >= 3) {
    logger.warn('Multiple extraction failures detected', {
      consecutiveFailures: extractionFailures,
    });
  }
}

/**
 * Reset extraction failure counter (on success).
 */
export function resetExtractionFailures(): void {
  extractionFailures = 0;
}

/**
 * Record embedding failure.
 */
export function recordEmbeddingFailure(): void {
  embeddingFailures++;
  if (embeddingFailures >= 3) {
    logger.warn('Multiple embedding failures detected', {
      consecutiveFailures: embeddingFailures,
    });
  }
}

/**
 * Reset embedding failure counter (on success).
 */
export function resetEmbeddingFailures(): void {
  embeddingFailures = 0;
}

/**
 * Get session metrics.
 */
export function getSessionMetrics(): Readonly<SessionMetrics> {
  return { ...sessionMetrics };
}

/**
 * Get proactive loop health based on heartbeat.
 */
export function getProactiveLoopHealth(): SubsystemHealth {
  if (!lastProactiveHeartbeat) {
    return {
      status: 'unknown',
      message: 'No heartbeat received yet',
    };
  }

  const ageMs = Date.now() - lastProactiveHeartbeat.getTime();
  const maxAgeMs = 5 * 60 * 1000; // 5 minutes

  if (ageMs < maxAgeMs) {
    return {
      status: 'ok',
      message: 'Loop running',
      lastCheck: lastProactiveHeartbeat,
    };
  }

  return {
    status: 'down',
    message: `No heartbeat for ${Math.floor(ageMs / 1000)}s`,
    lastCheck: lastProactiveHeartbeat,
  };
}

/**
 * Get reminder scheduler health based on heartbeat.
 */
export function getReminderSchedulerHealth(): SubsystemHealth {
  if (!lastReminderHeartbeat) {
    return {
      status: 'unknown',
      message: 'No heartbeat received yet',
    };
  }

  const ageMs = Date.now() - lastReminderHeartbeat.getTime();
  const maxAgeMs = 2 * 60 * 1000; // 2 minutes (reminders check every minute)

  if (ageMs < maxAgeMs) {
    return {
      status: 'ok',
      message: 'Scheduler running',
      lastCheck: lastReminderHeartbeat,
    };
  }

  return {
    status: 'down',
    message: `No heartbeat for ${Math.floor(ageMs / 1000)}s`,
    lastCheck: lastReminderHeartbeat,
  };
}

/**
 * Get extraction queue health.
 */
export function getExtractionQueueHealth(pendingCount: number): SubsystemHealth {
  if (pendingCount === 0) {
    return {
      status: 'ok',
      message: 'Queue empty',
      details: { pending: 0, failures: extractionFailures },
    };
  }

  if (pendingCount > 100) {
    return {
      status: 'degraded',
      message: `Large backlog: ${pendingCount} pending`,
      details: { pending: pendingCount, failures: extractionFailures },
    };
  }

  return {
    status: 'ok',
    message: `${pendingCount} pending`,
    details: { pending: pendingCount, failures: extractionFailures },
  };
}

/**
 * Get embedding queue health.
 */
export function getEmbeddingQueueHealth(pendingCount: number): SubsystemHealth {
  if (pendingCount === 0) {
    return {
      status: 'ok',
      message: 'Queue empty',
      details: { pending: 0, failures: embeddingFailures },
    };
  }

  if (pendingCount > 100) {
    return {
      status: 'degraded',
      message: `Large backlog: ${pendingCount} pending`,
      details: { pending: pendingCount, failures: embeddingFailures },
    };
  }

  return {
    status: 'ok',
    message: `${pendingCount} pending`,
    details: { pending: pendingCount, failures: embeddingFailures },
  };
}

/**
 * Determine overall system health from subsystem statuses.
 */
export function determineOverallHealth(
  subsystems: Record<string, SubsystemHealth>
): HealthStatus {
  const statuses = Object.values(subsystems).map((s) => s.status);

  if (statuses.some((s) => s === 'down')) {
    return 'degraded'; // Some components down but system still works
  }

  if (statuses.some((s) => s === 'degraded')) {
    return 'degraded';
  }

  if (statuses.every((s) => s === 'ok')) {
    return 'ok';
  }

  return 'unknown';
}

/**
 * Reset session metrics (for testing).
 */
export function resetSessionMetrics(): void {
  sessionMetrics = {
    startedAt: new Date(),
    factsExtracted: 0,
    factsSaved: 0,
    embeddingsGenerated: 0,
    messagesProcessed: 0,
    toolsExecuted: 0,
    localRouterHits: 0,
    localRouterBypasses: 0,
    contextTruncations: 0,
    proactiveMessagesSent: 0,
    remindersSent: 0,
  };
  lastProactiveHeartbeat = null;
  lastReminderHeartbeat = null;
  extractionFailures = 0;
  embeddingFailures = 0;
}

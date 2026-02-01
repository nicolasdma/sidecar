/**
 * Context Guard: Gestión del context window
 *
 * Protege contra overflow del context window truncando mensajes viejos.
 * Implementa Bug 12: detección de facts potenciales antes de truncar.
 * Issue #3: Backup is synchronous to prevent silent data loss.
 */

import { appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import type { Message } from '../llm/types.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import {
  estimateMessageTokens,
  estimateTotalTokens,
  TOKEN_BUDGETS,
} from '../utils/tokens.js';
import { scanMessagesForFacts, type ScanResult } from '../memory/fact-patterns.js';
import { summarizeMessages } from '../memory/summarization-service.js';
import { detectTopicShift, shouldTriggerSummarization } from '../memory/topic-detector.js';

const logger = createLogger('context');

// Issue #6: Use centralized token constants
const DEFAULT_MAX_TOKENS = TOKEN_BUDGETS.DEFAULT_MAX_CONTEXT;
const SYSTEM_PROMPT_RESERVE = TOKEN_BUDGETS.SYSTEM_PROMPT_RESERVE;
const RESPONSE_RESERVE = TOKEN_BUDGETS.RESPONSE_RESERVE;

// Issue #5: Use centralized paths from config
const DATA_DIR = config.paths.data;
const TRUNCATED_MESSAGES_PATH = config.paths.truncatedMessages;

export interface ContextGuardResult {
  messages: Message[];
  truncated: boolean;
  originalCount: number;
  finalCount: number;
  estimatedTokens: number;
  potentialFactsWarning?: string;
  /** Issue #3: Indicates if backup of truncated messages failed */
  backupFailed?: boolean;
  /** Fase 2: Indicates if a topic shift was detected */
  topicShiftDetected?: boolean;
}

/**
 * Guarda mensajes truncados en archivo de backup (Bug 12).
 * Este backup es append-only y sirve para recovery manual.
 *
 * Issue #3: Now throws errors instead of swallowing them,
 * so callers can detect backup failures.
 */
async function backupTruncatedMessages(
  messages: Message[],
  scanResult: ScanResult
): Promise<void> {
  // Asegurar que existe el directorio
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }

  const entry = {
    timestamp: new Date().toISOString(),
    messageCount: messages.length,
    potentialFacts: scanResult.matches,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content?.slice(0, 500), // Limitar tamaño del backup
    })),
  };

  await appendFile(
    TRUNCATED_MESSAGES_PATH,
    JSON.stringify(entry) + '\n',
    'utf-8'
  );

  logger.debug('Mensajes truncados guardados en backup');
}

/**
 * Trunca mensajes para que quepan en el context window.
 * Implementa Bug 12: detección y backup de facts potenciales.
 * Issue #3: Backup is now synchronous to prevent silent data loss.
 * Fase 2: Detects topic shifts and triggers summarization accordingly.
 *
 * @param messages - Current message history
 * @param maxTokens - Maximum context tokens
 * @param currentUserMessage - Optional current user message for topic shift detection
 */
export async function truncateMessages(
  messages: Message[],
  maxTokens: number = DEFAULT_MAX_TOKENS,
  currentUserMessage?: string
): Promise<ContextGuardResult> {
  const availableTokens = maxTokens - SYSTEM_PROMPT_RESERVE - RESPONSE_RESERVE;

  const totalTokens = estimateTotalTokens(messages);

  // Fase 2: Detect topic shift BEFORE any truncation decision
  let topicShiftDetected = false;
  if (currentUserMessage && messages.length > 0) {
    const topicShiftResult = detectTopicShift(currentUserMessage, messages);
    if (topicShiftResult.shifted) {
      topicShiftDetected = true;
      logger.info('Topic shift detected', {
        reason: topicShiftResult.reason,
        previousDomain: topicShiftResult.previousDomain,
        newDomain: topicShiftResult.newDomain,
      });
    }
  }

  if (totalTokens <= availableTokens) {
    // Even if not truncating, topic shift may trigger summarization
    if (topicShiftDetected && shouldTriggerSummarization({ shifted: true })) {
      logger.info('Topic shift detected without truncation, summarizing current context');
      summarizeMessages(messages).catch(err => {
        logger.warn('Topic shift summarization failed', { error: err instanceof Error ? err.message : err });
      });
    }

    return {
      messages,
      truncated: false,
      originalCount: messages.length,
      finalCount: messages.length,
      estimatedTokens: totalTokens,
      topicShiftDetected,
    };
  }

  logger.info(`Context too large (${totalTokens} tokens), truncating...`);

  const truncated: Message[] = [];
  let currentTokens = 0;

  // Iterar desde el final (mensajes más recientes primero)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    const msgTokens = estimateMessageTokens(msg);

    if (currentTokens + msgTokens > availableTokens) {
      break;
    }

    truncated.unshift(msg);
    currentTokens += msgTokens;
  }

  if (truncated.length === 0 && messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      truncated.push(lastMsg);
      currentTokens = estimateMessageTokens(lastMsg);
    }
  }

  // Calcular mensajes que se van a eliminar
  const removedCount = messages.length - truncated.length;
  const removedMessages = messages.slice(0, removedCount);

  logger.info(`Truncated from ${messages.length} to ${truncated.length} messages`);

  // Bug 12: Escanear mensajes removidos por facts potenciales
  let potentialFactsWarning: string | undefined;
  let backupFailed = false;

  if (removedMessages.length > 0) {
    const scanResult = scanMessagesForFacts(removedMessages);

    if (scanResult.hasPotentialFacts) {
      // Construir mensaje de warning
      const criticalWarning = scanResult.criticalCount > 0
        ? ` (${scanResult.criticalCount} CRÍTICOS)`
        : '';

      potentialFactsWarning = `⚠️ Truncando ${removedCount} mensajes con ${scanResult.matches.length} facts potenciales no guardados${criticalWarning}`;

      // Log detallado
      logger.warn(potentialFactsWarning);
      for (const match of scanResult.matches) {
        logger.warn(`  - [${match.priority}] ${match.category}: "${match.excerpt}"`);
      }

      // Issue #3: Guardar backup de forma síncrona (bloquea hasta completar)
      try {
        await backupTruncatedMessages(removedMessages, scanResult);
      } catch (error) {
        logger.error('CRÍTICO: Falló backup de mensajes con facts potenciales', { error });
        backupFailed = true;
        // Update warning to include backup failure
        potentialFactsWarning = `⚠️ ALERTA: ${scanResult.matches.length} facts potenciales NO pudieron respaldarse (backup failed)`;
      }
    }

    // Fase 2: Determine what to summarize based on topic shift
    // If topic shift detected AND significant, summarize full context
    // Otherwise, just summarize removed messages
    const shouldSummarizeFullContext = topicShiftDetected &&
      shouldTriggerSummarization({ shifted: true, previousDomain: undefined, newDomain: undefined });

    const messagesToSummarize = shouldSummarizeFullContext ? messages : removedMessages;

    if (messagesToSummarize.length >= 2) {
      logger.debug('Triggering summarization', {
        scope: shouldSummarizeFullContext ? 'full_context' : 'removed_messages',
        messageCount: messagesToSummarize.length,
        topicShiftDetected,
      });
      summarizeMessages(messagesToSummarize).catch(err => {
        logger.warn('Summarization failed', { error: err instanceof Error ? err.message : err });
      });
    }
  }

  return {
    messages: truncated,
    truncated: true,
    originalCount: messages.length,
    finalCount: truncated.length,
    estimatedTokens: currentTokens,
    potentialFactsWarning,
    backupFailed,
    topicShiftDetected,
  };
}

export function checkContextSize(
  messages: Message[],
  maxTokens: number = DEFAULT_MAX_TOKENS
): { withinLimit: boolean; estimatedTokens: number; availableTokens: number } {
  const availableTokens = maxTokens - SYSTEM_PROMPT_RESERVE - RESPONSE_RESERVE;
  const estimatedTokens = estimateTotalTokens(messages);

  return {
    withinLimit: estimatedTokens <= availableTokens,
    estimatedTokens,
    availableTokens,
  };
}

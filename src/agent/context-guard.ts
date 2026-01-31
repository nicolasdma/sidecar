/**
 * Context Guard: Gestión del context window
 *
 * Protege contra overflow del context window truncando mensajes viejos.
 * Implementa Bug 12: detección de facts potenciales antes de truncar.
 */

import { appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { Message } from '../llm/types.js';
import { createLogger } from '../utils/logger.js';
import { scanMessagesForFacts, type ScanResult } from '../memory/fact-patterns.js';

const logger = createLogger('context');

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 100000;
const SYSTEM_PROMPT_RESERVE = 4000;
const RESPONSE_RESERVE = 4000;

// Path para backup de mensajes truncados (Bug 12)
const DATA_DIR = path.join(process.cwd(), 'data');
const TRUNCATED_MESSAGES_PATH = path.join(DATA_DIR, 'truncated_messages.jsonl');

function estimateTokens(text: string | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function estimateMessageTokens(message: Message): number {
  let tokens = estimateTokens(message.content);

  tokens += 4;

  if (message.role === 'assistant' && message.tool_calls) {
    tokens += estimateTokens(JSON.stringify(message.tool_calls));
  }

  return tokens;
}

function estimateTotalTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

export interface ContextGuardResult {
  messages: Message[];
  truncated: boolean;
  originalCount: number;
  finalCount: number;
  estimatedTokens: number;
  potentialFactsWarning?: string;
}

/**
 * Guarda mensajes truncados en archivo de backup (Bug 12).
 * Este backup es append-only y sirve para recovery manual.
 */
async function backupTruncatedMessages(
  messages: Message[],
  scanResult: ScanResult
): Promise<void> {
  try {
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
  } catch (error) {
    logger.error('Error guardando backup de mensajes truncados', { error });
    // No propagar el error - el backup es best-effort
  }
}

/**
 * Trunca mensajes para que quepan en el context window.
 * Implementa Bug 12: detección y backup de facts potenciales.
 */
export function truncateMessages(
  messages: Message[],
  maxTokens: number = DEFAULT_MAX_TOKENS
): ContextGuardResult {
  const availableTokens = maxTokens - SYSTEM_PROMPT_RESERVE - RESPONSE_RESERVE;

  const totalTokens = estimateTotalTokens(messages);

  if (totalTokens <= availableTokens) {
    return {
      messages,
      truncated: false,
      originalCount: messages.length,
      finalCount: messages.length,
      estimatedTokens: totalTokens,
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

      // Guardar backup de forma asíncrona (no bloquear)
      backupTruncatedMessages(removedMessages, scanResult).catch(err => {
        logger.error('Error en backup asíncrono', { error: err });
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

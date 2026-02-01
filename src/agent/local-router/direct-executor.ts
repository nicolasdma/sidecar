/**
 * Direct Tool Executor - Fase 3.5
 *
 * Executes tools directly without going through the LLM.
 * INVARIANT: Uses executeTool() from registry - does NOT reimplement tool logic.
 */

import {
  executeTool,
  createExecutionContext,
  type ToolExecutionContext,
} from '../../tools/index.js';
import { parseDateTime } from '../proactive/date-parser.js';
import { createLogger } from '../../utils/logger.js';
import { config } from '../../utils/config.js';
import { readFileSync, existsSync } from 'fs';
import type { Intent, DirectExecutionResult } from './types.js';
import { INTENT_TO_TOOL } from './types.js';
import {
  generateTimeResponse,
  generateWeatherResponse,
  generateReminderResponse,
  generateListRemindersResponse,
  generateCancelReminderResponse,
} from './response-templates.js';

const logger = createLogger('local-router:executor');

/**
 * Get user timezone from user.md.
 */
function getUserTimezone(): string {
  const userMdPath = config.paths.userMd;
  if (!existsSync(userMdPath)) {
    return 'UTC';
  }

  try {
    const content = readFileSync(userMdPath, 'utf-8');
    const match = content.match(/\*?\*?timezone\*?\*?:\s*(\S+)/i);
    if (match?.[1]) {
      const tz = match[1].trim();
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return tz;
      } catch {
        logger.warn('Invalid timezone in user.md', { tz });
      }
    }
  } catch (error) {
    logger.warn('Error reading user.md for timezone', { error });
  }

  return 'UTC';
}

/**
 * Map classifier params to tool args for set_reminder.
 */
function mapReminderParams(params: Record<string, string>): {
  valid: boolean;
  args?: Record<string, unknown>;
  error?: string;
} {
  const time = params.time || params.datetime;
  const message = params.message || params.task;

  if (!time || !message) {
    return {
      valid: false,
      error: 'Falta el mensaje o la hora del recordatorio',
    };
  }

  // Validate time using parseDateTime
  const timezone = getUserTimezone();
  const parseResult = parseDateTime(time, timezone);

  if (!parseResult.success || !parseResult.datetime) {
    return {
      valid: false,
      error: parseResult.error || 'No pude entender la fecha/hora',
    };
  }

  return {
    valid: true,
    args: {
      message,
      datetime: time, // Pass original string, let the tool parse it
    },
  };
}

/**
 * Map classifier params to tool args for cancel_reminder.
 * If we have a query but not an ID, we need to find the reminder first.
 */
async function mapCancelReminderParams(
  params: Record<string, string>,
  context: ToolExecutionContext
): Promise<{
  valid: boolean;
  args?: Record<string, unknown>;
  error?: string;
  notFound?: boolean;
}> {
  const reminderId = params.reminder_id || params.id;
  const query = params.query || params.message;

  // If we have an ID, use it directly
  if (reminderId) {
    return {
      valid: true,
      args: { reminder_id: reminderId },
    };
  }

  // If we have a query, find the reminder first
  if (query) {
    const findResult = await executeTool('find_reminder', { query }, context);

    if (!findResult.success) {
      return {
        valid: false,
        error: findResult.error || 'Error buscando recordatorio',
      };
    }

    const data = findResult.data as { count: number; reminders?: Array<{ id: string }> };

    if (data.count === 0) {
      return {
        valid: false,
        notFound: true,
      };
    }

    if (data.count > 1) {
      return {
        valid: false,
        error: `Encontré ${data.count} recordatorios. Sé más específico.`,
      };
    }

    const foundId = data.reminders?.[0]?.id;
    if (!foundId) {
      return {
        valid: false,
        error: 'No pude obtener el ID del recordatorio',
      };
    }

    return {
      valid: true,
      args: { reminder_id: foundId },
    };
  }

  return {
    valid: false,
    error: 'Especificá qué recordatorio querés cancelar',
  };
}

/**
 * Execute an intent directly using the tool registry.
 *
 * INVARIANT: This function calls executeTool() and does NOT reimplement tool logic.
 */
export async function executeIntent(
  intent: Intent,
  params: Record<string, string>
): Promise<DirectExecutionResult> {
  const startTime = Date.now();
  const context = createExecutionContext();

  const toolName = INTENT_TO_TOOL[intent];
  if (!toolName) {
    return {
      success: false,
      response: '',
      error: `No tool mapped for intent: ${intent}`,
      latencyMs: Date.now() - startTime,
    };
  }

  logger.debug('Executing direct tool', { intent, toolName, params });

  try {
    let result;
    let response: string;

    switch (intent) {
      case 'time': {
        result = await executeTool(toolName, {}, context);
        if (result.success && result.data) {
          const data = result.data as {
            time: string;
            date: string;
            day: string;
          };
          response = generateTimeResponse(data);
        } else {
          response = 'No pude obtener la hora.';
        }
        break;
      }

      case 'weather': {
        const location = params.location || params.city || params.lugar;
        if (!location) {
          return {
            success: false,
            response: generateWeatherResponse(false, undefined, 'Falta la ubicación'),
            error: 'Falta la ubicación',
            toolName,
            latencyMs: Date.now() - startTime,
          };
        }

        result = await executeTool(toolName, { location }, context);
        if (result.success && result.data) {
          const data = result.data as {
            location: string;
            temperature: string;
            feelsLike: string;
            humidity: string;
            wind: string;
            condition: string;
            summary: string;
          };
          response = generateWeatherResponse(true, data);
        } else {
          response = generateWeatherResponse(false, undefined, result.error);
        }
        break;
      }

      case 'list_reminders': {
        result = await executeTool(toolName, {}, context);
        if (result.success && result.data) {
          const data = result.data as {
            count: number;
            reminders: string[];
            message: string;
          };
          response = generateListRemindersResponse(data);
        } else {
          response = 'No pude listar los recordatorios.';
        }
        break;
      }

      case 'reminder': {
        const mapped = mapReminderParams(params);
        if (!mapped.valid || !mapped.args) {
          return {
            success: false,
            response: mapped.error || 'Error en parámetros del recordatorio',
            error: mapped.error,
            toolName,
            latencyMs: Date.now() - startTime,
          };
        }

        result = await executeTool(toolName, mapped.args, context);
        if (result.success && result.data) {
          const data = result.data as {
            message: string;
            formattedTime: string;
          };
          response = generateReminderResponse(true, data);
        } else {
          response = generateReminderResponse(false, undefined, result.error);
        }
        break;
      }

      case 'cancel_reminder': {
        const mapped = await mapCancelReminderParams(params, context);
        if (!mapped.valid) {
          return {
            success: false, // Always false when params are invalid
            response: mapped.notFound
              ? generateCancelReminderResponse(false, undefined, true)
              : generateCancelReminderResponse(false, undefined, false, mapped.error),
            error: mapped.error,
            toolName,
            latencyMs: Date.now() - startTime,
          };
        }

        result = await executeTool(toolName, mapped.args!, context);
        if (result.success && result.data) {
          const data = result.data as { message: string };
          response = generateCancelReminderResponse(true, data);
        } else {
          // Check if it's a "not found" error
          const isNotFound = result.error?.toLowerCase().includes('no encontr');
          response = generateCancelReminderResponse(false, undefined, isNotFound, result.error);
        }
        break;
      }

      default:
        return {
          success: false,
          response: '',
          error: `Unhandled intent: ${intent}`,
          latencyMs: Date.now() - startTime,
        };
    }

    const latencyMs = Date.now() - startTime;

    logger.info('direct_execution', {
      intent,
      tool: toolName,
      success: result?.success ?? false,
      latency_ms: latencyMs,
      fallback_to_brain: false,
    });

    return {
      success: result?.success ?? false,
      response,
      error: result?.success ? undefined : result?.error,
      toolName,
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    logger.error('Direct execution failed', {
      intent,
      toolName,
      error: errorMsg,
      latency_ms: latencyMs,
    });

    return {
      success: false,
      response: '',
      error: errorMsg,
      toolName,
      latencyMs,
    };
  }
}

export default executeIntent;

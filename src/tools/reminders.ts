/**
 * Reminder Tools for Fase 3
 *
 * Tools: set_reminder, list_reminders, find_reminder, cancel_reminder
 *
 * The LLM passes natural language datetime to set_reminder.
 * We use deterministic parsing - no LLM interpretation of dates.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Tool, ToolResult, ToolExecutionContext } from './types.js';
import { parseDateTime } from '../agent/proactive/date-parser.js';
import {
  saveReminder,
  getPendingReminders,
  findRemindersByContent,
  cancelReminder,
  type ReminderRow,
} from '../memory/store.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { readFileSync, existsSync } from 'fs';
import {
  notifyReminderCreated,
  notifyReminderCancelled,
} from '../agent/proactive/reminder-scheduler-v2.js';

const logger = createLogger('tool:reminders');

/**
 * Get timezone from user.md or return default.
 */
function getUserTimezone(): string {
  const userMdPath = config.paths.userMd;
  if (!existsSync(userMdPath)) {
    logger.warn('user.md not found, using default timezone UTC');
    return 'UTC';
  }

  try {
    const content = readFileSync(userMdPath, 'utf-8');
    const match = content.match(/\*?\*?timezone\*?\*?:\s*(\S+)/i);
    if (match?.[1]) {
      const tz = match[1].trim();
      // Validate timezone
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return tz;
      } catch {
        logger.error(`Invalid timezone in user.md: ${tz}`);
      }
    }
  } catch (error) {
    logger.error('Error reading user.md for timezone', { error });
  }

  return 'UTC';
}

/**
 * Format a reminder for display.
 */
function formatReminder(reminder: ReminderRow): string {
  const triggerAt = new Date(reminder.trigger_at);
  const timezone = getUserTimezone();

  const formattedTime = triggerAt.toLocaleString('es-AR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  });

  return `[id:${reminder.id.slice(0, 8)}] ${reminder.message} - ${formattedTime}`;
}

/**
 * Tool: set_reminder
 *
 * Creates a reminder with natural language datetime.
 */
export const setReminderTool: Tool = {
  name: 'set_reminder',
  description: `Crea un recordatorio para una fecha/hora específica.

Formatos de fecha/hora soportados:
- "en 30 minutos", "en 2 horas", "en 1 hora y 30 minutos"
- "mañana a las 9", "mañana a las 15:30"
- "hoy a las 15", "hoy a las 18:00"
- "el lunes a las 10", "el viernes a las 18"

NO soportado (va a dar error):
- "a las 3" sin día
- "en un rato", "más tarde"
- "la semana que viene"

SIEMPRE pasá el mensaje y la fecha/hora exactamente como el usuario la especificó.`,

  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Qué debe recordarle al usuario (ej: "llamar a mamá", "tomar la medicina")',
      },
      datetime: {
        type: 'string',
        description: 'Cuándo recordar, en el formato que dijo el usuario (ej: "en 2 horas", "mañana a las 9")',
      },
    },
    required: ['message', 'datetime'],
  },

  execute: async (
    args: Record<string, unknown>,
    _context?: ToolExecutionContext
  ): Promise<ToolResult> => {
    const message = args.message as string;
    const datetime = args.datetime as string;

    if (!message?.trim()) {
      return {
        success: false,
        error: 'El mensaje del recordatorio no puede estar vacío',
      };
    }

    if (!datetime?.trim()) {
      return {
        success: false,
        error: 'Falta especificar cuándo recordar',
      };
    }

    // Get user timezone
    const timezone = getUserTimezone();
    logger.debug('Parsing reminder datetime', { datetime, timezone });

    // Parse the datetime
    const parseResult = parseDateTime(datetime.trim(), timezone);

    if (!parseResult.success || !parseResult.datetime) {
      logger.warn('Failed to parse reminder datetime', {
        datetime,
        error: parseResult.error,
      });
      return {
        success: false,
        error: parseResult.error ?? 'No pude entender la fecha/hora',
        data: {
          suggestion: parseResult.suggestion,
        },
      };
    }

    // Create the reminder
    const id = uuidv4();
    const triggerAt = parseResult.datetime;

    try {
      saveReminder({ id, message: message.trim(), triggerAt });

      // Notify scheduler V2 of new reminder
      notifyReminderCreated(id, message.trim(), triggerAt);

      const formattedTime = triggerAt.toLocaleString('es-AR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: timezone,
      });

      logger.info('Created reminder', { id, message, triggerAt: formattedTime });

      return {
        success: true,
        data: {
          id,
          message,
          triggerAt: triggerAt.toISOString(),
          formattedTime,
          timezone,
          confirmation: `Listo, te voy a recordar "${message}" el ${formattedTime}`,
        },
      };
    } catch (error) {
      logger.error('Error saving reminder', { error });
      return {
        success: false,
        error: 'Error al guardar el recordatorio',
      };
    }
  },
};

/**
 * Tool: list_reminders
 *
 * Lists all pending reminders.
 */
export const listRemindersTool: Tool = {
  name: 'list_reminders',
  description: 'Lista todos los recordatorios pendientes del usuario.',

  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },

  execute: async (): Promise<ToolResult> => {
    try {
      const reminders = getPendingReminders();

      if (reminders.length === 0) {
        return {
          success: true,
          data: {
            count: 0,
            reminders: [],
            message: 'No tenés recordatorios pendientes',
          },
        };
      }

      const formatted = reminders.map(formatReminder);

      return {
        success: true,
        data: {
          count: reminders.length,
          reminders: formatted,
          message: `Tenés ${reminders.length} recordatorio${reminders.length === 1 ? '' : 's'} pendiente${reminders.length === 1 ? '' : 's'}:\n${formatted.join('\n')}`,
        },
      };
    } catch (error) {
      logger.error('Error listing reminders', { error });
      return {
        success: false,
        error: 'Error al listar recordatorios',
      };
    }
  },
};

/**
 * Tool: find_reminder
 *
 * Finds reminders by content/message.
 */
export const findReminderTool: Tool = {
  name: 'find_reminder',
  description: `Busca recordatorios por contenido del mensaje.
Útil para encontrar el ID de un recordatorio para cancelarlo.
Por ejemplo, si el usuario dice "cancela el de mamá", primero buscá con query="mamá".`,

  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Texto a buscar en los recordatorios (ej: "mamá", "medicina")',
      },
    },
    required: ['query'],
  },

  execute: async (
    args: Record<string, unknown>
  ): Promise<ToolResult> => {
    const query = args.query as string;

    if (!query?.trim()) {
      return {
        success: false,
        error: 'Especificá qué buscar',
      };
    }

    try {
      const reminders = findRemindersByContent(query.trim());

      if (reminders.length === 0) {
        return {
          success: true,
          data: {
            count: 0,
            reminders: [],
            message: `No encontré recordatorios con "${query}"`,
          },
        };
      }

      const formatted = reminders.map(formatReminder);

      return {
        success: true,
        data: {
          count: reminders.length,
          reminders: reminders.map((r) => ({
            id: r.id,
            message: r.message,
            triggerAt: r.trigger_at,
          })),
          message: `Encontré ${reminders.length} recordatorio${reminders.length === 1 ? '' : 's'}:\n${formatted.join('\n')}`,
        },
      };
    } catch (error) {
      logger.error('Error finding reminders', { error });
      return {
        success: false,
        error: 'Error al buscar recordatorios',
      };
    }
  },
};

/**
 * Tool: cancel_reminder
 *
 * Cancels a reminder by ID.
 */
export const cancelReminderTool: Tool = {
  name: 'cancel_reminder',
  description: `Cancela un recordatorio por su ID.
Primero usá find_reminder o list_reminders para obtener el ID.
Podés usar solo los primeros 8 caracteres del ID.`,

  parameters: {
    type: 'object',
    properties: {
      reminder_id: {
        type: 'string',
        description: 'ID del recordatorio a cancelar (o los primeros 8 caracteres)',
      },
    },
    required: ['reminder_id'],
  },

  execute: async (
    args: Record<string, unknown>
  ): Promise<ToolResult> => {
    const reminderId = args.reminder_id as string;

    if (!reminderId?.trim()) {
      return {
        success: false,
        error: 'Falta el ID del recordatorio',
      };
    }

    const id = reminderId.trim();

    try {
      // Try to find the reminder by full ID or prefix
      const reminders = getPendingReminders();
      const matching = reminders.filter(
        (r) => r.id === id || r.id.startsWith(id)
      );

      if (matching.length === 0) {
        return {
          success: false,
          error: `No encontré un recordatorio con ID "${id}"`,
        };
      }

      if (matching.length > 1) {
        return {
          success: false,
          error: `Hay ${matching.length} recordatorios que empiezan con "${id}". Sé más específico.`,
          data: {
            matches: matching.map((r) => ({
              id: r.id.slice(0, 8),
              message: r.message,
            })),
          },
        };
      }

      const reminder = matching[0]!;
      const cancelled = cancelReminder(reminder.id);

      if (cancelled) {
        // Notify scheduler V2 of cancelled reminder
        notifyReminderCancelled(reminder.id);

        logger.info('Cancelled reminder', { id: reminder.id, message: reminder.message });
        return {
          success: true,
          data: {
            id: reminder.id,
            message: reminder.message,
            confirmation: `Cancelé el recordatorio: "${reminder.message}"`,
          },
        };
      } else {
        return {
          success: false,
          error: 'No pude cancelar el recordatorio (ya fue disparado o cancelado)',
        };
      }
    } catch (error) {
      logger.error('Error cancelling reminder', { error });
      return {
        success: false,
        error: 'Error al cancelar el recordatorio',
      };
    }
  },
};

/**
 * All reminder tools for registration.
 */
export const reminderTools: Tool[] = [
  setReminderTool,
  listRemindersTool,
  findReminderTool,
  cancelReminderTool,
];

export default reminderTools;

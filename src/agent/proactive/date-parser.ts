/**
 * Deterministic date parser for Spanish natural language.
 *
 * Refactorizado con Luxon para manejo correcto de timezones.
 *
 * Supported formats:
 * - Relative: "en N minutos", "en N horas", "en N horas y M minutos"
 * - Tomorrow: "mañana a las H" or "mañana a las H:MM"
 * - Today: "hoy a las H" or "hoy a las H:MM"
 * - Weekday: "el lunes/martes/.../domingo a las H[:MM]"
 *
 * Design:
 * - All parsing is regex-based and deterministic (no LLM)
 * - Timezone del usuario se respeta en todos los cálculos
 * - Internamente todo es UTC
 */

import { createLogger } from '../../utils/logger.js';
import {
  createDateTimeInUserTz,
  createDateTimeForWeekday,
  createRelativeDateTime,
  isInFuture,
  isValidTimezone,
  formatForUser,
  toJSDate,
  setMockNow,
  clearMockNow,
  type ParseResult,
  type ParsedDateTime,
} from '../../utils/datetime.js';

const logger = createLogger('date-parser');

/**
 * Re-export types for consumers
 */
export type { ParseResult, ParsedDateTime };

/**
 * Legacy interface for backward compatibility.
 * @deprecated Use ParseResult instead
 */
export interface DateParseResult {
  success: boolean;
  datetime?: Date;
  error?: string;
  suggestion?: string;
  formatted?: string;
}

/**
 * Weekday name to ISO weekday number (1=Monday, 7=Sunday)
 */
const WEEKDAYS: Record<string, number> = {
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6,
  domingo: 7,
};

/**
 * Parse relative time: "en N minutos", "en N horas", "N minutes", etc.
 */
function parseRelative(input: string, userTz: string): ParseResult | null {
  // Spanish: "en N minuto(s)"
  const minutesOnlyEs = input.match(/^en\s+(\d+)\s+minutos?$/i);
  if (minutesOnlyEs) {
    const minutes = parseInt(minutesOnlyEs[1]!, 10);
    const dt = createRelativeDateTime(0, minutes);
    return {
      success: true,
      result: { datetime: dt, formatted: formatForUser(dt, userTz) },
    };
  }

  // English: "N minute(s)" or "in N minute(s)"
  const minutesOnlyEn = input.match(/^(?:in\s+)?(\d+)\s+minutes?$/i);
  if (minutesOnlyEn) {
    const minutes = parseInt(minutesOnlyEn[1]!, 10);
    const dt = createRelativeDateTime(0, minutes);
    return {
      success: true,
      result: { datetime: dt, formatted: formatForUser(dt, userTz) },
    };
  }

  // Spanish: "en N hora(s)"
  const hoursOnlyEs = input.match(/^en\s+(\d+)\s+horas?$/i);
  if (hoursOnlyEs) {
    const hours = parseInt(hoursOnlyEs[1]!, 10);
    const dt = createRelativeDateTime(hours, 0);
    return {
      success: true,
      result: { datetime: dt, formatted: formatForUser(dt, userTz) },
    };
  }

  // English: "N hour(s)" or "in N hour(s)"
  const hoursOnlyEn = input.match(/^(?:in\s+)?(\d+)\s+hours?$/i);
  if (hoursOnlyEn) {
    const hours = parseInt(hoursOnlyEn[1]!, 10);
    const dt = createRelativeDateTime(hours, 0);
    return {
      success: true,
      result: { datetime: dt, formatted: formatForUser(dt, userTz) },
    };
  }

  // Spanish: "en N hora(s) y M minuto(s)"
  const compoundEs = input.match(
    /^en\s+(\d+)\s+horas?\s+y\s+(\d+)\s+minutos?$/i
  );
  if (compoundEs) {
    const hours = parseInt(compoundEs[1]!, 10);
    const minutes = parseInt(compoundEs[2]!, 10);
    const dt = createRelativeDateTime(hours, minutes);
    return {
      success: true,
      result: { datetime: dt, formatted: formatForUser(dt, userTz) },
    };
  }

  // English: "N hour(s) and M minute(s)"
  const compoundEn = input.match(
    /^(?:in\s+)?(\d+)\s+hours?\s+and\s+(\d+)\s+minutes?$/i
  );
  if (compoundEn) {
    const hours = parseInt(compoundEn[1]!, 10);
    const minutes = parseInt(compoundEn[2]!, 10);
    const dt = createRelativeDateTime(hours, minutes);
    return {
      success: true,
      result: { datetime: dt, formatted: formatForUser(dt, userTz) },
    };
  }

  return null;
}

/**
 * Parse "hoy a las H[:MM]"
 *
 * Regla de desambiguación para horas 1-11:
 * - Si PM está en el futuro, usar PM (la gente dice "a las 3" = 15:00)
 * - Si ambas pasaron, error
 */
function parseToday(input: string, userTz: string): ParseResult | null {
  const match = input.match(/^hoy\s+a\s+las?\s+(\d{1,2})(?::(\d{2}))?$/i);
  if (!match) return null;

  const hour = parseInt(match[1]!, 10);
  const minute = parseInt(match[2] || '0', 10);

  if (hour > 23 || minute > 59) {
    return { success: false, error: 'Hora inválida' };
  }

  try {
    // Hora no ambigua (0, 12-23): usar directamente
    if (hour === 0 || hour >= 12) {
      const dt = createDateTimeInUserTz(userTz, {
        hour,
        minute,
        daysFromNow: 0,
      });

      if (!isInFuture(dt)) {
        const timeStr =
          minute > 0 ? `${hour}:${minute.toString().padStart(2, '0')}` : `${hour}`;
        return {
          success: false,
          error: `Las ${timeStr} ya pasó hoy`,
          suggestion: `Probá con "mañana a las ${hour}"`,
        };
      }

      return {
        success: true,
        result: { datetime: dt, formatted: formatForUser(dt, userTz) },
      };
    }

    // Hora ambigua (1-11): preferir PM si está en el futuro
    const pmHour = hour + 12;
    const pmDt = createDateTimeInUserTz(userTz, {
      hour: pmHour,
      minute,
      daysFromNow: 0,
    });

    if (isInFuture(pmDt)) {
      // PM está en el futuro - usarlo (la gente dice "a las 3" = 15:00)
      return {
        success: true,
        result: { datetime: pmDt, formatted: formatForUser(pmDt, userTz) },
      };
    }

    // PM también pasó - error
    const timeStr =
      minute > 0 ? `${hour}:${minute.toString().padStart(2, '0')}` : `${hour}`;
    return {
      success: false,
      error: `Las ${timeStr} (${pmHour}:00) ya pasó hoy`,
      suggestion: `Probá con "mañana a las ${hour}"`,
    };
  } catch (error) {
    // DST edge-case
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Error de fecha',
      suggestion: 'Probá una hora diferente (posible cambio de horario)',
    };
  }
}

/**
 * Parse "mañana a las H[:MM]"
 */
function parseTomorrow(input: string, userTz: string): ParseResult | null {
  const match = input.match(/^mañana\s+a\s+las?\s+(\d{1,2})(?::(\d{2}))?$/i);
  if (!match) return null;

  const hour = parseInt(match[1]!, 10);
  const minute = parseInt(match[2] || '0', 10);

  if (hour > 23 || minute > 59) {
    return {
      success: false,
      error: 'Hora inválida',
      suggestion: 'Usá formato HH:MM, ej: "mañana a las 9:30"',
    };
  }

  try {
    const dt = createDateTimeInUserTz(userTz, {
      hour,
      minute,
      daysFromNow: 1,
    });

    return {
      success: true,
      result: { datetime: dt, formatted: formatForUser(dt, userTz) },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Error de fecha',
      suggestion: 'Probá una hora diferente (posible cambio de horario)',
    };
  }
}

/**
 * Parse "el [weekday] a las H[:MM]"
 * Always resolves to next occurrence.
 */
function parseWeekday(input: string, userTz: string): ParseResult | null {
  const match = input.match(
    /^el\s+(lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo)\s+a\s+las?\s+(\d{1,2})(?::(\d{2}))?$/i
  );
  if (!match) return null;

  // Normalize weekday name (remove accents for lookup)
  const weekdayName = match[1]!
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const hour = parseInt(match[2]!, 10);
  const minute = parseInt(match[3] || '0', 10);

  const weekday = WEEKDAYS[weekdayName];
  if (weekday === undefined) {
    return {
      success: false,
      error: `Día de la semana no reconocido: ${match[1]}`,
    };
  }

  if (hour > 23 || minute > 59) {
    return {
      success: false,
      error: 'Hora inválida',
      suggestion: `Usá formato HH:MM, ej: "el ${match[1]} a las 10:00"`,
    };
  }

  try {
    const dt = createDateTimeForWeekday(userTz, weekday, hour, minute);

    return {
      success: true,
      result: { datetime: dt, formatted: formatForUser(dt, userTz) },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Error de fecha',
      suggestion: 'Probá una hora diferente (posible cambio de horario)',
    };
  }
}

/**
 * Check for unsupported but common patterns with helpful errors.
 */
function checkUnsupportedPatterns(input: string): ParseResult | null {
  // "a las X" without day
  if (/^a\s+las?\s+\d+/i.test(input)) {
    return {
      success: false,
      error: 'Falta especificar el día',
      suggestion: 'Especificá el día: "hoy a las 3" o "mañana a las 3"',
    };
  }

  // "en un rato"
  if (/en\s+un\s+rato/i.test(input)) {
    return {
      success: false,
      error: 'Expresión demasiado vaga',
      suggestion: 'Usá tiempo específico: "en 30 minutos" o "en 1 hora"',
    };
  }

  // "la semana que viene"
  if (/la\s+semana\s+que\s+viene/i.test(input)) {
    return {
      success: false,
      error: 'Falta especificar día y hora',
      suggestion: 'Especificá día y hora: "el lunes a las 10"',
    };
  }

  // "el próximo [weekday]" without time
  if (/^el\s+pr[óo]ximo\s+\w+$/i.test(input)) {
    return {
      success: false,
      error: 'Falta especificar la hora',
      suggestion: 'Agregá la hora: "el martes a las 10"',
    };
  }

  // "pasado mañana"
  if (/pasado\s+mañana/i.test(input)) {
    return {
      success: false,
      error: 'Formato no soportado',
      suggestion: 'Usá: "en 2 días a las X" o especificá el día de la semana',
    };
  }

  return null;
}

/**
 * Main parsing function (new API with discriminated union).
 *
 * @param input - Natural language date/time string
 * @param timezone - IANA timezone (e.g., "America/Argentina/Buenos_Aires")
 * @returns ParseResult with success status and datetime or error
 */
export function parseDateTimeNew(input: string, timezone: string): ParseResult {
  if (!isValidTimezone(timezone)) {
    return {
      success: false,
      error: `Timezone inválida: "${timezone}". Usá formato IANA, ej: "America/Argentina/Buenos_Aires"`,
    };
  }

  const normalized = input.trim().replace(/\s+/g, ' ').toLowerCase();

  if (!normalized) {
    return {
      success: false,
      error: 'Entrada vacía',
      suggestion:
        'Especificá cuándo: "en 30 minutos", "mañana a las 9", etc.',
    };
  }

  // Try each parser in order
  const result =
    parseRelative(normalized, timezone) ||
    parseToday(normalized, timezone) ||
    parseTomorrow(normalized, timezone) ||
    parseWeekday(normalized, timezone);

  if (result) {
    return result;
  }

  // Check for common unsupported patterns
  const unsupported = checkUnsupportedPatterns(normalized);
  if (unsupported) {
    return unsupported;
  }

  // Unknown format
  logger.debug('Could not parse date input', { input: normalized });
  return {
    success: false,
    error: 'No pude entender la fecha/hora',
    suggestion:
      'Formatos soportados: "en 30 minutos", "mañana a las 9", "hoy a las 15", "el lunes a las 10"',
  };
}

/**
 * Main parsing function (legacy API for backward compatibility).
 *
 * @deprecated Use parseDateTimeNew() for new code
 */
export function parseDateTime(
  input: string,
  timezone: string,
  now?: Date // Optional reference time for testing (as UTC instant)
): DateParseResult {
  // Set mock time if provided (for testing)
  if (now) {
    setMockNow(now);
  }

  try {
    const result = parseDateTimeNew(input, timezone);

    if (result.success) {
      return {
        success: true,
        datetime: toJSDate(result.result.datetime),
        formatted: result.result.formatted,
      };
    }

    return {
      success: false,
      error: result.error,
      suggestion: result.suggestion,
    };
  } finally {
    // Always clear mock time after parsing
    if (now) {
      clearMockNow();
    }
  }
}

export default parseDateTime;

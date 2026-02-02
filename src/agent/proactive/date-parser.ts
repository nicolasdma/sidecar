/**
 * Deterministic date parser for Spanish natural language.
 *
 * Supported formats:
 * - ISO 8601: "2026-02-01T15:00" or "2026-02-01T15:00:00"
 * - Relative: "en N minutos", "en N horas", "en N horas y M minutos"
 * - Tomorrow: "mañana a las H" or "mañana a las H:MM"
 * - Today: "hoy a las H" or "hoy a las H:MM" (error if past)
 * - Weekday: "el lunes/martes/.../domingo a las H[:MM]"
 *
 * Design: All parsing is regex-based and deterministic. No LLM involved.
 */

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('date-parser');

/**
 * Result of date parsing attempt.
 */
export interface DateParseResult {
  success: boolean;
  datetime?: Date;
  error?: string;
  suggestion?: string;
  /** Human-readable formatted time for confirmation */
  formatted?: string;
}

/**
 * Weekday name to JS Date day number mapping (0=Sunday, 1=Monday, etc.)
 */
const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miércoles: 3,
  miercoles: 3, // Without accent
  jueves: 4,
  viernes: 5,
  sábado: 6,
  sabado: 6, // Without accent
};

/**
 * Validate that a timezone string is a valid IANA timezone.
 */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a date for human display in Spanish.
 */
function formatDateTime(date: Date, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  };

  return date.toLocaleString('es-AR', options);
}

/**
 * Parse ISO 8601 datetime string.
 */
function parseISO(input: string, timezone: string): DateParseResult | null {
  // Match ISO 8601: YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS
  const isoRegex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
  const match = input.match(isoRegex);

  if (!match) return null;

  const year = match[1]!;
  const month = match[2]!;
  const day = match[3]!;
  const hour = match[4]!;
  const minute = match[5]!;
  const date = new Date(
    parseInt(year, 10),
    parseInt(month, 10) - 1,
    parseInt(day, 10),
    parseInt(hour, 10),
    parseInt(minute, 10),
    0,
    0
  );

  if (isNaN(date.getTime())) {
    return {
      success: false,
      error: 'Fecha ISO inválida',
    };
  }

  return {
    success: true,
    datetime: date,
    formatted: formatDateTime(date, timezone),
  };
}

/**
 * Parse relative time in Spanish and English:
 * Spanish: "en N minutos", "en N horas", "en N horas y M minutos"
 * English: "N minutes", "N hours", "in N minutes", "N hours and M minutes"
 */
function parseRelative(input: string, now: Date): DateParseResult | null {
  // Spanish: "en N minuto(s)"
  const minutesOnlyEs = input.match(/^en\s+(\d+)\s+minutos?$/i);
  if (minutesOnlyEs) {
    const minutes = parseInt(minutesOnlyEs[1]!, 10);
    const result = new Date(now.getTime() + minutes * 60 * 1000);
    return {
      success: true,
      datetime: result,
    };
  }

  // English: "N minute(s)" or "in N minute(s)"
  const minutesOnlyEn = input.match(/^(?:in\s+)?(\d+)\s+minutes?$/i);
  if (minutesOnlyEn) {
    const minutes = parseInt(minutesOnlyEn[1]!, 10);
    const result = new Date(now.getTime() + minutes * 60 * 1000);
    return {
      success: true,
      datetime: result,
    };
  }

  // Spanish: "en N hora(s)"
  const hoursOnlyEs = input.match(/^en\s+(\d+)\s+horas?$/i);
  if (hoursOnlyEs) {
    const hours = parseInt(hoursOnlyEs[1]!, 10);
    const result = new Date(now.getTime() + hours * 60 * 60 * 1000);
    return {
      success: true,
      datetime: result,
    };
  }

  // English: "N hour(s)" or "in N hour(s)"
  const hoursOnlyEn = input.match(/^(?:in\s+)?(\d+)\s+hours?$/i);
  if (hoursOnlyEn) {
    const hours = parseInt(hoursOnlyEn[1]!, 10);
    const result = new Date(now.getTime() + hours * 60 * 60 * 1000);
    return {
      success: true,
      datetime: result,
    };
  }

  // Spanish: "en N hora(s) y M minuto(s)"
  const compoundEs = input.match(/^en\s+(\d+)\s+horas?\s+y\s+(\d+)\s+minutos?$/i);
  if (compoundEs) {
    const hours = parseInt(compoundEs[1]!, 10);
    const minutes = parseInt(compoundEs[2]!, 10);
    const totalMs = (hours * 60 + minutes) * 60 * 1000;
    const result = new Date(now.getTime() + totalMs);
    return {
      success: true,
      datetime: result,
    };
  }

  // English: "N hour(s) and M minute(s)" or "in N hour(s) and M minute(s)"
  const compoundEn = input.match(/^(?:in\s+)?(\d+)\s+hours?\s+and\s+(\d+)\s+minutes?$/i);
  if (compoundEn) {
    const hours = parseInt(compoundEn[1]!, 10);
    const minutes = parseInt(compoundEn[2]!, 10);
    const totalMs = (hours * 60 + minutes) * 60 * 1000;
    const result = new Date(now.getTime() + totalMs);
    return {
      success: true,
      datetime: result,
    };
  }

  return null;
}

/**
 * Parse time string like "9", "15", "9:30", "21:45"
 * Returns hour (0-23) and minute.
 * For ambiguous hours 1-11, caller decides interpretation.
 */
function parseTime(timeStr: string): { hour: number; minute: number } | null {
  // Match HH:MM or H:MM
  const withMinutes = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (withMinutes) {
    const hour = parseInt(withMinutes[1]!, 10);
    const minute = parseInt(withMinutes[2]!, 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
    return null;
  }

  // Match just hour: H or HH
  const hourOnly = timeStr.match(/^(\d{1,2})$/);
  if (hourOnly) {
    const hour = parseInt(hourOnly[1]!, 10);
    if (hour >= 0 && hour <= 23) {
      return { hour, minute: 0 };
    }
    return null;
  }

  return null;
}

/**
 * Parse "mañana a las H[:MM]"
 */
function parseTomorrow(
  input: string,
  timezone: string,
  now: Date
): DateParseResult | null {
  const match = input.match(/^mañana\s+a\s+las?\s+(\d{1,2}(?::\d{2})?)$/i);
  if (!match) return null;

  const timeStr = match[1]!;
  const parsed = parseTime(timeStr);
  if (!parsed) {
    return {
      success: false,
      error: 'Hora inválida',
      suggestion: 'Usá formato HH:MM, ej: "mañana a las 9:30"',
    };
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(parsed.hour, parsed.minute, 0, 0);

  return {
    success: true,
    datetime: tomorrow,
    formatted: formatDateTime(tomorrow, timezone),
  };
}

/**
 * Parse "hoy a las H[:MM]"
 * Error if time is in the past.
 *
 * Hour disambiguation rule:
 * - If hour is 1-11 and current time is still AM (before noon):
 *   - If AM interpretation is past, convert to PM (user probably means "later today")
 * - If hour is 1-11 and current time is PM (after noon):
 *   - Interpret as AM literally. If past, error (user meant morning, missed it).
 */
function parseToday(
  input: string,
  timezone: string,
  now: Date
): DateParseResult | null {
  const match = input.match(/^hoy\s+a\s+las?\s+(\d{1,2}(?::\d{2})?)$/i);
  if (!match) return null;

  const timeStr = match[1]!;
  const parsed = parseTime(timeStr);
  if (!parsed) {
    return {
      success: false,
      error: 'Hora inválida',
      suggestion: 'Usá formato HH:MM, ej: "hoy a las 15:30"',
    };
  }

  const { hour, minute } = parsed;
  const currentHour = now.getHours();

  // For 12-23 or 0 (midnight), no disambiguation needed
  if (hour === 0 || hour >= 12) {
    const today = new Date(now);
    today.setHours(hour, minute, 0, 0);

    // Check if time is in the past
    if (today.getTime() < now.getTime()) {
      const suggestedTime =
        minute > 0 ? `${hour}:${minute.toString().padStart(2, '0')}` : `${hour}`;
      return {
        success: false,
        error: `La hora ${suggestedTime} ya pasó hoy`,
        suggestion: `Probá con "mañana a las ${suggestedTime}"`,
      };
    }

    return {
      success: true,
      datetime: today,
      formatted: formatDateTime(today, timezone),
    };
  }

  // Hour is 1-11, needs disambiguation
  const amTime = new Date(now);
  amTime.setHours(hour, minute, 0, 0);

  const pmTime = new Date(now);
  pmTime.setHours(hour + 12, minute, 0, 0);

  const isAmPast = amTime.getTime() < now.getTime();
  const isPmPast = pmTime.getTime() < now.getTime();
  const isCurrentlyAM = currentHour < 12;

  // Rule: If we're still in AM hours and AM is past, convert to PM
  // If we're in PM hours, interpret literally as AM (if past, error)
  if (isCurrentlyAM && isAmPast && !isPmPast) {
    // We're in the morning, AM time passed, use PM
    return {
      success: true,
      datetime: pmTime,
      formatted: formatDateTime(pmTime, timezone),
    };
  }

  if (isAmPast) {
    // AM is past and we can't convert to PM (either we're in PM or PM is also past)
    const suggestedTime =
      minute > 0 ? `${hour}:${minute.toString().padStart(2, '0')}` : `${hour}`;
    return {
      success: false,
      error: `La hora ${suggestedTime} ya pasó hoy`,
      suggestion: `Probá con "mañana a las ${suggestedTime}"`,
    };
  }

  // AM is still in the future - but should we interpret as AM or PM?
  // If current time is AM, user probably means PM for hours like "3"
  // If current time is PM, user probably means tomorrow's AM... but we say "hoy", so error might be confusing
  // Conservative: if AM is in the future, use PM anyway (people say "a las 3" meaning 3 PM)
  return {
    success: true,
    datetime: pmTime,
    formatted: formatDateTime(pmTime, timezone),
  };
}

/**
 * Parse "el [weekday] a las H[:MM]"
 * Always resolves to next occurrence (if today is that weekday, go to next week).
 */
function parseWeekday(
  input: string,
  timezone: string,
  now: Date
): DateParseResult | null {
  const match = input.match(
    /^el\s+(lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo)\s+a\s+las?\s+(\d{1,2}(?::\d{2})?)$/i
  );
  if (!match) return null;

  const weekdayName = match[1]!.toLowerCase();
  const timeStr = match[2]!;

  const targetDay = WEEKDAYS[weekdayName];
  if (targetDay === undefined) {
    return {
      success: false,
      error: `Día de la semana no reconocido: ${weekdayName}`,
    };
  }

  const parsed = parseTime(timeStr);
  if (!parsed) {
    return {
      success: false,
      error: 'Hora inválida',
      suggestion: `Usá formato HH:MM, ej: "el ${weekdayName} a las 10:00"`,
    };
  }

  const currentDay = now.getDay();

  // Calculate days until target weekday
  // If today is the target weekday, we go to NEXT week (add 7)
  let daysUntil = targetDay - currentDay;
  if (daysUntil <= 0) {
    daysUntil += 7;
  }

  const targetDate = new Date(now);
  targetDate.setDate(targetDate.getDate() + daysUntil);
  targetDate.setHours(parsed.hour, parsed.minute, 0, 0);

  return {
    success: true,
    datetime: targetDate,
    formatted: formatDateTime(targetDate, timezone),
  };
}

/**
 * Check for unsupported but common patterns and return helpful errors.
 */
function checkUnsupportedPatterns(input: string): DateParseResult | null {
  // "a las X" without day
  if (/^a\s+las?\s+\d+/i.test(input)) {
    return {
      success: false,
      error: 'Falta especificar el día',
      suggestion: 'Especificá el día: "hoy a las 3" o "mañana a las 3"',
    };
  }

  // "en un rato" or other vague expressions
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

  // "pasado mañana" (could support in future, but currently ambiguous without time)
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
 * Main parsing function.
 *
 * @param input - The natural language date/time string
 * @param timezone - IANA timezone (e.g., "America/Argentina/Buenos_Aires")
 * @param now - Optional override for current time (for testing)
 * @returns DateParseResult with success status, datetime, or error
 */
export function parseDateTime(
  input: string,
  timezone: string,
  now?: Date
): DateParseResult {
  // Validate timezone first
  if (!isValidTimezone(timezone)) {
    logger.error('Invalid timezone', { timezone });
    return {
      success: false,
      error: `timezone inválido: "${timezone}". Usá formato IANA, ej: "America/Argentina/Buenos_Aires"`,
    };
  }

  // Use current time if not provided
  // NOTE: new Date() returns the correct UTC timestamp regardless of system timezone.
  // Relative calculations ("in 5 minutes") work correctly because we add milliseconds
  // to the current UTC timestamp. The timezone parameter is only used for formatting.
  const currentTime = now ?? new Date();

  // Normalize input: trim, collapse whitespace, lowercase for matching
  const normalized = input.trim().replace(/\s+/g, ' ').toLowerCase();

  // Empty input
  if (!normalized) {
    return {
      success: false,
      error: 'Entrada vacía',
      suggestion: 'Especificá cuándo: "en 30 minutos", "mañana a las 9", etc.',
    };
  }

  // Try ISO 8601 first (use original case for ISO)
  const isoResult = parseISO(input.trim(), timezone);
  if (isoResult) {
    if (isoResult.success && isoResult.datetime) {
      isoResult.formatted = formatDateTime(isoResult.datetime, timezone);
    }
    return isoResult;
  }

  // Try relative time
  const relativeResult = parseRelative(normalized, currentTime);
  if (relativeResult) {
    if (relativeResult.success && relativeResult.datetime) {
      relativeResult.formatted = formatDateTime(relativeResult.datetime, timezone);
    }
    return relativeResult;
  }

  // Try "mañana a las X"
  const tomorrowResult = parseTomorrow(normalized, timezone, currentTime);
  if (tomorrowResult) {
    return tomorrowResult;
  }

  // Try "hoy a las X"
  const todayResult = parseToday(normalized, timezone, currentTime);
  if (todayResult) {
    return todayResult;
  }

  // Try "el [weekday] a las X"
  const weekdayResult = parseWeekday(normalized, timezone, currentTime);
  if (weekdayResult) {
    return weekdayResult;
  }

  // Check for common unsupported patterns with helpful errors
  const unsupportedResult = checkUnsupportedPatterns(normalized);
  if (unsupportedResult) {
    return unsupportedResult;
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

export default parseDateTime;

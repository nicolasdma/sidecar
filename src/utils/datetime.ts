/**
 * DateTime Module - Manejo robusto de fechas/horas con Luxon
 *
 * INVARIANTES:
 * 1. Internamente siempre UTC - todas las funciones retornan DateTime en UTC
 * 2. Parsing respeta timezone del usuario - "15:00" en BA = 18:00 UTC
 * 3. Display convierte a TZ del usuario - 18:00 UTC → "15:00" si user en BA
 *
 * Usa Luxon para:
 * - Manejo correcto de timezones (no depende de TZ del proceso)
 * - Soporte de DST (Daylight Saving Time)
 * - API immutable y type-safe
 */

import { DateTime } from 'luxon';

// ============= Testing Support =============

/**
 * Mock "now" for deterministic testing.
 * When set, all functions use this instead of actual current time.
 * ONLY use in tests via setMockNow() / clearMockNow().
 */
let mockNow: DateTime | null = null;

/**
 * Set a mock "now" for testing. All datetime functions will use this.
 * The Date is treated as a specific instant in time (UTC).
 *
 * @param date - JS Date or DateTime to use as "now"
 */
export function setMockNow(date: Date | DateTime): void {
  mockNow = date instanceof DateTime ? date.toUTC() : DateTime.fromJSDate(date).toUTC();
}

/**
 * Clear mock "now", returning to real time.
 */
export function clearMockNow(): void {
  mockNow = null;
}

/**
 * Get current time (respects mock if set).
 */
function getNow(): DateTime {
  return mockNow ?? DateTime.utc();
}

/**
 * Get current time in a specific timezone (respects mock if set).
 */
function getNowInZone(zone: string): DateTime {
  const now = mockNow ?? DateTime.utc();
  return now.setZone(zone);
}

// ============= Tipos =============

export interface ParsedDateTime {
  datetime: DateTime;
  formatted: string;
}

export type ParseResult =
  | { success: true; result: ParsedDateTime }
  | { success: false; error: string; suggestion?: string };

// ============= Core: Crear DateTime en TZ del Usuario =============

/**
 * Crea un DateTime para "hoy" o días futuros a una hora específica,
 * en la timezone del usuario, y lo convierte a UTC.
 *
 * @throws Error si la hora no existe (DST gap)
 */
export function createDateTimeInUserTz(
  userTz: string,
  options: {
    hour: number;
    minute?: number;
    daysFromNow?: number;
  }
): DateTime {
  const now = getNowInZone(userTz);

  let target = now.set({
    hour: options.hour,
    minute: options.minute ?? 0,
    second: 0,
    millisecond: 0,
  });

  if (options.daysFromNow) {
    target = target.plus({ days: options.daysFromNow });
  }

  // DST edge-case: la hora puede no existir en cambio de horario
  if (!target.isValid) {
    throw new Error(
      `Hora ${options.hour}:${String(options.minute ?? 0).padStart(2, '0')} no existe en ${userTz} ` +
        `(probablemente cambio de horario). Razón: ${target.invalidReason}`
    );
  }

  return target.toUTC();
}

/**
 * Crea un DateTime para el próximo [día de semana] a una hora específica.
 *
 * @param weekday ISO weekday: 1=lunes, 7=domingo
 * @throws Error si la hora no existe (DST gap)
 */
export function createDateTimeForWeekday(
  userTz: string,
  weekday: number,
  hour: number,
  minute: number = 0
): DateTime {
  const now = getNowInZone(userTz);

  // Calcular días hasta el próximo [weekday]
  let daysUntil = weekday - now.weekday;
  if (daysUntil <= 0) {
    daysUntil += 7; // Siempre ir al próximo, no hoy
  }

  const target = now.plus({ days: daysUntil }).set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });

  if (!target.isValid) {
    throw new Error(
      `Hora ${hour}:${String(minute).padStart(2, '0')} no existe en ${userTz} para ese día ` +
        `(cambio de horario). Razón: ${target.invalidReason}`
    );
  }

  return target.toUTC();
}

/**
 * Crea un DateTime relativo ("en N minutos/horas").
 * No afectado por DST ya que es offset desde ahora.
 */
export function createRelativeDateTime(
  hours: number = 0,
  minutes: number = 0
): DateTime {
  return getNow().plus({ hours, minutes });
}

// ============= Validación =============

/**
 * Verifica que un DateTime no esté en el pasado.
 * Compara en UTC para evitar problemas de TZ.
 */
export function isInFuture(dt: DateTime): boolean {
  return dt.toMillis() > getNow().toMillis();
}

/**
 * Verifica que una timezone sea válida (IANA format).
 */
export function isValidTimezone(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid;
}

// ============= Conversión DB ↔ DateTime =============

/**
 * Convierte DateTime a ISO string UTC para guardar en DB.
 * SIEMPRE produce formato con 'Z' (UTC).
 */
export function toDbString(dt: DateTime): string {
  return dt.toUTC().toISO()!;
}

/**
 * Parsea ISO string de DB a DateTime UTC.
 *
 * NOTA: Strings sin 'Z' se asumen UTC (backward compatibility con
 * datos legacy de antes del fix con Luxon). Todo código nuevo DEBE
 * usar toDbString() que siempre incluye 'Z'.
 * NO extender este hack a nuevos casos.
 */
export function fromDbString(isoString: string): DateTime {
  const normalized = isoString.endsWith('Z') ? isoString : isoString + 'Z';
  return DateTime.fromISO(normalized, { zone: 'utc' });
}

// ============= Display =============

const DEFAULT_LOCALE = 'es-AR';

/**
 * Formatea un DateTime para mostrar al usuario en su timezone.
 */
export function formatForUser(
  dt: DateTime,
  userTz: string,
  locale: string = DEFAULT_LOCALE
): string {
  return dt.setZone(userTz).toLocaleString(
    {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    },
    { locale }
  );
}

/**
 * Formato corto para listados.
 */
export function formatShort(
  dt: DateTime,
  userTz: string,
  locale: string = DEFAULT_LOCALE
): string {
  return dt.setZone(userTz).toLocaleString(
    {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    },
    { locale }
  );
}

// ============= Utilidades =============

/**
 * Calcula milisegundos hasta un DateTime (para setTimeout).
 * Nunca retorna negativo.
 */
export function msUntil(dt: DateTime): number {
  return Math.max(0, dt.toMillis() - getNow().toMillis());
}

/**
 * Obtiene DateTime actual en la timezone del usuario.
 */
export function nowInUserTz(userTz: string): DateTime {
  return getNowInZone(userTz);
}

/**
 * Obtiene la hora actual (0-23) en la timezone del usuario.
 */
export function currentHourInUserTz(userTz: string): number {
  return getNowInZone(userTz).hour;
}

/**
 * Convierte DateTime a JS Date (para compatibilidad con APIs existentes).
 */
export function toJSDate(dt: DateTime): Date {
  return dt.toJSDate();
}

// Re-export DateTime para uso directo cuando sea necesario
export { DateTime } from 'luxon';

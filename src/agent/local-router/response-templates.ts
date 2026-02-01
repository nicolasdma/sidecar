/**
 * Response Templates - Fase 3.5
 *
 * Template responses for direct tool execution.
 * Multiple variants per intent to avoid robotic responses.
 */

import type { Intent } from './types.js';

type TemplateFunction<T = unknown> = (data: T) => string;

interface TimeData {
  time: string;
  date: string;
  day: string;
}

interface WeatherData {
  location: string;
  temperature: string;
  feelsLike: string;
  humidity: string;
  wind: string;
  condition: string;
  summary: string;
}

interface ReminderData {
  message: string;
  formattedTime: string;
}

interface ReminderListData {
  count: number;
  reminders: string[];
  message: string;
}

interface CancelReminderData {
  message: string;
}

/**
 * Templates for time responses.
 */
const TIME_TEMPLATES: {
  success: TemplateFunction<TimeData>[];
} = {
  success: [
    (d) => `Son las ${d.time}.`,
    (d) => `${d.time}.`,
    (d) => `Ahora son las ${d.time}.`,
    (d) => `${d.time}, ${d.date}.`,
  ],
};

/**
 * Templates for weather responses.
 */
const WEATHER_TEMPLATES: {
  success: TemplateFunction<WeatherData>[];
  error: TemplateFunction<string>[];
} = {
  success: [
    (w) => `En ${w.location}: ${w.condition}, ${w.temperature}.`,
    (w) => `${w.location}: ${w.temperature} y ${w.condition.toLowerCase()}.`,
    (w) => w.summary,
  ],
  error: [
    () => `No pude obtener el clima.`,
    () => `Falló la consulta del clima.`,
    (err) => `Error obteniendo clima: ${err}`,
  ],
};

/**
 * Templates for reminder creation.
 */
const REMINDER_TEMPLATES: {
  success: TemplateFunction<ReminderData>[];
  error: TemplateFunction<string>[];
} = {
  success: [
    (d) => `Listo, te voy a recordar "${d.message}" el ${d.formattedTime}.`,
    (d) => `Dale, te aviso ${d.formattedTime} sobre "${d.message}".`,
    (d) => `Anotado: "${d.message}" para el ${d.formattedTime}.`,
    (d) => `Perfecto, recordatorio creado para el ${d.formattedTime}: "${d.message}".`,
  ],
  error: [(err) => `No pude crear el recordatorio: ${err}`],
};

/**
 * Templates for listing reminders.
 */
const LIST_REMINDERS_TEMPLATES: {
  empty: TemplateFunction<void>[];
  success: TemplateFunction<ReminderListData>[];
} = {
  empty: [
    () => `No tenés recordatorios pendientes.`,
    () => `Tu lista de recordatorios está vacía.`,
    () => `No hay recordatorios activos.`,
  ],
  success: [
    (d) =>
      `Tenés ${d.count} recordatorio${d.count === 1 ? '' : 's'} pendiente${d.count === 1 ? '' : 's'}:\n${d.reminders.join('\n')}`,
  ],
};

/**
 * Templates for canceling reminders.
 */
const CANCEL_REMINDER_TEMPLATES: {
  success: TemplateFunction<CancelReminderData>[];
  notFound: TemplateFunction<void>[];
  error: TemplateFunction<string>[];
} = {
  success: [
    (d) => `Cancelé el recordatorio: "${d.message}"`,
    (d) => `Listo, borré el recordatorio de "${d.message}"`,
    (d) => `Eliminado: "${d.message}"`,
  ],
  notFound: [
    () => `No encontré ese recordatorio.`,
    () => `No hay un recordatorio que coincida.`,
  ],
  error: [(err) => `No pude cancelar el recordatorio: ${err}`],
};

/**
 * Pick a random template from an array.
 */
function pickTemplate<T>(templates: TemplateFunction<T>[]): TemplateFunction<T> {
  const idx = Math.floor(Math.random() * templates.length);
  return templates[idx]!;
}

/**
 * Generate a response for time intent.
 */
export function generateTimeResponse(data: TimeData): string {
  return pickTemplate(TIME_TEMPLATES.success)(data);
}

/**
 * Generate a response for weather intent.
 */
export function generateWeatherResponse(
  success: boolean,
  data?: WeatherData,
  error?: string
): string {
  if (success && data) {
    return pickTemplate(WEATHER_TEMPLATES.success)(data);
  }
  return pickTemplate(WEATHER_TEMPLATES.error)(error || 'Error desconocido');
}

/**
 * Generate a response for reminder creation.
 */
export function generateReminderResponse(
  success: boolean,
  data?: ReminderData,
  error?: string
): string {
  if (success && data) {
    return pickTemplate(REMINDER_TEMPLATES.success)(data);
  }
  return pickTemplate(REMINDER_TEMPLATES.error)(error || 'Error desconocido');
}

/**
 * Generate a response for listing reminders.
 */
export function generateListRemindersResponse(data: ReminderListData): string {
  if (data.count === 0) {
    return pickTemplate(LIST_REMINDERS_TEMPLATES.empty)();
  }
  return pickTemplate(LIST_REMINDERS_TEMPLATES.success)(data);
}

/**
 * Generate a response for canceling a reminder.
 */
export function generateCancelReminderResponse(
  success: boolean,
  data?: CancelReminderData,
  notFound?: boolean,
  error?: string
): string {
  if (notFound) {
    return pickTemplate(CANCEL_REMINDER_TEMPLATES.notFound)();
  }
  if (success && data) {
    return pickTemplate(CANCEL_REMINDER_TEMPLATES.success)(data);
  }
  return pickTemplate(CANCEL_REMINDER_TEMPLATES.error)(error || 'Error desconocido');
}

/**
 * Map of intent to response generator function name (for documentation).
 */
export const INTENT_RESPONSE_MAP: Record<
  Extract<Intent, 'time' | 'weather' | 'reminder' | 'list_reminders' | 'cancel_reminder'>,
  string
> = {
  time: 'generateTimeResponse',
  weather: 'generateWeatherResponse',
  reminder: 'generateReminderResponse',
  list_reminders: 'generateListRemindersResponse',
  cancel_reminder: 'generateCancelReminderResponse',
};

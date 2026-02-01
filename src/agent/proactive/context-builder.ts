/**
 * Context Builder for Spontaneous Messages
 *
 * Builds the context object that the LLM uses to decide
 * whether to send a spontaneous message.
 */

import {
  type SpontaneousContext,
  type ProactiveConfig,
  DEFAULT_PROACTIVE_CONFIG,
  isWithinQuietHours,
} from './types.js';
import {
  loadProactiveState,
  canSendSpontaneous,
  canSendGreeting,
} from './state.js';
import {
  countSpontaneousMessagesInLastHour,
  countSpontaneousMessagesToday,
} from '../../memory/store.js';
import { loadLearnings } from '../../memory/knowledge.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('context-builder');

/**
 * Get top N relevant facts for context.
 * For now, just returns recent facts. In future, could use embeddings.
 */
async function getRelevantFacts(limit: number = 5): Promise<string[]> {
  try {
    const learnings = await loadLearnings();
    const facts: string[] = [];

    // Extract facts from parsed learnings
    for (const fact of learnings.facts) {
      facts.push(`[w:${fact.weight}] ${fact.text}`);
    }

    // Sort by weight (higher first) and take top N
    facts.sort((a, b) => {
      const weightA = parseInt(a.match(/\[w:(\d+)\]/)?.[1] ?? '1', 10);
      const weightB = parseInt(b.match(/\[w:(\d+)\]/)?.[1] ?? '1', 10);
      return weightB - weightA;
    });

    return facts.slice(0, limit);
  } catch (error) {
    logger.error('Error loading facts for context', { error });
    return [];
  }
}

/**
 * Get Spanish day name.
 */
function getDayName(date: Date): string {
  const days = [
    'domingo',
    'lunes',
    'martes',
    'miércoles',
    'jueves',
    'viernes',
    'sábado',
  ];
  return days[date.getDay()] ?? 'desconocido';
}

/**
 * Format time as HH:MM.
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Format date as YYYY-MM-DD.
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0] ?? '';
}

/**
 * Calculate minutes since a date.
 */
function minutesSince(date: Date | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 60000);
}

/**
 * Calculate hours since a date.
 */
function hoursSince(date: Date | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 3600000);
}

/**
 * Build the context object for spontaneous message decisions.
 */
export async function buildSpontaneousContext(
  config: ProactiveConfig = DEFAULT_PROACTIVE_CONFIG
): Promise<SpontaneousContext> {
  const now = new Date();
  const currentHour = now.getHours();
  const state = loadProactiveState(config.timezone);
  const todayStr = formatDate(now);

  // Check constraints
  const spontaneousCheck = canSendSpontaneous(config);
  const greetingCheck = canSendGreeting(config);

  // Get rate limit info
  const hourlyCount = countSpontaneousMessagesInLastHour();
  const dailyCount = countSpontaneousMessagesToday(config.timezone);

  // Check if greeting already sent today
  const greetingAlreadySent =
    state.lastGreetingDate === todayStr &&
    state.lastGreetingType === greetingCheck.window;

  // Get relevant facts
  const relevantFacts = await getRelevantFacts(5);

  const context: SpontaneousContext = {
    // Time context
    currentTime: formatTime(now),
    currentDay: getDayName(now),
    currentDate: todayStr,

    // Activity context
    minutesSinceLastUserMessage: minutesSince(state.lastUserMessageAt),
    hoursSinceLastUserActivity: hoursSince(state.lastUserActivityAt),

    // Constraints
    isQuietHours: isWithinQuietHours(
      currentHour,
      config.quietHoursStart,
      config.quietHoursEnd
    ),
    isGreetingWindow: greetingCheck.window,
    greetingAlreadySent,
    remainingSpontaneousToday: Math.max(0, config.maxSpontaneousPerDay - dailyCount),
    remainingSpontaneousThisHour: Math.max(0, config.maxSpontaneousPerHour - hourlyCount),
    cooldownActive: !spontaneousCheck.allowed && spontaneousCheck.reason === 'cooldown_active',

    // Memory context
    relevantFacts,

    // User preferences
    proactivityLevel: config.proactivityLevel,
  };

  logger.debug('Built spontaneous context', {
    time: context.currentTime,
    day: context.currentDay,
    isQuietHours: context.isQuietHours,
    isGreetingWindow: context.isGreetingWindow,
    greetingAlreadySent: context.greetingAlreadySent,
    remainingToday: context.remainingSpontaneousToday,
    remainingHour: context.remainingSpontaneousThisHour,
    factCount: context.relevantFacts.length,
  });

  return context;
}

/**
 * Build prompt for LLM to decide on spontaneous message.
 */
export function buildDecisionPrompt(context: SpontaneousContext): string {
  let prompt = `Sos un compañero AI evaluando si debés enviar un mensaje espontáneo.

## Contexto Actual
- Hora: ${context.currentTime}
- Día: ${context.currentDay}
- Fecha: ${context.currentDate}

## Actividad del Usuario
`;

  if (context.minutesSinceLastUserMessage !== null) {
    prompt += `- Último mensaje del usuario hace: ${context.minutesSinceLastUserMessage} minutos\n`;
  } else {
    prompt += `- No hay mensajes previos del usuario\n`;
  }

  if (context.hoursSinceLastUserActivity !== null) {
    prompt += `- Última actividad hace: ${context.hoursSinceLastUserActivity} horas\n`;
  }

  prompt += `
## Restricciones
- Mensajes espontáneos restantes hoy: ${context.remainingSpontaneousToday}
- Mensajes espontáneos restantes esta hora: ${context.remainingSpontaneousThisHour}
- Nivel de proactividad configurado: ${context.proactivityLevel}
`;

  if (context.isQuietHours) {
    prompt += `- ⚠️ ESTAMOS EN QUIET HOURS - NO envíes mensajes espontáneos\n`;
  }

  if (context.cooldownActive) {
    prompt += `- ⚠️ Cooldown activo - NO envíes mensajes\n`;
  }

  if (context.isGreetingWindow) {
    prompt += `\n## Ventana de Saludo: ${context.isGreetingWindow}\n`;
    if (context.greetingAlreadySent) {
      prompt += `- ⚠️ Ya enviaste saludo de ${context.isGreetingWindow} hoy - NO repitas\n`;
    } else {
      prompt += `- Podés enviar un saludo de ${context.isGreetingWindow} si es apropiado\n`;
    }
  }

  if (context.relevantFacts.length > 0) {
    prompt += `\n## Facts Conocidos del Usuario\n`;
    for (const fact of context.relevantFacts) {
      prompt += `- ${fact}\n`;
    }
  }

  prompt += `
## Tu Decisión

Decidí si debés enviar un mensaje ahora. Considerá:
1. ¿Es un buen momento? (hora del día, día de la semana)
2. ¿Tenés algo útil o relevante que decir?
3. ¿Es demasiado pronto desde el último mensaje?
4. ¿El usuario parece ocupado o ausente?

IMPORTANTE: Es mejor NO hablar que molestar al usuario sin razón.
Si no tenés algo genuinamente útil que decir, NO hables.

Respondé en este formato JSON exacto:
{
  "shouldSpeak": true/false,
  "reason": "explicación breve de tu decisión",
  "messageType": "greeting" | "checkin" | "contextual" | "none",
  "message": "el mensaje a enviar (solo si shouldSpeak es true)"
}`;

  return prompt;
}

export default buildSpontaneousContext;

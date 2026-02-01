/**
 * Command Handler
 *
 * Handles CLI commands like /quiet, /reminders, /proactive.
 */

import type { CommandHandler, ChannelType } from './types.js';
import {
  getPendingReminders,
  cancelAllReminders,
  type ReminderRow,
  type FactDomain,
} from '../memory/store.js';
import {
  enableQuietMode,
  disableQuietMode,
  getProactiveStatus,
  loadProactiveState,
} from '../agent/proactive/state.js';
import { forceTick as forceReminderTick } from '../agent/proactive/reminder-scheduler.js';
import {
  forceTick as forceSpontaneousTick,
  getConfig as getProactiveConfig,
} from '../agent/proactive/spontaneous-loop.js';
import { buildSpontaneousContext } from '../agent/proactive/context-builder.js';
import { clearHistory } from '../memory/store.js';
import {
  saveFact,
  getFactsByDomain,
  getFactsStats,
  getTotalFactsCount,
} from '../memory/facts-store.js';

/**
 * Parse duration string like "1h", "30m", "2h".
 * Returns milliseconds.
 */
function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)\s*(h|m|hora|min|minuto|horas|minutos)?$/i);
  if (!match) return null;

  const value = parseInt(match[1]!, 10);
  const unit = (match[2] ?? 'h').toLowerCase();

  if (unit.startsWith('m')) {
    return value * 60 * 1000;
  }
  return value * 60 * 60 * 1000; // Default to hours
}

/**
 * Format a reminder for display.
 */
function formatReminder(reminder: ReminderRow, timezone: string = 'UTC'): string {
  const triggerAt = new Date(reminder.trigger_at);
  const formattedTime = triggerAt.toLocaleString('es-AR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  });

  return `  [${reminder.id.slice(0, 8)}] ${reminder.message} - ${formattedTime}`;
}

/**
 * Default command handler implementation.
 */
export class DefaultCommandHandler implements CommandHandler {
  private isDebugMode: boolean;

  constructor(debugMode: boolean = false) {
    this.isDebugMode = debugMode || process.env.NODE_ENV === 'development';
  }

  async handle(
    command: string,
    args: string,
    _source: ChannelType
  ): Promise<string | null> {
    switch (command) {
      case 'exit':
      case 'quit':
      case 'q':
        return this.handleExit();

      case 'clear':
        return this.handleClear();

      case 'help':
        return this.handleHelp();

      case 'quiet':
        return this.handleQuiet(args);

      case 'reminders':
        return this.handleReminders(args);

      case 'proactive':
        return this.isDebugMode ? this.handleProactive(args) : null;

      case 'remember':
        return this.handleRemember(args);

      case 'facts':
        return this.handleFacts(args);

      default:
        return null; // Not handled - pass to LLM
    }
  }

  private handleExit(): string {
    // Note: Actual exit happens in CLI source
    process.exit(0);
  }

  private handleClear(): string {
    clearHistory();
    return 'Historial de conversación limpiado.';
  }

  private handleHelp(): string {
    let help = `
Comandos disponibles:
  /clear           - Limpiar historial de conversación
  /quiet [tiempo]  - Silenciar mensajes espontáneos
                     Ej: /quiet, /quiet 2h, /quiet 30m, /quiet off
  /reminders       - Listar recordatorios pendientes
  /reminders clear - Cancelar todos los recordatorios
  /remember "fact" - Guardar un fact explícitamente
                     Ej: /remember "Prefiero el café sin azúcar"
  /facts [domain]  - Listar facts guardados
                     Dominios: health, preferences, work, relationships,
                     schedule, goals, general, all
  /exit            - Salir del programa
  /help            - Mostrar esta ayuda
`;

    if (this.isDebugMode) {
      help += `
Comandos de debug (solo dev mode):
  /proactive status  - Ver estado del sistema proactivo
  /proactive tick    - Forzar tick del loop espontáneo
  /proactive context - Ver contexto actual
  /proactive reset   - Reset contadores
`;
    }

    return help;
  }

  private handleQuiet(args: string): string {
    const trimmedArgs = args.trim().toLowerCase();

    // /quiet off - disable quiet mode
    if (trimmedArgs === 'off') {
      disableQuietMode();
      return 'Modo silencioso desactivado. Los mensajes espontáneos están habilitados.';
    }

    // Default duration: 1 hour
    let durationMs = 60 * 60 * 1000;
    let durationStr = '1 hora';

    if (trimmedArgs) {
      const parsed = parseDuration(trimmedArgs);
      if (!parsed) {
        return `Duración inválida: "${trimmedArgs}". Usá: /quiet 2h, /quiet 30m, /quiet off`;
      }
      durationMs = parsed;

      // Format for display
      const hours = Math.floor(durationMs / (60 * 60 * 1000));
      const minutes = Math.floor((durationMs % (60 * 60 * 1000)) / (60 * 1000));

      if (hours > 0 && minutes > 0) {
        durationStr = `${hours}h ${minutes}m`;
      } else if (hours > 0) {
        durationStr = `${hours} hora${hours > 1 ? 's' : ''}`;
      } else {
        durationStr = `${minutes} minuto${minutes > 1 ? 's' : ''}`;
      }
    }

    enableQuietMode(durationMs);

    const until = new Date(Date.now() + durationMs);
    const untilStr = until.toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
    });

    return `Modo silencioso activado por ${durationStr} (hasta las ${untilStr}).
Los recordatorios SÍ se seguirán enviando.
Usá /quiet off para desactivar antes.`;
  }

  private handleReminders(args: string): string {
    const trimmedArgs = args.trim().toLowerCase();

    // /reminders clear - cancel all
    if (trimmedArgs === 'clear') {
      const count = cancelAllReminders();
      if (count === 0) {
        return 'No había recordatorios pendientes.';
      }
      return `Cancelados ${count} recordatorio${count > 1 ? 's' : ''}.`;
    }

    // /reminders - list all
    const reminders = getPendingReminders();

    if (reminders.length === 0) {
      return 'No tenés recordatorios pendientes.';
    }

    const config = getProactiveConfig();
    const formatted = reminders.map((r) => formatReminder(r, config.timezone));

    return `Recordatorios pendientes (${reminders.length}):
${formatted.join('\n')}

Tip: Decí "cancela el de [texto]" para cancelar uno específico.`;
  }

  private async handleProactive(args: string): Promise<string> {
    const subcommand = args.trim().toLowerCase().split(/\s+/)[0];

    switch (subcommand) {
      case 'status': {
        const config = getProactiveConfig();
        const status = getProactiveStatus(config);
        return `Estado del sistema proactivo:
${JSON.stringify(status, null, 2)}`;
      }

      case 'tick': {
        try {
          await forceSpontaneousTick();
          return 'Tick espontáneo ejecutado. Ver logs para detalles.';
        } catch (error) {
          return `Error en tick: ${error instanceof Error ? error.message : 'unknown'}`;
        }
      }

      case 'reminder-tick': {
        try {
          await forceReminderTick();
          return 'Tick de reminders ejecutado. Ver logs para detalles.';
        } catch (error) {
          return `Error en tick: ${error instanceof Error ? error.message : 'unknown'}`;
        }
      }

      case 'context': {
        const config = getProactiveConfig();
        const context = await buildSpontaneousContext(config);
        return `Contexto espontáneo actual:
${JSON.stringify(context, null, 2)}`;
      }

      case 'reset': {
        const config = getProactiveConfig();
        // Reset state by re-initializing
        loadProactiveState(config.timezone);
        return 'Contadores reseteados (lazy reset en próximo load).';
      }

      default:
        return `Subcomando desconocido: "${subcommand}".
Disponibles: status, tick, reminder-tick, context, reset`;
    }
  }

  private handleRemember(args: string): string {
    const trimmedArgs = args.trim();

    // Parse quoted text: /remember "fact text here"
    const match = trimmedArgs.match(/^["'](.+?)["']$|^(.+)$/);
    if (!match) {
      return 'Uso: /remember "tu fact aquí"\nEj: /remember "Prefiero el café sin azúcar"';
    }

    const factText = (match[1] ?? match[2] ?? '').trim();

    if (!factText) {
      return 'Uso: /remember "tu fact aquí"\nEj: /remember "Prefiero el café sin azúcar"';
    }

    if (factText.length < 3) {
      return 'El fact es muy corto. Escribí algo más descriptivo.';
    }

    if (factText.length > 500) {
      return 'El fact es muy largo (máx 500 caracteres). Tratá de ser más conciso.';
    }

    // Detect domain from content
    const domain = detectDomainFromText(factText);

    try {
      const id = saveFact({
        domain,
        fact: factText,
        confidence: 'high', // Explicit saves are high confidence
        source: 'explicit',
      });

      return `Guardado en "${domain}": ${factText}\n(ID: ${id.slice(0, 8)})`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Error desconocido';
      return `Error guardando fact: ${msg}`;
    }
  }

  private handleFacts(args: string): string {
    const trimmedArgs = args.trim().toLowerCase();

    // /facts - show summary
    if (!trimmedArgs || trimmedArgs === 'all') {
      return this.showFactsSummary();
    }

    // /facts <domain> - show facts for domain
    const validDomains: FactDomain[] = [
      'health', 'preferences', 'work', 'relationships',
      'schedule', 'goals', 'general', 'decisions', 'personal', 'projects',
    ];

    if (validDomains.includes(trimmedArgs as FactDomain)) {
      return this.showFactsByDomain(trimmedArgs as FactDomain);
    }

    return `Dominio desconocido: "${trimmedArgs}".
Dominios válidos: ${validDomains.join(', ')}
O usá /facts sin argumentos para ver el resumen.`;
  }

  private showFactsSummary(): string {
    const stats = getFactsStats();
    const total = getTotalFactsCount();

    if (total === 0) {
      return 'No tenés facts guardados.\nUsá /remember "fact" para agregar uno.';
    }

    let output = `Facts guardados (${total} total):\n\n`;

    // Show non-zero domains
    const domainLabels: Record<FactDomain, string> = {
      health: 'Salud',
      preferences: 'Preferencias',
      work: 'Trabajo',
      relationships: 'Relaciones',
      schedule: 'Horarios',
      goals: 'Metas',
      general: 'General',
      decisions: 'Decisiones',
      personal: 'Personal',
      projects: 'Proyectos',
    };

    for (const [domain, count] of Object.entries(stats)) {
      if (count > 0) {
        const label = domainLabels[domain as FactDomain] ?? domain;
        output += `  ${label}: ${count}\n`;
      }
    }

    output += '\nUsá /facts <dominio> para ver facts específicos.';
    return output;
  }

  private showFactsByDomain(domain: FactDomain): string {
    const facts = getFactsByDomain(domain);

    if (facts.length === 0) {
      return `No hay facts en "${domain}".`;
    }

    let output = `Facts en "${domain}" (${facts.length}):\n\n`;

    for (const fact of facts) {
      const date = fact.lastConfirmedAt.toISOString().split('T')[0];
      const staleMarker = fact.stale ? ' [stale]' : '';
      output += `  - ${fact.fact}${staleMarker}\n    (${fact.confidence}, ${date})\n`;
    }

    return output;
  }
}

/**
 * Detects the most likely domain for a fact based on keywords.
 */
function detectDomainFromText(text: string): FactDomain {
  const lower = text.toLowerCase();

  // Health keywords
  if (/\b(alergi[ao]|médic|doctor|salud|enferm|medicament|hospital|dolor|sintoma|dieta|ejercicio)\b/.test(lower)) {
    return 'health';
  }

  // Work keywords
  if (/\b(trabaj|oficina|jefe|proyecto|reunión|deadline|cliente|empresa|sueldo|vacaciones)\b/.test(lower)) {
    return 'work';
  }

  // Relationships keywords
  if (/\b(familia|padre|madre|hijo|hija|hermano|hermana|amigo|pareja|novio|novia|esposo|esposa)\b/.test(lower)) {
    return 'relationships';
  }

  // Schedule keywords
  if (/\b(horario|rutina|mañana|tarde|noche|lunes|martes|miércoles|jueves|viernes|sábado|domingo|siempre a las)\b/.test(lower)) {
    return 'schedule';
  }

  // Goals keywords
  if (/\b(meta|objetivo|quiero|plan|futuro|sueño|esperanza|lograr|conseguir)\b/.test(lower)) {
    return 'goals';
  }

  // Preferences keywords
  if (/\b(prefier|gusta|favorit|odio|no me gusta|me encanta|amo|detesto)\b/.test(lower)) {
    return 'preferences';
  }

  return 'general';
}

export default DefaultCommandHandler;

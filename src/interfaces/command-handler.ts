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
import { getLocalRouter } from '../agent/local-router/index.js';
import { checkOllamaAvailability } from '../llm/ollama.js';
import { getEmbeddingsState } from '../memory/embeddings-state.js';
import { getPendingExtractionCount } from '../memory/store.js';
import { getPendingEmbeddingCount } from '../memory/store.js';
import {
  getSessionMetrics,
  getProactiveLoopHealth,
  getReminderSchedulerHealth,
  getExtractionQueueHealth,
  getEmbeddingQueueHealth,
  determineOverallHealth,
  type SubsystemHealth,
  type HealthStatus,
} from '../utils/metrics.js';
import {
  getMCPClientManager,
  loadMCPConfig,
  saveMCPConfig,
} from '../mcp/index.js';
import {
  getDeviceCapabilities,
  getDeviceProfile,
  getRouterMetrics,
  getMetricsSummary,
  getTierDescription,
  getOllamaHealthMonitor,
  resetSetupState,
  ensureModelsInstalled,
} from '../device/index.js';

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

      case 'router-stats':
        return this.handleRouterStats();

      case 'health':
        return this.handleHealth();

      case 'mcp':
        return this.handleMCP(args);

      case 'reset-models':
        return this.handleResetModels();

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
  /router-stats    - Ver estadísticas del LocalRouter
  /health          - Ver estado de salud del sistema
  /mcp             - Ver estado de servidores MCP
  /mcp enable <id> - Conectar servidor MCP (hot-reload)
  /mcp disable <id>- Desconectar servidor MCP
  /mcp tools <id>  - Listar tools de un servidor
  /mcp reload [id] - Reconectar servidor(es)
  /reset-models    - Reinstalar modelos esenciales de Ollama
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

  private handleRouterStats(): string {
    const router = getLocalRouter();
    const stats = router.getStats();
    const config = router.getConfig();

    // Get device info (Fase 3.6a)
    const capabilities = getDeviceCapabilities();
    const profile = getDeviceProfile();
    const v2Metrics = getRouterMetrics();
    const summary = getMetricsSummary();

    // Classic LocalRouter stats
    const localPct =
      stats.totalRequests > 0
        ? ((stats.routedLocal / stats.totalRequests) * 100).toFixed(1)
        : '0.0';
    const llmPct =
      stats.totalRequests > 0
        ? ((stats.routedToLlm / stats.totalRequests) * 100).toFixed(1)
        : '0.0';
    const successRate =
      stats.directSuccess + stats.directFailures > 0
        ? (
            (stats.directSuccess / (stats.directSuccess + stats.directFailures)) *
            100
          ).toFixed(1)
        : '0.0';

    let output = `
┌─────────────────────────────────────────────────────────────┐
│ Smart Router Stats                                           │`;

    // Add device info if available (Fase 3.6a)
    if (capabilities && profile) {
      const monitor = getOllamaHealthMonitor();
      const ollamaStatus = monitor.isAvailable() ? 'Available' : 'Not available';
      output += `
├─────────────────────────────────────────────────────────────┤
│ Device: ${capabilities.os} ${capabilities.cpu} (${capabilities.ram}GB RAM)`.padEnd(62) + `│
│ Tier: ${profile.tier} (${getTierDescription(profile.tier)})`.padEnd(62) + `│
│ Disk Free: ${capabilities.diskFree}GB`.padEnd(62) + `│
│ Classifier: ${profile.classifierModel}`.padEnd(62) + `│
│ Ollama: ${ollamaStatus}`.padEnd(62) + `│`;
    }

    output += `
├─────────────────────────────────────────────────────────────┤
│ LocalRouter (Fase 3.5)                                       │
├─────────────────────────────────────────────────────────────┤
│ Enabled:         ${(config.enabled ? 'Yes' : 'No').padEnd(42)}│
│ Total requests:  ${String(stats.totalRequests).padEnd(42)}│
│ Routed local:    ${`${stats.routedLocal} (${localPct}%)`.padEnd(42)}│
│ Routed to LLM:   ${`${stats.routedToLlm} (${llmPct}%)`.padEnd(42)}│
├─────────────────────────────────────────────────────────────┤
│ Direct success:  ${String(stats.directSuccess).padEnd(42)}│
│ Direct failures: ${String(stats.directFailures).padEnd(42)}│
│ Success rate:    ${`${successRate}%`.padEnd(42)}│
│ Fallbacks:       ${String(stats.fallbacksToBrain).padEnd(42)}│
│ Avg latency:     ${`${stats.avgLocalLatencyMs.toFixed(0)}ms`.padEnd(42)}│`;

    // Add backoff info if available
    if (stats.backoff) {
      output += `
├─────────────────────────────────────────────────────────────┤
│ Backoff State                                                │
│ In backoff:      ${(stats.backoff.inBackoff ? 'Yes' : 'No').padEnd(42)}│
│ Failures:        ${String(stats.backoff.consecutiveFailures).padEnd(42)}│`;

      if (stats.backoff.backoffUntil) {
        const until = stats.backoff.backoffUntil.toLocaleTimeString('es-AR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        output += `
│ Until:           ${until.padEnd(42)}│`;
      }

      if (stats.backoff.lastError) {
        const truncatedError = stats.backoff.lastError.slice(0, 38);
        output += `
│ Last error:      ${truncatedError.padEnd(42)}│`;
      }
    }

    // Add Router v2 metrics if available (Fase 3.6a)
    if (v2Metrics.requestsTotal > 0) {
      output += `
├─────────────────────────────────────────────────────────────┤
│ Router v2 (Fase 3.6a)                                        │
├─────────────────────────────────────────────────────────────┤
│ Total:           ${String(v2Metrics.requestsTotal).padEnd(42)}│
│ Deterministic:   ${`${v2Metrics.requestsDeterministic} (${summary.deterministicPercentage}%)`.padEnd(42)}│
│ Local LLM:       ${`${v2Metrics.requestsLocal} (${summary.localPercentage}%)`.padEnd(42)}│
│ API:             ${`${v2Metrics.requestsApi} (${summary.apiPercentage}%)`.padEnd(42)}│
├─────────────────────────────────────────────────────────────┤
│ Fallback rate:   ${`${summary.fallbackRate}%`.padEnd(42)}│
│ Est. savings:    ${summary.estimatedSavings.padEnd(42)}│
├─────────────────────────────────────────────────────────────┤
│ Health                                                       │
│ Reconnects:      ${String(v2Metrics.ollamaReconnects).padEnd(42)}│
│ Memory pressure: ${String(v2Metrics.memoryPressureEvents).padEnd(42)}│`;

      // Top intents breakdown
      const topIntents = Object.entries(v2Metrics.intentBreakdown)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5);

      if (topIntents.length > 0) {
        output += `
├─────────────────────────────────────────────────────────────┤
│ Top Intents                                                  │`;
        for (const [intent, data] of topIntents) {
          const successPct = (data.successRate * 100).toFixed(0);
          const info = `${data.count} (${successPct}% success, ${data.avgLatency}ms)`;
          output += `
│   ${intent.padEnd(16)} ${info.padEnd(40)}│`;
        }
      }
    }

    output += `
└─────────────────────────────────────────────────────────────┘`;

    return output;
  }

  private async handleHealth(): Promise<string> {
    // Gather all subsystem health info
    const extractionPending = getPendingExtractionCount();
    const embeddingPending = getPendingEmbeddingCount();

    // Check Ollama availability
    const ollamaAvailable = await checkOllamaAvailability();
    const ollamaHealth: SubsystemHealth = ollamaAvailable
      ? { status: 'ok', message: 'Connected' }
      : { status: 'down', message: 'Not available' };

    // Check embeddings state
    const embeddingsState = getEmbeddingsState();
    const embeddingsHealth: SubsystemHealth = embeddingsState.enabled
      ? embeddingsState.ready
        ? { status: 'ok', message: 'Active' }
        : embeddingsState.reason === 'circuit_breaker'
          ? { status: 'degraded', message: 'Circuit breaker open' }
          : { status: 'degraded', message: 'Loading...' }
      : { status: 'down', message: this.getEmbeddingsDisabledReason(embeddingsState.reason) };

    // Check LocalRouter
    const router = getLocalRouter();
    const routerStats = router.getStats();
    const routerConfig = router.getConfig();
    const routerHealth: SubsystemHealth = !routerConfig.enabled
      ? { status: 'down', message: 'Disabled' }
      : routerStats.backoff?.inBackoff
        ? { status: 'degraded', message: 'In backoff' }
        : { status: 'ok', message: 'Ready' };

    // Queue health
    const extractionQueueHealth = getExtractionQueueHealth(extractionPending);
    const embeddingQueueHealth = getEmbeddingQueueHealth(embeddingPending);

    // Loop health
    const proactiveHealth = getProactiveLoopHealth();
    const reminderHealth = getReminderSchedulerHealth();

    // Determine overall health
    const subsystems = {
      ollama: ollamaHealth,
      embeddings: embeddingsHealth,
      localRouter: routerHealth,
      extractionQueue: extractionQueueHealth,
      embeddingQueue: embeddingQueueHealth,
      proactiveLoop: proactiveHealth,
      reminderScheduler: reminderHealth,
    };
    const overall = determineOverallHealth(subsystems);

    // Session metrics
    const session = getSessionMetrics();
    const uptimeMs = Date.now() - session.startedAt.getTime();
    const uptimeStr = this.formatUptime(uptimeMs);

    // Build output
    const statusIcon = (status: HealthStatus): string => {
      switch (status) {
        case 'ok': return '✓';
        case 'degraded': return '◐';
        case 'down': return '✗';
        default: return '?';
      }
    };

    const overallIcon = statusIcon(overall);
    const overallLabel = overall === 'ok' ? 'Healthy' : overall === 'degraded' ? 'Degraded' : 'Issues';

    let output = `
┌─────────────────────────────────────┐
│ System Health: ${overallIcon} ${overallLabel.padEnd(18)}│
├─────────────────────────────────────┤
│ Subsystems                          │
│ ${statusIcon(ollamaHealth.status)} Ollama:        ${ollamaHealth.message.padEnd(17)}│
│ ${statusIcon(embeddingsHealth.status)} Embeddings:    ${embeddingsHealth.message.padEnd(17)}│
│ ${statusIcon(routerHealth.status)} LocalRouter:   ${routerHealth.message.padEnd(17)}│
│ ${statusIcon(proactiveHealth.status)} Proactive:     ${proactiveHealth.message.slice(0, 17).padEnd(17)}│
│ ${statusIcon(reminderHealth.status)} Reminders:     ${reminderHealth.message.slice(0, 17).padEnd(17)}│
├─────────────────────────────────────┤
│ Queues                              │
│   Extraction:    ${String(extractionPending).padEnd(18)}│
│   Embedding:     ${String(embeddingPending).padEnd(18)}│
├─────────────────────────────────────┤
│ Session (${uptimeStr})${' '.repeat(Math.max(0, 14 - uptimeStr.length))}│
│   Messages:      ${String(session.messagesProcessed).padEnd(18)}│
│   Facts saved:   ${String(session.factsSaved).padEnd(18)}│
│   Facts inferred:${String(session.factsExtracted).padEnd(18)}│
│   Embeddings:    ${String(session.embeddingsGenerated).padEnd(18)}│
│   Router hits:   ${String(session.localRouterHits).padEnd(18)}│
│   Truncations:   ${String(session.contextTruncations).padEnd(18)}│
└─────────────────────────────────────┘`;

    // Add warnings if needed
    const warnings: string[] = [];

    if (ollamaHealth.status === 'down') {
      warnings.push('⚠️  Ollama not available - extraction and LocalRouter disabled');
    }
    if (embeddingsHealth.status === 'down') {
      warnings.push('⚠️  Embeddings disabled - using keyword search only');
    }
    if (extractionPending > 50) {
      warnings.push(`⚠️  Large extraction backlog: ${extractionPending} items`);
    }
    if (embeddingPending > 50) {
      warnings.push(`⚠️  Large embedding backlog: ${embeddingPending} items`);
    }
    if (proactiveHealth.status === 'down') {
      warnings.push('⚠️  Proactive loop may have stopped');
    }
    if (session.contextTruncations > 0) {
      warnings.push(`⚠️  Context truncated ${session.contextTruncations} time(s) this session`);
    }

    if (warnings.length > 0) {
      output += '\n\n' + warnings.join('\n');
    }

    return output;
  }

  private getEmbeddingsDisabledReason(reason: string): string {
    switch (reason) {
      case 'disabled_by_config': return 'Disabled (config)';
      case 'extension_missing': return 'No sqlite-vec';
      case 'model_missing': return 'Model not found';
      case 'load_error': return 'Load failed';
      default: return 'Disabled';
    }
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m`;
    }
    return `${seconds}s`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // MODEL RESET COMMAND
  // ═══════════════════════════════════════════════════════════════════

  private async handleResetModels(): Promise<string> {
    const profile = getDeviceProfile();

    if (!profile) {
      return 'Error: Device module no inicializado. Reiniciá la aplicación.';
    }

    if (profile.tier === 'minimal') {
      return 'Tier minimal no requiere modelos locales.';
    }

    // Reset the setup state
    resetSetupState();

    // Run model setup again
    console.log('\n');
    const result = await ensureModelsInstalled(profile.tier, false);

    if (result.skipped && result.success) {
      return 'Todos los modelos ya están instalados.';
    }

    if (result.success) {
      return `Modelos reinstalados correctamente: ${result.modelsInstalled.join(', ')}`;
    }

    return `Algunos modelos fallaron: ${result.modelsFailed.join(', ')}\nReintentá con: ollama pull <modelo>`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // MCP COMMAND HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private async handleMCP(args: string): Promise<string> {
    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();
    const serverId = parts[1];

    const mcpManager = getMCPClientManager();

    switch (subcommand) {
      case undefined:
      case '':
      case 'list':
        return this.formatMCPServerList();

      case 'enable': {
        if (!serverId) return 'Uso: /mcp enable <server-id>';

        const config = await loadMCPConfig();
        const serverConfig = config.servers.find((s) => s.id === serverId);

        if (!serverConfig) {
          return `Server "${serverId}" no encontrado en mcp-config.json`;
        }

        serverConfig.enabled = true;
        await saveMCPConfig(config);

        try {
          await mcpManager.connectServer(serverConfig);
          const status = mcpManager.getServerStatus(serverId);
          return `${serverConfig.name} conectado. ${status.toolCount} tools disponibles.`;
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          return `Error conectando ${serverId}: ${errMsg}`;
        }
      }

      case 'disable': {
        if (!serverId) return 'Uso: /mcp disable <server-id>';

        await mcpManager.disconnectServer(serverId);

        const config = await loadMCPConfig();
        const serverConfig = config.servers.find((s) => s.id === serverId);
        if (serverConfig) {
          serverConfig.enabled = false;
          await saveMCPConfig(config);
        }

        return `${serverId} desconectado.`;
      }

      case 'status': {
        if (!serverId) return 'Uso: /mcp status <server-id>';
        return this.formatMCPServerStatus(serverId);
      }

      case 'tools': {
        if (!serverId) return 'Uso: /mcp tools <server-id>';
        return this.formatMCPServerTools(serverId);
      }

      case 'reload': {
        if (serverId) {
          try {
            await mcpManager.reconnectServer(serverId);
            return `${serverId} reconectado.`;
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return `Error reconectando ${serverId}: ${errMsg}`;
          }
        } else {
          // Reload all
          const result = await mcpManager.initialize();
          return (
            `Reconectados: ${result.successful.join(', ') || '(ninguno)'}\n` +
            `Fallidos: ${result.failed.map((f) => `${f.id}: ${f.error}`).join(', ') || '(ninguno)'}`
          );
        }
      }

      default:
        return `Subcomando desconocido: "${subcommand}".\n` +
          `Uso: /mcp [list|enable|disable|status|tools|reload] [server-id]`;
    }
  }

  private async formatMCPServerList(): Promise<string> {
    const mcpManager = getMCPClientManager();
    const config = await loadMCPConfig();
    const connectedServers = mcpManager.getConnectedServers();

    // Create lookup for connected servers
    const connectedMap = new Map(
      connectedServers.map((s) => [s.id, s])
    );

    // Calculate total MCP tools
    let totalTools = 0;
    let totalPending = 0;
    for (const server of connectedServers) {
      totalTools += server.status.toolCount;
      totalPending += server.status.pendingCalls;
    }

    let output = `
┌─────────────────────────────────────────────────────────────┐
│  MCP Servers                                                 │
├─────────────────────────────────────────────────────────────┤
│  Status   Name         Tools  Health   Last Ping             │
│  ──────   ────         ─────  ──────   ─────────             │`;

    for (const serverConfig of config.servers) {
      const connected = connectedMap.get(serverConfig.id);

      if (connected) {
        const healthIcon = connected.status.healthy ? 'OK' : 'FAIL';
        const pingTime = connected.status.lastPing
          ? this.formatTimeSince(connected.status.lastPing)
          : '-';
        output += `\n│  ✓        ${serverConfig.name.padEnd(12)} ${String(connected.status.toolCount).padEnd(6)} ${healthIcon.padEnd(8)} ${pingTime.padEnd(18)}│`;
      } else if (serverConfig.enabled) {
        output += `\n│  ◐        ${serverConfig.name.padEnd(12)} -      -        (connecting)        │`;
      } else {
        output += `\n│  ○        ${serverConfig.name.padEnd(12)} -      -        (disabled)          │`;
      }
    }

    output += `
├─────────────────────────────────────────────────────────────┤
│  Total tools MCP: ${String(totalTools).padEnd(4)} | Calls pendientes: ${String(totalPending).padEnd(14)}│
└─────────────────────────────────────────────────────────────┘`;

    return output;
  }

  private formatMCPServerStatus(serverId: string): string {
    const mcpManager = getMCPClientManager();
    const status = mcpManager.getServerStatus(serverId);

    const statusLabel = status.connected ? 'Connected' : 'Disconnected';
    const healthLabel = status.healthy ? 'OK' : 'FAIL';
    const lastPing = status.lastPing
      ? status.lastPing.toLocaleString('es-AR')
      : '(never)';
    const lastError = status.lastError ?? '(none)';

    return `
${serverId} MCP Server
  Status:     ${statusLabel}
  Health:     ${healthLabel}
  Tools:      ${status.toolCount}
  Last Ping:  ${lastPing}
  Last Error: ${lastError}
  Pending:    ${status.pendingCalls} calls
  Reconnects: ${status.reconnectAttempts}`;
  }

  private async formatMCPServerTools(serverId: string): Promise<string> {
    const mcpManager = getMCPClientManager();
    const status = mcpManager.getServerStatus(serverId);

    if (!status.connected) {
      return `Server "${serverId}" no está conectado.`;
    }

    const allTools = await mcpManager.getAllTools();
    const serverTools = allTools.filter((t) => t._mcpServerId === serverId);

    if (serverTools.length === 0) {
      return `Server "${serverId}" no tiene tools disponibles.`;
    }

    let output = `Tools from ${serverId} MCP Server:\n`;
    for (const tool of serverTools) {
      const desc = tool.description
        ? ` - ${tool.description.slice(0, 50)}${tool.description.length > 50 ? '...' : ''}`
        : '';
      output += `  • ${tool.name}${desc}\n`;
    }

    return output;
  }

  private formatTimeSince(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `hace ${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `hace ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `hace ${hours}h`;
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

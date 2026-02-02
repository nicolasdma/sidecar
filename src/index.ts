import { existsSync, readFileSync } from 'fs';
import { startCLI } from './interfaces/cli.js';
import { validateConfig, config } from './utils/config.js';
import { closeDatabase, getPendingExtractionCount, getPendingEmbeddingCount } from './memory/store.js';
import { createLogger } from './utils/logger.js';
import { runDecayCheck } from './memory/decay-service.js';
import { startExtractionWorker, stopExtractionWorker } from './memory/extraction-service.js';
import {
  initializeEmbeddings,
  getEmbeddingsStatusMessage,
  getEmbeddingsState,
} from './memory/embeddings-state.js';
import { startEmbeddingWorker, stopEmbeddingWorker } from './memory/embedding-worker.js';
import { disposePipeline } from './memory/embeddings-model.js';
import { initializeLocalRouter } from './agent/local-router/index.js';
import { checkOllamaAvailability } from './llm/ollama.js';
import { initializeDevice, shutdownDevice } from './device/index.js';
import { initializeRouterV2 } from './agent/local-router/router-v2.js';
import { getTotalFactsCount } from './memory/facts-store.js';
import { getMCPClientManager, type MCPInitializeResult } from './mcp/index.js';

const logger = createLogger('main');

/**
 * C1: Validates that critical files exist before starting.
 * Returns warnings for missing or incomplete configuration files.
 */
function validateStartupRequirements(): string[] {
  const warnings: string[] = [];

  // Check user.md exists and has timezone
  try {
    const userMdPath = config.paths.userMd;
    if (!existsSync(userMdPath)) {
      warnings.push('user.md not found - using defaults');
    } else {
      const content = readFileSync(userMdPath, 'utf-8');
      // Check for timezone (handles markdown formatting like **Timezone**:)
      if (!/timezone/i.test(content)) {
        warnings.push('user.md missing timezone - proactive timing may be off');
      }
    }
  } catch (error) {
    warnings.push('user.md unreadable - using defaults');
    logger.debug('Failed to read user.md', { error: error instanceof Error ? error.message : error });
  }

  // Check SOUL.md exists
  try {
    if (!existsSync(config.paths.soul)) {
      warnings.push('SOUL.md not found - using default personality');
    }
  } catch (error) {
    warnings.push('SOUL.md check failed');
    logger.debug('Failed to check SOUL.md', { error: error instanceof Error ? error.message : error });
  }

  return warnings;
}

/**
 * Logs startup status in a formatted box.
 * Shows user what features are active/inactive.
 * Fase 3.6: Expanded dashboard for better visibility.
 */
async function logStartupStatus(
  embeddingsEnabled: boolean,
  localRouterReady: boolean,
  mcpResult?: MCPInitializeResult
): Promise<void> {
  const state = getEmbeddingsState();

  // Check Ollama availability
  const ollamaStatus = await checkOllamaAvailability();

  // Get queue sizes
  const extractionQueue = getPendingExtractionCount();
  const embeddingQueue = embeddingsEnabled ? getPendingEmbeddingCount() : 0;

  // Get facts count
  const factsCount = getTotalFactsCount();

  // Status icons and labels
  const ollamaLabel = ollamaStatus.available ? '✓ Connected' : '✗ Offline';
  // Embeddings: enabled means infrastructure ready (model loads lazily on first use)
  const embedLabel = embeddingsEnabled
    ? state.reason === 'circuit_breaker'
      ? '◐ Paused'
      : '✓ Ready'
    : '✗ Disabled';
  const routerLabel = localRouterReady
    ? '✓ Ready'
    : config.localRouter.enabled
      ? '◐ Warming...'
      : '○ Disabled';
  const searchLabel = embeddingsEnabled ? '✓ Semantic' : '○ Keyword';

  // MCP status
  const mcpConnected = mcpResult?.successful.length ?? 0;
  const mcpFailed = mcpResult?.failed.length ?? 0;
  const mcpLabel = mcpConnected > 0
    ? `✓ ${mcpConnected} server${mcpConnected > 1 ? 's' : ''}`
    : mcpFailed > 0
      ? `◐ ${mcpFailed} failed`
      : '○ None enabled';

  // Determine overall status
  const hasIssues = !ollamaStatus.available || (!embeddingsEnabled && state.reason === 'extension_missing');
  const overallStatus = hasIssues ? '◐ Degraded' : '✓ Ready';

  console.log('\n┌─────────────────────────────────────┐');
  console.log(`│ Sidecar ${overallStatus.padEnd(28)}│`);
  console.log('├─────────────────────────────────────┤');
  console.log(`│ Ollama:         ${ollamaLabel.padEnd(20)}│`);
  console.log(`│ Embeddings:     ${embedLabel.padEnd(20)}│`);
  console.log(`│ LocalRouter:    ${routerLabel.padEnd(20)}│`);
  console.log(`│ MCP Servers:    ${mcpLabel.padEnd(20)}│`);
  console.log(`│ Search Mode:    ${searchLabel.padEnd(20)}│`);
  console.log('├─────────────────────────────────────┤');
  console.log(`│ Facts stored:   ${String(factsCount).padEnd(20)}│`);
  console.log(`│ Extraction Q:   ${String(extractionQueue).padEnd(20)}│`);
  if (embeddingsEnabled) {
    console.log(`│ Embedding Q:    ${String(embeddingQueue).padEnd(20)}│`);
  }
  console.log('└─────────────────────────────────────┘\n');

  // Warnings
  const warnings: string[] = [];

  if (!ollamaStatus.available) {
    warnings.push('⚠️  Ollama not available - fact extraction and LocalRouter disabled');
    warnings.push('   Start Ollama with: ollama serve');
  }

  if (mcpResult && mcpResult.failed.length > 0) {
    for (const fail of mcpResult.failed) {
      warnings.push(`⚠️  MCP server "${fail.id}" failed: ${fail.error}`);
    }
  }

  if (!embeddingsEnabled && state.reason === 'extension_missing') {
    warnings.push('⚠️  Semantic search disabled (sqlite-vec not found)');
    warnings.push('   Install with: npm install sqlite-vec');
  } else if (!embeddingsEnabled && state.reason === 'disabled_by_config') {
    warnings.push('ℹ️  Semantic search disabled by configuration');
  }

  if (extractionQueue > 50) {
    warnings.push(`⚠️  Large extraction backlog: ${extractionQueue} items pending`);
  }

  // Note: Embedding backlog warning removed from startup since model loads lazily.
  // Queue accumulates until first semantic search triggers model load.
  // Use /health to check embedding status.

  if (warnings.length > 0) {
    console.log(warnings.join('\n') + '\n');
  }

  console.log('Tip: Usá /health para ver el estado completo del sistema.\n');
}

async function main(): Promise<void> {
  logger.info('Starting Sidecar...');

  validateConfig();

  // C1: Validate critical files before proceeding
  const startupWarnings = validateStartupRequirements();
  for (const warning of startupWarnings) {
    console.log(`⚠️  ${warning}`);
  }

  // Fase 2: Run decay check at startup (marks 120+ day old facts as stale)
  try {
    const decayResult = await runDecayCheck();
    if (decayResult.markedStale > 0) {
      logger.info('Decay check completed', decayResult);
    }
  } catch (error) {
    logger.warn('Decay check failed at startup', { error });
  }

  // Fase 3.6a: Initialize device module FIRST
  // This detects hardware, assigns tier, and determines which models to use.
  // Must happen before LocalRouter so classifier knows which model to use.
  let deviceProfile: import('./device/types.js').DeviceProfile | null = null;
  try {
    const deviceResult = await initializeDevice();
    deviceProfile = deviceResult.profile;

    // Initialize Router v2 with device profile
    initializeRouterV2(deviceProfile);

    logger.info('Device module initialized', {
      tier: deviceProfile.tier,
      ollamaAvailable: deviceResult.ollamaHealth.available,
      modelsAvailable: deviceResult.ollamaHealth.modelsAvailable.length,
    });
  } catch (error) {
    logger.warn('Device module initialization failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    // Non-fatal: continue without device features (productivity tools will fallback to API)
  }

  // Fase 2: Start background extraction worker
  await startExtractionWorker();

  // Fase 3: Initialize embeddings capability (non-blocking)
  // Model loads lazily on first query, so this is fast
  let embeddingsEnabled = false;
  try {
    embeddingsEnabled = await initializeEmbeddings();
    logger.info(getEmbeddingsStatusMessage());

    // Start background embedding worker
    if (embeddingsEnabled) {
      await startEmbeddingWorker();
    }
  } catch (error) {
    logger.warn('Embeddings initialization failed', { error });
  }

  // Fase 3.5 + OPTIMIZATION: Initialize LocalRouter with NON-BLOCKING warmup
  // The classifier warms up in background, first request may be slightly slower
  // but startup is ~3.5 seconds faster
  let localRouterReady = false;
  if (config.localRouter.enabled) {
    try {
      const classifierModel = deviceProfile?.classifierModel;
      // Initialize WITHOUT warmup (warmup=false), then trigger async warmup
      const router = await initializeLocalRouter(config.localRouter, false, classifierModel);
      localRouterReady = true;
      logger.info('LocalRouter initialized (warming up in background)');

      // Non-blocking warmup - don't await, let it happen in background
      router.warmup().then(() => {
        logger.debug('LocalRouter warmup completed in background');
      }).catch((err) => {
        logger.warn('Background warmup failed', {
          error: err instanceof Error ? err.message : err,
        });
      });
    } catch (error) {
      logger.warn('LocalRouter initialization failed, will retry on first request', {
        error: error instanceof Error ? error.message : error,
      });
    }
  } else {
    logger.debug('LocalRouter disabled');
  }

  // Fase 3.6c: Initialize MCP servers (parallel, non-blocking)
  let mcpResult: MCPInitializeResult | undefined;
  try {
    const mcpManager = getMCPClientManager();
    mcpResult = await mcpManager.initialize();
    if (mcpResult.successful.length > 0) {
      logger.info(`MCP: ${mcpResult.successful.length} server(s) connected`);
    }
  } catch (error) {
    logger.warn('MCP initialization failed', {
      error: error instanceof Error ? error.message : error,
    });
  }

  // Fase 3.6: Expanded startup status dashboard
  await logStartupStatus(embeddingsEnabled, localRouterReady, mcpResult);

  process.on('SIGINT', async () => {
    console.log('\n\nRecibida señal de interrupción, cerrando...');
    stopEmbeddingWorker();
    stopExtractionWorker();
    shutdownDevice(); // Fase 3.6a: Shutdown device module
    await getMCPClientManager().shutdown(); // Close MCP servers
    await disposePipeline(); // Free embedding model memory
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    stopEmbeddingWorker();
    stopExtractionWorker();
    shutdownDevice(); // Fase 3.6a: Shutdown device module
    await getMCPClientManager().shutdown(); // Close MCP servers
    await disposePipeline(); // Free embedding model memory
    closeDatabase();
    process.exit(0);
  });

  process.on('uncaughtException', async (error) => {
    logger.error('Uncaught exception', error);
    stopEmbeddingWorker();
    stopExtractionWorker();
    shutdownDevice(); // Fase 3.6a: Shutdown device module
    await getMCPClientManager().shutdown(); // Close MCP servers
    await disposePipeline(); // Free embedding model memory
    closeDatabase();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', reason);
  });

  await startCLI();
}

main().catch((error) => {
  logger.error('Fatal error', error);
  closeDatabase();
  process.exit(1);
});

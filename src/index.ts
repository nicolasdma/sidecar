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
import { getTotalFactsCount } from './memory/facts-store.js';

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
      // Case-insensitive check for timezone (may be **Timezone**: in markdown)
      if (!/timezone:/i.test(content)) {
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
  localRouterReady: boolean
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

  // Determine overall status
  const hasIssues = !ollamaStatus.available || (!embeddingsEnabled && state.reason === 'extension_missing');
  const overallStatus = hasIssues ? '◐ Degraded' : '✓ Ready';

  console.log('\n┌─────────────────────────────────────┐');
  console.log(`│ Sidecar ${overallStatus.padEnd(28)}│`);
  console.log('├─────────────────────────────────────┤');
  console.log(`│ Ollama:         ${ollamaLabel.padEnd(20)}│`);
  console.log(`│ Embeddings:     ${embedLabel.padEnd(20)}│`);
  console.log(`│ LocalRouter:    ${routerLabel.padEnd(20)}│`);
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

  if (!embeddingsEnabled && state.reason === 'extension_missing') {
    warnings.push('⚠️  Semantic search disabled (sqlite-vec not found)');
    warnings.push('   Install with: npm install sqlite-vec');
  } else if (!embeddingsEnabled && state.reason === 'disabled_by_config') {
    warnings.push('ℹ️  Semantic search disabled by configuration');
  }

  if (extractionQueue > 50) {
    warnings.push(`⚠️  Large extraction backlog: ${extractionQueue} items pending`);
  }

  if (embeddingQueue > 50) {
    warnings.push(`⚠️  Large embedding backlog: ${embeddingQueue} items pending`);
  }

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

  // Fase 3.5: Initialize and warm up LocalRouter
  // This loads Qwen2.5-3B into memory for faster first request
  let localRouterReady = false;
  if (config.localRouter.enabled) {
    try {
      await initializeLocalRouter(config.localRouter, true);
      localRouterReady = true;
      logger.info('LocalRouter initialized');
    } catch (error) {
      logger.warn('LocalRouter initialization failed, will retry on first request', {
        error: error instanceof Error ? error.message : error,
      });
    }
  } else {
    logger.debug('LocalRouter disabled');
  }

  // Fase 3.6: Expanded startup status dashboard
  await logStartupStatus(embeddingsEnabled, localRouterReady);

  process.on('SIGINT', async () => {
    console.log('\n\nRecibida señal de interrupción, cerrando...');
    stopEmbeddingWorker();
    stopExtractionWorker();
    await disposePipeline(); // Free embedding model memory
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    stopEmbeddingWorker();
    stopExtractionWorker();
    await disposePipeline(); // Free embedding model memory
    closeDatabase();
    process.exit(0);
  });

  process.on('uncaughtException', async (error) => {
    logger.error('Uncaught exception', error);
    stopEmbeddingWorker();
    stopExtractionWorker();
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

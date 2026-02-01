import { startCLI } from './interfaces/cli.js';
import { validateConfig, config } from './utils/config.js';
import { closeDatabase } from './memory/store.js';
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

const logger = createLogger('main');

/**
 * Logs startup status in a formatted box.
 * Shows user what features are active/inactive.
 */
function logStartupStatus(embeddingsEnabled: boolean): void {
  const state = getEmbeddingsState();

  const embedStatus = embeddingsEnabled
    ? state.ready
      ? '✓ Active'
      : '◐ Loading...'
    : '✗ Disabled';

  const vectorStatus = embeddingsEnabled ? '✓ Available' : '✗ Keyword only';

  const windowStatus = embeddingsEnabled ? '✓ Semantic' : '○ Fixed (6 turns)';

  console.log('\n┌─────────────────────────────────┐');
  console.log('│ Sidecar Status                  │');
  console.log('├─────────────────────────────────┤');
  console.log(`│ Embeddings:     ${embedStatus.padEnd(15)}│`);
  console.log(`│ Vector Search:  ${vectorStatus.padEnd(15)}│`);
  console.log(`│ Context Window: ${windowStatus.padEnd(15)}│`);
  console.log('└─────────────────────────────────┘\n');

  // Issue 1: Clear warning if sqlite-vec is missing
  if (!embeddingsEnabled && state.reason === 'extension_missing') {
    console.log('⚠️  SEMANTIC SEARCH DISABLED');
    console.log('   Vector search requires sqlite-vec extension.');
    console.log('   Install with: npm install sqlite-vec');
    console.log('   Falling back to keyword search (Fase 2).\n');
  } else if (!embeddingsEnabled && state.reason === 'disabled_by_config') {
    console.log('ℹ️  Semantic search disabled by configuration (EMBEDDINGS_ENABLED=false)\n');
  }
}

async function main(): Promise<void> {
  logger.info('Starting Sidecar...');

  validateConfig();

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

  // Fase 3 Fixes: Log startup status with clear messaging
  logStartupStatus(embeddingsEnabled);

  // Fase 3.5: Initialize and warm up LocalRouter
  // This loads Qwen2.5-3B into memory for faster first request
  if (config.localRouter.enabled) {
    try {
      await initializeLocalRouter(config.localRouter, true);
      logger.info('LocalRouter initialized');
    } catch (error) {
      logger.warn('LocalRouter initialization failed, will retry on first request', {
        error: error instanceof Error ? error.message : error,
      });
    }
  } else {
    logger.debug('LocalRouter disabled');
  }

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

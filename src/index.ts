import { startCLI } from './interfaces/cli.js';
import { validateConfig } from './utils/config.js';
import { closeDatabase } from './memory/store.js';
import { createLogger } from './utils/logger.js';
import { runDecayCheck } from './memory/decay-service.js';
import { startExtractionWorker, stopExtractionWorker } from './memory/extraction-service.js';
import { initializeEmbeddings, getEmbeddingsStatusMessage } from './memory/embeddings-state.js';
import { startEmbeddingWorker, stopEmbeddingWorker } from './memory/embedding-worker.js';
import { disposePipeline } from './memory/embeddings-model.js';

const logger = createLogger('main');

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
  try {
    const embeddingsEnabled = await initializeEmbeddings();
    logger.info(getEmbeddingsStatusMessage());

    // Start background embedding worker
    if (embeddingsEnabled) {
      await startEmbeddingWorker();
    }
  } catch (error) {
    logger.warn('Embeddings initialization failed', { error });
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

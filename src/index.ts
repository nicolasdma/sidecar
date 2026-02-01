import { startCLI } from './interfaces/cli.js';
import { validateConfig } from './utils/config.js';
import { closeDatabase } from './memory/store.js';
import { createLogger } from './utils/logger.js';
import { runDecayCheck } from './memory/decay-service.js';
import { startExtractionWorker, stopExtractionWorker } from './memory/extraction-service.js';

const logger = createLogger('main');

async function main(): Promise<void> {
  logger.info('Starting Sidecar...');

  validateConfig();

  // Fase 2: Run decay check at startup
  try {
    const decayResult = await runDecayCheck();
    if (decayResult.markedStale > 0 || decayResult.markedLowPriority > 0 || decayResult.markedAging > 0) {
      logger.info('Decay check completed', decayResult);
    }
  } catch (error) {
    logger.warn('Decay check failed at startup', { error });
  }

  // Fase 2: Start background extraction worker
  await startExtractionWorker();

  process.on('SIGINT', () => {
    console.log('\n\nRecibida señal de interrupción, cerrando...');
    stopExtractionWorker();
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    stopExtractionWorker();
    closeDatabase();
    process.exit(0);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    stopExtractionWorker();
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

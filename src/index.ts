import { startCLI } from './interfaces/cli.js';
import { validateConfig } from './utils/config.js';
import { closeDatabase } from './memory/store.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('main');

async function main(): Promise<void> {
  logger.info('Starting Sidecar...');

  validateConfig();

  process.on('SIGINT', () => {
    console.log('\n\nRecibida señal de interrupción, cerrando...');
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    closeDatabase();
    process.exit(0);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
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

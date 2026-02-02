/**
 * CLI Interface
 *
 * Terminal interface using the channel layer architecture.
 * Integrates with MessageRouter for message processing
 * and proactive loops for autonomous behavior.
 */

import { CLIMessageSource } from './cli-source.js';
import { CLINotificationSink } from './cli-sink.js';
import { getMessageRouter } from './message-router.js';
import { DefaultCommandHandler } from './command-handler.js';
import { startReminderScheduler, stopReminderScheduler } from '../agent/proactive/reminder-scheduler-v2.js';
import {
  startSpontaneousLoop,
  stopSpontaneousLoop,
  setBrainProcessing,
} from '../agent/proactive/spontaneous-loop.js';
import { loadProactiveConfig } from './config-loader.js';
import { initializeProactiveState } from '../memory/store.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cli');

// Components
let cliSource: CLIMessageSource | null = null;
let cliSink: CLINotificationSink | null = null;

/**
 * Print welcome message.
 */
function printWelcome(): void {
  console.log('\n\x1b[1m=== Sidecar ===\x1b[0m');
  console.log('Tu compañero AI local');
  console.log('Comandos: /help (ayuda), /quiet (silenciar), /exit (salir)\n');
}

/**
 * Start the CLI interface with proactive loops.
 */
export async function startCLI(): Promise<void> {
  logger.info('Starting CLI interface...');

  // Initialize proactive state in database
  initializeProactiveState();

  // Load configuration
  const proactiveConfig = loadProactiveConfig();

  // Create components
  cliSource = new CLIMessageSource();
  cliSink = new CLINotificationSink();

  // Get message router
  const router = getMessageRouter();

  // Register source and sink
  router.registerSource(cliSource);
  router.registerSink(cliSink);

  // Register command handler
  const commandHandler = new DefaultCommandHandler(
    process.env.NODE_ENV === 'development'
  );
  router.registerCommandHandler(commandHandler);

  // Set up processing indicator for spontaneous loop
  const originalOnMessage = cliSource.onMessage.bind(cliSource);
  cliSource.onMessage = (handler) => {
    originalOnMessage(async (msg) => {
      setBrainProcessing(true);
      try {
        await handler(msg);
      } finally {
        setBrainProcessing(false);
      }
    });
  };

  // Start router
  router.start();

  // Print welcome
  printWelcome();

  // Start proactive loops if proactivity level > low
  if (proactiveConfig.proactivityLevel !== 'low') {
    logger.info('Starting proactive loops', {
      level: proactiveConfig.proactivityLevel,
    });
    startReminderScheduler();
    startSpontaneousLoop(proactiveConfig);
  } else {
    // Still start reminder scheduler even with low proactivity
    // (reminders are explicit user requests, not spontaneous)
    logger.info('Starting reminder scheduler only (proactivity=low)');
    startReminderScheduler();
  }

  // Start the CLI source (this starts the readline loop)
  cliSource.start();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await shutdown();
  });

  process.on('SIGTERM', async () => {
    await shutdown();
  });
}

/**
 * Graceful shutdown.
 */
async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  // Stop proactive loops
  stopReminderScheduler();
  stopSpontaneousLoop();

  // Stop router
  const router = getMessageRouter();
  await router.stop();

  console.log('\nChau!\n');
  process.exit(0);
}

export default startCLI;

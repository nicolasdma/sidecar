import * as readline from 'readline';
import { think } from '../agent/brain.js';
import { clearHistory } from '../memory/store.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cli');

const PROMPT = '\x1b[36mVos:\x1b[0m ';
const AGENT_PREFIX = '\x1b[33mSidecar:\x1b[0m ';
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function createSpinner(message: string): { stop: () => void } {
  let i = 0;
  const interval = setInterval(() => {
    const frame = SPINNER_FRAMES[i % SPINNER_FRAMES.length];
    process.stdout.write(`\r\x1b[33m${frame}\x1b[0m ${message}`);
    i++;
  }, 80);

  return {
    stop: () => {
      clearInterval(interval);
      process.stdout.write('\r\x1b[K');
    },
  };
}

function printWelcome(): void {
  console.log('\n\x1b[1m=== Sidecar ===\x1b[0m');
  console.log('Tu compañero AI local');
  console.log('Comandos: /clear (limpiar historial), /exit (salir)\n');
}

function printResponse(response: string): void {
  console.log(`\n${AGENT_PREFIX}${response}\n`);
}

function printError(message: string): void {
  console.log(`\n\x1b[31mError:\x1b[0m ${message}\n`);
}

async function handleCommand(command: string): Promise<boolean> {
  const cmd = command.toLowerCase().trim();

  switch (cmd) {
    case '/exit':
    case '/quit':
    case '/q':
      console.log('\nChau!\n');
      return false;

    case '/clear':
      clearHistory();
      console.log('\nHistorial limpiado.\n');
      return true;

    case '/help':
      console.log('\nComandos disponibles:');
      console.log('  /clear  - Limpiar historial de conversación');
      console.log('  /exit   - Salir del programa');
      console.log('  /help   - Mostrar esta ayuda\n');
      return true;

    default:
      console.log(`\nComando desconocido: ${command}\n`);
      return true;
  }
}

export async function startCLI(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  printWelcome();

  const prompt = (): void => {
    rl.question(PROMPT, async (input) => {
      const trimmedInput = input.trim();

      if (!trimmedInput) {
        prompt();
        return;
      }

      if (trimmedInput.startsWith('/')) {
        const shouldContinue = await handleCommand(trimmedInput);
        if (shouldContinue) {
          prompt();
        } else {
          rl.close();
        }
        return;
      }

      const spinner = createSpinner('Pensando...');
      try {
        const response = await think(trimmedInput);
        spinner.stop();
        printResponse(response);
      } catch (error) {
        spinner.stop();
        const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
        logger.error('Error processing input', error);
        printError(errorMessage);
      }

      prompt();
    });
  };

  rl.on('close', () => {
    process.exit(0);
  });

  prompt();
}

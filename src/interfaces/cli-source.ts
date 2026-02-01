/**
 * CLI Message Source
 *
 * Implements MessageSource for the terminal interface.
 * Wraps readline and provides message emission.
 */

import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import type {
  MessageSource,
  IncomingMessage,
  ChannelType,
} from './types.js';
import { createLogger, setReadlineInterface } from '../utils/logger.js';

const logger = createLogger('cli-source');

// Constants
const DEFAULT_USER_ID = 'local-user';
const PROMPT = '\x1b[36mVos:\x1b[0m ';
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Spinner for indicating processing.
 */
export interface Spinner {
  stop: () => void;
}

/**
 * Create a spinner that shows processing status.
 */
export function createSpinner(message: string): Spinner {
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

/**
 * CLI Message Source implementation.
 */
export class CLIMessageSource implements MessageSource {
  readonly channel: ChannelType = 'cli';

  private rl: readline.Interface | null = null;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private connected: boolean = false;
  private processing: boolean = false;
  private currentSpinner: Spinner | null = null;

  /**
   * Register handler for incoming messages.
   */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Send response to user (print to console).
   */
  async sendResponse(_userId: string, content: string, _replyTo?: string): Promise<void> {
    // Stop spinner if active
    if (this.currentSpinner) {
      this.currentSpinner.stop();
      this.currentSpinner = null;
    }

    // Print response
    console.log(`\n\x1b[33mSidecar:\x1b[0m ${content}\n`);

    // Mark processing complete
    this.processing = false;
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Start the CLI interface.
   */
  start(): void {
    if (this.connected) return;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Set prompt for the interface
    this.rl.setPrompt(PROMPT);

    this.connected = true;
    logger.info('CLI source started');

    // Handle line input
    this.rl.on('line', async (input) => {
      await this.handleInput(input);
      // Show prompt again after handling
      if (this.rl && this.connected && !this.processing) {
        this.rl.prompt();
      }
    });

    // Handle close
    this.rl.on('close', () => {
      setReadlineInterface(null, null);
      this.connected = false;
      process.exit(0);
    });

    // Show initial prompt, THEN register with logger
    // This ensures the logger only restores prompts after the first one is shown
    this.rl.prompt();
    setReadlineInterface(this.rl, PROMPT);
  }

  /**
   * Handle user input.
   */
  private async handleInput(input: string): Promise<void> {
    const trimmed = input.trim();

    // Empty input - just prompt again
    if (!trimmed) {
      return;
    }

    // Emit message to handler
    if (this.handler) {
      this.processing = true;
      this.currentSpinner = createSpinner('Pensando...');

      const msg: IncomingMessage = {
        id: uuidv4(),
        source: 'cli',
        userId: DEFAULT_USER_ID,
        content: trimmed,
        timestamp: new Date(),
        metadata: {},
      };

      try {
        await this.handler(msg);
      } catch (error) {
        // Stop spinner and show error
        if (this.currentSpinner) {
          this.currentSpinner.stop();
          this.currentSpinner = null;
        }
        console.log(`\n\x1b[31mError:\x1b[0m ${error instanceof Error ? error.message : 'Error desconocido'}\n`);
        this.processing = false;
      }
    }
  }

  /**
   * Re-show the prompt (useful after proactive messages).
   */
  showPrompt(): void {
    if (this.rl && this.connected && !this.processing) {
      this.rl.prompt();
    }
  }

  /**
   * Emit a message programmatically (for testing or proactive injections).
   */
  async emitMessage(content: string): Promise<void> {
    if (!this.handler) return;

    const msg: IncomingMessage = {
      id: uuidv4(),
      source: 'cli',
      userId: DEFAULT_USER_ID,
      content,
      timestamp: new Date(),
      metadata: { synthetic: true },
    };

    await this.handler(msg);
  }

  /**
   * Check if currently processing a message.
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Disconnect and cleanup.
   */
  async disconnect(): Promise<void> {
    setReadlineInterface(null, null);

    if (this.currentSpinner) {
      this.currentSpinner.stop();
      this.currentSpinner = null;
    }

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    this.connected = false;
    this.handler = null;
    logger.info('CLI source disconnected');
  }
}

export default CLIMessageSource;

import * as readline from 'readline';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
  data?: unknown;
}

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';

/**
 * Get log level from environment.
 * Default: 'debug' (all logs)
 */
function getLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel === 'debug' || envLevel === 'info' || envLevel === 'warn' || envLevel === 'error') {
    return envLevel;
  }
  return 'debug'; // Default: all logs
}

const GLOBAL_LOG_LEVEL = getLogLevel();

/**
 * Readline coordination for CLI-friendly logging.
 * When readline is active, logs will pause input, print, then restore.
 */
let activeRl: readline.Interface | null = null;
let activePrompt: string | null = null;

export function setReadlineInterface(rl: readline.Interface | null, prompt: string | null): void {
  activeRl = rl;
  activePrompt = prompt;
}

class Logger {
  private context: string;
  private minLevel: LogLevel = GLOBAL_LOG_LEVEL;

  constructor(context: string) {
    this.context = context;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private formatEntry(entry: LogEntry): string {
    const color = LOG_COLORS[entry.level];
    const levelStr = entry.level.toUpperCase().padEnd(5);
    const contextStr = entry.context.padEnd(12);

    let output = `${color}[${entry.timestamp}] ${levelStr}${RESET} [${contextStr}] ${entry.message}`;

    if (entry.data !== undefined) {
      const dataStr = typeof entry.data === 'string'
        ? entry.data
        : JSON.stringify(entry.data, null, 2);
      output += `\n${color}${dataStr}${RESET}`;
    }

    return output;
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString().slice(11, 23),
      level,
      context: this.context,
      message,
      data,
    };

    const formatted = this.formatEntry(entry);

    // If readline is active, use clearLine and cursorTo to avoid messing up the prompt
    if (activeRl && activePrompt) {
      // Clear current line
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }

    if (level === 'error') {
      console.error(formatted);
    } else if (level === 'warn') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }

    // Restore prompt if readline is active
    if (activeRl && activePrompt) {
      activeRl.prompt(true);
    }
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }
}

export function createLogger(context: string): Logger {
  return new Logger(context);
}

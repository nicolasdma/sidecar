import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function loadEnvFile(): void {
  const envPath = join(projectRoot, '.env');

  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

function getEnvVar(name: string, required: boolean = false): string | undefined {
  const value = process.env[name];

  if (required && !value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const config = {
  kimi: {
    apiKey: getEnvVar('KIMI_API_KEY'),
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2-0711-preview',
  },
  anthropic: {
    apiKey: getEnvVar('ANTHROPIC_API_KEY'),
  },
  jina: {
    apiKey: getEnvVar('JINA_API_KEY'),
  },
  paths: {
    root: projectRoot,
    data: join(projectRoot, 'data'),
    soul: join(projectRoot, 'SOUL.md'),
  },
} as const;

export function validateConfig(): void {
  if (!config.kimi.apiKey) {
    console.warn('Warning: KIMI_API_KEY not set. LLM calls will fail.');
  }
}

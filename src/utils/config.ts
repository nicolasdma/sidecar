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

/**
 * Issue #5: Centralized paths configuration.
 * All file paths should be imported from here, not hardcoded.
 */
const dataDir = process.env.SIDECAR_DATA_DIR || join(projectRoot, 'data');
const knowledgeDir = join(dataDir, 'knowledge');

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
    data: dataDir,
    soul: join(projectRoot, 'SOUL.md'),
    // Issue #5: Knowledge files
    knowledge: knowledgeDir,
    userMd: join(knowledgeDir, 'user.md'),
    learningsMd: join(knowledgeDir, 'learnings.md'),
    // Issue #5: Truncated messages backup
    truncatedMessages: join(dataDir, 'truncated_messages.jsonl'),
    // Database
    database: join(dataDir, 'memory.db'),
  },
  // Fase 3.5: LocalRouter configuration
  localRouter: {
    /** Feature flag to enable/disable LocalRouter */
    enabled: process.env.LOCAL_ROUTER_ENABLED !== 'false',
    /** Minimum confidence for direct tool execution */
    confidenceThreshold: parseFloat(process.env.LOCAL_ROUTER_CONFIDENCE || '0.8'),
    /** Timeout for Ollama requests in ms */
    ollamaTimeout: parseInt(process.env.LOCAL_ROUTER_TIMEOUT || '30000', 10),
    /** Max latency before bypassing to Brain in ms */
    maxLatencyBeforeBypass: parseInt(process.env.LOCAL_ROUTER_MAX_LATENCY || '2000', 10),
  },
} as const;

export function validateConfig(): void {
  if (!config.kimi.apiKey) {
    console.warn('Warning: KIMI_API_KEY not set. LLM calls will fail.');
  }
}

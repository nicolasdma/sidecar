/**
 * MCP Configuration Loader
 *
 * Handles loading, validation, and saving of MCP server configuration.
 * Supports environment variable resolution and config migrations.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { MCPConfig, MCPServerConfig } from './types.js';

// Re-export types for convenience
export type { MCPConfig } from './types.js';
import { createLogger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

const logger = createLogger('mcp-config');

/** Current config version for migrations */
const CURRENT_VERSION = 1;

/** Default data directory */
const dataDir = process.env.SIDECAR_DATA_DIR || join(projectRoot, 'data');

/** Path to MCP config file */
export const MCP_CONFIG_PATH = join(dataDir, 'mcp-config.json');

/**
 * Load MCP configuration from file.
 * Creates default config if file doesn't exist.
 */
export async function loadMCPConfig(): Promise<MCPConfig> {
  try {
    if (!existsSync(MCP_CONFIG_PATH)) {
      logger.info('MCP config not found, creating default');
      const defaultConfig = createDefaultMCPConfig();
      await saveMCPConfig(defaultConfig);
      return defaultConfig;
    }

    const raw = await readFile(MCP_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw) as MCPConfig;

    // Migrate if needed
    if (!config.version || config.version < CURRENT_VERSION) {
      logger.info(`Migrating MCP config from v${config.version ?? 0} to v${CURRENT_VERSION}`);
      const migrated = migrateMCPConfig(config);
      await saveMCPConfig(migrated);
      return migrated;
    }

    // Validate schema
    validateMCPConfig(config);

    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info('MCP config not found, creating default');
      const defaultConfig = createDefaultMCPConfig();
      await saveMCPConfig(defaultConfig);
      return defaultConfig;
    }
    throw error;
  }
}

/**
 * Validate MCP configuration schema.
 * Throws on invalid configuration.
 */
export function validateMCPConfig(config: MCPConfig): void {
  if (typeof config !== 'object' || config === null) {
    throw new Error('mcp-config.json: config must be an object');
  }

  if (!Array.isArray(config.servers)) {
    throw new Error('mcp-config.json: "servers" must be an array');
  }

  for (const server of config.servers) {
    if (!server.id) {
      throw new Error('mcp-config.json: server missing "id"');
    }
    if (typeof server.id !== 'string') {
      throw new Error('mcp-config.json: server "id" must be a string');
    }

    if (!server.transport) {
      throw new Error(`mcp-config.json: server "${server.id}" missing "transport"`);
    }
    if (server.transport !== 'stdio' && server.transport !== 'http') {
      throw new Error(
        `mcp-config.json: server "${server.id}" has invalid transport "${server.transport}"`
      );
    }

    if (server.transport === 'stdio') {
      if (!server.command) {
        throw new Error(`mcp-config.json: server "${server.id}" missing "command" for stdio transport`);
      }
      if (!server.args || !Array.isArray(server.args)) {
        throw new Error(`mcp-config.json: server "${server.id}" missing or invalid "args" for stdio transport`);
      }
    }

    if (server.transport === 'http') {
      if (!server.url) {
        throw new Error(`mcp-config.json: server "${server.id}" missing "url" for http transport`);
      }
    }
  }
}

/**
 * Validate that all required environment variables are set for enabled servers.
 * Returns list of missing variables.
 */
export function validateEnvVars(config: MCPConfig): string[] {
  const errors: string[] = [];

  for (const server of config.servers) {
    if (!server.enabled) continue;

    if (server.env) {
      for (const [, value] of Object.entries(server.env)) {
        if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
          const envVar = value.slice(2, -1);
          if (!process.env[envVar]) {
            errors.push(`Server "${server.id}" requires ${envVar} in .env`);
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Resolve environment variable placeholders in server config.
 * Throws if required variable is not defined.
 */
export function resolveEnvVars(config: MCPServerConfig): Record<string, string> {
  const resolved: Record<string, string> = {};

  if (!config.env) return resolved;

  for (const [key, value] of Object.entries(config.env)) {
    if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
      const envVar = value.slice(2, -1);
      const envValue = process.env[envVar];
      if (!envValue) {
        throw new Error(
          `Environment variable ${envVar} not defined (required by MCP server "${config.id}")`
        );
      }
      resolved[key] = envValue;
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

/**
 * Create default MCP configuration.
 * All servers disabled by default for security.
 */
export function createDefaultMCPConfig(): MCPConfig {
  return {
    version: CURRENT_VERSION,
    servers: [
      {
        id: 'filesystem',
        name: 'Filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
        enabled: false, // Disabled by default for security
        callTimeoutMs: 10000,
      },
    ],
  };
}

/**
 * Migrate old config format to current version.
 */
function migrateMCPConfig(config: Partial<MCPConfig>): MCPConfig {
  // For now, just ensure version and servers array exist
  const migrated: MCPConfig = {
    version: CURRENT_VERSION,
    servers: Array.isArray(config.servers) ? config.servers : [],
  };

  // Ensure all servers have required fields
  for (const server of migrated.servers) {
    if (!server.transport) {
      server.transport = 'stdio';
    }
    if (server.enabled === undefined) {
      server.enabled = false;
    }
  }

  return migrated;
}

/**
 * Save MCP configuration to file.
 */
export async function saveMCPConfig(config: MCPConfig): Promise<void> {
  // Ensure data directory exists
  const dir = dirname(MCP_CONFIG_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  logger.debug('MCP config saved');
}

/**
 * Get a server config by ID.
 */
export async function getServerConfig(serverId: string): Promise<MCPServerConfig | null> {
  const config = await loadMCPConfig();
  return config.servers.find((s) => s.id === serverId) ?? null;
}

/**
 * Update a server's enabled status and save.
 */
export async function setServerEnabled(serverId: string, enabled: boolean): Promise<void> {
  const config = await loadMCPConfig();
  const server = config.servers.find((s) => s.id === serverId);

  if (!server) {
    throw new Error(`MCP server "${serverId}" not found in configuration`);
  }

  server.enabled = enabled;
  await saveMCPConfig(config);
}

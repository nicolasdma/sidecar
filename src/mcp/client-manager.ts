/**
 * MCP Client Manager
 *
 * Core implementation for managing MCP server connections.
 * Provides parallel initialization, reconnection with exponential backoff,
 * health checks, graceful shutdown, and event emission.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { EventEmitter } from 'events';
import type {
  MCPClientManager,
  MCPServerConfig,
  MCPServerStatus,
  MCPServerInfo,
  MCPTool,
  MCPToolResult,
  MCPInitializeResult,
  MCPEventType,
  MCPEventHandler,
} from './types.js';
import { loadMCPConfig, resolveEnvVars, type MCPConfig } from './config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mcp');

// Configuration constants
const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_CALL_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_BASE_MS = 1000;
const HEALTH_CHECK_INTERVAL_MS = 60000;
const SHUTDOWN_GRACE_PERIOD_MS = 5000;

/**
 * Internal state for a connected server.
 */
interface ConnectedServer {
  config: MCPServerConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: MCPTool[];
  status: MCPServerStatus;
  pendingCalls: Set<string>;
}

/**
 * MCPClientManager implementation.
 */
class MCPClientManagerImpl extends EventEmitter implements MCPClientManager {
  private servers = new Map<string, ConnectedServer>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private isInitialized = false;

  // ═══════════════════════════════════════════════════════════════════
  // INITIALIZATION (Parallel, with individual timeouts)
  // ═══════════════════════════════════════════════════════════════════

  async initialize(): Promise<MCPInitializeResult> {
    if (this.isInitialized) {
      logger.warn('MCP already initialized, skipping');
      return { successful: [], failed: [] };
    }

    const config = await loadMCPConfig();

    // Validate env vars BEFORE attempting connections
    // Servers with missing env vars are skipped (not attempted)
    const { valid: validServers, errors: validationErrors } = this.validateAndFilterServers(config);

    for (const err of validationErrors) {
      logger.error(`MCP config error: ${err}`);
    }

    const enabledServers = validServers;

    if (enabledServers.length === 0) {
      logger.info('No MCP servers enabled');
      this.isInitialized = true;
      return { successful: [], failed: [] };
    }

    logger.info(`Connecting to ${enabledServers.length} MCP server(s)...`);

    // Connect in PARALLEL with individual timeouts
    const results = await Promise.allSettled(
      enabledServers.map((serverConfig) =>
        this.connectServerWithTimeout(serverConfig)
      )
    );

    const successful: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    results.forEach((result, index) => {
      const serverId = enabledServers[index]!.id;
      if (result.status === 'fulfilled') {
        successful.push(serverId);
        const server = this.servers.get(serverId);
        logger.info(`MCP: ${serverId} connected (${server?.tools.length ?? 0} tools)`);
      } else {
        const errorMsg = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        failed.push({ id: serverId, error: errorMsg });
        logger.warn(`MCP: ${serverId} failed: ${errorMsg}`);
      }
    });

    // Start health check after initialization
    this.startHealthCheck();

    this.isInitialized = true;
    return { successful, failed };
  }

  /**
   * Validate servers and filter out those with missing env vars.
   * Returns valid servers and list of validation errors.
   */
  private validateAndFilterServers(config: MCPConfig): {
    valid: MCPServerConfig[];
    errors: string[];
  } {
    const valid: MCPServerConfig[] = [];
    const errors: string[] = [];

    for (const server of config.servers) {
      if (!server.enabled) continue;

      // Check for missing env vars
      let hasError = false;
      if (server.env) {
        for (const [, value] of Object.entries(server.env)) {
          if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
            const envVar = value.slice(2, -1);
            if (!process.env[envVar]) {
              errors.push(`Server "${server.id}" requires ${envVar} in .env (skipping)`);
              hasError = true;
            }
          }
        }
      }

      if (!hasError) {
        valid.push(server);
      }
    }

    return { valid, errors };
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONNECTION (with timeout and retry)
  // ═══════════════════════════════════════════════════════════════════

  private async connectServerWithTimeout(config: MCPServerConfig): Promise<void> {
    const timeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Connection timeout (${timeoutMs}ms)`)),
        timeoutMs
      );
    });

    try {
      await Promise.race([this.connectServer(config), timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async connectServer(config: MCPServerConfig): Promise<void> {
    // Check if already connected
    if (this.servers.has(config.id)) {
      logger.debug(`MCP server ${config.id} already connected`);
      return;
    }

    // Validate env vars for this specific server
    const resolvedEnv = resolveEnvVars(config);

    if (config.transport === 'http') {
      throw new Error('HTTP transport not yet implemented');
    }

    // Transport: stdio
    if (!config.command || !config.args) {
      throw new Error(
        `Server ${config.id}: missing "command" or "args" for stdio transport`
      );
    }

    logger.debug(`Starting MCP server: ${config.command} ${config.args.join(' ')}`);

    // 1. Build environment (filter undefined values for TypeScript)
    const combinedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        combinedEnv[key] = value;
      }
    }
    Object.assign(combinedEnv, resolvedEnv);

    // 2. Create stdio transport (this spawns the process internally)
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: combinedEnv,
    });

    // 3. Create MCP client
    const client = new Client(
      {
        name: 'sidecar',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );

    // 4. Connect
    await client.connect(transport);

    // 5. Get available tools
    const toolsResponse = await client.listTools();
    const tools: MCPTool[] = toolsResponse.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as MCPTool['inputSchema'],
      _mcpServerId: config.id,
    }));

    // 6. Store connected server
    const connectedServer: ConnectedServer = {
      config,
      client,
      transport,
      tools,
      status: {
        connected: true,
        healthy: true,
        lastPing: new Date(),
        lastError: null,
        toolCount: tools.length,
        reconnectAttempts: 0,
        pendingCalls: 0,
      },
      pendingCalls: new Set(),
    };

    this.servers.set(config.id, connectedServer);

    // 7. Handle transport close (server crash/exit)
    transport.onclose = () => {
      if (this.isShuttingDown) return;

      logger.warn(`MCP server ${config.id} connection closed unexpectedly`);
      this.handleServerCrash(config.id);
    };

    transport.onerror = (err) => {
      logger.error(`MCP ${config.id} transport error: ${err.message}`);
    };

    // Emit connected event
    this.emit('server:connected', {
      serverId: config.id,
      toolCount: tools.length,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // RECONNECTION (exponential backoff)
  // ═══════════════════════════════════════════════════════════════════

  private async handleServerCrash(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) return;

    // Update status
    server.status.connected = false;
    server.status.healthy = false;
    server.status.lastError = 'Server process crashed';

    this.emit('server:disconnected', { serverId, reason: 'crash' });

    // Attempt reconnect
    const maxAttempts =
      server.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;

    if (server.status.reconnectAttempts < maxAttempts) {
      const backoffMs =
        RECONNECT_BACKOFF_BASE_MS * Math.pow(2, server.status.reconnectAttempts);
      server.status.reconnectAttempts++;

      logger.info(
        `MCP: Reconnecting ${serverId} in ${backoffMs}ms ` +
          `(attempt ${server.status.reconnectAttempts}/${maxAttempts})`
      );

      const timer = setTimeout(async () => {
        try {
          // Clean up old state
          this.servers.delete(serverId);
          await this.connectServer(server.config);
          logger.info(`MCP: ${serverId} reconnected successfully`);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.warn(`MCP: Reconnection of ${serverId} failed: ${errMsg}`);
          this.handleServerCrash(serverId);
        }
      }, backoffMs);

      this.reconnectTimers.set(serverId, timer);
    } else {
      logger.error(
        `MCP: ${serverId} exhausted reconnect attempts (${maxAttempts}). ` +
          `Use /mcp reload to retry manually.`
      );
      this.emit('server:error', {
        serverId,
        error: `Maximum reconnect attempts reached (${maxAttempts})`,
        recoverable: false,
      });
    }
  }

  async reconnectServer(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found in configuration`);
    }

    // Cancel any pending reconnect timer
    const timer = this.reconnectTimers.get(serverId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(serverId);
    }

    // Disconnect if connected
    if (server.status.connected) {
      await this.disconnectServer(serverId);
    }

    // Reset reconnect counter
    server.status.reconnectAttempts = 0;

    // Reconnect
    await this.connectServer(server.config);
  }

  // ═══════════════════════════════════════════════════════════════════
  // TOOL CALLS (with timeout and tracking)
  // ═══════════════════════════════════════════════════════════════════

  async callTool(
    serverId: string,
    toolName: string,
    args: unknown
  ): Promise<MCPToolResult> {
    if (this.isShuttingDown) {
      return { success: false, error: 'System is shutting down' };
    }

    const server = this.servers.get(serverId);
    if (!server) {
      return { success: false, error: `MCP server ${serverId} not connected` };
    }

    if (!server.status.connected || !server.status.healthy) {
      return { success: false, error: `MCP server ${serverId} not available` };
    }

    const callId = `${serverId}-${toolName}-${Date.now()}`;
    const timeoutMs = server.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

    // Structured logging
    logger.debug('MCP call start', {
      callId,
      server: serverId,
      tool: toolName,
      args: JSON.stringify(args).slice(0, 200), // Truncate for logs
    });

    const startTime = Date.now();
    server.pendingCalls.add(callId);
    server.status.pendingCalls = server.pendingCalls.size;

    let timeoutId: NodeJS.Timeout | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Tool call timeout (${timeoutMs}ms)`)),
          timeoutMs
        );
      });

      const result = await Promise.race([
        server.client.callTool({
          name: toolName,
          arguments: args as Record<string, unknown>,
        }),
        timeoutPromise,
      ]);

      const duration = Date.now() - startTime;
      logger.debug('MCP call success', {
        callId,
        duration,
        contentLength: JSON.stringify(result.content).length,
      });

      return {
        success: true,
        data: result.content,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.warn('MCP call failed', { callId, duration, error: errorMessage });

      // Mark server as unhealthy on timeout
      if (errorMessage.includes('timeout')) {
        server.status.healthy = false;
        server.status.lastError = errorMessage;
      }

      return {
        success: false,
        error: errorMessage,
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      server.pendingCalls.delete(callId);
      server.status.pendingCalls = server.pendingCalls.size;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // HEALTH CHECK
  // ═══════════════════════════════════════════════════════════════════

  private startHealthCheck(): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private async performHealthCheck(): Promise<void> {
    const HEALTH_CHECK_TIMEOUT_MS = 5000;

    for (const [serverId, server] of this.servers) {
      if (!server.status.connected) continue;

      let timeoutId: NodeJS.Timeout | undefined;

      try {
        // Simple ping: list tools (fast operation)
        const startTime = Date.now();
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Health check timeout')),
            HEALTH_CHECK_TIMEOUT_MS
          );
        });

        await Promise.race([server.client.listTools(), timeoutPromise]);

        const latency = Date.now() - startTime;
        server.status.healthy = true;
        server.status.lastPing = new Date();
        server.status.lastError = null;

        logger.debug(`MCP health check: ${serverId} OK (${latency}ms)`);
      } catch (error) {
        server.status.healthy = false;
        server.status.lastError =
          error instanceof Error ? error.message : 'Health check failed';
        logger.warn(
          `MCP health check: ${serverId} FAILED - ${server.status.lastError}`
        );
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SHUTDOWN (graceful)
  // ═══════════════════════════════════════════════════════════════════

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('MCP: Shutting down...');

    // Cancel health check
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Cancel all reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    // Wait for pending calls to complete (with timeout)
    await this.waitForPendingCalls(SHUTDOWN_GRACE_PERIOD_MS);

    // Close all servers
    for (const [serverId, server] of this.servers) {
      try {
        await server.client.close();
        await server.transport.close();
        logger.debug(`MCP: ${serverId} disconnected`);
      } catch (error) {
        logger.warn(`MCP: Error disconnecting ${serverId}: ${error}`);
      }
    }

    this.servers.clear();
    logger.info('MCP: Shutdown complete');
  }

  private async waitForPendingCalls(timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      let totalPending = 0;
      for (const server of this.servers.values()) {
        totalPending += server.pendingCalls.size;
      }

      if (totalPending === 0) {
        return;
      }

      logger.debug(`MCP shutdown: waiting for ${totalPending} pending calls...`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    logger.warn('MCP shutdown: timeout waiting for pending calls, forcing close');
  }

  // ═══════════════════════════════════════════════════════════════════
  // GETTERS
  // ═══════════════════════════════════════════════════════════════════

  async getAllTools(): Promise<MCPTool[]> {
    const allTools: MCPTool[] = [];

    for (const [serverId, server] of this.servers) {
      if (!server.status.connected || !server.status.healthy) continue;

      for (const tool of server.tools) {
        allTools.push({
          ...tool,
          _mcpServerId: serverId,
        });
      }
    }

    return allTools;
  }

  getConnectedServers(): MCPServerInfo[] {
    return Array.from(this.servers.entries()).map(([id, server]) => ({
      id,
      name: server.config.name,
      status: { ...server.status },
      toolCount: server.tools.length,
    }));
  }

  getServerStatus(serverId: string): MCPServerStatus {
    const server = this.servers.get(serverId);
    if (!server) {
      return {
        connected: false,
        healthy: false,
        lastPing: null,
        lastError: 'Server not found',
        toolCount: 0,
        reconnectAttempts: 0,
        pendingCalls: 0,
      };
    }
    return { ...server.status };
  }

  isServerHealthy(serverId: string): boolean {
    const server = this.servers.get(serverId);
    return server?.status.connected === true && server?.status.healthy === true;
  }

  async disconnectServer(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) return;

    try {
      await server.client.close();
      await server.transport.close();
    } catch (error) {
      logger.warn(`Error disconnecting ${serverId}: ${error}`);
    }

    this.servers.delete(serverId);
    this.emit('server:disconnected', { serverId, reason: 'manual' });
  }

  // ═══════════════════════════════════════════════════════════════════
  // EVENT HANDLING
  // ═══════════════════════════════════════════════════════════════════

  // Override to provide typed event methods
  override on(event: MCPEventType, handler: MCPEventHandler): this {
    super.on(event, handler as (...args: unknown[]) => void);
    return this;
  }

  override off(event: MCPEventType, handler: MCPEventHandler): this {
    super.off(event, handler as (...args: unknown[]) => void);
    return this;
  }
}

// Singleton instance
let instance: MCPClientManagerImpl | null = null;

/**
 * Get the singleton MCPClientManager instance.
 */
export function getMCPClientManager(): MCPClientManager {
  if (!instance) {
    instance = new MCPClientManagerImpl();
  }
  return instance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetMCPClientManager(): void {
  if (instance) {
    instance.shutdown().catch((err) => {
      logger.warn('Error during MCP reset shutdown:', err);
    });
    instance = null;
  }
}

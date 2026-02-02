import type { ToolDefinition } from '../llm/types.js';
import type { Tool, ToolResult, ToolExecutionContext } from './types.js';
import { createToolDefinition } from './types.js';
import { createLogger } from '../utils/logger.js';
import { withTimeout, TIMEOUTS } from '../utils/timeout.js';
import { getMCPClientManager, createMCPToolAdapter, type MCPToolAdapter } from '../mcp/index.js';

const logger = createLogger('tools');

/** Default timeout for tool execution in milliseconds */
const TOOL_TIMEOUT_MS = TIMEOUTS.TOOL_EXECUTION;

// Re-export for convenience
export type { ToolExecutionContext } from './types.js';
export { createExecutionContext, getToolCallCount, incrementToolCallCount } from './types.js';

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private mcpAdapter: MCPToolAdapter | null = null;
  private mcpToolsCache: Map<string, Tool> = new Map();
  private mcpCacheTime: number = 0;
  private readonly MCP_CACHE_TTL_MS = 5000; // Cache MCP tools for 5 seconds

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`Tool "${tool.name}" is already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
    logger.debug(`Registered tool: ${tool.name}`);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get local tool definitions only.
   */
  getDefinitions(): ToolDefinition[] {
    return this.getAll().map(createToolDefinition);
  }

  /**
   * Get combined tool definitions (local + MCP).
   * MCP tools are fetched from connected servers.
   */
  async getDefinitionsWithMCP(): Promise<ToolDefinition[]> {
    const adapter = this.getMCPAdapter();
    const allTools = await adapter.getAllToolsUnified(this.getAll());
    return allTools.map(createToolDefinition);
  }

  /**
   * Get the MCP tool adapter, lazily initialized.
   */
  private getMCPAdapter(): MCPToolAdapter {
    if (!this.mcpAdapter) {
      this.mcpAdapter = createMCPToolAdapter(getMCPClientManager());
    }
    return this.mcpAdapter;
  }

  /**
   * Refresh MCP tools cache if expired.
   */
  private async refreshMCPToolsCache(): Promise<void> {
    const now = Date.now();
    if (now - this.mcpCacheTime < this.MCP_CACHE_TTL_MS) {
      return; // Cache still valid
    }

    const adapter = this.getMCPAdapter();
    const mcpTools = await adapter.getMCPTools();

    this.mcpToolsCache.clear();
    for (const tool of mcpTools) {
      this.mcpToolsCache.set(tool.name, tool);
    }
    this.mcpCacheTime = now;
  }

  /**
   * Find a tool by name, checking local tools first, then MCP.
   */
  async findTool(name: string): Promise<Tool | undefined> {
    // Check local tools first
    const localTool = this.tools.get(name);
    if (localTool) return localTool;

    // Check MCP tools
    await this.refreshMCPToolsCache();
    return this.mcpToolsCache.get(name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    // Check local tools first, then MCP
    const tool = await this.findTool(name);

    if (!tool) {
      logger.error(`Tool not found: ${name}`);
      return {
        success: false,
        error: `Unknown tool: ${name}`,
      };
    }

    logger.info(`Executing tool: ${name}`, { args, turnId: context?.turnId });
    const startTime = Date.now();

    try {
      // Issue #2: Add timeout protection to prevent indefinite hangs
      // Issue #1: Pass context to tool for per-turn state management
      // Note: MCP tools have their own internal timeout, but we wrap for safety
      const result = await withTimeout(
        tool.execute(args, context),
        TOOL_TIMEOUT_MS,
        `Tool ${name} timed out after ${TOOL_TIMEOUT_MS / 1000}s`
      );

      const duration = Date.now() - startTime;
      logger.debug(`Tool ${name} completed in ${duration}ms`, result);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Tool ${name} failed after ${duration}ms: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Issue #4: Notify all tools that a new turn is starting.
   * Calls onTurnStart hook on each tool that implements it.
   */
  notifyTurnStart(): void {
    for (const tool of this.tools.values()) {
      if (tool.onTurnStart) {
        tool.onTurnStart();
      }
    }
    logger.debug('All tools notified of turn start');
  }
}

export const toolRegistry = new ToolRegistry();

export function registerTool(tool: Tool): void {
  toolRegistry.register(tool);
}

export function executeTool(
  name: string,
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  return toolRegistry.execute(name, args, context);
}

export function getToolDefinitions(): ToolDefinition[] {
  return toolRegistry.getDefinitions();
}

/**
 * Get combined tool definitions (local + MCP).
 * Use this to provide all available tools to the LLM.
 */
export async function getToolDefinitionsWithMCP(): Promise<ToolDefinition[]> {
  return toolRegistry.getDefinitionsWithMCP();
}

/**
 * Issue #4: Notify all tools that a new turn is starting.
 */
export function notifyToolsTurnStart(): void {
  toolRegistry.notifyTurnStart();
}

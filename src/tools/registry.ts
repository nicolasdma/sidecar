import type { ToolDefinition } from '../llm/types.js';
import type { Tool, ToolResult, ToolExecutionContext } from './types.js';
import { createToolDefinition } from './types.js';
import { createLogger } from '../utils/logger.js';
import { withTimeout, TIMEOUTS } from '../utils/timeout.js';

const logger = createLogger('tools');

/** Default timeout for tool execution in milliseconds */
const TOOL_TIMEOUT_MS = TIMEOUTS.TOOL_EXECUTION;

// Re-export for convenience
export type { ToolExecutionContext } from './types.js';
export { createExecutionContext, getToolCallCount, incrementToolCallCount } from './types.js';

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

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

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map(createToolDefinition);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

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
 * Issue #4: Notify all tools that a new turn is starting.
 */
export function notifyToolsTurnStart(): void {
  toolRegistry.notifyTurnStart();
}

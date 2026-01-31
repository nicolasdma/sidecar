import type { ToolDefinition } from '../llm/types.js';
import type { Tool, ToolResult } from './types.js';
import { createToolDefinition } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('tools');

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

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      logger.error(`Tool not found: ${name}`);
      return {
        success: false,
        error: `Unknown tool: ${name}`,
      };
    }

    logger.info(`Executing tool: ${name}`, args);

    try {
      const result = await tool.execute(args);
      logger.debug(`Tool ${name} result`, result);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Tool ${name} failed`, errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}

export const toolRegistry = new ToolRegistry();

export function registerTool(tool: Tool): void {
  toolRegistry.register(tool);
}

export function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return toolRegistry.execute(name, args);
}

export function getToolDefinitions(): ToolDefinition[] {
  return toolRegistry.getDefinitions();
}

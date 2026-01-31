import { registerTool, getToolDefinitions, executeTool } from './registry.js';
import { timeTool } from './time.js';
import { searchTool } from './search.js';

export function initializeTools(): void {
  registerTool(timeTool);
  registerTool(searchTool);
}

export { getToolDefinitions, executeTool };
export type { Tool, ToolResult } from './types.js';

import {
  registerTool,
  getToolDefinitions,
  executeTool,
  notifyToolsTurnStart,
  createExecutionContext,
} from './registry.js';
import { timeTool } from './time.js';
import { searchTool } from './search.js';
import { rememberTool } from './remember.js';
import { readUrlTool } from './read-url.js';
import { weatherTool } from './weather.js';

export function initializeTools(): void {
  registerTool(timeTool);
  registerTool(searchTool);
  registerTool(rememberTool);
  registerTool(readUrlTool);
  registerTool(weatherTool);
}

export {
  getToolDefinitions,
  executeTool,
  notifyToolsTurnStart,
  createExecutionContext,
};
export type { Tool, ToolResult, ToolExecutionContext } from './types.js';

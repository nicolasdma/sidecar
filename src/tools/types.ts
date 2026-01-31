import type { ToolDefinition } from '../llm/types.js';

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolDefinition['function']['parameters'];
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export function createToolDefinition(tool: Tool): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

import type { ToolDefinition } from '../llm/types.js';

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Execution context passed to each tool execution.
 * Created fresh for each turn of the agentic loop.
 * Issue #1: Replaces global state for proper isolation.
 */
export interface ToolExecutionContext {
  /** Unique identifier for this turn */
  turnId: string;
  /** Count of tool calls by tool name within this turn */
  toolCallCount: Map<string, number>;
}

/**
 * Creates a fresh execution context for a new turn.
 */
export function createExecutionContext(): ToolExecutionContext {
  return {
    turnId: crypto.randomUUID(),
    toolCallCount: new Map(),
  };
}

/**
 * Increments the call count for a specific tool and returns the new count.
 */
export function incrementToolCallCount(
  context: ToolExecutionContext,
  toolName: string
): number {
  const currentCount = context.toolCallCount.get(toolName) ?? 0;
  const newCount = currentCount + 1;
  context.toolCallCount.set(toolName, newCount);
  return newCount;
}

/**
 * Gets the current call count for a specific tool.
 */
export function getToolCallCount(
  context: ToolExecutionContext,
  toolName: string
): number {
  return context.toolCallCount.get(toolName) ?? 0;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolDefinition['function']['parameters'];
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<ToolResult>;
  /** Optional hook called at the start of each turn */
  onTurnStart?: () => void;
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

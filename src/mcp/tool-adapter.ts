/**
 * MCP Tool Adapter
 *
 * Converts MCP tools to Sidecar's Tool format and provides
 * unified tool access combining local and MCP tools.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../tools/types.js';
import type { MCPClientManager, MCPTool } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mcp-adapter');

/**
 * Factory that creates the MCP tool adapter with injected dependencies.
 *
 * @param mcpManager - The MCP client manager instance
 * @returns Adapter functions for tool conversion
 */
export function createMCPToolAdapter(mcpManager: MCPClientManager) {
  /**
   * Convert an MCP tool to Sidecar's Tool format.
   *
   * @param mcpTool - The MCP tool definition
   * @param serverId - The server ID providing this tool
   * @returns A Sidecar Tool that proxies to the MCP server
   */
  function mcpToolToSidecarTool(mcpTool: MCPTool, serverId: string): Tool {
    // MCP inputSchema is more generic than our Tool parameters type
    // We cast here as the LLM will handle the actual schema validation
    const defaultParams = { type: 'object' as const, properties: {}, required: [] };
    const params = mcpTool.inputSchema
      ? {
          type: 'object' as const,
          properties: (mcpTool.inputSchema.properties ?? {}) as Record<string, { type: string; description: string; enum?: string[] }>,
          required: mcpTool.inputSchema.required,
        }
      : defaultParams;

    return {
      name: mcpTool.name,
      description: mcpTool.description ?? '',
      parameters: params,

      execute: async (
        args: Record<string, unknown>,
        _context?: ToolExecutionContext
      ): Promise<ToolResult> => {
        logger.debug(`Executing MCP tool: ${mcpTool.name} on ${serverId}`);

        const result = await mcpManager.callTool(serverId, mcpTool.name, args);

        if (result.success) {
          return {
            success: true,
            data: result.data,
          };
        } else {
          return {
            success: false,
            error: result.error ?? 'Unknown MCP error',
          };
        }
      },
    };
  }

  /**
   * Get all tools (local + MCP) in a unified format.
   * Local tools have priority if there's a name conflict.
   *
   * @param localTools - Array of local Sidecar tools
   * @returns Combined array of local and MCP tools
   */
  async function getAllToolsUnified(localTools: Tool[]): Promise<Tool[]> {
    // 1. Get MCP tools from all connected servers
    const mcpTools = await mcpManager.getAllTools();

    // 2. Convert MCP tools to Sidecar format
    const adaptedMcpTools = mcpTools.map((tool) =>
      mcpToolToSidecarTool(tool, tool._mcpServerId!)
    );

    // 3. Combine (local tools take priority on name conflicts)
    const localNames = new Set(localTools.map((t) => t.name));
    const uniqueMcpTools = adaptedMcpTools.filter((t) => !localNames.has(t.name));

    // 4. Warn about conflicts (visible to user)
    const conflicts = adaptedMcpTools.filter((t) => localNames.has(t.name));
    if (conflicts.length > 0) {
      logger.warn(
        `MCP tools ignored due to name conflict with local tools: ${conflicts.map((t) => t.name).join(', ')}`
      );
    }

    logger.debug(
      `Combined tools: ${localTools.length} local + ${uniqueMcpTools.length} MCP = ${localTools.length + uniqueMcpTools.length} total`
    );

    return [...localTools, ...uniqueMcpTools];
  }

  /**
   * Get MCP-only tools (already converted to Sidecar format).
   *
   * @returns Array of MCP tools as Sidecar Tools
   */
  async function getMCPTools(): Promise<Tool[]> {
    const mcpTools = await mcpManager.getAllTools();
    return mcpTools.map((tool) =>
      mcpToolToSidecarTool(tool, tool._mcpServerId!)
    );
  }

  /**
   * Get total count of MCP tools available.
   */
  async function getMCPToolCount(): Promise<number> {
    const mcpTools = await mcpManager.getAllTools();
    return mcpTools.length;
  }

  return {
    mcpToolToSidecarTool,
    getAllToolsUnified,
    getMCPTools,
    getMCPToolCount,
  };
}

/**
 * Type for the MCP tool adapter instance.
 */
export type MCPToolAdapter = ReturnType<typeof createMCPToolAdapter>;

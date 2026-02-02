/**
 * MCP Module
 *
 * Provides MCP (Model Context Protocol) integration for connecting
 * to external MCP servers and using their tools.
 */

// Core exports
export { getMCPClientManager, resetMCPClientManager } from './client-manager.js';
export { createMCPToolAdapter } from './tool-adapter.js';
export type { MCPToolAdapter } from './tool-adapter.js';

// Config exports
export {
  loadMCPConfig,
  saveMCPConfig,
  validateMCPConfig,
  validateEnvVars,
  resolveEnvVars,
  getServerConfig,
  setServerEnabled,
  MCP_CONFIG_PATH,
} from './config.js';

// Type exports
export type {
  MCPClientManager,
  MCPConfig,
  MCPServerConfig,
  MCPServerStatus,
  MCPServerInfo,
  MCPTool,
  MCPToolResult,
  MCPInitializeResult,
  MCPTransport,
  MCPEventType,
  MCPEventHandler,
  MCPEvent,
  MCPServerConnectedEvent,
  MCPServerDisconnectedEvent,
  MCPServerErrorEvent,
} from './types.js';

/**
 * MCP (Model Context Protocol) Types
 *
 * Defines all interfaces for MCP integration including server configuration,
 * status tracking, tool definitions, and manager interface.
 */

/**
 * Transport type for MCP server communication.
 */
export type MCPTransport = 'stdio' | 'http';

/**
 * Configuration for an MCP server.
 */
export interface MCPServerConfig {
  /** Unique identifier for the server (e.g., "gmail", "slack") */
  id: string;
  /** Display name for the server */
  name: string;
  /** Transport type for communication */
  transport: MCPTransport;

  // For stdio transport:
  /** Command to run (e.g., "npx" or path to executable) */
  command?: string;
  /** Arguments for the command */
  args?: string[];

  // For http transport (future):
  /** URL for HTTP transport */
  url?: string;

  /** Environment variables to pass to the server (supports ${ENV_VAR} syntax) */
  env?: Record<string, string>;
  /** Whether the server is enabled */
  enabled: boolean;

  // Timeouts and retry configuration
  /** Connection timeout in milliseconds (default: 30000) */
  connectTimeoutMs?: number;
  /** Tool call timeout in milliseconds (default: 30000) */
  callTimeoutMs?: number;
  /** Maximum reconnection attempts (default: 3) */
  maxReconnectAttempts?: number;
}

/**
 * Full MCP configuration with version for migrations.
 */
export interface MCPConfig {
  /** Configuration version for migrations */
  version: number;
  /** List of configured MCP servers */
  servers: MCPServerConfig[];
}

/**
 * Status of an MCP server.
 */
export interface MCPServerStatus {
  /** Whether the server is connected */
  connected: boolean;
  /** Whether the server is healthy (responding to pings) */
  healthy: boolean;
  /** Last successful ping time */
  lastPing: Date | null;
  /** Last error message */
  lastError: string | null;
  /** Number of tools provided by this server */
  toolCount: number;
  /** Current reconnection attempt count */
  reconnectAttempts: number;
  /** Number of pending tool calls */
  pendingCalls: number;
}

/**
 * Information about a connected MCP server.
 */
export interface MCPServerInfo {
  /** Server ID */
  id: string;
  /** Server display name */
  name: string;
  /** Server status */
  status: MCPServerStatus;
  /** Number of tools available */
  toolCount: number;
}

/**
 * MCP tool definition from the server.
 */
export interface MCPTool {
  /** Tool name */
  name: string;
  /** Tool description */
  description?: string;
  /** JSON schema for input parameters */
  inputSchema?: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /** Internal: ID of the server providing this tool */
  _mcpServerId?: string;
}

/**
 * Result from an MCP tool call.
 */
export interface MCPToolResult {
  /** Whether the call succeeded */
  success: boolean;
  /** Result data if successful */
  data?: unknown;
  /** Error message if failed */
  error?: string;
}

/**
 * Result from initialization.
 */
export interface MCPInitializeResult {
  /** IDs of successfully connected servers */
  successful: string[];
  /** Failed server connections with error details */
  failed: Array<{ id: string; error: string }>;
}

/**
 * Event types emitted by MCPClientManager.
 */
export type MCPEventType =
  | 'server:connected'
  | 'server:disconnected'
  | 'server:error';

/**
 * Payload for server:connected event.
 */
export interface MCPServerConnectedEvent {
  serverId: string;
  toolCount: number;
}

/**
 * Payload for server:disconnected event.
 */
export interface MCPServerDisconnectedEvent {
  serverId: string;
  reason: 'crash' | 'manual' | 'shutdown';
}

/**
 * Payload for server:error event.
 */
export interface MCPServerErrorEvent {
  serverId: string;
  error: string;
  recoverable: boolean;
}

/**
 * Union type for all MCP events.
 */
export type MCPEvent =
  | MCPServerConnectedEvent
  | MCPServerDisconnectedEvent
  | MCPServerErrorEvent;

/**
 * Event handler function type.
 */
export type MCPEventHandler<T extends MCPEvent = MCPEvent> = (event: T) => void;

/**
 * MCP Client Manager interface.
 *
 * Manages connections to MCP servers, provides tool discovery,
 * handles reconnection, and performs health checks.
 */
export interface MCPClientManager {
  // Lifecycle
  /**
   * Initialize the manager and connect to enabled servers.
   * Connections happen in parallel with individual timeouts.
   */
  initialize(): Promise<MCPInitializeResult>;

  /**
   * Gracefully shutdown all connections.
   * Waits for pending calls to complete (with timeout).
   */
  shutdown(): Promise<void>;

  // Server management
  /**
   * Connect to a specific server.
   * @param config Server configuration
   */
  connectServer(config: MCPServerConfig): Promise<void>;

  /**
   * Disconnect from a specific server.
   * @param serverId Server ID to disconnect
   */
  disconnectServer(serverId: string): Promise<void>;

  /**
   * Reconnect to a specific server.
   * Resets reconnection counter and attempts fresh connection.
   * @param serverId Server ID to reconnect
   */
  reconnectServer(serverId: string): Promise<void>;

  /**
   * Get list of connected servers with their info.
   */
  getConnectedServers(): MCPServerInfo[];

  // Tools
  /**
   * Get all tools from all connected and healthy servers.
   */
  getAllTools(): Promise<MCPTool[]>;

  /**
   * Call a tool on a specific server.
   * @param serverId Server ID
   * @param toolName Tool name
   * @param args Tool arguments
   */
  callTool(
    serverId: string,
    toolName: string,
    args: unknown
  ): Promise<MCPToolResult>;

  // Resources (optional, for future)
  // listResources(serverId: string): Promise<MCPResource[]>;
  // readResource(serverId: string, uri: string): Promise<unknown>;

  // Status & Health
  /**
   * Get status of a specific server.
   * @param serverId Server ID
   */
  getServerStatus(serverId: string): MCPServerStatus;

  /**
   * Check if a server is connected and healthy.
   * @param serverId Server ID
   */
  isServerHealthy(serverId: string): boolean;

  // Events
  /**
   * Subscribe to MCP events.
   * @param event Event type
   * @param handler Event handler
   */
  on(event: MCPEventType, handler: MCPEventHandler): this;

  /**
   * Unsubscribe from MCP events.
   * @param event Event type
   * @param handler Event handler
   */
  off(event: MCPEventType, handler: MCPEventHandler): this;
}

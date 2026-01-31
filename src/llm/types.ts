export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface BaseMessage {
  role: MessageRole;
  content: string | null;
}

export interface SystemMessage extends BaseMessage {
  role: 'system';
  content: string;
}

export interface UserMessage extends BaseMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolMessage extends BaseMessage {
  role: 'tool';
  content: string;
  tool_call_id: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: string;
        description: string;
        enum?: string[];
      }>;
      required?: string[];
    };
  };
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[] | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
}

export interface LLMClient {
  complete(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[]
  ): Promise<LLMResponse>;
}

export interface LLMError extends Error {
  code: string;
  status?: number;
  retryable: boolean;
}

export function createLLMError(
  message: string,
  code: string,
  status?: number,
  retryable: boolean = false
): LLMError {
  const error = new Error(message) as LLMError;
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

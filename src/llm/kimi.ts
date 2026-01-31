import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import {
  type Message,
  type ToolDefinition,
  type LLMResponse,
  type LLMClient,
  type ToolCall,
  createLLMError,
} from './types.js';

const logger = createLogger('kimi');

interface KimiChatRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
  }>;
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
}

interface KimiChatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface KimiErrorResponse {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

const RETRY_DELAYS = [1000, 2000, 4000];
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];
const REQUEST_TIMEOUT_MS = 60000;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatMessages(
  systemPrompt: string,
  messages: Message[]
): KimiChatRequest['messages'] {
  const formatted: KimiChatRequest['messages'] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of messages) {
    if (msg.role === 'tool') {
      formatted.push({
        role: 'tool',
        content: msg.content,
        tool_call_id: msg.tool_call_id,
      });
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      formatted.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: msg.tool_calls,
      });
    } else {
      formatted.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  return formatted;
}

async function makeRequest(
  body: KimiChatRequest,
  attempt: number = 0
): Promise<KimiChatResponse> {
  const apiKey = config.kimi.apiKey;
  if (!apiKey) {
    throw createLLMError('KIMI_API_KEY not configured', 'CONFIG_ERROR');
  }

  const url = `${config.kimi.baseUrl}/chat/completions`;

  logger.debug(`Request attempt ${attempt + 1}`, {
    model: body.model,
    messageCount: body.messages.length,
    hasTools: !!body.tools?.length,
  });

  let response: Response;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      logger.error('Request timed out');
      throw createLLMError(
        'Request timed out after 60 seconds',
        'TIMEOUT_ERROR',
        undefined,
        true
      );
    }

    const networkError = error instanceof Error ? error.message : 'Unknown network error';
    logger.error('Network error', networkError);

    const retryDelay = RETRY_DELAYS[attempt];
    if (retryDelay !== undefined) {
      logger.info(`Retrying in ${retryDelay}ms...`);
      await sleep(retryDelay);
      return makeRequest(body, attempt + 1);
    }

    throw createLLMError(
      `Network error: ${networkError}`,
      'NETWORK_ERROR',
      undefined,
      true
    );
  }

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    let errorCode = 'API_ERROR';

    try {
      const errorBody = await response.json() as KimiErrorResponse;
      if (errorBody.error) {
        errorMessage = errorBody.error.message;
        errorCode = errorBody.error.code || errorCode;
      }
    } catch {
      // Ignore JSON parse errors
    }

    logger.error('API error', { status: response.status, message: errorMessage });

    const isRetryable = RETRYABLE_STATUS_CODES.includes(response.status);
    const errorRetryDelay = RETRY_DELAYS[attempt];
    if (isRetryable && errorRetryDelay !== undefined) {
      logger.info(`Retrying in ${errorRetryDelay}ms...`);
      await sleep(errorRetryDelay);
      return makeRequest(body, attempt + 1);
    }

    throw createLLMError(errorMessage, errorCode, response.status, isRetryable);
  }

  const data = await response.json() as KimiChatResponse;
  logger.debug('Response received', {
    usage: data.usage,
    finishReason: data.choices[0]?.finish_reason,
  });

  return data;
}

export class KimiClient implements LLMClient {
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(options?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.model = options?.model ?? config.kimi.model;
    this.temperature = options?.temperature ?? 0.7;
    this.maxTokens = options?.maxTokens ?? 4096;
  }

  async complete(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[]
  ): Promise<LLMResponse> {
    const formattedMessages = formatMessages(systemPrompt, messages);

    const requestBody: KimiChatRequest = {
      model: this.model,
      messages: formattedMessages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };

    if (tools && tools.length > 0) {
      requestBody.tools = tools;
    }

    const response = await makeRequest(requestBody);

    const choice = response.choices[0];
    if (!choice) {
      throw createLLMError('No response choice returned', 'INVALID_RESPONSE');
    }

    const finishReason = choice.finish_reason as LLMResponse['finishReason'];

    return {
      content: choice.message.content,
      toolCalls: choice.message.tool_calls ?? null,
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      },
      finishReason,
    };
  }
}

export function createKimiClient(options?: {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): LLMClient {
  return new KimiClient(options);
}

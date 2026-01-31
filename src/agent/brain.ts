import type { Message, AssistantMessage, ToolMessage, UserMessage, LLMClient } from '../llm/types.js';
import { createKimiClient } from '../llm/kimi.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { truncateMessages } from './context-guard.js';
import { getToolDefinitions, executeTool, initializeTools, type ToolResult } from '../tools/index.js';
import { resetTurnContext } from '../tools/remember.js';
import { saveMessage, loadHistory } from '../memory/store.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('brain');

const MAX_TOOL_ITERATIONS = 10;

interface BrainConfig {
  maxToolIterations?: number;
  maxContextTokens?: number;
}

export class Brain {
  private client: LLMClient;
  private maxToolIterations: number;
  private maxContextTokens: number;
  private initialized: boolean = false;

  constructor(config?: BrainConfig) {
    this.client = createKimiClient();
    this.maxToolIterations = config?.maxToolIterations ?? MAX_TOOL_ITERATIONS;
    this.maxContextTokens = config?.maxContextTokens ?? 100000;
  }

  private initialize(): void {
    if (this.initialized) return;
    initializeTools();
    this.initialized = true;
    logger.info('Brain initialized');
  }

  async think(userInput: string): Promise<string> {
    this.initialize();

    // Reset turn context for rate limiting (Bug 9: max 3 remember() per turn)
    resetTurnContext();

    const userMessage: UserMessage = {
      role: 'user',
      content: userInput,
    };
    saveMessage(userMessage);

    let history = loadHistory();

    const { messages: truncatedHistory } = truncateMessages(history, this.maxContextTokens);

    const systemPrompt = await buildSystemPrompt();
    const tools = getToolDefinitions();

    let workingMessages: Message[] = [...truncatedHistory];
    let iterations = 0;

    while (iterations < this.maxToolIterations) {
      iterations++;
      logger.debug(`Agentic loop iteration ${iterations}`);

      const response = await this.client.complete(systemPrompt, workingMessages, tools);

      // Handle truncated responses (finish_reason = 'length')
      if (response.finishReason === 'length') {
        logger.warn('Response was truncated due to max_tokens limit');

        // If there are tool calls, they're likely malformed - don't process them
        if (response.toolCalls && response.toolCalls.length > 0) {
          const errorMessage = 'La respuesta fue cortada. Intentá con una pregunta más específica.';
          const assistantMessage: AssistantMessage = {
            role: 'assistant',
            content: errorMessage,
          };
          saveMessage(assistantMessage);
          return errorMessage;
        }

        // For text responses, append indicator that it was truncated
        const truncatedContent = (response.content ?? '') + '\n\n[Respuesta truncada por límite de longitud]';
        const assistantMessage: AssistantMessage = {
          role: 'assistant',
          content: truncatedContent,
        };
        saveMessage(assistantMessage);
        return truncatedContent;
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        const assistantMessage: AssistantMessage = {
          role: 'assistant',
          content: response.content,
          tool_calls: response.toolCalls,
        };
        workingMessages.push(assistantMessage);
        saveMessage(assistantMessage);

        for (const toolCall of response.toolCalls) {
          logger.info(`Tool call: ${toolCall.function.name}`);

          let result: ToolResult;
          try {
            const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
            result = await executeTool(toolCall.function.name, args);
          } catch (parseError) {
            logger.error('Failed to parse tool arguments', toolCall.function.arguments);
            result = {
              success: false,
              error: `Invalid tool arguments: expected valid JSON but got: ${toolCall.function.arguments.slice(0, 100)}`,
            };
          }

          const toolMessage: ToolMessage = {
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: toolCall.id,
          };
          workingMessages.push(toolMessage);
          saveMessage(toolMessage);
        }

        continue;
      }

      const finalContent = response.content ?? '';

      // Handle empty response
      if (!finalContent) {
        logger.warn('LLM returned empty response', { finishReason: response.finishReason });
        const fallbackContent = 'No pude generar una respuesta. ¿Podés reformular tu pregunta?';
        const assistantMessage: AssistantMessage = {
          role: 'assistant',
          content: fallbackContent,
        };
        saveMessage(assistantMessage);
        return fallbackContent;
      }

      const assistantMessage: AssistantMessage = {
        role: 'assistant',
        content: finalContent,
      };
      saveMessage(assistantMessage);

      logger.info(`Response generated after ${iterations} iteration(s)`);
      return finalContent;
    }

    logger.warn(`Max tool iterations (${this.maxToolIterations}) reached`);
    return 'Lo siento, no pude completar la tarea. Llegué al límite de iteraciones.';
  }

  getHistory(): Message[] {
    return loadHistory();
  }
}

let brainInstance: Brain | null = null;

export function getBrain(): Brain {
  if (!brainInstance) {
    brainInstance = new Brain();
  }
  return brainInstance;
}

export async function think(userInput: string): Promise<string> {
  const brain = getBrain();
  return brain.think(userInput);
}

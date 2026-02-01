import type { Message, AssistantMessage, ToolMessage, UserMessage, LLMClient } from '../llm/types.js';
import { createKimiClient } from '../llm/kimi.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { truncateMessages } from './context-guard.js';
import {
  getToolDefinitions,
  executeTool,
  initializeTools,
  createExecutionContext,
  notifyToolsTurnStart,
  type ToolResult,
  type ToolExecutionContext,
} from '../tools/index.js';
import { saveMessage, loadHistory } from '../memory/store.js';
import { queueForExtraction } from '../memory/extraction-service.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { getLocalRouter, type LocalRouter } from './local-router/index.js';

const logger = createLogger('brain');

const MAX_TOOL_ITERATIONS = 10;

interface BrainConfig {
  maxToolIterations?: number;
  maxContextTokens?: number;
}

/**
 * Issue #7: Options for think() to support both reactive and proactive modes.
 */
export interface ThinkOptions {
  /** User input message. Optional for proactive mode. */
  userInput?: string;
  /** Additional context for proactive messages (e.g., "morning check-in") */
  proactiveContext?: string;
  /** Whether to save the user message (default: true if userInput provided) */
  saveUserMessage?: boolean;
}

export class Brain {
  private client: LLMClient;
  private maxToolIterations: number;
  private maxContextTokens: number;
  private initialized: boolean = false;
  private localRouter: LocalRouter | null = null;

  constructor(brainConfig?: BrainConfig) {
    this.client = createKimiClient();
    this.maxToolIterations = brainConfig?.maxToolIterations ?? MAX_TOOL_ITERATIONS;
    this.maxContextTokens = brainConfig?.maxContextTokens ?? 100000;

    // Fase 3.5: Initialize LocalRouter if enabled
    if (config.localRouter.enabled) {
      this.localRouter = getLocalRouter(config.localRouter);
    }
  }

  private initialize(): void {
    if (this.initialized) return;
    initializeTools();
    this.initialized = true;
    logger.info('Brain initialized');
  }

  /**
   * Main thinking method. Processes input and generates a response.
   *
   * Issue #7: Accepts either a string (backward compatible) or ThinkOptions
   * to support proactive mode where no user input is needed.
   *
   * @param optionsOrInput - User input string or ThinkOptions object
   * @returns The assistant's response
   */
  async think(optionsOrInput: string | ThinkOptions): Promise<string> {
    this.initialize();

    // Issue #7: Normalize input to ThinkOptions for unified handling
    const options: ThinkOptions = typeof optionsOrInput === 'string'
      ? { userInput: optionsOrInput }
      : optionsOrInput;

    // Issue #1: Create fresh execution context for this turn
    // Issue #4: Notify all tools of turn start via registry hook
    const execContext: ToolExecutionContext = createExecutionContext();
    notifyToolsTurnStart();

    // Only undefined/null triggers proactive mode, not empty string
    const isProactiveMode = options.userInput == null;
    logger.debug('Starting new turn', {
      turnId: execContext.turnId,
      mode: isProactiveMode ? 'proactive' : 'reactive',
      proactiveContext: options.proactiveContext,
    });

    // Fase 3.5: Pre-Brain routing (only for user messages, not proactive mode)
    // INVARIANTE: Proactive mode ALWAYS bypasses LocalRouter
    if (
      !isProactiveMode &&
      options.userInput &&
      this.localRouter &&
      config.localRouter.enabled
    ) {
      const routingResult = await this.localRouter.tryRoute(options.userInput);

      if (routingResult.route === 'DIRECT_TOOL') {
        const execResult = await this.localRouter.executeDirect(
          routingResult.intent,
          routingResult.params || {}
        );

        if (execResult.success) {
          // Save with SAME format as agentic loop
          this.saveDirectResponse(options.userInput, execResult.response);

          logger.info('Direct execution successful', {
            intent: routingResult.intent,
            latency_ms: execResult.latencyMs,
          });

          return execResult.response;
        }

        // Tool failed -> fallback to Brain WITH CONTEXT
        this.localRouter.recordFallback();
        logger.warn('Direct execution failed, falling back to Brain', {
          intent: routingResult.intent,
          error: execResult.error,
        });

        // Continue to agentic loop - the message will be saved below
        // Note: We don't pass previous attempt context yet (could be added later)
      }

      // ROUTE_TO_LLM -> continue to agentic loop
    }

    // Issue #7: Only save user message if there's actual user input
    let lastMessageId: number | null = null;
    if (options.userInput) {
      const shouldSave = options.saveUserMessage !== false;
      if (shouldSave) {
        const userMessage: UserMessage = {
          role: 'user',
          content: options.userInput,
        };
        lastMessageId = saveMessage(userMessage);

        // Fase 2: Queue for async fact extraction (fire-and-forget)
        queueForExtraction(lastMessageId, options.userInput, 'user').catch(err => {
          logger.warn('Failed to queue extraction', { error: err instanceof Error ? err.message : err });
        });
      }
    }

    let history = loadHistory();

    // Issue #3: truncateMessages is now async to ensure backup completes
    // Fase 2: Pass current user message for topic shift detection
    const { messages: truncatedHistory, backupFailed, topicShiftDetected } = await truncateMessages(
      history,
      this.maxContextTokens,
      options.userInput // Pass for topic shift detection
    );

    if (backupFailed) {
      logger.warn('Backup of truncated messages failed - potential data loss');
    }

    if (topicShiftDetected) {
      logger.debug('Topic shift detected, context summarized');
    }

    const systemPrompt = await buildSystemPrompt();
    const tools = getToolDefinitions();

    // Issue #7: For proactive mode, add context as a system-style message
    let workingMessages: Message[] = [...truncatedHistory];

    if (isProactiveMode && options.proactiveContext) {
      // Add proactive context as a user message that won't be saved
      const contextMessage: UserMessage = {
        role: 'user',
        content: `[Sistema: ${options.proactiveContext}]`,
      };
      workingMessages.push(contextMessage);
    }

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
          logger.info(`Tool call: ${toolCall.function.name}`, { turnId: execContext.turnId });

          let result: ToolResult;
          try {
            const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
            // Issue #1: Pass execution context to tools
            result = await executeTool(toolCall.function.name, args, execContext);
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
    const maxIterationsContent = 'Lo siento, no pude completar la tarea. Llegué al límite de iteraciones.';
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: maxIterationsContent,
    };
    saveMessage(assistantMessage);
    return maxIterationsContent;
  }

  getHistory(): Message[] {
    return loadHistory();
  }

  /**
   * Fase 3.5: Save direct response with SAME format as agentic loop.
   * This ensures history consistency between direct and agentic paths.
   */
  private saveDirectResponse(userInput: string, response: string): void {
    // Save user message
    const userMessage: UserMessage = {
      role: 'user',
      content: userInput,
    };
    const messageId = saveMessage(userMessage);

    // Queue for async fact extraction (fire-and-forget)
    queueForExtraction(messageId, userInput, 'user').catch(err => {
      logger.warn('Failed to queue extraction for direct response', {
        error: err instanceof Error ? err.message : err,
      });
    });

    // Save assistant response
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: response,
    };
    saveMessage(assistantMessage);
  }

  /**
   * Issue #7: Initiate a proactive message without user input.
   * Used by the proactive loop in Fase 3.
   *
   * @param context - Context for why the agent is initiating (e.g., "morning greeting", "reminder check")
   * @returns The agent's proactive message, or null if the agent decides not to speak
   */
  async initiateProactive(context: string): Promise<string | null> {
    logger.info('Initiating proactive message', { context });

    try {
      const response = await this.think({
        proactiveContext: context,
        saveUserMessage: false,
      });

      // If the response is essentially empty or a refusal, return null
      if (!response || response.trim().length === 0) {
        logger.debug('Proactive initiation returned empty response');
        return null;
      }

      return response;
    } catch (error) {
      logger.error('Error in proactive initiation', { error, context });
      return null;
    }
  }
}

let brainInstance: Brain | null = null;

export function getBrain(): Brain {
  if (!brainInstance) {
    brainInstance = new Brain();
  }
  return brainInstance;
}

export async function think(optionsOrInput: string | ThinkOptions): Promise<string> {
  const brain = getBrain();
  return brain.think(optionsOrInput);
}

/**
 * Issue #7: Initiate a proactive message.
 */
export async function initiateProactive(context: string): Promise<string | null> {
  const brain = getBrain();
  return brain.initiateProactive(context);
}

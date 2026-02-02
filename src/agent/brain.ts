import type { Message, AssistantMessage, ToolMessage, UserMessage, LLMClient } from '../llm/types.js';
import { createKimiClient } from '../llm/kimi.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { truncateMessages } from './context-guard.js';
import {
  getToolDefinitionsWithMCP,
  executeTool,
  initializeTools,
  createExecutionContext,
  notifyToolsTurnStart,
  type ToolResult,
  type ToolExecutionContext,
} from '../tools/index.js';
import { saveMessage, loadHistory } from '../memory/store.js';
import { queueForExtraction, recordUserActivity } from '../memory/extraction-service.js';
import { createLogger } from '../utils/logger.js';
import {
  routeV2,
  isRouterV2Initialized,
  isLikelySimpleChat,
} from './local-router/router-v2.js';
import { executeIntent } from './local-router/direct-executor.js';
import { executeLocalIntent } from './local-router/local-executor.js';
import type { Intent } from './local-router/types.js';
import {
  executeProductivityTool,
  formatProductivityResult,
  isProductivityIntent,
} from '../tools/productivity/index.js';
import {
  recordMessageProcessed,
  recordToolExecuted,
  recordLocalRouterHit,
  recordLocalRouterBypass,
} from '../utils/metrics.js';
import {
  recordLocalRequest,
  recordLocalToApiFallback,
} from '../device/metrics.js';

const logger = createLogger('brain');

const MAX_TOOL_ITERATIONS = 10;
// C4: Maximum time for a single think() call before timing out
const BRAIN_TIMEOUT_MS = 120_000; // 2 minutes

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

  constructor(brainConfig?: BrainConfig) {
    this.client = createKimiClient();
    this.maxToolIterations = brainConfig?.maxToolIterations ?? MAX_TOOL_ITERATIONS;
    this.maxContextTokens = brainConfig?.maxContextTokens ?? 100000;
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
   * C4: Protected with timeout to prevent indefinite blocking.
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

    // C4: Create timeout promise to prevent indefinite blocking
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('Brain timeout: LLM took too long'));
      }, BRAIN_TIMEOUT_MS);
    });

    try {
      // Race between actual work and timeout
      return await Promise.race([
        this.doThink(options),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Brain timeout')) {
        logger.error('Brain timeout', { input: options.userInput?.slice(0, 50) });
        return 'Lo siento, tardé demasiado en responder. ¿Podés repetir?';
      }
      throw error;
    }
  }

  /**
   * C4: Internal think implementation, separated for timeout wrapping.
   */
  private async doThink(options: ThinkOptions): Promise<string> {

    // Issue #1: Create fresh execution context for this turn
    // Issue #4: Notify all tools of turn start via registry hook
    const execContext: ToolExecutionContext = createExecutionContext();
    notifyToolsTurnStart();

    // Only undefined/null triggers proactive mode, not empty string
    const isProactiveMode = options.userInput == null;

    // Record message for metrics (only reactive mode counts as user message)
    if (!isProactiveMode) {
      recordMessageProcessed();
      // OPTIMIZATION: Record user activity to trigger extraction cooling period
      // This prevents extraction from competing with user requests for Ollama
      recordUserActivity();
    }

    logger.debug('Starting new turn', {
      turnId: execContext.turnId,
      mode: isProactiveMode ? 'proactive' : 'reactive',
      proactiveContext: options.proactiveContext,
    });

    // OPTIMIZED: Unified 3-tier routing via routeV2
    // Replaces dual LocalRouter + RouterV2 flow with single classification
    // Uses fast-path patterns for common intents (translate, time, weather)
    if (!isProactiveMode && options.userInput && isRouterV2Initialized()) {
      const routeResult = await routeV2(options.userInput);

      // Tier 1: Deterministic (time, weather, reminders) - direct tool execution
      if (routeResult.tier === 'deterministic') {
        const intent = routeResult.intent as Intent;
        const params = routeResult.params || {};

        logger.info('Deterministic route', {
          intent,
          confidence: routeResult.confidence,
          reason: routeResult.reason,
        });

        const execResult = await executeIntent(intent, params);

        if (execResult.success) {
          this.saveDirectResponse(options.userInput, execResult.response);
          recordLocalRouterHit();

          logger.info('Deterministic execution successful', {
            intent,
            latencyMs: execResult.latencyMs,
          });

          return execResult.response;
        }

        // Deterministic failed -> fallback to API
        logger.warn('Deterministic execution failed, falling back to API', {
          intent,
          error: execResult.error,
        });
        recordLocalRouterBypass();
        // Continue to agentic loop
      }

      // Tier 2: Local LLM (translate, grammar, summarize, simple_chat)
      if (routeResult.tier === 'local' && routeResult.model) {
        const intent = routeResult.intent as string;

        // Productivity intents (translate, grammar_check, summarize)
        if (isProductivityIntent(intent)) {
          logger.info('Local LLM route (productivity)', {
            intent,
            model: routeResult.model,
            confidence: routeResult.confidence,
          });

          const toolResult = await executeProductivityTool(
            intent,
            options.userInput,
            routeResult.model,
            routeResult.params
          );

          if (toolResult.success) {
            const response = formatProductivityResult(intent, toolResult);
            this.saveDirectResponse(options.userInput, response);
            recordLocalRequest(intent, toolResult.latencyMs, 0, true);
            recordLocalRouterHit();

            logger.info('Productivity tool successful', {
              intent,
              model: routeResult.model,
              latencyMs: toolResult.latencyMs,
            });

            return response;
          }

          // Productivity failed -> fallback to API
          logger.warn('Productivity tool failed, falling back to API', {
            intent,
            error: toolResult.error,
          });
          recordLocalToApiFallback(intent);
          // Continue to agentic loop
        }

        // Simple chat (greetings, thanks, etc.)
        if (intent === 'simple_chat' && isLikelySimpleChat(options.userInput)) {
          logger.info('Local LLM route (simple_chat)', {
            model: routeResult.model,
          });

          const chatResult = await executeLocalIntent(
            'simple_chat',
            options.userInput,
            routeResult.model
          );

          if (chatResult.success && chatResult.response) {
            this.saveDirectResponse(options.userInput, chatResult.response);
            recordLocalRequest('simple_chat', chatResult.latencyMs, chatResult.tokensGenerated || 0, true);
            recordLocalRouterHit();

            return chatResult.response;
          }

          // Simple chat failed -> fallback to API
          logger.debug('Simple chat failed, falling back to API');
          recordLocalToApiFallback('simple_chat');
          // Continue to agentic loop
        }
      }

      // Tier 3: API - handled by agentic loop below
      if (routeResult.tier === 'api') {
        logger.debug('API route', {
          intent: routeResult.intent,
          reason: routeResult.reason,
        });
        recordLocalRouterBypass();
      }
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
    const {
      messages: truncatedHistory,
      truncated,
      originalCount,
      finalCount,
      backupFailed,
      topicShiftDetected,
    } = await truncateMessages(
      history,
      this.maxContextTokens,
      options.userInput // Pass for topic shift detection
    );

    if (backupFailed) {
      logger.warn('Backup of truncated messages failed - potential data loss');
    }

    // Fase 3.6: Alert user when significant context truncation occurs
    if (truncated && originalCount - finalCount > 2) {
      logger.info('Context truncated', {
        removed: originalCount - finalCount,
        remaining: finalCount,
      });
      // User-visible alert (will appear before response)
      console.log(`\n💡 Nota: Se resumió parte de la conversación anterior (${originalCount - finalCount} mensajes) para mantener el contexto manejable.\n`);
    }

    if (topicShiftDetected) {
      logger.debug('Topic shift detected, context summarized');
    }

    const systemPrompt = await buildSystemPrompt();
    const tools = await getToolDefinitionsWithMCP();

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
            recordToolExecuted(); // Centralized metrics
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

      const rawContent = response.content ?? '';

      // Handle empty response
      if (!rawContent) {
        logger.warn('LLM returned empty response', { finishReason: response.finishReason });
        const fallbackContent = 'No pude generar una respuesta. ¿Podés reformular tu pregunta?';
        const assistantMessage: AssistantMessage = {
          role: 'assistant',
          content: fallbackContent,
        };
        saveMessage(assistantMessage);
        return fallbackContent;
      }

      // BUG-001 Fix: Detect and handle JSON responses with shouldSpeak format
      // This can happen when the LLM confuses reactive mode with proactive mode
      const finalContent = this.extractMessageFromJsonIfNeeded(rawContent);

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
   * BUG-001 Fix: Extract message from JSON if the LLM responded with shouldSpeak format.
   * This can happen when the LLM confuses reactive mode with proactive mode.
   */
  private extractMessageFromJsonIfNeeded(content: string): string {
    // Quick check: if it doesn't look like JSON with shouldSpeak, return as-is
    if (!content.includes('shouldSpeak')) {
      return content;
    }

    try {
      // Try to find JSON in the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return content;
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      // Check if it's the shouldSpeak format
      if (typeof parsed.shouldSpeak !== 'boolean') {
        return content;
      }

      logger.warn('LLM responded with proactive JSON format in reactive mode, extracting message');

      // If shouldSpeak is false or message is empty, return a minimal acknowledgment
      if (!parsed.shouldSpeak || !parsed.message || typeof parsed.message !== 'string' || !parsed.message.trim()) {
        // Check if there's a reason that indicates the action was completed
        const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
        if (reason.toLowerCase().includes('recordatorio') || reason.toLowerCase().includes('reminder')) {
          return 'Listo.';
        }
        return 'Entendido.';
      }

      // Return the extracted message
      return parsed.message;
    } catch {
      // JSON parse failed, return original content
      return content;
    }
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

/**
 * Productivity Tools - Fase 3.6b
 *
 * Local LLM-powered productivity tools:
 * - translate: Multi-language translation
 * - grammar_check: Spelling and grammar correction
 * - summarize: Text summarization
 * - explain: Concept explanation
 *
 * These tools are designed to run 100% locally with Ollama models,
 * with fallback to API when local execution fails.
 */

import { createLogger } from '../../utils/logger.js';
import type {
  ProductivityIntent,
  ProductivityToolResult,
  TranslateParams,
  TranslateResult,
  GrammarCheckParams,
  GrammarCheckResult,
  SummarizeParams,
  SummarizeResult,
  ExplainParams,
  ExplainResult,
} from './types.js';

// Tool implementations
import {
  executeTranslate,
  formatTranslateResult,
  detectTargetLanguage,
  extractTextToTranslate,
  SUPPORTED_LANGUAGES,
} from './translate.js';
import {
  executeGrammarCheck,
  formatGrammarCheckResult,
  extractTextToCheck,
} from './grammar-check.js';
import {
  executeSummarize,
  formatSummarizeResult,
  detectFormat,
  detectLength,
  extractTextToSummarize,
} from './summarize.js';
import {
  executeExplain,
  formatExplainResult,
  detectLevel,
  extractTopic,
  detectLanguage,
} from './explain.js';

const logger = createLogger('productivity');

// Re-export types
export type {
  ProductivityIntent,
  ProductivityToolResult,
  TranslateParams,
  TranslateResult,
  GrammarCheckParams,
  GrammarCheckResult,
  SummarizeParams,
  SummarizeResult,
  ExplainParams,
  ExplainResult,
};

// Re-export utilities
export {
  SUPPORTED_LANGUAGES,
  detectTargetLanguage,
  extractTextToTranslate,
  extractTextToCheck,
  detectFormat,
  detectLength,
  extractTextToSummarize,
  detectLevel,
  extractTopic,
  detectLanguage,
};

/**
 * Execute a productivity tool based on intent.
 *
 * This is the main entry point for executing productivity tools.
 * It handles parameter extraction from user input and delegates
 * to the appropriate tool implementation.
 *
 * @param intent - The productivity intent (translate, grammar_check, summarize, explain)
 * @param userInput - The original user input
 * @param model - The local model to use
 * @param params - Optional pre-extracted parameters from router
 * @returns Tool execution result
 */
export async function executeProductivityTool(
  intent: ProductivityIntent,
  userInput: string,
  model: string,
  params?: Record<string, string>
): Promise<ProductivityToolResult<unknown>> {
  logger.debug('Executing productivity tool', { intent, model, hasParams: !!params });

  switch (intent) {
    case 'translate': {
      const targetLang = params?.target_language
        ? Object.entries(SUPPORTED_LANGUAGES).find(([, name]) =>
            name.toLowerCase() === params.target_language?.toLowerCase()
          )?.[0] || detectTargetLanguage(userInput)
        : detectTargetLanguage(userInput);

      if (!targetLang) {
        return {
          success: false,
          error: 'No pude detectar el idioma destino. Por favor especifica: "traduce al [idioma]"',
          latencyMs: 0,
        };
      }

      const text = extractTextToTranslate(userInput);
      const translateParams: TranslateParams = {
        text,
        targetLang,
      };

      return executeTranslate(translateParams, model);
    }

    case 'grammar_check': {
      const text = extractTextToCheck(userInput);
      const grammarParams: GrammarCheckParams = {
        text,
        language: params?.language,
      };

      return executeGrammarCheck(grammarParams, model);
    }

    case 'summarize': {
      const text = extractTextToSummarize(userInput);
      const summarizeParams: SummarizeParams = {
        text,
        format: detectFormat(userInput),
        length: detectLength(userInput),
      };

      return executeSummarize(summarizeParams, model);
    }

    case 'explain': {
      const topic = extractTopic(userInput);
      const language = detectLanguage(userInput);
      const level = detectLevel(userInput);

      const explainParams: ExplainParams = {
        topic,
        level,
        language,
      };

      return executeExplain(explainParams, model);
    }

    default:
      logger.error('Unknown productivity intent', { intent });
      return {
        success: false,
        error: `Intent de productividad desconocido: ${intent}`,
        latencyMs: 0,
      };
  }
}

/**
 * Format a productivity tool result for user display.
 */
export function formatProductivityResult(
  intent: ProductivityIntent,
  result: ProductivityToolResult<unknown>
): string {
  if (!result.success) {
    return result.error || 'Error desconocido';
  }

  switch (intent) {
    case 'translate':
      return formatTranslateResult(result.data as TranslateResult);
    case 'grammar_check':
      return formatGrammarCheckResult(result.data as GrammarCheckResult);
    case 'summarize':
      return formatSummarizeResult(result.data as SummarizeResult);
    case 'explain':
      return formatExplainResult(result.data as ExplainResult);
    default:
      return JSON.stringify(result.data);
  }
}

/**
 * Check if an intent is a productivity intent.
 */
export function isProductivityIntent(intent: string): intent is ProductivityIntent {
  return ['translate', 'grammar_check', 'summarize', 'explain'].includes(intent);
}

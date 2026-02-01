/**
 * Ollama Client for Memory Agent (Fase 2)
 *
 * Client for local Qwen2.5:3b-instruct model via Ollama API.
 * Used for:
 * - Fact extraction from user messages
 * - Conversation summarization
 *
 * The model runs locally on Ollama (localhost:11434), providing
 * low-latency, zero-cost LLM calls for memory processing.
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('ollama');

// Ollama API configuration
const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MEMORY_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b-instruct';

// Timeout for Ollama requests (30 seconds - local model should be fast)
const REQUEST_TIMEOUT_MS = 30_000;

export interface OllamaResponse {
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaGenerateOptions {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  num_predict?: number;
}

/**
 * Checks if Ollama is available and the memory model is loaded.
 * Returns model info if available, null otherwise.
 */
export async function checkOllamaAvailability(): Promise<{ available: boolean; model?: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { available: false, error: `Ollama returned ${response.status}` };
    }

    const data = await response.json() as { models?: Array<{ name: string }> };
    const models = data.models || [];
    // Validate exact model name, not just prefix
    // Accept both "model" and "model:latest" formats
    const hasModel = models.some(
      m => m.name === MEMORY_MODEL || m.name === `${MEMORY_MODEL}:latest`
    );

    if (!hasModel) {
      return {
        available: false,
        error: `Model ${MEMORY_MODEL} not found. Run: ollama pull ${MEMORY_MODEL}`,
      };
    }

    return { available: true, model: MEMORY_MODEL };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { available: false, error: `Cannot connect to Ollama: ${message}` };
  }
}

/**
 * Cleans LLM response by removing markdown code blocks and trimming.
 * Handles common patterns like ```json ... ``` or ``` ... ```
 */
export function cleanJsonResponse(raw: string): string {
  return raw
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();
}

/**
 * Generates a response from the local Ollama model.
 *
 * @param prompt - The prompt to send to the model
 * @param options - Optional generation parameters
 * @returns The model's response text (cleaned of markdown formatting)
 * @throws Error if Ollama is unavailable or request fails
 */
export async function generateWithOllama(
  prompt: string,
  options: OllamaGenerateOptions = {}
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    logger.debug('Sending request to Ollama', {
      model: MEMORY_MODEL,
      promptLength: prompt.length,
    });

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MEMORY_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.1, // Low temp for consistent extraction
          top_p: options.top_p ?? 0.9,
          top_k: options.top_k ?? 40,
          num_predict: options.num_predict ?? 1024,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OllamaResponse;

    logger.debug('Ollama response received', {
      responseLength: data.response?.length ?? 0,
      evalCount: data.eval_count,
      totalDuration: data.total_duration,
    });

    return cleanJsonResponse(data.response);
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }

    throw error;
  }
}

/**
 * Validates that a string is valid JSON and returns parsed object.
 * Returns null if parsing fails.
 */
export function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    logger.warn('Failed to parse JSON from Ollama response', {
      text: text.slice(0, 200),
    });
    return null;
  }
}

/**
 * Generates and parses JSON from Ollama.
 * Combines generation and parsing with proper error handling.
 *
 * @param prompt - The prompt (should instruct model to output JSON)
 * @param options - Optional generation parameters
 * @returns Parsed JSON object or null if parsing fails
 */
export async function generateJsonWithOllama<T>(
  prompt: string,
  options: OllamaGenerateOptions = {}
): Promise<T | null> {
  try {
    const response = await generateWithOllama(prompt, options);
    return parseJsonSafe<T>(response);
  } catch (error) {
    logger.error('Ollama JSON generation failed', { error });
    return null;
  }
}

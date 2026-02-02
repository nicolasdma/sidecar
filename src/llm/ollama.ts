/**
 * Ollama Client for Memory Agent (Fase 2)
 *
 * Client for local LLM via Ollama API.
 * Used for:
 * - Fact extraction from user messages
 * - Conversation summarization
 * - Intent classification
 *
 * The model runs locally on Ollama (localhost:11434), providing
 * low-latency, zero-cost LLM calls for memory processing.
 */

import { createLogger } from '../utils/logger.js';
import { getDeviceProfile } from '../device/index.js';

const logger = createLogger('ollama');

// Ollama API configuration
const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

/**
 * Cache of installed models (refreshed periodically)
 */
let installedModelsCache: string[] = [];
let cacheLastRefresh = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Get list of installed models (cached)
 */
async function getInstalledModels(): Promise<string[]> {
  const now = Date.now();
  if (now - cacheLastRefresh < CACHE_TTL_MS && installedModelsCache.length > 0) {
    return installedModelsCache;
  }

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return installedModelsCache;

    const data = await response.json() as { models?: Array<{ name: string }> };
    installedModelsCache = data.models?.map((m) => m.name) || [];
    cacheLastRefresh = now;
    return installedModelsCache;
  } catch {
    return installedModelsCache;
  }
}

/**
 * Check if a model is installed (handles name variations)
 */
function isModelInstalled(modelName: string, installedModels: string[]): boolean {
  const normalized = modelName.toLowerCase().replace(':latest', '');
  return installedModels.some((m) => {
    const installed = m.toLowerCase().replace(':latest', '');
    return installed === normalized || installed.startsWith(normalized + ':') || normalized.startsWith(installed + ':');
  });
}

/**
 * Find the best available model from a list of preferences.
 * Falls back through the list until it finds one that's installed.
 */
export async function findAvailableModel(preferences: string[]): Promise<string | null> {
  const installed = await getInstalledModels();
  if (installed.length === 0) return null;

  // Try each preference in order
  for (const model of preferences) {
    if (isModelInstalled(model, installed)) {
      return model;
    }
  }

  // No preference available, return first installed model
  logger.debug('No preferred model available, using fallback', {
    preferences,
    installed,
    fallback: installed[0],
  });
  return installed[0] || null;
}

/**
 * Get the default model from device profile.
 * Simple: just returns the configured classifier model.
 * Use resolveClassifierModel() for validated model selection.
 */
function getDefaultModel(): string {
  const profile = getDeviceProfile();
  if (profile && profile.classifierModel !== 'none') {
    return profile.classifierModel;
  }
  return process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';
}

/**
 * Resolve the classifier model, ensuring it's actually available.
 * Falls back to recommended models or any installed model.
 */
export async function resolveClassifierModel(): Promise<string | null> {
  const profile = getDeviceProfile();
  if (!profile || profile.classifierModel === 'none') {
    return null;
  }

  // Build preference list: classifier first, then recommended models
  const preferences = [
    profile.classifierModel,
    ...profile.recommendedModels,
  ];

  return findAvailableModel(preferences);
}

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
 * Checks if Ollama is available and optionally if a specific model is available.
 *
 * @param modelName - Optional model to check for. If provided, validates it's installed.
 *                    If not provided, just checks Ollama is running.
 * @returns Availability status with optional model info
 */
export async function checkOllamaAvailability(modelName?: string): Promise<{ available: boolean; model?: string; error?: string }> {
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

    // If no model specified, just return that Ollama is available
    if (!modelName) {
      return { available: true };
    }

    // Validate specific model is installed
    // Accept both "model" and "model:latest" formats
    const hasModel = models.some(
      m => m.name === modelName || m.name === `${modelName}:latest` ||
           m.name.replace(':latest', '') === modelName.replace(':latest', '')
    );

    if (!hasModel) {
      return {
        available: false,
        error: `Model ${modelName} not found. Run: ollama pull ${modelName}`,
      };
    }

    return { available: true, model: modelName };
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
 * @param modelName - Optional model override (uses device profile default if not specified)
 * @returns The model's response text (cleaned of markdown formatting)
 * @throws Error if Ollama is unavailable or request fails
 */
export async function generateWithOllama(
  prompt: string,
  options: OllamaGenerateOptions = {},
  modelName?: string
): Promise<string> {
  const model = modelName || getDefaultModel();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    logger.debug('Sending request to Ollama', {
      model,
      promptLength: prompt.length,
    });

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
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

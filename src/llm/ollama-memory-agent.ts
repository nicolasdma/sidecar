/**
 * Ollama Memory Agent Implementation (Fase 2)
 *
 * Implements MemoryAgent interface using local Ollama model.
 * Uses Qwen2.5:3b-instruct for fact extraction and summarization.
 */

import type { MemoryAgent, MemoryAgentConfig } from './memory-agent.js';
import type { Message } from './types.js';
import {
  parseExtractedFacts,
  parseSummary,
  safeJsonParse,
  cleanLlmResponse,
  type ExtractedFact,
  type Summary,
} from '../memory/schemas.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ollama-memory');

// Prompts for memory operations
const EXTRACTION_PROMPT = `Extract facts about the user from this message.
Output ONLY valid JSON array, no explanations.

Format:
[{"fact": "text", "domain": "work|preferences|decisions|personal|projects|health|relationships|schedule|goals|general", "confidence": "high|medium|low"}]

If no facts found, output: []

Look for:
- Identity: "I am...", "I work at..."
- Preferences: "I like...", "I prefer..."
- Decisions: "I decided...", "from now on..."
- Personal info: family, health, routines
- Work: job, projects, colleagues
- Goals: plans, objectives, intentions

Message:
`;

const SUMMARIZATION_PROMPT = `Summarize these conversation messages into structured JSON.
Output ONLY valid JSON, no markdown, no explanations.

Format:
{"topic": "main topic (2-3 words)", "discussed": ["point1", "point2"], "outcome": "conclusion if any", "decisions": ["decision made"], "open_questions": ["unresolved question"]}

Use null for fields with no content (outcome, decisions, open_questions).
Keep discussed points concise (max 10 words each).
Maximum 5 discussed points, 3 decisions, 3 open questions.

Messages:
`;

/**
 * Ollama-based implementation of MemoryAgent.
 */
export class OllamaMemoryAgent implements MemoryAgent {
  readonly providerName = 'ollama';

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  // Health check cache (30 second TTL)
  private healthCache: { available: boolean; checkedAt: number } | null = null;
  private readonly healthCacheTtlMs = 30_000;

  constructor(config: MemoryAgentConfig) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.model = config.model || 'qwen2.5:3b-instruct';
    this.timeoutMs = config.timeoutMs || 30_000;
  }

  async isAvailable(): Promise<boolean> {
    // Return cached result if still valid
    if (this.healthCache) {
      const age = Date.now() - this.healthCache.checkedAt;
      if (age < this.healthCacheTtlMs) {
        return this.healthCache.available;
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        this.healthCache = { available: false, checkedAt: Date.now() };
        return false;
      }

      const data = (await response.json()) as { models?: Array<{ name: string }> };
      const models = data.models || [];
      const modelPrefix = this.model.split(':')[0] || '';
      const hasModel = models.some((m) => m.name.startsWith(modelPrefix));

      this.healthCache = { available: hasModel, checkedAt: Date.now() };

      if (!hasModel) {
        logger.warn(`Model ${this.model} not found in Ollama`);
      }

      return hasModel;
    } catch (error) {
      this.healthCache = { available: false, checkedAt: Date.now() };
      logger.debug('Ollama health check failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      return false;
    }
  }

  async extractFacts(content: string): Promise<ExtractedFact[]> {
    const available = await this.isAvailable();
    if (!available) {
      throw new Error('Ollama not available');
    }

    const prompt = EXTRACTION_PROMPT + content;
    const rawResponse = await this.generate(prompt);
    const cleanedResponse = cleanLlmResponse(rawResponse);

    const parsed = safeJsonParse(cleanedResponse);
    if (parsed === null) {
      logger.debug('Failed to parse extraction response', {
        response: cleanedResponse.slice(0, 200),
      });
      return [];
    }

    return parseExtractedFacts(parsed, logger);
  }

  async summarize(messages: Message[]): Promise<Summary | null> {
    const available = await this.isAvailable();
    if (!available) {
      throw new Error('Ollama not available');
    }

    const formattedMessages = this.formatMessagesForPrompt(messages);
    const prompt = SUMMARIZATION_PROMPT + formattedMessages;
    const rawResponse = await this.generate(prompt);
    const cleanedResponse = cleanLlmResponse(rawResponse);

    const parsed = safeJsonParse(cleanedResponse);
    if (parsed === null) {
      logger.warn('Failed to parse summary response', {
        response: cleanedResponse.slice(0, 200),
      });
      return null;
    }

    return parseSummary(parsed, logger);
  }

  /**
   * Generates a response from Ollama.
   */
  private async generate(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      logger.debug('Sending request to Ollama', {
        model: this.model,
        promptLength: prompt.length,
      });

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: {
            temperature: 0.1, // Low temp for consistent extraction
            top_p: 0.9,
            top_k: 40,
            num_predict: 1024,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as { response: string };

      logger.debug('Ollama response received', {
        responseLength: data.response?.length ?? 0,
      });

      return data.response || '';
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Ollama request timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    }
  }

  /**
   * Formats messages for the summarization prompt.
   */
  private formatMessagesForPrompt(messages: Message[]): string {
    return messages
      .map((m) => {
        const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Tool';
        const content = m.content?.slice(0, 500) || '[no content]';
        return `${role}: ${content}`;
      })
      .join('\n\n');
  }
}

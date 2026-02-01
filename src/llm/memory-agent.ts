/**
 * Memory Agent Interface (Fase 2)
 *
 * Abstracts the LLM provider used for memory operations (fact extraction,
 * summarization). This enables:
 * - Easy unit testing with mock implementations
 * - Swapping providers (Ollama -> Claude) without changing consumers
 * - Clear contract for memory-related LLM operations
 */

import type { Message } from './types.js';
import type { ExtractedFact, Summary } from '../memory/schemas.js';

/**
 * Interface for memory-related LLM operations.
 * Implementations must handle their own error recovery and retries.
 */
export interface MemoryAgent {
  /**
   * Extracts facts about the user from a message.
   * Returns validated facts ready for storage.
   *
   * @param content - User message to extract facts from
   * @returns Array of extracted facts (may be empty)
   * @throws Error if the provider is unavailable
   */
  extractFacts(content: string): Promise<ExtractedFact[]>;

  /**
   * Generates a structured summary of conversation messages.
   *
   * @param messages - Messages to summarize
   * @returns Structured summary or null if generation fails
   * @throws Error if the provider is unavailable
   */
  summarize(messages: Message[]): Promise<Summary | null>;

  /**
   * Checks if the memory agent provider is available.
   * Results may be cached for performance.
   *
   * @returns True if the provider can accept requests
   */
  isAvailable(): Promise<boolean>;

  /**
   * Returns the provider name for logging/debugging.
   */
  readonly providerName: string;
}

/**
 * Configuration for creating a memory agent.
 */
export interface MemoryAgentConfig {
  /** Provider type */
  provider: 'ollama';
  /** Base URL for the provider API */
  baseUrl?: string;
  /** Model name to use */
  model?: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

// Default configuration
const DEFAULT_CONFIG: MemoryAgentConfig = {
  provider: 'ollama',
  baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  model: process.env.OLLAMA_MODEL || 'qwen2.5:3b-instruct',
  timeoutMs: 30_000,
};

// Singleton instance
let memoryAgentInstance: MemoryAgent | null = null;

/**
 * Gets or creates the memory agent singleton.
 * Uses lazy initialization to avoid startup overhead if not used.
 *
 * @param config - Optional configuration (only used on first call)
 * @returns The memory agent instance
 */
export function getMemoryAgent(config?: Partial<MemoryAgentConfig>): MemoryAgent {
  if (!memoryAgentInstance) {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };

    // Import dynamically to avoid circular dependencies
    // and allow future provider implementations
    switch (finalConfig.provider) {
      case 'ollama':
        // Use the OllamaMemoryAgent implementation
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { OllamaMemoryAgent } = require('./ollama-memory-agent.js') as {
          OllamaMemoryAgent: new (config: MemoryAgentConfig) => MemoryAgent;
        };
        memoryAgentInstance = new OllamaMemoryAgent(finalConfig);
        break;
      default:
        throw new Error(`Unknown memory agent provider: ${finalConfig.provider}`);
    }
  }

  return memoryAgentInstance!;
}

/**
 * Resets the memory agent singleton.
 * Primarily used for testing.
 */
export function resetMemoryAgent(): void {
  memoryAgentInstance = null;
}

/**
 * Sets a custom memory agent instance.
 * Primarily used for testing with mocks.
 */
export function setMemoryAgent(agent: MemoryAgent): void {
  memoryAgentInstance = agent;
}

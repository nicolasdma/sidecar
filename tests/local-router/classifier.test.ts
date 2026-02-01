/**
 * Classifier Tests - Fase 3.5 Bugfixes
 *
 * Unit tests for the intent classifier.
 * Mocks Ollama to avoid requiring a running instance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Intent, Route } from '../../src/agent/local-router/types.js';

// Use vi.hoisted to create mock functions before module loading
const mocks = vi.hoisted(() => ({
  checkOllamaAvailability: vi.fn(),
  generateWithOllama: vi.fn(),
}));

vi.mock('../../src/llm/ollama.js', () => ({
  checkOllamaAvailability: mocks.checkOllamaAvailability,
  generateWithOllama: mocks.generateWithOllama,
}));

import { classifyIntent, validateModel, warmupClassifier } from '../../src/agent/local-router/classifier.js';

describe('Intent Classifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('validateModel', () => {
    it('returns valid=false when Ollama is not available', async () => {
      mocks.checkOllamaAvailability.mockResolvedValue({
        available: false,
        error: 'Connection refused',
      });

      const result = await validateModel();

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    it('returns valid=true when model is available', async () => {
      mocks.checkOllamaAvailability.mockResolvedValue({
        available: true,
        model: 'qwen2.5:3b-instruct',
      });

      const result = await validateModel();

      expect(result.valid).toBe(true);
    });

    it('returns valid=false when model is missing', async () => {
      mocks.checkOllamaAvailability.mockResolvedValue({
        available: true,
        model: null,
      });

      const result = await validateModel();

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  describe('classifyIntent', () => {
    describe('when Ollama unavailable', () => {
      it('returns ROUTE_TO_LLM with unknown intent', async () => {
        mocks.checkOllamaAvailability.mockResolvedValue({
          available: false,
          error: 'Connection refused',
        });

        const result = await classifyIntent('qué hora es');

        expect(result.route).toBe('ROUTE_TO_LLM');
        expect(result.intent).toBe('unknown');
        expect(result.confidence).toBe(0);
      });
    });

    describe('when Ollama available', () => {
      beforeEach(() => {
        mocks.checkOllamaAvailability.mockResolvedValue({
          available: true,
          model: 'qwen2.5:3b-instruct',
        });
      });

      it('classifies time queries correctly', async () => {
        mocks.generateWithOllama.mockResolvedValue('{"intent": "time", "confidence": 0.95}');

        const result = await classifyIntent('qué hora es');

        expect(result.intent).toBe('time');
        expect(result.confidence).toBe(0.95);
        expect(result.route).toBe('DIRECT_TOOL');
      });

      it('routes low confidence to LLM', async () => {
        mocks.generateWithOllama.mockResolvedValue('{"intent": "time", "confidence": 0.5}');

        // Note: "hora?" is a single word not in known list, so validation rules
        // change it to 'ambiguous'. This is correct behavior.
        const result = await classifyIntent('hora?');

        expect(result.route).toBe('ROUTE_TO_LLM');
        // The validation rules may change the intent to 'ambiguous' for single-word
        // inputs not in the known list (hora? != hora)
        expect(['time', 'ambiguous']).toContain(result.intent);
      });

      it('classifies weather queries correctly', async () => {
        mocks.generateWithOllama.mockResolvedValue(
          '{"intent": "weather", "confidence": 0.9, "params": {"location": "Buenos Aires"}}'
        );

        const result = await classifyIntent('clima en Buenos Aires');

        expect(result.intent).toBe('weather');
        expect(result.route).toBe('DIRECT_TOOL');
        expect(result.params?.location).toBe('Buenos Aires');
      });

      it('classifies reminder correctly with params', async () => {
        mocks.generateWithOllama.mockResolvedValue(
          '{"intent": "reminder", "confidence": 0.95, "params": {"time": "en 10 minutos", "message": "llamar al banco"}}'
        );

        const result = await classifyIntent('recordame en 10 minutos llamar al banco');

        expect(result.intent).toBe('reminder');
        expect(result.route).toBe('DIRECT_TOOL');
        expect(result.params?.time).toBe('en 10 minutos');
        expect(result.params?.message).toBe('llamar al banco');
      });

      it('routes conversation to LLM', async () => {
        mocks.generateWithOllama.mockResolvedValue('{"intent": "conversation", "confidence": 0.99}');

        const result = await classifyIntent('hola, cómo estás?');

        expect(result.intent).toBe('conversation');
        expect(result.route).toBe('ROUTE_TO_LLM');
      });

      it('routes question to LLM', async () => {
        mocks.generateWithOllama.mockResolvedValue('{"intent": "question", "confidence": 0.9}');

        const result = await classifyIntent('qué es la fotosíntesis?');

        expect(result.intent).toBe('question');
        expect(result.route).toBe('ROUTE_TO_LLM');
      });

      it('handles malformed JSON gracefully', async () => {
        mocks.generateWithOllama.mockResolvedValue('Not valid JSON at all');

        const result = await classifyIntent('test message');

        expect(result.intent).toBe('unknown');
        expect(result.confidence).toBe(0);
        expect(result.route).toBe('ROUTE_TO_LLM');
      });

      it('handles partial JSON in response', async () => {
        mocks.generateWithOllama.mockResolvedValue(
          'Based on analysis, {"intent": "time", "confidence": 0.8} seems right'
        );

        const result = await classifyIntent('qué hora es');

        expect(result.intent).toBe('time');
        expect(result.confidence).toBe(0.8);
      });

      it('handles Ollama errors gracefully', async () => {
        mocks.generateWithOllama.mockRejectedValue(new Error('Network timeout'));

        const result = await classifyIntent('test');

        expect(result.intent).toBe('unknown');
        expect(result.route).toBe('ROUTE_TO_LLM');
        expect(result.rawResponse).toContain('Network timeout');
      });
    });
  });

  describe('warmupClassifier', () => {
    it('returns success when Ollama responds', async () => {
      mocks.checkOllamaAvailability.mockResolvedValue({
        available: true,
        model: 'qwen2.5:3b-instruct',
      });
      mocks.generateWithOllama.mockResolvedValue('{"intent": "unknown", "confidence": 0.5}');

      const result = await warmupClassifier();

      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns success but with fallback when Ollama is unavailable', async () => {
      mocks.checkOllamaAvailability.mockResolvedValue({
        available: false,
        error: 'Not running',
      });

      const result = await warmupClassifier();

      // warmup returns success because classify itself completes (just falls back)
      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});

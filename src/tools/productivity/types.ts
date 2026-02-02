/**
 * Productivity Tools Types - Fase 3.6b
 *
 * Type definitions for all productivity tools.
 */

/**
 * Base result type for productivity tools.
 */
export interface ProductivityToolResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  latencyMs: number;
  /** Disclaimer if JSON extraction failed */
  disclaimer?: string;
}

// ============================================
// TRANSLATE TOOL
// ============================================

export interface TranslateParams {
  /** Text to translate */
  text: string;
  /** Target language code (es, en, fr, etc.) */
  targetLang: string;
  /** Source language code (optional, auto-detect if not specified) */
  sourceLang?: string;
  /** Formality level */
  formality?: 'formal' | 'informal';
}

export interface TranslateResult {
  /** Original text */
  original: string;
  /** Translated text */
  translated: string;
  /** Target language code */
  targetLang: string;
  /** Detected source language (if auto-detected) */
  detectedLang?: string;
}

// ============================================
// GRAMMAR CHECK TOOL
// ============================================

export interface GrammarCheckParams {
  /** Text to check */
  text: string;
  /** Language of the text (optional, auto-detect if not specified) */
  language?: string;
  /** Target style */
  style?: 'formal' | 'informal' | 'academic';
}

export interface GrammarChange {
  /** Type of change */
  type: 'spelling' | 'grammar' | 'punctuation' | 'style';
  /** Original text fragment */
  original: string;
  /** Corrected text fragment */
  corrected: string;
  /** Explanation of the correction */
  explanation?: string;
}

export interface GrammarCheckResult {
  /** Original text */
  original: string;
  /** Corrected text */
  corrected: string;
  /** List of changes made */
  changes: GrammarChange[];
  /** Summary of corrections */
  summary: string;
}

/** Raw response from LLM for grammar check */
export interface GrammarCheckLLMResponse {
  corrected: string;
  changes?: Array<{
    type?: string;
    original?: string;
    corrected?: string;
    explanation?: string;
  }>;
}

// ============================================
// SUMMARIZE TOOL
// ============================================

export interface SummarizeParams {
  /** Text to summarize */
  text: string;
  /** Length of summary */
  length?: 'brief' | 'medium' | 'detailed';
  /** Output format */
  format?: 'paragraph' | 'bullets' | 'tldr';
  /** Language of summary (same as input if not specified) */
  language?: string;
}

export interface SummarizeResult {
  /** Original text word count */
  originalLength: number;
  /** Summary text */
  summary: string;
  /** Summary word count */
  summaryLength: number;
  /** Compression ratio (summary/original) */
  compressionRatio: number;
}

// ============================================
// EXPLAIN TOOL
// ============================================

export interface ExplainParams {
  /** Topic or concept to explain */
  topic: string;
  /** Complexity level */
  level?: 'eli5' | 'beginner' | 'intermediate' | 'expert';
  /** Additional context */
  context?: string;
  /** Language of explanation */
  language?: string;
}

export interface ExplainResult {
  /** Topic that was explained */
  topic: string;
  /** The explanation */
  explanation: string;
  /** Examples (if provided) */
  examples?: string[];
  /** Related concepts */
  related?: string[];
}

// ============================================
// UNIFIED TOOL INTERFACE
// ============================================

export type ProductivityIntent = 'translate' | 'grammar_check' | 'summarize' | 'explain';

export interface ProductivityExecuteRequest {
  intent: ProductivityIntent;
  userInput: string;
  model: string;
  params?: Record<string, string>;
}

export type ProductivityResult =
  | ProductivityToolResult<TranslateResult>
  | ProductivityToolResult<GrammarCheckResult>
  | ProductivityToolResult<SummarizeResult>
  | ProductivityToolResult<ExplainResult>;

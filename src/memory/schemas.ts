/**
 * Zod Schemas for Memory Services (Fase 2)
 *
 * Validates LLM responses to prevent malformed data from corrupting storage.
 * Using Zod provides:
 * - Runtime validation with TypeScript type inference
 * - Clear error messages for debugging LLM issues
 * - Safe parsing that never throws
 */

import { z } from 'zod';

// ============= Fact Extraction Schemas =============

/**
 * Valid domains for facts.
 * Must match FactDomain type in store.ts
 */
export const FactDomainSchema = z.enum([
  'work',
  'preferences',
  'decisions',
  'personal',
  'projects',
  'health',
  'relationships',
  'schedule',
  'goals',
  'general',
]);

export type FactDomain = z.infer<typeof FactDomainSchema>;

/**
 * Valid confidence levels for extracted facts.
 */
export const FactConfidenceSchema = z.enum(['high', 'medium', 'low']);

export type FactConfidence = z.infer<typeof FactConfidenceSchema>;

/**
 * Schema for a single extracted fact from LLM.
 */
export const ExtractedFactSchema = z.object({
  fact: z
    .string()
    .min(5, 'Fact too short')
    .max(500, 'Fact too long')
    .transform(s => s.trim()),
  domain: FactDomainSchema,
  confidence: FactConfidenceSchema.default('medium'),
});

export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

/**
 * Schema for the array of facts returned by extraction LLM.
 * Allows partial success - valid facts are kept, invalid ones logged.
 */
export const ExtractedFactsArraySchema = z.array(ExtractedFactSchema);

/**
 * Parses extracted facts with graceful degradation.
 * Returns valid facts and logs warnings for invalid ones.
 */
export function parseExtractedFacts(
  raw: unknown,
  logger?: { warn: (msg: string, meta?: object) => void }
): ExtractedFact[] {
  // Handle null/undefined
  if (raw === null || raw === undefined) {
    return [];
  }

  // Must be an array
  if (!Array.isArray(raw)) {
    logger?.warn('Extraction response is not an array', { type: typeof raw });
    return [];
  }

  // Parse each item, keeping valid ones
  const validFacts: ExtractedFact[] = [];

  for (let i = 0; i < raw.length; i++) {
    const result = ExtractedFactSchema.safeParse(raw[i]);

    if (result.success) {
      // Additional validation: reject facts that are just domain names
      const factLower = result.data.fact.toLowerCase();
      if (FactDomainSchema.options.includes(factLower as FactDomain)) {
        logger?.warn('Rejected fact: is just a domain name', { fact: result.data.fact });
        continue;
      }

      validFacts.push(result.data);
    } else {
      logger?.warn('Invalid fact in extraction response', {
        index: i,
        errors: result.error.flatten().fieldErrors,
        raw: JSON.stringify(raw[i]).slice(0, 100),
      });
    }
  }

  return validFacts;
}

// ============= Summary Schemas =============

/**
 * Schema for a conversation summary from LLM.
 */
export const SummarySchema = z.object({
  topic: z
    .string()
    .min(1, 'Topic required')
    .max(50, 'Topic too long')
    .transform(s => s.trim()),

  discussed: z
    .array(z.string().max(100).transform(s => s.trim()))
    .min(1, 'At least one discussed point required')
    .max(5, 'Maximum 5 discussed points')
    .transform(arr => arr.filter(s => s.length > 0)),

  outcome: z
    .string()
    .max(200)
    .transform(s => s.trim())
    .nullable()
    .optional()
    .transform(v => v || null),

  decisions: z
    .array(z.string().max(100).transform(s => s.trim()))
    .max(3)
    .nullable()
    .optional()
    .transform(arr => arr?.filter(s => s.length > 0) || null),

  open_questions: z
    .array(z.string().max(100).transform(s => s.trim()))
    .max(3)
    .nullable()
    .optional()
    .transform(arr => arr?.filter(s => s.length > 0) || null),
});

export type Summary = z.infer<typeof SummarySchema>;

/**
 * Parses a summary with validation.
 * Returns null if parsing fails.
 */
export function parseSummary(
  raw: unknown,
  logger?: { warn: (msg: string, meta?: object) => void }
): Summary | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const result = SummarySchema.safeParse(raw);

  if (result.success) {
    return result.data;
  }

  logger?.warn('Invalid summary from LLM', {
    errors: result.error.flatten().fieldErrors,
    raw: JSON.stringify(raw).slice(0, 200),
  });

  return null;
}

// ============= JSON Parsing Helpers =============

/**
 * Safely parses JSON string, returning null on failure.
 */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Cleans LLM response by removing markdown code blocks.
 */
export function cleanLlmResponse(raw: string): string {
  return raw
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();
}

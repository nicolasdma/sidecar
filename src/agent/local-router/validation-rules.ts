/**
 * Post-Classification Validation Rules - Fase 3.5
 *
 * Hardcoded rules that override LLM classification for known edge cases.
 * These rules provide extra safety against false positives.
 */

import type { Intent, Route } from './types.js';

export interface ValidationOverride {
  intent?: Intent;
  route: Route;
}

/**
 * Apply post-classification validation rules.
 *
 * Returns override if the classification should be changed, null otherwise.
 */
export function applyValidationRules(
  originalMessage: string,
  intent: Intent,
  params?: Record<string, string>
): ValidationOverride | null {
  const lower = originalMessage.toLowerCase().trim();

  // Rule 1: Negations - "no me...", "no quiero...", "no necesito...", "no te..."
  // BUT: "no me dejes olvidar" is a valid reminder
  if (/^no\s+(me|quiero|necesito|te)\b/.test(lower)) {
    // Exception: "no me dejes olvidar" pattern
    if (/no\s+me\s+dejes\s+olvidar/.test(lower)) {
      return null; // Allow reminder classification
    }
    return { intent: 'conversation', route: 'ROUTE_TO_LLM' };
  }

  // Rule 2: Mass actions - "todos/todas" with cancel/delete/eliminar
  // These need confirmation from the full LLM
  if (
    /\b(todos?|todas?)\b/.test(lower) &&
    /\b(elimina|borra|cancela|delete|remove)\b/.test(lower)
  ) {
    return { route: 'ROUTE_TO_LLM' }; // Keep intent, but route to LLM for confirmation
  }

  // Rule 3: Fact memory pattern - "recordame que [fact about user]"
  // Patterns: soy, tengo, trabajo, vivo, estoy, me gusta, prefiero, no puedo, no me gusta
  // These should be stored as facts, not scheduled reminders
  // IMPORTANT: Must come BEFORE incomplete reminder check
  if (
    intent === 'reminder' &&
    /\brecord[aá]me\s+que\s+(soy|tengo|trabajo|vivo|estoy|me\s+gusta|prefiero|no\s+puedo|no\s+me\s+gusta)\b/i.test(
      lower
    )
  ) {
    return { intent: 'fact_memory', route: 'ROUTE_TO_LLM' };
  }

  // Rule 4: Suggestions - "deberías...", "podrías...", "quizás...", "tal vez...", "capaz que..."
  // These are not commands
  // IMPORTANT: Must come BEFORE incomplete reminder and single word checks
  if (/^(deberías|podrías|quizás|tal\s*vez|capaz\s+que)\b/.test(lower)) {
    return { intent: 'conversation', route: 'ROUTE_TO_LLM' };
  }

  // Rule 5: Incomplete reminder - classified as reminder but missing required params
  if (intent === 'reminder') {
    const hasTime = params?.time && params.time.trim().length > 0;
    const hasMessage = params?.message && params.message.trim().length > 0;

    if (!hasTime || !hasMessage) {
      return { intent: 'ambiguous', route: 'ROUTE_TO_LLM' };
    }
  }

  // Rule 6: Single word without clear intent (extra safety)
  // Only known single-word commands are allowed
  const wordCount = lower.split(/\s+/).filter((w) => w.length > 0).length;
  const knownSingleWords = [
    'hora',
    'clima',
    'tiempo',
    'recordatorios',
    'reminders',
  ];

  if (wordCount === 1 && !knownSingleWords.includes(lower)) {
    return { intent: 'ambiguous', route: 'ROUTE_TO_LLM' };
  }

  // Rule 7: Questions about reminders (not listing them)
  // "cuántos recordatorios tengo?" is different from "qué recordatorios tengo?"
  if (
    intent === 'list_reminders' &&
    /\bcu[aá]ntos\b/.test(lower)
  ) {
    // This is still list_reminders, but the question format might need LLM handling
    // We allow it to go through direct tool since list_reminders returns count
    return null;
  }

  return null; // No override needed
}

/**
 * Keywords that strongly indicate specific intents.
 * Used for quick validation.
 */
export const INTENT_KEYWORDS: Record<string, Intent[]> = {
  hora: ['time'],
  tiempo: ['time', 'weather'],
  clima: ['weather'],
  temperatura: ['weather'],
  lluvia: ['weather'],
  llover: ['weather'],
  paraguas: ['weather'],
  frío: ['weather'],
  calor: ['weather'],
  grados: ['weather'],
  recordatorios: ['list_reminders'],
  reminders: ['list_reminders'],
  recordame: ['reminder', 'fact_memory'],
  avisame: ['reminder'],
  acórdame: ['reminder'],
  cancela: ['cancel_reminder'],
  borra: ['cancel_reminder'],
  elimina: ['cancel_reminder'],
};

export default applyValidationRules;

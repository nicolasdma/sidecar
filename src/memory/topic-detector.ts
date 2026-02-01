/**
 * Topic Shift Detector (Fase 2)
 *
 * Heuristic-based detection of conversation topic changes.
 * No LLM required - uses keyword matching and phrase detection.
 *
 * Detection Rules:
 * 1. Explicit phrases: "otra cosa", "cambiando de tema", etc.
 * 2. Domain transitions: work -> personal, health -> work, etc.
 */

import type { Message } from '../llm/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('topic-detector');

// Domain types for tracking
export type ConversationDomain = 'work' | 'personal' | 'health' | 'tech' | 'general';

// Explicit topic shift phrases (Spanish + English)
const TOPIC_SHIFT_PHRASES = [
  // Spanish
  'otra cosa',
  'cambiando de tema',
  'te quería preguntar sobre',
  'dejando eso de lado',
  'hablando de otra cosa',
  'pasando a otro tema',
  'cambiemos de tema',
  'antes de que me olvide',
  'aprovecho para',
  'por cierto',
  'a propósito',
  'che,',
  'che ',
  // English
  'by the way',
  'on another note',
  'changing the subject',
  'speaking of which',
  'that reminds me',
  'on a different topic',
  'switching gears',
];

// Domain keyword mapping
const DOMAIN_KEYWORDS: Record<ConversationDomain, string[]> = {
  work: [
    'trabajo', 'proyecto', 'código', 'deploy', 'bug', 'reunión', 'meeting',
    'jefe', 'cliente', 'deadline', 'sprint', 'tarea', 'oficina', 'equipo',
    'commit', 'pull request', 'review', 'producción', 'servidor', 'api',
    'work', 'office', 'boss', 'team', 'project',
  ],
  personal: [
    'familia', 'amigos', 'casa', 'vida', 'vacaciones', 'finde', 'fin de semana',
    'cumpleaños', 'fiesta', 'relación', 'pareja', 'hijo', 'hija', 'padres',
    'mamá', 'papá', 'hermano', 'hermana', 'perro', 'gato', 'mascota',
    'family', 'friends', 'home', 'vacation', 'weekend', 'birthday', 'party',
  ],
  health: [
    'salud', 'médico', 'doctor', 'ejercicio', 'dieta', 'gimnasio', 'dormir',
    'sueño', 'dolor', 'enfermo', 'síntoma', 'medicamento', 'vitamina',
    'cansado', 'estrés', 'ansiedad', 'terapia', 'psicólogo', 'nutrición',
    'health', 'doctor', 'exercise', 'diet', 'gym', 'sleep', 'tired', 'stress',
  ],
  tech: [
    'computadora', 'celular', 'teléfono', 'app', 'aplicación', 'programa',
    'software', 'hardware', 'internet', 'wifi', 'actualización', 'instalación',
    'computer', 'phone', 'app', 'software', 'internet', 'update',
  ],
  general: [],
};

export interface TopicShiftResult {
  shifted: boolean;
  reason?: string;
  previousDomain?: ConversationDomain;
  newDomain?: ConversationDomain;
}

/**
 * Normalizes text for matching: lowercase, remove accents.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Checks if text contains any of the topic shift phrases.
 */
function containsShiftPhrase(text: string): string | null {
  const normalized = normalizeText(text);
  for (const phrase of TOPIC_SHIFT_PHRASES) {
    if (normalized.includes(normalizeText(phrase))) {
      return phrase;
    }
  }
  return null;
}

/**
 * Detects the dominant domain in a text based on keyword frequency.
 */
function detectDomain(text: string): ConversationDomain {
  const normalized = normalizeText(text);
  const words = normalized.split(/\s+/);

  const scores: Record<ConversationDomain, number> = {
    work: 0,
    personal: 0,
    health: 0,
    tech: 0,
    general: 0,
  };

  for (const word of words) {
    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      if (keywords.some(kw => normalizeText(kw) === word || word.includes(normalizeText(kw)))) {
        scores[domain as ConversationDomain]++;
      }
    }
  }

  // Find domain with highest score
  let maxDomain: ConversationDomain = 'general';
  let maxScore = 0;

  for (const [domain, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxDomain = domain as ConversationDomain;
    }
  }

  return maxDomain;
}

/**
 * Extracts text content from messages for domain analysis.
 */
function extractMessageText(messages: Message[]): string {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => m.content || '')
    .join(' ');
}

/**
 * Detects if a topic shift has occurred between the current message
 * and recent conversation history.
 *
 * @param currentMessage - The latest user message
 * @param previousMessages - Recent conversation history (typically last 3-5 messages)
 * @returns Topic shift detection result
 */
export function detectTopicShift(
  currentMessage: string,
  previousMessages: Message[]
): TopicShiftResult {
  // Check for explicit shift phrases first
  const shiftPhrase = containsShiftPhrase(currentMessage);
  if (shiftPhrase) {
    logger.debug('Topic shift detected via phrase', { phrase: shiftPhrase });
    return {
      shifted: true,
      reason: `Explicit phrase: "${shiftPhrase}"`,
    };
  }

  // If no previous messages, no shift possible
  if (previousMessages.length === 0) {
    return { shifted: false };
  }

  // Detect domains
  const previousText = extractMessageText(previousMessages);
  const previousDomain = detectDomain(previousText);
  const currentDomain = detectDomain(currentMessage);

  // Domain transition detected?
  if (previousDomain !== 'general' &&
      currentDomain !== 'general' &&
      previousDomain !== currentDomain) {
    logger.debug('Topic shift detected via domain transition', {
      from: previousDomain,
      to: currentDomain,
    });
    return {
      shifted: true,
      reason: `Domain transition: ${previousDomain} -> ${currentDomain}`,
      previousDomain,
      newDomain: currentDomain,
    };
  }

  return { shifted: false };
}

/**
 * Gets the current conversation domain from recent messages.
 */
export function getCurrentDomain(messages: Message[]): ConversationDomain {
  if (messages.length === 0) {
    return 'general';
  }
  const text = extractMessageText(messages);
  return detectDomain(text);
}

/**
 * Checks if a topic shift warrants triggering summarization.
 * Only significant shifts should trigger summarization.
 */
export function shouldTriggerSummarization(result: TopicShiftResult): boolean {
  if (!result.shifted) {
    return false;
  }

  // Explicit phrases always trigger
  if (result.reason?.startsWith('Explicit phrase')) {
    return true;
  }

  // Domain transitions trigger if moving away from work/health (important domains)
  if (result.previousDomain === 'work' || result.previousDomain === 'health') {
    return true;
  }

  return false;
}

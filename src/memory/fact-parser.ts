/**
 * Parser para facts en formato learnings.md
 * Formato: [weight:N] fact text | learned:YYYY-MM-DD | confirmed:YYYY-MM-DD
 */

export interface Fact {
  weight: number;        // 1-10
  text: string;          // El contenido del fact
  learned: string;       // Fecha de creación (YYYY-MM-DD)
  confirmed: string;     // Última confirmación (YYYY-MM-DD)
  category?: string;     // Categoría (Health, Preferences, etc.)
  raw?: string;          // Línea original si hubo error de parsing
}

export interface ParseResult {
  facts: Fact[];
  unparsed: string[];    // Líneas que no matchearon el formato
  warnings: string[];    // Mensajes de warning para logging
}

/**
 * Regex para parsear una línea de fact.
 *
 * Formato esperado: - [weight:N] fact text | learned:YYYY-MM-DD | confirmed:YYYY-MM-DD
 *
 * Grupos:
 * 1: weight (1-10)
 * 2: fact text
 * 3: learned date
 * 4: confirmed date
 */
const FACT_REGEX = /^-?\s*\[weight:(\d{1,2})\]\s+(.+?)\s+\|\s+learned:(\d{4}-\d{2}-\d{2})\s+\|\s+confirmed:(\d{4}-\d{2}-\d{2})\s*$/;

/**
 * Regex para detectar headers de categoría (## Category)
 */
const CATEGORY_REGEX = /^##\s+(.+)$/;

/**
 * Categorías válidas según el schema
 */
export const VALID_CATEGORIES = [
  'Health',
  'Preferences',
  'Work',
  'Relationships',
  'Schedule',
  'Goals',
  'General',
  'Unparsed', // Para líneas con formato inválido
] as const;

export type FactCategory = typeof VALID_CATEGORIES[number];

/**
 * Valida que una fecha tenga formato YYYY-MM-DD y sea válida.
 */
function isValidDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const date = new Date(dateStr);
  return !isNaN(date.getTime());
}

/**
 * Valida que el weight esté en rango 1-10.
 */
function isValidWeight(weight: number): boolean {
  return Number.isInteger(weight) && weight >= 1 && weight <= 10;
}

/**
 * Parsea una línea individual de fact.
 * Retorna Fact si es válida, null si no matchea el formato.
 */
export function parseFact(line: string, category: string = 'General'): Fact | null {
  const trimmed = line.trim();

  // Ignorar líneas vacías y comentarios
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const match = trimmed.match(FACT_REGEX);
  if (!match) {
    return null;
  }

  const [, weightStr, text, learned, confirmed] = match;
  const weight = parseInt(weightStr, 10);

  // Validaciones
  if (!isValidWeight(weight)) {
    return null;
  }
  if (!isValidDate(learned) || !isValidDate(confirmed)) {
    return null;
  }
  if (!text.trim()) {
    return null;
  }

  return {
    weight,
    text: text.trim(),
    learned,
    confirmed,
    category,
  };
}

/**
 * Parsea el contenido completo de learnings.md.
 * Maneja categorías (## Header) y facts (- [weight:N] ...).
 * Facts inválidos van a la categoría Unparsed con warning.
 */
export function parseLearningsFile(content: string): ParseResult {
  const lines = content.split('\n');
  const facts: Fact[] = [];
  const unparsed: string[] = [];
  const warnings: string[] = [];

  let currentCategory = 'General';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    // Línea vacía o título principal
    if (!trimmed || trimmed === '# Learnings') {
      continue;
    }

    // Header de categoría
    const categoryMatch = trimmed.match(CATEGORY_REGEX);
    if (categoryMatch) {
      const categoryName = categoryMatch[1].trim();
      if (VALID_CATEGORIES.includes(categoryName as FactCategory)) {
        currentCategory = categoryName;
      } else {
        warnings.push(`Línea ${lineNum}: Categoría desconocida "${categoryName}", usando General`);
        currentCategory = 'General';
      }
      continue;
    }

    // Intentar parsear como fact (solo si empieza con -)
    if (trimmed.startsWith('-')) {
      const fact = parseFact(trimmed, currentCategory);
      if (fact) {
        facts.push(fact);
      } else {
        // Línea que parece fact pero tiene formato inválido
        unparsed.push(trimmed);
        warnings.push(`Línea ${lineNum}: Formato inválido, movido a Unparsed`);
      }
    }
    // Ignorar otras líneas (texto descriptivo, etc.)
  }

  return { facts, unparsed, warnings };
}

/**
 * Formatea un fact al formato de archivo.
 */
export function formatFact(fact: Fact): string {
  return `- [weight:${fact.weight}] ${fact.text} | learned:${fact.learned} | confirmed:${fact.confirmed}`;
}

/**
 * Obtiene la fecha actual en formato YYYY-MM-DD.
 */
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Crea un nuevo fact con valores por defecto.
 */
export function createFact(text: string, category: FactCategory = 'General'): Fact {
  const today = getTodayDate();
  return {
    weight: 1,
    text: text.trim(),
    learned: today,
    confirmed: today,
    category,
  };
}

/**
 * Calcula días desde una fecha hasta hoy.
 */
export function daysSince(dateStr: string): number {
  const date = new Date(dateStr);
  const today = new Date();
  const diffTime = today.getTime() - date.getTime();
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Calcula el recency factor basado en la fecha de confirmación.
 * <7 días: 1.0, 7-30 días: 0.8, 30-90 días: 0.5, >90 días: 0.3
 */
export function recencyFactor(confirmedDate: string): number {
  const days = daysSince(confirmedDate);
  if (days < 7) return 1.0;
  if (days < 30) return 0.8;
  if (days < 90) return 0.5;
  return 0.3;
}

/**
 * Calcula el score de un fact para priorización.
 * score = weight * recencyFactor
 */
export function calculateScore(fact: Fact): number {
  return fact.weight * recencyFactor(fact.confirmed);
}

/**
 * Stopwords en español para el algoritmo de word overlap.
 * Usadas para filtrar palabras sin significado semántico en deduplicación de facts.
 */

export const STOPWORDS_ES = new Set([
  // Artículos
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',

  // Preposiciones
  'a', 'ante', 'con', 'de', 'del', 'desde', 'en', 'entre',
  'hacia', 'hasta', 'para', 'por', 'sin', 'sobre',

  // Pronombres
  'yo', 'me', 'mi', 'tu', 'te', 'ti', 'el', 'ella', 'le', 'lo',
  'nos', 'se', 'su', 'sus', 'que', 'quien',

  // Verbos auxiliares comunes
  'es', 'son', 'soy', 'sos', 'fue', 'ser', 'estar', 'está', 'estoy',
  'ha', 'he', 'hay', 'tiene', 'tengo',

  // Conjunciones y conectores
  'y', 'e', 'o', 'u', 'pero', 'como', 'si', 'no', 'ni',

  // Adverbios comunes
  'muy', 'mas', 'más', 'ya', 'solo', 'sólo', 'bien', 'mal',

  // Demostrativos
  'este', 'esta', 'esto', 'ese', 'esa', 'eso',

  // Otros
  'al', 'algo', 'todo', 'toda', 'todos', 'todas', 'otro', 'otra',
]);

/**
 * Verifica si una palabra es stopword.
 * Normaliza a minúsculas antes de comparar.
 */
export function isStopword(word: string): boolean {
  return STOPWORDS_ES.has(word.toLowerCase());
}

/**
 * Filtra stopwords de un array de palabras.
 */
export function filterStopwords(words: string[]): string[] {
  return words.filter(word => !isStopword(word));
}

/**
 * Tokeniza un texto y filtra stopwords.
 * Retorna palabras significativas en minúsculas.
 */
export function extractSignificantWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remover acentos para matching
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, '')) // Solo alfanuméricos
    .filter(w => w.length > 1); // Ignorar palabras de 1 char

  return new Set(filterStopwords(words));
}

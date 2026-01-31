/**
 * Patrones heurísticos para detectar facts potenciales en mensajes.
 * Usado por context-guard para advertir antes de truncar mensajes
 * que podrían contener información importante no guardada.
 *
 * Bug 12 mitigation: Detectar facts potenciales antes de perderlos.
 */

export interface FactPattern {
  name: string;
  pattern: RegExp;
  category: string;
  priority: 'critical' | 'high' | 'medium';
}

/**
 * Patrones para detectar facts potenciales en texto.
 * Ordenados por prioridad (críticos primero).
 */
export const FACT_PATTERNS: FactPattern[] = [
  // === CRITICAL: Health (nunca perder) ===
  {
    name: 'alergia',
    pattern: /\b(soy|tengo|sufro de?)\s+(alérgico|alergica|alergia)\s+(a|al|a la|a los|a las)?\s*\w+/i,
    category: 'Health',
    priority: 'critical',
  },
  {
    name: 'condicion_medica',
    pattern: /\b(soy|tengo|sufro de?|me diagnosticaron)\s+(diabético|diabética|diabetes|diabetico|diabetica|celíaco|celiaco|celíaca|celiaca|hipertenso|hipertensa|hipertensión|hipertension|asma|asmático|asmatico|epilepsia|epiléptico|epileptico)/i,
    category: 'Health',
    priority: 'critical',
  },
  {
    name: 'intolerancia',
    pattern: /\b(soy|tengo)\s+(intolerante|intolerancia)\s+(a|al)?\s*\w+/i,
    category: 'Health',
    priority: 'critical',
  },
  {
    name: 'medicamentos',
    pattern: /\b(tomo|estoy tomando|me recetaron)\s+\w+\s*(para|por|diariamente|todos los días)?/i,
    category: 'Health',
    priority: 'critical',
  },
  {
    name: 'restriccion_alimentaria',
    pattern: /\b(soy|no puedo comer|no como)\s+(vegetariano|vegetariana|vegano|vegana|carnívoro|carnivoro)/i,
    category: 'Health',
    priority: 'critical',
  },
  {
    name: 'no_puedo_comer',
    pattern: /\bno puedo (comer|tomar|consumir|ingerir)\s+\w+/i,
    category: 'Health',
    priority: 'critical',
  },

  // === HIGH: Relationships ===
  {
    name: 'familiar',
    pattern: /\bmi\s+(hermano|hermana|esposo|esposa|marido|mujer|hijo|hija|madre|mamá|mama|padre|papá|papa|abuelo|abuela|tío|tia|tío|primo|prima|cuñado|cuñada|suegro|suegra|novio|novia|pareja)\s+(se llama|es|tiene|vive|trabaja)/i,
    category: 'Relationships',
    priority: 'high',
  },
  {
    name: 'nombre_familiar',
    pattern: /\b(mi\s+)?(hermano|hermana|esposo|esposa|hijo|hija|madre|padre)\s+\w+\s+(es|tiene|vive)/i,
    category: 'Relationships',
    priority: 'high',
  },

  // === HIGH: Work ===
  {
    name: 'trabajo_en',
    pattern: /\b(trabajo|laburo|curro)\s+(en|para|como)\s+\w+/i,
    category: 'Work',
    priority: 'high',
  },
  {
    name: 'profesion',
    pattern: /\bsoy\s+(desarrollador|programador|ingeniero|diseñador|médico|abogado|contador|profesor|estudiante|freelancer|emprendedor)\w*/i,
    category: 'Work',
    priority: 'high',
  },

  // === MEDIUM: Preferences ===
  {
    name: 'preferencia_positiva',
    pattern: /\b(me gusta|me encanta|amo|adoro|prefiero|me copa|me fascina)\s+(el|la|los|las)?\s*\w+/i,
    category: 'Preferences',
    priority: 'medium',
  },
  {
    name: 'preferencia_negativa',
    pattern: /\b(no me gusta|odio|detesto|no soporto|no banco)\s+(el|la|los|las)?\s*\w+/i,
    category: 'Preferences',
    priority: 'medium',
  },

  // === MEDIUM: Schedule ===
  {
    name: 'rutina',
    pattern: /\b(todos los|cada)\s+(días|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|mañana|tarde|noche)\s+(hago|voy|tengo|como|tomo)/i,
    category: 'Schedule',
    priority: 'medium',
  },
  {
    name: 'horario',
    pattern: /\b(me levanto|me despierto|desayuno|almuerzo|ceno|me acuesto)\s+(a las|tipo|cerca de las)?\s*\d+/i,
    category: 'Schedule',
    priority: 'medium',
  },

  // === MEDIUM: Goals ===
  {
    name: 'objetivo',
    pattern: /\b(quiero|necesito|planeo|mi objetivo es|mi meta es|estoy tratando de)\s+\w+/i,
    category: 'Goals',
    priority: 'medium',
  },

  // === MEDIUM: General identity ===
  {
    name: 'identidad',
    pattern: /\bsoy\s+(de|argentino|argentina|chileno|chilena|mexicano|mexicana|colombiano|colombiana|español|española)\b/i,
    category: 'General',
    priority: 'medium',
  },
  {
    name: 'edad',
    pattern: /\btengo\s+\d+\s+(años|añitos)/i,
    category: 'General',
    priority: 'medium',
  },
  {
    name: 'cumpleanos',
    pattern: /\b(mi cumpleaños|cumplo años|nací)\s+(es|el|en)?\s*\d+/i,
    category: 'General',
    priority: 'medium',
  },
];

/**
 * Resultado de escanear un mensaje por facts potenciales.
 */
export interface ScanResult {
  hasPotentialFacts: boolean;
  matches: Array<{
    pattern: string;
    category: string;
    priority: 'critical' | 'high' | 'medium';
    excerpt: string;
  }>;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
}

/**
 * Escanea un texto buscando facts potenciales.
 * Retorna matches encontrados con su prioridad.
 */
export function scanForPotentialFacts(text: string): ScanResult {
  const matches: ScanResult['matches'] = [];

  for (const factPattern of FACT_PATTERNS) {
    const match = text.match(factPattern.pattern);
    if (match) {
      // Extraer un excerpt alrededor del match
      const matchIndex = match.index ?? 0;
      const start = Math.max(0, matchIndex - 10);
      const end = Math.min(text.length, matchIndex + match[0].length + 20);
      const excerpt = text.slice(start, end).replace(/\n/g, ' ').trim();

      matches.push({
        pattern: factPattern.name,
        category: factPattern.category,
        priority: factPattern.priority,
        excerpt: excerpt.length > 60 ? excerpt.slice(0, 57) + '...' : excerpt,
      });
    }
  }

  return {
    hasPotentialFacts: matches.length > 0,
    matches,
    criticalCount: matches.filter(m => m.priority === 'critical').length,
    highCount: matches.filter(m => m.priority === 'high').length,
    mediumCount: matches.filter(m => m.priority === 'medium').length,
  };
}

/**
 * Escanea múltiples mensajes y retorna facts potenciales encontrados.
 */
export function scanMessagesForFacts(
  messages: Array<{ role: string; content: string | null }>
): ScanResult {
  const allMatches: ScanResult['matches'] = [];

  for (const msg of messages) {
    // Solo escanear mensajes del usuario (los del assistant son respuestas)
    if (msg.role === 'user' && msg.content) {
      const result = scanForPotentialFacts(msg.content);
      allMatches.push(...result.matches);
    }
  }

  // Deduplicar por pattern name
  const uniqueMatches = allMatches.filter(
    (match, index, self) =>
      index === self.findIndex(m => m.pattern === match.pattern && m.excerpt === match.excerpt)
  );

  return {
    hasPotentialFacts: uniqueMatches.length > 0,
    matches: uniqueMatches,
    criticalCount: uniqueMatches.filter(m => m.priority === 'critical').length,
    highCount: uniqueMatches.filter(m => m.priority === 'high').length,
    mediumCount: uniqueMatches.filter(m => m.priority === 'medium').length,
  };
}

/**
 * Knowledge management: user.md + learnings.md
 *
 * Implementa el sistema de memoria persistente híbrido (Tier 1).
 * - user.md: Perfil del usuario (editable manualmente)
 * - learnings.md: Facts aprendidos por el agente
 */

import { readFile, writeFile, rename, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { estimateTokens, TOKEN_BUDGETS } from '../utils/tokens.js';
import { withLock } from '../utils/file-mutex.js';
import {
  type Fact,
  type FactCategory,
  type ParseResult,
  VALID_CATEGORIES,
  parseLearningsFile,
  formatFact,
  createFact,
  calculateScore,
  getTodayDate,
} from './fact-parser.js';
import { extractSignificantWords } from './stopwords.js';

const log = createLogger('knowledge');

// Issue #5: Use centralized paths from config
const KNOWLEDGE_DIR = config.paths.knowledge;
const USER_MD_PATH = config.paths.userMd;
const LEARNINGS_MD_PATH = config.paths.learningsMd;

// Thresholds para deduplicación (Bug 11)
const DEDUP_THRESHOLD_DEFAULT = 0.70;  // 70% word overlap
const DEDUP_THRESHOLD_HEALTH = 0.80;   // 80% para Health (más conservador)
const MIN_DIFFERENT_WORDS = 2;         // Si hay ≥2 palabras diferentes, crear nuevo

/**
 * Resultado de una operación de remember.
 */
export interface RememberResult {
  action: 'created' | 'updated' | 'duplicate_kept_in_health' | 'rate_limited';
  fact: Fact | null;
  message: string;
}

/**
 * Carga el contenido de user.md.
 */
export async function loadUserProfile(): Promise<string> {
  try {
    if (!existsSync(USER_MD_PATH)) {
      log.warn('user.md no encontrado, retornando vacío');
      return '';
    }
    return await readFile(USER_MD_PATH, 'utf-8');
  } catch (error) {
    log.error('Error leyendo user.md', { error });
    return '';
  }
}

/**
 * Carga y parsea learnings.md.
 * Retorna facts parseados + warnings.
 *
 * Includes crash recovery: if an orphaned .tmp file exists from an
 * interrupted atomic write, it will be recovered before reading.
 */
export async function loadLearnings(): Promise<ParseResult> {
  try {
    const tempPath = LEARNINGS_MD_PATH + '.tmp';

    // Crash recovery: check for orphaned .tmp file
    if (existsSync(tempPath)) {
      log.warn('Found orphaned .tmp file from interrupted write, attempting recovery');
      try {
        const tempContent = await readFile(tempPath, 'utf-8');
        const tempResult = parseLearningsFile(tempContent);

        // Validate .tmp has meaningful content before recovering
        if (tempResult.facts.length > 0 || tempContent.includes('# Learnings')) {
          log.info('Recovering from .tmp file', { facts: tempResult.facts.length });
          // Complete the interrupted atomic rename
          await rename(tempPath, LEARNINGS_MD_PATH);
        } else {
          // Empty or corrupted .tmp, delete it
          log.warn('Orphaned .tmp file is empty or invalid, deleting');
          await unlink(tempPath);
        }
      } catch (recoveryError) {
        log.error('Failed to recover from .tmp file', { error: recoveryError });
        // Attempt to remove corrupt .tmp to prevent blocking future operations
        try {
          await unlink(tempPath);
        } catch {
          // Ignore unlink errors - file may have been removed by another process
        }
      }
    }

    if (!existsSync(LEARNINGS_MD_PATH)) {
      log.warn('learnings.md no encontrado');
      return { facts: [], unparsed: [], warnings: [] };
    }
    const content = await readFile(LEARNINGS_MD_PATH, 'utf-8');
    const result = parseLearningsFile(content);

    // Log warnings de parsing (Bug 2)
    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        log.warn(warning);
      }
    }

    // Log count al iniciar
    log.info(`Loaded ${result.facts.length} facts (${result.unparsed.length} unparsed)`);

    return result;
  } catch (error) {
    log.error('Error leyendo learnings.md', { error });
    return { facts: [], unparsed: [], warnings: [] };
  }
}

/**
 * Carga todo el knowledge (user + learnings) como string para el prompt.
 */
export async function loadKnowledge(): Promise<string> {
  const [userProfile, learningsResult] = await Promise.all([
    loadUserProfile(),
    loadLearnings(),
  ]);

  // Formatear learnings para incluir en prompt
  const learningsFormatted = formatLearningsForPrompt(learningsResult.facts);

  return `${userProfile}\n\n${learningsFormatted}`;
}

/**
 * Formatea facts para incluir en el prompt.
 * Ordena por score y trunca si es necesario.
 * Issue #6: Uses centralized token estimation.
 */
export function formatLearningsForPrompt(
  facts: Fact[],
  maxTokens: number = TOKEN_BUDGETS.MAX_LEARNINGS_TOKENS
): string {
  if (facts.length === 0) {
    return '';
  }

  // Separar Health (nunca truncar - Bug 7) del resto
  const healthFacts = facts.filter(f => f.category === 'Health');
  const otherFacts = facts.filter(f => f.category !== 'Health');

  // Ordenar otros por score (mayor primero - Bug 1)
  otherFacts.sort((a, b) => calculateScore(b) - calculateScore(a));

  // Issue #6: Use centralized token estimation

  // Siempre incluir Health
  const healthLines = healthFacts.map(f => `- ${f.text}`);
  let currentTokens = estimateTokens(healthLines.join('\n'));

  // Agregar otros hasta el límite
  const includedOther: string[] = [];
  let truncatedCount = 0;

  for (const fact of otherFacts) {
    const line = `- ${fact.text}`;
    const lineTokens = estimateTokens(line);

    if (currentTokens + lineTokens > maxTokens) {
      truncatedCount++;
      continue;
    }

    includedOther.push(line);
    currentTokens += lineTokens;
  }

  // Construir output
  let output = '# Lo que sé sobre vos\n\n';

  if (healthFacts.length > 0) {
    output += '## Salud (importante)\n';
    output += healthLines.join('\n') + '\n\n';
  }

  if (includedOther.length > 0) {
    output += '## Otros datos\n';
    output += includedOther.join('\n') + '\n';
  }

  // Nota de truncación (Bug 7)
  if (truncatedCount > 0) {
    output += `\n(Hay ${truncatedCount} facts adicionales en archivo)`;
    log.info(`Truncated ${truncatedCount} facts from prompt`);
  }

  return output;
}

/**
 * Calcula el word overlap ratio entre dos textos.
 * Retorna un valor entre 0 y 1.
 */
export function calculateWordOverlap(text1: string, text2: string): number {
  const words1 = extractSignificantWords(text1);
  const words2 = extractSignificantWords(text2);

  if (words1.size === 0 || words2.size === 0) {
    return 0;
  }

  // Calcular intersección
  const intersection = new Set([...words1].filter(w => words2.has(w)));

  // Calcular unión
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * Cuenta palabras significativas diferentes entre dos textos.
 */
export function countDifferentWords(text1: string, text2: string): number {
  const words1 = extractSignificantWords(text1);
  const words2 = extractSignificantWords(text2);

  // Palabras en text1 que no están en text2
  const diff1 = [...words1].filter(w => !words2.has(w));
  // Palabras en text2 que no están en text1
  const diff2 = [...words2].filter(w => !words1.has(w));

  return diff1.length + diff2.length;
}

/**
 * Determina si dos facts deberían fusionarse.
 * Implementa Bug 11: threshold 70% (80% para Health) + regla de palabras diferentes.
 */
export function shouldMergeFacts(
  existingText: string,
  newText: string,
  isHealthCategory: boolean
): { shouldMerge: boolean; reason: string } {
  const overlap = calculateWordOverlap(existingText, newText);
  const differentWords = countDifferentWords(existingText, newText);
  const threshold = isHealthCategory ? DEDUP_THRESHOLD_HEALTH : DEDUP_THRESHOLD_DEFAULT;

  // Regla de palabras diferentes (Bug 11)
  if (differentWords >= MIN_DIFFERENT_WORDS) {
    log.debug(`No merge: ${differentWords} palabras diferentes`, {
      existing: existingText.slice(0, 50),
      new: newText.slice(0, 50),
    });
    return {
      shouldMerge: false,
      reason: `${differentWords} palabras significativas diferentes`,
    };
  }

  // Threshold de overlap
  if (overlap < threshold) {
    return {
      shouldMerge: false,
      reason: `Overlap ${(overlap * 100).toFixed(0)}% < threshold ${(threshold * 100).toFixed(0)}%`,
    };
  }

  return {
    shouldMerge: true,
    reason: `Overlap ${(overlap * 100).toFixed(0)}% >= threshold`,
  };
}

/**
 * Busca un fact duplicado en TODAS las categorías (Bug 8).
 * Retorna el fact encontrado y su índice, o null si no hay duplicado.
 */
export function findDuplicateFact(
  facts: Fact[],
  newText: string,
  targetCategory: FactCategory
): { fact: Fact; index: number } | null {
  // Buscar en TODAS las categorías (Bug 8)
  for (let i = 0; i < facts.length; i++) {
    const existing = facts[i];
    if (!existing) continue;

    const isHealth = existing.category === 'Health' || targetCategory === 'Health';
    const { shouldMerge, reason } = shouldMergeFacts(existing.text, newText, isHealth);

    if (shouldMerge) {
      log.debug(`Duplicado encontrado: ${reason}`, {
        existing: existing.text.slice(0, 50),
        new: newText.slice(0, 50),
        existingCategory: existing.category,
        targetCategory,
      });
      return { fact: existing, index: i };
    }
  }

  return null;
}

/**
 * Genera el contenido completo de learnings.md desde los facts.
 */
function generateLearningsContent(facts: Fact[], unparsed: string[]): string {
  const lines: string[] = ['# Learnings', ''];

  // Agrupar por categoría
  const byCategory = new Map<string, Fact[]>();
  for (const cat of VALID_CATEGORIES) {
    byCategory.set(cat, []);
  }

  for (const fact of facts) {
    const category = fact.category || 'General';
    const categoryFacts = byCategory.get(category);
    if (categoryFacts) {
      categoryFacts.push(fact);
    } else {
      // Preserve facts with unknown categories by mapping to General
      // This prevents data loss during regeneration
      const generalFacts = byCategory.get('General');
      if (generalFacts) {
        generalFacts.push(fact);
      }
    }
  }

  // Escribir cada categoría
  for (const cat of VALID_CATEGORIES) {
    if (cat === 'Unparsed') continue; // Unparsed va al final

    lines.push(`## ${cat}`);
    const categoryFacts = byCategory.get(cat) || [];

    if (categoryFacts.length === 0) {
      lines.push(`<!-- Facts sobre ${cat.toLowerCase()} -->`);
    } else {
      for (const fact of categoryFacts) {
        lines.push(formatFact(fact));
      }
    }
    lines.push('');
  }

  // Agregar unparsed si hay
  if (unparsed.length > 0) {
    lines.push('## Unparsed');
    lines.push('<!-- Líneas con formato inválido - revisar manualmente -->');
    for (const line of unparsed) {
      lines.push(line);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Escribe learnings.md de forma atómica (temp → rename).
 *
 * Concurrency assumptions:
 * - This function MUST be called within withLock() for single-process safety.
 * - Multi-process safety is NOT guaranteed. If multiple Node processes write
 *   concurrently, data loss may occur despite atomic rename.
 * - For multi-process scenarios, an external lock mechanism (e.g., lockfile,
 *   flock) would be required.
 */
async function writeLearningsAtomic(facts: Fact[], unparsed: string[]): Promise<void> {
  const content = generateLearningsContent(facts, unparsed);
  const tempPath = LEARNINGS_MD_PATH + '.tmp';

  // Bug 1 fix: Ensure directory exists before writing
  if (!existsSync(KNOWLEDGE_DIR)) {
    await mkdir(KNOWLEDGE_DIR, { recursive: true });
    log.info('Created data/knowledge/ directory');
  }

  // Escribir a archivo temporal
  await writeFile(tempPath, content, 'utf-8');

  // Rename atómico
  await rename(tempPath, LEARNINGS_MD_PATH);
}

/**
 * Guarda un nuevo fact o actualiza uno existente.
 * Implementa todas las mitigaciones de bugs documentadas.
 *
 * @param text - El texto del fact a guardar
 * @param category - La categoría sugerida
 * @param turnRememberCount - Contador de remember() en el turno actual (para rate limit)
 */
export async function rememberFact(
  text: string,
  category: string,
  turnRememberCount: number = 0
): Promise<RememberResult> {
  // Rate limit (Bug 9): máximo 3 remember() por turno
  if (turnRememberCount >= 3) {
    log.warn('Rate limit alcanzado: máximo 3 remember() por turno');
    return {
      action: 'rate_limited',
      fact: null,
      message: 'Rate limit: máximo 3 facts por turno',
    };
  }

  // Validar categoría
  const validCategory = VALID_CATEGORIES.includes(category as FactCategory)
    ? (category as FactCategory)
    : 'General';

  if (category !== validCategory) {
    log.warn(`Categoría inválida "${category}", usando General`);
  }

  // Usar mutex para escritura atómica
  return await withLock(LEARNINGS_MD_PATH, async () => {
    // Cargar estado actual
    const { facts, unparsed } = await loadLearnings();

    // Buscar duplicado en TODAS las categorías (Bug 8)
    const duplicate = findDuplicateFact(facts, text, validCategory);

    if (duplicate) {
      const existingFact = duplicate.fact;

      // Bug 10: Si el fact existente está en Health, NO moverlo
      if (existingFact.category === 'Health' && validCategory !== 'Health') {
        log.warn(
          `Intento de mover fact de Health a ${validCategory}, manteniéndolo en Health`,
          { fact: existingFact.text.slice(0, 50) }
        );

        // Solo actualizar weight y confirmed, no mover
        existingFact.weight = Math.min(existingFact.weight + 1, 10);
        existingFact.confirmed = getTodayDate();

        await writeLearningsAtomic(facts, unparsed);

        return {
          action: 'duplicate_kept_in_health',
          fact: existingFact,
          message: `Fact actualizado (weight:${existingFact.weight}), mantenido en Health`,
        };
      }

      // Actualizar fact existente
      existingFact.weight = Math.min(existingFact.weight + 1, 10);
      existingFact.confirmed = getTodayDate();

      // Mover a nueva categoría si cambió (y no es de Health)
      if (existingFact.category !== validCategory) {
        log.info(`Moviendo fact de ${existingFact.category} a ${validCategory}`);
        existingFact.category = validCategory;
      }

      await writeLearningsAtomic(facts, unparsed);

      return {
        action: 'updated',
        fact: existingFact,
        message: `Fact actualizado (weight:${existingFact.weight})`,
      };
    }

    // Crear nuevo fact
    const newFact = createFact(text, validCategory);
    facts.push(newFact);

    await writeLearningsAtomic(facts, unparsed);

    log.info(`Nuevo fact creado en ${validCategory}`, { text: text.slice(0, 50) });

    return {
      action: 'created',
      fact: newFact,
      message: `Guardado en ${validCategory}`,
    };
  });
}

/**
 * Asegura que existe la estructura de directorios.
 */
export async function ensureKnowledgeDir(): Promise<void> {
  if (!existsSync(KNOWLEDGE_DIR)) {
    await mkdir(KNOWLEDGE_DIR, { recursive: true });
    log.info('Creado directorio data/knowledge/');
  }
}

/**
 * Obtiene estadísticas del knowledge actual.
 */
export async function getKnowledgeStats(): Promise<{
  totalFacts: number;
  byCategory: Record<string, number>;
  unparsedCount: number;
  oldestFact: string | null;
  newestFact: string | null;
}> {
  const { facts, unparsed } = await loadLearnings();

  const byCategory: Record<string, number> = {};
  for (const cat of VALID_CATEGORIES) {
    byCategory[cat] = 0;
  }

  let oldest: string | null = null;
  let newest: string | null = null;

  for (const fact of facts) {
    const cat = fact.category || 'General';
    byCategory[cat] = (byCategory[cat] || 0) + 1;

    if (!oldest || fact.learned < oldest) oldest = fact.learned;
    if (!newest || fact.learned > newest) newest = fact.learned;
  }

  return {
    totalFacts: facts.length,
    byCategory,
    unparsedCount: unparsed.length,
    oldestFact: oldest,
    newestFact: newest,
  };
}

/**
 * Tool: remember_fact
 *
 * Permite al agente guardar información importante sobre el usuario
 * en la memoria persistente (learnings.md).
 */

import type { Tool, ToolResult } from './types.js';
import { rememberFact, type RememberResult } from '../memory/knowledge.js';
import { VALID_CATEGORIES } from '../memory/fact-parser.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tool:remember');

/**
 * Contexto del turno actual para tracking de rate limit.
 * Se resetea al inicio de cada turno del agentic loop.
 */
export interface TurnContext {
  rememberCount: number;
}

// Contexto global del turno actual (se resetea desde brain.ts)
let currentTurnContext: TurnContext = { rememberCount: 0 };

/**
 * Resetea el contexto del turno.
 * Debe llamarse al inicio de cada turno del agentic loop.
 */
export function resetTurnContext(): void {
  currentTurnContext = { rememberCount: 0 };
}

/**
 * Obtiene el contexto del turno actual.
 */
export function getTurnContext(): TurnContext {
  return currentTurnContext;
}

/**
 * Tool definition para remember_fact.
 */
export const rememberTool: Tool = {
  name: 'remember_fact',
  description: `Guarda información importante sobre el usuario en la memoria persistente.
SIEMPRE usá este tool cuando el usuario comparta:
- Información de salud (alergias, condiciones médicas, medicamentos)
- Preferencias personales (gustos, comidas favoritas)
- Información laboral (dónde trabaja, qué hace)
- Relaciones (familiares, amigos, contactos importantes)
- Rutinas y horarios
- Objetivos y metas

Si no guardás la información, la vas a olvidar en futuras conversaciones.`,

  parameters: {
    type: 'object',
    properties: {
      fact: {
        type: 'string',
        description: 'El hecho a recordar, escrito de forma concisa y clara. Ej: "Es alérgico al maní", "Trabaja como desarrollador en TypeScript", "Su hermana se llama María"',
      },
      category: {
        type: 'string',
        enum: VALID_CATEGORIES.filter(c => c !== 'Unparsed'),
        description: 'Categoría del fact: Health (salud), Preferences (gustos), Work (trabajo), Relationships (relaciones), Schedule (rutinas), Goals (objetivos), General (otros)',
      },
    },
    required: ['fact', 'category'],
  },

  execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
    const fact = args.fact as string;
    const category = args.category as string;

    if (!fact || typeof fact !== 'string' || fact.trim().length === 0) {
      return {
        success: false,
        data: null,
        error: 'El fact no puede estar vacío',
      };
    }

    if (fact.length > 500) {
      return {
        success: false,
        data: null,
        error: 'El fact es demasiado largo (máximo 500 caracteres)',
      };
    }

    log.info(`remember_fact llamado`, {
      fact: fact.slice(0, 50),
      category,
      turnCount: currentTurnContext.rememberCount,
    });

    try {
      const result: RememberResult = await rememberFact(
        fact.trim(),
        category,
        currentTurnContext.rememberCount
      );

      // Incrementar contador del turno (para rate limit - Bug 9)
      currentTurnContext.rememberCount++;

      // Formatear respuesta según acción
      switch (result.action) {
        case 'created':
          return {
            success: true,
            data: {
              action: 'created',
              category: result.fact?.category,
              message: `Guardado: "${fact.slice(0, 50)}${fact.length > 50 ? '...' : ''}" en ${result.fact?.category}`,
            },
            error: undefined,
          };

        case 'updated':
          return {
            success: true,
            data: {
              action: 'updated',
              category: result.fact?.category,
              weight: result.fact?.weight,
              message: `Actualizado: ya tenía este dato guardado (ahora weight:${result.fact?.weight})`,
            },
            error: undefined,
          };

        case 'duplicate_kept_in_health':
          return {
            success: true,
            data: {
              action: 'kept_in_health',
              category: 'Health',
              weight: result.fact?.weight,
              message: `Actualizado en Health (información de salud no se mueve a otras categorías)`,
            },
            error: undefined,
          };

        case 'rate_limited':
          return {
            success: false,
            data: null,
            error: 'Límite alcanzado: máximo 3 facts por turno de conversación',
          };

        default:
          return {
            success: false,
            data: null,
            error: 'Acción desconocida',
          };
      }
    } catch (error) {
      log.error('Error en remember_fact', { error, fact: fact.slice(0, 50) });
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Error desconocido',
      };
    }
  },
};

export default rememberTool;

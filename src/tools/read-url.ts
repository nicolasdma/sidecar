/**
 * Tool: read_url
 *
 * Lee el contenido de una URL y lo convierte a texto legible.
 * Usa Jina Reader (r.jina.ai) que es gratuito.
 */

import type { Tool, ToolResult } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tool:read-url');

const JINA_READER_BASE = 'https://r.jina.ai/';
const REQUEST_TIMEOUT = 30000; // 30 segundos

/**
 * Tool definition para read_url.
 */
export const readUrlTool: Tool = {
  name: 'read_url',
  description: `Lee el contenido de una página web y lo convierte a texto legible.
Usá este tool cuando el usuario te pida:
- Leer un artículo o página web
- Resumir el contenido de una URL
- Extraer información de un enlace

El contenido se convierte a Markdown para facilitar la lectura.`,

  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'La URL de la página web a leer. Debe ser una URL válida (empezar con http:// o https://)',
      },
    },
    required: ['url'],
  },

  execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
    const url = args.url as string;

    // Validar URL
    if (!url || typeof url !== 'string') {
      return {
        success: false,
        data: null,
        error: 'URL no proporcionada',
      };
    }

    // Validar formato de URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return {
          success: false,
          data: null,
          error: 'La URL debe empezar con http:// o https://',
        };
      }
    } catch {
      return {
        success: false,
        data: null,
        error: 'URL inválida',
      };
    }

    log.info(`Leyendo URL: ${url}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const response = await fetch(`${JINA_READER_BASE}${url}`, {
        method: 'GET',
        headers: {
          'Accept': 'text/plain',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        log.error(`Error leyendo URL: ${response.status} ${response.statusText}`);
        return {
          success: false,
          data: null,
          error: `Error al leer la página: ${response.status} ${response.statusText}`,
        };
      }

      const content = await response.text();

      // Limitar el contenido para no exceder el context
      const maxLength = 15000; // ~3750 tokens
      const truncatedContent = content.length > maxLength
        ? content.slice(0, maxLength) + '\n\n[Contenido truncado por longitud]'
        : content;

      log.info(`URL leída exitosamente: ${content.length} chars`);

      return {
        success: true,
        data: {
          url,
          content: truncatedContent,
          truncated: content.length > maxLength,
          originalLength: content.length,
        },
        error: undefined,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        log.error('Timeout leyendo URL', { url });
        return {
          success: false,
          data: null,
          error: 'Timeout: la página tardó demasiado en responder',
        };
      }

      log.error('Error leyendo URL', { error, url });
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Error desconocido',
      };
    }
  },
};

export default readUrlTool;

import type { Tool, ToolResult } from './types.js';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('search');

const JINA_SEARCH_URL = 'https://s.jina.ai/';

interface JinaSearchResult {
  title: string;
  url: string;
  content: string;
}

export const searchTool: Tool = {
  name: 'web_search',
  description: 'Search the web for information. Use this when you need to find current information, news, or facts that you might not know.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
    },
    required: ['query'],
  },
  execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
    const query = args['query'];

    if (typeof query !== 'string' || !query.trim()) {
      return {
        success: false,
        error: 'Query parameter is required and must be a non-empty string',
      };
    }

    logger.info(`Searching web for: ${query}`);

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    if (config.jina.apiKey) {
      headers['Authorization'] = `Bearer ${config.jina.apiKey}`;
    }

    try {
      const encodedQuery = encodeURIComponent(query.trim());
      const url = `${JINA_SEARCH_URL}${encodedQuery}`;

      const response = await fetch(url, { headers });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Jina search failed', { status: response.status, error: errorText });
        return {
          success: false,
          error: `Search failed: HTTP ${response.status}`,
        };
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('application/json')) {
        const data = await response.json() as { data?: JinaSearchResult[] };
        const results = data.data ?? [];

        const formatted = results.slice(0, 5).map((r: JinaSearchResult) => ({
          title: r.title,
          url: r.url,
          snippet: r.content.slice(0, 300),
        }));

        return {
          success: true,
          data: {
            query,
            results: formatted,
            resultCount: formatted.length,
          },
        };
      } else {
        const text = await response.text();
        return {
          success: true,
          data: {
            query,
            content: text.slice(0, 2000),
          },
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Search error', errorMessage);
      return {
        success: false,
        error: `Search failed: ${errorMessage}`,
      };
    }
  },
};

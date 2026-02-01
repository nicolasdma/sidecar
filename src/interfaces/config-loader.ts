/**
 * Configuration Loader
 *
 * Loads proactive configuration from user.md and environment.
 */

import { readFileSync, existsSync } from 'fs';
import {
  type ProactiveConfig,
  DEFAULT_PROACTIVE_CONFIG,
  parseProactivityLevel,
  parseQuietHours,
  isValidTimezone,
} from '../agent/proactive/types.js';
import { config as appConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('config-loader');

/**
 * Load proactive configuration from user.md.
 */
export function loadProactiveConfig(): ProactiveConfig {
  const userMdPath = appConfig.paths.userMd;
  let config = { ...DEFAULT_PROACTIVE_CONFIG };

  if (!existsSync(userMdPath)) {
    logger.warn('user.md not found, using default proactive config');
    return config;
  }

  try {
    const content = readFileSync(userMdPath, 'utf-8');

    // Parse proactivity level (handles both "proactivity level:" and "**Proactivity level**:")
    const levelMatch = content.match(/\*?\*?proactivity\s+level\*?\*?:\s*(\w+)/i);
    if (levelMatch?.[1]) {
      config.proactivityLevel = parseProactivityLevel(levelMatch[1]);
    }

    // Parse quiet hours (handles both "quiet hours:" and "**Quiet hours**:")
    const quietMatch = content.match(/\*?\*?quiet\s+hours\*?\*?:\s*(\S+\s*-\s*\S+)/i);
    if (quietMatch?.[1]) {
      const parsed = parseQuietHours(quietMatch[1]);
      if (parsed) {
        config.quietHoursStart = parsed.start;
        config.quietHoursEnd = parsed.end;
      }
    }

    // Parse timezone (handles both "timezone:" and "**Timezone**:")
    const tzMatch = content.match(/\*?\*?timezone\*?\*?:\s*(\S+)/i);
    if (tzMatch?.[1]) {
      const tz = tzMatch[1].trim();
      if (isValidTimezone(tz)) {
        config.timezone = tz;
      } else {
        logger.error(`Invalid timezone in user.md: ${tz}`);
        throw new Error(`timezone inválido: ${tz}`);
      }
    }

    // Parse language (handles both "language:" and "**Language**:")
    const langMatch = content.match(/\*?\*?language\*?\*?:\s*(\w+)/i);
    if (langMatch?.[1]) {
      config.language = langMatch[1].trim();
    }

    logger.info('Loaded proactive config from user.md', {
      proactivityLevel: config.proactivityLevel,
      timezone: config.timezone,
      quietHours: `${config.quietHoursStart}:00 - ${config.quietHoursEnd}:00`,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('timezone')) {
      // Re-throw timezone errors (they're fatal per spec)
      throw error;
    }
    logger.error('Error loading proactive config', { error });
  }

  return config;
}

/**
 * Create default user.md if it doesn't exist.
 */
export function ensureUserMdExists(): void {
  const userMdPath = appConfig.paths.userMd;

  if (existsSync(userMdPath)) {
    return;
  }

  const defaultContent = `# User Profile

## About Me
<!-- Add information about yourself here -->

## Communication Preferences
- Proactivity level: medium
- Quiet hours: 22:00 - 08:00
- Timezone: America/Argentina/Buenos_Aires
- Language: es

## Channel Preferences
- Primary channel: cli
- CLI notifications: all
`;

  try {
    const { writeFileSync, mkdirSync } = require('fs');
    const { dirname } = require('path');

    mkdirSync(dirname(userMdPath), { recursive: true });
    writeFileSync(userMdPath, defaultContent, 'utf-8');
    logger.info('Created default user.md');
  } catch (error) {
    logger.error('Failed to create default user.md', { error });
  }
}

export default loadProactiveConfig;

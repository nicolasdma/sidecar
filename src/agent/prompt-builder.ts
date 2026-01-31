import { readFileSync, existsSync } from 'fs';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('prompt');

let soulContent: string | null = null;

function loadSoul(): string {
  if (soulContent !== null) {
    return soulContent;
  }

  const soulPath = config.paths.soul;

  if (!existsSync(soulPath)) {
    logger.warn(`SOUL.md not found at ${soulPath}, using default personality`);
    soulContent = getDefaultSoul();
    return soulContent;
  }

  try {
    soulContent = readFileSync(soulPath, 'utf-8');
    logger.info('Loaded SOUL.md');
    return soulContent;
  } catch (error) {
    logger.error('Failed to read SOUL.md', error);
    soulContent = getDefaultSoul();
    return soulContent;
  }
}

function getDefaultSoul(): string {
  return `
# Companion Soul

Sos un compañero AI amigable y útil. Tu propósito es ayudar al usuario con lo que necesite.

## Personalidad
- Amigable pero directo
- Respondés en español argentino casual (vos, che)
- Sos honesto sobre tus limitaciones

## Capacidades
- Podés buscar información en internet
- Podés decir la hora y fecha actual
- Recordás la conversación
`.trim();
}

function getCurrentTimeContext(): string {
  const now = new Date();

  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  const dayName = days[now.getDay()];
  const monthName = months[now.getMonth()];
  const day = now.getDate();
  const year = now.getFullYear();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');

  return `Fecha y hora actual: ${dayName} ${day} de ${monthName} de ${year}, ${hours}:${minutes}`;
}

export function buildSystemPrompt(): string {
  const soul = loadSoul();
  const timeContext = getCurrentTimeContext();

  const systemPrompt = `${soul}

---

## Contexto actual
${timeContext}

## Instrucciones adicionales
- Usá las herramientas disponibles cuando sea apropiado
- Si necesitás información actual (hora, búsqueda web), usá la herramienta correspondiente
- Respondé de forma natural y conversacional
`;

  return systemPrompt;
}

export function reloadSoul(): void {
  soulContent = null;
  logger.info('Soul cache cleared, will reload on next prompt build');
}

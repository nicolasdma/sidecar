import type { Tool, ToolResult } from './types.js';

const DAYS_ES = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
];

const MONTHS_ES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

export const timeTool: Tool = {
  name: 'get_current_time',
  description: 'Get the current date and time. Use this when you need to know what day or time it is.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async (): Promise<ToolResult> => {
    const now = new Date();

    const dayName = DAYS_ES[now.getDay()];
    const monthName = MONTHS_ES[now.getMonth()];
    const day = now.getDate();
    const year = now.getFullYear();

    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');

    const timeString = `${hours}:${minutes}`;
    const dateString = `${dayName} ${day} de ${monthName} de ${year}`;

    return {
      success: true,
      data: {
        time: timeString,
        date: dateString,
        day: dayName,
        timestamp: now.toISOString(),
      },
    };
  },
};

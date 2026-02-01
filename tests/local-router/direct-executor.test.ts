/**
 * Direct Executor Tests - Fase 3.5 Bugfixes
 *
 * Tests for the direct tool execution module.
 * Mocks the tool registry to avoid requiring actual tool execution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Use vi.hoisted to create mock functions before module loading
const mocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
  createExecutionContext: vi.fn(),
  parseDateTime: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('../../src/tools/index.js', () => ({
  executeTool: mocks.executeTool,
  createExecutionContext: mocks.createExecutionContext,
}));

vi.mock('../../src/agent/proactive/date-parser.js', () => ({
  parseDateTime: mocks.parseDateTime,
}));

vi.mock('fs', () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}));

import { executeIntent } from '../../src/agent/local-router/direct-executor.js';

describe('Direct Executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up mock implementations in beforeEach to ensure they persist
    mocks.createExecutionContext.mockReturnValue({
      turnId: 'test-turn-123',
      toolCallCount: new Map(),
    });

    mocks.existsSync.mockReturnValue(false);
    mocks.readFileSync.mockReturnValue('');

    mocks.parseDateTime.mockImplementation((input: string) => {
      if (input.includes('minuto') || input.includes('hora') || input.includes('mañana')) {
        return {
          success: true,
          datetime: new Date(Date.now() + 60000),
          relative: true,
        };
      }
      return {
        success: false,
        error: 'No pude entender la fecha/hora',
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('time intent', () => {
    it('calls get_current_time tool', async () => {
      mocks.executeTool.mockResolvedValue({
        success: true,
        data: {
          time: '14:30',
          date: 'Sábado 1 de Febrero',
          day: 'Sábado',
        },
      });

      const result = await executeIntent('time', {});

      expect(mocks.executeTool).toHaveBeenCalledWith(
        'get_current_time',
        {},
        expect.objectContaining({ turnId: 'test-turn-123' })
      );
      expect(result.success).toBe(true);
      expect(result.response).toMatch(/14:30/);
    });

    it('handles tool failure gracefully', async () => {
      mocks.executeTool.mockResolvedValue({
        success: false,
        error: 'Internal error',
      });

      const result = await executeIntent('time', {});

      expect(result.success).toBe(false);
      expect(result.response).toContain('pude obtener');
    });
  });

  describe('weather intent', () => {
    it('calls get_weather tool with location', async () => {
      mocks.executeTool.mockResolvedValue({
        success: true,
        data: {
          location: 'Buenos Aires',
          temperature: '25°C',
          feelsLike: '27°C',
          humidity: '60%',
          wind: '10 km/h',
          condition: 'Parcialmente nublado',
          summary: 'Buenos Aires: 25°C, parcialmente nublado',
        },
      });

      const result = await executeIntent('weather', { location: 'Buenos Aires' });

      expect(mocks.executeTool).toHaveBeenCalledWith(
        'get_weather',
        { location: 'Buenos Aires' },
        expect.objectContaining({ turnId: 'test-turn-123' })
      );
      expect(result.success).toBe(true);
      expect(result.response).toContain('Buenos Aires');
    });

    it('returns error when location is missing', async () => {
      const result = await executeIntent('weather', {});

      expect(mocks.executeTool).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toContain('ubicación');
    });

    it('accepts city param as alias', async () => {
      mocks.executeTool.mockResolvedValue({
        success: true,
        data: {
          location: 'Madrid',
          temperature: '18°C',
          feelsLike: '17°C',
          humidity: '50%',
          wind: '5 km/h',
          condition: 'Soleado',
          summary: 'Madrid: 18°C, soleado',
        },
      });

      const result = await executeIntent('weather', { city: 'Madrid' });

      expect(mocks.executeTool).toHaveBeenCalledWith(
        'get_weather',
        { location: 'Madrid' },
        expect.objectContaining({ turnId: 'test-turn-123' })
      );
    });
  });

  describe('list_reminders intent', () => {
    it('calls list_reminders tool', async () => {
      mocks.executeTool.mockResolvedValue({
        success: true,
        data: {
          count: 2,
          reminders: ['Llamar al banco - Mañana 10:00', 'Comprar pan - Hoy 18:00'],
          message: '2 recordatorios pendientes',
        },
      });

      const result = await executeIntent('list_reminders', {});

      expect(mocks.executeTool).toHaveBeenCalledWith(
        'list_reminders',
        {},
        expect.objectContaining({ turnId: 'test-turn-123' })
      );
      expect(result.success).toBe(true);
      expect(result.response).toContain('2');
    });

    it('handles empty reminders', async () => {
      mocks.executeTool.mockResolvedValue({
        success: true,
        data: {
          count: 0,
          reminders: [],
          message: 'No hay recordatorios',
        },
      });

      const result = await executeIntent('list_reminders', {});

      expect(result.success).toBe(true);
      // Response should indicate no/empty reminders
      expect(
        result.response.toLowerCase().includes('vacía') ||
        result.response.toLowerCase().includes('pendiente') ||
        result.response.toLowerCase().includes('activo')
      ).toBe(true);
    });
  });

  describe('reminder intent', () => {
    it('creates reminder with valid params', async () => {
      mocks.executeTool.mockResolvedValue({
        success: true,
        data: {
          message: 'llamar al banco',
          formattedTime: 'Lunes 3 de Feb a las 10:00',
        },
      });

      const result = await executeIntent('reminder', {
        time: 'mañana a las 10',
        message: 'llamar al banco',
      });

      expect(mocks.executeTool).toHaveBeenCalledWith(
        'set_reminder',
        expect.objectContaining({
          message: 'llamar al banco',
          datetime: 'mañana a las 10',
        }),
        expect.objectContaining({ turnId: 'test-turn-123' })
      );
      expect(result.success).toBe(true);
    });

    it('returns error when time is missing', async () => {
      const result = await executeIntent('reminder', {
        message: 'llamar al banco',
      });

      expect(mocks.executeTool).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toContain('mensaje o la hora');
    });

    it('returns error when message is missing', async () => {
      const result = await executeIntent('reminder', {
        time: 'en 10 minutos',
      });

      expect(mocks.executeTool).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });

    it('accepts datetime param as alias for time', async () => {
      mocks.executeTool.mockResolvedValue({
        success: true,
        data: {
          message: 'test',
          formattedTime: 'Hoy a las 15:00',
        },
      });

      const result = await executeIntent('reminder', {
        datetime: 'en 30 minutos',
        task: 'test', // alias for message
      });

      expect(mocks.executeTool).toHaveBeenCalled();
    });

    it('returns error for unparseable time', async () => {
      const result = await executeIntent('reminder', {
        time: 'cuando quieras',
        message: 'algo',
      });

      expect(mocks.executeTool).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toContain('fecha/hora');
    });
  });

  describe('cancel_reminder intent', () => {
    it('cancels reminder by ID', async () => {
      mocks.executeTool.mockResolvedValue({
        success: true,
        data: {
          message: 'Recordatorio del banco cancelado',
        },
      });

      const result = await executeIntent('cancel_reminder', {
        reminder_id: 'abc123',
      });

      expect(mocks.executeTool).toHaveBeenCalledWith(
        'cancel_reminder',
        { reminder_id: 'abc123' },
        expect.objectContaining({ turnId: 'test-turn-123' })
      );
      expect(result.success).toBe(true);
    });

    it('finds and cancels reminder by query', async () => {
      // First call to find_reminder
      mocks.executeTool
        .mockResolvedValueOnce({
          success: true,
          data: {
            count: 1,
            reminders: [{ id: 'found-id-123', message: 'llamar banco' }],
          },
        })
        // Second call to cancel_reminder
        .mockResolvedValueOnce({
          success: true,
          data: { message: 'Cancelado' },
        });

      const result = await executeIntent('cancel_reminder', {
        query: 'banco',
      });

      expect(mocks.executeTool).toHaveBeenCalledTimes(2);
      expect(mocks.executeTool).toHaveBeenNthCalledWith(
        1,
        'find_reminder',
        { query: 'banco' },
        expect.objectContaining({ turnId: 'test-turn-123' })
      );
      expect(mocks.executeTool).toHaveBeenNthCalledWith(
        2,
        'cancel_reminder',
        { reminder_id: 'found-id-123' },
        expect.objectContaining({ turnId: 'test-turn-123' })
      );
      expect(result.success).toBe(true);
    });

    it('returns not found when no matching reminder', async () => {
      mocks.executeTool.mockResolvedValue({
        success: true,
        data: {
          count: 0,
          reminders: [],
        },
      });

      const result = await executeIntent('cancel_reminder', {
        query: 'nonexistent',
      });

      expect(result.success).toBe(false);
      // The response templates may say "No encontré" or "No hay un recordatorio que coincida"
      expect(
        result.response.toLowerCase().includes('encontr') ||
        result.response.toLowerCase().includes('coincid')
      ).toBe(true);
    });

    it('returns ambiguous when multiple reminders found', async () => {
      mocks.executeTool.mockResolvedValue({
        success: true,
        data: {
          count: 3,
          reminders: [
            { id: '1', message: 'banco 1' },
            { id: '2', message: 'banco 2' },
            { id: '3', message: 'banco 3' },
          ],
        },
      });

      const result = await executeIntent('cancel_reminder', {
        query: 'banco',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('3'); // "Encontré 3 recordatorios"
    });

    it('returns error when no query or id provided', async () => {
      const result = await executeIntent('cancel_reminder', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Especificá');
    });
  });

  describe('unhandled intents', () => {
    it('returns error for conversation intent', async () => {
      const result = await executeIntent('conversation', {});

      expect(mocks.executeTool).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toContain('No tool mapped');
    });

    it('returns error for question intent', async () => {
      const result = await executeIntent('question', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('No tool mapped');
    });

    it('returns error for unknown intent', async () => {
      const result = await executeIntent('unknown', {});

      expect(result.success).toBe(false);
    });
  });

  describe('error handling', () => {
    it('catches thrown errors from executeTool', async () => {
      mocks.executeTool.mockRejectedValue(new Error('Database connection failed'));

      const result = await executeIntent('time', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database connection failed');
    });
  });
});

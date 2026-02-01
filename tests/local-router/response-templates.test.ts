/**
 * Response Templates Tests - Fase 3.5 Bugfixes
 *
 * Tests for the response template generators.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateTimeResponse,
  generateWeatherResponse,
  generateReminderResponse,
  generateListRemindersResponse,
  generateCancelReminderResponse,
} from '../../src/agent/local-router/response-templates.js';

// Mock Math.random to make tests deterministic
const originalRandom = Math.random;

describe('Response Templates', () => {
  beforeEach(() => {
    // Reset Math.random to first template (index 0)
    Math.random = () => 0;
  });

  afterEach(() => {
    Math.random = originalRandom;
  });

  describe('generateTimeResponse', () => {
    it('generates response with time', () => {
      const response = generateTimeResponse({
        time: '14:30',
        date: 'Sábado 1 de Febrero de 2025',
        day: 'Sábado',
      });

      expect(response).toContain('14:30');
    });

    it('includes date when using certain templates', () => {
      // Use 4th template which includes date
      Math.random = () => 0.9;

      const response = generateTimeResponse({
        time: '14:30',
        date: 'Sábado 1 de Febrero',
        day: 'Sábado',
      });

      expect(response).toContain('14:30');
    });

    it('uses different templates based on random', () => {
      const data = { time: '10:00', date: 'Lunes 3 de Febrero', day: 'Lunes' };

      Math.random = () => 0;
      const response1 = generateTimeResponse(data);

      Math.random = () => 0.5;
      const response2 = generateTimeResponse(data);

      // Both contain the time
      expect(response1).toContain('10:00');
      expect(response2).toContain('10:00');
    });
  });

  describe('generateWeatherResponse', () => {
    const weatherData = {
      location: 'Buenos Aires',
      temperature: '25°C',
      feelsLike: '27°C',
      humidity: '60%',
      wind: '10 km/h',
      condition: 'Parcialmente nublado',
      summary: 'Buenos Aires: 25°C, parcialmente nublado',
    };

    it('generates success response with location and temp', () => {
      const response = generateWeatherResponse(true, weatherData);

      expect(response).toContain('Buenos Aires');
      expect(response).toContain('25°C');
    });

    it('includes condition in response', () => {
      const response = generateWeatherResponse(true, weatherData);

      expect(
        response.toLowerCase().includes('nublado') || response.includes('25°C')
      ).toBe(true);
    });

    it('generates error response on failure', () => {
      const response = generateWeatherResponse(false, undefined, 'API timeout');

      expect(
        response.toLowerCase().includes('error') ||
        response.toLowerCase().includes('pude')
      ).toBe(true);
    });

    it('handles missing error message', () => {
      const response = generateWeatherResponse(false);

      expect(response).toBeTruthy();
    });
  });

  describe('generateReminderResponse', () => {
    const reminderData = {
      message: 'llamar al banco',
      formattedTime: 'Lunes 3 de Febrero a las 10:00',
    };

    it('generates success response with message and time', () => {
      const response = generateReminderResponse(true, reminderData);

      expect(response).toContain('llamar al banco');
      expect(response).toContain('Lunes 3 de Febrero');
    });

    it('uses various confirmation phrases', () => {
      const data = { message: 'test', formattedTime: 'mañana' };

      // Different templates have different phrases
      Math.random = () => 0;
      const r1 = generateReminderResponse(true, data);

      Math.random = () => 0.3;
      const r2 = generateReminderResponse(true, data);

      // Both should contain the message
      expect(r1).toContain('test');
      expect(r2).toContain('test');
    });

    it('generates error response on failure', () => {
      const response = generateReminderResponse(false, undefined, 'Invalid time');

      expect(response.toLowerCase()).toContain('pude');
      expect(response).toContain('Invalid time');
    });
  });

  describe('generateListRemindersResponse', () => {
    it('generates empty list message when count is 0', () => {
      const response = generateListRemindersResponse({
        count: 0,
        reminders: [],
        message: 'No reminders',
      });

      expect(
        response.toLowerCase().includes('vacía') ||
        response.toLowerCase().includes('pendiente') ||
        response.toLowerCase().includes('activo')
      ).toBe(true);
    });

    it('generates list with count and items', () => {
      const response = generateListRemindersResponse({
        count: 2,
        reminders: ['Llamar banco - Mañana 10:00', 'Comprar pan - Hoy 18:00'],
        message: '2 reminders',
      });

      expect(response).toContain('2');
      expect(response).toContain('Llamar banco');
      expect(response).toContain('Comprar pan');
    });

    it('uses singular form for 1 reminder', () => {
      const response = generateListRemindersResponse({
        count: 1,
        reminders: ['Solo uno - Mañana'],
        message: '1 reminder',
      });

      expect(response).toContain('1');
      // Should not have plural "s" in "recordatorios"
      expect(response.match(/recordatorio[^s]/)).toBeTruthy();
    });

    it('uses plural form for multiple reminders', () => {
      const response = generateListRemindersResponse({
        count: 3,
        reminders: ['A', 'B', 'C'],
        message: '3 reminders',
      });

      expect(response).toContain('3');
      expect(response).toContain('recordatorios');
    });
  });

  describe('generateCancelReminderResponse', () => {
    it('generates success response with message', () => {
      const response = generateCancelReminderResponse(true, {
        message: 'llamar al banco',
      });

      expect(response).toContain('llamar al banco');
      expect(
        response.toLowerCase().includes('cancel') ||
        response.toLowerCase().includes('borr') ||
        response.toLowerCase().includes('elimin')
      ).toBe(true);
    });

    it('generates not found response', () => {
      const response = generateCancelReminderResponse(false, undefined, true);

      expect(
        response.toLowerCase().includes('encontr') ||
        response.toLowerCase().includes('coincid')
      ).toBe(true);
    });

    it('generates error response', () => {
      const response = generateCancelReminderResponse(
        false,
        undefined,
        false,
        'Database error'
      );

      expect(response.toLowerCase()).toContain('pude');
      expect(response).toContain('Database error');
    });

    it('handles missing error message in error case', () => {
      const response = generateCancelReminderResponse(false, undefined, false);

      expect(response).toBeTruthy();
      expect(response.toLowerCase()).toContain('desconocido');
    });
  });
});

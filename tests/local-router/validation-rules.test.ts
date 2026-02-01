/**
 * Validation Rules Tests - Fase 3.5 Bugfixes
 *
 * Tests for post-classification validation rules that override LLM decisions.
 */

import { describe, it, expect } from 'vitest';
import { applyValidationRules, INTENT_KEYWORDS } from '../../src/agent/local-router/validation-rules.js';

describe('Validation Rules', () => {
  describe('negation handling', () => {
    it('routes "no me recuerdes" to LLM', () => {
      const result = applyValidationRules('no me recuerdes nada', 'reminder', {});

      expect(result).not.toBeNull();
      expect(result?.route).toBe('ROUTE_TO_LLM');
      expect(result?.intent).toBe('conversation');
    });

    it('routes "no quiero recordatorios" to LLM', () => {
      const result = applyValidationRules('no quiero recordatorios', 'reminder', {});

      expect(result?.route).toBe('ROUTE_TO_LLM');
      expect(result?.intent).toBe('conversation');
    });

    it('routes "no necesito que me avises" to LLM', () => {
      const result = applyValidationRules('no necesito que me avises', 'reminder', {});

      expect(result?.route).toBe('ROUTE_TO_LLM');
      expect(result?.intent).toBe('conversation');
    });

    it('routes "no te preocupes" to LLM', () => {
      const result = applyValidationRules('no te preocupes por eso', 'task', {});

      expect(result?.route).toBe('ROUTE_TO_LLM');
      expect(result?.intent).toBe('conversation');
    });

    it('allows "no me dejes olvidar" as valid reminder', () => {
      const result = applyValidationRules(
        'no me dejes olvidar llamar al doctor',
        'reminder',
        { time: 'mañana', message: 'llamar al doctor' }
      );

      expect(result).toBeNull(); // No override needed
    });
  });

  describe('mass actions', () => {
    it('routes "elimina todos los recordatorios" to LLM for confirmation', () => {
      const result = applyValidationRules(
        'elimina todos los recordatorios',
        'cancel_reminder',
        {}
      );

      expect(result?.route).toBe('ROUTE_TO_LLM');
      // Intent is kept (cancel_reminder) but routed to LLM
    });

    it('routes "borra todas las alarmas" to LLM', () => {
      const result = applyValidationRules('borra todas las alarmas', 'cancel_reminder', {});

      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('routes "cancela todo" to LLM', () => {
      const result = applyValidationRules('cancela todo', 'cancel_reminder', {});

      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('allows single reminder cancellation', () => {
      const result = applyValidationRules(
        'cancela el recordatorio del banco',
        'cancel_reminder',
        { query: 'banco' }
      );

      expect(result).toBeNull(); // No override needed
    });
  });

  describe('incomplete reminders', () => {
    it('rejects reminder without time', () => {
      const result = applyValidationRules('recordame algo importante', 'reminder', {
        message: 'algo importante',
      });

      expect(result?.intent).toBe('ambiguous');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('rejects reminder without message', () => {
      const result = applyValidationRules('recordame en 5 minutos', 'reminder', {
        time: 'en 5 minutos',
      });

      expect(result?.intent).toBe('ambiguous');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('rejects reminder with empty time', () => {
      const result = applyValidationRules('recordame algo', 'reminder', {
        time: '  ',
        message: 'algo',
      });

      expect(result?.intent).toBe('ambiguous');
    });

    it('allows complete reminder', () => {
      const result = applyValidationRules(
        'recordame en 10 minutos de llamar',
        'reminder',
        { time: 'en 10 minutos', message: 'llamar' }
      );

      expect(result).toBeNull(); // No override needed
    });
  });

  describe('fact memory detection', () => {
    it('detects "recordame que soy" as fact_memory', () => {
      const result = applyValidationRules(
        'recordame que soy alérgico al maní',
        'reminder',
        {}
      );

      expect(result?.intent).toBe('fact_memory');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('detects "recordame que tengo" as fact_memory', () => {
      const result = applyValidationRules(
        'recordame que tengo diabetes',
        'reminder',
        {}
      );

      expect(result?.intent).toBe('fact_memory');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('detects "recordame que trabajo en" as fact_memory', () => {
      const result = applyValidationRules(
        'recordame que trabajo en Google',
        'reminder',
        {}
      );

      expect(result?.intent).toBe('fact_memory');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('detects "recordame que me gusta" as fact_memory', () => {
      const result = applyValidationRules(
        'recordame que me gusta el café sin azúcar',
        'reminder',
        {}
      );

      expect(result?.intent).toBe('fact_memory');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('detects "recordame que prefiero" as fact_memory', () => {
      const result = applyValidationRules(
        'recordame que prefiero los mensajes cortos',
        'reminder',
        {}
      );

      expect(result?.intent).toBe('fact_memory');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });
  });

  describe('suggestions', () => {
    it('routes "deberías recordarme" to LLM', () => {
      const result = applyValidationRules(
        'deberías recordarme mis citas',
        'reminder',
        {}
      );

      expect(result?.intent).toBe('conversation');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('routes "podrías avisarme" to LLM', () => {
      const result = applyValidationRules(
        'podrías avisarme cuando llegue?',
        'reminder',
        {}
      );

      expect(result?.intent).toBe('conversation');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('routes "quizás necesite" to LLM', () => {
      const result = applyValidationRules(
        'quizás necesite un recordatorio',
        'reminder',
        {}
      );

      expect(result?.intent).toBe('conversation');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('routes "tal vez deberías" to LLM', () => {
      const result = applyValidationRules('tal vez deberías buscar eso', 'search', {});

      expect(result?.intent).toBe('conversation');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });
  });

  describe('single word handling', () => {
    it('allows known single words like "hora"', () => {
      const result = applyValidationRules('hora', 'time', {});

      expect(result).toBeNull(); // No override
    });

    it('allows known single words like "clima"', () => {
      const result = applyValidationRules('clima', 'weather', {});

      expect(result).toBeNull();
    });

    it('allows known single words like "recordatorios"', () => {
      const result = applyValidationRules('recordatorios', 'list_reminders', {});

      expect(result).toBeNull();
    });

    it('rejects unknown single words', () => {
      const result = applyValidationRules('pastas', 'question', {});

      expect(result?.intent).toBe('ambiguous');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });

    it('rejects "ok" as single word', () => {
      const result = applyValidationRules('ok', 'conversation', {});

      expect(result?.intent).toBe('ambiguous');
      expect(result?.route).toBe('ROUTE_TO_LLM');
    });
  });

  describe('no override cases', () => {
    it('does not override valid time query', () => {
      const result = applyValidationRules('qué hora es', 'time', {});

      expect(result).toBeNull();
    });

    it('does not override valid weather query', () => {
      const result = applyValidationRules('clima en Madrid', 'weather', { location: 'Madrid' });

      expect(result).toBeNull();
    });

    it('does not override valid list_reminders', () => {
      const result = applyValidationRules('qué recordatorios tengo', 'list_reminders', {});

      expect(result).toBeNull();
    });

    it('does not override conversation intent', () => {
      const result = applyValidationRules('hola, cómo estás?', 'conversation', {});

      expect(result).toBeNull();
    });
  });
});

describe('INTENT_KEYWORDS', () => {
  it('has keywords for time intent', () => {
    expect(INTENT_KEYWORDS['hora']).toContain('time');
  });

  it('has keywords for weather intent', () => {
    expect(INTENT_KEYWORDS['clima']).toContain('weather');
    expect(INTENT_KEYWORDS['temperatura']).toContain('weather');
    expect(INTENT_KEYWORDS['lluvia']).toContain('weather');
    expect(INTENT_KEYWORDS['paraguas']).toContain('weather');
  });

  it('has keywords for list_reminders intent', () => {
    expect(INTENT_KEYWORDS['recordatorios']).toContain('list_reminders');
    expect(INTENT_KEYWORDS['reminders']).toContain('list_reminders');
  });

  it('has keywords for reminder/fact_memory intents', () => {
    expect(INTENT_KEYWORDS['recordame']).toContain('reminder');
    expect(INTENT_KEYWORDS['recordame']).toContain('fact_memory');
  });

  it('has keywords for cancel_reminder intent', () => {
    expect(INTENT_KEYWORDS['cancela']).toContain('cancel_reminder');
    expect(INTENT_KEYWORDS['borra']).toContain('cancel_reminder');
  });
});

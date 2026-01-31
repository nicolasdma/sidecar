/**
 * Tool: get_weather
 *
 * Obtiene el clima actual para una ubicación.
 * Usa Open-Meteo API (gratuito, sin API key).
 */

import type { Tool, ToolResult } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tool:weather');

const GEOCODING_API = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT = 15000; // 15 segundos

/**
 * Mapeo de códigos WMO a descripciones en español.
 */
const WMO_CODES: Record<number, string> = {
  0: 'Despejado',
  1: 'Mayormente despejado',
  2: 'Parcialmente nublado',
  3: 'Nublado',
  45: 'Niebla',
  48: 'Niebla con escarcha',
  51: 'Llovizna leve',
  53: 'Llovizna moderada',
  55: 'Llovizna intensa',
  56: 'Llovizna helada leve',
  57: 'Llovizna helada intensa',
  61: 'Lluvia leve',
  63: 'Lluvia moderada',
  65: 'Lluvia intensa',
  66: 'Lluvia helada leve',
  67: 'Lluvia helada intensa',
  71: 'Nevada leve',
  73: 'Nevada moderada',
  75: 'Nevada intensa',
  77: 'Granizo',
  80: 'Chubascos leves',
  81: 'Chubascos moderados',
  82: 'Chubascos intensos',
  85: 'Nevada leve con chubascos',
  86: 'Nevada intensa con chubascos',
  95: 'Tormenta',
  96: 'Tormenta con granizo leve',
  99: 'Tormenta con granizo intenso',
};

interface GeocodingResult {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    admin1?: string;
  }>;
}

interface WeatherResult {
  current?: {
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    weather_code: number;
    wind_speed_10m: number;
  };
}

/**
 * Tool definition para get_weather.
 */
export const weatherTool: Tool = {
  name: 'get_weather',
  description: `Obtiene el clima actual para una ciudad o ubicación.
Usá este tool cuando el usuario pregunte:
- ¿Cómo está el clima en [ciudad]?
- ¿Qué temperatura hace en [lugar]?
- ¿Va a llover hoy?

Devuelve temperatura, sensación térmica, humedad, viento y condición climática.`,

  parameters: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: 'La ciudad o ubicación. Ej: "Buenos Aires", "Madrid", "New York"',
      },
    },
    required: ['location'],
  },

  execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
    const location = args.location as string;

    if (!location || typeof location !== 'string' || location.trim().length === 0) {
      return {
        success: false,
        data: null,
        error: 'Ubicación no proporcionada',
      };
    }

    log.info(`Obteniendo clima para: ${location}`);

    try {
      // Paso 1: Geocoding - obtener coordenadas
      const geoController = new AbortController();
      const geoTimeoutId = setTimeout(() => geoController.abort(), REQUEST_TIMEOUT);

      const geoUrl = `${GEOCODING_API}?name=${encodeURIComponent(location)}&count=1&language=es`;
      const geoResponse = await fetch(geoUrl, { signal: geoController.signal });

      clearTimeout(geoTimeoutId);

      if (!geoResponse.ok) {
        return {
          success: false,
          data: null,
          error: `Error en geocoding: ${geoResponse.status}`,
        };
      }

      const geoData = await geoResponse.json() as GeocodingResult;

      if (!geoData.results || geoData.results.length === 0) {
        return {
          success: false,
          data: null,
          error: `No se encontró la ubicación: ${location}`,
        };
      }

      const place = geoData.results[0];
      if (!place) {
        return {
          success: false,
          data: null,
          error: `No se encontró la ubicación: ${location}`,
        };
      }

      const { latitude, longitude, name, country, admin1 } = place;

      // Paso 2: Obtener clima actual
      const weatherController = new AbortController();
      const weatherTimeoutId = setTimeout(() => weatherController.abort(), REQUEST_TIMEOUT);

      const weatherUrl = `${WEATHER_API}?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
      const weatherResponse = await fetch(weatherUrl, { signal: weatherController.signal });

      clearTimeout(weatherTimeoutId);

      if (!weatherResponse.ok) {
        return {
          success: false,
          data: null,
          error: `Error obteniendo clima: ${weatherResponse.status}`,
        };
      }

      const weatherData = await weatherResponse.json() as WeatherResult;

      if (!weatherData.current) {
        return {
          success: false,
          data: null,
          error: 'No se pudo obtener el clima actual',
        };
      }

      const current = weatherData.current;
      const condition = WMO_CODES[current.weather_code] || 'Desconocido';

      const fullLocation = admin1
        ? `${name}, ${admin1}, ${country}`
        : `${name}, ${country}`;

      log.info(`Clima obtenido para ${fullLocation}`);

      return {
        success: true,
        data: {
          location: fullLocation,
          temperature: `${Math.round(current.temperature_2m)}°C`,
          feelsLike: `${Math.round(current.apparent_temperature)}°C`,
          humidity: `${current.relative_humidity_2m}%`,
          wind: `${Math.round(current.wind_speed_10m)} km/h`,
          condition,
          summary: `En ${fullLocation}: ${condition}, ${Math.round(current.temperature_2m)}°C (sensación ${Math.round(current.apparent_temperature)}°C), humedad ${current.relative_humidity_2m}%, viento ${Math.round(current.wind_speed_10m)} km/h`,
        },
        error: undefined,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        log.error('Timeout obteniendo clima', { location });
        return {
          success: false,
          data: null,
          error: 'Timeout: el servicio de clima tardó demasiado',
        };
      }

      log.error('Error obteniendo clima', { error, location });
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Error desconocido',
      };
    }
  },
};

export default weatherTool;

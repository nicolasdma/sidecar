# Fase 3.6: Local-First Productivity

> **Estado:** ⏳ Planificado
> **Prerequisitos:** Fase 3.5 completada (LocalRouter)
> **Objetivo:** 80-90% de requests resueltos localmente, integraciones externas modulares
> **Última revisión:** 2026-02-01
> **Duración estimada:** 20 días (4 sub-fases × 5 días)

---

## Visión

Transformar Sidecar de un agente que depende de APIs pagas a un **asistente local-first** que:

1. **Maximiza uso de LLMs locales** según capacidades del dispositivo
2. **Reduce costos de API** en 80-90% para uso típico
3. **Ofrece tools de productividad** que corren 100% local
4. **Permite integraciones externas** (Gmail, Twitter, etc.) como plugins opcionales

---

## Arquitectura General

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SIDECAR 3.6                                        │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  DEVICE LAYER (3.6a)                                                   │ │
│  │                                                                        │ │
│  │  Device Detection → Tier Assignment → Model Manager                   │ │
│  │  (minimal | basic | standard | power | server)                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                       │
│                                      ▼                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  SMART ROUTER v2 (3.6a)                                                │ │
│  │                                                                        │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │ │
│  │  │    TIER 1    │  │    TIER 2    │  │    TIER 3    │                 │ │
│  │  │ Deterministic│  │  Local LLM   │  │     API      │                 │ │
│  │  │    (0ms)     │  │   (~2-5s)    │  │   (~1-3s)    │                 │ │
│  │  │              │  │              │  │              │                 │ │
│  │  │ time,weather │  │  translate   │  │   complex    │                 │ │
│  │  │  reminders   │  │   grammar    │  │  web search  │                 │ │
│  │  │              │  │  summarize   │  │  tool chains │                 │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘                 │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                       │
│                                      ▼                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  TOOLS LAYER                                                           │ │
│  │                                                                        │ │
│  │  ┌─────────────────────┐  ┌─────────────────────────────────────────┐ │ │
│  │  │  CORE TOOLS         │  │  PRODUCTIVITY TOOLS (3.6b)              │ │ │
│  │  │  (always loaded)    │  │  (local LLM)                            │ │ │
│  │  │                     │  │                                         │ │ │
│  │  │  • get_time         │  │  • translate                            │ │ │
│  │  │  • get_weather      │  │  • grammar_check                        │ │ │
│  │  │  • web_search       │  │  • summarize                            │ │ │
│  │  │  • read_url         │  │  • explain                              │ │ │
│  │  │  • remember         │  │                                         │ │ │
│  │  │  • reminders        │  │  Future: learning_session               │ │ │
│  │  └─────────────────────┘  └─────────────────────────────────────────┘ │ │
│  │                                                                        │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │ │
│  │  │  INTEGRATION TOOLS (3.6c/d) - Dynamic Loading                   │  │ │
│  │  │                                                                 │  │ │
│  │  │  Gmail (if enabled):     Twitter (if enabled):                  │  │ │
│  │  │  • email_list            • tweet_post                           │  │ │
│  │  │  • email_read            • timeline_read                        │  │ │
│  │  │  • email_search          • tweet_search                         │  │ │
│  │  │  • email_summarize                                              │  │ │
│  │  │  • email_send            LinkedIn, Upwork, Calendar...          │  │ │
│  │  └─────────────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Sub-Fases

| Fase | Nombre | Duración | Descripción |
|------|--------|----------|-------------|
| **3.6a** | Device Profiles + Smart Router | 5 días | Detección de hardware, tiers, routing a LLMs locales |
| **3.6b** | Productivity Tools | 5 días | translate, grammar_check, summarize, explain |
| **3.6c** | Integration Framework | 5 días | Plugin architecture, OAuth, dynamic tool loading |
| **3.6d** | Gmail Integration | 5 días | Primera integración completa |

---

## Fase 3.6a: Device Profiles + Smart Router

**Archivo:** `plan/fase-3.6a-device-profiles.md`

### Objetivo
Detectar capacidades del dispositivo y rutear requests a LLMs locales cuando sea posible.

### Entregables
- Device detection (RAM, CPU, GPU)
- 5 tiers (minimal → server)
- Model Manager con hot-swap
- Smart Router v2 con 3 niveles
- Métricas de uso local vs API

### Tu Mac (M1 Pro 16GB)
- **Tier:** Standard
- **Modelos:** qwen2.5:7b, mistral:7b, gemma2:9b (uno a la vez)
- **Embeddings:** Locales
- **Clasificador:** qwen2.5:3b (siempre cargado)

---

## Fase 3.6b: Productivity Tools

**Archivo:** `plan/fase-3.6b-productivity-tools.md`

### Objetivo
Tools de productividad que corren 100% local con LLMs.

### Tools
| Tool | Descripción | Modelo Preferido |
|------|-------------|------------------|
| `translate` | Traducción multi-idioma | gemma2:9b |
| `grammar_check` | Corrección ortográfica/gramatical | qwen2.5:7b |
| `summarize` | Resumen de textos | qwen2.5:7b |
| `explain` | Explicación de conceptos | gemma2:9b |

### Preview
- Arquitectura para `/learn` mode (implementación futura)
- Schema SQL para tracking de progreso

---

## Fase 3.6c: Integration Framework

**Archivo:** `plan/fase-3.6c-integration-framework.md`

### Objetivo
Arquitectura de plugins para integraciones externas.

### Componentes
- **Integration Registry:** Descubrimiento y gestión de plugins
- **OAuth Manager:** Flujo genérico OAuth 2.0
- **Dynamic Tool Loading:** Carga tools según config
- **User Configuration:** `/integrations` command

### Integraciones Planificadas
| Tier | Integraciones |
|------|---------------|
| 1 | Gmail, Calendar |
| 2 | Twitter, LinkedIn, Upwork |
| 3 | Spotify, Notion, Slack |

---

## Fase 3.6d: Gmail Integration

**Archivo:** `plan/fase-3.6d-gmail-integration.md`

### Objetivo
Primera integración completa usando el framework.

### Tools
| Tool | Descripción |
|------|-------------|
| `email_list` | Listar emails recientes |
| `email_read` | Leer email completo |
| `email_search` | Buscar con sintaxis Gmail |
| `email_summarize` | Resumir con LLM local |
| `email_send` | Enviar email |

### OAuth
- Google Cloud project setup
- Scopes: gmail.readonly, gmail.send
- Token refresh automático

---

## Dependencias Entre Fases

```
Fase 3.5 (LocalRouter) ✅
       │
       ▼
Fase 3.6a (Device Profiles)
       │
       ▼
Fase 3.6b (Productivity Tools)
       │
       ▼
Fase 3.6c (Integration Framework)
       │
       ▼
Fase 3.6d (Gmail Integration)
       │
       ▼
Fase 4 (WhatsApp) - Opcional, puede ir en paralelo después de 3.6a
```

---

## Métricas de Éxito

### Costo
- **Objetivo:** 80-90% de requests resueltos sin API paga
- **Métrica:** `requests_local / requests_total`
- **Visible en:** `/router-stats`

### Latencia
- **Deterministic:** <100ms
- **Local LLM:** <5s
- **API:** <3s
- **Métrica:** Promedio por tier

### Funcionalidad
- **Productivity tools:** 100% funcionales offline
- **Integrations:** OAuth flow completo
- **Gmail:** 5 tools operativas

---

## Requisitos de Hardware

### Mínimos (Tier Basic)
- RAM: 4-8GB
- Modelos: Solo qwen2.5:3b
- Sin embeddings locales

### Recomendados (Tier Standard)
- RAM: 8-16GB
- Modelos: Hasta 7B
- Embeddings locales
- **Tu Mac M1 Pro está aquí**

### Óptimos (Tier Power)
- RAM: 16-32GB
- Modelos: Hasta 13B, 2 concurrentes
- Todo local

---

## Instalación de Modelos

```bash
# Ya tienes (Fase 3.5)
ollama pull qwen2.5:3b-instruct

# Nuevos para Fase 3.6
ollama pull qwen2.5:7b-instruct
ollama pull mistral:7b-instruct
ollama pull gemma2:9b
```

**Espacio en disco:** ~15GB total para los 4 modelos

---

## Archivos del Plan

```
plan/
├── fase-3.6-overview.md           # Este archivo
├── fase-3.6a-device-profiles.md   # Device detection + Smart Router
├── fase-3.6b-productivity-tools.md # translate, grammar, summarize, explain
├── fase-3.6c-integration-framework.md # Plugin architecture
└── fase-3.6d-gmail-integration.md # Gmail plugin completo
```

---

## Cronograma

| Semana | Fase | Días |
|--------|------|------|
| 1 | 3.6a: Device Profiles | D1-D5 |
| 2 | 3.6b: Productivity Tools | D6-D10 |
| 3 | 3.6c: Integration Framework | D11-D15 |
| 4 | 3.6d: Gmail Integration | D16-D20 |

**Total:** ~20 días de trabajo

---

## Decisiones Clave

| Decisión | Elegido | Alternativas Consideradas |
|----------|---------|--------------------------|
| Device detection | Auto sin preguntar | Preguntar al usuario |
| Modelo default | qwen2.5:7b | mistral:7b, gemma2:9b |
| OAuth storage | integrations.json encriptado | Keychain, env vars |
| Primera integración | Gmail | Twitter, Calendar |

---

## Riesgos Identificados y Mitigaciones

### Riesgos Críticos (Resolver Antes de Implementar)

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| Ollama no disponible al startup | Alto | Health check proactivo con mensaje claro al usuario |
| Ningún modelo instalado | Alto | Validación explícita con instrucciones de instalación |
| Race condition en refresh de OAuth tokens | Medio | Mutex o patrón single-flight en OAuth manager |
| LLM retorna JSON malformado | Alto | Extracción robusta de JSON con múltiples estrategias |

### Riesgos de Arquitectura

| Riesgo | Descripción | Mitigación |
|--------|-------------|------------|
| Acoplamiento LocalExecutor ↔ Tools | Tools dependen directamente de localExecutor | Considerar interfaz `ToolExecutionContext` |
| OAuth Manager scope creep | Cada proveedor tiene quirks diferentes | Mantener provider-specific handlers |
| Sin versionado de integrations.json | Migraciones difíciles si schema cambia | Agregar campo `version` al config |

### Decisiones de Scope

| Cambio Recomendado | Razón |
|--------------------|-------|
| **Fusionar 3.6c + 3.6d** | 3.6c solo produce infraestructura sin features visibles al usuario |
| **Eliminar Learning Mode preview de 3.6b** | Infraestructura especulativa; schema puede cambiar |
| **Estimación realista: 30-40 días** | 20 días es optimista considerando edge cases y testing |

---

## Observabilidad Requerida

Además de las métricas básicas, implementar:

1. **Categorización de errores:** Por qué falló local (timeout, OOM, output malo)
2. **Tracking de calidad por modelo:** Qué modelo produce mejores resultados por intent
3. **Dashboard de integraciones:** Estado OAuth, última llamada exitosa, tasa de error

---

## Changelog

### 2026-02-01 - Análisis de arquitectura y riesgos
- Agregada sección "Riesgos Identificados y Mitigaciones"
- Documentados riesgos críticos: Ollama health, no-models, OAuth race, JSON parsing
- Agregadas recomendaciones de scope: fusionar 3.6c+3.6d, eliminar Learning preview
- Estimación realista: 30-40 días (vs 20 días original)
- Agregada sección de observabilidad requerida

### 2026-02-01 - Documentos iniciales
- Creado overview de Fase 3.6
- Creado plan de Fase 3.6a (Device Profiles)
- Creado plan de Fase 3.6b (Productivity Tools)
- Creado plan de Fase 3.6c (Integration Framework)
- Creado plan de Fase 3.6d (Gmail Integration)

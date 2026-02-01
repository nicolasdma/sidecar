# Fase 3.6c: Integration Framework

> **Estado:** ⏳ Planificado
> **Prerequisitos:** Fase 3.6b completada (Productivity Tools)
> **Objetivo:** Arquitectura de plugins para integraciones externas (Gmail, Twitter, LinkedIn, etc.)
> **Última revisión:** 2026-02-01
>
> **⚠️ RECOMENDACIÓN:** Considerar fusionar con Fase 3.6d (Gmail Integration).
> Razón: Esta fase produce solo infraestructura sin features visibles al usuario.
> Si el timeline se retrasa, 3.6c sola no entrega valor. Construir el framework
> mientras se implementa Gmail evita sobre-abstracción.

---

## Contexto

Sidecar necesita conectarse con servicios externos para tareas de productividad:
- **Email:** Leer y resumir emails (Gmail)
- **Social:** Postear en Twitter, revisar LinkedIn/Upwork
- **Calendario:** Ver eventos, crear citas
- **Otros:** Spotify, Notion, Slack, etc.

**Problema:** Cada integración requiere:
- OAuth o API keys
- Lógica específica del servicio
- Tools específicas
- Configuración del usuario

**Solución:** Un framework de plugins que:
1. Estandariza cómo se agregan integraciones
2. Maneja OAuth de forma genérica
3. Carga tools dinámicamente según configuración
4. Permite al usuario habilitar/deshabilitar servicios

---

## Objetivo

1. **Integration Registry:** Registro centralizado de integraciones disponibles
2. **OAuth Manager:** Flujo genérico de autenticación
3. **Dynamic Tool Loading:** Solo carga tools de integraciones habilitadas
4. **User Configuration:** UI para habilitar/deshabilitar integraciones
5. **Plugin Architecture:** Estructura estándar para nuevas integraciones

---

## Arquitectura

### Diagrama General

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      INTEGRATION FRAMEWORK                               │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  USER CONFIGURATION                                              │    │
│  │                                                                  │    │
│  │  data/integrations.json                                          │    │
│  │  {                                                               │    │
│  │    "version": 1,  // Para migraciones futuras                   │    │
│  │    "integrations": {                                             │    │
│  │      "gmail": { "enabled": true, "oauth": {...} },              │    │
│  │      "twitter": { "enabled": false },                            │    │
│  │      ...                                                         │    │
│  │    }                                                             │    │
│  │  }                                                               │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  INTEGRATION REGISTRY                                            │    │
│  │                                                                  │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │    │
│  │  │   Gmail     │  │   Twitter   │  │  LinkedIn   │  ...         │    │
│  │  │   Plugin    │  │   Plugin    │  │   Plugin    │              │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘              │    │
│  │                                                                  │    │
│  │  • Descubre plugins disponibles                                  │    │
│  │  • Verifica cuáles están habilitados                            │    │
│  │  • Carga tools dinámicamente                                     │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  OAUTH MANAGER                                                   │    │
│  │                                                                  │    │
│  │  • Flujo genérico OAuth 2.0                                      │    │
│  │  • Almacenamiento seguro de tokens                               │    │
│  │  • Refresh automático                                            │    │
│  │  • Revocación de acceso                                          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  DYNAMIC TOOL REGISTRY                                           │    │
│  │                                                                  │    │
│  │  CORE (siempre):                                                 │    │
│  │  - time, weather, search, remember, reminders                    │    │
│  │  - translate, grammar_check, summarize, explain                  │    │
│  │                                                                  │    │
│  │  GMAIL (si enabled):                                             │    │
│  │  - email_list, email_read, email_search, email_send              │    │
│  │                                                                  │    │
│  │  TWITTER (si enabled):                                           │    │
│  │  - tweet_post, tweet_search, timeline_read                       │    │
│  │                                                                  │    │
│  │  LINKEDIN (si enabled):                                          │    │
│  │  - jobs_search, jobs_apply, messages_read                        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Flujo de Startup

```
1. Load integrations.json
2. For each integration:
   a. Check if enabled
   b. If enabled, verify OAuth is valid
   c. If OAuth expired, try refresh
   d. If refresh fails, mark as "needs_reauth"
   e. Load tools for valid integrations
3. Register all tools with Brain
4. Log: "Integrations loaded: Gmail (active), Twitter (disabled), ..."
```

---

## Plugin Interface

### Estructura de un Plugin

```typescript
// src/integrations/types.ts

interface IntegrationPlugin {
  // Metadata
  id: string;                    // 'gmail', 'twitter', etc.
  name: string;                  // 'Gmail', 'Twitter', etc.
  description: string;           // Descripción corta
  icon: string;                  // Emoji o icono

  // OAuth config
  oauth: OAuthConfig | null;     // null si no requiere OAuth

  // Tools que provee
  tools: ToolDefinition[];

  // Lifecycle hooks
  onEnable(): Promise<void>;     // Cuando el usuario habilita
  onDisable(): Promise<void>;    // Cuando el usuario deshabilita
  onStartup(): Promise<void>;    // Al iniciar Sidecar

  // Status
  getStatus(): Promise<IntegrationStatus>;
}

interface OAuthConfig {
  provider: 'google' | 'twitter' | 'linkedin' | 'custom';
  clientId: string;              // De env vars
  scopes: string[];
  authUrl: string;
  tokenUrl: string;
}

interface IntegrationStatus {
  enabled: boolean;
  authenticated: boolean;
  lastSync?: Date;
  error?: string;
}
```

### Ejemplo: Gmail Plugin

```typescript
// src/integrations/gmail/index.ts

import { IntegrationPlugin, OAuthConfig } from '../types';
import { gmailTools } from './tools';

export const GmailPlugin: IntegrationPlugin = {
  id: 'gmail',
  name: 'Gmail',
  description: 'Read, search, and send emails',
  icon: '📧',

  oauth: {
    provider: 'google',
    clientId: process.env.GOOGLE_CLIENT_ID!,
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
  },

  tools: gmailTools,

  async onEnable() {
    // Verificar que OAuth está configurado
    if (!process.env.GOOGLE_CLIENT_ID) {
      throw new Error('GOOGLE_CLIENT_ID not configured');
    }
  },

  async onDisable() {
    // Opcional: revocar tokens
  },

  async onStartup() {
    // Verificar conexión, refresh token si necesario
  },

  async getStatus() {
    const config = await loadIntegrationConfig('gmail');
    return {
      enabled: config.enabled,
      authenticated: !!config.oauth?.accessToken,
      lastSync: config.lastSync,
    };
  },
};
```

---

## OAuth Manager

### Flujo OAuth 2.0

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OAUTH FLOW                                       │
│                                                                          │
│  1. Usuario: /integrations connect gmail                                │
│                    │                                                     │
│                    ▼                                                     │
│  2. Sistema genera URL de autorización                                  │
│     https://accounts.google.com/o/oauth2/v2/auth?...                   │
│                    │                                                     │
│                    ▼                                                     │
│  3. Sistema abre URL en browser (o muestra para copiar)                │
│                    │                                                     │
│                    ▼                                                     │
│  4. Usuario autoriza en browser                                         │
│                    │                                                     │
│                    ▼                                                     │
│  5. Callback a localhost:PORT/oauth/callback?code=...                  │
│                    │                                                     │
│                    ▼                                                     │
│  6. Sistema intercambia code por tokens                                 │
│                    │                                                     │
│                    ▼                                                     │
│  7. Tokens guardados en integrations.json (encriptados)                │
│                    │                                                     │
│                    ▼                                                     │
│  8. Tools del plugin ahora disponibles                                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Interfaz OAuth Manager

```typescript
// src/integrations/oauth.ts

interface OAuthManager {
  // Iniciar flujo
  startAuthFlow(integrationId: string): Promise<AuthFlowResult>;

  // Manejar callback
  handleCallback(integrationId: string, code: string): Promise<TokenResult>;

  // Token management
  getAccessToken(integrationId: string): Promise<string | null>;
  refreshToken(integrationId: string): Promise<string | null>;
  revokeToken(integrationId: string): Promise<void>;

  // Status
  isAuthenticated(integrationId: string): Promise<boolean>;
  getTokenExpiry(integrationId: string): Promise<Date | null>;
}

interface AuthFlowResult {
  authUrl: string;
  state: string;  // CSRF protection
}

interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}
```

### Almacenamiento Seguro

```typescript
// Los tokens se guardan encriptados en integrations.json

interface IntegrationConfig {
  enabled: boolean;
  oauth?: {
    accessToken: string;     // Encriptado con key derivada de machine ID
    refreshToken?: string;   // Encriptado
    expiresAt: string;       // ISO date
  };
  settings?: Record<string, unknown>;  // Config específica del plugin
  lastSync?: string;
}

// Encriptación simple pero efectiva
// Key derivada de: machineId + salt fijo
// Algoritmo: AES-256-GCM
```

### Token Refresh Mutex (Crítico)

**Problema:** Race condition cuando múltiples requests detectan token expirado simultáneamente.

```
Request A: Token expirado → inicia refresh
Request B: Token expirado → inicia refresh (antes de que A termine)
Request A: Guarda nuevo token
Request B: Guarda otro token (sobreescribe A)
→ Posible corrupción o tokens inconsistentes
```

**Solución:** Patrón single-flight para refresh:

```typescript
// src/integrations/oauth.ts

class OAuthManager {
  private refreshPromises = new Map<string, Promise<string>>();

  async getAccessToken(integrationId: string): Promise<string> {
    const config = await loadIntegrationConfig(integrationId);

    if (!config.oauth) {
      throw new Error(`${integrationId} not authenticated`);
    }

    // Token válido, retornar directamente
    if (new Date(config.oauth.expiresAt) > new Date(Date.now() + 60000)) {
      return decrypt(config.oauth.accessToken);
    }

    // Token expirado o por expirar, necesita refresh
    return this.refreshTokenSingleFlight(integrationId);
  }

  private async refreshTokenSingleFlight(integrationId: string): Promise<string> {
    // Si ya hay un refresh en progreso para esta integración, esperar ese
    const existingPromise = this.refreshPromises.get(integrationId);
    if (existingPromise) {
      return existingPromise;
    }

    // Crear nueva promesa de refresh
    const refreshPromise = this.doRefreshToken(integrationId)
      .finally(() => {
        // Limpiar después de completar (éxito o error)
        this.refreshPromises.delete(integrationId);
      });

    this.refreshPromises.set(integrationId, refreshPromise);
    return refreshPromise;
  }

  private async doRefreshToken(integrationId: string): Promise<string> {
    // Implementación real del refresh
    const config = await loadIntegrationConfig(integrationId);
    // ... hacer request a token endpoint ...
    // ... guardar nuevo token ...
    return newAccessToken;
  }
}
```

**Tests requeridos:**
- [ ] Dos requests simultáneas con token expirado → solo un refresh
- [ ] Refresh falla → ambas requests reciben el error
- [ ] Refresh exitoso → ambas requests reciben el nuevo token

---

## Integration Registry

### Interfaz

```typescript
// src/integrations/registry.ts

interface IntegrationRegistry {
  // Descubrimiento
  getAvailableIntegrations(): IntegrationPlugin[];
  getEnabledIntegrations(): IntegrationPlugin[];

  // Gestión
  enable(integrationId: string): Promise<void>;
  disable(integrationId: string): Promise<void>;

  // Estado
  getStatus(integrationId: string): Promise<IntegrationStatus>;
  getAllStatuses(): Promise<Record<string, IntegrationStatus>>;

  // Tools
  getToolsForIntegration(integrationId: string): ToolDefinition[];
  getAllEnabledTools(): ToolDefinition[];
}
```

### Auto-Discovery de Plugins

```typescript
// Los plugins se registran automáticamente al importar

// src/integrations/index.ts
import { GmailPlugin } from './gmail';
import { TwitterPlugin } from './twitter';
import { LinkedInPlugin } from './linkedin';
import { UpworkPlugin } from './upwork';
import { CalendarPlugin } from './calendar';
import { SpotifyPlugin } from './spotify';

export const AVAILABLE_INTEGRATIONS: IntegrationPlugin[] = [
  GmailPlugin,
  TwitterPlugin,
  LinkedInPlugin,
  UpworkPlugin,
  CalendarPlugin,
  SpotifyPlugin,
];
```

---

## Comando `/integrations`

### UI en CLI

```
> /integrations

┌─────────────────────────────────────────────────────────────┐
│  🔌 Integrations                                             │
│                                                              │
│  Status   Name        Description                            │
│  ──────   ────        ───────────                            │
│  ✅       Gmail       Read and send emails                   │
│  ⚪       Twitter     Post tweets, read timeline             │
│  ⚪       LinkedIn    Search jobs, view messages             │
│  ⚪       Upwork      Search and apply to jobs               │
│  ⚪       Calendar    View and create events                 │
│  ⚪       Spotify     Control playback                       │
│                                                              │
│  Commands:                                                   │
│    /integrations connect <name>    Start OAuth flow          │
│    /integrations disconnect <name> Remove access             │
│    /integrations status <name>     Show detailed status      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Subcomandos

```
/integrations connect gmail
→ Abre browser con URL de OAuth
→ "Autoriza el acceso en tu browser..."
→ "✅ Gmail conectado. Tools disponibles: email_list, email_read, email_search"

/integrations disconnect gmail
→ "¿Estás seguro? Esto eliminará el acceso a Gmail. (y/n)"
→ "✅ Gmail desconectado"

/integrations status gmail
→ "Gmail: Conectado desde 2026-01-15. Último sync: hace 2 horas. Tokens válidos."
```

---

## Integraciones Planificadas

### Tier 1: Productividad Core

| Plugin | Tools | OAuth | Prioridad |
|--------|-------|-------|-----------|
| **Gmail** | email_list, email_read, email_search, email_send | Google OAuth | Alta |
| **Calendar** | events_list, events_create, events_update | Google OAuth | Alta |

### Tier 2: Social/Trabajo

| Plugin | Tools | OAuth | Prioridad |
|--------|-------|-------|-----------|
| **Twitter** | tweet_post, tweet_search, timeline_read, dm_read | Twitter OAuth | Media |
| **LinkedIn** | jobs_search, jobs_apply, messages_read, profile_view | LinkedIn OAuth | Media |
| **Upwork** | jobs_search, proposals_list, proposal_submit | Upwork OAuth | Media |

### Tier 3: Extras

| Plugin | Tools | OAuth | Prioridad |
|--------|-------|-------|-----------|
| **Spotify** | playback_control, now_playing, search_tracks | Spotify OAuth | Baja |
| **Notion** | pages_search, pages_read, pages_create | Notion OAuth | Baja |
| **Slack** | messages_read, messages_send, channels_list | Slack OAuth | Baja |

---

## Gmail Plugin (Detalle)

### Tools

```typescript
// src/integrations/gmail/tools.ts

export const gmailTools: ToolDefinition[] = [
  {
    name: 'email_list',
    description: 'List recent emails from inbox',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max emails to return', default: 10 },
        unread_only: { type: 'boolean', description: 'Only unread emails', default: false },
        from: { type: 'string', description: 'Filter by sender email' },
        subject_contains: { type: 'string', description: 'Filter by subject' },
      },
    },
    execute: listEmails,
  },
  {
    name: 'email_read',
    description: 'Read a specific email by ID',
    parameters: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'Email ID', required: true },
      },
      required: ['email_id'],
    },
    execute: readEmail,
  },
  {
    name: 'email_search',
    description: 'Search emails with Gmail query syntax',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query', required: true },
        limit: { type: 'number', description: 'Max results', default: 10 },
      },
      required: ['query'],
    },
    execute: searchEmails,
  },
  {
    name: 'email_send',
    description: 'Send an email',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email', required: true },
        subject: { type: 'string', description: 'Email subject', required: true },
        body: { type: 'string', description: 'Email body (plain text)', required: true },
      },
      required: ['to', 'subject', 'body'],
    },
    execute: sendEmail,
  },
];
```

### Ejemplo de Uso

```
Usuario: "Revisa mis emails de hoy"
→ Intent: email_list (via Smart Router → API tier)
→ Tool: email_list({ unread_only: false, limit: 10 })
→ Response: "Tienes 5 emails hoy:
   1. De: john@company.com - 'Meeting tomorrow' (hace 2h)
   2. De: amazon@email.com - 'Your order shipped' (hace 4h)
   ..."

Usuario: "Lee el email de John"
→ Intent: email_read
→ Tool: email_read({ email_id: "..." })
→ Response: "Email de John:
   Asunto: Meeting tomorrow

   Hi, can we meet at 3pm tomorrow to discuss the project?
   ..."

Usuario: "Respóndele que sí, a las 3pm está bien"
→ Intent: email_send
→ Tool: email_send({ to: "john@company.com", subject: "Re: Meeting tomorrow", body: "..." })
→ Response: "Email enviado a John."
```

---

## Twitter Plugin (Detalle)

### Tools

```typescript
// src/integrations/twitter/tools.ts

export const twitterTools: ToolDefinition[] = [
  {
    name: 'tweet_post',
    description: 'Post a tweet',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Tweet text (max 280 chars)', required: true },
        reply_to: { type: 'string', description: 'Tweet ID to reply to' },
      },
      required: ['text'],
    },
    execute: postTweet,
  },
  {
    name: 'timeline_read',
    description: 'Read recent tweets from your timeline',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max tweets', default: 10 },
      },
    },
    execute: readTimeline,
  },
  {
    name: 'tweet_search',
    description: 'Search tweets by keyword',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query', required: true },
        limit: { type: 'number', description: 'Max results', default: 10 },
      },
      required: ['query'],
    },
    execute: searchTweets,
  },
];
```

### Ejemplo de Uso

```
Usuario: "Postea en Twitter: Probando mi nuevo asistente AI"
→ Intent: tweet_post
→ Tool: tweet_post({ text: "Probando mi nuevo asistente AI 🤖" })
→ Response: "Tweet publicado: https://twitter.com/user/status/..."

Usuario: "Qué está pasando en Twitter sobre AI?"
→ Intent: tweet_search
→ Tool: tweet_search({ query: "AI", limit: 5 })
→ Response: "Tweets recientes sobre AI:
   1. @user1: 'New GPT model released...' (50 likes)
   2. @user2: 'AI is changing everything...' (120 likes)
   ..."
```

---

## Estructura de Archivos

```
sidecar/
├── src/
│   ├── integrations/
│   │   ├── index.ts              # Export de todos los plugins
│   │   ├── types.ts              # Interfaces
│   │   ├── registry.ts           # Integration Registry
│   │   ├── oauth.ts              # OAuth Manager
│   │   ├── config.ts             # Load/save integrations.json
│   │   │
│   │   ├── gmail/
│   │   │   ├── index.ts          # GmailPlugin
│   │   │   ├── tools.ts          # Tool definitions
│   │   │   ├── client.ts         # Gmail API client
│   │   │   └── types.ts          # Gmail-specific types
│   │   │
│   │   ├── twitter/
│   │   │   ├── index.ts
│   │   │   ├── tools.ts
│   │   │   └── client.ts
│   │   │
│   │   ├── linkedin/
│   │   │   └── ...
│   │   │
│   │   └── upwork/
│   │       └── ...
│   │
│   ├── interfaces/
│   │   └── cli.ts                # Agregar comando /integrations
│   │
│   └── ...
│
├── data/
│   └── integrations.json         # Config + OAuth tokens (gitignored!)
│
└── .env
    ├── GOOGLE_CLIENT_ID=...
    ├── GOOGLE_CLIENT_SECRET=...
    ├── TWITTER_API_KEY=...
    └── ...
```

---

## Orden de Implementación

### Día 1: Core Framework

- [ ] `src/integrations/types.ts`
  - IntegrationPlugin interface
  - OAuthConfig interface
  - IntegrationStatus interface
  - **IntegrationsFile interface con version**

- [ ] `src/integrations/config.ts`
  - Load/save integrations.json
  - Encriptación de tokens
  - **Versionado y migraciones:**
    ```typescript
    interface IntegrationsFile {
      version: number;
      integrations: Record<string, IntegrationConfig>;
    }

    const CURRENT_VERSION = 1;

    async function loadIntegrationsFile(): Promise<IntegrationsFile> {
      const raw = await readFile('data/integrations.json');
      const data = JSON.parse(raw);

      // Migrar si es necesario
      if (!data.version || data.version < CURRENT_VERSION) {
        return migrateIntegrationsFile(data);
      }

      return data;
    }
    ```

- [ ] `src/integrations/registry.ts`
  - getAvailableIntegrations()
  - getEnabledIntegrations()
  - enable/disable

### Día 2: OAuth Manager

- [ ] `src/integrations/oauth.ts`
  - startAuthFlow()
  - handleCallback() con server temporal
  - Token storage encriptado
  - refreshToken()

- [ ] HTTP server temporal para OAuth callback
  - Puerto dinámico
  - Timeout de 5 minutos
  - CSRF protection con state

### Día 3: Dynamic Tool Loading

- [ ] Integrar con tool registry existente
  - Core tools siempre cargadas
  - Plugin tools cargadas si enabled
  - Reload cuando cambia config

- [ ] Integrar con prompt builder
  - Solo incluir tools disponibles
  - Descripción de integraciones en system prompt

### Día 4: CLI Command + Gmail Plugin

- [ ] `/integrations` command
  - Lista de integraciones
  - connect/disconnect subcomandos
  - status subcomando

- [ ] `src/integrations/gmail/`
  - Plugin skeleton
  - OAuth config para Google
  - 4 tools básicas

### Día 5: Testing + Polish

- [ ] Tests unitarios
  - Registry load/save
  - OAuth flow (mock)
  - Tool loading dinámico

- [ ] Tests de integración
  - Gmail con cuenta real (manual)
  - Connect/disconnect flow

- [ ] Documentación
  - README con setup de OAuth
  - PLAN.md actualizado

---

## Criterios de Verificación

### Framework Core

- [ ] integrations.json se crea correctamente al primer run
- [ ] Plugins se descubren automáticamente
- [ ] enable/disable actualiza config
- [ ] Tools se cargan/descargan dinámicamente
- [ ] Log muestra integraciones al startup

### OAuth

- [ ] `/integrations connect gmail` abre browser
- [ ] Callback recibe code correctamente
- [ ] Tokens se guardan encriptados
- [ ] Refresh automático funciona
- [ ] `/integrations disconnect` revoca y limpia

### Gmail Plugin

- [ ] `email_list` retorna emails recientes
- [ ] `email_read` retorna contenido completo
- [ ] `email_search` encuentra emails por query
- [ ] Errores de auth → mensaje claro al usuario

### Seguridad

- [ ] integrations.json está en .gitignore
- [ ] Tokens están encriptados
- [ ] CSRF protection en OAuth flow
- [ ] No se loguean tokens

---

## Configuración de OAuth

### Google (Gmail, Calendar)

1. Ir a Google Cloud Console
2. Crear proyecto
3. Habilitar Gmail API y Calendar API
4. Crear OAuth 2.0 credentials
5. Agregar `http://localhost:PORT/oauth/callback` a redirect URIs
6. Copiar Client ID y Secret a `.env`

```env
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
```

### Twitter

1. Ir a Twitter Developer Portal
2. Crear app
3. Obtener API Key y Secret
4. Agregar callback URL

```env
TWITTER_API_KEY=xxx
TWITTER_API_SECRET=xxx
```

### LinkedIn

1. Ir a LinkedIn Developer Portal
2. Crear app
3. Solicitar permisos necesarios
4. Agregar redirect URI

```env
LINKEDIN_CLIENT_ID=xxx
LINKEDIN_CLIENT_SECRET=xxx
```

---

## Manejo de Errores

| Error | Causa | Respuesta |
|-------|-------|-----------|
| OAuth not configured | Variables de entorno faltantes | "Gmail no está configurado. Agrega GOOGLE_CLIENT_ID a .env" |
| Token expired | Access token venció | (auto-refresh) o "Reconecta Gmail: /integrations connect gmail" |
| Rate limited | Demasiadas requests | "Gmail rate limited. Intenta en X minutos." |
| Scope insufficient | Falta permiso | "Gmail necesita permisos adicionales. Reconecta." |
| Network error | Sin conexión | "No se pudo conectar a Gmail. Verifica tu conexión." |

---

## Futuro (No en Fase 3.6c)

Ideas para fases posteriores:

- **Webhook support:** Recibir notificaciones push (Gmail push, Twitter webhooks)
- **Background sync:** Sincronizar datos periódicamente
- **Multi-account:** Múltiples cuentas del mismo servicio
- **Plugin marketplace:** Instalar plugins de terceros
- **Custom integrations:** Usuario crea sus propias integraciones

---

## Changelog

### 2026-02-01 - Análisis de riesgos integrado
- Agregada recomendación de fusionar con 3.6d en header
- Agregada sección "Token Refresh Mutex" con patrón single-flight
- Agregado versionado a integrations.json schema
- Día 1 actualizado con IntegrationsFile interface y migraciones
- Tests de race condition agregados

### 2026-02-01 - Documento inicial
- Arquitectura de Integration Framework
- Plugin interface
- OAuth Manager design
- Dynamic tool loading
- Gmail y Twitter plugins detallados
- Orden de implementación (5 días)
- Criterios de verificación

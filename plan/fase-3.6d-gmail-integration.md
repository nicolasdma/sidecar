# Fase 3.6d: Gmail Integration

> **Estado:** ⏳ Planificado
> **Prerequisitos:** Fase 3.6c completada (Integration Framework)
> **Objetivo:** Primera integración completa: Gmail
> **Última revisión:** 2026-02-01

---

## Contexto

Gmail es la primera integración real del sistema. Usa el Integration Framework de Fase 3.6c para:
- Conectar vía OAuth
- Cargar tools dinámicamente
- Ejecutar operaciones sobre emails

**Por qué Gmail primero:**
1. API bien documentada
2. OAuth estándar (Google)
3. Caso de uso claro (leer, buscar, resumir emails)
4. Reutilizable para Calendar (mismo OAuth)

---

## Objetivo

Implementar el plugin completo de Gmail con:
- OAuth flow con Google
- 5 tools funcionales
- Integración con LLM para resumir emails
- Tests con cuenta real

---

## Tools

### 1. `email_list`

Lista emails recientes del inbox.

```typescript
interface EmailListParams {
  limit?: number;           // Default: 10, max: 50
  unread_only?: boolean;    // Default: false
  from?: string;            // Filtrar por remitente
  after?: string;           // Fecha YYYY-MM-DD
  before?: string;          // Fecha YYYY-MM-DD
  label?: string;           // INBOX, SENT, SPAM, etc.
}

interface EmailListResult {
  emails: EmailSummary[];
  total: number;
  has_more: boolean;
}

interface EmailSummary {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;          // Preview de 100 chars
  date: string;             // ISO date
  is_unread: boolean;
  labels: string[];
  has_attachments: boolean;
}
```

**Ejemplo:**
```
Usuario: "Muéstrame mis emails de hoy"
→ email_list({ after: "2026-02-01", limit: 10 })
→ "Tienes 5 emails hoy:
   1. 📧 john@company.com - 'Meeting tomorrow' (hace 2h) [unread]
   2. 📧 amazon@email.com - 'Your order shipped' (hace 4h)
   3. 📧 newsletter@tech.com - 'Weekly digest' (hace 6h)
   ..."
```

### 2. `email_read`

Lee el contenido completo de un email.

```typescript
interface EmailReadParams {
  email_id: string;         // Required
  format?: 'full' | 'summary';  // Default: full
}

interface EmailReadResult {
  id: string;
  thread_id: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  body: string;             // Plain text
  html?: string;            // HTML si disponible
  date: string;
  attachments: Attachment[];
  labels: string[];
}

interface EmailAddress {
  name?: string;
  email: string;
}

interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  size: number;             // bytes
}
```

**Ejemplo:**
```
Usuario: "Lee el email de John"
→ email_read({ email_id: "abc123" })
→ "Email de John Smith <john@company.com>
   Fecha: 2026-02-01 10:30
   Asunto: Meeting tomorrow

   Hi,

   Can we meet at 3pm tomorrow to discuss the project?
   I have some updates to share.

   Best,
   John"
```

### 3. `email_search`

Busca emails con sintaxis de Gmail.

```typescript
interface EmailSearchParams {
  query: string;            // Gmail search syntax
  limit?: number;           // Default: 10
}

interface EmailSearchResult {
  emails: EmailSummary[];
  query_used: string;
  total_matches: number;
}
```

**Gmail Query Syntax:**
- `from:john@example.com` - De remitente
- `to:me` - Para mí
- `subject:meeting` - En asunto
- `has:attachment` - Con adjuntos
- `is:unread` - No leídos
- `after:2026/01/01` - Después de fecha
- `before:2026/02/01` - Antes de fecha
- `label:work` - Con etiqueta
- `"exact phrase"` - Frase exacta
- `OR` - Operador OR
- `-term` - Excluir término

**Ejemplo:**
```
Usuario: "Busca emails de Amazon de la última semana"
→ email_search({ query: "from:amazon after:2026/01/25" })
→ "Encontré 3 emails de Amazon:
   1. 'Your order has shipped' - 2026-01-28
   2. 'Order confirmation #12345' - 2026-01-26
   3. 'Deal of the day' - 2026-01-25"
```

### 4. `email_summarize`

Resume un email o thread largo usando LLM local.

```typescript
interface EmailSummarizeParams {
  email_id?: string;        // Un email específico
  thread_id?: string;       // Todo el thread
  style?: 'brief' | 'detailed' | 'action_items';
}

interface EmailSummarizeResult {
  summary: string;
  action_items?: string[];  // Si style es action_items
  key_points?: string[];
  original_length: number;
  summary_length: number;
}
```

**Ejemplo:**
```
Usuario: "Resume el thread con John"
→ email_summarize({ thread_id: "thread123", style: "action_items" })
→ "Resumen del thread con John (5 emails):

   John quiere reunirse mañana a las 3pm para discutir el proyecto.
   Mencionó que tiene actualizaciones importantes sobre el timeline.

   Action items:
   • Confirmar asistencia a reunión de mañana 3pm
   • Revisar timeline del proyecto antes de la reunión"
```

### 5. `email_send`

Envía un email.

```typescript
interface EmailSendParams {
  to: string | string[];    // Destinatario(s)
  subject: string;
  body: string;             // Plain text
  cc?: string[];
  bcc?: string[];
  reply_to?: string;        // Email ID para reply
  draft?: boolean;          // Solo crear draft, no enviar
}

interface EmailSendResult {
  success: boolean;
  message_id?: string;
  thread_id?: string;
  error?: string;
}
```

**Ejemplo:**
```
Usuario: "Respóndele a John que sí, a las 3pm está bien"
→ email_send({
    to: "john@company.com",
    subject: "Re: Meeting tomorrow",
    body: "Hi John,\n\nYes, 3pm works for me. See you then!\n\nBest",
    reply_to: "abc123"
  })
→ "Email enviado a John."
```

---

## OAuth Flow Detallado

### Configuración en Google Cloud

1. **Crear Proyecto:**
   - Google Cloud Console → New Project → "Sidecar"

2. **Habilitar APIs:**
   - Gmail API
   - (Opcional) Google Calendar API

3. **Configurar OAuth Consent Screen:**
   - User Type: External
   - App name: "Sidecar"
   - Scopes:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.send`
     - `https://www.googleapis.com/auth/gmail.modify`

4. **Crear Credentials:**
   - OAuth 2.0 Client ID
   - Application type: Desktop app
   - Download JSON

5. **Agregar a .env:**
   ```env
   GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxx
   ```

### Flow en Sidecar

```
1. Usuario: /integrations connect gmail

2. Sidecar:
   a. Verifica que GOOGLE_CLIENT_ID existe
   b. Genera state para CSRF
   c. Construye auth URL:
      https://accounts.google.com/o/oauth2/v2/auth?
        client_id=xxx&
        redirect_uri=http://localhost:PORT/oauth/callback&
        scope=gmail.readonly gmail.send&
        response_type=code&
        state=xxx&
        access_type=offline&
        prompt=consent
   d. Inicia servidor HTTP temporal en puerto random
   e. Abre browser (o muestra URL)

3. Usuario autoriza en browser

4. Google redirige a localhost:PORT/oauth/callback?code=xxx&state=xxx

5. Sidecar:
   a. Verifica state
   b. Intercambia code por tokens:
      POST https://oauth2.googleapis.com/token
        code=xxx&
        client_id=xxx&
        client_secret=xxx&
        redirect_uri=xxx&
        grant_type=authorization_code
   c. Recibe: { access_token, refresh_token, expires_in }
   d. Guarda tokens encriptados en integrations.json
   e. Cierra servidor temporal
   f. Carga tools de Gmail

6. Sidecar: "✅ Gmail conectado. Tools disponibles: email_list, email_read, ..."
```

### Refresh Token

```typescript
async function refreshGmailToken(): Promise<string> {
  const config = await loadIntegrationConfig('gmail');

  if (!config.oauth?.refreshToken) {
    throw new Error('No refresh token. Reconnect Gmail.');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: config.oauth.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error}`);
  }

  // Actualizar access token
  await updateIntegrationConfig('gmail', {
    oauth: {
      ...config.oauth,
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    },
  });

  return data.access_token;
}
```

---

## Gmail API Client

### Interfaz

```typescript
// src/integrations/gmail/client.ts

interface GmailClient {
  // Emails
  listMessages(params: ListMessagesParams): Promise<Message[]>;
  getMessage(id: string, format?: 'full' | 'metadata'): Promise<Message>;
  searchMessages(query: string, maxResults?: number): Promise<Message[]>;
  sendMessage(params: SendMessageParams): Promise<SendResult>;

  // Drafts
  createDraft(params: SendMessageParams): Promise<Draft>;

  // Labels
  listLabels(): Promise<Label[]>;

  // Threads
  getThread(id: string): Promise<Thread>;
}

interface Message {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: MessagePayload;
  internalDate: string;
}

interface MessagePayload {
  headers: Header[];
  body?: { data: string };
  parts?: MessagePart[];
}
```

### Implementación

```typescript
// src/integrations/gmail/client.ts

import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

export class GmailClientImpl implements GmailClient {
  private gmail: ReturnType<typeof google.gmail>;

  constructor(accessToken: string) {
    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: accessToken });
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  async listMessages(params: ListMessagesParams): Promise<Message[]> {
    const query = this.buildQuery(params);

    const response = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: params.limit || 10,
    });

    if (!response.data.messages) return [];

    // Fetch full message for each
    const messages = await Promise.all(
      response.data.messages.map(m => this.getMessage(m.id!))
    );

    return messages;
  }

  async getMessage(id: string, format = 'full'): Promise<Message> {
    const response = await this.gmail.users.messages.get({
      userId: 'me',
      id,
      format,
    });

    return response.data as Message;
  }

  // ... más métodos
}
```

---

## Parsing de Emails

### Extraer Headers

```typescript
function parseHeaders(headers: Header[]): ParsedHeaders {
  const get = (name: string) =>
    headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

  return {
    from: parseEmailAddress(get('From') || ''),
    to: (get('To') || '').split(',').map(parseEmailAddress),
    cc: (get('Cc') || '').split(',').filter(Boolean).map(parseEmailAddress),
    subject: get('Subject') || '(no subject)',
    date: get('Date') || '',
    messageId: get('Message-ID') || '',
    inReplyTo: get('In-Reply-To'),
  };
}

function parseEmailAddress(raw: string): EmailAddress {
  // "John Doe <john@example.com>" → { name: "John Doe", email: "john@example.com" }
  const match = raw.match(/^(?:"?([^"]*)"?\s)?<?([^>]+)>?$/);
  if (match) {
    return { name: match[1]?.trim(), email: match[2].trim() };
  }
  return { email: raw.trim() };
}
```

### Extraer Body (con Edge Cases)

**⚠️ CRÍTICO:** El parsing de emails es más complejo de lo que parece. ~5-10% de emails reales tienen formatos problemáticos.

```typescript
function extractBody(payload: MessagePayload): { text: string; html?: string } {
  // Email simple (sin parts)
  if (payload.body?.data) {
    const decoded = decodeBody(payload.body.data, getEncoding(payload.headers));
    return { text: decoded };
  }

  // Email multipart
  if (payload.parts) {
    let text = '';
    let html = '';

    for (const part of payload.parts) {
      const encoding = getEncoding(part.headers);

      if (part.mimeType === 'text/plain' && part.body?.data) {
        text = decodeBody(part.body.data, encoding);
      }
      if (part.mimeType === 'text/html' && part.body?.data) {
        html = decodeBody(part.body.data, encoding);
      }
      // Recursivo para multipart anidados
      if (part.parts) {
        const nested = extractBody(part as MessagePayload);
        text = text || nested.text;
        html = html || nested.html;
      }
    }

    // EDGE CASE: Email con solo HTML, sin text/plain
    if (!text && html) {
      text = htmlToPlainText(html);
    }

    return { text, html };
  }

  return { text: '' };
}

// Manejar diferentes encodings
function decodeBody(data: string, encoding: string): string {
  const buffer = Buffer.from(data, 'base64');

  switch (encoding.toLowerCase()) {
    case 'quoted-printable':
      return decodeQuotedPrintable(buffer);
    case 'base64':
      return buffer.toString('utf-8');
    default:
      return buffer.toString('utf-8');
  }
}

function getEncoding(headers?: Header[]): string {
  const header = headers?.find(
    h => h.name.toLowerCase() === 'content-transfer-encoding'
  );
  return header?.value || '7bit';
}

// Quoted-printable decoding (común en emails)
function decodeQuotedPrintable(buffer: Buffer): string {
  return buffer
    .toString('utf-8')
    .replace(/=\r?\n/g, '')                    // Soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

// Fallback: extraer texto de HTML
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
```

### Edge Cases de Email a Testear

| Caso | Frecuencia | Manejo |
|------|------------|--------|
| Quoted-printable encoding | ~20% | `decodeQuotedPrintable()` |
| Solo HTML, sin text/plain | ~10% | `htmlToPlainText()` fallback |
| Charset no-UTF8 (ISO-8859-1, etc) | ~5% | Detectar charset header, usar iconv |
| MIME malformado | ~3% | Try-catch, retornar snippet como fallback |
| Nested multipart/mixed | ~15% | Recursión (ya implementada) |
| Attachments inline | ~10% | Filtrar por Content-Disposition |
```

---

## Integración con LLM

### Resumir Email

Cuando el usuario pide un resumen, usamos el LLM local (Fase 3.6a/b).

```typescript
// src/integrations/gmail/tools.ts

async function summarizeEmail(params: EmailSummarizeParams): Promise<EmailSummarizeResult> {
  // 1. Obtener email(s)
  let content: string;
  if (params.email_id) {
    const email = await gmailClient.getMessage(params.email_id);
    content = formatEmailForSummary(email);
  } else if (params.thread_id) {
    const thread = await gmailClient.getThread(params.thread_id);
    content = thread.messages.map(formatEmailForSummary).join('\n---\n');
  } else {
    throw new Error('email_id or thread_id required');
  }

  // 2. Construir prompt según style
  const prompt = buildSummaryPrompt(content, params.style);

  // 3. Ejecutar con LLM local
  const result = await localExecutor.execute({
    intent: 'summarize',
    prompt,
    preferredModel: 'qwen2.5:7b-instruct',
  });

  // 4. Parsear resultado
  return parseSummaryResult(result, content.length);
}

function buildSummaryPrompt(content: string, style: string): string {
  const styleInstructions = {
    brief: 'Summarize in 1-2 sentences. Only the key point.',
    detailed: 'Provide a comprehensive summary covering all main points.',
    action_items: 'Summarize and extract any action items or tasks mentioned.',
  };

  return `
Summarize the following email(s).

Style: ${styleInstructions[style] || styleInstructions.brief}

Email content:
"""
${content}
"""

${style === 'action_items' ?
  'Response format:\nSummary: [summary]\nAction Items:\n- [item 1]\n- [item 2]' :
  'Response format: Just the summary, no preamble.'}
`;
}
```

---

## Estructura de Archivos

```
sidecar/
├── src/
│   ├── integrations/
│   │   ├── gmail/
│   │   │   ├── index.ts          # GmailPlugin export
│   │   │   ├── tools.ts          # Tool definitions + execute functions
│   │   │   ├── client.ts         # Gmail API wrapper
│   │   │   ├── parser.ts         # Email parsing utilities
│   │   │   └── types.ts          # Gmail-specific types
│   │   │
│   │   └── ...
│   │
│   └── ...
│
├── tests/
│   └── integrations/
│       └── gmail/
│           ├── client.test.ts
│           ├── parser.test.ts
│           └── tools.test.ts
│
└── ...
```

---

## Orden de Implementación

### Día 1: Gmail Client

- [ ] `src/integrations/gmail/types.ts`
  - Interfaces para emails, threads, labels

- [ ] `src/integrations/gmail/client.ts`
  - Wrapper de googleapis
  - listMessages, getMessage, searchMessages
  - sendMessage (básico)

- [ ] `src/integrations/gmail/parser.ts`
  - parseHeaders
  - extractBody
  - formatEmailForDisplay

### Día 2: OAuth Integration

- [ ] Integrar con OAuth Manager de Fase 3.6c
  - Google-specific config
  - Scopes correctos
  - Redirect URI handling

- [ ] Test manual de flow completo
  - `/integrations connect gmail`
  - Autorizar en browser
  - Verificar tokens guardados

### Día 3: Tools Implementation

- [ ] `email_list` tool
  - Parámetros: limit, unread_only, from, after, before
  - Formateo amigable de resultados

- [ ] `email_read` tool
  - Full email display
  - Attachments listing

- [ ] `email_search` tool
  - Gmail query syntax
  - Resultados paginados

### Día 4: Advanced Tools

- [ ] `email_summarize` tool
  - Integración con LLM local
  - Estilos: brief, detailed, action_items
  - Thread summarization

- [ ] `email_send` tool
  - Composición de mensaje
  - Reply-to support
  - Draft mode

### Día 5: Testing + Polish

- [ ] Tests unitarios
  - Parser tests con ejemplos reales **(CRÍTICO)**
  - Mock de Gmail API

- [ ] **Tests de parsing de email (crear fixtures reales):**
  - [ ] Email simple text/plain
  - [ ] Email multipart con text + html
  - [ ] Email con quoted-printable encoding
  - [ ] Email con solo HTML (sin text/plain)
  - [ ] Email con charset ISO-8859-1
  - [ ] Email con MIME malformado (graceful failure)
  - [ ] Thread con 5+ emails anidados

- [ ] Tests de integración
  - Con cuenta Gmail real (manual)
  - Todos los flows

- [ ] Edge cases
  - Token expirado → refresh (verificar mutex funciona)
  - Rate limit → retry con backoff
  - Email sin body → mostrar snippet como fallback
  - Attachments grandes → skip body, mostrar lista de attachments

- [ ] Documentación
  - README con setup de Google Cloud
  - Ejemplos de uso

---

## Criterios de Verificación

### OAuth

- [ ] `/integrations connect gmail` abre browser
- [ ] Autorización completa el flow
- [ ] Tokens se guardan encriptados
- [ ] `/integrations status gmail` muestra "connected"
- [ ] Token refresh funciona automáticamente

### Tools

- [ ] `email_list` retorna emails recientes
- [ ] `email_list({ unread_only: true })` filtra correctamente
- [ ] `email_read` muestra email completo con headers
- [ ] `email_search` encuentra emails por query
- [ ] `email_summarize` genera resumen útil
- [ ] `email_send` envía email correctamente

### Error Handling

- [ ] Token expirado → auto refresh → retry
- [ ] Token inválido → "Reconecta Gmail"
- [ ] Email no encontrado → error claro
- [ ] Rate limit → espera y retry
- [ ] Sin conexión → error apropiado

### UX

- [ ] Emails se muestran con formato legible
- [ ] Fechas en formato local
- [ ] Snippets truncados apropiadamente
- [ ] Attachments listados con tamaño

---

## Rate Limits

Gmail API tiene límites:
- 250 quota units por user por segundo
- getMessage = 5 units
- list = 5 units
- send = 100 units

**Mitigación:**
- Batch requests cuando sea posible
- Cache de mensajes recientes (5 minutos)
- Retry con backoff exponencial

```typescript
const GMAIL_RATE_LIMIT = {
  maxRequestsPerSecond: 10,
  retryAfterMs: 1000,
  maxRetries: 3,
};

async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < GMAIL_RATE_LIMIT.maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (isRateLimitError(error)) {
        await sleep(GMAIL_RATE_LIMIT.retryAfterMs * (i + 1));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Rate limit exceeded after retries');
}
```

---

## Seguridad

### Tokens

- Access token: Válido ~1 hora
- Refresh token: Válido indefinidamente (hasta revocado)
- Ambos encriptados con AES-256-GCM
- Key derivada de machine ID

### Scopes Mínimos

Solo pedimos lo necesario:
- `gmail.readonly`: Leer emails
- `gmail.send`: Enviar emails
- `gmail.modify`: Marcar como leído (opcional)

**NO pedimos:**
- `gmail.full`: Acceso completo (innecesario)
- Scopes de otros servicios

### Logging

- NUNCA logueamos tokens
- NUNCA logueamos contenido de emails
- Solo logueamos IDs y metadata

---

## Changelog

### 2026-02-01 - Análisis de riesgos integrado
- Reescrita sección "Extraer Body" con manejo de edge cases
- Agregadas funciones: `decodeQuotedPrintable()`, `htmlToPlainText()`, `getEncoding()`
- Agregada tabla de edge cases de email con frecuencias
- Día 5 actualizado con tests específicos de parsing
- 7 fixtures de email requeridos para tests

### 2026-02-01 - Documento inicial
- Especificación de 5 tools de Gmail
- OAuth flow detallado
- Gmail API client design
- Integración con LLM para summarize
- Rate limiting strategy
- Orden de implementación (5 días)
- Criterios de verificación

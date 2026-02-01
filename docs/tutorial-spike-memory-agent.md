# Tutorial: Spike Técnico del Memory Agent

> Este documento explica paso a paso qué es un spike técnico, qué hicimos, y cómo podés reproducirlo manualmente.

---

## 1. ¿Qué es un Spike Técnico?

Un **spike técnico** es un experimento corto (1-2 días) para responder una pregunta específica antes de comprometerse a implementar algo grande.

### Analogía

Imaginate que querés pintar tu casa de un color nuevo. Antes de comprar 20 litros de pintura y pintar todo:

1. Comprás un litro pequeño
2. Pintás un pedacito de pared
3. Esperás que seque
4. Ves si te gusta

Eso es un spike. Probás rápido, con bajo costo, antes de comprometerte.

### Nuestro Spike

**Pregunta:** ¿Puede un modelo de IA pequeño (Qwen2.5-3B) corriendo en mi computadora hacer tareas de memoria para nuestro agente?

**Tareas a probar:**
- Extraer hechos (facts) de una conversación
- Resumir conversaciones
- Detectar si el usuario re-confirma algo que ya sabíamos

---

## 2. ¿Qué es Ollama?

**Ollama** es una herramienta que te permite correr modelos de IA en tu propia computadora, sin necesidad de internet o APIs de pago.

### Analogía

Pensá en Ollama como un "Netflix de modelos de IA":
- Netflix: descargás películas y las ves offline
- Ollama: descargás modelos de IA y los usás offline

### Por qué es útil

| Sin Ollama | Con Ollama |
|------------|------------|
| Pagás por cada pregunta (API) | Gratis después de descargar |
| Necesitás internet | Funciona offline |
| Tus datos van a servidores externos | Todo queda en tu máquina |

---

## 3. Paso a Paso: Cómo Hicimos el Spike

### Paso 1: Instalar Ollama

```bash
brew install ollama
```

**¿Qué hace este comando?**
- `brew` es el gestor de paquetes de macOS (como una "App Store" para la terminal)
- `install ollama` descarga e instala Ollama en tu computadora

**Resultado esperado:** Ollama queda instalado pero NO está corriendo todavía.

---

### Paso 2: Iniciar el Servidor de Ollama

```bash
ollama serve &
```

**¿Qué hace este comando?**
- `ollama serve` inicia el servidor de Ollama (como "prender" el programa)
- `&` al final significa "corré esto en segundo plano" (para que la terminal no quede bloqueada)

**¿Por qué es necesario?**
Ollama funciona como cliente-servidor:
```
┌─────────────────┐         ┌─────────────────┐
│   Tu terminal   │ ──────► │ Servidor Ollama │
│   (cliente)     │ ◄────── │ (procesa IA)    │
└─────────────────┘         └─────────────────┘
```

El servidor es el que realmente ejecuta los modelos de IA. Tiene que estar corriendo para que puedas hacer preguntas.

**Problema común:**
```
Error: ollama server not responding - could not find ollama app
```
Esto significa que el servidor no está corriendo. Solución: ejecutar `ollama serve &`.

---

### Paso 3: Descargar el Modelo

```bash
ollama pull qwen2.5:3b-instruct
```

**¿Qué hace este comando?**
- `ollama pull` = descargar un modelo
- `qwen2.5:3b-instruct` = el nombre del modelo específico

**Desglose del nombre del modelo:**
```
qwen2.5 : 3b   - instruct
│         │      │
│         │      └── "instruct" = entrenado para seguir instrucciones
│         │
│         └── "3b" = 3 billones de parámetros (tamaño del modelo)
│
└── "qwen2.5" = nombre del modelo (hecho por Alibaba)
```

**¿Cuánto tarda?**
- El modelo pesa ~1.9 GB
- Depende de tu conexión a internet
- Típicamente 2-5 minutos

**Resultado esperado:**
```
pulling manifest
pulling 5ee4f07cdb9b: 100% ▕██████████████████▏ 1.9 GB
verifying sha256 digest
writing manifest
success
```

---

### Paso 4: Verificar que el Modelo se Descargó

```bash
ollama list
```

**¿Qué hace este comando?**
Lista todos los modelos que tenés descargados.

**Resultado esperado:**
```
NAME                   ID              SIZE      MODIFIED
qwen2.5:3b-instruct    357c53fb659c    1.9 GB    About a minute ago
```

---

### Paso 5: Probar el Modelo (Extracción de Facts)

Ahora viene lo interesante. Vamos a pedirle al modelo que extraiga hechos de un mensaje.

```bash
curl -s http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:3b-instruct",
  "prompt": "Extract facts from this message. Output ONLY valid JSON, no explanations.\n\nMessage: \"Trabajo en una fintech, somos 5 en el equipo. Prefiero que me hables directo, sin rodeos.\"\n\nOutput format:\n{\"facts\": [{\"domain\": \"work|preferences|personal\", \"fact\": \"...\", \"confidence\": \"high|medium|low\"}]}",
  "stream": false
}' | jq -r '.response'
```

**Desglose del comando (parte por parte):**

```
curl -s http://localhost:11434/api/generate -d '{...}'
│    │   │                      │
│    │   │                      └── La API de generación de Ollama
│    │   │
│    │   └── localhost:11434 = tu computadora, puerto 11434 (donde corre Ollama)
│    │
│    └── -s = "silent" (no mostrar barra de progreso)
│
└── curl = programa para hacer requests HTTP desde la terminal
```

```
-d '{...}'
    │
    └── -d = "data" (los datos que enviamos al servidor)
```

**El JSON que enviamos:**
```json
{
  "model": "qwen2.5:3b-instruct",  // Qué modelo usar
  "prompt": "...",                  // La pregunta/instrucción
  "stream": false                   // Queremos la respuesta completa, no en partes
}
```

**El prompt que usamos:**
```
Extract facts from this message. Output ONLY valid JSON, no explanations.

Message: "Trabajo en una fintech, somos 5 en el equipo. Prefiero que me hables directo."

Output format:
{"facts": [{"domain": "work|preferences|personal", "fact": "...", "confidence": "high|medium|low"}]}
```

**¿Qué hace `| jq -r '.response'`?**
```
| jq -r '.response'
│ │   │   │
│ │   │   └── Extraer solo el campo "response" del JSON
│ │   │
│ │   └── -r = "raw" (sin comillas extra)
│ │
│ └── jq = programa para procesar JSON
│
└── | = "pipe" (pasar la salida de curl a jq)
```

**Resultado esperado:**
```json
{
  "facts": [
    {"domain": "work", "fact": "The narrator is working at a fintech company.", "confidence": "high"},
    {"domain": "preferences", "fact": "The narrator prefers direct communication.", "confidence": "high"}
  ]
}
```

---

### Paso 6: Probar Summarization

```bash
curl -s http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:3b-instruct",
  "prompt": "Summarize this conversation. Output ONLY valid JSON.\n\nFormat: {\"topic\": \"...\", \"discussed\": [...], \"outcome\": \"...\"}\n\nConversation:\nUser: \"Estoy pensando si usar Docker Compose o Kubernetes\"\nAssistant: \"Para un equipo de 5, Docker Compose es más simple.\"\nUser: \"Vamos con Docker Compose entonces\"\n\nOutput:",
  "stream": false
}' | jq -r '.response'
```

**Resultado esperado:**
```json
{
  "topic": "Deployment Choice",
  "discussed": ["Docker Compose", "Kubernetes"],
  "outcome": "Choose Docker Compose"
}
```

---

### Paso 7: Medir Latencia

```bash
time curl -s http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:3b-instruct",
  "prompt": "Say hello in JSON: {\"greeting\": \"...\"}",
  "stream": false
}' > /dev/null
```

**Desglose:**
- `time` = medir cuánto tarda el comando
- `> /dev/null` = descartar la salida (solo queremos el tiempo)

**Resultado esperado:**
```
real    0m0.847s    ← Esto es lo que nos importa
user    0m0.005s
sys     0m0.004s
```

El modelo tarda ~0.3-1.2 segundos por pregunta.

---

## 4. ¿Qué Significan los Resultados?

### Lo que aprendimos del Spike

| Prueba | Resultado | Significa |
|--------|-----------|-----------|
| Extracción de facts | ✅ Funcionó | El modelo puede identificar hechos en texto |
| Summarization | ✅ Funcionó | El modelo puede comprimir conversaciones |
| Re-confirmación | ⚠️ Muy estricto | Prefiere decir "no" ante ambigüedad |
| Latencia | ~0.4-1.2s | Aceptable para operaciones async |

### Decisión

**SPIKE EXITOSO** → Podemos usar Qwen2.5:3b como Memory Agent.

---

## 5. Problemas Comunes y Soluciones

### Problema 1: "ollama server not responding"

**Causa:** El servidor no está corriendo.

**Solución:**
```bash
ollama serve &
```

### Problema 2: "model not found"

**Causa:** El modelo no está descargado.

**Solución:**
```bash
ollama pull qwen2.5:3b-instruct
```

### Problema 3: La respuesta tiene markdown

A veces el modelo devuelve:
```
```json
{"facts": [...]}
```
```

En lugar de JSON limpio.

**Solución en código:**
```typescript
function cleanResponse(raw: string): string {
  return raw
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
}
```

### Problema 4: El modelo es muy lento

**Causas posibles:**
1. Primera llamada (cold start) - siempre es más lenta
2. Poco RAM disponible
3. Modelo muy grande para tu hardware

**Soluciones:**
1. Ignorar la primera llamada (warm-up)
2. Cerrar otras aplicaciones
3. Usar un modelo más pequeño (ej: `qwen2.5:1.5b`)

---

## 6. Comandos Útiles de Ollama

```bash
# Ver modelos descargados
ollama list

# Descargar un modelo
ollama pull <nombre>

# Borrar un modelo
ollama rm <nombre>

# Chat interactivo con un modelo
ollama run qwen2.5:3b-instruct

# Ver si el servidor está corriendo
curl http://localhost:11434/api/tags

# Detener el servidor
pkill ollama
```

---

## 7. Próximos Pasos

Ahora que validamos que el Memory Agent funciona, los siguientes pasos son:

1. **Implementar `memory-agent.ts`** — Cliente TypeScript para Ollama
2. **Integrar en `context-guard.ts`** — Usar summarization antes de truncar
3. **Agregar hook post-respuesta** — Extracción automática de facts
4. **Agregar embeddings** — Para búsqueda semántica de facts

---

## 8. Glosario

| Término | Significado |
|---------|-------------|
| **Spike** | Experimento corto para validar una idea |
| **Ollama** | Herramienta para correr modelos de IA localmente |
| **curl** | Programa de terminal para hacer requests HTTP |
| **JSON** | Formato de datos estructurados |
| **API** | Interfaz para comunicarse con un programa |
| **localhost** | Tu propia computadora |
| **Puerto 11434** | "Puerta" donde Ollama escucha conexiones |
| **Modelo** | El "cerebro" de IA que procesa texto |
| **Prompt** | La instrucción que le das al modelo |
| **Latencia** | Cuánto tiempo tarda en responder |

# Sidecar

A local-first AI companion agent that runs on your machine. Built with TypeScript and Node.js.

## What is Sidecar?

Sidecar is an intelligent companion that lives on your computer. Unlike cloud-only assistants, it:

- **Runs locally** - Your data stays on your machine
- **Has persistent memory** - Remembers conversations and learns facts about you
- **Is proactive** - Can initiate conversations and send reminders
- **Uses tools** - Searches the web, checks weather, manages reminders, and more
- **Works offline** - Core features work without internet (with local LLMs via Ollama)

## Features

### Semantic Memory System
- Automatic fact extraction from conversations
- Vector embeddings for intelligent retrieval (`all-MiniLM-L6-v2`)
- Hybrid search (70% vector + 30% keyword)
- Adaptive context window (4-8 turns based on semantic continuity)

### Local Router
- Routes simple queries to local LLMs via Ollama
- Reduces API costs by 80-90% for typical usage
- Handles time, weather, and reminder queries locally
- Automatic fallback to cloud LLMs when needed

### Built-in Tools
| Tool | Description |
|------|-------------|
| `get_time` | Current date and time |
| `web_search` | Search the internet |
| `read_url` | Read and summarize web pages |
| `weather` | Current weather for any location |
| `remember` | Store facts about the user |
| `set_reminder` | Schedule reminders |
| `list_reminders` | View pending reminders |
| `cancel_reminder` | Cancel a reminder |

### Proactive Behavior
- Spontaneous check-ins based on context
- Reminder notifications
- Contextual suggestions

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AGENT CORE                           │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐   │
│  │   System    │  │   Agentic   │  │   Context    │   │
│  │   Prompt    │  │    Loop     │  │    Guard     │   │
│  │   Builder   │  │   (ReAct)   │  │              │   │
│  └─────────────┘  └─────────────┘  └──────────────┘   │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐   │
│  │   Memory    │  │    Local    │  │    Tools     │   │
│  │   (SQLite   │  │   Router    │  │   Registry   │   │
│  │  + Vectors) │  │  (Ollama)   │  │              │   │
│  └─────────────┘  └─────────────┘  └──────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Proactive Loop                      │   │
│  │         (Reminders + Spontaneous)                │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                     INTERFACES                          │
│                                                         │
│      CLI (current)    │    WhatsApp (planned)          │
└─────────────────────────────────────────────────────────┘
```

## Requirements

- Node.js >= 20.0.0
- [Ollama](https://ollama.ai) (for local LLM routing)
- An LLM API key (Kimi, Claude, or similar)

## Installation

```bash
# Clone the repository
git clone https://github.com/nicolasdma/sidecar.git
cd sidecar

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys

# Build
npm run build

# Run
npm start
```

## Development

```bash
# Run in development mode (with hot reload)
npm run dev

# Run tests
npm test                    # Unit tests
npm run test:local-router   # LocalRouter tests (90 tests)
npm run test:integration    # Integration tests
npm run test:all            # All tests
```

## Configuration

Create a `.env` file with:

```env
# Required: At least one LLM API key
KIMI_API_KEY=your_key_here
# ANTHROPIC_API_KEY=your_key_here

# Optional: For web search
JINA_API_KEY=your_key_here

# Optional: For weather
WEATHER_API_KEY=your_key_here
```

### Ollama Setup (for local routing)

```bash
# Install Ollama (macOS)
brew install ollama

# Pull the required model
ollama pull qwen2.5:3b-instruct

# Pull embedding model (optional, for local embeddings)
ollama pull nomic-embed-text
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `/facts` | Show stored facts about the user |
| `/remember <fact>` | Manually store a fact |
| `/reminders` | List pending reminders |
| `/health` | Show system health status |
| `/router-stats` | Show LocalRouter statistics |
| `/debug` | Toggle debug mode |
| `/clear` | Clear conversation history |
| `/exit` | Exit the application |

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict mode)
- **Database**: SQLite with sqlite-vec for vector search
- **Embeddings**: transformers.js (`all-MiniLM-L6-v2`)
- **Local LLM**: Ollama (`qwen2.5:3b-instruct`)
- **Cloud LLM**: Kimi K2.5 (default), Claude (fallback)
- **Testing**: Vitest

## Project Structure

```
sidecar/
├── src/
│   ├── index.ts              # Entry point
│   ├── agent/                # Brain, prompt builder, context guard
│   │   ├── brain.ts          # Agentic loop
│   │   ├── local-router/     # Local LLM routing
│   │   └── proactive/        # Spontaneous loop, reminders
│   ├── memory/               # SQLite operations, embeddings
│   ├── tools/                # Tool definitions
│   ├── interfaces/           # CLI adapter
│   ├── llm/                  # LLM clients (Kimi, Claude)
│   └── utils/                # Logger, config, metrics
├── tests/                    # Test suites
├── SOUL.md                   # Agent personality
└── data/                     # SQLite DB (gitignored)
```

## Personality

Sidecar has a distinct personality defined in `SOUL.md`:

- Friendly but not cloying
- Proactive but not invasive
- Curious about what the user is doing
- Honest about limitations
- Subtle humor when appropriate

The default personality speaks casual Argentine Spanish, but you can customize `SOUL.md` to change the language and tone.

## Roadmap

- [x] **Phase 1-2**: Core agent with memory and tools
- [x] **Phase 3**: Semantic memory with embeddings
- [x] **Phase 3.5**: LocalRouter for cost reduction
- [ ] **Phase 4**: WhatsApp integration
- [ ] **Phase 5**: Desktop UI with sprites

## License

MIT

## Contributing

Contributions are welcome! Please read the codebase first and maintain the existing code style (TypeScript strict, explicit error handling, no spaghetti).

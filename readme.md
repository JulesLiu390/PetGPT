<p align="center">
  <img src="design/icons/app-icon.png" alt="PetGPT Logo" width="128" height="128">
</p>

<h1 align="center">🐾 PetGPT</h1>

<p align="center">
  <strong>AI Desktop Pet Assistant with Autonomous Social Agent</strong> — A lightweight, cross-platform desktop companion powered by large language models, capable of independently participating in group chats.
</p>

---

## 📦 Download

**[Download Latest Release →](https://github.com/JulesLiu390/PetGPT/tags)**

### macOS Installation

If the app fails to open due to security restrictions, run:

```bash
sudo xattr -cr /Applications/PetGPT.app
```

---

## ✨ Features

### 🤖 Multi-LLM Support

Connect to any LLM provider with a unified interface:

- **OpenAI** — GPT-4o, GPT-4, GPT-3.5
- **Google Gemini** — Official REST API with enhanced multimodal support
- **Anthropic Claude** — Claude 3.5 Sonnet, Claude 3 Opus
- **xAI Grok** — Grok-2
- **OpenAI-Compatible APIs** — Ollama, DeepSeek, or any custom endpoint

### 🎨 Create Your Own AI Companion

Build personalized AI assistants with:

- **Custom Personalities** — Define system instructions and behavior
- **Multiple Assistants** — Create different characters for different tasks
- **Model Configuration** — Separate model settings from assistant personalities
- **Character Appearances** — Choose from built-in avatars or create custom ones

### 😊 Dynamic Expressions

Characters display real-time emotional reactions:

- **Mood Detection** — AI analyzes user messages to determine appropriate mood
- **Expression States** — Happy, Normal, Angry expressions
- **Per-Conversation Moods** — Each chat session maintains its own mood state

### 🖼️ Multimodal Support

Rich media capabilities vary by provider:

| Feature | OpenAI | Gemini | Others |
|---------|--------|--------|--------|
| Images | ✅ | ✅ | Varies |
| Video | ❌ | ✅ | ❌ |
| Audio | ❌ | ✅ | ❌ |
| PDF | ❌ | ✅ | ❌ |

- **Paste Images** — Directly paste images into chat
- **File Attachments** — Upload supported media files
- **Graceful Fallback** — Unsupported types convert to text descriptions

### 🔌 MCP (Model Context Protocol) Integration

Extend AI capabilities with external tools:

- **Stdio Transport** — Run local MCP servers (e.g., `npx @modelcontextprotocol/server-*`)
- **HTTP/SSE Transport** — Connect to remote MCP endpoints
- **Tool Execution** — AI can call tools automatically during conversations
- **Server Management** — Start, stop, and configure MCP servers from the UI
- **Per-Conversation Tools** — Enable/disable tools per chat session
- **Built-in QQ Connector** — Download a managed QQ-MCP runtime and official native NapCat package on demand, complete QQ QR login, and persist the QQ account → MCP server mapping without Docker

Open **Management → MCP** to use the built-in QQ setup wizard. PetGPT keeps the
Python runtime under its app-data directory, restricts NapCat WebUI access and
OneBot adapters to localhost, and generates a separate OneBot access token.
NapCat's official macOS installer still requires its guided QQ patch step.

### 🧩 Per-Assistant Skills

Add reusable workflows without loading every instruction into every prompt:

- **Progressive Loading** — Only Skill metadata is injected initially; full instructions and references are loaded on demand
- **Global Skill Library** — Maintain one shared Skill package and reuse it across assistants
- **Simple Library Management** — Add and delete shared packages from the dedicated Skills page
- **Per-Assistant Enablement** — Enable or disable individual Skills from the Assistant editor or directly from the Chat toolbar
- **Tool Composition** — Skills explain how to combine the built-in tools and enabled MCP servers without granting new permissions
- **Read-Only Runtime** — Chat can load Skill instructions and text references, but cannot execute arbitrary Skill scripts

Add or delete Skills from **Management → Skills**. Choose which Skills are active
from an Assistant's edit screen or the puzzle-piece menu in Chat. Both selectors
share the same per-assistant configuration.

Shared packages live at
`<app-data>/skills/<skill-id>/SKILL.md`; optional private overrides live at
`workspace/<pet-id>/skills/<skill-id>/SKILL.md`. If both locations contain the
same Skill ID, the assistant-private package takes precedence. Each assistant
still controls its own enabled Skill IDs.

Every `SKILL.md` uses Markdown frontmatter:

```markdown
---
name: Meeting Notes
description: Turn a meeting transcript into decisions and action items.
version: 1.0.0
scopes: chat
---

# Instructions

1. Identify decisions and unresolved questions.
2. Assign action items only when the transcript names an owner.
```

### 💾 Local Memory System

Persistent memory for personalized interactions:

- **Long-Term Memory** — AI remembers important user information across sessions
- **Memory Extraction** — Automatically identifies and stores key facts (name, preferences, etc.)
- **Per-Assistant Memory** — Each assistant maintains separate memory banks
- **Memory Toggle** — Enable/disable memory per conversation

### 🪟 Multi-Window Architecture

Flexible desktop integration:

- **Character Window** — Always-on-top transparent pet that follows you
- **Chat Window** — Resizable chat interface, auto-positions near character
- **Settings Panel** — Configure defaults, hotkeys, and preferences
- **MCP Manager** — Dedicated window for tool server management
- **Fullscreen Mode** — Expand chat with conversation history sidebar
- **Sidebar** — Browse and switch between past conversations

### ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Shift + Space` | Toggle character window |
| `Alt + Space` | Toggle chat window |

> Shortcuts are fully customizable in Settings.

### 🗂️ Conversation Management

- **Multi-Tab Interface** — Multiple chat sessions in tabs
- **Conversation History** — Full history saved to local SQLite database
- **Session Persistence** — Resume conversations after app restart
- **Orphan Recovery** — Transfer chats from deleted assistants to new ones

### 🤝 Social Agent — Autonomous Group Chat Participation

PetGPT can autonomously join and participate in messaging platform group chats as an independent social agent. Currently supports **QQ** (via [Amadeus-QQ-MCP](https://github.com/JulesLiu390/Amadeus-QQ-MCP)), with **Telegram**, **WhatsApp**, and more platforms planned.

#### Architecture: 4-Layer Processing Pipeline

Each monitored group runs **three independent loops** concurrently:

| Layer | Role | Description |
|-------|------|-------------|
| **Fetcher** | Data Ingestion | Batch-polls all targets on a fixed interval, writes raw messages into a shared in-memory buffer |
| **Observer** | Memory & Archival | Reads the message stream in read-only lurk mode; maintains per-group rule files (`GROUP_RULE_{id}.md`) and a global social memory (`SOCIAL_MEMORY.md`) — no sending |
| **Reply** | Response Decision | Detects new messages via watermark comparison; decides whether to speak or stay silent; sends via `send_message` tool call |
| **Intent** | Inner Monologue | Per-group independent thought loop; evaluates the character's subjective reaction to ongoing conversations and outputs a 5-tier willingness score |

#### Intent System — 5-Tier Willingness

The Intent loop produces a continuous inner monologue for each group, rating the character's desire to speak:

| Tier | Tag | Meaning |
|------|-----|---------|
| 1 | `[不想理]` | Zero interest, will not speak |
| 2 | `[无感]` | Aware of the topic, but irrelevant |
| 3 | `[有点想说]` | A thought surfaces, but could stay silent |
| 4 | `[想聊]` | Has something to say, wants to join |
| 5 | `[忍不住]` | Must speak, can't hold back |

Tiers 1–2 → sleep (no reply triggered). Tiers 3–5 → active (reply loop considers speaking). The intent is injected into the Reply prompt's final user message for maximum recency attention.

#### Lurk Modes

Each target can be independently set to one of three modes:

| Mode | Reply Behavior | Observer | Intent |
|------|---------------|----------|--------|
| `normal` | Full participation | ✅ | Evaluates on every new message |
| `semi-lurk` | Only responds when @mentioned | ✅ | 1-min cooldown between evaluations |
| `full-lurk` | Silent — no replies | ✅ | 1-min cooldown between evaluations |

All modes share the same Observer loop for continuous memory archival. Intent prompts are mode-aware — the LLM knows whether the character can speak, influencing its thought output.

#### Double-Slot Catchup Queue

Messages arriving while the Reply LLM is running are tracked by a background watcher (2s interval). Up to 2 catchup rounds are queued, ensuring recent messages are not missed without running indefinitely.

#### Platform Support

| Platform | Status | Integration |
|----------|--------|-------------|
| **QQ** | ✅ Supported | Via [Amadeus-QQ-MCP](https://github.com/JulesLiu390/Amadeus-QQ-MCP) (OneBot v11 → native MCP tool calls) |
| **Telegram** | 🔜 Planned | — |
| **WhatsApp** | 🔜 Planned | — |
| **Discord** | 🔜 Planned | — |

---

## 🗂️ Table of Contents

- [Download](#-download)
- [Features](#-features)
- [Social Agent](#-social-agent--autonomous-group-chat-participation)
- [Keyboard Shortcuts](#️-keyboard-shortcuts)
- [Development Guide](#-development-guide)
- [Project Structure](#-project-structure)
- [Tech Stack](#-tech-stack)
- [License](#-license)

---

## 🧑‍💻 Development Guide

### Prerequisites

- **Node.js** 18+
- **Rust** 1.77+ (for Tauri backend)
- **npm** or **pnpm**
- **Platform-specific:**
  - **macOS** — Xcode Command Line Tools
  - **Linux** — `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, etc. (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))
  - **Windows** — Visual Studio 2022 (MSVC C++ build tools) + Windows SDK

### Setup

```bash
# Install frontend dependencies
npm install
```

### Development

#### macOS / Linux

```bash
npm run tauri:dev
```

#### Windows

> Windows requires a dedicated script to set up the MSVC environment and strip conflicting PATH entries (e.g. Anaconda).

```powershell
npm run tauri:dev:win
```

The `dev-windows.ps1` script automatically cleans the PATH, sets MSVC/SDK environment variables, and starts the dev server.

### Build for Production

#### macOS

```bash
# Build .app bundle
npm run tauri:build

# Build DMG installer (Apple Silicon)
npm run build:dmg

# Build DMG installer (Intel)
sh scripts/create-dmg-intel.sh
```

#### Linux

```bash
# Build .deb package
npm run tauri:build
sh scripts/create-deb.sh
```

#### Windows

```powershell
npm run tauri:build:win
```

The `scripts/build-windows.ps1` script validates prerequisites, configures the MSVC toolchain, and compiles a release build. Output is placed in `src-tauri/target/release/bundle/` (includes `.msi` and NSIS `.exe` installers).

### Build Scripts

| Script | Platform | Description |
|--------|----------|-------------|
| `dev-windows.ps1` | Windows | Set up MSVC environment + start dev server |
| `scripts/build-windows.ps1` | Windows | Set up MSVC environment + release build |
| `scripts/create-dmg.sh` | macOS (ARM) | Package DMG installer |
| `scripts/create-dmg-intel.sh` | macOS (x86) | Package Intel DMG installer |
| `scripts/create-deb.sh` | Linux | Package .deb installer |
| `scripts/generate-all-icons.sh` | macOS | Generate all platform icons from source images |

---

## 📁 Project Structure

```
.
├── src/                    # React frontend
│   ├── components/         # UI components
│   │   ├── Chat/           # Chat interface components
│   │   ├── Layout/         # Title bars and layout
│   │   ├── Settings/       # Settings components
│   │   └── UI/             # Reusable UI primitives
│   ├── context/            # Global state management (Context + Reducer)
│   ├── pages/              # Page-level components
│   └── utils/              # Utilities
│       ├── llm/            # LLM adapters (OpenAI, Gemini)
│       └── mcp/            # MCP tool integration
├── src-tauri/              # Tauri backend (Rust)
│   ├── src/
│   │   ├── database/       # SQLite data layer
│   │   └── mcp/            # MCP client implementation
│   └── tauri.conf.json     # Tauri configuration
├── public/                 # Static assets
└── package.json
```

### Key Files

| File | Description |
|------|-------------|
| `src-tauri/src/lib.rs` | Tauri commands and app setup |
| `src/utils/bridge.js` | Frontend-backend communication layer |
| `src/utils/llm/` | Unified LLM API adapters |
| `src/components/Chat/ChatboxInputBox.jsx` | Main chat logic |

---

## 🧰 Tech Stack

### Desktop Framework

- [**Tauri 2**](https://tauri.app/) — Lightweight Rust-based desktop framework
- **SQLite** (via `rusqlite`) — Local database for conversations and settings
- **tokio** — Async runtime for Rust

### Frontend

- [**React 19**](https://react.dev/) — UI framework
- [**Vite**](https://vitejs.dev/) — Build tooling
- [**TailwindCSS 4**](https://tailwindcss.com/) — Utility-first styling
- [**React Router**](https://reactrouter.com/) — Hash-based routing
- [**react-markdown**](https://github.com/remarkjs/react-markdown) — Markdown rendering
- [**motion**](https://motion.dev/) — Animations

### AI & Tools

- **OpenAI SDK** — LLM API client
- **MCP (Model Context Protocol)** — Tool/agent framework support
- **Zod** — Schema validation

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

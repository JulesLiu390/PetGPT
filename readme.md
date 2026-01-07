<p align="center">
  <img src="design/icons/app-icon.png" alt="PetGPT Logo" width="128" height="128">
</p>

<h1 align="center">🐾 PetGPT</h1>

<p align="center">
  <strong>AI Desktop Pet Assistant</strong> — A lightweight, cross-platform desktop companion powered by large language models.
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

---

## 🗂️ Table of Contents

- [Download](#-download)
- [Features](#-features)
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

### Setup

```bash
# Install frontend dependencies
npm install

# Run in development mode (starts both frontend and Tauri)
npm run tauri:dev
```

### Build for Production

```bash
# Build the application
npm run tauri:build

# Build macOS DMG installer
npm run build:dmg
```

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

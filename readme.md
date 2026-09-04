<p align="center">
  <img src="design/icons/app-icon.png" alt="PetGPT Logo" width="128" height="128">
</p>

<h1 align="center">🐾 PetGPT</h1>

<p align="center">
  <strong>AI Desktop Pet Assistant with Autonomous Social Agent</strong> — A cross-platform desktop companion with configurable personalities, local memory, tool use, and autonomous QQ conversations.
</p>

PetGPT combines a desktop chat assistant with a background social agent. React
coordinates conversations and agent workflows; Tauri and Rust provide native
windows, local storage, network requests, MCP connections, and subprocesses.
Model inference uses the provider you configure, including compatible local
endpoints.

## Contents

- [Download](#-download)
- [Features](#-features)
- [Social Agent](#-social-agent--autonomous-qq-conversations)
- [Runtime Architecture](#runtime-architecture)
- [Local Data](#local-data)
- [Development Guide](#-development-guide)
- [Project Structure](#-project-structure)
- [Tech Stack](#-tech-stack)
- [License](#-license)

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

Configure providers separately from assistants and choose one of three API
formats implemented by PetGPT:

| API format | Adapter |
|------------|---------|
| `openai_compatible` | Chat Completions-compatible endpoints, including configured OpenAI, Grok, DeepSeek, Ollama, and custom services |
| `gemini_official` | Gemini REST requests, multimodal content, and Gemini tool schemas |
| `anthropic_native` | Anthropic Messages requests, image input, tools, and prompt caching |

Available models and capabilities depend on the selected provider and endpoint.
Ordinary chat supports streaming responses and tool calls; social roles can use
separate model configurations.

### 🎨 Create Your Own AI Companion

Build personalized AI assistants with:

- **Custom Personalities** — Define system instructions and behavior
- **Multiple Assistants** — Create different characters for different tasks
- **Model Configuration** — Separate model settings from assistant personalities
- **Character Appearances** — Choose from built-in avatars or create custom ones

### 😊 Dynamic Expressions

Characters display real-time emotional reactions:

- **Mood Detection** — Model-assisted mood selection updates the character during conversations
- **Expression States** — Normal, smile, sad, shocked, and thinking states, with appearance-dependent rendering
- **Per-Conversation Moods** — Each chat session maintains its own mood state
- **Layered Avatar** — A pseudo-Live2D character uses layered images, blinking, and lightweight animation

### 🖼️ Multimodal Support

PetGPT accepts pasted images and file attachments. Its OpenAI-compatible and
Anthropic adapters handle image input, while its Gemini adapter also handles
audio, video, and PDF attachments. The selected model must support the media
being sent; these are PetGPT adapter capabilities, not a complete provider
feature matrix.

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
- **Read-Only Runtime** — Chat can load Skill instructions and supported reference resources, but cannot execute arbitrary Skill scripts

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

### 💾 File-Based Personality and Memory

Each assistant has a workspace containing readable Markdown files:

| File | Purpose |
|------|---------|
| `SOUL.md` | The assistant's personality and behavior |
| `USER.md` | Information the assistant has learned about its user |
| `MEMORY.md` | Persistent facts, decisions, and context worth remembering |

The prompt builder reads these files each turn and truncates oversized content.
Memory uses text injection rather than a vector database. The assistant updates
memory through built-in `read`, `write`, and `edit` tools.

The per-conversation memory switch controls access to `USER.md` and `MEMORY.md`.
Custom personalities can still use `SOUL.md` with memory disabled; default
personality mode with memory disabled uses a generic assistant prompt.
AI-requested writes or edits to `SOUL.md` require confirmation in the app.

### 🪟 Multi-Window Architecture

Flexible desktop integration:

- **Character Window** — Always-on-top transparent pet; also hosts the social runtime
- **Chat Window** — Resizable chat interface, auto-positions near character
- **Management Window** — Manage assistants, providers, skins, MCP servers, Skills, defaults, and preferences
- **Social Window** — Configure targets, start or stop the agent, and inspect activity logs
- **Screenshot Overlay** — Capture screen content for chat
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

### 🤝 Social Agent — Autonomous QQ Conversations

PetGPT can observe and participate in configured QQ groups and private chats
through [Amadeus-QQ-MCP](https://github.com/JulesLiu390/Amadeus-QQ-MCP). Connect a
QQ account, select an assistant and messaging MCP server in the Social window,
configure the models and watched targets, then start the agent.

One assistant's social runtime can be active at a time, watching multiple
targets. The runtime lives in the **character window**; the Social window
controls it and displays logs through Tauri events. Closing the Social panel
does not itself stop the runtime—use its Stop control.

#### Processing and Decision Flow

A shared Fetcher runs alongside per-target Observer, Intent, and passive Reply
monitor loops:

| Component | Responsibility |
|-----------|----------------|
| **Fetcher** | Batch-polls targets, deduplicates messages, updates bounded buffers, and stores chat history |
| **Observer** | Maintains group rules, contact profiles, and social memory without sending messages |
| **Intent** | Reads the current situation, evaluates the character's response, and submits an action plan |
| **Reply** | Executes replies dispatched by Intent; the passive `replyLoop` only tracks message changes and watermarks |

Intent uses a tool-driven decision flow:

1. Call `get_situation()` for recent messages, trusted mention metadata, and the character's recent actions.
2. Consult relevant memory or available research tools as needed.
3. Call `write_intent_plan(state, brief, actions)` to submit the decision in one operation. A reply action requires a reply brief.
4. The runtime dispatches permitted actions: `reply`, `sticker`, `image`, or `wait`. An empty action list means no action.

The submission updates `social/<group|friend>/INTENT_<target-id>.md` and, when a
reply is requested, the target's `scratch_<target-id>/reply_brief.md`. Reply tasks
receive the brief and plan captured at dispatch time, so later Intent decisions
do not overwrite an in-flight reply's instructions.

Reply dispatch checks pause state, lurk mode, cooldown, and a per-target limit of
three concurrent replies. New messages arriving during an evaluation can trigger
a fresh assessment. Intent decisions use structured action plans rather than the
older five-tier willingness score and double-slot catchup queue.

#### Lurk Modes

Each target can be independently set to one of three modes:

| Mode | Behavior |
|------|----------|
| `normal` | Intent may initiate participation |
| `semi-lurk` | Sending requires a fresh, unconsumed mention identified by trusted message metadata |
| `full-lurk` | Observation continues; no outgoing actions are permitted |

Pausing a target is separate from lurking: it suspends the target's processing
and action dispatch. Social state is kept per assistant, with separate group
and private-chat namespaces. Timers, retry limits, runtime generations, and an
Intent watchdog help prevent stalled or superseded loops from continuing work.

#### Social Memory and History

- **Group rules:** `social/group/RULE_<target-id>.md`
- **Contact index and profiles:** `social/CONTACTS.md` and `social/people/<qq-id>.md`
- **Shared social memory:** `social/SOCIAL_MEMORY.md`
- **Reply strategy:** `social/REPLY_STRATEGY.md`, with agent editing controlled by configuration
- **History:** SQLite chat storage with FTS5 search and surrounding-message lookup, plus workspace logs and summaries

Observer and daily compression workflows maintain these records. Optional
Intent training collection requires the global toggle and target opt-in; it
stores traces under `social/training/intent/`. The export utility at
[`scripts/export_intent_training.mjs`](scripts/export_intent_training.mjs)
supports filtering and QQ identifier redaction.

### 🔎 Claude Code Subagents

Chat and Social Agent can delegate background research to Claude Code CLI
subprocesses. Each task gets a workspace and returns a result file; the Rust
process pool limits concurrency and enforces timeouts.

This optional feature requires a working, authenticated `claude` executable on
the application's `PATH`. Enable it for the relevant chat or social
configuration. Chat enablement is scoped to the conversation. Skill loading
does not itself enable subprocess execution or grant additional tools.

### Messaging Platform Support

| Platform | Status | Integration |
|----------|--------|-------------|
| **QQ** | ✅ Supported | Via [Amadeus-QQ-MCP](https://github.com/JulesLiu390/Amadeus-QQ-MCP) (OneBot v11 → native MCP tool calls) |
| **Telegram** | 🔜 Planned | — |
| **WhatsApp** | 🔜 Planned | — |
| **Discord** | 🔜 Planned | — |

---

## Runtime Architecture

The React entry point is `src/main.jsx`, with hash routes defined in
`src/components/App.jsx`. Each Tauri window loads its own route and React state.
Shared native state and events coordinate tabs, settings, character moods, and
social controls across windows.

```text
Chat UI -> personality / memory / Skill catalog -> LLM and tool loop
                                                   |
                                     Rust HTTP proxy -> configured model
                                                   |
                                  built-in tools / Skills / MCP servers
                                                   |
                                  streamed UI updates + SQLite persistence

Social panel -- Tauri events --> Character window's social runtime
                                  Fetcher -> target buffers
                                             |-- Observer -> social memory
                                             `-- Intent -> plan -> Reply / actions
```

`src/utils/tauri.js` is the active frontend-to-Rust API wrapper.
`src/utils/bridge.js` retains older Electron/Tauri compatibility code. The
shipped desktop application uses Tauri; it does not require an Electron runtime.
Rust owns the database, filesystem engines, MCP clients, HTTP transport, native
window behavior, and Claude Code process pool.

## Local Data

PetGPT uses Tauri's OS-specific application data directory for
`com.petgpt.app`, separate from the source checkout:

```text
<app-data>/
├── petgpt.db                  # Assistants, conversations, settings, providers, QQ mappings, chat history
├── workspace/<pet-id>/
│   ├── SOUL.md                # Personality
│   ├── USER.md                # User profile
│   ├── MEMORY.md              # Long-term memory, created as needed
│   ├── social/                # Social configuration, profiles, plans, logs, and traces
│   ├── skills/<skill-id>/     # Optional assistant-private Skill overrides
│   └── subagents/<task-id>/   # Background task workspaces
├── skills/<skill-id>/         # Shared Skill library
├── connectors/qq/            # Managed QQ runtime and login data
├── uploads/                  # Chat attachments
└── skins/                    # Character appearances
```

Persistence is local; configured model providers and MCP services receive the
messages and tool arguments needed for their calls. Back up the application
data directory to preserve conversations and assistant workspaces.

---

## 🧑‍💻 Development Guide

### Prerequisites

- **Node.js** 22+ recommended for development and tests
- **Rust** stable toolchain (the crate declares a minimum of 1.77.2; locked dependencies may require a newer compiler)
- **npm** (commands below use the committed `package-lock.json`)
- **Platform-specific:**
  - **macOS** — Xcode Command Line Tools
  - **Linux** — `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, etc. (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))
  - **Windows** — Visual Studio 2022 (MSVC C++ build tools) + Windows SDK

### Setup

```bash
# Install the locked frontend dependencies
npm ci
```

### Development

#### macOS / Linux

```bash
npm run tauri:dev
```

This starts Vite and the native Tauri application together. Keep Vite's port
aligned with `build.devUrl` in `src-tauri/tauri.conf.json` if changing the dev
server configuration. `npm run dev` starts only the frontend; a standalone
browser does not provide the native APIs required for full functionality.

On first launch, add an API provider in Management, create an assistant, and
choose its model and personality. MCP, QQ, Skills, and subagents are optional
capabilities configured separately.

#### Windows

> Windows requires a dedicated script to set up the MSVC environment and strip conflicting PATH entries (e.g. Anaconda).

```powershell
npm run tauri:dev:win
```

The `dev-windows.ps1` script cleans the PATH, sets MSVC/SDK environment
variables, and starts the dev server. The Windows scripts contain explicit
MSVC and Windows SDK paths; adjust them to match the installed toolchain.

### Validation

Run these from the repository root:

```bash
npm run build
node --test
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run lint
```

JavaScript tests use Node's built-in test runner. Integration tests load modules
through Vite and mock native calls and model responses. Rust tests cover native
helpers, workspace files, and Skill packages. There is no `npm test` script.

Builds, tests, and lint are separate checks; a successful build does not imply
a clean lint report. These checks also do not verify live model credentials,
QQ login, real message delivery, or native window interactions.

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
npm run tauri:build -- --bundles deb
```

#### Windows

```powershell
npm run tauri:build:win
```

The `scripts/build-windows.ps1` script validates prerequisites, configures the
MSVC toolchain, and invokes Tauri's release build. Bundle targets are controlled
by the Tauri configuration, whose checked-in default is the macOS `app` target.
For Windows installer builds, set `bundle.targets` to `msi` and/or `nsis` before
running the script. Bundle output is placed in `src-tauri/target/release/bundle/`.

### Build Scripts

| Script | Platform | Description |
|--------|----------|-------------|
| `dev-windows.ps1` | Windows | Set up MSVC environment + start dev server |
| `scripts/build-windows.ps1` | Windows | Set up MSVC environment + release build |
| `scripts/create-dmg.sh` | macOS (ARM) | Package DMG installer |
| `scripts/create-dmg-intel.sh` | macOS (x86) | Package Intel DMG installer |
| `scripts/create-deb.sh` | Linux | Alternative manual .deb packaging; inspect its version metadata before use |
| `scripts/generate-all-icons.sh` | macOS | Generate all platform icons from source images |

---

## 📁 Project Structure

```
.
├── src/                    # React frontend
│   ├── main.jsx            # Router and context providers
│   ├── components/         # UI components
│   │   ├── Avatar/         # Layered pseudo-Live2D character
│   │   ├── Chat/           # Chat interface components
│   │   ├── Layout/         # Title bars and layout
│   │   ├── Settings/       # Settings components
│   │   └── UI/             # Reusable UI primitives
│   ├── context/            # Global state management (Context + Reducer)
│   ├── pages/              # Character, management, social, and screenshot routes
│   └── utils/              # Conversation and agent orchestration
│       ├── llm/            # OpenAI-compatible, Gemini, and Anthropic adapters
│       ├── mcp/            # Tool schemas, execution loops, and authorization
│       ├── skills/         # Skill catalog, enablement, and read-only tools
│       ├── workspace/      # Chat and social file/action tools
│       ├── promptBuilder.js
│       ├── socialAgent.js
│       └── socialPromptBuilder.js
├── src-tauri/              # Tauri backend (Rust)
│   ├── src/
│   │   ├── lib.rs          # App setup, state, and command registration
│   │   ├── database/       # SQLite data layer
│   │   ├── llm/            # HTTP clients, proxy, and streaming
│   │   ├── mcp/            # Stdio and HTTP MCP clients
│   │   ├── platform/       # OS-specific native integration
│   │   ├── skills/         # Skill package validation and resource access
│   │   ├── subagent/       # Claude Code subprocess pool
│   │   ├── workspace/      # Per-assistant filesystem engine
│   │   ├── qq_connector.rs # Managed QQ runtime and account setup
│   │   └── window_layout.rs
│   └── tauri.conf.json     # Tauri configuration
├── pseudo_live2d_renderer/  # Avatar assets and standalone renderer experiments
├── scripts/                # Packaging, icons, and Intent training export
├── docs/superpowers/       # Design specifications and implementation plans
├── memory module documents/ # File-memory design notes
├── public/                 # Static public assets
└── package.json            # Frontend dependencies and development scripts
```

### Key Files

| File | Description |
|------|-------------|
| [`src/components/App.jsx`](src/components/App.jsx) | Window routes |
| [`src/components/Chat/ChatboxInputBox.jsx`](src/components/Chat/ChatboxInputBox.jsx) | Message submission, prompt assembly, streaming, and tool integration |
| [`src/utils/promptBuilder.js`](src/utils/promptBuilder.js) | File-based personality and memory prompts |
| [`src/utils/mcp/toolExecutor.js`](src/utils/mcp/toolExecutor.js) | Shared LLM/tool loops and per-turn tool authorization |
| [`src/utils/socialAgent.js`](src/utils/socialAgent.js) | Social runtime and action dispatch |
| [`src/pages/CharacterPage.jsx`](src/pages/CharacterPage.jsx) | Character rendering and social-runtime event ownership |
| [`src/utils/tauri.js`](src/utils/tauri.js) | Frontend wrappers for native commands and events |
| [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) | Rust app setup and command registration |

The root `src/` directory is the active frontend. The separate `frontend/`
directory is not a second application entry point. Design notes describe
individual iterations; use the runtime code to resolve differences with older
plans.

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

- **Provider adapters + reqwest** — Model request/response conversion and native HTTP transport
- **MCP (Model Context Protocol)** — External tool discovery and execution
- **Claude Code CLI** — Optional background research subprocesses
- **Zod** — Schema validation

---

## 📄 License

PetGPT is licensed under the [MIT License](LICENSE).

Copyright (c) 2026 JulesLiu390 and PetGPT contributors.

Third-party dependencies and assets remain subject to their respective licenses.

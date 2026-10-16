# PetGPT

## Communication
- 与用户交流时使用中文

Tauri v2 desktop app (Rust backend + React/Vite frontend). An AI pet that participates in group chats (QQ/WeChat via MCP) with a social agent system.

## Build & Dev

```bash
npm run tauri:dev        # dev mode (macOS/Linux)
npm run tauri:build      # production build
npm run dev              # frontend only (Vite)
npm run lint             # ESLint
npm run typecheck        # tsc over the TypeScript files
npm test                 # node --test src/**/*.test.{mjs,ts}
```

## Architecture

### Frontend (src/)
- **`src/pages/`** — React pages. `SocialPage.jsx` is the main social agent UI.
- **`src/utils/socialAgent.js`** — Core social agent loop: Intent (eval/plan) + Reply (send) + Observer + Fetcher layers per target (group/friend).
- **`src/utils/socialPromptBuilder.js`** — Builds system prompts for Intent eval and Reply LLM calls.
- **`src/utils/workspace/socialToolExecutor.js`** — Executes builtin tools (write_intent_plan, sticker, social_read/edit/write, history, etc.).
- **`src/utils/llm/`** — LLM abstraction. `index.js` routes to Rust backend (`llmCall`/`llmStream`) or JS adapters.
- **`src/utils/mcp/toolExecutor.js`** — `callLLMWithTools` loop: handles tool calls, builtin vs MCP dispatch, `stopAfterTool`.
- **`src/utils/tauri.js`** — Tauri invoke wrappers (`workspaceRead`, `workspaceWrite`, `llmCall`, etc.).

### Rust backend (src-tauri/)
- Handles LLM API calls, file I/O, MCP server management, and system tray.

## Key Patterns

### Social Agent Loop
Each target (group/friend) runs independent loops:
- **Fetcher** — polls MCP for new messages, wakes Intent via `_wake()`
- **Intent loop** — evaluates situation, calls `social_edit` then `write_intent_plan(actions=[...])`
- **Reply loop** — woken by `replyWakeFlag`, calls `send_message` via MCP (stopped after first call via `stopAfterTool`)
- **Observer loop** — periodic background analysis

### Intent State
- Stored per-session in `social/{group|friend}/INTENT_{targetId}.md` (workspace file)
- Format: `【我刚做了】... 【群里情况】... 【我的判断】...`
- LLM writes it directly via `social_edit` before calling `write_intent_plan`
- Read back at next eval via `readIntentStateFile` in system prompt

### `callLLMWithTools`
Key options:
- `stopAfterTool: 'tool_name'` — stops loop after named tool completes (used for `write_intent_plan` and `send_message`)
- `toolArgTransform: (name, args) => args` — transform args before execution (used to force `num_chunks` for Reply)
- `builtinToolContext` — passed to all builtin tool executors

### Workspace Files
Stored under `~/Library/Application Support/com.petgpt.app/workspace/{petId}/`:
- `social/group/INTENT_{id}.md` — per-session intent state (reset on agent start)
- `social/group/RULE_{id}.md` — group rules (persistent)
- `social/SOCIAL_MEMORY.md` — global social memory
- `social/CONTACTS.md` — contacts index

## Conventions
- New features are written in TypeScript (`.ts`/`.tsx`, strict); existing JS/JSX stays JS unless it is being rewritten. `npm run typecheck` checks only the TS files; the JS they import is used for type inference and is not checked.
- In TS files, imports carry the real extension (`./voiceCall.ts`, `./outgoingText.js`), types come in through `import type`, and there are no enums or namespaces: `node --test` runs `.ts` files directly with Node's type stripping, without a bundler.
- Tailwind CSS for styling
- Log levels: `info`, `warn`, `error`, `intent`, `send`, `memory`, `poll`
- `addLog(level, message, details, target)` for all agent logging
- `tauri.workspaceRead/Write` for all workspace file I/O

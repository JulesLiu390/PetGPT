# social-agent

Headless social agent service — extracted from PetGPT's Tauri app.
Runs as a CLI (Ink TUI) **and** an HTTP/WS service backing a web dashboard.

This subdirectory is **fully self-contained**: it has its own `package.json`,
`bun.lockb`, `tsconfig.json`. The outer PetGPT (Tauri app) does not import
from here, and vice versa. Connection between them is HTTP + WebSocket only.

## Stack

- **Bun** ≥ 1.3 (runtime + bundler + package manager)
- **TypeScript**
- **Ink** (React-for-terminals) — TUI mode
- **Bun.serve** built-in HTTP + WebSocket — service mode
- **MCP**: `@modelcontextprotocol/sdk`

## Getting started

```bash
cd social-agent
bun install
bun run dev      # Ink TUI — shows resolved paths
bun run serve    # headless HTTP+WS server on :8787
```

## Data layout

Mirrors Claude Code's `~/.claude/` convention.

```
~/.social-agent/                       # macOS — overridable via $SOCIAL_AGENT_HOME
├── settings.json                      # global config, user-editable
├── settings.local.json                # per-machine override (gitignore)
├── providers.enc                      # API keys, AES-GCM encrypted (master password)
├── mcp-servers.json                   # MCP server registry
├── pets/
│   └── {petId}/
│       ├── social-config.json         # mcpServerName / target list / lurk / customGroupRules
│       ├── workspace/
│       │   └── social/
│       │       ├── group/
│       │       │   ├── INTENT_{target}.md
│       │       │   ├── RULE_{target}.md
│       │       │   └── scratch_{target}/
│       │       │       ├── recent_self.md
│       │       │       └── reply_brief.md
│       │       ├── friend/
│       │       ├── SOCIAL_MEMORY.md
│       │       └── CONTACTS.md
│       ├── training/intent/{date}.jsonl
│       ├── images/
│       └── logs/
├── cache/
├── logs/
└── debug/
```

Cross-platform fallback (handled in [src/paths.ts](src/paths.ts)):

| OS      | Default path                                              | ENV override          |
| ------- | --------------------------------------------------------- | --------------------- |
| macOS   | `~/.social-agent`                                         | `$SOCIAL_AGENT_HOME`  |
| Linux   | `$XDG_CONFIG_HOME/social-agent` or `~/.config/social-agent` | `$SOCIAL_AGENT_HOME` |
| Windows | `%APPDATA%\social-agent`                                  | `%SOCIAL_AGENT_HOME%` |

# Claude SDK Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `claude_cli` (CLI subprocess) with `claude_sdk` (Agent SDK sidecar), making it a fully parallel third API format alongside OpenAI and Gemini with no special-case code paths.

**Architecture:** A Node.js sidecar process runs `@anthropic-ai/claude-agent-sdk`, communicating with Rust via stdin/stdout JSON-RPC. Rust routes `claude_sdk` requests to this sidecar in the same `llm_call`/`llm_stream` path used by OpenAI/Gemini. JS adapter outputs OpenAI-compatible format so toolExecutor needs zero special handling.

**Tech Stack:** Node.js (`@anthropic-ai/claude-agent-sdk`), Rust (Tauri, tokio, serde_json), JavaScript (React/Vite)

**Spec:** `docs/superpowers/specs/2026-04-01-claude-sdk-adapter-design.md`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Add `@anthropic-ai/claude-agent-sdk` dependency |
| `src-tauri/sidecars/claude-sdk-bridge.mjs` | Create | Node.js sidecar — wraps Agent SDK, stdin/stdout JSON protocol |
| `src-tauri/src/llm/claude_sdk.rs` | Create | Rust sidecar manager — spawn, communicate, lifecycle |
| `src-tauri/src/llm/types.rs` | Modify | Add `ClaudeSdk` to `ApiFormat` enum |
| `src-tauri/src/llm/client.rs` | Modify | Add `ClaudeSdk` match arm in `call()` |
| `src-tauri/src/llm/stream.rs` | Modify | Add `ClaudeSdk` match arm in `stream_chat()` |
| `src-tauri/src/llm/mod.rs` | Modify | Replace `claude_cli` module with `claude_sdk` |
| `src-tauri/src/lib.rs` | Modify | Register new commands, remove old ones, swap State |
| `src/utils/llm/adapters/claudeSdk.js` | Create | JS adapter — parallel to openaiCompatible.js |
| `src/utils/llm/index.js` | Modify | Route `claude_sdk`, remove `claude_cli` code |
| `src/utils/llm/presets.js` | Modify | Update presets for `claude_sdk` |
| `src/utils/mcp/toolExecutor.js` | Modify | Remove all `claude_cli` branches |
| `src/utils/tauri.js` | Modify | Add sidecar commands, remove CLI commands |
| `src/utils/socialAgent.js` | Modify | Remove `isCliMode` branches |
| `src/utils/socialPromptBuilder.js` | Modify | Remove `isCcMode` branches |
| `src/pages/ManagementPage.jsx` | Modify | Replace CLI UI with SDK UI |
| `src-tauri/src/llm/claude_cli.rs` | Delete | Remove entire module |
| `src/utils/llm/adapters/claudeCli.js` | Delete | Remove entire adapter |

---

### Task 1: Install Agent SDK + Create Bridge Sidecar

**Files:**
- Modify: `package.json`
- Create: `src-tauri/sidecars/claude-sdk-bridge.mjs`

- [ ] **Step 1: Install the Agent SDK**

```bash
npm install @anthropic-ai/claude-agent-sdk
```

- [ ] **Step 2: Create the sidecar directory**

```bash
mkdir -p src-tauri/sidecars
```

- [ ] **Step 3: Create the bridge script**

Create `src-tauri/sidecars/claude-sdk-bridge.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Claude SDK Bridge — sidecar process for PetGPT
 *
 * Wraps @anthropic-ai/claude-agent-sdk, communicates via stdin/stdout JSON-RPC.
 * Stays alive between calls; SDK manages auth via bundled CLI.
 *
 * Protocol: one JSON object per line (newline-delimited JSON).
 * Request:  { "id": "...", "method": "...", "params": { ... } }
 * Response: { "id": "...", "result": { ... } }  or  { "id": "...", "error": "..." }
 * Stream:   { "id": "...", "stream": { "type": "delta"|"tool_call_start"|..., ... } }
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createInterface } from 'readline';

// ── Helpers ──

/** Send a JSON line to stdout */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Convert OpenAI-format tools to SDK allowedTools (we disable all built-in tools) */
function convertTools(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return [];
  // SDK doesn't support custom tool definitions via query() — we describe tools in system prompt
  // and parse tool_call blocks from the response (same as claude_cli approach but much faster)
  return [];
}

/** Build the tool-calling system prompt injection */
function buildToolPrompt(tools) {
  if (!tools || tools.length === 0) return '';

  let section = '\n\n# Tool Calling\n\n' +
    'You have external tools you can call. To use a tool, output EXACTLY this format and NOTHING else:\n\n' +
    '```tool_call\n{"name": "TOOL_NAME", "arguments": {ARGS}}\n```\n\n' +
    'Rules:\n' +
    '- STOP immediately after the ```tool_call``` block. Do NOT add any text before or after it.\n' +
    '- The system will execute the tool and give you the result. Then you can continue.\n' +
    '- You can call only ONE tool at a time.\n' +
    '- When the user asks you to do something that matches a tool, you MUST call it.\n\n' +
    'Example:\n```tool_call\n{"name": "example_tool", "arguments": {"key": "value"}}\n```\n\n' +
    '## Available Tools\n\n';

  for (const tool of tools) {
    const fn = tool.function || tool;
    const name = fn.name || 'unknown';
    const desc = fn.description || '';
    const params = fn.parameters ? JSON.stringify(fn.parameters) : '{}';
    section += `- ${name}: ${desc} | Parameters: ${params}\n`;
  }

  return section;
}

/** Extract tool_call blocks from response text */
function extractToolCalls(text) {
  const toolCalls = [];
  let cleanText = '';
  let inToolBlock = false;
  let toolJson = '';
  let callIndex = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (trimmed === '```tool_call') {
      inToolBlock = true;
      toolJson = '';
      continue;
    }

    if (inToolBlock) {
      if (trimmed === '```') {
        inToolBlock = false;
        try {
          const parsed = JSON.parse(toolJson.trim());
          toolCalls.push({
            id: `cc_call_${callIndex++}`,
            type: 'function',
            function: {
              name: parsed.name || 'unknown',
              arguments: JSON.stringify(parsed.arguments || {}),
            },
          });
        } catch (e) { /* skip malformed */ }
        toolJson = '';
      } else {
        toolJson += (toolJson ? '\n' : '') + line;
      }
      continue;
    }

    cleanText += (cleanText ? '\n' : '') + line;
  }

  return { cleanText: cleanText.trim(), toolCalls };
}

// ── Sessions (for multi-turn tool calling) ──

const sessions = new Map(); // sessionId → { messages: [...] }

// ── Request handlers ──

async function handleLlmCall(id, params) {
  const { messages, model, system_prompt, tools, temperature, max_tokens, stream } = params;

  // Build prompt: combine system + tool definitions + conversation
  let fullSystem = system_prompt || '';
  if (tools && tools.length > 0) {
    fullSystem += buildToolPrompt(tools);
  }

  // Serialize messages to prompt text
  const promptParts = [];
  for (const msg of (messages || [])) {
    if (msg.role === 'system') continue; // already in system_prompt
    const content = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
        : String(msg.content || '');
    if (!content) continue;
    const label = msg.role === 'assistant' ? 'Assistant'
      : msg.role === 'tool' ? 'Tool Result'
      : 'Human';
    promptParts.push(`[${label}]\n${content}`);
  }
  const prompt = promptParts.join('\n\n');

  try {
    let resultText = '';

    for await (const message of query({
      prompt,
      options: {
        model: model || 'sonnet',
        systemPrompt: fullSystem || undefined,
        allowedTools: [],
        maxTurns: 1,
      },
    })) {
      if (message.type === 'assistant') {
        for (const block of (message.message?.content || [])) {
          if (block.type === 'text') {
            if (stream) {
              send({ id, stream: { type: 'delta', text: block.text } });
            }
            resultText += block.text;
          }
        }
      }
      if (message.type === 'result') {
        // Extract usage if available
        const usage = message.usage || {};
        const { cleanText, toolCalls } = extractToolCalls(resultText);

        // Return OpenAI-compatible format
        send({
          id,
          result: {
            choices: [{
              message: {
                role: 'assistant',
                content: cleanText,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
            }],
            usage: {
              prompt_tokens: usage.input_tokens || 0,
              completion_tokens: usage.output_tokens || 0,
              total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
            },
          },
        });
      }
    }
  } catch (err) {
    send({ id, error: err.message || String(err) });
  }
}

async function handlePing(id) {
  send({ id, result: { status: 'ok' } });
}

// ── Main loop ──

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    send({ id: null, error: `JSON parse error: ${e.message}` });
    return;
  }

  const { id, method, params } = req;

  try {
    switch (method) {
      case 'ping':
        await handlePing(id);
        break;
      case 'llm_call':
        await handleLlmCall(id, params || {});
        break;
      default:
        send({ id, error: `Unknown method: ${method}` });
    }
  } catch (err) {
    send({ id, error: err.message || String(err) });
  }
});

rl.on('close', () => process.exit(0));

// Signal ready
send({ id: null, result: { status: 'ready' } });
```

- [ ] **Step 4: Test the bridge manually**

```bash
echo '{"id":"t1","method":"ping","params":{}}' | node src-tauri/sidecars/claude-sdk-bridge.mjs
```

Expected output includes: `{"id":null,"result":{"status":"ready"}}` followed by `{"id":"t1","result":{"status":"ok"}}`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src-tauri/sidecars/claude-sdk-bridge.mjs
git commit -m "feat: add Claude SDK bridge sidecar"
```

---

### Task 2: Rust Sidecar Manager

**Files:**
- Create: `src-tauri/src/llm/claude_sdk.rs`
- Modify: `src-tauri/src/llm/types.rs`
- Modify: `src-tauri/src/llm/mod.rs`
- Modify: `src-tauri/src/llm/client.rs`
- Modify: `src-tauri/src/llm/stream.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `ClaudeSdk` to `ApiFormat` enum**

In `src-tauri/src/llm/types.rs`, add the variant and update `From<&str>`:

```rust
pub enum ApiFormat {
    OpenaiCompatible,
    GeminiOfficial,
    ClaudeSdk,
}

impl From<&str> for ApiFormat {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "gemini_official" | "gemini" => Self::GeminiOfficial,
            "claude_sdk" => Self::ClaudeSdk,
            _ => Self::OpenaiCompatible,
        }
    }
}
```

- [ ] **Step 2: Create `claude_sdk.rs` — sidecar manager**

Create `src-tauri/src/llm/claude_sdk.rs`:

```rust
//! Claude SDK Bridge 管理器
//!
//! 管理一个常驻 Node.js sidecar 进程，该进程运行 @anthropic-ai/claude-agent-sdk。
//! 通过 stdin/stdout JSON-RPC 通信，复用 MCP server 的管理模式。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, oneshot};
use tauri::{AppHandle, Emitter};

use crate::llm::types::*;

const BRIDGE_TIMEOUT_SECS: u64 = 180;

pub struct ClaudeSdkManager {
    inner: Mutex<Option<BridgeProcess>>,
}

struct BridgeProcess {
    child: Child,
    stdin: std::process::ChildStdin,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    next_id: AtomicU64,
}

impl ClaudeSdkManager {
    pub fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }

    /// Ensure the bridge is running, spawn if needed
    async fn ensure_running(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        if guard.is_some() { return Ok(()); }

        // Find node and bridge script
        let node_bin = std::env::var("NODE_BIN").unwrap_or_else(|_| "node".to_string());

        // Bridge script path — relative to the executable or dev path
        let bridge_path = find_bridge_script()?;

        log::info!("[ClaudeSdk] Spawning bridge: {} {}", node_bin, bridge_path);

        let mut child = Command::new(&node_bin)
            .arg(&bridge_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn Claude SDK bridge: {}", e))?;

        let stdin = child.stdin.take()
            .ok_or("Failed to take bridge stdin")?;
        let stdout = child.stdout.take()
            .ok_or("Failed to take bridge stdout")?;
        let stderr = child.stderr.take();

        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_clone = pending.clone();

        // Stdout reader thread
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        log::error!("[ClaudeSdk] stdout read error: {}", e);
                        break;
                    }
                };
                if line.trim().is_empty() { continue; }

                let parsed: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!("[ClaudeSdk] JSON parse error: {} — line: {}", e, &line[..line.len().min(200)]);
                        continue;
                    }
                };

                let id = parsed.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

                if let Some(id) = id {
                    // Check if this is a final result (has "result" or "error" field)
                    if parsed.get("result").is_some() || parsed.get("error").is_some() {
                        let mut map = pending_clone.blocking_lock();
                        if let Some(sender) = map.remove(&id) {
                            let _ = sender.send(parsed);
                        }
                    }
                    // Stream events are handled differently (via Tauri events in stream path)
                }
            }
            log::info!("[ClaudeSdk] stdout reader thread exited");
        });

        // Stderr reader thread
        if let Some(stderr) = stderr {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(line) = line {
                        if !line.trim().is_empty() {
                            log::warn!("[ClaudeSdk bridge stderr] {}", line);
                        }
                    }
                }
            });
        }

        // Wait for ready signal (first line from bridge)
        // The reader thread will handle it; we just store the process
        *guard = Some(BridgeProcess {
            child,
            stdin,
            pending,
            next_id: AtomicU64::new(1),
        });

        Ok(())
    }

    /// Send a request and wait for the response
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.ensure_running().await?;
        let mut guard = self.inner.lock().await;
        let bridge = guard.as_mut().ok_or("Bridge not running")?;

        let id = format!("req_{}", bridge.next_id.fetch_add(1, Ordering::SeqCst));
        let req = json!({ "id": id, "method": method, "params": params });

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = bridge.pending.blocking_lock();
            pending.insert(id.clone(), tx);
        }

        // Write to stdin
        let line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        bridge.stdin.write_all(line.as_bytes()).map_err(|e| format!("stdin write: {}", e))?;
        bridge.stdin.write_all(b"\n").map_err(|e| format!("stdin newline: {}", e))?;
        bridge.stdin.flush().map_err(|e| format!("stdin flush: {}", e))?;

        drop(guard); // Release lock while waiting

        // Wait for response with timeout
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(BRIDGE_TIMEOUT_SECS),
            rx,
        ).await
            .map_err(|_| format!("Bridge request timed out after {}s", BRIDGE_TIMEOUT_SECS))?
            .map_err(|_| "Bridge response channel dropped".to_string())?;

        // Check for error
        if let Some(err) = response.get("error").and_then(|e| e.as_str()) {
            return Err(err.to_string());
        }

        response.get("result").cloned()
            .ok_or_else(|| "Bridge response missing 'result'".to_string())
    }

    /// Graceful shutdown
    pub async fn shutdown(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(mut bridge) = guard.take() {
            let _ = bridge.child.kill();
            let _ = bridge.child.wait();
            log::info!("[ClaudeSdk] Bridge shut down");
        }
    }
}

/// Find the bridge script path
fn find_bridge_script() -> Result<String, String> {
    // Try relative to current exe (production)
    if let Ok(exe) = std::env::current_exe() {
        let dir = exe.parent().unwrap_or(std::path::Path::new("."));
        let candidate = dir.join("sidecars").join("claude-sdk-bridge.mjs");
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
        // macOS .app bundle
        let candidate = dir.join("../Resources/sidecars/claude-sdk-bridge.mjs");
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    // Dev mode: relative to project root
    let candidate = "src-tauri/sidecars/claude-sdk-bridge.mjs";
    if std::path::Path::new(candidate).exists() {
        return Ok(candidate.to_string());
    }
    Err("Claude SDK bridge script not found".to_string())
}

// ── Tauri command: non-streaming call via bridge ──

pub async fn call_via_bridge(
    manager: &ClaudeSdkManager,
    request: &LlmRequest,
) -> Result<LlmResponse, String> {
    let params = request_to_params(request, false);
    let result = manager.request("llm_call", params).await?;

    // Parse OpenAI-compatible response from bridge
    let content = result.pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let tool_calls = result.pointer("/choices/0/message/tool_calls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter().map(|tc| {
                let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let name = tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let arguments = tc.pointer("/function/arguments").and_then(|v| v.as_str()).unwrap_or("{}").to_string();
                ToolCall { id, name, arguments }
            }).collect::<Vec<_>>()
        });

    let usage = result.get("usage").cloned();

    Ok(LlmResponse {
        content,
        tool_calls,
        mood: None,
        usage,
    })
}

// ── Tauri command: streaming call via bridge ──

pub async fn stream_via_bridge(
    app: AppHandle,
    manager: &ClaudeSdkManager,
    request: &LlmRequest,
    cancel_token: Arc<std::sync::atomic::AtomicBool>,
) -> Result<LlmResponse, String> {
    // For now, use non-streaming and emit the full text as a single chunk
    // TODO: Implement true streaming when bridge supports it
    let response = call_via_bridge(manager, request).await?;

    let conversation_id = &request.conversation_id;
    let _ = app.emit(&format!("llm-stream-{}", conversation_id), json!({
        "delta": &response.content,
        "full_text": &response.content,
    }));

    Ok(response)
}

/// Convert LlmRequest to bridge params
fn request_to_params(request: &LlmRequest, stream: bool) -> Value {
    let messages: Vec<Value> = request.messages.iter().map(|msg| {
        json!({
            "role": match msg.role {
                Role::System => "system",
                Role::User => "user",
                Role::Assistant => "assistant",
                Role::Tool => "tool",
            },
            "content": match &msg.content {
                MessageContent::Text(s) => json!(s),
                MessageContent::Parts(parts) => json!(parts),
            },
            "tool_call_history": msg.tool_call_history,
        })
    }).collect();

    json!({
        "messages": messages,
        "model": request.model,
        "system_prompt": null,  // extracted from messages by bridge
        "tools": null,          // injected via system prompt by bridge
        "temperature": request.temperature,
        "max_tokens": request.max_tokens,
        "stream": stream,
    })
}
```

- [ ] **Step 3: Update `mod.rs` — replace claude_cli with claude_sdk**

In `src-tauri/src/llm/mod.rs`:

```rust
//! LLM 模块 - 负责与 AI 服务通信
//!
//! 支持:
//! - OpenAI 兼容 API (openai_compatible)
//! - Google Gemini 官方 API (gemini_official)
//! - Claude SDK Bridge (claude_sdk)

pub mod client;
pub mod types;
pub mod stream;
pub mod proxy;
pub mod claude_sdk;

pub use client::LlmClient;
pub use types::*;
pub use stream::{stream_chat, LlmStreamCancellation};
pub use proxy::LlmProxy;
```

- [ ] **Step 4: Add `ClaudeSdk` arm to `client.rs`**

In `src-tauri/src/llm/client.rs`, in the `call` method, add the match arm:

```rust
pub async fn call(&self, request: &LlmRequest) -> Result<LlmResponse, String> {
    match request.api_format {
        ApiFormat::OpenaiCompatible => self.call_openai(request).await,
        ApiFormat::GeminiOfficial => self.call_gemini(request).await,
        ApiFormat::ClaudeSdk => {
            Err("ClaudeSdk format should be routed through bridge, not LlmClient".to_string())
        }
    }
}
```

- [ ] **Step 5: Add `ClaudeSdk` arm to `stream.rs`**

In `src-tauri/src/llm/stream.rs`, in `stream_chat`:

```rust
match request.api_format {
    ApiFormat::OpenaiCompatible => stream_openai(app, client, request, cancel_token).await,
    ApiFormat::GeminiOfficial => stream_gemini(app, client, request, cancel_token).await,
    ApiFormat::ClaudeSdk => {
        Err("ClaudeSdk format should be routed through bridge, not stream_chat".to_string())
    }
}
```

- [ ] **Step 6: Update `lib.rs` — route claude_sdk through bridge**

In `src-tauri/src/lib.rs`:

1. Remove all `claude_cli` imports and command registrations
2. Remove `CliSessionManager` state
3. Add `ClaudeSdkManager` state
4. Update `llm_call` and `llm_stream` to route `ClaudeSdk` to bridge

Replace `llm_call`:

```rust
#[tauri::command]
async fn llm_call(
    llm_client: State<'_, LlmState>,
    sdk_manager: State<'_, Arc<llm::claude_sdk::ClaudeSdkManager>>,
    request: LlmRequest,
) -> Result<LlmResponse, String> {
    match request.api_format {
        llm::types::ApiFormat::ClaudeSdk => {
            llm::claude_sdk::call_via_bridge(&sdk_manager, &request).await
        }
        _ => llm_client.call(&request).await,
    }
}
```

Replace `llm_stream`:

```rust
#[tauri::command]
async fn llm_stream(
    app: AppHandle,
    cancellation: State<'_, LlmCancelState>,
    sdk_manager: State<'_, Arc<llm::claude_sdk::ClaudeSdkManager>>,
    request: LlmRequest,
) -> Result<LlmResponse, String> {
    match request.api_format {
        llm::types::ApiFormat::ClaudeSdk => {
            let cancel_token = cancellation.get_token(&request.conversation_id);
            cancellation.reset(&request.conversation_id);
            llm::claude_sdk::stream_via_bridge(app, &sdk_manager, &request, cancel_token).await
        }
        _ => llm::stream_chat(app, request, cancellation.inner().clone()).await,
    }
}
```

In setup, replace CliSessionManager with ClaudeSdkManager:

```rust
// Remove: app.manage(Arc::new(llm::claude_cli::CliSessionManager::new()));
app.manage(Arc::new(llm::claude_sdk::ClaudeSdkManager::new()));
```

Remove from invoke_handler: `llm_claude_cli_call`, `llm_claude_cli_call_with_tools`, `cli_session_start`, `cli_session_tool_result`, `cli_session_close`.

- [ ] **Step 7: Delete `claude_cli.rs`**

```bash
rm src-tauri/src/llm/claude_cli.rs
```

- [ ] **Step 8: Verify Rust compilation**

```bash
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: `Finished` with no errors (warnings OK)

- [ ] **Step 9: Commit**

```bash
git add -A src-tauri/src/llm/
git commit -m "feat: add Claude SDK bridge manager, remove claude_cli"
```

---

### Task 3: JS Adapter + LLM Layer Integration

**Files:**
- Create: `src/utils/llm/adapters/claudeSdk.js`
- Modify: `src/utils/llm/index.js`
- Modify: `src/utils/llm/presets.js`
- Modify: `src/utils/tauri.js`
- Delete: `src/utils/llm/adapters/claudeCli.js`

- [ ] **Step 1: Create `claudeSdk.js` adapter**

Create `src/utils/llm/adapters/claudeSdk.js`:

```javascript
/**
 * Claude SDK Adapter
 *
 * Parallel to openaiCompatible.js and geminiOfficial.js.
 * Routes through Rust sidecar bridge. Returns OpenAI-compatible format
 * so toolExecutor needs zero special handling.
 */

export const capabilities = {
  supportsImage: false,
  supportsVideo: false,
  supportsAudio: false,
  supportsPdf: false,
  supportsDocx: false,
  supportsInlineData: false,
  maxInlineBytes: 0,
};

/**
 * Build request — returns same shape as openaiCompatible adapter
 * so Rust can route it. The key difference: api_format = 'claude_sdk'.
 */
export const buildRequest = async ({ messages, apiFormat, apiKey, model, baseUrl, options = {} }) => {
  // For Claude SDK, we just pass through to Rust which routes to the bridge
  // The bridge handles system prompt extraction and tool injection
  return {
    endpoint: null, // not used — Rust routes to bridge
    headers: {},
    body: {
      model: model || 'sonnet',
      messages,
      tools: options.tools,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: options.stream || false,
    },
  };
};

/**
 * Parse non-streaming response — OpenAI compatible format from bridge
 */
export const parseResponse = (responseJson) => {
  const message = responseJson.choices?.[0]?.message;
  const content = message?.content || '';

  let toolCalls = null;
  if (message?.tool_calls && message.tool_calls.length > 0) {
    toolCalls = message.tool_calls.map(tc => ({
      id: tc.id,
      name: tc.function?.name || tc.name,
      arguments: typeof tc.function?.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : (tc.function?.arguments || tc.arguments || {}),
    }));
  }

  return {
    content,
    toolCalls,
    finishReason: responseJson.choices?.[0]?.finish_reason,
    usage: responseJson.usage,
    raw: responseJson,
  };
};

/**
 * Parse streaming chunk — same as OpenAI format
 */
export const parseStreamChunk = (jsonStr) => {
  try {
    const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    const delta = data.choices?.[0]?.delta;
    if (!delta) return { deltaText: '', deltaToolCalls: null };

    return {
      deltaText: delta.content || '',
      deltaToolCalls: delta.tool_calls || null,
    };
  } catch {
    return { deltaText: '', deltaToolCalls: null };
  }
};

/**
 * Format tool result message — same as OpenAI format
 */
export const formatToolResultMessage = (toolCallId, result) => ({
  role: 'tool',
  tool_call_id: toolCallId,
  content: typeof result === 'string' ? result : JSON.stringify(result),
});

/**
 * Create assistant message with tool calls — same as OpenAI format
 */
export const createAssistantToolCallMessage = (toolCalls) => ({
  role: 'assistant',
  content: null,
  tool_calls: toolCalls.map(tc => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments || {}),
    },
  })),
});

/**
 * Return available models (hardcoded — SDK uses CLI subscription)
 */
export const fetchModels = async () => [
  { id: 'sonnet', name: 'Claude Sonnet' },
  { id: 'opus', name: 'Claude Opus' },
  { id: 'haiku', name: 'Claude Haiku' },
];
```

- [ ] **Step 2: Update `llm/index.js` — add claude_sdk, remove claude_cli**

In `src/utils/llm/index.js`:

Replace import:
```javascript
// Remove: import * as claudeCliAdapter from './adapters/claudeCli.js';
import * as claudeSdkAdapter from './adapters/claudeSdk.js';
```

Update `getAdapter`:
```javascript
const getAdapter = (apiFormat) => {
  if (apiFormat === 'gemini_official') return geminiAdapter;
  if (apiFormat === 'claude_sdk') return claudeSdkAdapter;
  return openaiAdapter;
};
```

Remove the entire `callLLMClaudeCli` function (~35 lines).

Remove the `claude_cli` branch from `callLLMRust`:
```javascript
// Remove: if (apiFormat === 'claude_cli') { return callLLMClaudeCli(...) }
```

Remove the `claude_cli` branch from `callLLMStreamRust`:
```javascript
// Remove: if (apiFormat === 'claude_cli') { ... onChunk ... return result }
```

Update `fetchModels`:
```javascript
export const fetchModels = async ({ apiFormat, apiKey, baseUrl }) => {
  if (apiFormat === 'claude_sdk') return claudeSdkAdapter.fetchModels();
  if (apiFormat === 'gemini_official') return geminiAdapter.fetchModels(apiKey);
  // ... rest unchanged
};
```

- [ ] **Step 3: Update `presets.js`**

In `src/utils/llm/presets.js`, update `getPresetsForFormat`:

```javascript
export const getPresetsForFormat = (apiFormat) => {
  if (apiFormat === 'claude_sdk') return []; // SDK mode needs no URL presets
  if (apiFormat === 'gemini_official') return GEMINI_OFFICIAL_PRESETS;
  return OPENAI_COMPATIBLE_PRESETS;
};
```

- [ ] **Step 4: Update `tauri.js` — remove CLI commands**

In `src/utils/tauri.js`:

Remove these exports:
- `llmClaudeCliCall`
- `llmClaudeCliCallWithTools`
- `cliSessionStart`
- `cliSessionToolResult`
- `cliSessionClose`

Remove the entire "Claude CLI Session API" section.

- [ ] **Step 5: Delete `claudeCli.js` adapter**

```bash
rm src/utils/llm/adapters/claudeCli.js
```

- [ ] **Step 6: Verify syntax**

```bash
node -c src/utils/llm/index.js && node -c src/utils/llm/adapters/claudeSdk.js && node -c src/utils/llm/presets.js && echo "OK"
```

- [ ] **Step 7: Commit**

```bash
git add -A src/utils/llm/ src/utils/tauri.js
git commit -m "feat: add claudeSdk adapter, remove claudeCli adapter and tauri wrappers"
```

---

### Task 4: Remove claude_cli Special Branches

**Files:**
- Modify: `src/utils/mcp/toolExecutor.js`
- Modify: `src/utils/socialAgent.js`
- Modify: `src/utils/socialPromptBuilder.js`

- [ ] **Step 1: Clean up `toolExecutor.js`**

In `src/utils/mcp/toolExecutor.js`:

1. Remove import of `claudeCliAdapter`:
```javascript
// Remove: import * as claudeCliAdapter from '../llm/adapters/claudeCli.js';
```

2. Remove imports of CLI session/call functions:
```javascript
// Remove from import: llmClaudeCliCallWithTools, llmClaudeCliCall, cliSessionStart, cliSessionToolResult, cliSessionClose
```

3. In `callLLMWithTools`, remove the entire `if (apiFormat === 'claude_cli')` block (~120 lines starting around line 516). The function should go straight from initial setup to the `while` loop with no format-specific branching.

4. In `callLLMStreamWithTools`, remove the entire `if (apiFormat === 'claude_cli')` block (~160 lines starting around line 886). Same treatment — straight to the HTTP streaming loop.

5. Update adapter selection in both functions — change `claude_cli` to `claude_sdk`:
```javascript
const adapter = apiFormat === 'claude_sdk' ? claudeSdkAdapter
  : apiFormat === 'gemini_official' ? geminiAdapter
  : openaiAdapter;
```

Add the import at the top:
```javascript
import * as claudeSdkAdapter from '../llm/adapters/claudeSdk.js';
```

- [ ] **Step 2: Clean up `socialAgent.js`**

In `src/utils/socialAgent.js`:

1. Remove `isCliMode` variable and all conditional branches (~lines 2238-2266):

```javascript
// Remove: const isCliMode = intentLLMConfig.apiFormat === 'claude_cli';
// Restore the original unconditional tool construction:

        const intentPlanDefs = getIntentPlanToolDefinitions();
        const intentFileDefs = getSocialFileToolDefinitions().filter(t => ['social_read', 'social_edit', 'social_write'].includes(t.function.name));
        const intentToolDefs = [...intentPlanDefs, ...intentFileDefs, ...getHistoryToolDefinitions(), ...getGroupLogToolDefinitions()];
        let intentMcpTools = intentToolDefs.map(t => ({
          name: t.function.name,
          description: t.function.description,
          inputSchema: t.function.parameters,
          serverName: null,
        }));
        try {
          const allTools = await getMcpTools();
          const extraServers = new Set(promptConfig.enabledMcpServers || []);
          const externalTools = allTools.filter(t =>
            extraServers.has(t.serverName) && t.serverName !== config.mcpServerName
          );
          if (externalTools.length > 0) {
            intentMcpTools = [...intentMcpTools, ...externalTools];
          }
        } catch { /* non-fatal */ }
```

2. Remove the `apiFormat` parameter from the `buildIntentSystemPrompt` call (~line 2318).

- [ ] **Step 3: Clean up `socialPromptBuilder.js`**

In `src/utils/socialPromptBuilder.js`:

1. Remove `apiFormat` from the `buildIntentSystemPrompt` function signature (~line 628).
2. Remove `isCcMode` variable and the entire CC-specific tool description branch (~lines 775-787). Keep only the original unified tool description.

- [ ] **Step 4: Verify syntax**

```bash
node -c src/utils/mcp/toolExecutor.js && node -c src/utils/socialAgent.js && node -c src/utils/socialPromptBuilder.js && echo "OK"
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/mcp/toolExecutor.js src/utils/socialAgent.js src/utils/socialPromptBuilder.js
git commit -m "refactor: remove all claude_cli special branches from toolExecutor, socialAgent, socialPromptBuilder"
```

---

### Task 5: Update UI — Replace CLI with SDK

**Files:**
- Modify: `src/pages/ManagementPage.jsx`

- [ ] **Step 1: Replace `claude_cli` format option with `claude_sdk`**

In `src/pages/ManagementPage.jsx`:

1. Find the API format selector options. Change `claude_cli` value/label to `claude_sdk` / "Claude SDK".

2. Remove `handleTestClaudeCli` function entirely (~lines 889-919).

3. Update `isClaudeCli` variable to `isClaudeSdk`:
```javascript
const isClaudeSdk = formData.apiFormat === 'claude_sdk';
```

4. Update all references from `isClaudeCli` to `isClaudeSdk`.

5. Update the test button: for `claude_sdk`, use the standard `handleTestConnection` flow (which will go through `llmCall` → Rust → bridge). Or create a simple ping test:
```javascript
const handleTestClaudeSdk = async () => {
  setTesting(true);
  setTestResult(null);
  try {
    // Simple test: call LLM with a trivial prompt
    const { callLLM } = await import('../utils/llm/index.js');
    const response = await callLLM({
      messages: [{ role: 'user', content: '1+1=?' }],
      apiFormat: 'claude_sdk',
      model: 'haiku',
    });
    if (response.content && !response.error) {
      setTestResult(`✓ Claude SDK 连接成功！\n回复: ${response.content.trim().substring(0, 100)}`);
      setTestSuccess(true);
      // Auto-fetch models
      const models = await fetchModels(null, null, 'claude_sdk');
      if (models?.length > 0) {
        setFetchedModels(models.map(m => typeof m === 'object' ? m.id : m));
      }
    } else {
      setTestResult(`✗ 回复异常: ${response.content || '(空)'}`);
    }
  } catch (error) {
    setTestResult(`✗ Claude SDK 测试失败: ${error?.message || error}`);
  } finally {
    setTesting(false);
  }
};
```

6. Remove the old `handleTestClaudeCli` button and wire up the new one for `isClaudeSdk`.

- [ ] **Step 2: Auto-fill behavior**

When `claude_sdk` is selected:
- Set `name` to "Claude SDK"
- Set `baseUrl` to "claude_sdk" (placeholder)
- Set `apiKey` to "claude_sdk" (placeholder)
- Hide Base URL and API Key input fields (same as old CLI behavior)

- [ ] **Step 3: Verify syntax**

```bash
node -c src/pages/ManagementPage.jsx && echo "OK"
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/ManagementPage.jsx
git commit -m "feat: replace Claude CLI UI with Claude SDK in ManagementPage"
```

---

### Task 6: Delete Remaining claude_cli Artifacts

**Files:**
- Delete: `src-tauri/tests/claude_cli_proxy.rs` (if exists)
- Modify: any remaining references

- [ ] **Step 1: Search for remaining `claude_cli` references**

```bash
grep -r "claude_cli" --include="*.js" --include="*.jsx" --include="*.rs" --include="*.ts" -l
```

Delete or update any remaining references.

- [ ] **Step 2: Remove test file if present**

```bash
rm -f src-tauri/tests/claude_cli_proxy.rs
```

- [ ] **Step 3: Final compilation and syntax checks**

```bash
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
node -c src/utils/llm/index.js
node -c src/utils/mcp/toolExecutor.js
node -c src/utils/socialAgent.js
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove all remaining claude_cli references"
```

---

### Task 7: End-to-End Verification

- [ ] **Step 1: Restart dev server**

```bash
npm run tauri:dev
```

- [ ] **Step 2: Test bridge sidecar starts**

Check Rust logs for: `[ClaudeSdk] Spawning bridge`

- [ ] **Step 3: Test chat (no tools)**

Create a new API provider with format "Claude SDK", test connection, open new conversation, send "hello". Verify text response.

- [ ] **Step 4: Test tool calling (chat)**

In conversation, ask to check QQ status. Verify tool_call is detected and executed.

- [ ] **Step 5: Test social agent Intent**

Set social agent Intent model to Claude SDK sonnet. Start agent. Verify:
- `social_edit` + `write_intent_plan` tools execute normally
- No `claude_cli` errors in logs
- Time from eval start to result is ~20-30s

- [ ] **Step 6: Test OpenAI/Gemini unaffected**

Switch to Gemini model, verify social agent and chat work identically to before.

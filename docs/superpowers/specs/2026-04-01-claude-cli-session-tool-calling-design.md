# Claude CLI Session-based Tool Calling (B2)

## Summary

Enable native function calling for Claude CLI adapter by keeping the CLI process alive across tool call rounds. Uses a session-based multi-command pattern over Tauri IPC.

## Architecture

```
toolExecutor.js (JS)                    claude_cli.rs (Rust)                 CLI Process
      |                                       |                                |
      +-- cli_session_start(msgs,tools) ----->|-- spawn claude -p stream-json ->|
      |                                       |<-- read events, collect calls --|
      |<-- { session_id, tool_calls } --------|   (process stays alive)         |
      |                                       |                                |
      +-- execute tools, get results          |                                |
      |                                       |                                |
      +-- cli_session_tool_result(id,res) --->|-- write tool_result to stdin -->|
      |                                       |<-- read next round events ------|
      |<-- { text/tool_calls/done } ----------|                                |
      |                                       |                                |
      +-- (repeat until done)                 |                                |
      |                                       |                                |
      +-- cli_session_close(id) ------------>|-- kill process, cleanup -------->|
```

## Rust Side (`src-tauri/src/llm/claude_cli.rs`)

### State Management

- `CliSession` struct: holds `stdin: ChildStdin`, `reader: BufReader<ChildStdout>`, `accumulated_text: String`
- `CliSessionManager`: `Arc<Mutex<HashMap<String, CliSession>>>`, injected as Tauri State
- Session ID: UUID v4

### New Tauri Commands

#### `cli_session_start`

**Input:** `messages: Vec<Value>`, `model: Option<String>`, `system_prompt: Option<String>`, `tools: Option<Vec<Value>>`

**Behavior:**
1. Spawn `claude -p --input-format stream-json --output-format stream-json --verbose --max-turns 0` (max-turns 0 = don't auto-execute tools)
2. If tools provided, convert OpenAI format to Anthropic tool definitions and pass via stdin as part of the initial configuration
3. Write `user_message` event to stdin with serialized messages
4. Read event stream until: tool_use blocks collected OR message ends (end_turn)
5. Store session in HashMap
6. Return `{ session_id, result: { text, tool_calls, done } }`

#### `cli_session_tool_result`

**Input:** `session_id: String`, `tool_results: Vec<Value>` (array of `{ tool_use_id, content }`)

**Behavior:**
1. Find session by ID (error if not found)
2. Write `tool_result` events to stdin for each result
3. Read event stream until next tool_use or end_turn
4. Return `{ result: { text, tool_calls, done } }`

#### `cli_session_close`

**Input:** `session_id: String`

**Behavior:**
1. Find session, kill child process
2. Remove from HashMap

### Event Stream Parsing

Shared `read_until_turn_end()` function that reads stdout line by line:

- `content_block_start` with `type=tool_use` -> start new tool call (capture id, name)
- `content_block_delta` with `type=input_json_delta` -> accumulate partial_json
- `content_block_stop` -> finalize tool call, parse accumulated JSON as arguments
- `content_block_delta` with `type=text_delta` -> accumulate text content
- `message_stop` / `result` -> turn complete, set done=true

Return format (Rust -> JS):
```json
{
  "text": "optional text content",
  "tool_calls": [
    { "id": "toolu_01X", "name": "send_message", "arguments": { ... } }
  ],
  "done": false
}
```

When `done=true`, `tool_calls` is empty/null.

### Timeouts & Cleanup

- 180s timeout per `read_until_turn_end()` call
- On timeout: kill process, remove session, return error
- No idle timeout needed (JS side always calls close in finally block)

## JS Side

### `tauri.js` — New Exports

```js
export const cliSessionStart = (messages, model, systemPrompt, tools) =>
  invoke('cli_session_start', { messages, model, systemPrompt, tools });

export const cliSessionToolResult = (sessionId, toolResults) =>
  invoke('cli_session_tool_result', { sessionId, toolResults });

export const cliSessionClose = (sessionId) =>
  invoke('cli_session_close', { sessionId });
```

### `toolExecutor.js` — claude_cli Branch

Replace current simple-mode fallback with session-based loop:

```
if (apiFormat === 'claude_cli') {
  let sessionId = null;
  try {
    // Extract system prompt from messages
    const { systemPrompt, otherMessages } = extractSystemPrompt(currentMessages);

    // Start session
    const startResult = await cliSessionStart(otherMessages, model, systemPrompt, llmTools);
    sessionId = startResult.session_id;
    let turnResult = startResult.result;

    // Process text
    if (turnResult.text) {
      fullContent += turnResult.text;
      onChunk?.(turnResult.text, fullContent);
    }

    // Tool call loop
    while (turnResult.tool_calls?.length > 0 && !turnResult.done) {
      // Execute each tool call (reuse existing MCP/builtin dispatch)
      const toolResults = [];
      for (const call of turnResult.tool_calls) {
        // ... existing tool execution logic (filter, transform, execute) ...
        toolResults.push({ tool_use_id: call.id, content: resultString });
      }

      // Send results back
      turnResult = (await cliSessionToolResult(sessionId, toolResults)).result;

      // Process new text
      if (turnResult.text) {
        fullContent += turnResult.text;
        onChunk?.(turnResult.text, fullContent);
      }
    }
  } finally {
    if (sessionId) await cliSessionClose(sessionId).catch(() => {});
  }
}
```

Key: all existing tool execution logic (stopAfterTool, toolCallFilter, toolArgTransform, MCP/builtin dispatch) is reused within the loop.

## Files Changed

1. `src-tauri/src/llm/claude_cli.rs` — Add CliSession, CliSessionManager, 3 new commands, event parser
2. `src-tauri/src/llm/mod.rs` — Export new types
3. `src-tauri/src/lib.rs` — Register new commands, add CliSessionManager state
4. `src/utils/tauri.js` — Add 3 new invoke wrappers
5. `src/utils/mcp/toolExecutor.js` — Replace claude_cli branch with session loop

## Not Changed

- `claudeCli.js` adapter — not needed, Rust returns standardized format directly
- OpenAI/Gemini paths — completely untouched
- Tool execution logic — reused as-is
- Social agent — inherits support automatically via toolExecutor

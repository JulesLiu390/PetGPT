# Claude SDK Adapter — 第三种 API 格式

## Summary

新增 `claude_sdk` 作为与 `openai_compatible`、`gemini_official` 完全平行的第三种 API 格式。通过 Node.js sidecar 运行 `@anthropic-ai/claude-agent-sdk`，消除 CLI subprocess 开销。同时撤销所有 `claude_cli` 在 socialAgent、toolExecutor 等模块中的特殊分支，让 `claude_sdk` 走统一的通用路径。

## 目标

1. `claude_sdk` 与 OpenAI/Gemini 走完全相同的代码路径——不需要任何 `if (apiFormat === 'claude_sdk')` 特殊分支
2. 速度：消除 CLI spawn 开销（每轮 ~12s → ~0s），只有 API 推理时间
3. 原生工具调用：通过 Bridge 使用 SDK 的工具系统，不用 prompt 模拟
4. 流式支持：聊天界面逐字显示
5. 完全删除 `claude_cli` 格式——所有相关代码、adapter、Rust commands 全部移除

## 架构

```
LLM 抽象层 (llm/index.js)
  ├─ openai_compatible  → Rust llm_call/llm_stream → HTTP fetch → API
  ├─ gemini_official    → Rust llm_call/llm_stream → HTTP fetch → API
  └─ claude_sdk (新)    → Rust llm_call/llm_stream → stdin/stdout → Bridge sidecar → Agent SDK
```

Bridge sidecar 对 Rust 来说就是另一个 "API endpoint"——Rust 收到 LLM 请求后，不走 HTTP，走 stdin/stdout 发给 sidecar。但对 JS 层完全透明：adapter 构建的请求格式和解析的响应格式与 OpenAI 一致。

## 组件设计

### 1. Bridge Sidecar (`src-tauri/sidecars/claude-sdk-bridge.mjs`)

常驻 Node.js 进程。协议：逐行 JSON via stdin/stdout。

**请求格式（Rust → Bridge）：**
```json
{
  "id": "req_123",
  "method": "llm_call",
  "params": {
    "messages": [...],
    "model": "sonnet",
    "system_prompt": "...",
    "tools": [...],
    "temperature": 0.7,
    "max_tokens": 4096,
    "stream": false
  }
}
```

**非流式响应（Bridge → Rust）：**
```json
{
  "id": "req_123",
  "result": {
    "content": "回复文本",
    "tool_calls": [
      {"id": "call_1", "name": "QQ__check_status", "arguments": {}}
    ],
    "usage": {"input_tokens": 100, "output_tokens": 50},
    "finish_reason": "tool_use"
  }
}
```

**流式响应（Bridge → Rust，多行）：**
```json
{"id": "req_123", "stream": {"type": "delta", "text": "你"}}
{"id": "req_123", "stream": {"type": "delta", "text": "好"}}
{"id": "req_123", "stream": {"type": "tool_call_start", "id": "call_1", "name": "send_message"}}
{"id": "req_123", "stream": {"type": "tool_call_delta", "id": "call_1", "arguments_delta": "{\"text\":"}}
{"id": "req_123", "stream": {"type": "tool_call_end", "id": "call_1"}}
{"id": "req_123", "result": {"content": "你好", "tool_calls": [...], "usage": {...}, "finish_reason": "tool_use"}}
```

**工具结果提交（Rust → Bridge）：**
多轮工具调用时，Rust 不需要管理 session。Bridge 内部维护对话状态：
```json
{
  "id": "req_124",
  "method": "tool_result",
  "params": {
    "conversation_id": "conv_abc",
    "tool_results": [
      {"tool_use_id": "call_1", "content": "QQ 在线"}
    ]
  }
}
```

Bridge 内部用 SDK 的 `ClaudeSDKClient`（有状态）来维护多轮会话。

**工具定义转换：** Bridge 接收 OpenAI 格式的 tools，内部转换为 SDK 的 `tool()` 定义。这样 JS adapter 不需要做特殊格式转换。

### 2. Rust 管理层 (`src-tauri/src/llm/claude_sdk.rs`)

新模块。管理 sidecar 生命周期 + 请求代理。

**生命周期：**
- Lazy spawn：第一次收到 `claude_sdk` 格式的 LLM 请求时启动
- Health check：发 `ping` 请求，3s 无响应则重启
- 自动重启：进程异常退出时自动重启
- App 关闭时 graceful shutdown

**请求代理：**
- 非流式：写 JSON 到 stdin，读一行 JSON 响应
- 流式：写 JSON 到 stdin，逐行读取 stream 事件，通过 `app.emit()` 推送前端
- 超时：单次请求 180s

**集成到现有 LLM 路径：**
修改 `llm_call` 和 `llm_stream` Tauri command：当 `api_format === "claude_sdk"` 时，不走 HTTP client，走 sidecar proxy。对前端 JS 完全透明。

### 3. JS Adapter (`src/utils/llm/adapters/claudeSdk.js`)

与 `openaiCompatible.js` 几乎相同，因为 Bridge 返回的就是 OpenAI 兼容格式。

**区别点：**
- `capabilities`: 按 SDK 实际支持设置（图片支持等）
- `buildRequest`: 返回 `api_format: 'claude_sdk'`（让 Rust 路由到 sidecar）
- `fetchModels`: 返回预设列表（sonnet/opus/haiku）
- `parseResponse` / `parseStreamChunk`: 与 OpenAI adapter 相同（Bridge 输出 OpenAI 兼容格式）

### 4. UI (`ManagementPage.jsx`)

- API 格式下拉：将 "Claude CLI" 替换为 "Claude SDK"（`claude_sdk`）
- 选择时：隐藏 API Key 和 Base URL 输入（不需要）
- Test 按钮：调用 sidecar health check
- 删除 `handleTestClaudeCli` 函数和相关 UI
- 删除旧的 `claude_cli` 格式选项

## 撤销清单 — 消除 `claude_cli` 特殊分支

以下特殊处理需要撤销，让 `claude_sdk` 走通用路径：

### toolExecutor.js（最大改动）
- **删除** `callLLMWithTools` 里的整个 `if (apiFormat === 'claude_cli')` session 分支（~120 行）
- **删除** `callLLMStreamWithTools` 里的整个 `if (apiFormat === 'claude_cli')` session 分支（~160 行）
- `claude_sdk` 走跟 OpenAI 一样的 HTTP/proxy 路径（Rust 内部路由到 sidecar）
- 移除 `cliSessionStart/ToolResult/Close` 的 import

### llm/index.js
- **删除** `callLLMRust` 里的 `if (apiFormat === 'claude_cli')` 分支
- **删除** `callLLMStreamRust` 里的 `if (apiFormat === 'claude_cli')` 分支
- **删除** `callLLMClaudeCli` 函数
- `claude_sdk` 走正常的 `llmCall`/`llmStream` → Rust 内部路由

### socialAgent.js
- **删除** `isCliMode` 变量和所有相关条件分支
- CC 模式的工具集过滤和 MCP 跳过全部撤销
- `claude_sdk` 跟 OpenAI/Gemini 一样拿到完整工具集

### socialPromptBuilder.js
- **删除** `isCcMode` 变量和条件分支
- 工具描述恢复为统一版本（不再区分 CC 和非 CC）

### Rust claude_cli.rs
- **完全删除**整个模块文件
- 删除 `mod.rs` 中的 `pub mod claude_cli` 声明
- 删除 `lib.rs` 中所有 `claude_cli` command 注册和 `CliSessionManager` state

### Rust lib.rs / llm_call / llm_stream
- 新增 `claude_sdk` 路由分支：检测 `api_format`，走 sidecar proxy 而非 HTTP
- 移除所有 `claude_cli` 相关注册

## 依赖

- `@anthropic-ai/claude-agent-sdk` — npm 依赖，安装到项目根目录
- Node.js — 运行 sidecar（用户机器上已有，因为 dev 环境就是 Node）

## 不改动的部分

- OpenAI / Gemini 路径 — 完全不受影响
- MCP 工具系统 — 不变
- 数据库 schema — `api_format` 字段已是 string，直接存 `claude_sdk`
- workspace 文件系统 — 不变

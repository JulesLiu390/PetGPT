# CC Subagent 设计规格

> 为 PetGPT 社交 agent 添加 Claude Code CLI subagent 功能，实现异步并行的后台任务执行。

## 概述

Intent 循环在评估中发现需要外部信息（查资料、分析内容等）时，通过 `dispatch_subagent` 工具发起后台任务。每个任务由一个独立的 Claude Code CLI 进程执行，拥有自己的隔离 workspace，完成后通过文件传递结果。

### 核心原则

- **Subagent 是纯任务执行者** — 只接收明确任务指令，不注入社交上下文、聊天记录、人物档案
- **上下文整合是 Intent 的责任** — Intent 拿到原始结果后自己决定如何融入对话
- **异步非阻塞** — fire-and-forget，不阻塞任何循环
- **并行** — 多个 subagent 可同时运行，不同任务/不同 target 互不干扰

---

## 1. Workspace 结构

```
workspace/{petId}/subagents/
├── task_{id}/
│   ├── CLAUDE.md          ← JS 自动生成的任务指令
│   └── output/
│       └── result.md      ← CC 写入的交付物
```

### CLAUDE.md 模板

JS 端根据 `dispatch_subagent` 参数生成：

```markdown
# Task

{task_description}

## Output

把结果写入 output/result.md。完成后直接退出。

## Constraints
- 结果控制在 {maxLen} 字以内
- 只输出最终结果，不要输出思考过程
- 用中文
```

### CC 启动参数与沙箱隔离

```bash
claude -p \
  --model {subagentModel} \
  --bare \
  --tools "Read,Write,WebSearch,WebFetch" \
  --strict-mcp-config \
  --no-session-persistence \
  "按照 CLAUDE.md 里的任务执行"
```

沙箱约束：

| 参数 | 作用 |
|------|------|
| `--bare` | 跳过 hooks、LSP、全局 CLAUDE.md 自动发现、keychain 读取、auto-memory — 完全隔离于用户环境 |
| `--tools "Read,Write,WebSearch,WebFetch"` | 白名单：只能读写文件 + 搜索/抓取网页。无 Bash、无 git、无 Agent、无 Edit |
| `--strict-mcp-config` | 不加载用户配置的任何 MCP server（不会连到 QQ、GitHub 等用户线上服务） |
| `--no-session-persistence` | 不保存会话到磁盘，用完即丢 |
| CWD = subagent workspace | `Read`/`Write` 限定在 `subagents/task_{id}/` 目录内 |

这确保 subagent：
- 无法访问用户文件系统的其他目录
- 无法执行任意 shell 命令
- 无法访问用户的 GitHub、QQ 等线上账户
- 无法读取用户的 API key 或 keychain
- 只能用 web search 获取公开信息

### 生命周期

1. JS 创建 `subagents/task_{id}/` 目录 + 写入 CLAUDE.md
2. 调用 Rust `subagent_spawn(taskId, cwd)`
3. Rust spawn CC 进程（使用上述沙箱参数），注册到进程池
4. CC 自然退出 → Rust 发 Tauri event `subagent-done`
5. 或兜底超时（默认 5min）→ Rust kill 进程 → 发 `subagent-timeout` event
6. JS 收到 event → 读 `output/result.md` → 写入主 workspace scratch 文件 → wake Intent → 清理 subagent 目录

---

## 2. Rust 端：进程池管理

### 新模块

`src-tauri/src/subagent/mod.rs`

### 状态结构

```rust
pub struct SubagentPool {
    semaphore: Semaphore,                              // 并发上限（默认 5，可配置）
    processes: Mutex<HashMap<String, SubagentProcess>>, // taskId → process info
}

struct SubagentProcess {
    pid: u32,
    kill_handle: JoinHandle<()>,  // 兜底超时 kill 的 tokio task
}
```

### Tauri Commands

| Command | 参数 | 说明 |
|---------|------|------|
| `subagent_spawn` | `task_id, cwd, timeout_secs=300` | 获取 semaphore permit → spawn `claude -p --model sonnet` 以 cwd 为工作目录 → 注册进程 → 启动超时 watch task → 返回 ok |
| `subagent_kill` | `task_id` | 手动 kill 某个 subagent（Intent 决定取消时用） |
| `subagent_set_max_concurrent` | `n` | 动态调整并发上限 |

### Tauri Events（Rust → JS）

| Event | Payload | 触发时机 |
|-------|---------|----------|
| `subagent-done` | `{ taskId, exitCode }` | CC 进程正常退出 |
| `subagent-timeout` | `{ taskId }` | 兜底超时被 kill |
| `subagent-error` | `{ taskId, error }` | spawn 失败（如 claude 命令不存在） |

Semaphore permit 在进程退出/超时/spawn失败时均立即释放。

---

## 3. JS 端：调度与状态追踪

### 全局状态

在 `socialAgent.js` 中：

```js
const subagentRegistry = new Map();
// taskId → { status, task, target, targetType, outputPath, createdAt }
// status: 'running' | 'done' | 'failed' | 'timeout'
```

### `dispatch_subagent` Builtin Tool

在 `socialToolExecutor.js` 中新增 handler。

**Intent 调用方式：**
```
dispatch_subagent(task="查一下 Therac-25 事故经过，200字总结", maxLen=200)
```

**Handler 流程：**
1. 生成 taskId（`sa_` + nanoid）
2. 通过 `workspaceWrite` 创建 `subagents/task_{id}/CLAUDE.md`（自动创建目录）
3. 调用 Rust `subagent_spawn(taskId, cwd)`
4. 注册到 `subagentRegistry`
5. 返回 `{ taskId, status: 'dispatched' }` 给 LLM

### Event 监听

Agent 启动时注册 Tauri event 监听：

- **`subagent-done`**：
  1. 读 `subagents/task_{id}/output/result.md`
  2. 写入 `social/{dir}/scratch_{target}/subagent_{taskId}.md`
  3. 标记 registry status = 'done'
  4. 清理 subagent workspace 目录
  5. Wake Intent（`_wake()`）

- **`subagent-timeout`**：
  1. 标记 registry status = 'timeout'
  2. 清理 subagent workspace 目录
  3. Wake Intent

- **`subagent-error`**：
  1. 标记 registry status = 'failed'，记录 error
  2. 清理 subagent workspace 目录
  3. Wake Intent

### Agent 停止时

Kill 所有 running subagents（调用 `subagent_kill`），清空 registry。

---

## 4. Intent Prompt 集成

### 4a. 工具定义

在 `buildIntentSystemPrompt()` 的工具列表中新增：

```
dispatch_subagent(task, maxLen=500)
  发起一个后台研究任务。task 是明确的任务描述，CC 会自主完成（可能用 web search 等工具）。
  结果会异步写入 scratch 文件，你在后续 eval 中用 social_read 读取。
  返回 taskId。发起后请 write_intent_plan(actions=[]) 等待结果。
```

### 4b. 状态注入

在 Intent system prompt 末尾，动态拼入当前 target 的 subagent 状态：

```
## 后台任务状态
- ✅ sa_a1b2c3: "查 Therac-25 事故经过" → 已完成，结果在 social/group/scratch_902317662/subagent_sa_a1b2c3.md
- ⏳ sa_d4e5f6: "对比 Rust async trait 和 Go interface" → 执行中 (已耗时 15s)
- ❌ sa_g7h8i9: "查 XXX" → 失败 (进程异常退出)
```

规则：
- 只列出当前 target 的 subagent 状态
- 已完成且 Intent 已通过 `social_read` 读取过的条目，在下轮清除
- 无 subagent 时不注入此段

### 4c. Intent 使用模式

1. eval → 发现需要查资料 → `dispatch_subagent(task=...)` → `write_intent_plan(actions=[])`
2. CC 完成 → event → 写入 scratch → **wake Intent**
3. Intent 立即被唤起 → 看到 "✅ 已完成" → `social_read(结果文件)` → 融入判断 → `write_intent_plan(actions=[reply])`

失败/超时同理 — 立刻 wake Intent，它看到 ❌ 状态并自行决策（重试或放弃）。

---

## 5. 配置

在 SocialPage 的 config 中新增：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `subagentMaxConcurrent` | number | 5 | 全局最大并发 subagent 数 |
| `subagentTimeoutSecs` | number | 300 | 兜底超时秒数 |
| `subagentModel` | string | `'sonnet'` | CC subagent 使用的模型 |
| `subagentEnabled` | boolean | `true` | 是否启用 subagent 功能 |

---

## 6. 日志

使用现有 `addLog` 机制：

| 时机 | level | 示例 |
|------|-------|------|
| 任务发起 | `intent` | `🚀 subagent dispatched: sa_a1b2c3 "查 Therac-25 事故"` |
| 任务完成 | `info` | `✅ subagent done: sa_a1b2c3 (32s, 180字)` |
| 任务超时 | `warn` | `⏰ subagent timeout: sa_a1b2c3 (300s)` |
| 任务失败 | `error` | `❌ subagent error: sa_a1b2c3: claude command not found` |
| Intent 消费结果 | `intent` | `📖 subagent result consumed: sa_a1b2c3` |

---

## 7. 文件改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/subagent/mod.rs` | 新增 | SubagentPool + Tauri commands + events |
| `src-tauri/src/lib.rs` | 编辑 | 注册 SubagentPool state + commands |
| `src/utils/tauri.js` | 编辑 | 新增 invoke wrappers |
| `src/utils/workspace/socialToolExecutor.js` | 编辑 | 新增 `dispatch_subagent` handler |
| `src/utils/socialAgent.js` | 编辑 | subagentRegistry + event 监听 + 停止清理 |
| `src/utils/socialPromptBuilder.js` | 编辑 | Intent 工具定义 + 状态注入 |
| `src/pages/SocialPage.jsx` | 编辑 | config 新增 subagent 相关字段 |

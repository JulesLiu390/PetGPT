# CC Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude Code CLI subagent support so the social agent's Intent loop can dispatch async background research tasks to isolated CC processes, with results flowing back through workspace files.

**Architecture:** Rust manages a process pool (tokio Semaphore + HashMap) that spawns sandboxed CC CLI processes and emits Tauri events on completion/timeout/error. JS manages workspace preparation, state tracking (subagentRegistry Map), event listening, and Intent prompt injection. Communication is file-based: CC writes `output/result.md`, JS copies to scratch files, wakes Intent.

**Tech Stack:** Rust (tokio process/sync), Tauri events, existing workspace file I/O, socialAgent.js async patterns.

---

### Task 1: Rust SubagentPool module

**Files:**
- Create: `src-tauri/src/subagent/mod.rs`

- [ ] **Step 1: Create the subagent module directory**

```bash
mkdir -p src-tauri/src/subagent
```

- [ ] **Step 2: Write `src-tauri/src/subagent/mod.rs`**

```rust
//! CC Subagent 进程池管理
//!
//! 为前端 social agent 提供 Claude Code CLI 子进程的生命周期管理：
//! - tokio Semaphore 限制并发数（默认 5，可动态调整）
//! - 兜底超时自动 kill（默认 300s）
//! - Tauri event 通知前端进程状态变化

use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinHandle;
use tauri::{AppHandle, Emitter};
use serde::Serialize;

/// Tauri event payloads
#[derive(Clone, Serialize)]
struct SubagentDonePayload {
    #[serde(rename = "taskId")]
    task_id: String,
    #[serde(rename = "exitCode")]
    exit_code: Option<i32>,
}

#[derive(Clone, Serialize)]
struct SubagentErrorPayload {
    #[serde(rename = "taskId")]
    task_id: String,
    error: String,
}

#[derive(Clone, Serialize)]
struct SubagentTimeoutPayload {
    #[serde(rename = "taskId")]
    task_id: String,
}

struct SubagentProcess {
    /// Handle to the timeout-kill task (abort this on normal exit)
    timeout_handle: JoinHandle<()>,
    /// Handle to the wait-for-exit task (abort this on kill)
    wait_handle: JoinHandle<()>,
}

pub struct SubagentPool {
    semaphore: Arc<Semaphore>,
    max_concurrent: Mutex<usize>,
    processes: Mutex<HashMap<String, SubagentProcess>>,
}

const DEFAULT_MAX_CONCURRENT: usize = 5;

impl SubagentPool {
    pub fn new() -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(DEFAULT_MAX_CONCURRENT)),
            max_concurrent: Mutex::new(DEFAULT_MAX_CONCURRENT),
            processes: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for SubagentPool {
    fn default() -> Self {
        Self::new()
    }
}

/// Spawn a CC CLI subagent process in the given working directory.
///
/// Acquires a semaphore permit, spawns `claude -p` with sandbox flags,
/// and starts a background task that emits events on exit or timeout.
#[tauri::command]
pub async fn subagent_spawn(
    pool: tauri::State<'_, Arc<SubagentPool>>,
    app: AppHandle,
    task_id: String,
    cwd: String,
    model: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<(), String> {
    let timeout = timeout_secs.unwrap_or(300);
    let model_arg = model.unwrap_or_else(|| "sonnet".to_string());

    // Check if task_id already exists
    {
        let procs = pool.processes.lock().await;
        if procs.contains_key(&task_id) {
            return Err(format!("Subagent task_id '{}' already exists", task_id));
        }
    }

    // Acquire semaphore permit (waits if at capacity)
    let permit = pool.semaphore.clone().acquire_owned().await
        .map_err(|e| format!("Semaphore error: {}", e))?;

    // Spawn the CC CLI process
    let mut child = Command::new("claude")
        .arg("-p")
        .arg("--model").arg(&model_arg)
        .arg("--bare")
        .arg("--tools").arg("Read,Write,WebSearch,WebFetch")
        .arg("--strict-mcp-config")
        .arg("--no-session-persistence")
        .arg("按照 CLAUDE.md 里的任务执行")
        .current_dir(&cwd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            drop(permit);
            let _ = app.emit("subagent-error", SubagentErrorPayload {
                task_id: task_id.clone(),
                error: format!("Failed to spawn claude: {}", e),
            });
            format!("Failed to spawn claude: {}", e)
        })?;

    let pid = child.id();
    let task_id_wait = task_id.clone();
    let task_id_timeout = task_id.clone();
    let app_wait = app.clone();
    let app_timeout = app.clone();
    let pool_arc_wait = pool.inner().clone();
    let pool_arc_timeout = pool.inner().clone();

    // Background task: wait for process exit
    let wait_handle = tokio::spawn(async move {
        let _permit = permit; // hold permit until process exits
        let status = child.wait().await;
        let exit_code = status.ok().and_then(|s| s.code());

        // Remove from processes map and cancel timeout
        let mut procs = pool_arc_wait.processes.lock().await;
        if let Some(proc) = procs.remove(&task_id_wait) {
            proc.timeout_handle.abort();
        }

        let _ = app_wait.emit("subagent-done", SubagentDonePayload {
            task_id: task_id_wait,
            exit_code,
        });
    });

    // Background task: timeout kill
    let timeout_handle = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(timeout)).await;

        // Timeout reached — kill the process
        let mut procs = pool_arc_timeout.processes.lock().await;
        if let Some(proc) = procs.remove(&task_id_timeout) {
            proc.wait_handle.abort();
        }

        // Try to kill by PID (best-effort)
        if let Some(id) = pid {
            #[cfg(unix)]
            {
                unsafe { libc::kill(id as i32, libc::SIGKILL); }
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &id.to_string(), "/F"])
                    .output()
                    .await;
            }
        }

        let _ = app_timeout.emit("subagent-timeout", SubagentTimeoutPayload {
            task_id: task_id_timeout,
        });
    });

    // Register in process map
    {
        let mut procs = pool.processes.lock().await;
        procs.insert(task_id, SubagentProcess {
            timeout_handle,
            wait_handle,
        });
    }

    Ok(())
}

/// Kill a specific subagent by task_id.
#[tauri::command]
pub async fn subagent_kill(
    pool: tauri::State<'_, Arc<SubagentPool>>,
    app: AppHandle,
    task_id: String,
) -> Result<(), String> {
    let mut procs = pool.processes.lock().await;
    if let Some(proc) = procs.remove(&task_id) {
        proc.wait_handle.abort();
        proc.timeout_handle.abort();
        let _ = app.emit("subagent-error", SubagentErrorPayload {
            task_id,
            error: "Killed by user".to_string(),
        });
        Ok(())
    } else {
        Err(format!("No active subagent with task_id '{}'", task_id))
    }
}

/// Dynamically adjust the max concurrent subagent count.
#[tauri::command]
pub async fn subagent_set_max_concurrent(
    pool: tauri::State<'_, Arc<SubagentPool>>,
    n: usize,
) -> Result<(), String> {
    if n == 0 {
        return Err("Max concurrent must be > 0".to_string());
    }
    let mut current = pool.max_concurrent.lock().await;
    if n > *current {
        pool.semaphore.add_permits(n - *current);
    }
    // Note: reducing below current isn't directly supported by tokio Semaphore,
    // but the effective limit will converge as permits are returned.
    *current = n;
    Ok(())
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd src-tauri && cargo check
```

Expected: compiles with no errors (warnings about unused are OK since commands aren't registered yet).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/subagent/mod.rs
git commit -m "feat(subagent): add Rust SubagentPool with spawn/kill/set_max_concurrent"
```

---

### Task 2: Register SubagentPool in Tauri app

**Files:**
- Modify: `src-tauri/src/lib.rs:1-17` (mod + use declarations)
- Modify: `src-tauri/src/lib.rs:32-53` (type alias)
- Modify: `src-tauri/src/lib.rs:2200-2224` (state init)
- Modify: `src-tauri/src/lib.rs:2646-2668` (command registration)

- [ ] **Step 1: Add module declaration and type alias**

At `src-tauri/src/lib.rs` line 6 (after `mod workspace;`), add:

```rust
mod subagent;
```

After the existing type aliases (around line 47), add:

```rust
type SubagentPoolState = Arc<subagent::SubagentPool>;
```

- [ ] **Step 2: Initialize SubagentPool state**

After the `app.manage(workspace_engine)` block (around line 2224), add:

```rust
// Initialize subagent pool (CC CLI 子进程管理)
let subagent_pool: SubagentPoolState = Arc::new(subagent::SubagentPool::new());
app.manage(subagent_pool);
```

- [ ] **Step 3: Register Tauri commands**

In the `.invoke_handler(tauri::generate_handler![...])` block, after `workspace::workspace_open_file,` (line 2667), add:

```rust
// Subagent commands
subagent::subagent_spawn,
subagent::subagent_kill,
subagent::subagent_set_max_concurrent,
```

- [ ] **Step 4: Verify compilation**

```bash
cd src-tauri && cargo check
```

Expected: compiles successfully. Warnings about `libc` not found on macOS — we need to handle the unix kill differently. The `libc` crate is only in Linux deps. Fix: use `nix` or just `Command::new("kill")` on unix. Actually, `tokio::process::Child` has a `kill()` method — but we only have the PID at timeout time since the child is moved into the wait task. Let's use `std::process::Command` for the kill:

In `subagent/mod.rs`, replace the unix kill block:
```rust
#[cfg(unix)]
{
    let _ = std::process::Command::new("kill")
        .args(["-9", &id.to_string()])
        .output();
}
```

- [ ] **Step 5: Verify again and commit**

```bash
cd src-tauri && cargo check
git add src-tauri/src/lib.rs src-tauri/src/subagent/mod.rs
git commit -m "feat(subagent): register SubagentPool in Tauri app"
```

---

### Task 3: JS Tauri wrappers for subagent commands

**Files:**
- Modify: `src/utils/tauri.js:757-759` (after workspaceGetPath)

- [ ] **Step 1: Add subagent invoke wrappers**

After the `workspaceGetPath` function (around line 759), add:

```js
// ==================== Subagent (CC CLI 子进程) ====================

/**
 * Spawn a CC CLI subagent process
 * @param {string} taskId - Unique task identifier
 * @param {string} cwd - Working directory for the CC process
 * @param {string} [model='sonnet'] - CC model to use
 * @param {number} [timeoutSecs=300] - Timeout in seconds
 */
export const subagentSpawn = (taskId, cwd, model = 'sonnet', timeoutSecs = 300) =>
  invoke('subagent_spawn', { taskId, cwd, model, timeoutSecs });

/**
 * Kill a running subagent
 * @param {string} taskId - Task to kill
 */
export const subagentKill = (taskId) =>
  invoke('subagent_kill', { taskId });

/**
 * Dynamically adjust max concurrent subagents
 * @param {number} n - New max concurrent count
 */
export const subagentSetMaxConcurrent = (n) =>
  invoke('subagent_set_max_concurrent', { n });

/**
 * Listen for subagent events
 * @param {'subagent-done'|'subagent-timeout'|'subagent-error'} eventName
 * @param {Function} callback - (payload) => void
 * @returns {Promise<Function>} unlisten function
 */
export const onSubagentEvent = (eventName, callback) =>
  listen(eventName, (event) => callback(event.payload));
```

- [ ] **Step 2: Add to exports**

In the default export object at the bottom of `tauri.js`, add:

```js
subagentSpawn,
subagentKill,
subagentSetMaxConcurrent,
onSubagentEvent,
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/tauri.js
git commit -m "feat(subagent): add JS Tauri wrappers for subagent commands"
```

---

### Task 4: `dispatch_subagent` builtin tool in socialToolExecutor.js

**Files:**
- Modify: `src/utils/workspace/socialToolExecutor.js`

- [ ] **Step 1: Add the tool name checker**

After the `isIntentPlanTool` function (find it with grep), add:

```js
/** 检查是否为 subagent 工具 */
export function isSubagentTool(toolName) {
  return toolName === 'dispatch_subagent';
}
```

- [ ] **Step 2: Add the tool definition getter**

After the new checker, add:

```js
/** 获取 dispatch_subagent 工具的 function calling 定义 */
export function getSubagentToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'dispatch_subagent',
      description: '发起一个后台研究任务。CC 会在独立沙箱中自主完成任务（可能用 web search 等工具）。结果会异步写入 scratch 文件，你在后续 eval 中用 social_read 读取。发起后请 write_intent_plan(actions=[]) 等待结果。',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: '明确的任务描述，例如"查一下 Therac-25 事故经过，200字总结"',
          },
          maxLen: {
            type: 'number',
            description: '结果最大字数限制',
            default: 500,
          },
        },
        required: ['task'],
      },
    },
  };
}
```

- [ ] **Step 3: Add the executor function**

After the definition getter, add:

```js
/**
 * 执行 dispatch_subagent 工具
 * @param {string} toolName
 * @param {Object} args - { task, maxLen }
 * @param {Object} context - { petId, targetId, targetType, subagentRegistry, subagentConfig }
 */
export async function executeSubagentTool(toolName, args, context) {
  if (toolName !== 'dispatch_subagent') return { error: `未知工具: ${toolName}` };

  const { petId, targetId, targetType, subagentRegistry, subagentConfig } = context;
  if (!petId || !targetId) return { error: '缺少 petId 或 targetId' };
  if (!subagentConfig?.enabled) return { error: 'Subagent 功能未启用' };

  const { task, maxLen = 500 } = args;
  if (!task || typeof task !== 'string' || task.trim().length === 0) {
    return { error: '缺少 task 参数' };
  }

  // Generate task ID
  const taskId = `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const dir = targetType === 'friend' ? 'friend' : 'group';

  // Build CLAUDE.md content
  const claudeMd = `# Task

${task.trim()}

## Output

把结果写入 output/result.md。完成后直接退出。

## Constraints
- 结果控制在 ${maxLen} 字以内
- 只输出最终结果，不要输出思考过程
- 用中文
`;

  try {
    // Create workspace: write CLAUDE.md (auto-creates directories)
    await tauri.workspaceWrite(petId, `subagents/${taskId}/CLAUDE.md`, claudeMd);
    // Create output directory by writing a placeholder (workspaceWrite auto-creates dirs)
    await tauri.workspaceWrite(petId, `subagents/${taskId}/output/.gitkeep`, '');

    // Get absolute path for CWD
    const cwd = await tauri.workspaceGetPath(petId, `subagents/${taskId}`, false);

    // Spawn via Rust
    await tauri.subagentSpawn(
      taskId,
      cwd,
      subagentConfig.model || 'sonnet',
      subagentConfig.timeoutSecs || 300,
    );

    // Register in subagentRegistry
    subagentRegistry.set(taskId, {
      status: 'running',
      task: task.trim(),
      target: targetId,
      targetType,
      dir,
      outputPath: `social/${dir}/scratch_${targetId}/subagent_${taskId}.md`,
      createdAt: Date.now(),
    });

    return {
      content: [{ type: 'text', text: `✓ 后台任务已发起: ${taskId}\n任务: ${task.trim()}\n结果将写入 social/${dir}/scratch_${targetId}/subagent_${taskId}.md` }],
    };
  } catch (e) {
    return { error: `Subagent 发起失败: ${e.message || e}` };
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/utils/workspace/socialToolExecutor.js
git commit -m "feat(subagent): add dispatch_subagent builtin tool executor"
```

---

### Task 5: Wire `dispatch_subagent` into callLLMWithTools dispatch

**Files:**
- Modify: `src/utils/mcp/toolExecutor.js:13` (import)
- Modify: `src/utils/mcp/toolExecutor.js:660-690` (tool dispatch block — appears twice, at ~670 and ~1140)

- [ ] **Step 1: Add import**

At `src/utils/mcp/toolExecutor.js` line 13, extend the import:

```js
import { isSocialFileTool, executeSocialFileTool, isHistoryBuiltinTool, executeHistoryBuiltinTool, isGroupLogBuiltinTool, executeGroupLogBuiltinTool, isStickerBuiltinTool, executeStickerBuiltinTool, isBufferSearchTool, executeBufferSearchTool, isIntentPlanTool, executeIntentPlanTool, isSubagentTool, executeSubagentTool } from '../workspace/socialToolExecutor.js';
```

- [ ] **Step 2: Add dispatch in first callLLMWithTools (non-streaming, ~line 668-689)**

After `const isIntentPlan = isIntentPlanTool(call.name);` add:

```js
const isSubagent = isSubagentTool(call.name);
```

Update `isAnyBuiltin` to include `isSubagent`:

```js
const isAnyBuiltin = isBuiltin || isSocialFile || isHistoryBuiltin || isGroupLogBuiltin || isStickerTool || isBufferSearch || isIntentPlan || isSubagent;
```

After the `isIntentPlan` dispatch block, add:

```js
} else if (isSubagent && builtinToolContext) {
  toolResult = await executeSubagentTool(call.name, call.arguments, builtinToolContext);
```

- [ ] **Step 3: Repeat for second callLLMWithTools (streaming, ~line 1140-1163)**

Apply the identical changes to the streaming version of the dispatch block.

- [ ] **Step 4: Verify no syntax errors**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run lint 2>&1 | head -20
```

Expected: no errors related to toolExecutor.js.

- [ ] **Step 5: Commit**

```bash
git add src/utils/mcp/toolExecutor.js
git commit -m "feat(subagent): wire dispatch_subagent into callLLMWithTools dispatch"
```

---

### Task 6: Subagent registry + event listeners in socialAgent.js

**Files:**
- Modify: `src/utils/socialAgent.js`

- [ ] **Step 1: Add subagentRegistry declaration**

Near the other global Maps (around line 1777 where `replyWakeFlag` is declared), add:

```js
const subagentRegistry = new Map();   // taskId → { status, task, target, targetType, dir, outputPath, createdAt, readByIntent }
```

- [ ] **Step 2: Add event listener setup function**

After the `sleepInterruptible` function (around line 1791), add:

```js
/** Subagent event 监听器（agent 启动时注册，停止时清理） */
let _subagentUnlisteners = [];
async function setupSubagentListeners(config) {
  // Clean up previous listeners
  for (const ul of _subagentUnlisteners) ul();
  _subagentUnlisteners = [];

  // subagent-done: read result, copy to scratch, wake Intent
  const ul1 = await tauri.onSubagentEvent('subagent-done', async (payload) => {
    const { taskId, exitCode } = payload;
    const entry = subagentRegistry.get(taskId);
    if (!entry) return;

    try {
      // Read the result from subagent workspace
      const result = await tauri.workspaceRead(config.petId, `subagents/${taskId}/output/result.md`).catch(() => '');
      if (result && result.trim()) {
        // Copy to main workspace scratch file
        await tauri.workspaceWrite(config.petId, entry.outputPath, result);
        entry.status = 'done';
        const elapsed = Math.round((Date.now() - entry.createdAt) / 1000);
        addLog('info', `✅ subagent done: ${taskId} (${elapsed}s, ${result.length}字)`, null, entry.target);
      } else {
        entry.status = 'failed';
        entry.error = `CC exited (code=${exitCode}) but no result.md found`;
        addLog('error', `❌ subagent error: ${taskId}: no output`, null, entry.target);
      }
    } catch (e) {
      entry.status = 'failed';
      entry.error = e.message || String(e);
      addLog('error', `❌ subagent error: ${taskId}: ${entry.error}`, null, entry.target);
    }

    // Clean up subagent workspace
    cleanupSubagentWorkspace(config.petId, taskId);

    // Wake Intent for this target
    wakeIntentForTarget(entry.target);
  });
  _subagentUnlisteners.push(ul1);

  // subagent-timeout
  const ul2 = await tauri.onSubagentEvent('subagent-timeout', async (payload) => {
    const { taskId } = payload;
    const entry = subagentRegistry.get(taskId);
    if (!entry) return;

    entry.status = 'timeout';
    addLog('warn', `⏰ subagent timeout: ${taskId} (${Math.round((Date.now() - entry.createdAt) / 1000)}s)`, null, entry.target);
    cleanupSubagentWorkspace(config.petId, taskId);
    wakeIntentForTarget(entry.target);
  });
  _subagentUnlisteners.push(ul2);

  // subagent-error
  const ul3 = await tauri.onSubagentEvent('subagent-error', async (payload) => {
    const { taskId, error } = payload;
    const entry = subagentRegistry.get(taskId);
    if (!entry) return;

    entry.status = 'failed';
    entry.error = error;
    addLog('error', `❌ subagent error: ${taskId}: ${error}`, null, entry.target);
    cleanupSubagentWorkspace(config.petId, taskId);
    wakeIntentForTarget(entry.target);
  });
  _subagentUnlisteners.push(ul3);
}

/** Clean up a subagent's workspace directory */
async function cleanupSubagentWorkspace(petId, taskId) {
  try {
    await tauri.workspaceDeleteFile(petId, `subagents/${taskId}/output/result.md`).catch(() => {});
    await tauri.workspaceDeleteFile(petId, `subagents/${taskId}/output/.gitkeep`).catch(() => {});
    await tauri.workspaceDeleteFile(petId, `subagents/${taskId}/CLAUDE.md`).catch(() => {});
    // Directories are left behind (empty) — harmless, cleaned on next start
  } catch { /* best-effort */ }
}

/** Wake Intent loop for a specific target */
function wakeIntentForTarget(target) {
  const iState = intentMap.get(target);
  if (iState) {
    iState.forceEval = true;
    if (iState._wake) { iState._wake(); iState._wake = null; }
  }
}
```

- [ ] **Step 3: Call setupSubagentListeners in startSocialLoop**

In the `startSocialLoop` function, after the existing event listener setup (search for where Observer/Reply/Intent loops are started, around line 2930-2960), add before the loop starts:

```js
// Setup subagent event listeners
if (config.subagentEnabled !== false) {
  await setupSubagentListeners(config);
  if (config.subagentMaxConcurrent) {
    tauri.subagentSetMaxConcurrent(config.subagentMaxConcurrent).catch(() => {});
  }
}
```

- [ ] **Step 4: Clean up subagents in stopSocialLoop**

In `stopSocialLoop()` (around line 2963), before `activeLoop = null;`, add:

```js
// Kill all running subagents
for (const [taskId, entry] of subagentRegistry) {
  if (entry.status === 'running') {
    tauri.subagentKill(taskId).catch(() => {});
  }
}
subagentRegistry.clear();
// Clean up subagent event listeners
for (const ul of _subagentUnlisteners) ul();
_subagentUnlisteners = [];
```

- [ ] **Step 5: Pass subagentRegistry into builtinToolContext for Intent**

Find where Intent calls `callLLMWithTools` (around line 2327). The `builtinToolContext` is constructed somewhere nearby. Add to it:

```js
subagentRegistry,
subagentConfig: {
  enabled: config.subagentEnabled !== false,
  model: config.subagentModel || 'sonnet',
  timeoutSecs: config.subagentTimeoutSecs || 300,
},
```

- [ ] **Step 6: Commit**

```bash
git add src/utils/socialAgent.js
git commit -m "feat(subagent): add subagentRegistry, event listeners, and lifecycle management"
```

---

### Task 7: Intent prompt integration — tool definition + status injection

**Files:**
- Modify: `src/utils/socialPromptBuilder.js:808-830` (tool section)
- Modify: `src/utils/socialPromptBuilder.js` (add subagent status builder)

- [ ] **Step 1: Add subagent status builder function**

At the top of `socialPromptBuilder.js` (after imports), add:

```js
/**
 * Build subagent status section for Intent prompt injection
 * @param {Map} subagentRegistry
 * @param {string} targetId - current target
 * @returns {string} status section text, or empty string if none
 */
export function buildSubagentStatusSection(subagentRegistry, targetId) {
  if (!subagentRegistry || subagentRegistry.size === 0) return '';

  const lines = [];
  for (const [taskId, entry] of subagentRegistry) {
    if (entry.target !== targetId) continue;
    const elapsed = Math.round((Date.now() - entry.createdAt) / 1000);
    switch (entry.status) {
      case 'done':
        if (!entry.readByIntent) {
          lines.push(`- ✅ ${taskId}: "${entry.task}" → 已完成，结果在 ${entry.outputPath}`);
        }
        break;
      case 'running':
        lines.push(`- ⏳ ${taskId}: "${entry.task}" → 执行中 (已耗时 ${elapsed}s)`);
        break;
      case 'timeout':
        lines.push(`- ⏰ ${taskId}: "${entry.task}" → 超时`);
        break;
      case 'failed':
        lines.push(`- ❌ ${taskId}: "${entry.task}" → 失败 (${entry.error || '未知错误'})`);
        break;
    }
  }

  if (lines.length === 0) return '';
  return `\n## 后台任务状态\n${lines.join('\n')}`;
}
```

- [ ] **Step 2: Add `dispatch_subagent` to Intent tool section in prompt**

In the `buildIntentSystemPrompt` function, find the tool section (around line 808-830 starting with `# 可用工具`). After the `外部搜索工具` section and before the closing of the tools section, add:

```js
后台研究工具（需要深入调查或查阅外部资料时使用）：
- dispatch_subagent(task, maxLen=500)：发起一个后台研究任务。task 写明确的指令，CC 会在独立沙箱中自主完成（可用 web search）。结果异步写入 scratch 文件，你在后续 eval 中用 social_read 读取。发起后 write_intent_plan(actions=[]) 等待结果。
```

- [ ] **Step 2b: Register dispatch_subagent in Intent tool definitions array**

In `socialAgent.js` at line 2230, the Intent tool set is built. Import `getSubagentToolDefinition` from `socialToolExecutor.js` and add it:

```js
// At the import block (line ~7-14 of socialAgent.js where other socialToolExecutor imports are)
import { ..., getSubagentToolDefinition } from './workspace/socialToolExecutor.js';

// At line 2230, after existing intentToolDefs construction:
const intentToolDefs = [...intentPlanDefs, ...intentFileDefs, ...getHistoryToolDefinitions(), ...getGroupLogToolDefinitions()];

// Add subagent tool if enabled:
if (config.subagentEnabled !== false) {
  intentToolDefs.push(getSubagentToolDefinition());
}
```

- [ ] **Step 3: Inject subagent status into prompt**

In `buildIntentSystemPrompt`, the function needs to accept `subagentRegistry` as a parameter. Find where the function signature is defined and add the parameter. Then, after the sticker section and before the tool section (around line 808), add:

```js
// === 后台任务状态 ===
const subagentStatus = buildSubagentStatusSection(subagentRegistry, targetId);
if (subagentStatus) {
  sections.push(subagentStatus);
}
```

- [ ] **Step 4: Pass subagentRegistry when calling buildIntentSystemPrompt**

In `socialAgent.js`, find where `buildIntentSystemPrompt` is called (in the Intent loop). Add `subagentRegistry` to the call arguments.

- [ ] **Step 5: Mark consumed subagent results**

In `socialToolExecutor.js`, inside `executeSocialFileTool` for the `social_read` handler, add a check: if the path matches `subagent_sa_*`, mark the corresponding registry entry as `readByIntent = true`:

```js
// In executeSocialRead, after successful read:
if (args.path && args.path.includes('subagent_sa_') && context.subagentRegistry) {
  const match = args.path.match(/subagent_(sa_[^./]+)/);
  if (match) {
    const entry = context.subagentRegistry.get(match[1]);
    if (entry) entry.readByIntent = true;
  }
}
```

- [ ] **Step 6: Clean up consumed entries**

In `socialAgent.js`, at the start of each Intent eval (before building the prompt), clean up old consumed entries:

```js
// Purge consumed subagent entries for this target
for (const [taskId, entry] of subagentRegistry) {
  if (entry.target === target && entry.readByIntent) {
    subagentRegistry.delete(taskId);
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add src/utils/socialPromptBuilder.js src/utils/socialAgent.js src/utils/workspace/socialToolExecutor.js
git commit -m "feat(subagent): Intent prompt integration — tool def + status injection + result consumption"
```

---

### Task 8: SocialPage config fields

**Files:**
- Modify: `src/pages/SocialPage.jsx`

- [ ] **Step 1: Add default config values**

In the `useState` config initializer (around line 20-45), add:

```js
subagentEnabled: true,
subagentMaxConcurrent: 5,
subagentTimeoutSecs: 300,
subagentModel: 'sonnet',
```

- [ ] **Step 2: Add to saved config keys**

Find where config keys are listed for save/load (search for `imageDescMode` in the save keys array, around line 436). Add:

```js
'subagentEnabled', 'subagentMaxConcurrent', 'subagentTimeoutSecs', 'subagentModel',
```

- [ ] **Step 3: Add UI controls**

Find the advanced LLM config section (where `observerApiProviderId` inputs are). After the last advanced config row, add:

```jsx
{/* Subagent 配置 */}
<div className="border-t border-gray-200 dark:border-gray-700 pt-3 mt-3">
  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">CC Subagent</h4>
  <div className="flex items-center gap-2 mb-2">
    <input
      type="checkbox"
      checked={config.subagentEnabled !== false}
      onChange={(e) => handleConfigChange('subagentEnabled', e.target.checked)}
      className="rounded"
    />
    <span className="text-xs text-gray-600 dark:text-gray-400">启用后台研究任务</span>
  </div>
  {config.subagentEnabled !== false && (
    <div className="grid grid-cols-3 gap-2">
      <div>
        <label className="text-xs text-gray-500">并发上限</label>
        <input
          type="number"
          min="1"
          max="20"
          value={config.subagentMaxConcurrent ?? 5}
          onChange={(e) => handleConfigChange('subagentMaxConcurrent', parseInt(e.target.value) || 5)}
          className="w-full rounded border px-2 py-1 text-sm"
        />
      </div>
      <div>
        <label className="text-xs text-gray-500">超时(秒)</label>
        <input
          type="number"
          min="30"
          max="600"
          value={config.subagentTimeoutSecs ?? 300}
          onChange={(e) => handleConfigChange('subagentTimeoutSecs', parseInt(e.target.value) || 300)}
          className="w-full rounded border px-2 py-1 text-sm"
        />
      </div>
      <div>
        <label className="text-xs text-gray-500">模型</label>
        <input
          type="text"
          value={config.subagentModel || 'sonnet'}
          onChange={(e) => handleConfigChange('subagentModel', e.target.value)}
          className="w-full rounded border px-2 py-1 text-sm"
          placeholder="sonnet"
        />
      </div>
    </div>
  )}
</div>
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/SocialPage.jsx
git commit -m "feat(subagent): add subagent config UI in SocialPage"
```

---

### Task 9: Integration test — manual end-to-end

- [ ] **Step 1: Verify Rust builds**

```bash
cd src-tauri && cargo build
```

Expected: builds successfully.

- [ ] **Step 2: Run dev mode**

```bash
npm run tauri:dev
```

Expected: app launches without errors.

- [ ] **Step 3: Manual test**

1. Go to Social page → enable CC Subagent in config
2. Start social agent with a watched group
3. Check logs for any startup errors related to subagent listeners
4. Verify the app doesn't crash

- [ ] **Step 4: Verify CC CLI availability**

In the app's dev console, run:

```js
await window.__TAURI__.invoke('subagent_spawn', { taskId: 'test_001', cwd: '/tmp/test_subagent', model: 'sonnet', timeoutSecs: 10 })
```

Expected: either succeeds (if `claude` is in PATH) or returns a clear error about command not found.

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix(subagent): integration fixups"
```

---

### Task 10: Frontend — subagent 日志展示 + 选项卡 + 状态栏

**Files:**
- Modify: `src/pages/SocialPage.jsx`
- Modify: `src/utils/socialAgent.js` (emit subagent log events)

- [ ] **Step 1: Add `showSubagent` toggle state and `subagent` log level**

In SocialPage.jsx, alongside existing toggles (line ~149-153):

```js
const [showSubagent, setShowSubagent] = useState(true);
```

In the `addLog` calls in socialAgent.js event listeners (Task 6), use a dedicated level `'subagent'` instead of `'info'`/`'warn'`/`'error'`:

```js
// subagent-done event handler:
addLog('subagent', `✅ subagent done: ${taskId} (${elapsed}s, ${result.length}字)`, 
  JSON.stringify({ taskId, task: entry.task, elapsed, resultPreview: result.substring(0, 500), resultLen: result.length }), entry.target);

// subagent-timeout event handler:
addLog('subagent', `⏰ subagent timeout: ${taskId} (${Math.round((Date.now() - entry.createdAt) / 1000)}s)`,
  JSON.stringify({ taskId, task: entry.task, status: 'timeout' }), entry.target);

// subagent-error event handler:
addLog('subagent', `❌ subagent error: ${taskId}: ${error}`,
  JSON.stringify({ taskId, task: entry.task, status: 'failed', error }), entry.target);

// dispatch_subagent tool executor (Task 4), on success:
addLog('subagent', `🚀 subagent dispatched: ${taskId} "${task.trim().substring(0, 50)}"`,
  JSON.stringify({ taskId, task: task.trim(), maxLen, status: 'dispatched' }), targetId);
```

- [ ] **Step 2: Add 🤖 Subagent toggle button in filter bar**

In the toggle button row (line ~1372-1376), add after the Intent button:

```jsx
<ToggleBtn active={showSubagent} onClick={() => setShowSubagent(!showSubagent)} icon="🤖" label="Subagent" />
```

- [ ] **Step 3: Add subagent log filtering**

In the `filteredLogs` useMemo (around line 590-601), add subagent level filtering:

```js
if (log.level === 'subagent') return showSubagent && (logFilter === 'all' || logFilter === 'system' || log.target === logFilter);
```

- [ ] **Step 4: Create `SubagentLogEntry` component**

After the existing `LlmLogEntry` component (around line 1648), add:

```jsx
function SubagentLogEntry({ log, logFilter }) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(log.timestamp).toLocaleTimeString();

  let details = {};
  try { details = typeof log.details === 'string' ? JSON.parse(log.details) : (log.details || {}); } catch { details = {}; }

  const statusColor = details.status === 'timeout' ? 'text-amber-500'
    : details.status === 'failed' ? 'text-red-500'
    : details.status === 'dispatched' ? 'text-blue-500'
    : 'text-emerald-500';

  return (
    <div className="py-0.5">
      <div
        className={`flex items-start gap-1 cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1 ${statusColor}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-slate-400 shrink-0">{ts}</span>
        <span className="text-slate-400 shrink-0">[subagent]</span>
        {log.target && logFilter === 'all' && (
          <span className="text-slate-300 shrink-0">[{log.target}]</span>
        )}
        <span className="font-medium">🤖</span>
        <span className="flex-1 break-words">{log.message}</span>
        <span className="text-slate-300 shrink-0">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && details && (
        <div className="ml-16 mt-0.5 p-2 rounded bg-slate-50 border border-slate-200 text-[10px] space-y-1">
          {details.task && (
            <div>
              <span className="text-slate-400 font-semibold">Task: </span>
              <span className="text-slate-600">{details.task}</span>
            </div>
          )}
          {details.elapsed != null && (
            <div>
              <span className="text-slate-400 font-semibold">耗时: </span>
              <span className="text-slate-600">{details.elapsed}s</span>
            </div>
          )}
          {details.resultLen != null && (
            <div>
              <span className="text-slate-400 font-semibold">结果: </span>
              <span className="text-slate-600">{details.resultLen}字</span>
            </div>
          )}
          {details.resultPreview && (
            <div className="mt-1 p-1.5 rounded bg-white border border-slate-150 whitespace-pre-wrap text-slate-600">
              {details.resultPreview}
            </div>
          )}
          {details.error && (
            <div className="text-red-500">
              <span className="font-semibold">错误: </span>{details.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Wire SubagentLogEntry into log renderer**

In the log rendering switch (around line 1472-1490), add before the default case:

```jsx
) : log.level === 'subagent' ? (
  <SubagentLogEntry key={log.id ?? log.timestamp} log={log} logFilter={logFilter} />
```

- [ ] **Step 6: Add subagent running count to status bar (right side)**

In the status/toolbar area next to the Running/Paused button (around line 1382-1392), add a subagent counter. This requires tracking active subagent count via a state variable.

Add state:

```js
const [activeSubagentCount, setActiveSubagentCount] = useState(0);
```

Listen for subagent events to update the count. In the `useEffect` that sets up Tauri event listeners, add:

```js
const ul1 = await tauri.onSubagentEvent('subagent-done', () => setActiveSubagentCount(c => Math.max(0, c - 1)));
const ul2 = await tauri.onSubagentEvent('subagent-timeout', () => setActiveSubagentCount(c => Math.max(0, c - 1)));
const ul3 = await tauri.onSubagentEvent('subagent-error', () => setActiveSubagentCount(c => Math.max(0, c - 1)));
```

Also listen for dispatched events. In socialAgent.js, emit a Tauri event on dispatch:

```js
// In dispatch_subagent handler, after successful spawn:
import { emit } from '@tauri-apps/api/event';
emit('subagent-dispatched', { taskId });
```

And in SocialPage:

```js
const ul4 = await listen('subagent-dispatched', () => setActiveSubagentCount(c => c + 1));
```

Render the counter in the status bar, after the Running/Paused button area:

```jsx
{socialActive && activeSubagentCount > 0 && (
  <span className="ml-2 px-2 py-0.5 text-[10px] font-medium rounded-full bg-blue-100 text-blue-700 border border-blue-200 shrink-0"
    title={`${activeSubagentCount} CC subagent(s) running`}
  >
    🤖 {activeSubagentCount}
  </span>
)}
```

- [ ] **Step 7: Add subagent info in Intent plan display**

In the Plan section (around line 1440-1462), when an Intent plan includes a `dispatch_subagent` action, show it. The `write_intent_plan` actions array may now include `{ type: 'subagent', taskId: '...' }` items. Update the `actionLabel` function to handle this:

```js
// In actionLabel function:
if (a.type === 'subagent') return `subagent:${a.taskId || '?'}`;
```

And style subagent actions distinctly (blue background):

```jsx
a.type === 'subagent' ? 'text-blue-700 bg-blue-50 border-blue-200' :
```

Note: This requires the Intent LLM to emit subagent actions in write_intent_plan, which happens naturally when it calls dispatch_subagent before write_intent_plan. We can also track dispatched subagents from the tool call log and show them in the Plan area.

- [ ] **Step 8: Reset subagent count on agent stop**

In the event listener that handles `social-status-changed` (agent start/stop), reset the counter:

```js
if (!isRunning) setActiveSubagentCount(0);
```

- [ ] **Step 9: Commit**

```bash
git add src/pages/SocialPage.jsx src/utils/socialAgent.js
git commit -m "feat(subagent): frontend log display, filter tab, status bar counter, plan integration"
```

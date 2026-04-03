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
    timeout_handle: JoinHandle<()>,
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

    {
        let procs = pool.processes.lock().await;
        if procs.contains_key(&task_id) {
            return Err(format!("Subagent task_id '{}' already exists", task_id));
        }
    }

    let permit = pool.semaphore.clone().acquire_owned().await
        .map_err(|e| format!("Semaphore error: {}", e))?;

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
        .map_err(|e| format!("Failed to spawn claude: {}", e))?;

    let pid = child.id();
    let task_id_wait = task_id.clone();
    let task_id_timeout = task_id.clone();
    let app_wait = app.clone();
    let app_timeout = app.clone();
    let pool_arc_wait = pool.inner().clone();
    let pool_arc_timeout = pool.inner().clone();

    let wait_handle = tokio::spawn(async move {
        let _permit = permit;
        let status = child.wait().await;
        let exit_code = status.ok().and_then(|s| s.code());

        let mut procs = pool_arc_wait.processes.lock().await;
        if let Some(proc) = procs.remove(&task_id_wait) {
            proc.timeout_handle.abort();
        }

        let _ = app_wait.emit("subagent-done", SubagentDonePayload {
            task_id: task_id_wait,
            exit_code,
        });
    });

    let timeout_handle = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(timeout)).await;

        let mut procs = pool_arc_timeout.processes.lock().await;
        if let Some(proc) = procs.remove(&task_id_timeout) {
            proc.wait_handle.abort();
        }

        if let Some(id) = pid {
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &id.to_string()])
                    .output();
            }
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &id.to_string(), "/F"])
                    .output();
            }
        }

        let _ = app_timeout.emit("subagent-timeout", SubagentTimeoutPayload {
            task_id: task_id_timeout,
        });
    });

    {
        let mut procs = pool.processes.lock().await;
        procs.insert(task_id, SubagentProcess {
            timeout_handle,
            wait_handle,
        });
    }

    Ok(())
}

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
    *current = n;
    Ok(())
}

//! 项目登记与项目内文件读取的命令层。
//!
//! 所有路径校验都在 Rust 侧完成：前端只传「项目 id + 项目内相对路径」，
//! 绝对路径由后端从登记表里查出来再拼。前端拿不到、也不需要拼绝对路径，
//! 这样越界访问没有入口。

use std::sync::Arc;

use crate::agent_sessions;
use crate::database::project_sessions::ProjectSession;
use crate::database::Database;
use crate::projects::{self, DirListing, FilePreview, Project, WriteResult};

/// 取项目根路径。顺手确认它还在磁盘上 —— 项目文件夹被移走或删掉是常事，
/// 与其让后续操作抛一个含糊的 IO 错误，不如在这里说清楚。
fn project_root(db: &Database, project_id: &str) -> Result<String, String> {
    let project = db
        .get_project(project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Project '{project_id}' is not registered"))?;
    if !std::path::Path::new(&project.path).is_dir() {
        return Err(format!("Project folder no longer exists: {}", project.path));
    }
    Ok(project.path)
}

#[tauri::command]
pub fn projects_list(db: tauri::State<'_, Arc<Database>>) -> Result<Vec<Project>, String> {
    db.get_projects().map_err(|e| e.to_string())
}

/// 登记一个已存在的目录。名称默认取目录名。
#[tauri::command]
pub fn projects_add(
    db: tauri::State<'_, Arc<Database>>,
    path: String,
    name: Option<String>,
) -> Result<Project, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    // 存 canonical 路径：同一个目录经由不同符号链接添加两次应该只算一个项目
    let canonical = dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {e}"))?
        .to_string_lossy()
        .to_string();

    let display_name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
        std::path::Path::new(&canonical)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| canonical.clone())
    });

    let id = uuid::Uuid::new_v4().to_string();
    db.create_project(&id, &display_name, &canonical)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn projects_rename(
    db: tauri::State<'_, Arc<Database>>,
    id: String,
    name: String,
) -> Result<bool, String> {
    if name.trim().is_empty() {
        return Err("Project name cannot be empty".to_string());
    }
    db.rename_project(&id, name.trim()).map_err(|e| e.to_string())
}

/// 只从列表里移除，磁盘上的文件一个都不动。
#[tauri::command]
pub fn projects_remove(
    db: tauri::State<'_, Arc<Database>>,
    id: String,
) -> Result<bool, String> {
    db.delete_project(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn projects_touch(db: tauri::State<'_, Arc<Database>>, id: String) -> Result<(), String> {
    db.touch_project(&id).map_err(|e| e.to_string())
}

/// 项目根的绝对路径。PTY 需要它当 cwd。
#[tauri::command]
pub fn projects_root_path(
    db: tauri::State<'_, Arc<Database>>,
    id: String,
) -> Result<String, String> {
    project_root(&db, &id)
}

#[tauri::command]
pub fn projects_list_dir(
    db: tauri::State<'_, Arc<Database>>,
    id: String,
    path: Option<String>,
) -> Result<DirListing, String> {
    let root = project_root(&db, &id)?;
    let relative = path.unwrap_or_default();
    projects::list_dir(&root, &relative).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn projects_preview_file(
    db: tauri::State<'_, Arc<Database>>,
    id: String,
    path: String,
) -> Result<FilePreview, String> {
    let root = project_root(&db, &id)?;
    projects::preview_file(&root, &path).map_err(|e| e.to_string())
}

/// 项目的 git 状态：分支、领先/落后、改动文件清单。
///
/// 界面在轮询它，所以「不是 git 仓库」不是错误 —— 那种情况返回
/// `isRepo: false`，前端把 git 那一段收起来就行。只有项目本身查不到或
/// 已经不在磁盘上才报错。
#[tauri::command]
pub async fn projects_git_status(
    db: tauri::State<'_, Arc<Database>>,
    id: String,
) -> Result<projects::git::GitStatus, String> {
    // 先把根路径取出来再 await：State 里的 Database 是同步 Mutex，
    // 锁不能跨 await 点。
    let root = project_root(&db, &id)?;
    Ok(projects::git::read_status(&root).await)
}


/// 写回一个项目内的文件。
///
/// `expectedModifiedAt` 是前端读取时拿到的修改时间。磁盘上的值已经不同就
/// 拒绝写入并报 Conflict —— agent 正在同一个项目里改文件，无条件覆盖会把
/// 它的修改吞掉。传 null 表示用户看到冲突提示后显式选择强制覆盖。
#[tauri::command]
pub fn projects_write_file(
    db: tauri::State<'_, Arc<Database>>,
    id: String,
    path: String,
    content: String,
    expected_modified_at: Option<i64>,
) -> Result<WriteResult, String> {
    let root = project_root(&db, &id)?;
    projects::write_file(&root, &path, &content, expected_modified_at).map_err(|e| e.to_string())
}

// ==================== 项目会话（历史与恢复） ====================

/// 历史会话列表。内容来自 claude/codex 自己的存储，PetGPT 只做索引。
/// `shell` 不入历史 —— 一个 bash 会话没有可恢复的语义。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionHistory {
    /// PetGPT 的绑定记录（含标题、状态、所属窗口）
    pub bound: Vec<ProjectSession>,
    /// CLI 存储里属于这个项目的全部会话，按时间倒序
    pub agent_sessions: Vec<agent_sessions::AgentSessionRecord>,
}

/// 登记一个会话窗口。
///
/// 新建会话时 agent id 还不存在（两个 CLI 都是懒写入），留空等
/// `projects_claim_session` 回填。**恢复**会话时 agent id 是已知的，直接
/// 传进来 —— 这样新会话与原对话同一身份，界面上不会多出一行。
#[tauri::command]
pub fn projects_register_session(
    db: tauri::State<'_, Arc<Database>>,
    session_id: String,
    project_id: String,
    kind: String,
    title: Option<String>,
    agent_id: Option<String>,
) -> Result<(), String> {
    if kind == "shell" {
        return Ok(());
    }
    let agent_id = agent_id.filter(|id| !id.trim().is_empty());
    db.upsert_project_session(
        &session_id,
        &project_id,
        &kind,
        title.as_deref(),
        agent_id.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/// 尝试把刚落盘的 agent 会话认领给这个窗口。
///
/// 返回认领到的 agent id；还没有可认领的候选时返回 `None`，调用方可以稍后重试。
/// 认领规则见 `agent_sessions::pick_claim_candidate`（纯函数，带测试）。
#[tauri::command]
pub fn projects_claim_session(
    db: tauri::State<'_, Arc<Database>>,
    session_id: String,
    project_id: String,
    kind: String,
    spawned_at: i64,
) -> Result<Option<String>, String> {
    if kind == "shell" {
        return Ok(None);
    }
    let root = project_root(&db, &project_id)?;
    let candidates = agent_sessions::claim_candidates(&root, spawned_at);
    let bound = db.bound_agent_ids(&project_id).map_err(|e| e.to_string())?;

    let Some(agent_id) = agent_sessions::pick_claim_candidate(
        &candidates,
        &kind,
        spawned_at,
        agent_sessions::claim_now(),
        &bound,
    ) else {
        return Ok(None);
    };

    // UNIQUE 索引挡住重复绑定；绑不上说明被别的窗口抢先了，不算错误
    if db
        .bind_project_session_agent(&session_id, &agent_id)
        .map_err(|e| e.to_string())?
    {
        Ok(Some(agent_id))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn projects_session_history(
    db: tauri::State<'_, Arc<Database>>,
    id: String,
    limit: Option<usize>,
) -> Result<ProjectSessionHistory, String> {
    let root = project_root(&db, &id)?;
    Ok(ProjectSessionHistory {
        bound: db.get_project_sessions(&id).map_err(|e| e.to_string())?,
        agent_sessions: agent_sessions::list_project_sessions(&root, limit.unwrap_or(30)),
    })
}

#[tauri::command]
pub fn projects_mark_session_exited(
    db: tauri::State<'_, Arc<Database>>,
    session_id: String,
) -> Result<(), String> {
    db.mark_project_session_exited(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn projects_rename_session(
    db: tauri::State<'_, Arc<Database>>,
    session_id: String,
    title: String,
) -> Result<bool, String> {
    if title.trim().is_empty() {
        return Err("Session name cannot be empty".to_string());
    }
    db.rename_project_session(&session_id, title.trim())
        .map_err(|e| e.to_string())
}

/// 从历史里移除一条绑定记录。只删 PetGPT 的索引，
/// claude/codex 自己的会话文件一个都不动。
#[tauri::command]
pub fn projects_forget_session(
    db: tauri::State<'_, Arc<Database>>,
    session_id: String,
) -> Result<bool, String> {
    db.delete_project_session(&session_id)
        .map_err(|e| e.to_string())
}

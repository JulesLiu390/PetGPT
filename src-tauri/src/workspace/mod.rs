// Workspace module: file-based personality, user profile, and memory system
// Replaces the old pets.system_instruction / pets.user_memory / longTimeMemory() pipeline

pub mod engine;

pub use engine::WorkspaceEngine;

use std::sync::Arc;
use tauri::State;
use std::process::Command as StdCommand;

/// Type alias for workspace state managed by Tauri
pub type WorkspaceState = Arc<WorkspaceEngine>;

// ============ Tauri Commands ============

/// Read a file from the pet's workspace
#[tauri::command]
pub fn workspace_read(
    workspace: State<'_, WorkspaceState>,
    pet_id: String,
    path: String,
) -> Result<String, String> {
    workspace
        .read(&pet_id, &path)
        .map_err(|e| e.to_string())
}

/// Write (create or overwrite) a file in the pet's workspace
#[tauri::command]
pub fn workspace_write(
    workspace: State<'_, WorkspaceState>,
    pet_id: String,
    path: String,
    content: String,
) -> Result<String, String> {
    workspace
        .write(&pet_id, &path, &content)
        .map_err(|e| e.to_string())
}

/// Edit a file by exact text find-and-replace
#[tauri::command]
pub fn workspace_edit(
    workspace: State<'_, WorkspaceState>,
    pet_id: String,
    path: String,
    old_text: String,
    new_text: String,
) -> Result<String, String> {
    workspace
        .edit(&pet_id, &path, &old_text, &new_text)
        .map_err(|e| e.to_string())
}

/// Ensure default workspace files (SOUL.md, USER.md) exist for a pet
#[tauri::command]
pub fn workspace_ensure_default_files(
    workspace: State<'_, WorkspaceState>,
    pet_id: String,
    pet_name: String,
) -> Result<(), String> {
    workspace
        .ensure_default_files(&pet_id, &pet_name)
        .map_err(|e| e.to_string())
}

/// Check if a file exists in the pet's workspace
#[tauri::command]
pub fn workspace_file_exists(
    workspace: State<'_, WorkspaceState>,
    pet_id: String,
    path: String,
) -> Result<bool, String> {
    Ok(workspace.file_exists(&pet_id, &path))
}

/// Get the absolute filesystem path of a file in the pet's workspace.
/// Ensures the file exists first; creates parent dirs and an empty file if needed.
#[tauri::command]
pub fn workspace_get_path(
    workspace: State<'_, WorkspaceState>,
    pet_id: String,
    path: String,
    ensure_exists: Option<bool>,
) -> Result<String, String> {
    // Use write with empty-string fallback to ensure the file & dirs exist
    if ensure_exists.unwrap_or(false) && !workspace.file_exists(&pet_id, &path) {
        workspace.write(&pet_id, &path, "").map_err(|e| e.to_string())?;
    }
    // resolve_safe_path is private, so we reconstruct the path the same way
    let full = workspace.get_full_path(&pet_id, &path).map_err(|e| e.to_string())?;
    full.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())
}

/// Open a workspace file in the system default editor
#[tauri::command]
pub fn workspace_open_file(
    workspace: State<'_, WorkspaceState>,
    pet_id: String,
    path: String,
    default_content: Option<String>,
) -> Result<(), String> {
    // Ensure file exists and has content (create/fill with default content if needed)
    let needs_content = if workspace.file_exists(&pet_id, &path) {
        // File exists but might be empty
        workspace.read(&pet_id, &path)
            .map(|c| c.trim().is_empty())
            .unwrap_or(false)
    } else {
        true
    };
    if needs_content {
        let content = default_content.unwrap_or_default();
        if !content.is_empty() {
            workspace.write(&pet_id, &path, &content).map_err(|e| e.to_string())?;
        } else if !workspace.file_exists(&pet_id, &path) {
            workspace.write(&pet_id, &path, "").map_err(|e| e.to_string())?;
        }
    }
    let full = workspace.get_full_path(&pet_id, &path).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    StdCommand::new("open")
        .arg(&full)
        .spawn()
        .map_err(|e| format!("Failed to open file: {}", e))?;

    #[cfg(target_os = "linux")]
    StdCommand::new("xdg-open")
        .arg(&full)
        .spawn()
        .map_err(|e| format!("Failed to open file: {}", e))?;

    #[cfg(target_os = "windows")]
    StdCommand::new("cmd")
        .args(["/C", "start", ""])
        .arg(&full)
        .spawn()
        .map_err(|e| format!("Failed to open file: {}", e))?;

    Ok(())
}

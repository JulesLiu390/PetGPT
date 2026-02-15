// Workspace module: file-based personality, user profile, and memory system
// Replaces the old pets.system_instruction / pets.user_memory / longTimeMemory() pipeline

pub mod engine;

pub use engine::WorkspaceEngine;

use std::sync::Arc;
use tauri::State;

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

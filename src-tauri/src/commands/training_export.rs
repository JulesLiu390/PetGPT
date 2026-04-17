use serde::{Deserialize, Serialize};
use std::process::Command;
use std::path::PathBuf;
use tauri::Manager;
use crate::workspace::WorkspaceEngine;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct ExportOptions {
    pub pet_id: String,
    pub output_path: String,
    #[serde(default)]
    pub redact: bool,
    pub status: Option<String>,
    pub termination: Option<String>,
}

#[derive(Serialize)]
pub struct ExportSummary {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

#[tauri::command]
pub async fn run_training_export(
    app: tauri::AppHandle,
    workspace: tauri::State<'_, Arc<WorkspaceEngine>>,
    options: ExportOptions,
) -> Result<ExportSummary, String> {
    // Resolve input path via the workspace engine (same as workspace_open_subfolder)
    let input_dir = workspace
        .get_full_path(&options.pet_id, "social/training/intent")
        .map_err(|e| format!("resolve input: {e}"))?;

    // Ensure the directory exists (it may not exist yet if no data was collected)
    std::fs::create_dir_all(&input_dir)
        .map_err(|e| format!("create input dir: {e}"))?;

    // Resolve script path: prefer resource_dir (prod bundle), fall back to repo root (dev)
    let mut script = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("scripts")
        .join("export_intent_training.mjs");

    if !script.exists() {
        // Dev mode: look relative to cwd
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let candidate = cwd.join("scripts").join("export_intent_training.mjs");
        if candidate.exists() {
            script = candidate;
        } else {
            // Also try one level up (when Tauri binary lives in src-tauri/target/...)
            if let Some(parent) = cwd.parent() {
                let candidate2 = parent.join("scripts").join("export_intent_training.mjs");
                if candidate2.exists() {
                    script = candidate2;
                }
            }
        }
    }

    if !script.exists() {
        return Err(format!("export script not found (tried: {})", script.display()));
    }

    let mut cmd = Command::new("node");
    cmd.arg(&script)
        .arg("--input").arg(&input_dir)
        .arg("--output").arg(&options.output_path);

    if options.redact {
        cmd.arg("--redact");
    }
    if let Some(s) = &options.status {
        cmd.arg("--status").arg(s);
    }
    if let Some(t) = &options.termination {
        cmd.arg("--termination").arg(t);
    }

    let output = cmd.output().map_err(|e| format!("spawn failed: {e}"))?;

    Ok(ExportSummary {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    })
}

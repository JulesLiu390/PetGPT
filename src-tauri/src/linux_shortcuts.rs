//! Linux-specific global shortcut handling using GNOME custom keybindings + Unix socket IPC.
//!
//! On GNOME Wayland, X11 key grabs (used by the global-hotkey crate through XWayland)
//! do NOT receive key events when a native Wayland surface has focus.  This module
//! registers shortcuts via GNOME's custom-keybinding system which works at the Mutter
//! compositor level — truly global regardless of focus.
//!
//! Flow:
//!   1. App starts → creates a Unix domain socket listener at $XDG_RUNTIME_DIR/petgpt-shortcuts.sock
//!   2. User saves shortcuts → registers GNOME custom keybindings via `dconf write`
//!      Each keybinding command runs a tiny helper script that sends a command name to the socket
//!   3. GNOME detects the key combo → runs the helper script → our listener receives the command
//!   4. App performs the action (toggle character, toggle chat, take screenshot)
//!   5. On exit → removes the keybindings from GNOME and cleans up the socket

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::Manager;
use tokio::io::AsyncReadExt;
use tokio::net::UnixListener;

const DCONF_BASE: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/petgpt";
const GSETTINGS_KEY: &str = "org.gnome.settings-daemon.plugins.media-keys";

/// Saved window positions so we can restore them exactly after show().
/// XWayland doesn't reliably preserve position across hide()/show().
static SAVED_CHAR_POS: Mutex<Option<(f64, f64)>> = Mutex::new(None);
static SAVED_CHAT_POS: Mutex<Option<(f64, f64)>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn runtime_dir() -> PathBuf {
    std::env::var("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let uid = unsafe { libc::getuid() };
            PathBuf::from(format!("/run/user/{}", uid))
        })
}

fn socket_path() -> PathBuf {
    runtime_dir().join("petgpt-shortcuts.sock")
}

fn helper_script_path() -> PathBuf {
    runtime_dir().join("petgpt-shortcut.sh")
}

// ---------------------------------------------------------------------------
// Shortcut format conversion   (Tauri normalised → GNOME binding)
// ---------------------------------------------------------------------------

/// Convert Tauri-normalised shortcut (e.g. "Control+Shift+A") to GNOME binding
/// format (e.g. "<Control><Shift>a").
fn to_gnome_binding(normalised: &str) -> String {
    let mut mods = String::new();
    let mut key = String::new();
    for part in normalised.split('+') {
        let p = part.trim();
        match p {
            "Control" => mods.push_str("<Control>"),
            "Alt"     => mods.push_str("<Alt>"),
            "Shift"   => mods.push_str("<Shift>"),
            "Super" | "Meta" | "Command" => mods.push_str("<Super>"),
            _ => {
                // Key name — GNOME uses lowercase for single letters, XKB names for others
                key = match p {
                    "Space"     => "space".into(),
                    "Enter"     => "Return".into(),
                    "Escape"    => "Escape".into(),
                    "Backspace" => "BackSpace".into(),
                    "Delete"    => "Delete".into(),
                    "Tab"       => "Tab".into(),
                    other if other.len() == 1 => other.to_lowercase(),
                    other => other.to_string(), // F1 … F12, etc.
                };
            }
        }
    }
    format!("{}{}", mods, key)
}

// ---------------------------------------------------------------------------
// Helper script
// ---------------------------------------------------------------------------

fn create_helper_script() -> Result<(), String> {
    let path = helper_script_path();
    let sock = socket_path();
    let content = format!(
        r#"#!/bin/bash
# PetGPT shortcut helper – sends command to PetGPT via Unix socket.
# Auto-generated; do not edit – it will be recreated on next launch.
python3 -c "
import socket, sys
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect('{sock}')
    s.sendall(sys.argv[1].encode())
    s.close()
except Exception:
    pass
" "$1"
"#,
        sock = sock.display()
    );

    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write helper script: {}", e))?;

    // chmod +x
    Command::new("chmod")
        .args(["+x", &path.to_string_lossy()])
        .output()
        .map_err(|e| format!("Failed to chmod helper script: {}", e))?;

    log::info!("[LinuxShortcuts] Helper script created at {}", path.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// GNOME keybinding registration via dconf
// ---------------------------------------------------------------------------

fn dconf_write(key: &str, value: &str) -> Result<(), String> {
    let out = Command::new("dconf")
        .args(["write", key, value])
        .output()
        .map_err(|e| format!("dconf write failed: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("dconf write {} failed: {}", key, stderr));
    }
    Ok(())
}

fn register_one_keybinding(suffix: &str, name: &str, binding: &str, action: &str) -> Result<(), String> {
    let base = format!("{}-{}/", DCONF_BASE, suffix);
    let script = helper_script_path();

    dconf_write(&format!("{}name", base), &format!("'{}'", name))?;
    dconf_write(&format!("{}binding", base), &format!("'{}'", binding))?;
    dconf_write(
        &format!("{}command", base),
        &format!("'{} {}'", script.display(), action),
    )?;

    Ok(())
}

/// Update the master list of custom-keybinding paths,
/// keeping any non-PetGPT entries and adding ours.
fn update_master_list(suffixes: &[&str]) -> Result<(), String> {
    let out = Command::new("gsettings")
        .args(["get", GSETTINGS_KEY, "custom-keybindings"])
        .output()
        .map_err(|e| format!("gsettings get failed: {}", e))?;

    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();

    // Parse existing paths, filtering our own
    let mut paths: Vec<String> = if raw == "@as []" || raw.is_empty() {
        vec![]
    } else {
        raw.trim_matches(|c| c == '[' || c == ']')
            .split(',')
            .map(|s| s.trim().trim_matches('\'').trim().to_string())
            .filter(|s| !s.is_empty() && !s.contains("petgpt"))
            .collect()
    };

    // Append our paths
    for s in suffixes {
        paths.push(format!("{}-{}/", DCONF_BASE, s));
    }

    let formatted = if paths.is_empty() {
        "@as []".to_string()
    } else {
        let inner: Vec<String> = paths.iter().map(|p| format!("'{}'", p)).collect();
        format!("[{}]", inner.join(", "))
    };

    let out = Command::new("gsettings")
        .args(["set", GSETTINGS_KEY, "custom-keybindings", &formatted])
        .output()
        .map_err(|e| format!("gsettings set failed: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        log::warn!("[LinuxShortcuts] gsettings set stderr: {}", stderr);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Returns true if we are running under a GNOME-based desktop session.
pub fn is_gnome() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP")
        .map(|d| {
            let d = d.to_lowercase();
            d.contains("gnome") || d.contains("unity") || d.contains("cinnamon")
        })
        .unwrap_or(false)
}

/// Register shortcuts as GNOME custom keybindings.
/// `s1`, `s2`, `s3` are already normalised by `window_layout::normalize_shortcut`.
pub fn register_shortcuts(s1: &str, s2: &str, s3: &str) -> Result<(), String> {
    create_helper_script()?;

    let mut suffixes: Vec<&str> = vec![];

    if !s1.is_empty() {
        let binding = to_gnome_binding(s1);
        register_one_keybinding("char", "PetGPT Character", &binding, "toggle_char")?;
        suffixes.push("char");
        log::info!("[LinuxShortcuts] Registered: {} → {}", s1, binding);
    }

    if !s2.is_empty() {
        let binding = to_gnome_binding(s2);
        register_one_keybinding("chat", "PetGPT Chat", &binding, "toggle_chat")?;
        suffixes.push("chat");
        log::info!("[LinuxShortcuts] Registered: {} → {}", s2, binding);
    }

    if !s3.is_empty() {
        let binding = to_gnome_binding(s3);
        register_one_keybinding("screenshot", "PetGPT Screenshot", &binding, "screenshot")?;
        suffixes.push("screenshot");
        log::info!("[LinuxShortcuts] Registered: {} → {}", s3, binding);
    }

    update_master_list(&suffixes)?;
    log::info!("[LinuxShortcuts] All shortcuts registered via GNOME custom keybindings");
    Ok(())
}

/// Remove all PetGPT keybindings from GNOME and clean up files.
pub fn cleanup() {
    // Remove our entries from the master list
    if let Ok(out) = Command::new("gsettings")
        .args(["get", GSETTINGS_KEY, "custom-keybindings"])
        .output()
    {
        let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if raw != "@as []" && !raw.is_empty() {
            let paths: Vec<String> = raw
                .trim_matches(|c| c == '[' || c == ']')
                .split(',')
                .map(|s| s.trim().trim_matches('\'').trim().to_string())
                .filter(|s| !s.is_empty() && !s.contains("petgpt"))
                .collect();

            let formatted = if paths.is_empty() {
                "@as []".to_string()
            } else {
                let inner: Vec<String> = paths.iter().map(|p| format!("'{}'", p)).collect();
                format!("[{}]", inner.join(", "))
            };

            let _ = Command::new("gsettings")
                .args(["set", GSETTINGS_KEY, "custom-keybindings", &formatted])
                .output();
        }
    }

    // Delete dconf entries
    for suffix in &["char", "chat", "screenshot"] {
        let path = format!("{}-{}/", DCONF_BASE, suffix);
        let _ = Command::new("dconf").args(["reset", "-f", &path]).output();
    }

    // Remove files
    let _ = std::fs::remove_file(socket_path());
    let _ = std::fs::remove_file(helper_script_path());

    log::info!("[LinuxShortcuts] Cleaned up keybindings and files");
}

/// Start the Unix socket listener that receives shortcut commands from GNOME.
/// Safe to call from a synchronous (Tauri setup) context.
pub fn start_listener(app_handle: tauri::AppHandle) -> Result<(), String> {
    let sock = socket_path();

    // Remove stale socket
    let _ = std::fs::remove_file(&sock);

    // Bind synchronously — this doesn't need an async runtime
    let std_listener = std::os::unix::net::UnixListener::bind(&sock)
        .map_err(|e| format!("Failed to bind Unix socket at {}: {}", sock.display(), e))?;
    std_listener.set_nonblocking(true)
        .map_err(|e| format!("Failed to set non-blocking: {}", e))?;

    log::info!("[LinuxShortcuts] Socket listener starting at {}", sock.display());

    // Spawn the async listener using Tauri's async runtime
    tauri::async_runtime::spawn(async move {
        // Convert std UnixListener to tokio UnixListener inside the async context
        let listener = match UnixListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                log::error!("[LinuxShortcuts] Failed to convert to tokio listener: {}", e);
                return;
            }
        };

        loop {
            match listener.accept().await {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 256];
                    match stream.read(&mut buf).await {
                        Ok(n) if n > 0 => {
                            let cmd = String::from_utf8_lossy(&buf[..n]).trim().to_string();
                            log::info!("[LinuxShortcuts] Received command: {}", cmd);
                            handle_command(&app_handle, &cmd);
                        }
                        _ => {}
                    }
                }
                Err(e) => {
                    log::error!("[LinuxShortcuts] Accept error: {}", e);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

fn handle_command(app: &tauri::AppHandle, cmd: &str) {
    // Helper: set skip_chat_sync_until grace period to prevent
    // Moved events from repositioning chat during show/hide transitions.
    let set_grace_period = |app: &tauri::AppHandle| {
        let ws: tauri::State<'_, crate::WinState> = app.state();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        ws.skip_chat_sync_until.store(now + 1000, std::sync::atomic::Ordering::SeqCst);
    };

    // Helper: get a window's logical position
    let get_logical_pos = |win: &tauri::WebviewWindow| -> Option<(f64, f64)> {
        if let Ok(pos) = win.outer_position() {
            let sf = win.scale_factor().unwrap_or(1.0);
            Some((pos.x as f64 / sf, pos.y as f64 / sf))
        } else {
            None
        }
    };

    // Helper: restore saved position and focus a window
    let restore_and_show = |win: &tauri::WebviewWindow, saved: &Mutex<Option<(f64, f64)>>| {
        let _ = win.show();
        if let Some((x, y)) = saved.lock().unwrap().take() {
            let _ = win.set_position(tauri::Position::Logical(
                tauri::LogicalPosition { x, y }
            ));
        }
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
    };

    match cmd {
        "toggle_char" => {
            log::info!("[LinuxShortcuts] Toggling character window");
            if let Some(window) = app.get_webview_window("character") {
                if window.is_visible().unwrap_or(false) {
                    // Save position before hiding
                    *SAVED_CHAR_POS.lock().unwrap() = get_logical_pos(&window);
                    set_grace_period(app);
                    let _ = window.hide();
                } else {
                    set_grace_period(app);
                    restore_and_show(&window, &SAVED_CHAR_POS);
                    // Delayed re-focus to ensure Mutter raises the window
                    let app_clone = app.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        if let Some(w) = app_clone.get_webview_window("character") {
                            // Restore position again in case XWayland moved it
                            if let Some((x, y)) = *SAVED_CHAR_POS.lock().unwrap() {
                                let _ = w.set_position(tauri::Position::Logical(
                                    tauri::LogicalPosition { x, y }
                                ));
                            }
                            let _ = w.set_always_on_top(false);
                            let _ = w.set_always_on_top(true);
                            let _ = w.set_focus();
                        }
                    });
                }
            }
        }
        "toggle_chat" => {
            log::info!("[LinuxShortcuts] Toggling chat window");
            if let Some(window) = app.get_webview_window("chat") {
                set_grace_period(app);
                if window.is_visible().unwrap_or(false) {
                    *SAVED_CHAT_POS.lock().unwrap() = get_logical_pos(&window);
                    let _ = window.hide();
                } else {
                    restore_and_show(&window, &SAVED_CHAT_POS);
                }
            }
        }
        "screenshot" => {
            log::info!("[LinuxShortcuts] Taking screenshot");
            // We need DbState and WinState from the managed state.
            // Since we have the AppHandle, we can retrieve them.
            let db: tauri::State<'_, crate::DbState> = app.state();
            let ws: tauri::State<'_, crate::WinState> = app.state();
            if let Err(e) = crate::take_screenshot(app.clone(), db, ws) {
                log::error!("[LinuxShortcuts] Screenshot failed: {}", e);
            }
        }
        other => {
            log::warn!("[LinuxShortcuts] Unknown command: {}", other);
        }
    }
}

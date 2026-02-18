// Linux platform implementation.
// Uses external commands (gdbus, grim, import) for screenshot capture
// and conservative heuristics for work-area estimation.

use super::types::*;
use std::path::Path;
use std::process::Command;

pub struct LinuxPlatform;

// ============ Internal helpers ============

/// Detect whether the current session is Wayland or X11.
fn session_type() -> &'static str {
    // Cache the result for the lifetime of the process
    use std::sync::OnceLock;
    static SESSION: OnceLock<String> = OnceLock::new();

    let s = SESSION.get_or_init(|| {
        std::env::var("XDG_SESSION_TYPE")
            .unwrap_or_else(|_| "x11".to_string())
            .to_lowercase()
    });

    if s.contains("wayland") {
        "wayland"
    } else {
        "x11"
    }
}

/// Try to read `_NET_WORKAREA` via `xprop` on X11.
/// Returns (x, y, width, height) of the primary work area in pixels.
fn x11_get_workarea() -> Option<(f64, f64, f64, f64)> {
    let output = Command::new("xprop")
        .args(["-root", "_NET_WORKAREA"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    // Format: _NET_WORKAREA(CARDINAL) = 0, 0, 1920, 1048, ...
    // We only care about the first 4 values (primary monitor).
    let values_part = text.split('=').nth(1)?;
    let nums: Vec<f64> = values_part
        .split(',')
        .take(4)
        .filter_map(|s| s.trim().parse::<f64>().ok())
        .collect();

    if nums.len() == 4 {
        Some((nums[0], nums[1], nums[2], nums[3]))
    } else {
        None
    }
}

/// Capture screenshot via D-Bus Portal (works on both Wayland and X11 with portal).
/// Returns path to the temporary screenshot file.
fn capture_via_portal() -> Result<String, String> {
    // Use gdbus to call xdg-desktop-portal Screenshot
    // This opens a system dialog asking the user for permission
    let output = Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest", "org.freedesktop.portal.Desktop",
            "--object-path", "/org/freedesktop/portal/desktop",
            "--method", "org.freedesktop.portal.Screenshot.Screenshot",
            "",  // parent window (empty = no parent)
            "{}",  // options (empty dict)
        ])
        .output()
        .map_err(|e| format!("Failed to call gdbus: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("D-Bus Screenshot portal failed: {}", stderr));
    }

    // Parse response: (<'objectpath'>,) or the URI directly depending on portal version
    let stdout = String::from_utf8_lossy(&output.stdout);

    // The response varies by portal implementation. Try to extract a file URI.
    // Common format: (<objectpath>,) — but we need to wait for the Response signal.
    // Simpler approach: use the interactive flag which returns the file directly in some impls.

    // For most modern implementations, we need to use a helper approach.
    // Fall through to gnome-screenshot/grim if portal doesn't give us a direct path.
    Err(format!(
        "Portal returned handle (async not supported via gdbus CLI): {}",
        stdout.trim()
    ))
}

/// Capture screenshot using gnome-screenshot (GNOME desktops).
fn capture_via_gnome_screenshot(path: &str) -> Result<(), String> {
    let output = Command::new("gnome-screenshot")
        .args(["-f", path])
        .output()
        .map_err(|e| format!("gnome-screenshot failed: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("gnome-screenshot error: {}", stderr))
    }
}

/// Capture screenshot using grim (Wayland/wlroots compositors).
fn capture_via_grim(path: &str) -> Result<(), String> {
    let output = Command::new("grim")
        .arg(path)
        .output()
        .map_err(|e| format!("grim failed: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("grim error: {}", stderr))
    }
}

/// Capture screenshot using import (ImageMagick, X11).
fn capture_via_import(path: &str) -> Result<(), String> {
    let output = Command::new("import")
        .args(["-window", "root", path])
        .output()
        .map_err(|e| format!("import failed: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("import error: {}", stderr))
    }
}

/// Read an image file (PNG/BMP/etc.) and convert to BGRA pixel data.
fn read_image_as_bgra(path: &str) -> Result<ScreenshotData, String> {
    let img = image::open(path)
        .map_err(|e| format!("Failed to open screenshot image: {}", e))?;

    let rgba = img.to_rgba8();
    let width = rgba.width();
    let height = rgba.height();

    // Convert RGBA → BGRA (swap R and B channels)
    let mut bgra = rgba.into_raw();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2); // R ↔ B
    }

    Ok(ScreenshotData { bgra, width, height })
}

// ============ PlatformProvider implementation ============

impl PlatformProvider for LinuxPlatform {
    fn screen_info_from_monitor(
        monitor_size_physical: (u32, u32),
        monitor_position_physical: (i32, i32),
        scale_factor: f64,
    ) -> ScreenInfo {
        let total_w = monitor_size_physical.0 as f64 / scale_factor;
        let total_h = monitor_size_physical.1 as f64 / scale_factor;
        let origin_x = monitor_position_physical.0 as f64 / scale_factor;
        let origin_y = monitor_position_physical.1 as f64 / scale_factor;

        let total = LogicalRect::new(origin_x, origin_y, total_w, total_h);

        // Try to get real work area from X11 _NET_WORKAREA
        let work_area = if session_type() == "x11" {
            if let Some((wa_x, wa_y, wa_w, wa_h)) = x11_get_workarea() {
                // _NET_WORKAREA returns physical pixels, convert to logical
                LogicalRect::new(
                    wa_x / scale_factor,
                    wa_y / scale_factor,
                    wa_w / scale_factor,
                    wa_h / scale_factor,
                )
            } else {
                // X11 fallback: assume top panel ~32px (GNOME Shell)
                LogicalRect::new(origin_x, origin_y + 32.0, total_w, total_h - 32.0)
            }
        } else {
            // Wayland: no standard way to query work area from client side.
            // GNOME Shell top bar is ~32px. Assume no bottom dock.
            LogicalRect::new(origin_x, origin_y + 32.0, total_w, total_h - 32.0)
        };

        ScreenInfo {
            total,
            work_area,
            scale_factor,
        }
    }

    fn capture_screen() -> Result<ScreenshotData, String> {
        // Use a temp file for the screenshot
        let tmp_path = "/tmp/petgpt_screenshot.png";

        // Strategy: try multiple capture methods in order of preference
        let mut errors = Vec::new();

        // 1. Try D-Bus Portal (works on both Wayland and X11 with portal support)
        match capture_via_portal() {
            Ok(portal_path) => {
                return read_image_as_bgra(&portal_path);
            }
            Err(e) => errors.push(format!("Portal: {}", e)),
        }

        // 2. Try session-specific tools
        if session_type() == "wayland" {
            // Try grim (wlroots Wayland compositors)
            match capture_via_grim(tmp_path) {
                Ok(()) => return read_image_as_bgra(tmp_path),
                Err(e) => errors.push(format!("grim: {}", e)),
            }
        } else {
            // X11: try import (ImageMagick)
            match capture_via_import(tmp_path) {
                Ok(()) => return read_image_as_bgra(tmp_path),
                Err(e) => errors.push(format!("import: {}", e)),
            }
        }

        // 3. Try gnome-screenshot as universal fallback
        match capture_via_gnome_screenshot(tmp_path) {
            Ok(()) => return read_image_as_bgra(tmp_path),
            Err(e) => errors.push(format!("gnome-screenshot: {}", e)),
        }

        Err(format!(
            "All screenshot methods failed on Linux ({}):\n  {}",
            session_type(),
            errors.join("\n  ")
        ))
    }

    fn write_preview(data: &ScreenshotData, path: &Path) -> Result<(), String> {
        super::bmp::write_bmp_file(path, &data.bgra, data.width, data.height)
    }

    fn apply_window_effect(_window: &tauri::WebviewWindow, _effect: &WindowEffect) -> Result<(), String> {
        // Linux has no native translucent window effect API.
        // The frontend handles opacity fallback via platform-info event.
        Ok(())
    }

    fn clear_window_effect(_window: &tauri::WebviewWindow) -> Result<(), String> {
        Ok(())
    }

    fn normalize_modifier(key: &str) -> &'static str {
        match key {
            "cmd" | "command" | "meta" => "Control",
            "ctrl" | "control" => "Control",
            "alt" | "option" => "Alt",
            "shift" => "Shift",
            _ => "Control",
        }
    }

    fn default_scale_factor() -> f64 {
        1.0
    }
}

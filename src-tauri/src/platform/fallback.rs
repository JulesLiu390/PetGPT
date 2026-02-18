// Fallback platform implementation for Windows and other non-macOS, non-Linux systems.
// Provides safe defaults and graceful degradation.

use super::types::*;
use std::path::Path;

pub struct FallbackPlatform;

impl PlatformProvider for FallbackPlatform {
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

        // Conservative work-area estimate:
        // - Top inset 0px (no macOS menu bar; Windows taskbar can be anywhere)
        // - Bottom inset 50px (approximate taskbar / panel height)
        // This is a safe fallback; platform-specific implementations can override.
        let work_area = LogicalRect::new(
            origin_x,
            origin_y,
            total_w,
            total_h - 50.0,
        );

        ScreenInfo {
            total,
            work_area,
            scale_factor,
        }
    }

    fn capture_screen() -> Result<ScreenshotData, String> {
        // TODO: Implement Windows (BitBlt/PrintWindow) and Linux (xdg-screenshot) capture
        Err("Screenshot is not yet supported on this platform".to_string())
    }

    fn write_preview(_data: &ScreenshotData, _path: &Path) -> Result<(), String> {
        Err("Screenshot preview is not yet supported on this platform".to_string())
    }

    fn apply_window_effect(window: &tauri::WebviewWindow, effect: &WindowEffect) -> Result<(), String> {
        match effect {
            WindowEffect::Mica => {
                // Windows 11 Mica effect
                #[cfg(target_os = "windows")]
                {
                    use window_vibrancy::apply_mica;
                    return apply_mica(window, None)
                        .map_err(|e| format!("Failed to apply Mica: {:?}", e));
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = window;
                    Ok(()) // No-op on Linux
                }
            }
            WindowEffect::Acrylic => {
                #[cfg(target_os = "windows")]
                {
                    use window_vibrancy::apply_acrylic;
                    return apply_acrylic(window, None)
                        .map_err(|e| format!("Failed to apply Acrylic: {:?}", e));
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = window;
                    Ok(())
                }
            }
            WindowEffect::Vibrancy { .. } => {
                // macOS vibrancy requested on non-macOS — try Mica as best alternative
                #[cfg(target_os = "windows")]
                {
                    use window_vibrancy::apply_mica;
                    return apply_mica(window, None)
                        .map_err(|e| format!("Failed to apply Mica (vibrancy fallback): {:?}", e));
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = window;
                    Ok(()) // Linux: no translucent effect, frontend uses opaque CSS background
                }
            }
            WindowEffect::None => {
                let _ = window;
                Ok(())
            }
        }
    }

    fn clear_window_effect(_window: &tauri::WebviewWindow) -> Result<(), String> {
        // No-op on platforms without native window effects
        Ok(())
    }

    fn normalize_modifier(key: &str) -> &'static str {
        match key {
            "cmd" | "command" | "meta" => "Control", // Map Cmd to Ctrl on non-macOS
            "ctrl" | "control" => "Control",
            "alt" | "option" => "Alt",
            "shift" => "Shift",
            _ => "Control", // fallback for unknown modifiers
        }
    }

    fn default_scale_factor() -> f64 {
        1.0 // Standard DPI
    }
}

// Platform abstraction types — used by all platform implementations and window_layout.
// All coordinates and sizes are in LOGICAL pixels unless explicitly noted.

use std::path::Path;

/// A rectangle in logical coordinates.
#[derive(Debug, Clone, Copy)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl LogicalRect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    /// Right edge (x + width)
    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    /// Bottom edge (y + height)
    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }
}

/// Screen information with both total and usable (work) areas.
#[derive(Debug, Clone)]
pub struct ScreenInfo {
    /// Total screen size (including system UI like menu bar, taskbar, dock)
    pub total: LogicalRect,
    /// Usable work area (excluding system UI)
    pub work_area: LogicalRect,
    /// Display scale factor (e.g., 2.0 for Retina, 1.0 for standard)
    pub scale_factor: f64,
}

/// Raw screenshot data in BGRA pixel format.
#[derive(Debug, Clone)]
pub struct ScreenshotData {
    /// Raw BGRA pixel data (4 bytes per pixel)
    pub bgra: Vec<u8>,
    /// Image width in physical pixels
    pub width: u32,
    /// Image height in physical pixels
    pub height: u32,
}

/// Window visual effect types.
#[derive(Debug, Clone)]
pub enum WindowEffect {
    /// macOS vibrancy (NSVisualEffectMaterial::FullScreenUI with given corner radius)
    Vibrancy { radius: f64 },
    /// Windows 11 Mica effect  
    Mica,
    /// Windows 10/11 Acrylic effect
    Acrylic,
    /// No special effect (transparent or opaque fallback)
    None,
}

/// Trait that each platform module must implement.
/// All coordinates are in logical pixels.
pub trait PlatformProvider: Send + Sync {
    /// Get screen information for the display containing the given point,
    /// or the primary display if no point is specified.
    /// The `monitor` parameter provides Tauri's raw monitor data.
    fn screen_info_from_monitor(
        monitor_size_physical: (u32, u32),
        monitor_position_physical: (i32, i32),
        scale_factor: f64,
    ) -> ScreenInfo;

    /// Capture the main screen. Returns raw BGRA pixel data.
    fn capture_screen() -> Result<ScreenshotData, String>;

    /// Write screenshot data to a BMP preview file.
    fn write_preview(data: &ScreenshotData, path: &Path) -> Result<(), String>;

    /// Apply a visual effect (vibrancy/mica/acrylic) to a window.
    fn apply_window_effect(window: &tauri::WebviewWindow, effect: &WindowEffect) -> Result<(), String>;

    /// Remove any visual effect from a window.
    fn clear_window_effect(window: &tauri::WebviewWindow) -> Result<(), String>;

    /// Normalize a modifier key name for the current platform.
    /// e.g., "cmd" → "Command" on macOS, "Control" on Windows/Linux.
    fn normalize_modifier(key: &str) -> &'static str;

    /// Default scale factor fallback when no monitor info is available.
    /// macOS Retina → 2.0, others → 1.0.
    fn default_scale_factor() -> f64;
}

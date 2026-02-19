// Centralized window layout engine.
// All computations use logical coordinates exclusively.
// Platform-specific work-area information comes from `platform::PlatformProvider`.

use crate::platform::{Platform, PlatformProvider, ScreenInfo};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64};
use std::sync::Mutex;

// ============ Constants ============

/// Sidebar width in logical pixels (matches frontend w-64 = 256px)
pub const SIDEBAR_WIDTH: f64 = 256.0;

/// Minimum visible pixels when clamping to screen edge
const MIN_VISIBLE: f64 = 50.0;

/// Gap between character and chat windows (logical px)
const CHAT_CHARACTER_GAP: f64 = 20.0;

/// Vertical offset for chat relative to character bottom-alignment
const CHAT_VERTICAL_OFFSET: f64 = 80.0;

/// Margin from screen edges for default positioning
const EDGE_MARGIN: f64 = 20.0;

/// Bottom margin for character window (additional clearance above work-area bottom)
const CHAR_BOTTOM_MARGIN: f64 = 10.0;

// ============ Window State ============

/// Global window state — replaces scattered static variables in lib.rs
pub struct WindowState {
    pub sidebar_expanded: AtomicBool,
    pub original_width: AtomicU32,
    pub chat_follows_character: AtomicBool,
    pub saved_chat_position: Mutex<Option<(f64, f64)>>,
    pub saved_chat_size: Mutex<Option<(f64, f64)>>,
    pub screenshot_cache: Mutex<Option<(Vec<u8>, u32, u32)>>,
    pub pending_restore_windows: Mutex<Vec<String>>,
    pub pending_character_id: Mutex<Option<String>>,
    /// Epoch millis until which chat position sync should be skipped.
    /// Set after show_chat_window to prevent Moved events from snapping chat.
    pub skip_chat_sync_until: AtomicU64,
    /// Last known character position (logical px * 10 for sub-pixel precision).
    /// Used to filter spurious Moved events on XWayland.
    pub last_char_x: AtomicI32,
    pub last_char_y: AtomicI32,
}

impl WindowState {
    pub fn new() -> Self {
        Self {
            sidebar_expanded: AtomicBool::new(false),
            original_width: AtomicU32::new(0),
            chat_follows_character: AtomicBool::new(true),
            saved_chat_position: Mutex::new(None),
            saved_chat_size: Mutex::new(None),
            screenshot_cache: Mutex::new(None),
            pending_restore_windows: Mutex::new(Vec::new()),
            pending_character_id: Mutex::new(None),
            skip_chat_sync_until: AtomicU64::new(0),
            last_char_x: AtomicI32::new(i32::MIN),
            last_char_y: AtomicI32::new(i32::MIN),
        }
    }
}

// ============ Screen Info Helper ============

/// Extract ScreenInfo from a Tauri monitor object via the Platform abstraction.
pub fn screen_info_from_tauri_monitor(monitor: &tauri::Monitor) -> ScreenInfo {
    let size = monitor.size();
    let pos = monitor.position();
    Platform::screen_info_from_monitor(
        (size.width, size.height),
        (pos.x, pos.y),
        monitor.scale_factor(),
    )
}

// ============ Baseline Sizes ============

/// Baseline logical sizes for each window at the "medium" preset.
pub struct BaselineSize {
    pub width: f64,
    pub height: f64,
}

pub fn get_baseline_sizes() -> HashMap<&'static str, BaselineSize> {
    let mut sizes = HashMap::new();
    sizes.insert("character", BaselineSize { width: 200.0, height: 300.0 });
    sizes.insert("chat", BaselineSize { width: 500.0, height: 400.0 });
    sizes.insert("manage", BaselineSize { width: 640.0, height: 680.0 });
    sizes
}

pub fn get_scale_factor_for_preset(preset: &str) -> f64 {
    match preset {
        "small" => 0.9,
        "medium" => 1.0,
        "large" => 1.15,
        _ => 1.0,
    }
}

// ============ Layout Functions ============

/// Calculate the bottom-right position for the character window within the work area.
/// Returns (x, y) in logical coordinates.
pub fn position_character_bottom_right(
    screen: &ScreenInfo,
    char_width: f64,
    char_height: f64,
) -> (f64, f64) {
    let x = screen.work_area.right() - char_width - EDGE_MARGIN;
    let y = screen.work_area.bottom() - char_height - CHAR_BOTTOM_MARGIN;
    (x.max(screen.work_area.x), y.max(screen.work_area.y))
}

/// Calculate chat window position relative to character window.
/// Chat sits to the left of character, bottom-aligned with vertical offset.
/// Returns (x, y) in logical coordinates.
pub fn position_chat_relative_to_character(
    char_x: f64,
    char_y: f64,
    char_height: f64,
    chat_width: f64,
    chat_height: f64,
) -> (f64, f64) {
    let char_bottom = char_y + char_height;
    let chat_x = char_x - chat_width - CHAT_CHARACTER_GAP;
    let chat_y = char_bottom - chat_height - CHAT_VERTICAL_OFFSET;
    (chat_x.max(0.0), chat_y.max(0.0))
}

/// Calculate the screen-center position for the manage/settings window.
/// Returns (x, y) in logical coordinates.
pub fn position_manage_center(
    screen: &ScreenInfo,
    manage_width: f64,
    manage_height: f64,
) -> (f64, f64) {
    let x = screen.work_area.x + (screen.work_area.width - manage_width) / 2.0;
    let y = screen.work_area.y + (screen.work_area.height - manage_height) / 2.0;
    (x.max(screen.work_area.x), y.max(screen.work_area.y))
}

/// Clamp a window position so that at least `MIN_VISIBLE` pixels remain on screen.
/// All parameters and return values are in logical coordinates.
pub fn clamp_to_work_area(
    screen: &ScreenInfo,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> (f64, f64, bool) {
    let mut new_x = x;
    let mut new_y = y;
    let mut changed = false;

    let wa = &screen.work_area;

    // Left boundary: ensure right edge is at least MIN_VISIBLE into work area
    if x + width < wa.x + MIN_VISIBLE {
        new_x = wa.x;
        changed = true;
    }
    // Right boundary: ensure left edge doesn't go past work area right - MIN_VISIBLE
    if x > wa.right() - MIN_VISIBLE {
        new_x = wa.right() - width;
        changed = true;
    }
    // Top boundary: don't go above work area top
    if y < wa.y {
        new_y = wa.y;
        changed = true;
    }
    // Bottom boundary: ensure top stays above wa.bottom - MIN_VISIBLE
    if y + height > wa.bottom() + MIN_VISIBLE {
        new_y = wa.bottom() - height;
        changed = true;
    }

    (new_x, new_y, changed)
}

/// Calculate sidebar expand/collapse window geometry changes.
/// Returns (new_x, new_width) for the chat window.
pub fn sidebar_expand(
    current_x: f64,
    current_width: f64,
) -> (f64, f64) {
    let new_x = current_x - SIDEBAR_WIDTH;
    let new_width = current_width + SIDEBAR_WIDTH;
    (new_x, new_width)
}

pub fn sidebar_collapse(
    current_x: f64,
    original_width: f64,
    current_width: f64,
) -> (f64, f64) {
    let new_x = current_x + SIDEBAR_WIDTH;
    let new_width = if original_width > 0.0 { original_width } else { current_width - SIDEBAR_WIDTH };
    (new_x, new_width)
}

/// Apply a size preset to get the target (width, height) for a given window.
pub fn apply_size_preset(
    window_label: &str,
    preset: &str,
) -> Option<(f64, f64)> {
    let baselines = get_baseline_sizes();
    let scale = get_scale_factor_for_preset(preset);
    baselines.get(window_label).map(|b| {
        ((b.width * scale).round(), (b.height * scale).round())
    })
}

/// Normalize a shortcut string for the current platform.
/// Converts modifier names (cmd→Command/Control) and capitalizes key names.
pub fn normalize_shortcut(shortcut: &str) -> String {
    shortcut
        .split('+')
        .map(|part| {
            let lowered = part.trim().to_lowercase();
            match lowered.as_str() {
                "ctrl" | "control" => "Control".to_string(),
                "cmd" | "command" | "meta" => Platform::normalize_modifier("cmd").to_string(),
                "alt" | "option" => "Alt".to_string(),
                "shift" => "Shift".to_string(),
                "space" => "Space".to_string(),
                "escape" | "esc" => "Escape".to_string(),
                "enter" | "return" => "Enter".to_string(),
                "tab" => "Tab".to_string(),
                "backspace" => "Backspace".to_string(),
                "delete" | "del" => "Delete".to_string(),
                other => {
                    let mut chars = other.chars();
                    match chars.next() {
                        Some(c) => c.to_uppercase().chain(chars).collect(),
                        None => String::new(),
                    }
                }
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// Check if cursor is within a window's bounds.
/// All parameters should be in the same coordinate space (physical or logical).
pub fn is_cursor_in_window(
    cursor_x: f64,
    cursor_y: f64,
    window_x: f64,
    window_y: f64,
    window_width: f64,
    window_height: f64,
) -> bool {
    cursor_x >= window_x
        && cursor_x <= window_x + window_width
        && cursor_y >= window_y
        && cursor_y <= window_y + window_height
}

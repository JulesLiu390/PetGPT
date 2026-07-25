// Centralized window layout engine.
// All computations use logical coordinates exclusively.
// Platform-specific work-area information comes from `platform::PlatformProvider`.

use crate::platform::{LogicalRect, Platform, PlatformProvider, ScreenInfo};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64};
use std::sync::Mutex;

// ============ Constants ============

/// Sidebar width in logical pixels (matches frontend w-64 = 256px)
pub const SIDEBAR_WIDTH: f64 = 256.0;

/// Native minimum height used by the regular, full chat window.
pub const CHAT_FULL_MIN_HEIGHT: f64 = 300.0;

/// The compact composer may report a taller preferred height as its textarea
/// or attachment tray grows, but it must never collapse below this floor.
pub const CHAT_COMPACT_MIN_HEIGHT: f64 = 96.0;

/// Safe fallback before the frontend has measured the compact composer.
pub const CHAT_COMPACT_DEFAULT_HEIGHT: f64 = 132.0;

/// Clearance between the compact composer window and the usable screen edge.
pub const CHAT_COMPACT_BOTTOM_MARGIN: f64 = 16.0;

/// Horizontal clearance used when a chat window must fit inside a work area.
pub const CHAT_WORK_AREA_MARGIN: f64 = 20.0;

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
    /// Whether the chat is currently showing only the empty composer.
    pub chat_compact: AtomicBool,
    /// Last frontend-measured compact height in logical pixels.
    pub chat_compact_height: Mutex<f64>,
    /// Full-window geometry captured before entering compact mode. This is
    /// intentionally separate from the maximize/restore snapshot below.
    pub chat_full_geometry: Mutex<Option<WindowGeometry>>,
    /// Native presentation state to restore after leaving compact mode.
    pub chat_full_was_maximized: AtomicBool,
    pub chat_full_was_fullscreen: AtomicBool,
    pub chat_full_character_was_visible: AtomicBool,
    /// Serializes compact/full native mutations so rapid frontend height and
    /// mode updates cannot interleave their geometry snapshots.
    pub chat_layout_transition: Mutex<()>,
    /// Latest frontend layout request applied or admitted. Older IPC calls may
    /// arrive late; they must never overwrite a newer full/compact decision.
    pub chat_layout_request_id: AtomicU64,
    pub saved_chat_position: Mutex<Option<(f64, f64)>>,
    pub saved_chat_size: Mutex<Option<(f64, f64)>>,
    pub screenshot_cache: Mutex<Option<(Vec<u8>, u32, u32)>>,
    pub pending_restore_windows: Mutex<Vec<String>>,
    pub pending_character_id: Mutex<Option<String>>,
    /// Epoch millis until which chat position sync should be skipped.
    /// Set after show_chat_window to prevent Moved events from snapping chat.
    pub skip_chat_sync_until: AtomicU64,
    /// Monotonic id attached to chat activation events so the frontend can
    /// refocus the composer even when visibility itself did not change.
    pub chat_focus_request_id: AtomicU64,
    /// Last known character position (logical px * 10 for sub-pixel precision).
    /// Used to filter spurious Moved events on XWayland.
    pub last_char_x: AtomicI32,
    pub last_char_y: AtomicI32,
    /// Content-driven minimum chat width (logical px), reported by the
    /// frontend from measuring the input toolbar. None until first report.
    pub chat_min_width: Mutex<Option<f64>>,
    /// Last applied window-size preset ("small" | "medium" | "large").
    /// Kept so a later min-width report can re-derive the preset width.
    pub chat_size_preset: Mutex<String>,
}

impl WindowState {
    pub fn new() -> Self {
        Self {
            sidebar_expanded: AtomicBool::new(false),
            original_width: AtomicU32::new(0),
            chat_follows_character: AtomicBool::new(true),
            chat_compact: AtomicBool::new(false),
            chat_compact_height: Mutex::new(CHAT_COMPACT_DEFAULT_HEIGHT),
            chat_full_geometry: Mutex::new(None),
            chat_full_was_maximized: AtomicBool::new(false),
            chat_full_was_fullscreen: AtomicBool::new(false),
            chat_full_character_was_visible: AtomicBool::new(true),
            chat_layout_transition: Mutex::new(()),
            chat_layout_request_id: AtomicU64::new(0),
            saved_chat_position: Mutex::new(None),
            saved_chat_size: Mutex::new(None),
            screenshot_cache: Mutex::new(None),
            pending_restore_windows: Mutex::new(Vec::new()),
            pending_character_id: Mutex::new(None),
            skip_chat_sync_until: AtomicU64::new(0),
            chat_focus_request_id: AtomicU64::new(0),
            last_char_x: AtomicI32::new(i32::MIN),
            last_char_y: AtomicI32::new(i32::MIN),
            chat_min_width: Mutex::new(None),
            chat_size_preset: Mutex::new("medium".to_string()),
        }
    }
}

/// A window rectangle expressed entirely in logical coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// ============ Screen Info Helper ============

/// Extract ScreenInfo from a Tauri monitor object via the Platform abstraction.
pub fn screen_info_from_tauri_monitor(monitor: &tauri::Monitor) -> ScreenInfo {
    let size = monitor.size();
    let pos = monitor.position();
    let work_area = monitor.work_area();
    let scale_factor = monitor.scale_factor().max(f64::EPSILON);
    ScreenInfo {
        total: LogicalRect::new(
            pos.x as f64 / scale_factor,
            pos.y as f64 / scale_factor,
            size.width as f64 / scale_factor,
            size.height as f64 / scale_factor,
        ),
        work_area: LogicalRect::new(
            work_area.position.x as f64 / scale_factor,
            work_area.position.y as f64 / scale_factor,
            work_area.size.width as f64 / scale_factor,
            work_area.size.height as f64 / scale_factor,
        ),
        scale_factor,
    }
}

// ============ Baseline Sizes ============

/// Baseline logical sizes for each window at the "medium" preset.
pub struct BaselineSize {
    pub width: f64,
    pub height: f64,
}

/// Character dimensions are 1.3× the previous 200×300 logical baseline.
pub const CHARACTER_BASELINE_WIDTH: f64 = 260.0;
pub const CHARACTER_BASELINE_HEIGHT: f64 = 390.0;
pub const CHARACTER_MIN_WIDTH: f64 = 234.0;
pub const CHARACTER_MIN_HEIGHT: f64 = 351.0;

pub fn get_baseline_sizes() -> HashMap<&'static str, BaselineSize> {
    let mut sizes = HashMap::new();
    sizes.insert("character", BaselineSize {
        width: CHARACTER_BASELINE_WIDTH,
        height: CHARACTER_BASELINE_HEIGHT,
    });
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

/// Hard floor for the chat window's content-driven min width.
/// Matches `minWidth` for the chat window in tauri.conf.json.
pub const CHAT_MIN_WIDTH_FLOOR: f64 = 460.0;

/// Chat window width scale per preset, applied to the content-driven minimum
/// width: small IS the minimum; medium/large grow proportionally from it.
pub fn get_chat_width_scale_for_preset(preset: &str) -> f64 {
    match preset {
        "small" => 1.0,
        "medium" => 1.15,
        "large" => 1.3,
        _ => 1.15,
    }
}

/// Target chat width for a preset, derived from the reported content minimum
/// (falls back to the hard floor before any report arrives).
pub fn compute_chat_width(content_min_width: Option<f64>, preset: &str) -> f64 {
    let min_w = content_min_width
        .unwrap_or(CHAT_MIN_WIDTH_FLOOR)
        .max(CHAT_MIN_WIDTH_FLOOR);
    (min_w * get_chat_width_scale_for_preset(preset)).round()
}

/// Clamp the compact composer to the supplied work area. The reported height
/// may be non-finite during a transient DOM measurement; use the stable
/// fallback in that case.
pub fn compute_chat_compact_size(
    content_min_width: Option<f64>,
    requested_height: f64,
    screen: &ScreenInfo,
) -> (f64, f64) {
    let max_width = (screen.work_area.width - CHAT_WORK_AREA_MARGIN * 2.0).max(1.0);
    let max_height = (screen.work_area.height - CHAT_WORK_AREA_MARGIN * 2.0).max(1.0);
    let width = content_min_width
        .unwrap_or(CHAT_MIN_WIDTH_FLOOR)
        .max(CHAT_MIN_WIDTH_FLOOR)
        .min(max_width);
    let requested_height = if requested_height.is_finite() && requested_height > 0.0 {
        requested_height
    } else {
        CHAT_COMPACT_DEFAULT_HEIGHT
    };
    let height = requested_height
        .max(CHAT_COMPACT_MIN_HEIGHT.min(max_height))
        .min(max_height);
    (width.round(), height.round())
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
    // Monitor origins may be negative when a display sits to the left of or
    // above the primary display. The caller owns work-area clamping because it
    // also knows which monitor the character is on.
    (chat_x, chat_y)
}

/// Center the compact composer at the bottom of the current work area.
/// Unlike the legacy relative-to-character helper, this deliberately retains
/// negative monitor origins used by displays placed left of the primary one.
pub fn position_chat_bottom_center(
    screen: &ScreenInfo,
    chat_width: f64,
    chat_height: f64,
) -> (f64, f64) {
    let x = screen.work_area.x + (screen.work_area.width - chat_width) / 2.0;
    let y = screen.work_area.bottom() - chat_height - CHAT_COMPACT_BOTTOM_MARGIN;
    (x.max(screen.work_area.x), y.max(screen.work_area.y))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::LogicalRect;

    fn screen_with_work_area(x: f64, y: f64, width: f64, height: f64) -> ScreenInfo {
        let rect = LogicalRect::new(x, y, width, height);
        ScreenInfo {
            total: rect,
            work_area: rect,
            scale_factor: 1.0,
        }
    }

    #[test]
    fn character_presets_use_the_enlarged_minimum() {
        assert_eq!(
            apply_size_preset("character", "small"),
            Some((CHARACTER_MIN_WIDTH, CHARACTER_MIN_HEIGHT))
        );
        assert_eq!(
            apply_size_preset("character", "medium"),
            Some((260.0, 390.0))
        );
        assert_eq!(
            apply_size_preset("character", "large"),
            Some((299.0, 448.0))
        );
    }

    #[test]
    fn compact_chat_uses_content_floor_and_measured_height() {
        let screen = screen_with_work_area(0.0, 24.0, 1440.0, 876.0);
        assert_eq!(
            compute_chat_compact_size(Some(420.0), 118.4, &screen),
            (460.0, 118.0)
        );
        assert_eq!(
            compute_chat_compact_size(Some(510.0), f64::NAN, &screen),
            (510.0, CHAT_COMPACT_DEFAULT_HEIGHT)
        );
    }

    #[test]
    fn compact_chat_size_stays_inside_small_work_area() {
        let screen = screen_with_work_area(0.0, 0.0, 400.0, 120.0);
        assert_eq!(
            compute_chat_compact_size(Some(800.0), 500.0, &screen),
            (360.0, 80.0)
        );
    }

    #[test]
    fn compact_chat_bottom_center_preserves_negative_monitor_origin() {
        let screen = screen_with_work_area(-1920.0, 23.0, 1920.0, 1057.0);
        assert_eq!(
            position_chat_bottom_center(&screen, 460.0, 132.0),
            (-1190.0, 932.0)
        );
    }

    #[test]
    fn chat_relative_to_character_preserves_negative_monitor_coordinates() {
        assert_eq!(
            position_chat_relative_to_character(-180.0, 500.0, 390.0, 460.0, 400.0),
            (-660.0, 410.0)
        );
    }

    #[test]
    fn relative_chat_clamps_against_the_negative_target_work_area() {
        let screen = screen_with_work_area(-1920.0, -1080.0, 1920.0, 1080.0);
        let (x, y) =
            position_chat_relative_to_character(-100.0, -300.0, 390.0, 460.0, 400.0);
        assert_eq!(clamp_to_work_area(&screen, x, y, 460.0, 400.0), (x, y, false));
    }
}

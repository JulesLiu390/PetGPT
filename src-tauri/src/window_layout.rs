// Centralized window layout engine.
// All computations use logical coordinates exclusively.
// Platform-specific work-area information comes from `platform::PlatformProvider`.

use crate::platform::{LogicalRect, Platform, PlatformProvider, ScreenInfo};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, AtomicU64};
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
    /// Whether the native chat background effect is enabled. The compact and
    /// full layouts use different corner radii, so transitions need to know
    /// whether it is safe to refresh that effect.
    pub chat_vibrancy_enabled: AtomicBool,
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
    /// Whether the visible chat session was summoned as a large dialog
    /// (character or dock icon) rather than as a quick-ask bubble (hotkey).
    ///
    /// Only large sessions write back `chatLargeGeometry` when hidden. Without
    /// this distinction, hiding a quick-ask session would persist the small
    /// window as the remembered large size.
    pub chat_opened_as_large: AtomicBool,
    /// Whether the chat window currently holds focus. Drives the character's
    /// always-on-top state: a focused large chat must be able to cover the
    /// character, but the character should float above other apps again as
    /// soon as the chat is not the window being used.
    pub chat_focused: AtomicBool,
    /// 聊天窗最近一次失去焦点的时刻（毫秒）。仍有焦点时为 0。
    ///
    /// 点小人这个动作本身就会把焦点从聊天窗夺走，所以判断「聊天窗是不是本来
    /// 在最前面」不能只看当前焦点 —— 那样永远是「否」，大窗就再也关不掉了。
    /// 靠「刚刚才失焦」把这次点击引起的失焦和「早就被别的 app 盖住」区分开。
    pub chat_focus_lost_at: AtomicI64,
}

impl WindowState {
    pub fn new() -> Self {
        Self {
            sidebar_expanded: AtomicBool::new(false),
            original_width: AtomicU32::new(0),
            chat_follows_character: AtomicBool::new(true),
            chat_compact: AtomicBool::new(false),
            chat_vibrancy_enabled: AtomicBool::new(true),
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
            chat_opened_as_large: AtomicBool::new(false),
            chat_focused: AtomicBool::new(false),
            chat_focus_lost_at: AtomicI64::new(0),
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

/// Interpolate a native window frame while keeping all values in logical
/// coordinates. Progress is clamped so delayed animation ticks can never
/// overshoot the final restore geometry.
pub fn interpolate_window_geometry(
    start: WindowGeometry,
    end: WindowGeometry,
    progress: f64,
) -> WindowGeometry {
    let progress = if progress.is_finite() {
        progress.clamp(0.0, 1.0)
    } else {
        1.0
    };
    let interpolate = |from: f64, to: f64| from + (to - from) * progress;
    WindowGeometry {
        x: interpolate(start.x, end.x),
        y: interpolate(start.y, end.y),
        width: interpolate(start.width, end.width),
        height: interpolate(start.height, end.height),
    }
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

/// How much of the usable work area a large chat window takes.
///
/// Deliberately short of the full area: the window stays a real, draggable,
/// resizable window rather than a maximized one, so the user can still reach
/// whatever is behind it.
pub const LARGE_CHAT_WORK_AREA_RATIO: f64 = 0.85;

/// Width below which the chat window cannot show its full UI.
///
/// The sidebar only auto-reveals at Tailwind's `lg` breakpoint (1024px), and a
/// project tab needs 776px of main area on top of the 256px sidebar to dock
/// its Files panel. 1040 clears both, so a large window always opens with the
/// whole interface visible instead of a bare message column.
pub const CHAT_FULL_UI_MIN_WIDTH: f64 = 1040.0;

/// Height below which the full UI gets uncomfortably cramped once the title
/// bar, message area and composer are all stacked.
pub const CHAT_FULL_UI_MIN_HEIGHT: f64 = 700.0;

/// Fit a remembered window size onto the current screen.
///
/// The remembered size is honoured as-is: only the *first* summon defaults to
/// a large full-UI window, after that whatever size the user left behind is
/// what they get back. The only adjustment is clamping to the screen, for the
/// case where the size was recorded on a larger display.
///
/// Deliberately no full-UI floor here. Forcing a remembered 900px window back
/// up to 1040px reads as the app fighting the user's own resize.
pub fn fit_remembered_chat_size(width: f64, height: f64, screen: &ScreenInfo) -> (f64, f64) {
    let area = &screen.work_area;
    (
        width.max(CHAT_MIN_WIDTH_FLOOR).min(area.width),
        height.max(CHAT_FULL_MIN_HEIGHT).min(area.height),
    )
}

/// Whether the chat window is currently wide enough to be the full-UI layout.
///
/// Keyed on the window's *actual* width rather than on how it was summoned:
/// after the first launch a chat-intent summon restores whatever size the user
/// left behind, which is often a small window. Deciding pinning and character
/// layering from the intent would then pin the wrong thing.
pub fn is_full_ui_chat(width: f64) -> bool {
    width >= CHAT_FULL_UI_MIN_WIDTH
}

/// What clicking the character should do to the chat window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatSummonAction {
    /// 窗口是隐藏的：按意图打开它
    Show,
    /// 窗口在最前面：收起它
    Hide,
    /// 窗口开着但被别的 app 盖住了：抬到前台，**不**改置顶状态
    Raise,
}

/// 点小人时，刚失焦多久以内仍算「聊天窗本来在最前面」。
///
/// 点小人会先把焦点交给角色窗口，聊天窗的 Focused(false) 紧接着就到；
/// 这个窗口期用来把那次失焦和「早就被 Chrome 盖住」区分开。
pub const CHAT_RECENT_FOCUS_LOSS_MS: i64 = 400;

/// 决定点小人（或点图标）时对聊天窗做什么。
///
/// 只有**全 UI 大窗**才有「被盖住」这个状态 —— 小窗是置顶的浮层，永远在最
/// 前面，所以它只有显示/隐藏两种。
pub fn chat_summon_action(
    visible: bool,
    is_full_ui: bool,
    focused: bool,
    ms_since_focus_lost: i64,
) -> ChatSummonAction {
    if !visible {
        return ChatSummonAction::Show;
    }
    if !is_full_ui {
        return ChatSummonAction::Hide;
    }
    // 本来就在最前面（还持有焦点，或焦点刚被这次点击夺走）→ 收起
    if focused || (ms_since_focus_lost >= 0 && ms_since_focus_lost <= CHAT_RECENT_FOCUS_LOSS_MS) {
        return ChatSummonAction::Hide;
    }
    ChatSummonAction::Raise
}

/// Whether the chat window should stay above other apps.
///
/// A small window is a companion overlay sitting next to the pet, so it floats.
/// A full-UI window is something the user works inside, so other apps must be
/// able to cover it. `pinned_when_large` is the user's explicit preference and
/// overrides the full-UI rule.
pub fn chat_should_pin(is_full_ui: bool, pinned_when_large: bool) -> bool {
    !is_full_ui || pinned_when_large
}

/// Whether the chat window should track the character window's position.
///
/// A large, full-UI window is something the user places and works in, so
/// dragging the pet must not drag it around. Only the small and compact
/// layouts stay tethered to the character.
pub fn chat_should_follow_character(follow_preference: bool, chat_is_large: bool) -> bool {
    follow_preference && !chat_is_large
}

/// Geometry for a large (but not maximized) chat window, centered in the
/// screen's usable area.
///
/// `work_area` already excludes the menu bar and Dock on macOS, so the result
/// never lands under system UI.
pub fn large_chat_geometry(screen: &ScreenInfo, min_width: f64, min_height: f64) -> WindowGeometry {
    let ratio = LARGE_CHAT_WORK_AREA_RATIO;
    let area = &screen.work_area;
    let width = (area.width * ratio).max(min_width).min(area.width);
    let height = (area.height * ratio).max(min_height).min(area.height);
    WindowGeometry {
        x: area.x + (area.width - width) / 2.0,
        y: area.y + (area.height - height) / 2.0,
        width,
        height,
    }
}

/// Whether the character window should currently sit above other apps.
///
/// macOS maps always-on-top onto two absolute window levels (floating 3 vs
/// normal 0), and level ordering beats focus order, so a floating character
/// can never be covered by a normal-level window. The only way to let a large
/// chat window cover the character while still letting other apps cover that
/// chat window is to drop the character to the normal level for exactly as
/// long as the chat is the window being used.
pub fn character_should_float(
    chat_visible: bool,
    chat_is_large: bool,
    chat_focused: bool,
    chat_pinned_while_large: bool,
) -> bool {
    // A pinned large chat stays on the floating level itself, so both windows
    // share a level and focus order already puts the chat in front. Dropping
    // the character there would push it below other apps for no benefit.
    if chat_pinned_while_large {
        return true;
    }
    !(chat_visible && chat_is_large && chat_focused)
}

/// Baseline logical sizes for each window at the "medium" preset.
pub struct BaselineSize {
    pub width: f64,
    pub height: f64,
}

/// Character dimensions are 1.3× the previous 200×300 logical baseline.
pub const CHARACTER_BASELINE_WIDTH: f64 = 260.0;
pub const CHARACTER_BASELINE_HEIGHT: f64 = 390.0;
pub const CHARACTER_MIN_WIDTH: f64 = 195.0;
pub const CHARACTER_MIN_HEIGHT: f64 = 293.0;

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

/// Character presets deliberately use a wider range than interface windows.
/// This keeps the choices visually distinct without scaling the rest of the UI.
pub fn get_character_scale_factor_for_preset(preset: &str) -> f64 {
    match preset {
        "small" => 0.75,
        "medium" => 1.0,
        "large" => 1.35,
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
    let scale = if window_label == "character" {
        get_character_scale_factor_for_preset(preset)
    } else {
        get_scale_factor_for_preset(preset)
    };
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
    fn character_presets_are_visually_distinct() {
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
            Some((351.0, 527.0))
        );
        assert!(get_character_scale_factor_for_preset("medium")
            - get_character_scale_factor_for_preset("small") >= 0.25);
        assert!(get_character_scale_factor_for_preset("large")
            - get_character_scale_factor_for_preset("medium") >= 0.35);
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
    fn window_geometry_interpolation_clamps_and_reaches_the_restore_frame() {
        let start = WindowGeometry {
            x: 490.0,
            y: 700.0,
            width: 460.0,
            height: 104.0,
        };
        let end = WindowGeometry {
            x: 820.0,
            y: 360.0,
            width: 529.0,
            height: 400.0,
        };
        assert_eq!(interpolate_window_geometry(start, end, -1.0), start);
        assert_eq!(interpolate_window_geometry(start, end, 1.0), end);
        assert_eq!(interpolate_window_geometry(start, end, f64::NAN), end);
        assert_eq!(
            interpolate_window_geometry(start, end, 0.5),
            WindowGeometry {
                x: 655.0,
                y: 530.0,
                width: 494.5,
                height: 252.0,
            }
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

#[cfg(test)]
mod large_chat_and_character_level_tests {
    use super::*;
    use crate::platform::{LogicalRect, ScreenInfo};

    fn screen(x: f64, y: f64, w: f64, h: f64) -> ScreenInfo {
        ScreenInfo {
            total: LogicalRect::new(x, y, w, h + 60.0),
            work_area: LogicalRect::new(x, y, w, h),
            scale_factor: 2.0,
        }
    }

    #[test]
    fn a_large_chat_window_is_centered_and_stops_short_of_the_work_area() {
        let geo = large_chat_geometry(&screen(0.0, 25.0, 1440.0, 875.0), 460.0, 300.0);
        assert_eq!(geo.width, 1440.0 * 0.85);
        assert_eq!(geo.height, 875.0 * 0.85);
        // 居中：两侧留白相等
        assert_eq!(geo.x, (1440.0 - geo.width) / 2.0);
        assert_eq!(geo.y, 25.0 + (875.0 - geo.height) / 2.0);
        // 不是最大化：四周都还留有空隙
        assert!(geo.width < 1440.0 && geo.height < 875.0);
    }

    #[test]
    fn the_work_area_offset_is_respected_so_the_window_clears_system_ui() {
        // 副屏 + 菜单栏占位：work_area 的原点不是 (0,0)
        let geo = large_chat_geometry(&screen(1440.0, 25.0, 1920.0, 1055.0), 460.0, 300.0);
        assert!(geo.x >= 1440.0, "不能跑到主屏上去");
        assert!(geo.y >= 25.0, "不能压在菜单栏下面");
        assert!(geo.x + geo.width <= 1440.0 + 1920.0);
        assert!(geo.y + geo.height <= 25.0 + 1055.0);
    }

    #[test]
    fn a_large_window_always_opens_wide_enough_for_the_whole_interface() {
        // 侧边栏在 1024px 才自动出现，project 标签的 Files 面板还要 776+256。
        // 屏幕够大时 85% 本来就超过下限。
        let big = large_chat_geometry(
            &screen(0.0, 25.0, 1920.0, 1055.0),
            CHAT_FULL_UI_MIN_WIDTH,
            CHAT_FULL_UI_MIN_HEIGHT,
        );
        assert!(big.width >= CHAT_FULL_UI_MIN_WIDTH);
        assert!(big.height >= CHAT_FULL_UI_MIN_HEIGHT);
        assert_eq!(big.width, 1920.0 * 0.85);

        // 屏幕偏小时，全 UI 下限接管，而不是退回 460px 那种连侧边栏都没有的宽度
        let modest = large_chat_geometry(
            &screen(0.0, 25.0, 1180.0, 760.0),
            CHAT_FULL_UI_MIN_WIDTH,
            CHAT_FULL_UI_MIN_HEIGHT,
        );
        assert_eq!(modest.width, CHAT_FULL_UI_MIN_WIDTH, "1180*0.85=1003 < 1040");
        assert_eq!(modest.height, CHAT_FULL_UI_MIN_HEIGHT, "760*0.85=646 < 700");
        assert!(modest.x >= 0.0 && modest.y >= 25.0, "仍要留在可视区内");
    }

    #[test]
    fn the_full_ui_floor_clears_both_layout_breakpoints() {
        // 侧边栏断点 1024 + project 视图需要的 256 侧栏 + 776 主区
        assert!(CHAT_FULL_UI_MIN_WIDTH >= 1024.0);
        assert!(CHAT_FULL_UI_MIN_WIDTH >= 256.0 + 776.0);
    }

    #[test]
    fn a_remembered_size_is_returned_as_the_user_left_it() {
        let scr = screen(0.0, 25.0, 1920.0, 1055.0);
        assert_eq!(fit_remembered_chat_size(1400.0, 900.0, &scr), (1400.0, 900.0));
        // 用户主动缩小过就尊重它 —— 只有首次开窗才默认大窗。
        // 强行顶回全 UI 下限会让人觉得应用在跟自己的拖动对抗。
        assert_eq!(fit_remembered_chat_size(700.0, 420.0, &scr), (700.0, 420.0));
        // 但不能小于窗口本身的最小尺寸
        assert_eq!(
            fit_remembered_chat_size(100.0, 100.0, &scr),
            (CHAT_MIN_WIDTH_FLOOR, CHAT_FULL_MIN_HEIGHT),
        );
        // 换到小屏幕上时不能超出可视区
        let small = screen(0.0, 25.0, 1180.0, 760.0);
        assert_eq!(fit_remembered_chat_size(1800.0, 1200.0, &small), (1180.0, 760.0));
    }

    #[test]
    fn full_ui_is_decided_by_the_actual_width_not_by_how_the_window_was_summoned() {
        assert!(is_full_ui_chat(CHAT_FULL_UI_MIN_WIDTH));
        assert!(is_full_ui_chat(1600.0));
        assert!(!is_full_ui_chat(CHAT_FULL_UI_MIN_WIDTH - 1.0));
        assert!(!is_full_ui_chat(500.0));
    }

    #[test]
    fn a_hidden_chat_window_is_shown() {
        assert_eq!(chat_summon_action(false, true, false, 99_999), ChatSummonAction::Show);
        assert_eq!(chat_summon_action(false, false, false, 99_999), ChatSummonAction::Show);
    }

    #[test]
    fn a_buried_full_ui_window_is_raised_rather_than_hidden() {
        // 大窗开着但早就被别的 app 盖住了：点小人该把它抬上来
        assert_eq!(
            chat_summon_action(true, true, false, 30_000),
            ChatSummonAction::Raise,
        );
    }

    #[test]
    fn a_full_ui_window_that_was_frontmost_is_hidden_not_raised() {
        // 关键场景：点小人这个动作本身会夺走聊天窗的焦点，紧接着 Focused(false)
        // 就到了。若只看「当前有没有焦点」，结论永远是「被盖住」，大窗就再也
        // 关不掉。靠「刚刚才失焦」把这次点击造成的失焦识别出来。
        assert_eq!(
            chat_summon_action(true, true, false, 50),
            ChatSummonAction::Hide,
        );
        // 还持有焦点时同样是收起
        assert_eq!(chat_summon_action(true, true, true, 0), ChatSummonAction::Hide);
    }

    #[test]
    fn the_recent_focus_loss_window_has_a_boundary() {
        assert_eq!(
            chat_summon_action(true, true, false, CHAT_RECENT_FOCUS_LOSS_MS),
            ChatSummonAction::Hide,
        );
        assert_eq!(
            chat_summon_action(true, true, false, CHAT_RECENT_FOCUS_LOSS_MS + 1),
            ChatSummonAction::Raise,
        );
    }

    #[test]
    fn a_small_pinned_window_only_toggles_because_it_is_never_buried() {
        // 小窗是置顶浮层，没有「被盖住」这个状态
        assert_eq!(chat_summon_action(true, false, false, 99_999), ChatSummonAction::Hide);
        assert_eq!(chat_summon_action(true, false, true, 0), ChatSummonAction::Hide);
    }

    #[test]
    fn a_negative_elapsed_time_does_not_count_as_recent() {
        // 时钟回拨不该让「被盖住的窗口」被误判成「刚失焦」
        assert_eq!(chat_summon_action(true, true, false, -5_000), ChatSummonAction::Raise);
    }

    #[test]
    fn a_small_window_floats_and_a_full_ui_window_does_not() {
        // 小窗是贴在小人旁边的浮层，要压在别的 app 之上
        assert!(chat_should_pin(false, false));
        // 全 UI 窗口是用来干活的，其它 app 必须能盖住它
        assert!(!chat_should_pin(true, false));
    }

    #[test]
    fn the_user_preference_can_pin_even_a_full_ui_window() {
        assert!(chat_should_pin(true, true));
        assert!(chat_should_pin(false, true));
    }

    #[test]
    fn a_large_chat_window_is_not_dragged_around_by_the_character() {
        // 全 UI 大窗是用户自己摆好、在里面干活的窗口，拖小人不该带走它
        assert!(!chat_should_follow_character(true, true));
        // 小窗和紧凑气泡仍然跟着小人
        assert!(chat_should_follow_character(true, false));
        // 用户关掉了跟随偏好，那两种情况都不跟
        assert!(!chat_should_follow_character(false, false));
        assert!(!chat_should_follow_character(false, true));
    }

    #[test]
    fn a_tiny_screen_still_gets_at_least_the_window_minimums() {
        // 85% 会小于窗口最小尺寸时，最小尺寸优先
        let geo = large_chat_geometry(&screen(0.0, 0.0, 500.0, 320.0), 460.0, 300.0);
        assert_eq!(geo.width, 460.0);
        assert_eq!(geo.height, 300.0);
    }

    #[test]
    fn a_screen_smaller_than_the_minimums_never_produces_an_oversized_window() {
        let geo = large_chat_geometry(&screen(0.0, 0.0, 400.0, 250.0), 460.0, 300.0);
        assert_eq!(geo.width, 400.0, "不能超出屏幕宽度");
        assert_eq!(geo.height, 250.0);
    }

    #[test]
    fn the_character_floats_whenever_the_chat_is_not_the_window_in_use() {
        // 聊天窗不可见
        assert!(character_should_float(false, true, true, false));
        // 可见但是小窗
        assert!(character_should_float(true, false, true, false));
        // 大窗但没有焦点：小人要回到浮动层，压在其它 app 之上
        assert!(character_should_float(true, true, false, false));
    }

    #[test]
    fn only_a_focused_large_chat_drops_the_character_off_the_floating_level() {
        assert!(!character_should_float(true, true, true, false));
    }

    #[test]
    fn a_pinned_large_chat_leaves_the_character_floating() {
        // 用户开了「最大化时保持置顶」：两个窗口同层，焦点顺序已经能让
        // 聊天窗在前，把小人降下去只会让它掉到别的 app 后面。
        assert!(character_should_float(true, true, true, true));
        assert!(character_should_float(true, true, false, true));
    }
}

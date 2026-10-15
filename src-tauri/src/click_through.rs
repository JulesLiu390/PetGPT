//! Lets clicks on the empty, transparent parts of the character window reach whatever is behind it.
//! The page reports where the pet is drawn; the cursor poll compares the cursor with that region and
//! has the OS ignore the window everywhere else.
use serde::Deserialize;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::time::Instant;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// Cursor sampling while it is near the pet: quick enough that the window has switched before a
/// click can follow the cursor onto or off the pet.
const NEAR_INTERVAL: Duration = Duration::from_millis(30);
/// Farther away only hovering matters.
const FAR_INTERVAL: Duration = Duration::from_millis(100);
/// "Near" reaches this many CSS pixels past the window's edges.
const NEAR_MARGIN: f64 = 120.0;

/// A rectangle in the character window, in CSS pixels from its top-left corner.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl HitRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// The parts of the character window that catch the mouse. Until the page has measured them the
/// whole window does, so a failed measurement never leaves the pet impossible to grab.
#[derive(Default)]
pub struct HitRegion(Mutex<Option<Vec<HitRect>>>);

impl HitRegion {
    fn contains(&self, x: f64, y: f64) -> bool {
        let rects = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        rects
            .as_ref()
            .map_or(true, |rects| rects.iter().any(|rect| rect.contains(x, y)))
    }
}

/// Replaces the region; `None` has the whole window catch the mouse again.
#[tauri::command]
pub fn set_character_hit_region(
    window: WebviewWindow,
    region: State<'_, HitRegion>,
    rects: Option<Vec<HitRect>>,
) {
    if window.label() == "character" {
        *region.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = rects;
    }
}

/// Decides from cursor samples when the window should ignore the mouse.
#[derive(Default)]
struct Gate {
    ignoring: bool,
    button_was_down: bool,
    /// The window caught the press still held, so it keeps catching until release: a drag or click
    /// on the pet is never cut off halfway.
    holding: bool,
}

impl Gate {
    /// Returns the window's new state when it should change. `inside` is whether the cursor is in
    /// the window and `on_pet` whether it is over the region. Outside, the window catches the mouse,
    /// so a quick move onto the pet and a click cannot fall through before the next sample.
    fn update(&mut self, inside: bool, on_pet: bool, button_down: Option<bool>) -> Option<bool> {
        let down = button_down == Some(true);
        if down && !self.button_was_down {
            self.holding = inside && !self.ignoring;
        }
        self.button_was_down = down;
        let ignore = if down && self.holding {
            self.ignoring
        } else {
            inside && !on_pet
        };
        if ignore == self.ignoring {
            return None;
        }
        self.ignoring = ignore;
        Some(ignore)
    }
}

/// The cursor relative to a window's content, and the content's size, in CSS pixels.
struct CursorSample {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl CursorSample {
    fn within(&self, margin: f64) -> bool {
        self.x >= -margin
            && self.y >= -margin
            && self.x <= self.width + margin
            && self.y <= self.height + margin
    }
}

/// Follows the cursor over the character window: tells the page when it enters or leaves, and
/// switches click-through as the cursor crosses between the pet and the space around it.
pub struct CharacterPointer {
    over_window: bool,
    gate: Gate,
    /// Under Wayland, XWayland included, the cursor cannot be seen over other apps' windows, so a
    /// window ignoring the mouse could never tell when to catch it again. It stays clickable there.
    enabled: bool,
    #[cfg(target_os = "macos")]
    primary_scale: Option<(Instant, f64)>,
}

impl CharacterPointer {
    pub fn new() -> Self {
        #[cfg(target_os = "linux")]
        let enabled = !std::env::var("XDG_SESSION_TYPE")
            .unwrap_or_default()
            .to_lowercase()
            .contains("wayland");
        #[cfg(not(target_os = "linux"))]
        let enabled = true;
        Self {
            over_window: false,
            gate: Gate::default(),
            enabled,
            #[cfg(target_os = "macos")]
            primary_scale: None,
        }
    }

    /// Samples the cursor once and returns how long to wait before the next sample.
    pub fn poll(&mut self, app: &AppHandle) -> Duration {
        let Some(window) = app.get_webview_window("character") else {
            return FAR_INTERVAL;
        };
        let Some(cursor) = self.sample(&window) else {
            return FAR_INTERVAL;
        };
        let inside = cursor.within(0.0);
        if inside != self.over_window {
            self.over_window = inside;
            let _ = window.emit("mouse-over-character", inside);
        }
        if self.enabled {
            let on_pet = app
                .try_state::<HitRegion>()
                .map_or(true, |region| region.contains(cursor.x, cursor.y));
            let button_down = crate::drag_motion::primary_button_down();
            if let Some(ignore) = self.gate.update(inside, on_pet, button_down) {
                let _ = window.set_ignore_cursor_events(ignore);
            }
        }
        if cursor.within(NEAR_MARGIN) {
            NEAR_INTERVAL
        } else {
            FAR_INTERVAL
        }
    }

    fn sample(&mut self, window: &WebviewWindow) -> Option<CursorSample> {
        let cursor = window.cursor_position().ok()?;
        let origin = window.inner_position().ok()?;
        let size = window.inner_size().ok()?;
        let scale = window.scale_factor().ok()?;
        let cursor_scale = self.cursor_scale(window).unwrap_or(scale);
        Some(CursorSample {
            x: cursor.x / cursor_scale - f64::from(origin.x) / scale,
            y: cursor.y / cursor_scale - f64::from(origin.y) / scale,
            width: f64::from(size.width) / scale,
            height: f64::from(size.height) / scale,
        })
    }

    /// tao scales the macOS cursor by the primary display's factor rather than the window's, which
    /// differ when the pet sits on a second display. Looked up at most once a second.
    #[cfg(target_os = "macos")]
    fn cursor_scale(&mut self, window: &WebviewWindow) -> Option<f64> {
        if let Some((at, scale)) = self.primary_scale {
            if at.elapsed() < Duration::from_secs(1) {
                return Some(scale);
            }
        }
        let scale = window.primary_monitor().ok().flatten()?.scale_factor();
        self.primary_scale = Some((Instant::now(), scale));
        Some(scale)
    }

    #[cfg(not(target_os = "macos"))]
    fn cursor_scale(&mut self, _window: &WebviewWindow) -> Option<f64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PET: HitRect = HitRect {
        x: 100.0,
        y: 50.0,
        width: 80.0,
        height: 200.0,
    };

    fn region(rects: Option<Vec<HitRect>>) -> HitRegion {
        HitRegion(Mutex::new(rects))
    }

    #[test]
    fn the_whole_window_catches_the_mouse_until_the_pet_is_measured() {
        assert!(region(None).contains(5.0, 5.0));
        let measured = region(Some(vec![PET]));
        assert!(measured.contains(100.0, 50.0));
        assert!(measured.contains(179.9, 249.9));
        assert!(!measured.contains(180.0, 100.0));
        assert!(!measured.contains(5.0, 5.0));
        assert!(!region(Some(vec![])).contains(5.0, 5.0));
    }

    #[test]
    fn only_empty_parts_of_the_window_let_clicks_through() {
        let mut gate = Gate::default();
        assert_eq!(gate.update(false, false, Some(false)), None, "outside it keeps catching");
        assert_eq!(gate.update(true, false, Some(false)), Some(true), "empty space lets clicks through");
        assert_eq!(gate.update(true, false, Some(false)), None, "only changes are applied");
        assert_eq!(gate.update(true, true, Some(false)), Some(false), "the pet catches them");
        assert_eq!(gate.update(true, false, None), Some(true), "works where the button cannot be read");
        assert_eq!(gate.update(false, false, None), Some(false), "leaving the window catches again");
    }

    #[test]
    fn a_press_on_the_pet_keeps_the_window_catching_until_release() {
        let mut gate = Gate::default();
        assert_eq!(gate.update(true, true, Some(true)), None);
        assert_eq!(gate.update(true, false, Some(true)), None, "dragged off the pet while held");
        assert_eq!(gate.update(false, false, Some(true)), None);
        assert_eq!(gate.update(true, false, Some(false)), Some(true), "released over empty space");
    }

    #[test]
    fn a_press_the_window_never_caught_does_not_hold_it() {
        let mut gate = Gate::default();
        assert_eq!(gate.update(true, false, Some(false)), Some(true));
        // Pressed over empty space, so the app behind has the press; the pet still catches the mouse
        // as soon as the cursor is over it.
        assert_eq!(gate.update(true, false, Some(true)), None);
        assert_eq!(gate.update(true, true, Some(true)), Some(false));
        assert_eq!(gate.update(true, false, Some(true)), Some(true));

        // A press that began outside the window was another app's too.
        let mut gate = Gate::default();
        assert_eq!(gate.update(false, false, Some(true)), None);
        assert_eq!(gate.update(true, false, Some(true)), Some(true));
    }

    #[test]
    fn near_reaches_past_the_window_edges() {
        let cursor = |x, y| CursorSample { x, y, width: 260.0, height: 390.0 };
        assert!(cursor(0.0, 390.0).within(0.0));
        assert!(!cursor(-1.0, 100.0).within(0.0));
        assert!(cursor(-1.0, 100.0).within(NEAR_MARGIN));
        assert!(!cursor(260.0 + NEAR_MARGIN + 1.0, 100.0).within(NEAR_MARGIN));
    }
}

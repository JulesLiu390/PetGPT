//! Streams the character window's motion during a native drag, which drives the avatar's swing.
//! The webview receives no pointer events while the OS moves the window, so motion is sampled here.
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, WebviewWindow};

static SESSION: AtomicU64 = AtomicU64::new(0);
const SAMPLE_INTERVAL: Duration = Duration::from_millis(16);
// Only macOS can see the release; elsewhere the webview ends the drag on its next pointer event.
const IDLE_LIMIT: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize)]
struct Sample {
    x: f64,
    y: f64,
    /// Milliseconds since the drag started, so the frontend can ignore IPC jitter.
    t: f64,
    done: bool,
}

/// Logical position of whatever moves with the drag. macOS reports window moves only once a drag
/// ends, but the window is glued to the cursor, so follow the cursor there. Elsewhere use the window
/// itself: under a compositor grab XWayland stops seeing the pointer, but the window keeps moving.
fn position(window: &WebviewWindow) -> Option<(f64, f64)> {
    let sf = window.scale_factor().ok()?;
    #[cfg(target_os = "macos")]
    let (x, y) = window.cursor_position().ok().map(|p| (p.x, p.y))?;
    #[cfg(not(target_os = "macos"))]
    let (x, y) = window
        .outer_position()
        .ok()
        .map(|p| (f64::from(p.x), f64::from(p.y)))?;
    Some((x / sf, y / sf))
}

#[cfg(target_os = "macos")]
fn primary_button_released() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }
    // kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft
    !unsafe { CGEventSourceButtonState(0, 0) }
}

#[cfg(not(target_os = "macos"))]
fn primary_button_released() -> bool {
    false
}

#[tauri::command]
pub fn start_drag_motion(window: WebviewWindow) {
    let session = SESSION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let started = Instant::now();
        let emit = |(x, y): (f64, f64), done: bool| {
            let t = started.elapsed().as_secs_f64() * 1000.0;
            let _ = window.emit_to(window.label(), "drag-motion", Sample { x, y, t, done });
        };
        let mut last = None;
        let mut moved_at = Instant::now();
        while SESSION.load(Ordering::SeqCst) == session {
            if let Some(point) = position(&window) {
                if last != Some(point) {
                    last = Some(point);
                    moved_at = Instant::now();
                    emit(point, false);
                }
            }
            if primary_button_released() || moved_at.elapsed() > IDLE_LIMIT {
                // Announce only this session's own end; a superseded session stays silent.
                if SESSION
                    .compare_exchange(session, session + 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    emit(last.unwrap_or_default(), true);
                }
                return;
            }
            std::thread::sleep(SAMPLE_INTERVAL);
        }
    });
}

#[tauri::command]
pub fn stop_drag_motion() {
    SESSION.fetch_add(1, Ordering::SeqCst);
}

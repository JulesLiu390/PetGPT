// macOS platform implementation — uses Cocoa/CoreGraphics FFI for native capabilities.

use super::types::*;
use std::path::Path;

pub struct MacOSPlatform;

// ============ CoreGraphics / CoreFoundation FFI for screenshot ============

mod ffi {
    use std::ffi::c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGMainDisplayID() -> u32;
        pub fn CGDisplayCreateImage(display: u32) -> *mut c_void;
        pub fn CGImageGetWidth(image: *const c_void) -> usize;
        pub fn CGImageGetHeight(image: *const c_void) -> usize;
        pub fn CGImageGetBytesPerRow(image: *const c_void) -> usize;
        pub fn CGImageGetDataProvider(image: *const c_void) -> *const c_void;
        pub fn CGDataProviderCopyData(provider: *const c_void) -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFDataGetLength(data: *const c_void) -> isize;
        pub fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        pub fn CFRelease(cf: *const c_void);
    }
}

// ============ Cocoa FFI for NSScreen.visibleFrame ============

mod cocoa_ffi {
    use std::ffi::c_void;

    // NSScreen class methods
    extern "C" {
        pub fn objc_getClass(name: *const u8) -> *mut c_void;
        pub fn sel_registerName(name: *const u8) -> *mut c_void;
    }

    // NSRect is { origin: { x, y }, size: { width, height } } — 4 f64s
    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    pub struct NSRect {
        pub origin_x: f64,
        pub origin_y: f64,
        pub size_width: f64,
        pub size_height: f64,
    }

    extern "C" {
        // objc_msgSend for calls returning id (pointer)
        pub fn objc_msgSend(obj: *mut c_void, sel: *mut c_void, ...) -> *mut c_void;
    }

    // objc_msgSend variant for calls returning NSRect (struct)
    // On macOS x86_64, large structs are returned via objc_msgSend_stret.
    // On ARM64 (Apple Silicon), all structs go through regular objc_msgSend.
    #[cfg(target_arch = "aarch64")]
    extern "C" {
        #[link_name = "objc_msgSend"]
        pub fn objc_msgSend_stret(obj: *mut c_void, sel: *mut c_void, ...) -> NSRect;
    }

    #[cfg(target_arch = "x86_64")]
    extern "C" {
        pub fn objc_msgSend_stret(out: *mut NSRect, obj: *mut c_void, sel: *mut c_void, ...);
    }

    /// Get the visible frame of the main screen (excludes menu bar and Dock).
    /// Returns (x, y, width, height) in macOS screen coordinates (origin at bottom-left).
    pub fn get_main_screen_visible_frame() -> Option<NSRect> {
        unsafe {
            let ns_screen_class = objc_getClass(b"NSScreen\0".as_ptr());
            if ns_screen_class.is_null() {
                return None;
            }

            let main_screen_sel = sel_registerName(b"mainScreen\0".as_ptr());
            let main_screen: *mut c_void = objc_msgSend(ns_screen_class, main_screen_sel);
            if main_screen.is_null() {
                return None;
            }

            let visible_frame_sel = sel_registerName(b"visibleFrame\0".as_ptr());

            #[cfg(target_arch = "aarch64")]
            {
                let rect = objc_msgSend_stret(main_screen, visible_frame_sel);
                Some(rect)
            }

            #[cfg(target_arch = "x86_64")]
            {
                let mut rect = NSRect {
                    origin_x: 0.0,
                    origin_y: 0.0,
                    size_width: 0.0,
                    size_height: 0.0,
                };
                objc_msgSend_stret(&mut rect, main_screen, visible_frame_sel);
                Some(rect)
            }
        }
    }

    /// Get the full frame of the main screen (total resolution).
    pub fn get_main_screen_frame() -> Option<NSRect> {
        unsafe {
            let ns_screen_class = objc_getClass(b"NSScreen\0".as_ptr());
            if ns_screen_class.is_null() {
                return None;
            }

            let main_screen_sel = sel_registerName(b"mainScreen\0".as_ptr());
            let main_screen: *mut c_void = objc_msgSend(ns_screen_class, main_screen_sel);
            if main_screen.is_null() {
                return None;
            }

            let frame_sel = sel_registerName(b"frame\0".as_ptr());

            #[cfg(target_arch = "aarch64")]
            {
                let rect = objc_msgSend_stret(main_screen, frame_sel);
                Some(rect)
            }

            #[cfg(target_arch = "x86_64")]
            {
                let mut rect = NSRect {
                    origin_x: 0.0,
                    origin_y: 0.0,
                    size_width: 0.0,
                    size_height: 0.0,
                };
                objc_msgSend_stret(&mut rect, main_screen, frame_sel);
                Some(rect)
            }
        }
    }
}

// ============ BMP writer (zero-encoding) ============

/// Write BGRA pixel data as a BMP file. BMP natively stores BGRA so this is
/// a pure memcpy with a 54-byte header — zero encoding overhead.
// ============ PlatformProvider implementation ============

impl PlatformProvider for MacOSPlatform {
    fn screen_info_from_monitor(
        monitor_size_physical: (u32, u32),
        monitor_position_physical: (i32, i32),
        scale_factor: f64,
    ) -> ScreenInfo {
        // Total logical size from Tauri's monitor info
        let total_w = monitor_size_physical.0 as f64 / scale_factor;
        let total_h = monitor_size_physical.1 as f64 / scale_factor;
        let origin_x = monitor_position_physical.0 as f64 / scale_factor;
        let origin_y = monitor_position_physical.1 as f64 / scale_factor;

        let total = LogicalRect::new(origin_x, origin_y, total_w, total_h);

        // Try to get the real work area from NSScreen.visibleFrame
        let work_area = if let (Some(visible), Some(full)) = (
            cocoa_ffi::get_main_screen_visible_frame(),
            cocoa_ffi::get_main_screen_frame(),
        ) {
            // macOS coordinates have origin at bottom-left. Convert to top-left origin.
            // visible.origin_y is the distance from the bottom of the screen to the bottom
            // of the visible frame. We need to convert this to a top-left Y.
            //
            // top_inset (menu bar) = full.height - (visible.origin_y + visible.height)
            // bottom_inset (Dock when at bottom) = visible.origin_y - full.origin_y
            //
            // In top-left coordinate system:
            //   work_area.x = visible.origin_x (usually 0)
            //   work_area.y = origin_y + top_inset
            //   work_area.width = visible.size_width
            //   work_area.height = visible.size_height

            let top_inset = full.size_height - (visible.origin_y - full.origin_y + visible.size_height);
            let left_inset = visible.origin_x - full.origin_x;

            LogicalRect::new(
                origin_x + left_inset,
                origin_y + top_inset,
                visible.size_width,
                visible.size_height,
            )
        } else {
            // Fallback: assume 25px menu bar + 70px Dock (legacy behavior)
            LogicalRect::new(
                origin_x,
                origin_y + 25.0,
                total_w,
                total_h - 25.0 - 70.0,
            )
        };

        ScreenInfo {
            total,
            work_area,
            scale_factor,
        }
    }

    fn capture_screen() -> Result<ScreenshotData, String> {
        unsafe {
            let display_id = ffi::CGMainDisplayID();
            let cg_image = ffi::CGDisplayCreateImage(display_id);
            if cg_image.is_null() {
                return Err("CGDisplayCreateImage returned null (screen recording permission may be needed)".to_string());
            }

            let width = ffi::CGImageGetWidth(cg_image) as u32;
            let height = ffi::CGImageGetHeight(cg_image) as u32;
            let bytes_per_row = ffi::CGImageGetBytesPerRow(cg_image);

            let provider = ffi::CGImageGetDataProvider(cg_image);
            let cf_data = ffi::CGDataProviderCopyData(provider);
            if cf_data.is_null() {
                ffi::CFRelease(cg_image);
                return Err("Failed to get pixel data from CGImage".to_string());
            }

            let data_len = ffi::CFDataGetLength(cf_data) as usize;
            let data_ptr = ffi::CFDataGetBytePtr(cf_data);
            let raw_bytes = std::slice::from_raw_parts(data_ptr, data_len);

            let stride = width as usize * 4;
            let bgra = if bytes_per_row == stride {
                raw_bytes[..stride * height as usize].to_vec()
            } else {
                let mut buf = Vec::with_capacity(stride * height as usize);
                for y in 0..height as usize {
                    let row_start = y * bytes_per_row;
                    buf.extend_from_slice(&raw_bytes[row_start..row_start + stride]);
                }
                buf
            };

            ffi::CFRelease(cf_data);
            ffi::CFRelease(cg_image);

            Ok(ScreenshotData { bgra, width, height })
        }
    }

    fn write_preview(data: &ScreenshotData, path: &Path) -> Result<(), String> {
        super::bmp::write_bmp_file(path, &data.bgra, data.width, data.height)
    }

    fn apply_window_effect(window: &tauri::WebviewWindow, effect: &WindowEffect) -> Result<(), String> {
        match effect {
            WindowEffect::Vibrancy { radius } => {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                apply_vibrancy(
                    window,
                    NSVisualEffectMaterial::FullScreenUI,
                    Some(NSVisualEffectState::Active),
                    Some(*radius),
                )
                .map_err(|e| format!("Failed to apply vibrancy: {:?}", e))
            }
            _ => Ok(()), // Other effects not applicable on macOS
        }
    }

    fn clear_window_effect(window: &tauri::WebviewWindow) -> Result<(), String> {
        use window_vibrancy::clear_vibrancy;
        clear_vibrancy(window)
            .map(|_| ())
            .map_err(|e| format!("Failed to clear vibrancy: {:?}", e))
    }

    fn normalize_modifier(key: &str) -> &'static str {
        match key {
            "cmd" | "command" | "meta" => "Command",
            "ctrl" | "control" => "Control",
            "alt" | "option" => "Alt",
            "shift" => "Shift",
            _ => "Control", // fallback for unknown modifiers
        }
    }

    fn default_scale_factor() -> f64 {
        2.0 // Retina
    }
}

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // On GNOME Wayland, force XWayland so that outer_position() / set_position()
  // actually work. This is required for chat-follows-character and window
  // positioning. Only applies when running under a Wayland session.
  #[cfg(target_os = "linux")]
  {
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
    if session.contains("wayland") {
      std::env::set_var("GDK_BACKEND", "x11");
    }
  }

  app_lib::run();
}

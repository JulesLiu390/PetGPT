// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // On GNOME Wayland, force XWayland so that outer_position() / set_position()
  // actually work. This is required for chat-follows-character and window
  // positioning. Only applies when running under a Wayland session.
  #[cfg(target_os = "linux")]
  {
    // WebKitGTK's DMA-BUF renderer can fail to allocate GBM buffers with
    // NVIDIA (including XWayland), leaving otherwise running windows blank.
    // Shared-memory buffers avoid GBM. Disabling the renderer instead (the
    // legacy path) never clears transparent pixels, so anything moving in a
    // transparent window leaves trails. Set this before creating any WebViews;
    // preserve explicit user overrides.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
      && std::env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_none()
    {
      std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
    }
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
    if session.contains("wayland") {
      std::env::set_var("GDK_BACKEND", "x11");
    }
  }

  app_lib::run();
}

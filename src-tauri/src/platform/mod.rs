// Platform abstraction layer — selects the correct implementation based on target OS.
//
// Each platform module implements `PlatformProvider` from `types.rs`.
// The rest of the codebase uses `Platform` (the type alias) to call into the
// platform-specific code without any `#[cfg]` scattered around.

pub mod types;
pub mod bmp;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub mod fallback;

// Re-export the trait and types for convenience
pub use types::*;

// Type alias: the platform implementation selected at compile time
#[cfg(target_os = "macos")]
pub type Platform = macos::MacOSPlatform;

#[cfg(target_os = "linux")]
pub type Platform = linux::LinuxPlatform;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub type Platform = fallback::FallbackPlatform;

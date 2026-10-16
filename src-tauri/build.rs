fn main() {
  // screencapturekit's Swift bridge loads the Swift runtime through @rpath. Its own build script
  // adds the rpath, but link args from a dependency never reach our binaries, so add it here.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
  }
  tauri_build::build()
}

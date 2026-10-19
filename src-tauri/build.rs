fn main() {
    // Declaring the app's commands generates `allow-*` permissions, so the
    // capability file can grant them to the server-hosted (remote) page.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["copy_equation", "save_file", "open_file"]),
    ))
    .expect("failed to run tauri-build");
}

// Native open/save dialogs for .mmeq documents and image exports.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const MAX_OPEN_BYTES: u64 = 1_000_000;

#[derive(Serialize)]
pub struct OpenedFile {
    path: String,
    contents: String,
}

fn extension_refs(extensions: &[String]) -> Vec<&str> {
    extensions.iter().map(String::as_str).collect()
}

/// Ask where to save, then write either `text` or base64-decoded `base64`.
/// Returns the chosen path, or None when the user cancels.
#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    default_name: String,
    filter_name: String,
    extensions: Vec<String>,
    text: Option<String>,
    base64: Option<String>,
) -> Result<Option<String>, String> {
    let bytes = match (text, base64) {
        (Some(text), None) => text.into_bytes(),
        (None, Some(data)) => STANDARD.decode(data).map_err(|e| format!("Invalid file data: {e}"))?,
        _ => return Err("Provide exactly one of text or base64".into()),
    };
    let picked = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(&filter_name, &extension_refs(&extensions))
        .blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| format!("Unsupported save location: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

/// Ask for a text file and return its contents (at most 1 MB).
#[tauri::command]
pub async fn open_file(app: AppHandle, filter_name: String, extensions: Vec<String>) -> Result<Option<OpenedFile>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter(&filter_name, &extension_refs(&extensions))
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| format!("Unsupported file location: {e}"))?;
    let size = std::fs::metadata(&path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?.len();
    if size > MAX_OPEN_BYTES {
        return Err(format!("{} is larger than 1 MB", path.display()));
    }
    let contents = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read {} as text: {e}", path.display()))?;
    Ok(Some(OpenedFile { path: path.display().to_string(), contents }))
}

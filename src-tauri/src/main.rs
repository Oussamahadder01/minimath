// MiniMath desktop shell.
//
// The shell owns one child process: the Node app server (which in turn owns
// the license helper). It starts the server on an ephemeral loopback port,
// waits for its "MINIMATH_LISTENING <url>" line, and points the window at
// it. The server's stdin pipe is held open for the shell's lifetime; when
// the shell exits — cleanly or not — the pipe closes and the server shuts
// itself and the helper down.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
mod files;

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const STDERR_TAIL_LINES: usize = 20;
const WINDOW_ATTEMPTS: u32 = 5;

#[derive(Default)]
struct ServerProcess {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    origin: Mutex<Option<Url>>,
}

/// Turn `\\?\C:\dir` (extended-length form) into `C:\dir`; Node.js derives
/// module URLs from these paths, and the plain form is the one it expects.
fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

/// Directory holding bin/, src/, web/, node_modules/ … (the Node side of the app).
fn app_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("MINIMATH_ROOT") {
        return Ok(PathBuf::from(root));
    }
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
    }
    app.path()
        .resource_dir()
        .map(|dir| plain_path(dir.join("app")))
        .map_err(|e| format!("Cannot locate bundled resources: {e}"))
}

/// Node.js to run the server with: explicit override, bundled copy, or PATH.
fn node_binary(app: &AppHandle) -> PathBuf {
    if let Ok(node) = std::env::var("MINIMATH_NODE") {
        return PathBuf::from(node);
    }
    if let Ok(dir) = app.path().resource_dir() {
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        let bundled = plain_path(dir.join("node").join(name));
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from("node")
}

fn spawn_server(app: &AppHandle) -> Result<(Child, Url), String> {
    let root = app_root(app)?;
    let node = node_binary(app);
    let script = root.join("bin").join("minimath-server.mjs");
    if !script.is_file() {
        return Err(format!("Server script not found at {}", script.display()));
    }
    let mut command = Command::new(&node);
    command
        .arg(&script)
        .current_dir(&root)
        .env("MINIMATH_PORT", "0")
        .env("MINIMATH_EXIT_ON_STDIN_CLOSE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start Node.js at {}: {e}\nInstall Node.js 22+ or set MINIMATH_NODE.", node.display()))?;

    let stdout = child.stdout.take().ok_or("Server stdout was not captured")?;
    let stderr = child.stderr.take().ok_or("Server stderr was not captured")?;
    let (ready_tx, ready_rx) = mpsc::channel::<String>();
    // Keep draining both pipes for the server's whole life so it never blocks.
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(url) = line.strip_prefix("MINIMATH_LISTENING ") {
                let _ = ready_tx.send(url.trim().to_string());
            }
        }
    });
    let recent_errors = Arc::new(Mutex::new(VecDeque::<String>::new()));
    let sink = Arc::clone(&recent_errors);
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("{line}");
            let mut lines = sink.lock().unwrap();
            if lines.len() == STDERR_TAIL_LINES {
                lines.pop_front();
            }
            lines.push_back(line);
        }
    });

    let failure = |child: &mut Child, reason: String| -> String {
        let _ = child.kill();
        let _ = child.wait();
        // Give the stderr reader a moment to collect the final lines.
        std::thread::sleep(Duration::from_millis(200));
        let tail: Vec<String> = recent_errors.lock().unwrap().iter().cloned().collect();
        if tail.is_empty() {
            reason
        } else {
            format!("{reason}\n\n{}", tail.join("\n"))
        }
    };

    match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
        Ok(url) => match Url::parse(&url) {
            Ok(url) if url.host_str() == Some("127.0.0.1") => Ok((child, url)),
            _ => Err(failure(&mut child, format!("Server reported an unexpected address: {url}"))),
        },
        // The stdout reader ended: the server exited before becoming ready.
        Err(RecvTimeoutError::Disconnected) => {
            let status = child.wait().map(|s| s.to_string()).unwrap_or_else(|e| e.to_string());
            Err(failure(&mut child, format!("The MiniMath server exited during startup ({status}).")))
        }
        Err(RecvTimeoutError::Timeout) => Err(failure(&mut child, "The MiniMath server did not start within 30 seconds.".into())),
    }
}

fn stop_server(app: &AppHandle) {
    let state = app.state::<ServerProcess>();
    // Closing stdin asks the server to stop the helper and exit.
    drop(state.stdin.lock().unwrap().take());
    let Some(mut child) = state.child.lock().unwrap().take() else { return };
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// macOS has no installer step, so the app registers its Word add-in itself:
/// Word for Mac loads every manifest in its container's `wef` folder (the
/// documented sideload location). Windows registration happens in the NSIS
/// installer (windows/hooks.nsh) instead, so uninstalling also removes it.
/// Additive and idempotent: the file is written only when absent or stale,
/// and nothing happens if Word has never run on this Mac.
#[cfg(target_os = "macos")]
fn register_word_addin(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let manifest = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("addin")
        .join("manifest.xml");
    if !manifest.is_file() {
        return Ok(None); // dev builds without a generated manifest
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let documents = home.join("Library/Containers/com.microsoft.Word/Data/Documents");
    if !documents.is_dir() {
        return Ok(None);
    }
    let contents = std::fs::read(&manifest).map_err(|e| format!("read {}: {e}", manifest.display()))?;
    let wef = documents.join("wef");
    let target = wef.join("minimath-manifest.xml");
    if std::fs::read(&target).ok().as_deref() == Some(contents.as_slice()) {
        return Ok(Some(target));
    }
    std::fs::create_dir_all(&wef).map_err(|e| format!("create {}: {e}", wef.display()))?;
    std::fs::write(&target, contents).map_err(|e| format!("write {}: {e}", target.display()))?;
    Ok(Some(target))
}

fn allowed_navigation(app: &AppHandle, url: &Url) -> bool {
    // The boot page (bundled assets) and the server's own origin only.
    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
        return true;
    }
    let origin = app.state::<ServerProcess>().origin.lock().unwrap().clone();
    matches!(origin, Some(o) if o.scheme() == url.scheme() && o.host_str() == url.host_str() && o.port() == url.port())
}

#[cfg(test)]
mod tests {
    use super::plain_path;
    use std::path::PathBuf;

    #[test]
    fn strips_extended_length_prefix_from_drive_paths_only() {
        assert_eq!(plain_path(PathBuf::from(r"\\?\C:\Apps\MiniMath")), PathBuf::from(r"C:\Apps\MiniMath"));
        assert_eq!(plain_path(PathBuf::from(r"\\?\UNC\server\share")), PathBuf::from(r"\\?\UNC\server\share"));
        assert_eq!(plain_path(PathBuf::from(r"C:\x")), PathBuf::from(r"C:\x"));
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerProcess::default())
        .invoke_handler(tauri::generate_handler![clipboard::copy_equation, files::save_file, files::open_file])
        .setup(|app| {
            let handle = app.handle().clone();
            // Creating the webview can fail transiently, e.g. while a previous
            // instance's WebView2 process still holds the profile. Retry, and
            // never exit without telling the user why.
            let mut attempt = 0;
            loop {
                let nav_handle = handle.clone();
                match WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("MiniMath")
                    .inner_size(1180.0, 880.0)
                    .min_inner_size(640.0, 480.0)
                    .on_navigation(move |url| allowed_navigation(&nav_handle, url))
                    .build()
                {
                    Ok(_) => break,
                    Err(error) if attempt < WINDOW_ATTEMPTS => {
                        attempt += 1;
                        eprintln!("MiniMath window creation failed (attempt {attempt}): {error}");
                        if let Some(partial) = handle.get_webview_window("main") {
                            let _ = partial.destroy();
                        }
                        std::thread::sleep(Duration::from_millis(500));
                    }
                    Err(error) => {
                        handle
                            .dialog()
                            .message(format!("MiniMath could not open its window:\n\n{error}"))
                            .title("MiniMath")
                            .kind(MessageDialogKind::Error)
                            .blocking_show();
                        return Err(error.into());
                    }
                }
            }

            #[cfg(target_os = "macos")]
            {
                let addin_handle = handle.clone();
                std::thread::spawn(move || match register_word_addin(&addin_handle) {
                    Ok(Some(path)) => eprintln!("Word add-in registered at {}", path.display()),
                    Ok(None) => {}
                    Err(error) => eprintln!("Word add-in not registered: {error}"),
                });
            }

            std::thread::spawn(move || {
                let window = handle.get_webview_window("main");
                match spawn_server(&handle) {
                    Ok((mut child, url)) => {
                        let state = handle.state::<ServerProcess>();
                        *state.stdin.lock().unwrap() = child.stdin.take();
                        *state.child.lock().unwrap() = Some(child);
                        *state.origin.lock().unwrap() = Some(url.clone());
                        if let Some(window) = window {
                            let _ = window.navigate(url);
                        }
                    }
                    Err(message) => {
                        if let Some(window) = window {
                            let script = format!("window.showStartupError({})", serde_json::to_string(&message).unwrap_or_default());
                            // The boot page may still be loading; retry briefly.
                            for _ in 0..20 {
                                if window.eval(&script).is_ok() {
                                    break;
                                }
                                std::thread::sleep(Duration::from_millis(250));
                            }
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the MiniMath shell");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_server(handle);
        }
    });
}

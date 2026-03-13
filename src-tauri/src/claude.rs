use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write as IoWrite};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

// ── Shell environment resolution ─────────────────────────────────────
// macOS .app bundles don't inherit shell env vars (ANTHROPIC_API_KEY, etc.)
// We capture the full login shell environment once and apply it to child processes.
// On Windows, the process already inherits the full environment, so we just collect it.

fn get_shell_env() -> &'static HashMap<String, String> {
    static CACHED_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    CACHED_ENV.get_or_init(|| {
        #[cfg(unix)]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            // Run login shell to dump the full environment
            if let Ok(output) = Command::new(&shell)
                .args(["-ilc", "env"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
            {
                if output.status.success() {
                    let mut env_map = HashMap::new();
                    let text = String::from_utf8_lossy(&output.stdout);
                    for line in text.lines() {
                        if let Some((key, value)) = line.split_once('=') {
                            // Skip problematic keys
                            if key.is_empty() || key.starts_with('_') || key == "PWD"
                                || key == "OLDPWD" || key == "SHLVL"
                                || key == "CLAUDECODE" {
                                continue;
                            }
                            env_map.insert(key.to_string(), value.to_string());
                        }
                    }
                    if !env_map.is_empty() {
                        return env_map;
                    }
                }
            }
            // Fallback: at least set a good PATH
            let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/user".to_string());
            let mut fallback = HashMap::new();
            fallback.insert("PATH".to_string(), format!(
                "/opt/homebrew/bin:/usr/local/bin:{}/.nvm/versions/node/default/bin:{}/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                home, home
            ));
            fallback.insert("HOME".to_string(), home);
            fallback
        }

        #[cfg(windows)]
        {
            // Windows: process already inherits the full environment from the shell.
            // However, when launched from GUI (not terminal), npm global path may not
            // be in PATH. We ensure %APPDATA%\npm and %LOCALAPPDATA%\pnpm are included.
            let mut env_map: HashMap<String, String> = std::env::vars().collect();
            env_map.remove("CLAUDECODE");

            // Ensure npm/pnpm global bin dirs are in PATH
            let mut extra_paths: Vec<String> = Vec::new();
            if let Ok(appdata) = std::env::var("APPDATA") {
                let npm_dir = format!("{}\\npm", appdata);
                extra_paths.push(npm_dir);
            }
            if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
                let pnpm_dir = format!("{}\\pnpm", localappdata);
                extra_paths.push(pnpm_dir);
            }
            if !extra_paths.is_empty() {
                let current_path = env_map.get("Path")
                    .or_else(|| env_map.get("PATH"))
                    .cloned()
                    .unwrap_or_default();
                let current_lower = current_path.to_lowercase();
                let missing: Vec<&String> = extra_paths.iter()
                    .filter(|p| !current_lower.contains(&p.to_lowercase()))
                    .collect();
                if !missing.is_empty() {
                    let new_path = format!("{};{}", current_path, missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(";"));
                    // Windows PATH key can be "Path" or "PATH" — update whichever exists
                    if env_map.contains_key("Path") {
                        env_map.insert("Path".to_string(), new_path);
                    } else {
                        env_map.insert("PATH".to_string(), new_path);
                    }
                }
            }

            env_map
        }
    })
}

fn command_with_path(program: &str) -> Command {
    // On Windows, wrap with `cmd /c` so that .cmd/.bat scripts (e.g. claude.cmd
    // from npm global install) are resolved via PATHEXT.
    // CREATE_NO_WINDOW (0x0800_0000) prevents a visible console window from
    // flashing on screen — without it every spawned cmd.exe briefly shows a
    // black terminal window which is jarring for GUI users.
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = Command::new("cmd");
        c.args(["/C", program]);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new(program);

    // Apply all shell env vars
    for (key, value) in get_shell_env() {
        cmd.env(key, value);
    }
    cmd.env_remove("CLAUDECODE");
    cmd
}

/// Canonicalize a path and strip the Windows `\\?\` extended-length prefix.
/// Node.js cannot handle `\\?\C:\...` paths — it misparses `C:` as a directory
/// and fails with `EISDIR: illegal operation on a directory, lstat 'C:'`.
fn clean_path(p: std::path::PathBuf) -> String {
    let resolved = p.canonicalize().unwrap_or(p);
    let s = resolved.to_string_lossy().to_string();
    // Strip \\?\ prefix that canonicalize() adds on Windows
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// Resolve the sidecar/bridge.mjs path.
/// In dev mode, it lives at `{project_root}/sidecar/bridge.mjs`.
/// In production, it's bundled (bridge.bundle.mjs) as a Tauri resource next to the binary.
fn resolve_bridge_path() -> Result<String, String> {
    let mut checked: Vec<String> = Vec::new();

    // 1. Development: unbundled file relative to CWD (tauri dev runs from project root)
    let dev_path = std::env::current_dir()
        .map(|p| p.join("sidecar").join("bridge.mjs"))
        .unwrap_or_default();
    checked.push(format!("cwd: {}", dev_path.display()));
    if dev_path.exists() {
        return Ok(clean_path(dev_path));
    }

    // 2. Paths relative to the executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // 2a. Dev fallback: exe is at src-tauri/target/debug/app(.exe),
            //     project root is three levels up.
            let dev_from_exe = parent.join("..").join("..").join("..").join("sidecar").join("bridge.mjs");
            checked.push(format!("dev(exe): {}", dev_from_exe.display()));
            if dev_from_exe.exists() {
                return Ok(clean_path(dev_from_exe));
            }

            // 2b. Production macOS: Binary is in ClaudeBox.app/Contents/MacOS/
            //     Tauri puts "../sidecar/bridge.bundle.mjs" at Resources/_up_/sidecar/bridge.bundle.mjs
            let mac_path = parent.join("..").join("Resources").join("_up_").join("sidecar").join("bridge.bundle.mjs");
            checked.push(format!("macOS: {}", mac_path.display()));
            if mac_path.exists() {
                return Ok(clean_path(mac_path));
            }

            // 2c. Production Windows / Linux: Tauri places "../sidecar/bridge.bundle.mjs"
            //     resource at {exe_dir}/_up_/sidecar/bridge.bundle.mjs
            let up_path = parent.join("_up_").join("sidecar").join("bridge.bundle.mjs");
            checked.push(format!("win/linux(_up_): {}", up_path.display()));
            if up_path.exists() {
                return Ok(clean_path(up_path));
            }

            // 2d. Flat fallback: bridge.bundle.mjs in the same directory as binary
            let same_dir = parent.join("bridge.bundle.mjs");
            checked.push(format!("flat: {}", same_dir.display()));
            if same_dir.exists() {
                return Ok(clean_path(same_dir));
            }
        }
    }

    Err(format!(
        "Cannot find sidecar/bridge.mjs. Checked paths:\n{}",
        checked.join("\n")
    ))
}

// ── Debug event helper ───────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct DebugEvent {
    pub session_id: String,
    pub level: String,
    pub message: String,
    pub timestamp: u64,
}

fn emit_debug(app: &AppHandle, session_id: &str, level: &str, message: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let _ = app.emit(
        "claude-debug",
        DebugEvent {
            session_id: session_id.to_string(),
            level: level.to_string(),
            message: message.to_string(),
            timestamp: ts,
        },
    );
}

// ── State ────────────────────────────────────────────────────────────

pub struct ProcessManager {
    /// frontend session id -> real claude session id (from stream-json output)
    claude_sessions: Arc<Mutex<HashMap<String, String>>>,
    /// frontend session id -> child PID (for stopping)
    running_pids: Arc<Mutex<HashMap<String, u32>>>,
    /// frontend session id -> child stdin handle (for sending responses)
    stdin_handles: Arc<Mutex<HashMap<String, ChildStdin>>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            claude_sessions: Arc::new(Mutex::new(HashMap::new())),
            running_pids: Arc::new(Mutex::new(HashMap::new())),
            stdin_handles: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct StreamPayload {
    pub session_id: String,
    pub data: String,
    pub done: bool,
    pub error: Option<String>,
    pub stream: String,
}

#[derive(Deserialize, Clone, Serialize)]
pub struct Attachment {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub file_type: String,
}

#[derive(Deserialize)]
pub struct SendMessageRequest {
    pub session_id: String,
    pub message: String,
    pub cwd: String,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    /// Kept for check_claude_installed but not used in sidecar mode
    #[allow(dead_code)]
    pub claude_path: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub attachments: Option<Vec<Attachment>>,
}

// ── Commands ─────────────────────────────────────────────────────────

/// Check whether the Claude CLI is reachable.
/// Runs `claude --version` in a background thread with a 10-second timeout so
/// that a slow PATH search on Windows can never freeze the UI at startup.
#[tauri::command]
pub async fn check_claude_installed(claude_path: Option<String>) -> Result<String, String> {
    let cmd = claude_path.unwrap_or_else(|| "claude".to_string());
    let cmd_for_err = cmd.clone();

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(command_with_path(&cmd).arg("--version").output());
    });

    match rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(output)) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        Ok(Ok(output)) => Err(format!(
            "claude CLI error: {}",
            String::from_utf8_lossy(&output.stderr)
        )),
        Ok(Err(e)) => Err(format!("claude CLI not found at '{}': {}", cmd_for_err, e)),
        Err(_) => Err(format!(
            "claude CLI check timed out (10s) — '{}' may not be installed or PATH is slow",
            cmd_for_err
        )),
    }
}

/// Send a message by spawning `node sidecar/bridge.mjs` with stdin piped.
/// The sidecar bridges the Agent SDK `query()` API and streams NDJSON back.
/// Uses --resume for multi-turn conversations.
#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    request: SendMessageRequest,
) -> Result<u32, String> {
    let session_id = request.session_id.clone();

    let bridge_path = resolve_bridge_path()?;
    emit_debug(&app, &session_id, "process", &format!("Sidecar: {}", bridge_path));

    // Build the "start" message for the sidecar
    let resume_id = {
        let sessions = state.claude_sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&session_id).cloned()
    };

    if let Some(ref rid) = resume_id {
        emit_debug(&app, &session_id, "info", &format!("--resume {}", rid));
    } else {
        emit_debug(&app, &session_id, "info", "First message (no --resume)");
    }

    let start_msg = serde_json::json!({
        "type": "start",
        "prompt": request.message,
        "cwd": request.cwd,
        "model": request.model.as_deref().unwrap_or(""),
        "resume": resume_id.as_deref().unwrap_or(""),
        "allowedTools": request.allowed_tools.as_deref().unwrap_or(&[]),
        "permissionMode": request.permission_mode.as_deref().unwrap_or(""),
        "attachments": request.attachments.as_deref().unwrap_or(&[]),
    });

    emit_debug(&app, &session_id, "process", &format!("$ node {} (start: prompt=\"{}\")",
        bridge_path,
        if request.message.chars().count() > 60 {
            format!("{}...", request.message.chars().take(60).collect::<String>())
        } else {
            request.message.clone()
        }
    ));
    emit_debug(&app, &session_id, "info", &format!("cwd: {}", request.cwd));

    let mut child = command_with_path("node")
        .arg(&bridge_path)
        .current_dir(&request.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped())
        // Override API key / base URL from settings if provided
        .envs(
            request.api_key.as_deref()
                .filter(|s| !s.is_empty())
                .map(|k| ("ANTHROPIC_API_KEY".to_string(), k.to_string()))
                .into_iter()
                .chain(
                    request.base_url.as_deref()
                        .filter(|s| !s.is_empty())
                        .map(|u| ("ANTHROPIC_BASE_URL".to_string(), u.to_string()))
                        .into_iter()
                )
        )
        // Ensure CLAUDECODE is never passed to child — prevents
        // "Cannot be launched inside another Claude Code session" error
        .env_remove("CLAUDECODE")
        .spawn()
        .map_err(|e| {
            let msg = format!("Failed to spawn node sidecar: {}", e);
            emit_debug(&app, &session_id, "error", &msg);
            msg
        })?;

    let pid = child.id();
    emit_debug(&app, &session_id, "process", &format!("Started PID {}", pid));

    // Write the start message to stdin
    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let start_line = format!("{}\n", start_msg);
    stdin.write_all(start_line.as_bytes()).map_err(|e| {
        let msg = format!("Failed to write start message: {}", e);
        emit_debug(&app, &session_id, "error", &msg);
        msg
    })?;
    stdin.flush().map_err(|e| e.to_string())?;
    emit_debug(&app, &session_id, "stdin", &start_line.trim().to_string());

    // Store stdin handle and PID
    {
        let mut pids = state.running_pids.lock().map_err(|e| e.to_string())?;
        pids.insert(session_id.clone(), pid);
    }
    {
        let mut handles = state.stdin_handles.lock().map_err(|e| e.to_string())?;
        handles.insert(session_id.clone(), stdin);
    }

    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    // Clone Arcs for background threads
    let sessions_arc = Arc::clone(&state.claude_sessions);
    let pids_arc = Arc::clone(&state.running_pids);
    let stdin_arc = Arc::clone(&state.stdin_handles);

    // stdout reader thread
    let app_out = app.clone();
    let sid_out = session_id.clone();
    let sessions_for_stdout = Arc::clone(&sessions_arc);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    emit_debug(&app_out, &sid_out, "stdout", &line);

                    // Extract real claude session_id from "system" init message
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                        if val.get("type").and_then(|t| t.as_str()) == Some("system") {
                            if let Some(sid) = val.get("session_id").and_then(|s| s.as_str()) {
                                emit_debug(&app_out, &sid_out, "info",
                                    &format!("Claude session_id: {}", sid));
                                if let Ok(mut sessions) = sessions_for_stdout.lock() {
                                    sessions.insert(sid_out.clone(), sid.to_string());
                                }
                            }
                        }
                    }

                    let payload = StreamPayload {
                        session_id: sid_out.clone(),
                        data: line,
                        done: false,
                        error: None,
                        stream: "stdout".to_string(),
                    };
                    let _ = app_out.emit("claude-stream", &payload);
                }
                Err(e) => {
                    emit_debug(&app_out, &sid_out, "error", &format!("stdout error: {}", e));
                    break;
                }
            }
        }

        // Process finished
        emit_debug(&app_out, &sid_out, "process", "Process exited (stdout closed)");
        let _ = app_out.emit("claude-stream", &StreamPayload {
            session_id: sid_out.clone(),
            data: String::new(),
            done: true,
            error: None,
            stream: "stdout".to_string(),
        });

        // Clean up PID and stdin handle
        if let Ok(mut pids) = pids_arc.lock() {
            pids.remove(&sid_out);
        }
        if let Ok(mut handles) = stdin_arc.lock() {
            handles.remove(&sid_out);
        }
    });

    // stderr reader thread
    let app_err = app.clone();
    let sid_err = session_id.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    emit_debug(&app_err, &sid_err, "stderr", &line);
                    let _ = app_err.emit("claude-stream", &StreamPayload {
                        session_id: sid_err.clone(),
                        data: line,
                        done: false,
                        error: None,
                        stream: "stderr".to_string(),
                    });
                }
                Err(_) => break,
            }
        }
    });

    Ok(pid)
}

/// Send a response to the sidecar (e.g. user answer for AskUserQuestion, plan approval).
/// Writes a JSON line to the child process's stdin.
#[tauri::command]
pub fn send_response(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    session_id: String,
    response: String,
) -> Result<(), String> {
    let mut handles = state.stdin_handles.lock().map_err(|e| e.to_string())?;
    if let Some(stdin) = handles.get_mut(&session_id) {
        let line = format!("{}\n", response.trim());
        emit_debug(&app, &session_id, "stdin", &line.trim().to_string());
        stdin.write_all(line.as_bytes()).map_err(|e| {
            format!("Failed to write response: {}", e)
        })?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("No active session for {}", session_id))
    }
}

/// Stop a running claude process
#[tauri::command]
pub fn stop_session(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    session_id: String,
) -> Result<(), String> {
    // Send abort message through stdin first for clean shutdown
    {
        let mut handles = state.stdin_handles.lock().map_err(|e| e.to_string())?;
        if let Some(stdin) = handles.get_mut(&session_id) {
            let abort_msg = "{\"type\":\"abort\"}\n";
            let _ = stdin.write_all(abort_msg.as_bytes());
            let _ = stdin.flush();
        }
        handles.remove(&session_id);
    }
    let mut pids = state.running_pids.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = pids.remove(&session_id) {
        emit_debug(&app, &session_id, "process", &format!("Killing PID {}", pid));
        #[cfg(unix)]
        unsafe { libc::kill(pid as i32, libc::SIGTERM); }
        #[cfg(windows)]
        {
            // Windows: use taskkill to terminate the process tree
            // CREATE_NO_WINDOW prevents console window flash
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
    }
    Ok(())
}

/// Get the current git branch for a directory
#[tauri::command]
pub fn get_git_branch(cwd: String) -> Result<String, String> {
    let output = command_with_path("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err("Not a git repository".to_string())
    }
}

/// Open a URL in the system default browser
#[tauri::command]
pub fn open_in_browser(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// List directory entries
#[derive(Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    let dir = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    for entry in dir.flatten() {
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    // Limit to 2MB to avoid memory issues
    if metadata.len() > 2 * 1024 * 1024 {
        return Err("File too large (>2MB)".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Read an image file and return a data: URL (base64).
/// Limited to 10MB. Returns `data:<mime>;base64,<data>`.
#[tauri::command]
pub fn read_image_base64(path: String) -> Result<String, String> {
    use base64::Engine as _;
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("Image too large (>10MB)".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mime = match path.rsplit('.').next().map(|s| s.to_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

// ── Persistent file storage ──────────────────────────────────────────
// Stores data in ~/.claudebox/data/ — stable across app updates,
// independent of Tauri WebView's localStorage (which has ~5MB limit
// and may be lost when the bundle identifier changes).

fn storage_dir() -> std::path::PathBuf {
    #[cfg(unix)]
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".to_string());
    std::path::PathBuf::from(home).join(".claudebox").join("data")
}

#[tauri::command]
pub fn storage_read(key: String) -> Result<Option<String>, String> {
    let path = storage_dir().join(format!("{}.json", key));
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_write(key: String, value: String) -> Result<(), String> {
    let dir = storage_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", key));
    std::fs::write(&path, value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_remove(key: String) -> Result<(), String> {
    let path = storage_dir().join(format!("{}.json", key));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write as IoWrite};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

// ── System proxy detection ──────────────────────────────────────────
// Detect system proxy on macOS (scutil --proxy) / Windows (registry).
//
// Key insight: HTTP CONNECT proxy (`http://host:port`) often fails in China
// due to GFW TLS fingerprinting (LibreSSL SSL_ERROR_SYSCALL). SOCKS5 with
// REMOTE DNS resolution (`socks5h://host:port`) works reliably because:
// 1. The TLS handshake goes through the encrypted SOCKS5 tunnel
// 2. DNS is resolved by the proxy server, bypassing GFW DNS pollution
//    (*.workers.dev domains get poisoned to wrong IPs locally)

/// Cached proxy URLs. Set by `apply_system_proxy` command.
static PROXY_HTTP: std::sync::LazyLock<Mutex<String>> =
    std::sync::LazyLock::new(|| Mutex::new(String::new()));
static PROXY_SOCKS: std::sync::LazyLock<Mutex<String>> =
    std::sync::LazyLock::new(|| Mutex::new(String::new()));

/// Detect system proxy settings from the OS.
/// Returns (http_proxy_url, socks_proxy_url) — either or both may be empty.
fn detect_system_proxy() -> (String, String) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("scutil")
            .arg("--proxy")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                return parse_scutil_proxy(&text);
            }
        }
        (String::new(), String::new())
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut http_proxy = String::new();
        if let Ok(output) = Command::new("reg")
            .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings", "/v", "ProxyEnable"])
            .stdout(Stdio::piped()).stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            let enabled = text.lines().any(|l| l.contains("ProxyEnable") && l.trim().ends_with("0x1"));
            if enabled {
                if let Ok(output2) = Command::new("reg")
                    .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings", "/v", "ProxyServer"])
                    .stdout(Stdio::piped()).stderr(Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                {
                    let text2 = String::from_utf8_lossy(&output2.stdout);
                    for line in text2.lines() {
                        if line.contains("ProxyServer") {
                            if let Some(val) = line.split_whitespace().last() {
                                let val = val.trim();
                                if !val.is_empty() {
                                    http_proxy = if val.contains("://") { val.to_string() } else { format!("http://{}", val) };
                                }
                            }
                        }
                    }
                }
            }
        }
        (http_proxy, String::new())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let http = std::env::var("http_proxy").or_else(|_| std::env::var("HTTP_PROXY")).unwrap_or_default();
        let socks = std::env::var("all_proxy").or_else(|_| std::env::var("ALL_PROXY")).unwrap_or_default();
        (http, socks)
    }
}

/// Parse macOS `scutil --proxy` output.
/// Returns (http_proxy_url, socks_proxy_url).
#[cfg(target_os = "macos")]
fn parse_scutil_proxy(text: &str) -> (String, String) {
    let get = |key: &str| -> Option<String> {
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with(key) {
                if let Some(val) = trimmed.split(':').last() {
                    let val = val.trim();
                    if !val.is_empty() && val != "0" {
                        return Some(val.to_string());
                    }
                }
            }
        }
        None
    };

    let mut http_url = String::new();
    if get("HTTPEnable").is_some() {
        if let (Some(host), Some(port)) = (get("HTTPProxy"), get("HTTPPort")) {
            http_url = format!("http://{}:{}", host, port);
        }
    }
    if http_url.is_empty() && get("HTTPSEnable").is_some() {
        if let (Some(host), Some(port)) = (get("HTTPSProxy"), get("HTTPSPort")) {
            http_url = format!("http://{}:{}", host, port);
        }
    }

    // socks5h:// = remote DNS resolution (proxy resolves DNS, bypasses GFW DNS pollution)
    // This is critical for domains like *.workers.dev whose DNS is poisoned in China.
    let mut socks_url = String::new();
    if get("SOCKSEnable").is_some() {
        if let (Some(host), Some(port)) = (get("SOCKSProxy"), get("SOCKSPort")) {
            socks_url = format!("socks5h://{}:{}", host, port);
        }
    }

    (http_url, socks_url)
}

/// Detect system proxy and apply as process-level env vars.
/// - Rust process: `ALL_PROXY=socks5h://...` so reqwest (Tauri updater) uses SOCKS5
/// - Child processes via command_with_path: `HTTP(S)_PROXY=http://...` for Node.js sidecar
/// Returns JSON: `{ "desc": "...", "changed": true/false }`
/// `changed` indicates whether the proxy config differs from the previous call.
#[derive(Clone, Serialize)]
pub struct ProxyStatus {
    pub desc: String,
    pub changed: bool,
}

#[tauri::command]
pub async fn apply_system_proxy() -> Result<ProxyStatus, String> {
    // Run blocking subprocess calls (reg query on Windows, scutil on macOS) on
    // a background thread so the async Tauri command handler is not stalled.
    let (tx, rx) = std::sync::mpsc::channel::<(String, String)>();
    std::thread::spawn(move || {
        let _ = tx.send(detect_system_proxy());
    });
    let (http, socks) = rx.recv_timeout(std::time::Duration::from_secs(5))
        .unwrap_or_default();

    // Check if changed compared to cached values
    let changed = {
        let prev_http = PROXY_HTTP.lock().ok().map(|h| h.clone()).unwrap_or_default();
        let prev_socks = PROXY_SOCKS.lock().ok().map(|s| s.clone()).unwrap_or_default();
        http != prev_http || socks != prev_socks
    };

    // Update cache
    if let Ok(mut h) = PROXY_HTTP.lock() { *h = http.clone(); }
    if let Ok(mut s) = PROXY_SOCKS.lock() { *s = socks.clone(); }

    // Apply env vars (always, to ensure consistency)
    if !socks.is_empty() {
        std::env::set_var("ALL_PROXY", &socks);
        std::env::set_var("all_proxy", &socks);
        std::env::remove_var("HTTPS_PROXY");
        std::env::remove_var("https_proxy");
    }
    if !http.is_empty() {
        std::env::set_var("HTTP_PROXY", &http);
        std::env::set_var("http_proxy", &http);
    }
    if socks.is_empty() && !http.is_empty() {
        std::env::set_var("HTTPS_PROXY", &http);
        std::env::set_var("https_proxy", &http);
        std::env::set_var("ALL_PROXY", &http);
        std::env::set_var("all_proxy", &http);
    }
    // If proxy was removed entirely, clear env vars
    if http.is_empty() && socks.is_empty() && changed {
        for key in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
            std::env::remove_var(key);
        }
    }

    let desc = match (http.is_empty(), socks.is_empty()) {
        (false, false) => format!("http={}, socks={}", http, socks),
        (false, true) => format!("http={}", http),
        (true, false) => format!("socks={}", socks),
        _ => String::new(),
    };
    Ok(ProxyStatus { desc, changed })
}

/// Probe a URL using curl (native — bypasses WebView CORS).
/// Uses SOCKS5 proxy if available (more reliable than HTTP CONNECT in China).
#[derive(Clone, Serialize)]
pub struct ProbeResult {
    pub url: String,
    pub ok: bool,
    pub status: i32,
    pub size: u64,
    pub time_ms: u64,
    pub version: String,
    pub error: String,
}

#[tauri::command]
pub async fn probe_url(url: String) -> Result<ProbeResult, String> {
    let url_clone = url.clone();
    let proxy = PROXY_SOCKS.lock().ok().filter(|s| !s.is_empty()).map(|s| s.clone())
        .or_else(|| PROXY_HTTP.lock().ok().filter(|s| !s.is_empty()).map(|s| s.clone()))
        .unwrap_or_default();

    let handle = std::thread::spawn(move || {
        let start = std::time::Instant::now();

        #[cfg(target_os = "macos")]
        let mut cmd = Command::new("/usr/bin/curl");
        #[cfg(target_os = "windows")]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let mut c = Command::new("curl");
            c.creation_flags(CREATE_NO_WINDOW);
            c
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut cmd = Command::new("curl");

        cmd.args(["-sS", "-f", "-L", "--max-time", "15"]);
        if !proxy.is_empty() {
            cmd.args(["--proxy", &proxy]);
        }
        cmd.arg(&url_clone);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let output = cmd.output();
        let elapsed_ms = start.elapsed().as_millis() as u64;

        match output {
            Ok(out) if out.status.success() => {
                let body = String::from_utf8_lossy(&out.stdout).to_string();
                let size = body.len() as u64;
                let mut version = String::new();
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    if let Some(v) = json.get("version").and_then(|v| v.as_str()) {
                        version = v.to_string();
                    }
                }
                ProbeResult { url: url_clone, ok: true, status: 200, size, time_ms: elapsed_ms, version, error: String::new() }
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let code = out.status.code().unwrap_or(-1);
                ProbeResult {
                    url: url_clone, ok: false, status: code, size: 0, time_ms: elapsed_ms, version: String::new(),
                    error: if stderr.is_empty() { format!("curl exit code {}", code) } else { stderr },
                }
            }
            Err(e) => ProbeResult { url: url_clone, ok: false, status: 0, size: 0, time_ms: elapsed_ms, version: String::new(), error: e.to_string() },
        }
    });

    handle.join().map_err(|_| "probe thread panicked".to_string())
}

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

pub fn command_with_path(program: &str) -> Command {
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

    // On Windows, always use the latest process Path (may have been updated by
    // check_node_version after a fresh Node.js install).
    #[cfg(windows)]
    {
        if let Ok(path) = std::env::var("Path") {
            cmd.env("Path", path);
        }
    }

    // Inject proxy env vars for child processes (Node.js sidecar).
    // Node.js/undici supports HTTP CONNECT proxy via HTTP_PROXY/HTTPS_PROXY.
    // Also set ALL_PROXY to SOCKS5 as fallback.
    if let Ok(http) = PROXY_HTTP.lock() {
        if !http.is_empty() {
            cmd.env("HTTP_PROXY", http.as_str());
            cmd.env("http_proxy", http.as_str());
            cmd.env("HTTPS_PROXY", http.as_str());
            cmd.env("https_proxy", http.as_str());
        }
    }
    if let Ok(socks) = PROXY_SOCKS.lock() {
        if !socks.is_empty() {
            cmd.env("ALL_PROXY", socks.as_str());
            cmd.env("all_proxy", socks.as_str());
        }
    }

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

/// Generic sidecar resolver — finds `dev_name` (dev mode) or `bundle_name` (production).
/// Used by lark.rs to locate lark-bot.mjs / lark-bot.bundle.mjs.
pub fn resolve_sidecar_path(dev_name: &str, bundle_name: &str) -> Result<String, String> {
    let mut checked: Vec<String> = Vec::new();

    // 1. Development: relative to CWD
    let dev_path = std::env::current_dir()
        .map(|p| p.join("sidecar").join(dev_name))
        .unwrap_or_default();
    checked.push(format!("cwd: {}", dev_path.display()));
    if dev_path.exists() {
        return Ok(clean_path(dev_path));
    }

    // 2. Paths relative to the executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Dev fallback
            let dev_from_exe = parent.join("..").join("..").join("..").join("sidecar").join(dev_name);
            checked.push(format!("dev(exe): {}", dev_from_exe.display()));
            if dev_from_exe.exists() {
                return Ok(clean_path(dev_from_exe));
            }

            // Production macOS
            let mac_path = parent.join("..").join("Resources").join("_up_").join("sidecar").join(bundle_name);
            checked.push(format!("macOS: {}", mac_path.display()));
            if mac_path.exists() {
                return Ok(clean_path(mac_path));
            }

            // Production Windows / Linux
            let up_path = parent.join("_up_").join("sidecar").join(bundle_name);
            checked.push(format!("win/linux(_up_): {}", up_path.display()));
            if up_path.exists() {
                return Ok(clean_path(up_path));
            }

            // Flat fallback
            let same_dir = parent.join(bundle_name);
            checked.push(format!("flat: {}", same_dir.display()));
            if same_dir.exists() {
                return Ok(clean_path(same_dir));
            }
        }
    }

    Err(format!(
        "Cannot find sidecar/{}. Checked paths:\n{}",
        dev_name,
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

pub fn emit_debug(app: &AppHandle, session_id: &str, level: &str, message: &str) {
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
    /// Claude session ID for --resume (persisted across app restarts by frontend)
    pub resume_id: Option<String>,
    /// UI locale — forwarded to sidecar for language-aware system prompt
    pub locale: Option<String>,
    /// Effort level: low / medium / high / max
    pub effort: Option<String>,
    /// Context window size: 200k / 1m
    pub context_window: Option<String>,
    /// Model tier defaults
    pub haiku_model: Option<String>,
    pub sonnet_model: Option<String>,
    pub opus_model: Option<String>,
}

// ── Commands ─────────────────────────────────────────────────────────

#[cfg(windows)]
fn decode_os_output(bytes: &[u8]) -> String {
    if let Ok(s) = String::from_utf8(bytes.to_vec()) {
        return s;
    }
    // cmd.exe uses the OEM code page — decode via MultiByteToWideChar
    extern "system" {
        fn GetOEMCP() -> u32;
        fn MultiByteToWideChar(
            cp: u32, flags: u32, src: *const u8, src_len: i32,
            dst: *mut u16, dst_len: i32,
        ) -> i32;
    }
    unsafe {
        let cp = GetOEMCP();
        let len = MultiByteToWideChar(cp, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0);
        if len <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        let mut wide = vec![0u16; len as usize];
        MultiByteToWideChar(cp, 0, bytes.as_ptr(), bytes.len() as i32, wide.as_mut_ptr(), len);
        String::from_utf16_lossy(&wide)
    }
}

#[cfg(not(windows))]
fn decode_os_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

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
        Ok(Ok(output)) => {
            let stderr = decode_os_output(&output.stderr);
            let stderr = stderr.trim();
            if stderr.is_empty() {
                Err(format!(
                    "claude CLI exited with code {}",
                    output.status.code().unwrap_or(-1)
                ))
            } else {
                Err(format!("claude CLI error: {}", stderr))
            }
        }
        Ok(Err(e)) => Err(format!("claude CLI not found at '{}': {}", cmd_for_err, e)),
        Err(_) => Err(format!(
            "claude CLI check timed out (10s) — '{}' may not be installed or PATH is slow",
            cmd_for_err
        )),
    }
}

/// On Windows, read the current PATH from the registry (system + user)
/// so we can find programs installed after ClaudeBox launched.
#[cfg(windows)]
fn fresh_windows_path() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let read_reg = |key: &str| -> Option<String> {
        let output = Command::new("reg")
            .args(["query", key, "/v", "Path"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .ok()?;
        let text = decode_os_output(&output.stdout);
        // reg output format: "    Path    REG_SZ    <value>" or "    Path    REG_EXPAND_SZ    <value>"
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("Path") || trimmed.starts_with("PATH") {
                // Split on REG_SZ or REG_EXPAND_SZ
                if let Some(pos) = trimmed.find("REG_") {
                    let after = &trimmed[pos..];
                    if let Some(val_start) = after.find("    ") {
                        return Some(after[val_start..].trim().to_string());
                    }
                }
            }
        }
        None
    };
    let sys = read_reg(r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment").unwrap_or_default();
    let user = read_reg(r"HKCU\Environment").unwrap_or_default();
    if sys.is_empty() && user.is_empty() {
        return None;
    }
    Some(format!("{};{}", sys, user))
}

/// Try running `node --version` with a custom PATH (used as fallback on Windows
/// after Node.js is freshly installed and the process PATH is stale).
#[cfg(windows)]
fn check_node_with_path(path: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    let output = Command::new("cmd")
        .args(["/C", "node", "--version"])
        .env("Path", path)
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

/// Check Node.js version. Returns the version string (e.g. "v22.3.0") on success.
#[tauri::command]
pub async fn check_node_version() -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(command_with_path("node").arg("--version").output());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(output)) if output.status.success() => {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
        _ => {}
    }

    // On Windows, retry with fresh PATH from registry (Node may have been
    // installed after ClaudeBox launched, so the cached process PATH is stale).
    #[cfg(windows)]
    {
        if let Some(fresh_path) = fresh_windows_path() {
            if let Some(ver) = check_node_with_path(&fresh_path) {
                // Update the process PATH so future calls (npm, claude) also work
                std::env::set_var("Path", &fresh_path);
                return Ok(ver);
            }
        }
        // Also try the default Node.js install location directly
        let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".to_string());
        let node_dir = format!(r"{}\nodejs", program_files);
        if std::path::Path::new(&node_dir).join("node.exe").exists() {
            let current = std::env::var("Path").unwrap_or_default();
            let new_path = format!("{};{}", current, node_dir);
            if let Some(ver) = check_node_with_path(&new_path) {
                std::env::set_var("Path", &new_path);
                return Ok(ver);
            }
        }
    }

    Err("node not found".to_string())
}

/// Check whether a model ID is available by making a minimal API call.
/// Check if a model name is available against the user's API endpoint.
/// Uses reqwest to POST to the Anthropic Messages API with max_tokens=1.
/// Returns Ok(()) if model is valid, Err(reason) otherwise.
///
/// Note: do NOT shell out to curl here. On Windows, `command_with_path("curl")`
/// wraps the call in `cmd /C`, and passing `-w "\n%{http_code}"` causes the
/// embedded LF to terminate the cmd line prematurely (and `%` triggers variable
/// expansion), leaving the real curl without proper args — the response came
/// back empty and the user saw "模型不可用：API returned HTTP " (no status).
#[tauri::command]
pub async fn check_model_available(
    model: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<(), String> {
    let key = api_key
        .filter(|s| !s.is_empty())
        .or_else(|| get_shell_env().get("ANTHROPIC_API_KEY").cloned())
        .ok_or("no_api_key")?;

    let url = base_url
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let endpoint = format!("{}/v1/messages", url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "hi"}]
    });

    // Build reqwest client honoring the cached system proxy (same rules
    // as sidecar spawning in command_with_path: SOCKS5 preferred over HTTP).
    let proxy_url = PROXY_SOCKS
        .lock()
        .ok()
        .map(|s| s.clone())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            PROXY_HTTP
                .lock()
                .ok()
                .map(|h| h.clone())
                .filter(|s| !s.is_empty())
        });

    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15));
    if let Some(p) = proxy_url {
        if let Ok(px) = reqwest::Proxy::all(&p) {
            builder = builder.proxy(px);
        }
    }
    let client = builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client
        .post(&endpoint)
        .header("x-api-key", &key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Model check timed out (15s)".to_string()
            } else {
                format!("Failed to check model: {}", e)
            }
        })?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if status.is_success() {
        return Ok(());
    }

    // Try to extract a human-readable error message from the response body
    if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(msg) = err_json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return Err(msg.to_string());
        }
    }
    Err(format!("API returned HTTP {}", status.as_u16()))
}

/// Clear the in-memory resume session ID for a given session.
/// Called by frontend when user starts a new conversation to prevent
/// the fallback HashMap from re-attaching the old resume ID.
#[tauri::command]
pub async fn clear_session_resume(
    state: State<'_, ProcessManager>,
    session_id: String,
) -> Result<(), String> {
    if let Ok(mut sessions) = state.claude_sessions.lock() {
        sessions.remove(&session_id);
    }
    Ok(())
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
    // Priority: frontend-persisted resume_id > in-memory HashMap
    let resume_id = request.resume_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            state.claude_sessions.lock().ok()
                .and_then(|sessions| sessions.get(&session_id).cloned())
        });

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
        "locale": request.locale.as_deref().unwrap_or(""),
        "effort": request.effort.as_deref().unwrap_or(""),
        "contextWindow": request.context_window.as_deref().unwrap_or(""),
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

    let mut cmd = command_with_path("node");
    cmd.arg(&bridge_path)
        .current_dir(&request.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped())
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
                .chain({
                    let fallback = request.model.as_deref().filter(|s| !s.is_empty());
                    let haiku = request.haiku_model.as_deref().filter(|s| !s.is_empty()).or(fallback);
                    let sonnet = request.sonnet_model.as_deref().filter(|s| !s.is_empty()).or(fallback);
                    let opus = request.opus_model.as_deref().filter(|s| !s.is_empty()).or(fallback);
                    haiku.map(|m| ("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), m.to_string())).into_iter()
                        .chain(sonnet.map(|m| ("ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(), m.to_string())).into_iter())
                        .chain(opus.map(|m| ("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), m.to_string())).into_iter())
                })
        )
        .env_remove("CLAUDECODE");

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setpgid(0, 0);
                Ok(())
            });
        }
    }

    let mut child = cmd.spawn()
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
        unsafe { libc::kill(-(pid as i32), libc::SIGTERM); }
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

/// List local git branches for a directory.
/// Returns a list of branch names, with the current branch first.
#[tauri::command]
pub fn list_git_branches(cwd: String) -> Result<Vec<String>, String> {
    let output = command_with_path("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let branches: Vec<String> = text
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(branches)
}

/// Checkout a local git branch.
#[tauri::command]
pub fn checkout_git_branch(cwd: String, branch: String) -> Result<String, String> {
    let output = command_with_path("git")
        .args(["checkout", &branch])
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(branch)
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(err)
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
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("cmd")
            .args(["/C", "start", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a directory in the system terminal
#[tauri::command]
pub fn open_in_terminal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Prefer iTerm2, fall back to Terminal.app
        let terminals = ["iTerm", "Terminal"];
        let mut launched = false;
        for term in &terminals {
            let result = Command::new("open")
                .args(["-a", term, &path])
                .spawn();
            if result.is_ok() {
                launched = true;
                break;
            }
        }
        if !launched {
            return Err("No terminal emulator found".into());
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators in order of popularity
        let terminals = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
        let mut launched = false;
        for term in &terminals {
            let result = if *term == "gnome-terminal" {
                Command::new(term)
                    .args(["--working-directory", &path])
                    .spawn()
            } else {
                Command::new(term)
                    .current_dir(&path)
                    .spawn()
            };
            if result.is_ok() {
                launched = true;
                break;
            }
        }
        if !launched {
            return Err("No terminal emulator found".into());
        }
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", &format!("cd /d {}", path)])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Reveal a file in Finder (macOS) / Explorer (Windows) / file manager (Linux)
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let is_dir = std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        if is_dir {
            Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
        } else {
            Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Try xdg-open on the parent directory
        let target = if std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false) {
            path.clone()
        } else {
            std::path::Path::new(&path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(path)
        };
        Command::new("xdg-open").arg(&target).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        let is_dir = std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        if is_dir {
            Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?;
        } else {
            Command::new("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Get list of files with uncommitted changes (staged + unstaged + untracked)
#[tauri::command]
pub fn git_diff_files(cwd: String) -> Result<Vec<String>, String> {
    let output = command_with_path("git")
        .args(["status", "--porcelain=v1"])
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(vec![]);
    }
    let root = cwd.trim_end_matches('/');
    let text = String::from_utf8_lossy(&output.stdout);
    let files: Vec<String> = text
        .lines()
        .filter(|l| l.len() > 3)
        .filter_map(|l| {
            let rel = l[3..].trim();
            // Handle rename "old -> new": take the "new" path
            let rel = if let Some(idx) = rel.find(" -> ") {
                &rel[idx + 4..]
            } else {
                rel
            };
            if rel.is_empty() { None } else { Some(format!("{}/{}", root, rel)) }
        })
        .collect();
    Ok(files)
}

/// Get the full git diff (staged + unstaged) for a directory
#[tauri::command]
pub fn git_diff(cwd: String) -> Result<String, String> {
    // staged changes
    let staged = command_with_path("git")
        .args(["diff", "--cached"])
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    // unstaged changes
    let unstaged = command_with_path("git")
        .args(["diff"])
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let mut result = String::new();
    let staged_str = String::from_utf8_lossy(&staged.stdout);
    let unstaged_str = String::from_utf8_lossy(&unstaged.stdout);
    if !staged_str.is_empty() {
        result.push_str(&staged_str);
    }
    if !unstaged_str.is_empty() {
        result.push_str(&unstaged_str);
    }
    Ok(result)
}


#[tauri::command]
pub async fn preload_skills(
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<String, String> {
    let bridge_path = resolve_bridge_path()?;
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Cannot determine home directory".to_string())?;

    let start_msg = serde_json::json!({
        "type": "list_skills",
        "cwd": &home,
    });

    let mut cmd = command_with_path("node");
    cmd.arg(&bridge_path)
        .current_dir(&home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped())
        .envs(
            api_key.as_deref()
                .filter(|s| !s.is_empty())
                .map(|k| ("ANTHROPIC_API_KEY".to_string(), k.to_string()))
                .into_iter()
                .chain(
                    base_url.as_deref()
                        .filter(|s| !s.is_empty())
                        .map(|u| ("ANTHROPIC_BASE_URL".to_string(), u.to_string()))
                        .into_iter()
                )
        )
        .env_remove("CLAUDECODE");

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn sidecar for skill preload: {}", e))?;

    let mut stdin_handle = child.stdin.take().ok_or("No stdin")?;
    let start_line = format!("{}\n", start_msg);
    stdin_handle.write_all(start_line.as_bytes()).map_err(|e| e.to_string())?;
    stdin_handle.flush().map_err(|e| e.to_string())?;
    drop(stdin_handle);

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout_str = String::from_utf8_lossy(&output.stdout);

    for line in stdout_str.lines() {
        if line.contains("\"type\":\"skills\"") || line.contains("\"type\": \"skills\"") {
            return Ok(line.to_string());
        }
    }

    Err(format!(
        "No skills response received. stderr: {}",
        String::from_utf8_lossy(&output.stderr).chars().take(500).collect::<String>()
    ))
}


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
pub fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn copy_file(src: String, dest: String) -> Result<(), String> {
    std::fs::copy(&src, &dest)
        .map(|_| ())
        .map_err(|e| e.to_string())
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

/// Return the file size in bytes (used by attachment chips).
#[tauri::command]
pub fn get_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
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

// ── One-click install: Node.js + Claude Code ────────────────────────

const NODE_LTS_VERSION: &str = "v24.15.0";

#[derive(Clone, Serialize)]
pub struct NodeInstallerInfo {
    pub url: String,
    pub filename: String,
    pub version: String,
}

#[tauri::command]
pub fn get_node_installer_url() -> Result<NodeInstallerInfo, String> {
    let ver = NODE_LTS_VERSION;
    let mirror = std::env::var("NODEJS_MIRROR")
        .unwrap_or_else(|_| "https://nodejs.org/dist".to_string());
    let base = mirror.trim_end_matches('/');

    #[cfg(target_os = "macos")]
    let filename = format!("node-{ver}.pkg");

    #[cfg(target_os = "windows")]
    let filename = {
        let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x64" };
        format!("node-{ver}-{arch}.msi")
    };

    #[cfg(target_os = "linux")]
    let filename = {
        let arch = if std::env::consts::ARCH == "aarch64" { "linux-arm64" } else { "linux-x64" };
        format!("node-{ver}-{arch}.tar.xz")
    };

    Ok(NodeInstallerInfo {
        url: format!("{base}/{ver}/{filename}"),
        filename,
        version: ver.to_string(),
    })
}

#[derive(Clone, Serialize)]
struct InstallProgress {
    step: String,
    progress: f64,
    message: String,
    done: bool,
    error: Option<String>,
}

fn emit_install(app: &AppHandle, step: &str, progress: f64, message: &str, done: bool, error: Option<String>) {
    let _ = app.emit("install-progress", InstallProgress {
        step: step.to_string(),
        progress,
        message: message.to_string(),
        done,
        error,
    });
}

#[tauri::command]
pub async fn download_and_open_node_installer(app: AppHandle) -> Result<(), String> {
    let info = get_node_installer_url()?;
    let dest_dir = std::env::temp_dir();
    let dest_path = dest_dir.join(&info.filename);
    let dest_str = dest_path.to_string_lossy().to_string();

    emit_install(&app, "download_node", 0.0, &format!("Downloading {}", info.filename), false, None);

    let app2 = app.clone();
    let url = info.url.clone();
    let dest = dest_str.clone();

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            // Get Content-Length first
            let head_out = command_with_path("curl")
                .args(["-sIL", &url])
                .output();
            let total_bytes: u64 = head_out.ok().and_then(|o| {
                let s = String::from_utf8_lossy(&o.stdout);
                s.lines()
                    .filter_map(|line| {
                        let lower = line.to_lowercase();
                        if lower.starts_with("content-length:") {
                            lower.split(':').nth(1)?.trim().parse::<u64>().ok()
                        } else {
                            None
                        }
                    })
                    .last()
            }).unwrap_or(0);

            // Start curl download
            let mut child = command_with_path("curl")
                .args(["-sL", "-o", &dest, &url])
                .spawn()
                .map_err(|e| format!("Failed to start curl: {e}"))?;

            // Poll file size for progress
            let dest_p = std::path::PathBuf::from(&dest);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if status.success() {
                            return Ok(());
                        } else {
                            return Err(format!("curl exited with code {}", status.code().unwrap_or(-1)));
                        }
                    }
                    Ok(None) => {
                        if total_bytes > 0 {
                            let downloaded = std::fs::metadata(&dest_p).map(|m| m.len()).unwrap_or(0);
                            let pct = (downloaded as f64 / total_bytes as f64).min(0.99);
                            emit_install(&app2, "download_node", pct,
                                &format!("{:.1} MB / {:.1} MB", downloaded as f64 / 1_048_576.0, total_bytes as f64 / 1_048_576.0),
                                false, None);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                    Err(e) => return Err(format!("curl error: {e}")),
                }
            }
        })();
        let _ = tx.send(result);
    });

    // Wait with a generous timeout (10 minutes for large downloads)
    match rx.recv_timeout(std::time::Duration::from_secs(600)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            emit_install(&app, "download_node", 0.0, &e, true, Some(e.clone()));
            return Err(e);
        }
        Err(_) => {
            let msg = "Download timed out (10 min)".to_string();
            emit_install(&app, "download_node", 0.0, &msg, true, Some(msg.clone()));
            return Err(msg);
        }
    }

    emit_install(&app, "download_node", 1.0, "Download complete", false, None);

    // Open the installer
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&dest_str).spawn()
            .map_err(|e| format!("Failed to open installer: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("cmd")
            .args(["/C", "start", "", &dest_str])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open installer: {e}"))?;
    }

    emit_install(&app, "open_installer", -1.0, "Installer opened", false, None);
    Ok(())
}

#[tauri::command]
pub async fn install_claude_code(app: AppHandle) -> Result<(), String> {
    emit_install(&app, "install_claude", -1.0, "Installing Claude Code...", false, None);

    let app2 = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let mut child = command_with_path("npm")
                .args(["install", "-g", "@anthropic-ai/claude-code"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to start npm: {e}"))?;

            let stderr = child.stderr.take();
            let app3 = app2.clone();
            let stderr_thread = std::thread::spawn(move || {
                if let Some(stderr) = stderr {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines().flatten() {
                        emit_install(&app3, "install_claude", -1.0, &line, false, None);
                    }
                }
            });

            if let Some(stdout) = child.stdout.take() {
                let reader = BufReader::new(stdout);
                for line in reader.lines().flatten() {
                    emit_install(&app2, "install_claude", -1.0, &line, false, None);
                }
            }

            let _ = stderr_thread.join();
            let status = child.wait().map_err(|e| format!("npm error: {e}"))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("npm install exited with code {}", status.code().unwrap_or(-1)))
            }
        })();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(std::time::Duration::from_secs(300)) {
        Ok(Ok(())) => {
            emit_install(&app, "install_claude", 1.0, "Claude Code installed successfully", true, None);
            Ok(())
        }
        Ok(Err(e)) => {
            emit_install(&app, "install_claude", 0.0, &e, true, Some(e.clone()));
            Err(e)
        }
        Err(_) => {
            let msg = "npm install timed out (5 min)".to_string();
            emit_install(&app, "install_claude", 0.0, &msg, true, Some(msg.clone()));
            Err(msg)
        }
    }
}

// ── Clipboard image saving ───────────────────────────────────────────

fn tmp_dir() -> std::path::PathBuf {
    #[cfg(unix)]
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".to_string());
    std::path::PathBuf::from(home).join(".claudebox").join("tmp")
}

/// Save a clipboard image (raw base64, no data-URL prefix) to
/// `~/.claudebox/tmp/<timestamp>-<sanitised_name>` and return the path.
/// Limited to 10 MB.
#[tauri::command]
pub fn save_clipboard_image(data: String, filename: String) -> Result<String, String> {
    use base64::Engine as _;

    let dir = tmp_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create tmp dir: {e}"))?;

    // Decode first so we can check the real size
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Invalid base64: {e}"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("Image too large (>10MB)".to_string());
    }

    // Sanitise filename & add a timestamp prefix for uniqueness
    let safe: String = filename
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dest = dir.join(format!("{ts}-{safe}"));

    std::fs::write(&dest, &bytes).map_err(|e| format!("Failed to write image: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Delete tmp images older than 24 h.  Called once at startup.
pub fn cleanup_old_tmp_images() {
    let dir = tmp_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(24 * 3600);
    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
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

/// Read context token count from a Claude session JSONL file.
/// Scans `~/.claude/projects/{encoded_path}/{session_id}.jsonl` from the end
/// and returns `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
/// from the last assistant message with usage data.
#[tauri::command]
pub fn get_context_tokens(session_id: String, project_path: String) -> Option<u64> {
    #[cfg(unix)]
    let home = std::env::var("HOME").ok()?;
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").ok()?;
    let home = std::path::PathBuf::from(home);
    // Encode project path: replace non-alphanumeric with '-'
    let encoded: String = project_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let jsonl_path = home
        .join(".claude")
        .join("projects")
        .join(&encoded)
        .join(format!("{}.jsonl", session_id));

    if !jsonl_path.exists() {
        return None;
    }

    // Read last 100KB to find the most recent assistant message with usage
    let file = std::fs::File::open(&jsonl_path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let read_from = if file_len > 100_000 { file_len - 100_000 } else { 0 };

    use std::io::{Seek, SeekFrom};
    let mut reader = std::io::BufReader::new(file);
    reader.seek(SeekFrom::Start(read_from)).ok()?;

    // If we seeked into the middle of a line, skip the partial first line
    if read_from > 0 {
        let mut discard = String::new();
        reader.read_line(&mut discard).ok()?;
    }

    let mut last_context: Option<u64> = None;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        // Quick check before full parse
        if !trimmed.contains("\"input_tokens\"") { continue; }

        if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if val.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            if let Some(usage) = val.pointer("/message/usage") {
                let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_create = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let ctx = input + cache_create + cache_read;
                if ctx > 0 {
                    last_context = Some(ctx);
                }
            }
        }
    }

    last_context
}

#[tauri::command]
pub fn copy_image_to_clipboard(base64_png: String) -> Result<(), String> {
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_png)
        .map_err(|e| format!("Invalid base64: {e}"))?;

    let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| format!("Invalid PNG: {e}"))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();

    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| format!("Clipboard init failed: {e}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Owned(rgba.into_raw()),
        })
        .map_err(|e| format!("Clipboard write failed: {e}"))?;
    Ok(())
}

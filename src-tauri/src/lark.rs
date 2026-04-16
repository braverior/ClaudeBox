use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write as IoWrite};
use std::process::{ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::claude::{command_with_path, emit_debug, resolve_sidecar_path};

// ── State ────────────────────────────────────────────────────────────

pub struct LarkProcessManager {
    pid: Arc<Mutex<Option<u32>>>,
    stdin_handle: Arc<Mutex<Option<ChildStdin>>>,
    status: Arc<Mutex<String>>,
}

impl LarkProcessManager {
    pub fn new() -> Self {
        Self {
            pid: Arc::new(Mutex::new(None)),
            stdin_handle: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new("stopped".to_string())),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct LarkStreamPayload {
    pub data: String,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Deserialize)]
pub struct StartLarkBotRequest {
    pub app_id: String,
    pub app_secret: String,
    pub project_dir: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_lark_bot(
    app: AppHandle,
    state: tauri::State<'_, LarkProcessManager>,
    request: StartLarkBotRequest,
) -> Result<u32, String> {
    // Stop existing bot first
    stop_lark_bot_internal(&state)?;

    let bridge_path = resolve_sidecar_path("lark-bot.mjs", "lark-bot.bundle.mjs")?;
    emit_debug(&app, "__lark__", "process", &format!("Lark sidecar: {}", bridge_path));

    let start_msg = serde_json::json!({
        "type": "start",
        "app_id": request.app_id,
        "app_secret": request.app_secret,
        "project_dir": request.project_dir.as_deref().unwrap_or(""),
        "model": request.model.as_deref().unwrap_or(""),
        "api_key": request.api_key.as_deref().unwrap_or(""),
        "base_url": request.base_url.as_deref().unwrap_or(""),
    });

    let mut child = command_with_path("node")
        .arg(&bridge_path)
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
        )
        .env_remove("CLAUDECODE")
        .spawn()
        .map_err(|e| {
            let msg = format!("Failed to spawn lark bot sidecar: {}", e);
            emit_debug(&app, "__lark__", "error", &msg);
            msg
        })?;

    let pid = child.id();
    emit_debug(&app, "__lark__", "process", &format!("Lark bot PID {}", pid));

    // Write the start message
    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let start_line = format!("{}\n", start_msg);
    stdin.write_all(start_line.as_bytes()).map_err(|e| {
        let msg = format!("Failed to write start message: {}", e);
        emit_debug(&app, "__lark__", "error", &msg);
        msg
    })?;
    stdin.flush().map_err(|e| e.to_string())?;

    // Store state
    *state.pid.lock().map_err(|e| e.to_string())? = Some(pid);
    *state.stdin_handle.lock().map_err(|e| e.to_string())? = Some(stdin);
    *state.status.lock().map_err(|e| e.to_string())? = "connecting".to_string();

    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    let pid_arc = Arc::clone(&state.pid);
    let stdin_arc = Arc::clone(&state.stdin_handle);
    let status_arc = Arc::clone(&state.status);

    // stdout reader thread
    let app_out = app.clone();
    let status_for_stdout = Arc::clone(&status_arc);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }

                    // Update internal status
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                        if val.get("type").and_then(|t| t.as_str()) == Some("status") {
                            if let Some(s) = val.get("status").and_then(|s| s.as_str()) {
                                if let Ok(mut st) = status_for_stdout.lock() {
                                    *st = s.to_string();
                                }
                            }
                        }
                    }

                    emit_debug(&app_out, "__lark__", "stdout", &line);

                    let _ = app_out.emit(
                        "lark-event",
                        &LarkStreamPayload {
                            data: line,
                            done: false,
                            error: None,
                        },
                    );
                }
                Err(e) => {
                    emit_debug(&app_out, "__lark__", "error", &format!("stdout error: {}", e));
                    break;
                }
            }
        }

        // Process exited
        emit_debug(&app_out, "__lark__", "process", "Lark bot process exited");
        if let Ok(mut st) = status_for_stdout.lock() {
            *st = "stopped".to_string();
        }
        let _ = app_out.emit(
            "lark-event",
            &LarkStreamPayload {
                data: String::new(),
                done: true,
                error: None,
            },
        );

        // Clean up
        if let Ok(mut p) = pid_arc.lock() {
            *p = None;
        }
        if let Ok(mut h) = stdin_arc.lock() {
            *h = None;
        }
    });

    // stderr reader thread
    let app_err = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    emit_debug(&app_err, "__lark__", "stderr", &line);
                }
                Err(_) => break,
            }
        }
    });

    Ok(pid)
}

fn stop_lark_bot_internal(state: &LarkProcessManager) -> Result<(), String> {
    // Send stop command
    {
        let mut handle = state.stdin_handle.lock().map_err(|e| e.to_string())?;
        if let Some(stdin) = handle.as_mut() {
            let stop_msg = "{\"type\":\"stop\"}\n";
            let _ = stdin.write_all(stop_msg.as_bytes());
            let _ = stdin.flush();
        }
        *handle = None;
    }

    // Kill process
    if let Ok(mut pid_lock) = state.pid.lock() {
        if let Some(pid) = pid_lock.take() {
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                use std::process::Command;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn();
            }
        }
    }

    if let Ok(mut st) = state.status.lock() {
        *st = "stopped".to_string();
    }

    Ok(())
}

#[tauri::command]
pub fn stop_lark_bot(
    app: AppHandle,
    state: tauri::State<'_, LarkProcessManager>,
) -> Result<(), String> {
    emit_debug(&app, "__lark__", "process", "Stopping lark bot...");
    stop_lark_bot_internal(&state)
}

#[tauri::command]
pub fn get_lark_status(state: tauri::State<'_, LarkProcessManager>) -> Result<String, String> {
    Ok(state
        .status
        .lock()
        .map_err(|e| e.to_string())?
        .clone())
}

#[tauri::command]
pub fn lark_send_notification(
    state: tauri::State<'_, LarkProcessManager>,
    chat_id: String,
    title: String,
    content: String,
    card_type: String,
) -> Result<(), String> {
    let mut handle = state.stdin_handle.lock().map_err(|e| e.to_string())?;
    if let Some(stdin) = handle.as_mut() {
        let msg = serde_json::json!({
            "type": "notify",
            "chat_id": chat_id,
            "title": title,
            "content": content,
            "card_type": card_type,
        });
        let line = format!("{}\n", msg);
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("Failed to write notification: {}", e))?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Lark bot not running".to_string())
    }
}

#[tauri::command]
pub fn lark_send_command(
    state: tauri::State<'_, LarkProcessManager>,
    command: String,
) -> Result<(), String> {
    let mut handle = state.stdin_handle.lock().map_err(|e| e.to_string())?;
    if let Some(stdin) = handle.as_mut() {
        let line = format!("{}\n", command.trim());
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("Failed to write command: {}", e))?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Lark bot not running".to_string())
    }
}

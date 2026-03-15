import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { StreamPayload, DebugEvent } from "./stream-parser";

export interface SendMessageRequest {
  session_id: string;
  message: string;
  cwd: string;
  model?: string;
  permission_mode?: string;
  claude_path?: string;
  allowed_tools?: string[];
  api_key?: string;
  base_url?: string;
  attachments?: { path: string; name: string; type: string }[];
  /** Claude session ID for --resume (persisted across app restarts) */
  resume_id?: string;
}

/** Send a message (spawns claude -p per message, with --resume for multi-turn). Returns PID. */
export async function sendMessage(request: SendMessageRequest): Promise<number> {
  return invoke("send_message", { request });
}

/** Stop a running claude process */
export async function stopSession(sessionId: string): Promise<void> {
  return invoke("stop_session", { sessionId });
}

/** Clear the in-memory resume session ID on Rust side */
export async function clearSessionResume(sessionId: string): Promise<void> {
  return invoke("clear_session_resume", { sessionId });
}

/** Send a response to the sidecar (user answer for AskUserQuestion, plan approval, etc.) */
export async function sendResponse(
  sessionId: string,
  response: Record<string, unknown>
): Promise<void> {
  return invoke("send_response", {
    sessionId,
    response: JSON.stringify(response),
  });
}

/** Check if Claude CLI is installed */
export async function checkClaudeInstalled(
  claudePath?: string
): Promise<string> {
  return invoke("check_claude_installed", { claudePath: claudePath ?? null });
}

/** Check if a model is available by making a minimal API call */
export async function checkModelAvailable(
  model: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<void> {
  return invoke("check_model_available", {
    model,
    apiKey: apiKey ?? null,
    baseUrl: baseUrl ?? null,
  });
}

/** Get current git branch for a directory */
export async function getGitBranch(cwd: string): Promise<string> {
  return invoke("get_git_branch", { cwd });
}

/** Listen for stream events */
export function onStream(
  callback: (payload: StreamPayload) => void
): Promise<UnlistenFn> {
  return listen<StreamPayload>("claude-stream", (event) => {
    callback(event.payload);
  });
}

/** Listen for debug events */
export function onDebug(
  callback: (event: DebugEvent) => void
): Promise<UnlistenFn> {
  return listen<DebugEvent>("claude-debug", (event) => {
    callback(event.payload);
  });
}

/** Open a URL in the system default browser */
export async function openInBrowser(url: string): Promise<void> {
  return invoke("open_in_browser", { url });
}

/** List directory entries */
export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export async function listDir(path: string): Promise<DirEntry[]> {
  return invoke("list_dir", { path });
}

/** Read a text file's content */
export async function readFile(path: string): Promise<string> {
  return invoke("read_file", { path });
}

/** Read an image file as a data: URL (base64) */
export async function readImageBase64(path: string): Promise<string> {
  return invoke("read_image_base64", { path });
}

/**
 * Frontend-side debug event bus.
 * Used by modules like updater to emit logs visible in the Debug Panel.
 */
type AppDebugListener = (event: DebugEvent) => void;
const appDebugListeners = new Set<AppDebugListener>();

/** Subscribe to frontend-emitted debug events. Returns unsubscribe fn. */
export function onAppDebug(fn: AppDebugListener): () => void {
  appDebugListeners.add(fn);
  return () => { appDebugListeners.delete(fn); };
}

/**
 * Emit a debug event from the frontend side.
 * Shows up in the Debug Panel alongside Rust-emitted events.
 */
export function emitDebug(
  level: DebugEvent["level"],
  message: string,
  sessionId = "__app__"
): void {
  const event: DebugEvent = {
    session_id: sessionId,
    level,
    message,
    timestamp: Date.now(),
  };
  for (const fn of appDebugListeners) fn(event);
}

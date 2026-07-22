import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
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
  /** UI locale — used to instruct Claude to respond in the matching language */
  locale?: string;
  /** Effort level: low / medium / high / max */
  effort?: string;
  /** Context window size: 200k / 1m */
  context_window?: string;
  /** Model tier defaults — passed as ANTHROPIC_DEFAULT_*_MODEL env vars */
  haiku_model?: string;
  sonnet_model?: string;
  opus_model?: string;
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

/**
 * Detect system proxy and apply as process env vars.
 * Uses SOCKS5 for HTTPS (bypasses GFW TLS fingerprinting), HTTP for sidecar.
 * Returns { desc, changed } — desc is empty if no proxy found,
 * changed indicates whether config differs from last call.
 */
export interface ProxyStatus {
  desc: string;
  changed: boolean;
}

export async function applySystemProxy(): Promise<ProxyStatus> {
  return invoke("apply_system_proxy");
}

/** Probe a URL using native curl (bypasses WebView CORS restrictions). */
export interface ProbeResult {
  url: string;
  ok: boolean;
  status: number;
  size: number;
  time_ms: number;
  version: string;
  error: string;
}

export async function probeUrl(url: string): Promise<ProbeResult> {
  return invoke("probe_url", { url });
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

/** Check Node.js version. Returns version string like "v22.3.0" */
export async function checkNodeVersion(): Promise<string> {
  return invoke("check_node_version");
}

// ── One-click install ──────────────────────────────────────────────

export interface NodeInstallerInfo {
  url: string;
  filename: string;
  version: string;
}

export interface InstallProgress {
  step: string;
  progress: number;
  message: string;
  done: boolean;
  error: string | null;
}

export async function getNodeInstallerUrl(): Promise<NodeInstallerInfo> {
  return invoke("get_node_installer_url");
}

export async function downloadAndOpenNodeInstaller(): Promise<void> {
  return invoke("download_and_open_node_installer");
}

export async function installClaudeCode(): Promise<void> {
  return invoke("install_claude_code");
}

export function onInstallProgress(
  callback: (payload: InstallProgress) => void
): Promise<UnlistenFn> {
  return listen<InstallProgress>("install-progress", (event) => {
    callback(event.payload);
  });
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

/** List local git branches for a directory */
export async function listGitBranches(cwd: string): Promise<string[]> {
  return invoke("list_git_branches", { cwd });
}

/** Checkout a local git branch */
export async function checkoutGitBranch(cwd: string, branch: string): Promise<string> {
  return invoke("checkout_git_branch", { cwd, branch });
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

/** Reveal a file or folder in Finder / Explorer */
export async function revealInFinder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}

/** Get list of files with uncommitted git changes (absolute paths) */
export async function gitDiffFiles(cwd: string): Promise<string[]> {
  return invoke("git_diff_files", { cwd });
}

/** Get the full git diff output (staged + unstaged) for a directory */
export async function gitDiff(cwd: string): Promise<string> {
  return invoke("git_diff", { cwd });
}

export interface GitDiffStat {
  added: number;
  removed: number;
  files: number;
}

/** Aggregate diff line counts (staged + unstaged) for a directory */
export async function gitDiffStat(cwd: string): Promise<GitDiffStat> {
  const [added, removed, files] = await invoke<[number, number, number]>("git_diff_stat", { cwd });
  return { added, removed, files };
}

/** Open a directory in the system terminal */
export async function openInTerminal(path: string): Promise<void> {
  return invoke("open_in_terminal", { path });
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

/** Recursively search project files for the `@` mention picker (skips node_modules/.git/etc). */
export async function searchProjectFiles(root: string, query: string, limit?: number): Promise<DirEntry[]> {
  return invoke("search_project_files", { root, query, limit: limit ?? null });
}

export async function preloadSkills(apiKey?: string, baseUrl?: string): Promise<string> {
  return invoke("preload_skills", { apiKey: apiKey || null, baseUrl: baseUrl || null });
}

/** Read a text file's content */
export async function readFile(path: string): Promise<string> {
  return invoke("read_file", { path });
}

/** Write text content to a file */
export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

/** Copy a file from src to dest (preserves binary contents) */
export async function copyFile(src: string, dest: string): Promise<void> {
  return invoke("copy_file", { src, dest });
}

/** Read an image file as a data: URL (base64) */
export async function readImageBase64(path: string): Promise<string> {
  return invoke("read_image_base64", { path });
}

/** Save a clipboard image (raw base64) to a temp file, returns the full path */
export async function saveClipboardImage(data: string, filename: string): Promise<string> {
  return invoke("save_clipboard_image", { data, filename });
}

/** Get file size in bytes */
export async function getFileSize(path: string): Promise<number> {
  return invoke("get_file_size", { path });
}

/** Copy a PNG image (raw base64, no data-URL prefix) to the system clipboard */
export async function copyImageToClipboard(base64Png: string): Promise<void> {
  return invoke("copy_image_to_clipboard", { base64Png });
}

export async function getContextTokens(sessionId: string, projectPath: string): Promise<number | null> {
  return invoke("get_context_tokens", { sessionId, projectPath });
}

/** Lightweight metadata for one Claude session (one JSONL file on disk). */
export interface ClaudeSessionMeta {
  claudeSessionId: string;
  projectPath: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastModel: string | null;
  permissionMode: string | null;
  messageCount: number;
}

/** Scan ~/.claude/projects and return metadata for every non-empty session. */
export async function listClaudeSessions(): Promise<ClaudeSessionMeta[]> {
  return invoke("list_claude_sessions");
}

/** Read the raw JSONL transcript text for one session (tail-capped if huge). */
export async function readSessionTranscript(claudeSessionId: string, projectPath: string): Promise<string> {
  return invoke("read_session_transcript", { claudeSessionId, projectPath });
}

/** Permanently delete a session's JSONL file (also removes CLI-visible history). */
export async function deleteSessionTranscript(claudeSessionId: string, projectPath: string): Promise<void> {
  return invoke("delete_session_transcript", { claudeSessionId, projectPath });
}

/** Open the OS network proxy settings panel (macOS / Windows). */
export async function openProxySettings(): Promise<void> {
  return invoke("open_proxy_settings");
}

/**
 * Frontend-side debug event bus.
 * Backed by Tauri's IPC event system so events broadcast across windows
 * (e.g. the standalone Debug Window can receive logs emitted by the main
 * window's updater module).
 */
type AppDebugListener = (event: DebugEvent) => void;

/** Subscribe to frontend-emitted debug events. Returns unsubscribe fn. */
export function onAppDebug(fn: AppDebugListener): () => void {
  let alive = true;
  const unlistenP = listen<DebugEvent>("app-debug", (event) => {
    if (alive) fn(event.payload);
  });
  return () => {
    alive = false;
    unlistenP.then((u) => u()).catch(() => {});
  };
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
  emit("app-debug", event).catch(() => {});
}

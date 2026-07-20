import { create } from "zustand";
import { useTokenUsageStore } from "./tokenUsageStore";
import { useSettingsStore } from "./settingsStore";
import type {
  ChatMessage,
  ContentBlock,
  StreamMessage,
  PendingInteraction,
  AnsweredToolData,
} from "../lib/stream-parser";
import { useTaskStore } from "./taskStore";
import { useSkillsStore } from "./skillsStore";
import { v4Style } from "../lib/utils";
import { storageRead, storageWrite, storageRemove } from "../lib/storage";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

/** Wraps a promise with a timeout — rejects after `ms` milliseconds */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

export interface Session {
  id: string;
  projectPath: string;
  projectName: string;
  model: string;
  permissionMode: string;
  allowedTools: string[];
  skills?: ({ name: string; desc: string } | string)[];
  skillSources?: Record<string, "builtin" | "plugin" | "global" | "project">;
  createdAt: number;
  updatedAt: number;
  /** Real Claude session ID (from system init message) — used for --resume across app restarts */
  claudeSessionId?: string;
  /** Background completion not yet seen by user (cleared on switchSession) */
  unread?: boolean;
  /** Pinned to the top section (manual order, immune from auto-bump) */
  pinned?: boolean;
}

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: { name: string; type: "text" | "image" | "document" | "directory"; path: string; dataUrl?: string; size?: number }[];
  enqueuedAt: number;
}

export interface InputDraft {
  content: string;
  attachments: { name: string; type: "text" | "image" | "document" | "directory"; path: string; dataUrl?: string; size?: number }[];
}

export const DEFAULT_TOOLS = ["Read", "Glob", "Grep", "TodoWrite", "Write", "Edit", "Bash", "WebFetch", "WebSearch", "NotebookEdit", "Agent", "MCP"];

const AUTO_MERGE_TOOLS = ["Read", "Glob", "Grep", "TodoWrite"];

function mergeAllowedTools(existing: string[] | undefined): string[] {
  const base = existing ?? DEFAULT_TOOLS;
  const set = new Set(base);
  for (const t of AUTO_MERGE_TOOLS) set.add(t);
  return Array.from(set);
}

interface ChatState {
  sessions: Session[];
  currentSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  stderrLogs: Record<string, string[]>;
  streamStartTimes: Record<string, number>;
  /** Per-session streaming state */
  streamingSessions: Record<string, boolean>;
  /** Per-session queue of messages submitted while a task is running. */
  messageQueue: Record<string, QueuedMessage[]>;
  /** Per-session input drafts, restored when the user switches back. */
  inputDrafts: Record<string, InputDraft>;
  /** Session id whose git diff dialog is currently open (null = closed). */
  viewDiffSessionId: string | null;
  streamError: string | null;
  /** Per-session pending interactive tool request (AskUserQuestion / ExitPlanMode / tool permission) */
  pendingInteractions: Record<string, PendingInteraction>;
  /** Persisted answered state for interactive tools, keyed by tool_use block ID */
  answeredTools: Record<string, AnsweredToolData>;
  /** Whether the store has finished loading from persistent storage */
  loaded: boolean;

  /** Async initialization — loads data from file storage, migrates from localStorage */
  init: () => Promise<void>;
  createSession: (projectPath: string, model: string, permissionMode: string) => string;
  removeSession: (id: string) => void;
  switchSession: (id: string) => void;
  updateSession: (id: string, updates: Partial<Pick<Session, "model" | "permissionMode" | "allowedTools" | "claudeSessionId">>) => void;
  /** Clear claudeSessionId so the next message starts a fresh session */
  clearClaudeSession: (id: string) => void;
  /** Clear all chat messages for a session (history wipe) */
  clearMessages: (id: string) => void;
  addUserMessage: (sessionId: string, content: string, attachments?: { name: string; type: string; path?: string; dataUrl?: string; size?: number }[]) => void;
  addSystemMessage: (sessionId: string, text: string) => void;
  addLaunchMessage: (sessionId: string, pid: number, resumeFrom?: string) => void;
  handleStreamData: (sessionId: string, data: string, stream: string) => void;
  handleStreamDone: (sessionId: string, error?: string, force?: boolean) => void;
  setStreaming: (sessionId: string, streaming: boolean) => void;
  clearError: () => void;
  /** Clear the pending interaction for a session after it has been responded to */
  clearPendingInteraction: (sessionId: string) => void;
  /** Mark an interactive tool as answered, persisting data across re-renders */
  setToolAnswered: (toolUseId: string, data: AnsweredToolData) => void;
  /** Reorder sessions inside the pinned section. Indices refer to positions among pinned sessions. */
  reorderPinned: (fromIndex: number, toIndex: number) => void;
  /** Toggle a session's pinned state. */
  togglePinned: (id: string) => void;
  /** Refresh updatedAt for a session (used on user activity; recent section is sorted by updatedAt). */
  bumpSessionToTop: (id: string) => void;
  /** Mark a session as unread (background completion). */
  markUnread: (id: string) => void;
  /** Clear unread flag (when user opens / switches to the session). */
  clearUnread: (id: string) => void;
  /** Enqueue a message to be sent automatically after the current task finishes. */
  enqueueMessage: (sessionId: string, content: string, attachments?: QueuedMessage["attachments"]) => void;
  /** Remove a single queued message. */
  removeQueuedMessage: (sessionId: string, queueItemId: string) => void;
  /** Pop the head of the queue (returns the removed item or null). */
  popQueuedMessage: (sessionId: string) => QueuedMessage | null;
  /** Drop the entire queue for a session (e.g. on stop). */
  clearMessageQueue: (sessionId: string) => void;
  /** Save (or clear) the input draft for a session. Empty drafts are removed. */
  saveInputDraft: (sessionId: string, draft: InputDraft) => void;
  /** Drop the input draft for a session. */
  clearInputDraft: (sessionId: string) => void;
  /** Open the git diff dialog for a given session. */
  openDiffDialog: (sessionId: string) => void;
  /** Close the git diff dialog. */
  closeDiffDialog: () => void;
}

// ── File storage keys ───────────────────────────────────────────────

const SESSIONS_KEY = "sessions";
const MESSAGES_KEY_PREFIX = "msgs-";
const ANSWERED_TOOLS_KEY = "answered-tools";

// ── Legacy localStorage keys (for migration) ───────────────────────

const LS_SESSIONS_KEY = "claudebox-sessions";
const LS_MESSAGES_KEY_PREFIX = "claudebox-msgs-";

// ── File storage helpers ────────────────────────────────────────────

async function loadSessionsFromFile(): Promise<Session[]> {
  try {
    const data = await withTimeout(storageRead(SESSIONS_KEY), 5000);
    if (data) {
      const sessions: Session[] = JSON.parse(data);
      return sessions.map((s) => ({
        ...s,
        allowedTools: mergeAllowedTools(s.allowedTools),
      }));
    }
  } catch { /* ignore */ }
  return [];
}

function saveSessions(sessions: Session[]) {
  storageWrite(SESSIONS_KEY, JSON.stringify(sessions)).catch(() => {});
}

async function loadMessagesFromFile(sessionId: string): Promise<ChatMessage[]> {
  try {
    const data = await withTimeout(storageRead(MESSAGES_KEY_PREFIX + sessionId), 5000);
    if (data) return JSON.parse(data);
  } catch { /* ignore */ }
  return [];
}

function saveMessages(sessionId: string, msgs: ChatMessage[]) {
  storageWrite(MESSAGES_KEY_PREFIX + sessionId, JSON.stringify(msgs)).catch(() => {});
}

async function loadAnsweredTools(): Promise<Record<string, AnsweredToolData>> {
  try {
    const data = await withTimeout(storageRead(ANSWERED_TOOLS_KEY), 5000);
    if (data) return JSON.parse(data);
  } catch { /* ignore */ }
  return {};
}

function saveAnsweredTools(tools: Record<string, AnsweredToolData>) {
  storageWrite(ANSWERED_TOOLS_KEY, JSON.stringify(tools)).catch(() => {});
}

function removeMessages(sessionId: string) {
  storageRemove(MESSAGES_KEY_PREFIX + sessionId).catch(() => {});
}

// ── Legacy localStorage helpers (for migration) ────────────────────

function loadSessionsFromLocalStorage(): Session[] {
  try {
    const stored = localStorage.getItem(LS_SESSIONS_KEY);
    if (stored) {
      const sessions: Session[] = JSON.parse(stored);
      return sessions.map((s) => ({
        ...s,
        allowedTools: mergeAllowedTools(s.allowedTools),
      }));
    }
  } catch { /* ignore */ }
  return [];
}

function loadMessagesFromLocalStorage(sessionId: string): ChatMessage[] {
  try {
    const stored = localStorage.getItem(LS_MESSAGES_KEY_PREFIX + sessionId);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return [];
}

function clearLocalStorageData(sessions: Session[]) {
  try {
    localStorage.removeItem(LS_SESSIONS_KEY);
    for (const s of sessions) {
      localStorage.removeItem(LS_MESSAGES_KEY_PREFIX + s.id);
    }
  } catch { /* ignore */ }
}

// ── Desktop notifications ──────────────────────────────────────────

let notificationPermissionReady = false;
(async () => {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    notificationPermissionReady = granted;
  } catch { /* Tauri API unavailable in dev */ }
})();

function notify(title: string, body?: string) {
  if (!notificationPermissionReady) return;
  if (!useSettingsStore.getState().settings.notifications) return;
  if (document.hasFocus()) return;
  try { sendNotification({ title, body }); } catch { /* ignore */ }
}

// ── Project name extraction ─────────────────────────────────────────

function extractProjectName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// ── Task tool call processing ───────────────────────────────────────

function processTaskToolCalls(sessionId: string, content: ContentBlock[]) {
  const taskStore = useTaskStore.getState();
  for (const block of content) {
    if (block.type === "tool_use" && block.name && block.input) {
      if (block.name === "TaskCreate" || block.name === "TaskUpdate" || block.name === "TodoWrite") {
        taskStore.handleToolUse(sessionId, block.name, block.input, block.id);
      }
    }
  }
}

/** When TaskCreate's tool_result arrives, upgrade the placeholder (tool_use_id)
 *  to the real "#N" id so subsequent TaskUpdate(taskId="N") matches. */
function processTaskToolResults(sessionId: string, content: ContentBlock[], assistantMsgs: ChatMessage[]) {
  for (const block of content) {
    if (block.type !== "tool_result" || !block.tool_use_id) continue;
    let isTaskCreate = false;
    for (let i = assistantMsgs.length - 1; i >= 0; i--) {
      const m = assistantMsgs[i];
      if (m.role !== "assistant") continue;
      const hit = m.content.find(
        (b) => b.type === "tool_use" && b.id === block.tool_use_id && b.name === "TaskCreate"
      );
      if (hit) { isTaskCreate = true; break; }
    }
    if (!isTaskCreate) continue;
    const text = typeof block.content === "string" ? block.content : "";
    const match = text.match(/Task #(\d+)/);
    if (match) {
      useTaskStore.getState().patchTaskId(sessionId, block.tool_use_id, match[1]);
    }
  }
}

/**
 * Merge new content blocks into existing ones.
 * Without --include-partial-messages, each assistant event for the same
 * message id contains only the NEWLY completed block(s), not the cumulative
 * content.  So we simply append blocks we haven't seen yet.
 *
 * We de-duplicate by checking block id (for tool_use) or type+index.
 */
function appendNewBlocks(
  existing: ContentBlock[],
  incoming: ContentBlock[]
): ContentBlock[] {
  if (incoming.length === 0) return existing;

  const existingIds = new Set(
    existing.map((b) => b.id).filter(Boolean)
  );

  const result = [...existing];
  for (const block of incoming) {
    if (block.id && existingIds.has(block.id)) {
      const idx = result.findIndex((b) => b.id === block.id);
      if (idx >= 0) result[idx] = block;
      continue;
    }

    const last = result[result.length - 1];
    if (
      block.type === "text" &&
      last?.type === "text" &&
      !block.id &&
      !last.id
    ) {
      result[result.length - 1] = block;
      continue;
    }

    result.push(block);
    if (block.id) existingIds.add(block.id);
  }

  return result;
}

// ── Streaming delta batching ────────────────────────────────────────
//
// includePartialMessages delivers assistant text token-by-token. Applying a
// store update per token forces the whole message list to re-render — and the
// growing text block's ReactMarkdown to re-parse — on every token, which janks
// long responses. Instead, buffer the deltas and flush them on an animation
// frame (capped at ~30fps) so a burst of tokens collapses into one render.

const STREAMING_ID = "__streaming__";
const STREAM_FLUSH_MIN_MS = 33;

const pendingStreamDeltas: Record<string, { kind: "text" | "thinking"; text: string }[]> = {};
let streamFlushHandle: number | null = null;
let lastStreamFlushAt = 0;

/** Fold a run of deltas onto a content array, growing the trailing same-kind
 *  block (id-less, so it's a streamed block) or appending a new one. */
function applyDeltasToContent(
  content: ContentBlock[],
  deltas: { kind: "text" | "thinking"; text: string }[]
): ContentBlock[] {
  const out = [...content];
  for (const { kind, text } of deltas) {
    const last = out[out.length - 1];
    if (last && last.type === kind && !last.id) {
      out[out.length - 1] =
        kind === "thinking"
          ? { ...last, thinking: (last.thinking || "") + text }
          : { ...last, text: (last.text || "") + text };
    } else {
      out.push(kind === "thinking" ? { type: "thinking", thinking: text } : { type: "text", text });
    }
  }
  return out;
}

/** Apply all buffered deltas immediately in a single store update. Called on
 *  each (rate-limited) animation frame, and synchronously before any non-delta
 *  event so the placeholder is complete before it gets finalized/appended to. */
function flushStreamDeltasNow() {
  if (streamFlushHandle != null) {
    cancelAnimationFrame(streamFlushHandle);
    streamFlushHandle = null;
  }
  const sessionIds = Object.keys(pendingStreamDeltas);
  if (sessionIds.length === 0) return;

  const allMessages = { ...useChatStore.getState().messages };
  let changed = false;

  for (const sessionId of sessionIds) {
    const deltas = pendingStreamDeltas[sessionId];
    delete pendingStreamDeltas[sessionId];
    if (!deltas || deltas.length === 0) continue;

    const msgs = [...(allMessages[sessionId] || [])];
    // Close the "launching" placeholder once real tokens arrive.
    const launchIdx = msgs.findIndex(
      (m) => m.role === "assistant" && m.streamMessageId === "__launch__"
    );
    if (launchIdx >= 0 && msgs[launchIdx].isStreaming) {
      msgs[launchIdx] = { ...msgs[launchIdx], isStreaming: false };
    }
    let idx = msgs.findIndex((m) => m.role === "assistant" && m.streamMessageId === STREAMING_ID);
    if (idx < 0) {
      msgs.push({
        id: v4Style(),
        streamMessageId: STREAMING_ID,
        role: "assistant",
        content: [],
        timestamp: Date.now(),
        isStreaming: true,
      });
      idx = msgs.length - 1;
    }
    msgs[idx] = {
      ...msgs[idx],
      content: applyDeltasToContent(msgs[idx].content, deltas),
      isStreaming: true,
    };
    allMessages[sessionId] = msgs;
    changed = true;
  }

  lastStreamFlushAt = performance.now();
  if (changed) useChatStore.setState({ messages: allMessages });
}

/** Schedule a flush on the next animation frame, rate-limited to ~30fps. */
function scheduleStreamFlush() {
  if (streamFlushHandle != null) return;
  streamFlushHandle = requestAnimationFrame(() => {
    streamFlushHandle = null;
    if (
      performance.now() - lastStreamFlushAt < STREAM_FLUSH_MIN_MS &&
      Object.keys(pendingStreamDeltas).length > 0
    ) {
      // Too soon since the last flush — defer one more frame to cap re-parses.
      scheduleStreamFlush();
      return;
    }
    flushStreamDeltasNow();
  });
}

// ── Store ───────────────────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: {},
  stderrLogs: {},
  streamStartTimes: {},
  streamingSessions: {},
  messageQueue: {},
  inputDrafts: {},
  viewDiffSessionId: null,
  streamError: null,
  pendingInteractions: {},
  answeredTools: {},
  loaded: false,

  init: async () => {
    // 1. Try loading from file storage
    let sessions = await loadSessionsFromFile();

    // 2. If empty, migrate from localStorage
    if (sessions.length === 0) {
      const lsSessions = loadSessionsFromLocalStorage();
      if (lsSessions.length > 0) {
        sessions = lsSessions;
        // Save sessions to file storage
        await storageWrite(SESSIONS_KEY, JSON.stringify(sessions)).catch(() => {});
        // Migrate messages for all sessions
        for (const s of sessions) {
          const msgs = loadMessagesFromLocalStorage(s.id);
          if (msgs.length > 0) {
            await storageWrite(
              MESSAGES_KEY_PREFIX + s.id,
              JSON.stringify(msgs)
            ).catch(() => {});
          }
        }
        // Clean up localStorage after successful migration
        clearLocalStorageData(sessions);
      }
    }

    // 3. Load messages for the most recent session
    const messages: Record<string, ChatMessage[]> = {};
    if (sessions.length > 0) {
      const msgs = await loadMessagesFromFile(sessions[0].id);
      if (msgs.length > 0) {
        messages[sessions[0].id] = msgs;
      }
    }

    // 4. Load answered tools
    const answeredTools = await loadAnsweredTools();

    set({
      sessions,
      currentSessionId: null,
      messages,
      answeredTools,
      loaded: true,
    });
  },

  createSession: (projectPath, model, permissionMode) => {
    const existing = get().sessions.find((s) => s.projectPath === projectPath);
    if (existing) {
      set({ currentSessionId: existing.id, streamError: null });
      return existing.id;
    }

    const id = v4Style();
    const session: Session = {
      id,
      projectPath,
      projectName: extractProjectName(projectPath),
      model,
      permissionMode,
      allowedTools: DEFAULT_TOOLS,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const sessions = [session, ...get().sessions];
    saveSessions(sessions);
    set({
      sessions,
      currentSessionId: id,
      messages: { ...get().messages, [id]: [] },
      stderrLogs: { ...get().stderrLogs, [id]: [] },
    });
    return id;
  },

  removeSession: (id) => {
    const sessions = get().sessions.filter((s) => s.id !== id);
    saveSessions(sessions);
    const messages = { ...get().messages };
    const stderrLogs = { ...get().stderrLogs };
    delete messages[id];
    delete stderrLogs[id];
    removeMessages(id);
    useTaskStore.getState().clearTasks(id);
    const currentId =
      get().currentSessionId === id
        ? sessions[0]?.id ?? null
        : get().currentSessionId;
    set({ sessions, messages, stderrLogs, currentSessionId: currentId });
  },

  switchSession: (id) => {
    const currentMsgs = get().messages[id];
    if (!currentMsgs) {
      // Load messages from file storage asynchronously
      loadMessagesFromFile(id).then((loaded) => {
        if (loaded.length > 0) {
          set({
            messages: { ...get().messages, [id]: loaded },
          });
        }
      });
    }
    set({ currentSessionId: id, streamError: null });
    get().clearUnread(id);
  },

  updateSession: (id, updates) => {
    const sessions = get().sessions.map((s) =>
      s.id === id ? { ...s, ...updates, updatedAt: Date.now() } : s
    );
    saveSessions(sessions);
    set({ sessions });
  },

  clearClaudeSession: (id) => {
    const sessions = get().sessions.map((s) =>
      s.id === id ? { ...s, claudeSessionId: undefined, updatedAt: Date.now() } : s
    );
    saveSessions(sessions);
    set({ sessions });
  },

  clearMessages: (id) => {
    removeMessages(id);
    const messages = { ...get().messages };
    delete messages[id];
    set({ messages });
  },

  addUserMessage: (sessionId, content, attachments) => {
    const msg: ChatMessage = {
      id: v4Style(),
      role: "user",
      content: [{ type: "text", text: content }],
      timestamp: Date.now(),
      attachments,
    };
    const msgs = [...(get().messages[sessionId] || []), msg];
    useTaskStore.getState().clearTasks(sessionId);
    set({
      messages: { ...get().messages, [sessionId]: msgs },
      streamStartTimes: { ...get().streamStartTimes, [sessionId]: Date.now() },
    });
    get().bumpSessionToTop(sessionId);
  },

  addSystemMessage: (sessionId, text) => {
    const msg: ChatMessage = {
      id: v4Style(),
      role: "system",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    };
    const msgs = [...(get().messages[sessionId] || []), msg];
    set({ messages: { ...get().messages, [sessionId]: msgs } });
  },

  addLaunchMessage: (sessionId, pid, resumeFrom) => {
    const msg: ChatMessage = {
      id: v4Style(),
      role: "assistant",
      content: [{ type: "text", text: `__launch__:${JSON.stringify({ pid, resumeFrom: resumeFrom || undefined })}` }],
      timestamp: Date.now(),
      isStreaming: true,
      streamMessageId: "__launch__",
    };
    const msgs = [...(get().messages[sessionId] || []), msg];
    set({ messages: { ...get().messages, [sessionId]: msgs } });
  },

  handleStreamData: (sessionId, data, stream) => {
    if (stream === "stderr") {
      const logs = [...(get().stderrLogs[sessionId] || []), data];
      if (logs.length > 500) logs.splice(0, logs.length - 500);
      set({ stderrLogs: { ...get().stderrLogs, [sessionId]: logs } });
      return;
    }

    try {
      const event: StreamMessage = JSON.parse(data);

      // High-frequency token deltas: buffer and flush on an animation frame
      // (~30fps) instead of re-rendering per token. Everything else flushes any
      // pending deltas first so the streaming placeholder is up to date.
      if (event.type === "stream_delta") {
        if (event.delta != null) {
          (pendingStreamDeltas[sessionId] ||= []).push({
            kind: event.delta_kind === "thinking" ? "thinking" : "text",
            text: event.delta,
          });
          scheduleStreamFlush();
        }
        return;
      }
      flushStreamDeltasNow();

      const msgs = [...(get().messages[sessionId] || [])];

      const finalizeLaunch = () => {
        const launchIdx = msgs.findIndex(
          (m) => m.role === "assistant" && m.streamMessageId === "__launch__"
        );
        if (launchIdx >= 0) {
          msgs[launchIdx] = { ...msgs[launchIdx], isStreaming: false };
        }
      };

      if (event.type === "system") {
        // Persist Claude session ID and skills for --resume across app restarts
        if (event.session_id) {
          const sessions = get().sessions.map((s) =>
            s.id === sessionId ? { ...s, claudeSessionId: event.session_id, updatedAt: Date.now() } : s
          );
          saveSessions(sessions);
          set({ sessions });
        }

        // Handle compaction status events
        if (event.subtype === "status" && event.status === "compacting") {
          msgs.push({
            id: v4Style(),
            role: "system",
            content: [{ type: "text", text: "__compacting__" }],
            timestamp: Date.now(),
            isStreaming: true,
          });
        } else if (event.subtype === "compact_boundary" && event.compact_metadata) {
          const compactIdx = msgs.findIndex(
            (m) => m.role === "system" && m.content[0]?.text === "__compacting__"
          );
          const preTokens = event.compact_metadata.pre_tokens;
          if (compactIdx >= 0) {
            msgs[compactIdx] = {
              ...msgs[compactIdx],
              isStreaming: false,
              content: [{ type: "text", text: `__compacted__:${preTokens}` }],
            };
          } else {
            msgs.push({
              id: v4Style(),
              role: "system",
              content: [{ type: "text", text: `__compacted__:${preTokens}` }],
              timestamp: Date.now(),
            });
          }
        }

        const launchIdx = msgs.findIndex(
          (m) => m.role === "assistant" && m.streamMessageId === "__launch__"
        );
        if (launchIdx >= 0 && event.session_id) {
          const old = msgs[launchIdx];
          const oldText = old.content[0]?.text || "";
          try {
            const info = JSON.parse(oldText.replace("__launch__:", ""));
            info.sessionId = event.session_id;
            msgs[launchIdx] = {
              ...old,
              isStreaming: false,
              content: [{ type: "text", text: `__launch__:${JSON.stringify(info)}` }],
            };
          } catch {
            msgs[launchIdx] = { ...old, isStreaming: false };
          }
        } else if (launchIdx >= 0) {
          msgs[launchIdx] = { ...msgs[launchIdx], isStreaming: false };
        }
      }

      if (event.type === "assistant" && event.message) {
        const incomingContent: ContentBlock[] = event.message.content || [];
        const streamMsgId = event.message.id;

        finalizeLaunch();
        processTaskToolCalls(sessionId, incomingContent);

        const usage = event.message.usage
          ? {
              input_tokens: event.message.usage.input_tokens,
              output_tokens: event.message.usage.output_tokens,
              cache_creation_input_tokens: event.message.usage.cache_creation_input_tokens,
              cache_read_input_tokens: event.message.usage.cache_read_input_tokens,
              server_tool_use_input_tokens: event.message.usage.server_tool_use_input_tokens,
              contextWindow: event.message.usage.contextWindow,
            }
          : undefined;

        // If a live-streamed placeholder is open, this full message IS its
        // finalized form — adopt the real id and replace the streamed preview
        // text with the authoritative content (avoids double-rendering the
        // text that already arrived via stream_delta). Otherwise fall back to
        // id-keyed reconciliation for the non-streaming path.
        const streamingIdx = msgs.findIndex(
          (m) => m.role === "assistant" && m.streamMessageId === "__streaming__"
        );
        const existingIdx = streamMsgId
          ? msgs.findIndex(
              (m) =>
                m.role === "assistant" &&
                m.streamMessageId === streamMsgId
            )
          : -1;

        if (streamingIdx >= 0) {
          const existing = msgs[streamingIdx];
          msgs[streamingIdx] = {
            ...existing,
            // Keep `existing.id` stable (it's the React list key). Only adopt the
            // real id into streamMessageId for matching follow-up assistant
            // events — changing `id` here would remount the whole bubble and
            // cause a visible flash when streaming finalizes.
            streamMessageId: streamMsgId,
            content: incomingContent,
            model: event.message.model || existing.model,
            isStreaming: true,
            usage: usage ?? existing.usage,
          };
        } else if (existingIdx >= 0) {
          const existing = msgs[existingIdx];
          msgs[existingIdx] = {
            ...existing,
            content: appendNewBlocks(existing.content, incomingContent),
            model: event.message.model || existing.model,
            usage: usage ?? existing.usage,
          };
        } else {
          msgs.push({
            id: streamMsgId || v4Style(),
            streamMessageId: streamMsgId,
            role: "assistant",
            content: incomingContent,
            timestamp: Date.now(),
            model: event.message.model,
            isStreaming: true,
            usage,
          });
        }
      } else if (event.type === "user" && event.message) {
        const incomingContent: ContentBlock[] = event.message.content || [];

        processTaskToolResults(sessionId, incomingContent, msgs);

        for (const block of incomingContent) {
          if (block.type === "tool_result" && block.tool_use_id) {
            for (let i = msgs.length - 1; i >= 0; i--) {
              const msg = msgs[i];
              if (msg.role !== "assistant") continue;
              const hasToolUse = msg.content.some(
                (b) => b.type === "tool_use" && b.id === block.tool_use_id
              );
              if (hasToolUse) {
                const updates: Partial<ChatMessage> = {
                  content: [...msg.content, block],
                };
                const isAgent = msg.content.some(
                  (b) => b.type === "tool_use" && b.id === block.tool_use_id && b.name === "Agent"
                );
                if (isAgent) {
                  let childCount = 0;
                  for (let k = i + 1; k < msgs.length; k++) {
                    if (msgs[k].role === "user") break;
                    childCount++;
                  }
                  updates.agentChildCount = childCount;
                }
                msgs[i] = { ...msg, ...updates };
                break;
              }
            }
          }
        }
      } else if (event.type === "result") {
        const startTime = get().streamStartTimes[sessionId];
        let turnTokens = 0;
        let lastAssistantIdx = -1;
        let inputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0, outputTokens = 0;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "user") break;
          if (msgs[i].role === "assistant") {
            if (lastAssistantIdx === -1) lastAssistantIdx = i;
            if (msgs[i].usage) {
              const u = msgs[i].usage!;
              inputTokens += u.input_tokens || 0;
              outputTokens += u.output_tokens || 0;
              cacheCreationTokens += u.cache_creation_input_tokens || 0;
              cacheReadTokens += u.cache_read_input_tokens || 0;
              turnTokens += (u.input_tokens || 0) + (u.output_tokens || 0)
                + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
            }
          }
        }
        if (lastAssistantIdx >= 0) {
          const durationMs = startTime
            ? Math.max(0, Date.now() - startTime)
            : (event.duration_ms || 0);
          msgs[lastAssistantIdx] = {
            ...msgs[lastAssistantIdx],
            turnMeta: {
              tokens: turnTokens,
              durationMs,
              costUsd: event.total_cost_usd,
              inputTokens,
              cacheCreationTokens,
              cacheReadTokens,
              outputTokens,
            },
          };
        }
        // 记录到 token 使用统计
        if (event.total_cost_usd != null || turnTokens > 0) {
          const session = get().sessions.find((s) => s.id === sessionId);
          if (session) {
            useTokenUsageStore.getState().addUsage({
              projectPath: session.projectPath,
              projectName: session.projectName,
              inputTokens,
              cacheCreationTokens,
              cacheReadTokens,
              outputTokens,
              costUsd: event.total_cost_usd ?? 0,
            });
          }
        }
        for (let i = 0; i < msgs.length; i++) {
          if (msgs[i].isStreaming || msgs[i].streamMessageId === "__streaming__") {
            msgs[i] = {
              ...msgs[i],
              isStreaming: false,
              // Drop the live-stream placeholder marker so a new turn's deltas
              // don't append onto a finished (or errored) message.
              streamMessageId:
                msgs[i].streamMessageId === "__streaming__"
                  ? undefined
                  : msgs[i].streamMessageId,
            };
          }
        }
        const projectName = get().sessions.find((s) => s.id === sessionId)?.projectName;
        notify("ClaudeBox", `${projectName ?? "Task"} completed`);
        const restInteractions = { ...get().pendingInteractions };
        delete restInteractions[sessionId];
        set({
          streamingSessions: { ...get().streamingSessions, [sessionId]: false },
          pendingInteractions: restInteractions,
        });
        if (get().currentSessionId !== sessionId) {
          get().markUnread(sessionId);
        }
      } else if (event.type === "ask_user" && event.requestId) {
        notify("ClaudeBox", "Claude needs your input");
        set({
          pendingInteractions: {
            ...get().pendingInteractions,
            [sessionId]: {
              type: "ask_user",
              requestId: event.requestId,
              sessionId,
              questions: event.questions,
            },
          },
        });
      } else if (event.type === "exit_plan" && event.requestId) {
        notify("ClaudeBox", "Plan ready — approval needed");
        set({
          pendingInteractions: {
            ...get().pendingInteractions,
            [sessionId]: {
              type: "exit_plan",
              requestId: event.requestId,
              sessionId,
              input: event.input,
              planContent: event.planContent,
            },
          },
        });
      } else if (event.type === "tool_permission" && event.requestId) {
        notify("ClaudeBox", `Tool permission: ${event.toolName}`);
        set({
          pendingInteractions: {
            ...get().pendingInteractions,
            [sessionId]: {
              type: "tool_permission",
              requestId: event.requestId,
              sessionId,
              toolName: event.toolName,
              toolInput: event.input,
            },
          },
        });
      } else if (event.type === "skills" && event.skills) {
        const sessions = get().sessions.map((s) =>
          s.id === sessionId
            ? { ...s, skills: event.skills, skillSources: event.skillSources, updatedAt: Date.now() }
            : s
        );
        set({ sessions });
        // Sync to global skills cache
        try {
          const normalizedSkills = (event.skills || []).map((s: any) =>
            typeof s === "string" ? { name: s, desc: s } : s
          );
          useSkillsStore.getState().updateFromSession(normalizedSkills, event.skillSources || {});
        } catch { /* ignore */ }
      } else if (event.type === "error") {
        try {
          const raw = JSON.parse(data);
          set({ streamError: raw.message || "Unknown sidecar error" });
        } catch {
          set({ streamError: "Unknown sidecar error" });
        }
      }

      set({ messages: { ...get().messages, [sessionId]: msgs } });
    } catch {
      // Non-JSON
    }
  },

  handleStreamDone: (sessionId, error, force) => {
    // Guard against late `done` events from a previous child process that
    // exited *after* the auto-queue picked up the next message and started a
    // fresh stream. result-event already flipped streaming to false; if it's
    // back to true now it means a new process is running for this session and
    // we must not clobber its streaming state. Errors and explicit
    // user-initiated stops (force=true) always pass through.
    const currentlyStreaming = !!get().streamingSessions[sessionId];
    if (!force && currentlyStreaming && !error) {
      return;
    }
    const msgs = [...(get().messages[sessionId] || [])];
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].isStreaming || msgs[i].streamMessageId === "__streaming__") {
        msgs[i] = {
          ...msgs[i],
          isStreaming: false,
          streamMessageId:
            msgs[i].streamMessageId === "__streaming__"
              ? undefined
              : msgs[i].streamMessageId,
        };
      }
    }
    const sessions = get().sessions.map((s) =>
      s.id === sessionId ? { ...s, updatedAt: Date.now() } : s
    );
    saveSessions(sessions);
    // Persist messages to file storage
    saveMessages(sessionId, msgs);
    const restInteractions = { ...get().pendingInteractions };
    delete restInteractions[sessionId];
    set({
      sessions,
      messages: { ...get().messages, [sessionId]: msgs },
      streamingSessions: { ...get().streamingSessions, [sessionId]: false },
      streamError: error || null,
      pendingInteractions: restInteractions,
    });
    if (!error && get().currentSessionId !== sessionId) {
      get().markUnread(sessionId);
    }
  },

  setStreaming: (sessionId, streaming) => set({
    streamingSessions: { ...get().streamingSessions, [sessionId]: streaming },
  }),
  clearError: () => set({ streamError: null }),
  clearPendingInteraction: (sessionId) => {
    const rest = { ...get().pendingInteractions };
    delete rest[sessionId];
    set({ pendingInteractions: rest });
  },
  setToolAnswered: (toolUseId, data) => {
    const answeredTools = { ...get().answeredTools, [toolUseId]: data };
    set({ answeredTools });
    saveAnsweredTools(answeredTools);
  },

  reorderPinned: (fromIndex, toIndex) => {
    const sessions = [...get().sessions];
    const pinnedSessions = sessions.filter((s) => s.pinned);
    if (
      fromIndex < 0 ||
      fromIndex >= pinnedSessions.length ||
      toIndex < 0 ||
      toIndex >= pinnedSessions.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const moved = pinnedSessions[fromIndex];
    const target = pinnedSessions[toIndex];
    const fromGlobal = sessions.indexOf(moved);
    const toGlobal = sessions.indexOf(target);
    sessions.splice(fromGlobal, 1);
    const adjustedTo = fromGlobal < toGlobal ? toGlobal - 1 : toGlobal;
    sessions.splice(adjustedTo, 0, moved);
    saveSessions(sessions);
    set({ sessions });
  },

  togglePinned: (id) => {
    const sessions = get().sessions;
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const target = sessions[idx];
    const nextPinned = !target.pinned;
    if (nextPinned) {
      // Place at end of pinned section (= just before first non-pinned)
      const without = sessions.filter((s) => s.id !== id);
      const insertAt = without.findIndex((s) => !s.pinned);
      const updated = { ...target, pinned: true };
      const next = [...without];
      if (insertAt === -1) next.push(updated);
      else next.splice(insertAt, 0, updated);
      saveSessions(next);
      set({ sessions: next });
    } else {
      // Just flip the flag; recent section is sorted by updatedAt at render time
      const next = sessions.map((s) =>
        s.id === id ? { ...s, pinned: false } : s
      );
      saveSessions(next);
      set({ sessions: next });
    }
  },

  bumpSessionToTop: (id) => {
    // Only refresh updatedAt; SessionList renders pinned section first (manual order)
    // followed by non-pinned sorted by updatedAt desc, so the timestamp is what matters.
    const sessions = get().sessions.map((s) =>
      s.id === id ? { ...s, updatedAt: Date.now() } : s
    );
    saveSessions(sessions);
    set({ sessions });
  },

  markUnread: (id) => {
    const sessions = get().sessions.map((s) =>
      s.id === id ? { ...s, unread: true } : s
    );
    saveSessions(sessions);
    set({ sessions });
  },

  clearUnread: (id) => {
    const sessions = get().sessions;
    const target = sessions.find((s) => s.id === id);
    if (!target?.unread) return;
    const next = sessions.map((s) => (s.id === id ? { ...s, unread: false } : s));
    saveSessions(next);
    set({ sessions: next });
  },

  enqueueMessage: (sessionId, content, attachments) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const item: QueuedMessage = {
      id: v4Style(),
      content: trimmed,
      attachments,
      enqueuedAt: Date.now(),
    };
    const current = get().messageQueue[sessionId] || [];
    set({ messageQueue: { ...get().messageQueue, [sessionId]: [...current, item] } });
  },

  removeQueuedMessage: (sessionId, queueItemId) => {
    const current = get().messageQueue[sessionId];
    if (!current || current.length === 0) return;
    const next = current.filter((q) => q.id !== queueItemId);
    if (next.length === current.length) return;
    set({ messageQueue: { ...get().messageQueue, [sessionId]: next } });
  },

  popQueuedMessage: (sessionId) => {
    const current = get().messageQueue[sessionId];
    if (!current || current.length === 0) return null;
    const [head, ...rest] = current;
    set({ messageQueue: { ...get().messageQueue, [sessionId]: rest } });
    return head;
  },

  clearMessageQueue: (sessionId) => {
    const queue = get().messageQueue[sessionId];
    if (!queue || queue.length === 0) return;
    set({ messageQueue: { ...get().messageQueue, [sessionId]: [] } });
  },

  saveInputDraft: (sessionId, draft) => {
    const isEmpty = !draft.content.trim() && draft.attachments.length === 0;
    const existing = get().inputDrafts[sessionId];
    if (isEmpty) {
      if (!existing) return;
      const next = { ...get().inputDrafts };
      delete next[sessionId];
      set({ inputDrafts: next });
      return;
    }
    set({ inputDrafts: { ...get().inputDrafts, [sessionId]: draft } });
  },

  clearInputDraft: (sessionId) => {
    if (!get().inputDrafts[sessionId]) return;
    const next = { ...get().inputDrafts };
    delete next[sessionId];
    set({ inputDrafts: next });
  },

  openDiffDialog: (sessionId) => set({ viewDiffSessionId: sessionId }),
  closeDiffDialog: () => set({ viewDiffSessionId: null }),
}));

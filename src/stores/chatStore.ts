import { create } from "zustand";
import { useTokenUsageStore } from "./tokenUsageStore";
import type {
  ChatMessage,
  ContentBlock,
  StreamMessage,
  PendingInteraction,
  AnsweredToolData,
} from "../lib/stream-parser";
import { useTaskStore } from "./taskStore";
import { v4Style } from "../lib/utils";
import { storageRead, storageWrite, storageRemove } from "../lib/storage";

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
  createdAt: number;
  updatedAt: number;
  /** Real Claude session ID (from system init message) — used for --resume across app restarts */
  claudeSessionId?: string;
}

export const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "NotebookEdit", "Agent"];

interface ChatState {
  sessions: Session[];
  currentSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  stderrLogs: Record<string, string[]>;
  streamStartTimes: Record<string, number>;
  /** Per-session streaming state */
  streamingSessions: Record<string, boolean>;
  streamError: string | null;
  /** Pending interactive tool request (AskUserQuestion / ExitPlanMode) */
  pendingInteraction: PendingInteraction | null;
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
  addUserMessage: (sessionId: string, content: string, attachments?: { name: string; type: string; path?: string; dataUrl?: string }[]) => void;
  addSystemMessage: (sessionId: string, text: string) => void;
  addLaunchMessage: (sessionId: string, pid: number, resumeFrom?: string) => void;
  handleStreamData: (sessionId: string, data: string, stream: string) => void;
  handleStreamDone: (sessionId: string, error?: string) => void;
  setStreaming: (sessionId: string, streaming: boolean) => void;
  clearError: () => void;
  /** Clear the pending interaction after it has been responded to */
  clearPendingInteraction: () => void;
  /** Mark an interactive tool as answered, persisting data across re-renders */
  setToolAnswered: (toolUseId: string, data: AnsweredToolData) => void;
}

// ── File storage keys ───────────────────────────────────────────────

const SESSIONS_KEY = "sessions";
const MESSAGES_KEY_PREFIX = "msgs-";

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
        allowedTools: s.allowedTools ?? DEFAULT_TOOLS,
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
        allowedTools: s.allowedTools ?? DEFAULT_TOOLS,
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
        taskStore.handleToolUse(sessionId, block.name, block.input);
      }
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

// ── Store ───────────────────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: {},
  stderrLogs: {},
  streamStartTimes: {},
  streamingSessions: {},
  streamError: null,
  pendingInteraction: null,
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

    set({
      sessions,
      currentSessionId: null,
      messages,
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
        // Persist Claude session ID for --resume across app restarts
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

        const existingIdx = streamMsgId
          ? msgs.findIndex(
              (m) =>
                m.role === "assistant" &&
                m.streamMessageId === streamMsgId
            )
          : -1;

        if (existingIdx >= 0) {
          const existing = msgs[existingIdx];
          msgs[existingIdx] = {
            ...existing,
            content: appendNewBlocks(existing.content, incomingContent),
            model: event.message.model || existing.model,
            usage: event.message.usage
              ? {
                  input_tokens: event.message.usage.input_tokens,
                  output_tokens: event.message.usage.output_tokens,
                  cache_creation_input_tokens: event.message.usage.cache_creation_input_tokens,
                  cache_read_input_tokens: event.message.usage.cache_read_input_tokens,
                  server_tool_use_input_tokens: event.message.usage.server_tool_use_input_tokens,
                  contextWindow: event.message.usage.contextWindow,
                }
              : existing.usage,
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
            usage: event.message.usage
              ? {
                  input_tokens: event.message.usage.input_tokens,
                  output_tokens: event.message.usage.output_tokens,
                  cache_creation_input_tokens: event.message.usage.cache_creation_input_tokens,
                  cache_read_input_tokens: event.message.usage.cache_read_input_tokens,
                  server_tool_use_input_tokens: event.message.usage.server_tool_use_input_tokens,
                  contextWindow: event.message.usage.contextWindow,
                }
              : undefined,
          });
        }
      } else if (event.type === "user" && event.message) {
        const incomingContent: ContentBlock[] = event.message.content || [];

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
          if (msgs[i].isStreaming) {
            msgs[i] = { ...msgs[i], isStreaming: false };
          }
        }
        set({
          streamingSessions: { ...get().streamingSessions, [sessionId]: false },
          pendingInteraction: get().pendingInteraction?.sessionId === sessionId ? null : get().pendingInteraction,
        });
      } else if (event.type === "ask_user" && event.requestId) {
        set({
          pendingInteraction: {
            type: "ask_user",
            requestId: event.requestId,
            sessionId,
            questions: event.questions,
          },
        });
      } else if (event.type === "exit_plan" && event.requestId) {
        set({
          pendingInteraction: {
            type: "exit_plan",
            requestId: event.requestId,
            sessionId,
            input: event.input,
            planContent: event.planContent,
          },
        });
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

  handleStreamDone: (sessionId, error) => {
    const msgs = [...(get().messages[sessionId] || [])];
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].isStreaming) {
        msgs[i] = { ...msgs[i], isStreaming: false };
      }
    }
    const sessions = get().sessions.map((s) =>
      s.id === sessionId ? { ...s, updatedAt: Date.now() } : s
    );
    saveSessions(sessions);
    // Persist messages to file storage
    saveMessages(sessionId, msgs);
    set({
      sessions,
      messages: { ...get().messages, [sessionId]: msgs },
      streamingSessions: { ...get().streamingSessions, [sessionId]: false },
      streamError: error || null,
    });
  },

  setStreaming: (sessionId, streaming) => set({
    streamingSessions: { ...get().streamingSessions, [sessionId]: streaming },
  }),
  clearError: () => set({ streamError: null }),
  clearPendingInteraction: () => set({ pendingInteraction: null }),
  setToolAnswered: (toolUseId, data) => set({
    answeredTools: { ...get().answeredTools, [toolUseId]: data },
  }),
}));

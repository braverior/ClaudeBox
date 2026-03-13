import { create } from "zustand";
import type {
  ChatMessage,
  ContentBlock,
  StreamMessage,
  PendingInteraction,
} from "../lib/stream-parser";
import { useTaskStore } from "./taskStore";
import { v4Style } from "../lib/utils";

export interface Session {
  id: string;
  projectPath: string;
  projectName: string;
  model: string;
  permissionMode: string;
  allowedTools: string[];
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

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

  createSession: (projectPath: string, model: string, permissionMode: string) => string;
  removeSession: (id: string) => void;
  switchSession: (id: string) => void;
  updateSession: (id: string, updates: Partial<Pick<Session, "model" | "permissionMode" | "allowedTools">>) => void;
  addUserMessage: (sessionId: string, content: string, attachments?: { name: string; type: string; path?: string; dataUrl?: string }[]) => void;
  addSystemMessage: (sessionId: string, text: string) => void;
  addLaunchMessage: (sessionId: string, pid: number) => void;
  handleStreamData: (sessionId: string, data: string, stream: string) => void;
  handleStreamDone: (sessionId: string, error?: string) => void;
  setStreaming: (sessionId: string, streaming: boolean) => void;
  clearError: () => void;
  loadSessions: () => void;
  /** Clear the pending interaction after it has been responded to */
  clearPendingInteraction: () => void;
}

const SESSIONS_KEY = "claudebox-sessions";
const MESSAGES_KEY_PREFIX = "claudebox-msgs-";

function loadSessions(): Session[] {
  try {
    const stored = localStorage.getItem(SESSIONS_KEY);
    if (stored) {
      const sessions: Session[] = JSON.parse(stored);
      // Migrate old sessions: add default allowedTools if missing
      return sessions.map((s) => ({
        ...s,
        allowedTools: s.allowedTools ?? DEFAULT_TOOLS,
      }));
    }
  } catch { /* ignore */ }
  return [];
}

function saveSessions(sessions: Session[]) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

function loadMessages(sessionId: string): ChatMessage[] {
  try {
    const stored = localStorage.getItem(MESSAGES_KEY_PREFIX + sessionId);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return [];
}

function saveMessages(sessionId: string, msgs: ChatMessage[]) {
  try {
    localStorage.setItem(MESSAGES_KEY_PREFIX + sessionId, JSON.stringify(msgs));
  } catch { /* ignore — may exceed quota */ }
}

function removeMessages(sessionId: string) {
  localStorage.removeItem(MESSAGES_KEY_PREFIX + sessionId);
}

function extractProjectName(path: string): string {
  // Handle both Unix "/" and Windows "\" path separators
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

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
    // If block has an id and we already have it, skip (or update)
    if (block.id && existingIds.has(block.id)) {
      // Update existing block in place (e.g. tool_use input may have grown)
      const idx = result.findIndex((b) => b.id === block.id);
      if (idx >= 0) result[idx] = block;
      continue;
    }

    // For text blocks with same type as the last existing block, update (streaming text)
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

const initialSessions = loadSessions();
// Pre-load messages for the most recent session so they show on startup
const initialMessages: Record<string, ChatMessage[]> = {};
if (initialSessions.length > 0) {
  const msgs = loadMessages(initialSessions[0].id);
  if (msgs.length > 0) {
    initialMessages[initialSessions[0].id] = msgs;
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: initialSessions,
  // Auto-restore the most recent session
  currentSessionId: initialSessions.length > 0 ? initialSessions[0].id : null,
  messages: initialMessages,
  stderrLogs: {},
  streamStartTimes: {},
  streamingSessions: {},
  streamError: null,
  pendingInteraction: null,

  createSession: (projectPath, model, permissionMode) => {
    // If a session with this path already exists, switch to it
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
    // Load persisted messages if not already in memory
    const currentMsgs = get().messages[id];
    if (!currentMsgs) {
      const loaded = loadMessages(id);
      if (loaded.length > 0) {
        set({
          currentSessionId: id,
          streamError: null,
          messages: { ...get().messages, [id]: loaded },
        });
        return;
      }
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

  addUserMessage: (sessionId, content, attachments) => {
    const msg: ChatMessage = {
      id: v4Style(),
      role: "user",
      content: [{ type: "text", text: content }],
      timestamp: Date.now(),
      attachments,
    };
    const msgs = [...(get().messages[sessionId] || []), msg];
    // Clear task list for a fresh interaction
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

  addLaunchMessage: (sessionId, pid) => {
    const msg: ChatMessage = {
      id: v4Style(),
      role: "assistant",
      content: [{ type: "text", text: `__launch__:${JSON.stringify({ pid })}` }],
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

      // Helper: finalize the launch placeholder when real content arrives
      const finalizeLaunch = () => {
        const launchIdx = msgs.findIndex(
          (m) => m.role === "assistant" && m.streamMessageId === "__launch__"
        );
        if (launchIdx >= 0) {
          msgs[launchIdx] = { ...msgs[launchIdx], isStreaming: false };
        }
      };

      if (event.type === "system") {
        // Any system event finalizes the launch message
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

        // Finalize launch placeholder when first real assistant content arrives
        finalizeLaunch();

        // Process task tool calls
        processTaskToolCalls(sessionId, incomingContent);

        // Find existing assistant message with the same stream message id
        const existingIdx = streamMsgId
          ? msgs.findIndex(
              (m) =>
                m.role === "assistant" &&
                m.streamMessageId === streamMsgId
            )
          : -1;

        if (existingIdx >= 0) {
          // Same turn — append new content blocks
          const existing = msgs[existingIdx];
          msgs[existingIdx] = {
            ...existing,
            content: appendNewBlocks(existing.content, incomingContent),
            model: event.message.model || existing.model,
            usage: event.message.usage
              ? {
                  input_tokens: event.message.usage.input_tokens,
                  output_tokens: event.message.usage.output_tokens,
                }
              : existing.usage,
          };
        } else {
          // New turn — create a new assistant message
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
                }
              : undefined,
          });
        }
      } else if (event.type === "user" && event.message) {
        // Tool result messages — inject results into the matching assistant message
        const incomingContent: ContentBlock[] = event.message.content || [];

        for (const block of incomingContent) {
          if (block.type === "tool_result" && block.tool_use_id) {
            // Find the assistant message that contains the matching tool_use
            for (let i = msgs.length - 1; i >= 0; i--) {
              const msg = msgs[i];
              if (msg.role !== "assistant") continue;
              const hasToolUse = msg.content.some(
                (b) => b.type === "tool_use" && b.id === block.tool_use_id
              );
              if (hasToolUse) {
                // Append tool_result block to that assistant message
                msgs[i] = {
                  ...msg,
                  content: [...msg.content, block],
                };
                break;
              }
            }
          }
        }
      } else if (event.type === "result") {
        // Calculate turn tokens and duration, store on the last assistant message
        const startTime = get().streamStartTimes[sessionId];
        let turnTokens = 0;
        let lastAssistantIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "user") break;
          if (msgs[i].role === "assistant") {
            if (lastAssistantIdx === -1) lastAssistantIdx = i;
            if (msgs[i].usage) {
              turnTokens += (msgs[i].usage!.input_tokens || 0) + (msgs[i].usage!.output_tokens || 0);
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
            },
          };
        }
        // Mark all streaming messages as done
        for (let i = 0; i < msgs.length; i++) {
          if (msgs[i].isStreaming) {
            msgs[i] = { ...msgs[i], isStreaming: false };
          }
        }
        set({ streamingSessions: { ...get().streamingSessions, [sessionId]: false }, pendingInteraction: null });
      } else if (event.type === "ask_user" && event.requestId) {
        // Interactive: Claude is asking the user a question
        set({
          pendingInteraction: {
            type: "ask_user",
            requestId: event.requestId,
            questions: event.questions,
          },
        });
      } else if (event.type === "exit_plan" && event.requestId) {
        // Interactive: Claude wants to exit plan mode — user must approve
        set({
          pendingInteraction: {
            type: "exit_plan",
            requestId: event.requestId,
            input: event.input,
            planContent: event.planContent,
          },
        });
      } else if (event.type === "error") {
        // Sidecar error — parse the raw data for the message field
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
    // Persist messages to localStorage
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
  loadSessions: () => set({ sessions: loadSessions() }),
  clearPendingInteraction: () => set({ pendingInteraction: null }),
}));

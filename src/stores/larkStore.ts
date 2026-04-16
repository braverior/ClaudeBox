import { create } from "zustand";
import { storageRead, storageWrite } from "../lib/storage";

// ── Types ────────────────────────────────────────────────────────────

export interface LarkConfig {
  appId: string;
  appSecret: string;
  autoConnect: boolean;
}

export type LarkStatus =
  | "stopped"
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "error";

export interface LarkMessage {
  id: string;
  messageId: string;
  senderId: string;
  content: string;
  timestamp: number;
  aiReply?: string;
  status: "received" | "processing" | "replied" | "error";
}

export interface DevTask {
  id: string;
  projectPath: string;
  projectName: string;
  description: string;
  status: "pending" | "in_progress" | "done";
  createdAt: number;
  updatedAt: number;
}

/** Tracks a Lark-triggered execution routed through the main chat flow */
export interface LarkExecution {
  sessionId: string;
  chatId: string;       // Lark chat ID for sending status updates
  messageId: string;
  prompt: string;
  summary: string;
  status: "running" | "completed" | "error";
  startedAt: number;
}

interface LarkState {
  config: LarkConfig;
  status: LarkStatus;
  messages: LarkMessage[];
  devTasks: DevTask[];
  errorMessage: string | null;
  loaded: boolean;
  /** Maps taskId → chatStore sessionId */
  taskSessionMap: Record<string, string>;
  /** Maps chatStore sessionId → LarkExecution for Lark-triggered sessions */
  larkExecutions: Record<string, LarkExecution>;

  init: () => Promise<void>;
  updateConfig: (partial: Partial<LarkConfig>) => void;
  setStatus: (status: LarkStatus) => void;
  addMessage: (msg: LarkMessage) => void;
  updateMessage: (messageId: string, updates: Partial<LarkMessage>) => void;
  addTask: (task: DevTask) => void;
  updateTask: (taskId: string, updates: Partial<DevTask>) => void;
  setError: (msg: string | null) => void;
  clearMessages: () => void;
  setTaskSession: (taskId: string, sessionId: string) => void;
  addLarkExecution: (execution: LarkExecution) => void;
  updateLarkExecution: (sessionId: string, updates: Partial<LarkExecution>) => void;
  getLarkExecution: (sessionId: string) => LarkExecution | undefined;
}

// ── Defaults ─────────────────────────────────────────────────────────

const defaultConfig: LarkConfig = {
  appId: "",
  appSecret: "",
  autoConnect: false,
};

const CONFIG_KEY = "lark-config";
const TASKS_KEY = "lark-tasks";

// ── Store ────────────────────────────────────────────────────────────

export const useLarkStore = create<LarkState>((set, get) => ({
  config: defaultConfig,
  status: "stopped",
  messages: [],
  devTasks: [],
  errorMessage: null,
  loaded: false,
  taskSessionMap: {},
  larkExecutions: {},

  init: async () => {
    // Load config
    try {
      const data = await storageRead(CONFIG_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        set({ config: { ...defaultConfig, ...parsed } });
      }
    } catch { /* ignore */ }

    // Load tasks
    try {
      const data = await storageRead(TASKS_KEY);
      if (data) {
        set({ devTasks: JSON.parse(data) });
      }
    } catch { /* ignore */ }

    set({ loaded: true });
  },

  updateConfig: (partial) => {
    const newConfig = { ...get().config, ...partial };
    set({ config: newConfig });
    storageWrite(CONFIG_KEY, JSON.stringify(newConfig)).catch(() => {});
  },

  setStatus: (status) => set({ status }),

  addMessage: (msg) => {
    set({ messages: [...get().messages.slice(-99), msg] }); // Keep last 100
  },

  updateMessage: (messageId, updates) => {
    set({
      messages: get().messages.map((m) =>
        m.messageId === messageId ? { ...m, ...updates } : m,
      ),
    });
  },

  addTask: (task) => {
    const newTasks = [...get().devTasks, task];
    set({ devTasks: newTasks });
    storageWrite(TASKS_KEY, JSON.stringify(newTasks)).catch(() => {});
  },

  updateTask: (taskId, updates) => {
    const newTasks = get().devTasks.map((t) =>
      t.id === taskId ? { ...t, ...updates, updatedAt: Date.now() } : t,
    );
    set({ devTasks: newTasks });
    storageWrite(TASKS_KEY, JSON.stringify(newTasks)).catch(() => {});
  },

  setError: (msg) => set({ errorMessage: msg }),

  clearMessages: () => set({ messages: [] }),

  setTaskSession: (taskId, sessionId) => {
    set({ taskSessionMap: { ...get().taskSessionMap, [taskId]: sessionId } });
  },

  addLarkExecution: (execution) => {
    set({ larkExecutions: { ...get().larkExecutions, [execution.sessionId]: execution } });
  },

  updateLarkExecution: (sessionId, updates) => {
    const existing = get().larkExecutions[sessionId];
    if (existing) {
      set({
        larkExecutions: {
          ...get().larkExecutions,
          [sessionId]: { ...existing, ...updates },
        },
      });
    }
  },

  getLarkExecution: (sessionId) => get().larkExecutions[sessionId],
}));

import { create } from "zustand";
import { storageRead, storageWrite } from "../lib/storage";

const STORAGE_KEY = "token-usage";

export interface ProjectTokenStats {
  projectPath: string;
  projectName: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  turnCount: number;
  lastUpdated: number;
}

interface TokenUsageState {
  stats: Record<string, ProjectTokenStats>; // keyed by projectPath
  loaded: boolean;
  init: () => Promise<void>;
  addUsage: (opts: {
    projectPath: string;
    projectName: string;
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    costUsd: number;
  }) => void;
  resetProject: (projectPath: string) => void;
  resetAll: () => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ]);
}

export const useTokenUsageStore = create<TokenUsageState>((set, get) => ({
  stats: {},
  loaded: false,

  init: async () => {
    try {
      const data = await withTimeout(storageRead(STORAGE_KEY), 5000);
      if (data) {
        set({ stats: JSON.parse(data), loaded: true });
        return;
      }
    } catch { /* ignore */ }
    set({ loaded: true });
  },

  addUsage: ({ projectPath, projectName, inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens, costUsd }) => {
    const existing = get().stats[projectPath];
    const updated: ProjectTokenStats = existing
      ? {
          ...existing,
          projectName, // keep name fresh
          inputTokens: existing.inputTokens + inputTokens,
          cacheCreationTokens: existing.cacheCreationTokens + cacheCreationTokens,
          cacheReadTokens: existing.cacheReadTokens + cacheReadTokens,
          outputTokens: existing.outputTokens + outputTokens,
          costUsd: existing.costUsd + costUsd,
          turnCount: existing.turnCount + 1,
          lastUpdated: Date.now(),
        }
      : {
          projectPath,
          projectName,
          inputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          outputTokens,
          costUsd,
          turnCount: 1,
          lastUpdated: Date.now(),
        };

    const newStats = { ...get().stats, [projectPath]: updated };
    set({ stats: newStats });
    storageWrite(STORAGE_KEY, JSON.stringify(newStats)).catch(() => {});
  },

  resetProject: (projectPath) => {
    const newStats = { ...get().stats };
    delete newStats[projectPath];
    set({ stats: newStats });
    storageWrite(STORAGE_KEY, JSON.stringify(newStats)).catch(() => {});
  },

  resetAll: () => {
    set({ stats: {} });
    storageWrite(STORAGE_KEY, JSON.stringify({})).catch(() => {});
  },
}));

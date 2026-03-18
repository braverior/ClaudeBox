import { create } from "zustand";
import { storageRead, storageWrite } from "../lib/storage";

export interface Settings {
  model: string;
  models: string[];
  permissionMode: string;
  claudePath: string;
  workingDirectory: string;
  theme: "dark" | "light";
  locale: "en" | "zh";
  apiKey: string;
  baseUrl: string;
}

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  init: () => Promise<void>;
  updateSettings: (partial: Partial<Settings>) => void;
}

const STORAGE_KEY = "settings";
const LS_STORAGE_KEY = "claudebox-settings";

const defaultSettings: Settings = {
  model: "",
  models: [],
  permissionMode: "",
  claudePath: "claude",
  workingDirectory: "",
  theme: "dark",
  locale: "en",
  apiKey: "",
  baseUrl: "",
};

/** Wraps a promise with a timeout — rejects after `ms` milliseconds */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: defaultSettings,
  loaded: false,

  init: async () => {
    // 1. Try loading from file storage (5s timeout guards against IPC hang)
    try {
      const data = await withTimeout(storageRead(STORAGE_KEY), 5000);
      if (data) {
        set({ settings: { ...defaultSettings, ...JSON.parse(data) }, loaded: true });
        return;
      }
    } catch { /* ignore */ }

    // 2. Migrate from localStorage
    try {
      const lsData = localStorage.getItem(LS_STORAGE_KEY);
      if (lsData) {
        const parsed = { ...defaultSettings, ...JSON.parse(lsData) };
        // Save to file storage
        await storageWrite(STORAGE_KEY, JSON.stringify(parsed)).catch(() => {});
        // Clean up localStorage
        localStorage.removeItem(LS_STORAGE_KEY);
        set({ settings: parsed, loaded: true });
        return;
      }
    } catch { /* ignore */ }

    // 3. Defaults
    set({ loaded: true });
  },

  updateSettings: (partial) => {
    const newSettings = { ...get().settings, ...partial };
    set({ settings: newSettings });
    storageWrite(STORAGE_KEY, JSON.stringify(newSettings)).catch(() => {});
  },
}));

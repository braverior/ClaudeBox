import { create } from "zustand";
import { storageRead, storageWrite } from "../lib/storage";
import { detectProviderByBaseUrl, type ModelConfig } from "../lib/providers";

export type { ModelConfig };

export interface Settings {
  model: string;
  models: ModelConfig[];
  defaultModel: string;
  haikuModel: string;
  sonnetModel: string;
  opusModel: string;
  effort: string;
  contextWindow: "200k" | "1m";
  permissionMode: string;
  claudePath: string;
  workingDirectory: string;
  theme: "dark" | "light";
  locale: "en" | "zh";
  apiKey: string;
  baseUrl: string;
  autoStart: boolean;
  notifications: boolean;
}

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  init: () => Promise<void>;
  updateSettings: (partial: Partial<Settings>) => void;
}

const STORAGE_KEY = "settings";
const LS_STORAGE_KEY = "claudebox-settings";

function getSystemLocale(): "en" | "zh" {
  const lang = navigator.language || (navigator as any).userLanguage || "en";
  return lang.startsWith("zh") ? "zh" : "en";
}

const defaultSettings: Settings = {
  model: "",
  models: [],
  defaultModel: "",
  haikuModel: "",
  sonnetModel: "",
  opusModel: "",
  effort: "high",
  contextWindow: "200k",
  permissionMode: "",
  claudePath: "claude",
  workingDirectory: "",
  theme: "dark",
  locale: getSystemLocale(),
  apiKey: "",
  baseUrl: "",
  autoStart: false,
  notifications: true,
};

/** Wraps a promise with a timeout — rejects after `ms` milliseconds */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function migrateSettings(raw: any): Settings {
  const merged = { ...defaultSettings, ...raw };
  const models = merged.models;
  if (Array.isArray(models) && models.length > 0 && typeof models[0] === "string") {
    const globalKey = typeof merged.apiKey === "string" ? merged.apiKey : "";
    const globalUrl = typeof merged.baseUrl === "string" ? merged.baseUrl : "";
    const providerId = detectProviderByBaseUrl(globalUrl);
    merged.models = (models as string[]).map((id) => ({
      id,
      providerId,
      baseUrl: globalUrl,
      apiKey: globalKey,
    }));
  } else if (!Array.isArray(models)) {
    merged.models = [];
  } else {
    // Rename legacy "alibaba" providerId to "qwen"
    merged.models = (models as ModelConfig[]).map((m) =>
      m.providerId === "alibaba" ? { ...m, providerId: "qwen" } : m
    );
  }
  return merged as Settings;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: defaultSettings,
  loaded: false,

  init: async () => {
    // 1. Try loading from file storage (5s timeout guards against IPC hang)
    try {
      const data = await withTimeout(storageRead(STORAGE_KEY), 5000);
      if (data) {
        set({ settings: migrateSettings(JSON.parse(data)), loaded: true });
        return;
      }
    } catch { /* ignore */ }

    // 2. Migrate from localStorage
    try {
      const lsData = localStorage.getItem(LS_STORAGE_KEY);
      if (lsData) {
        const parsed = migrateSettings(JSON.parse(lsData));
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

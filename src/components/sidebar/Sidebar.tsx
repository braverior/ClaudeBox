import { useState } from "react";
import {
  Settings,
  PanelLeftClose,
  PanelLeft,
  FolderOpen,
  Sun,
  Moon,
  Languages,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import SessionList from "./SessionList";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useT } from "../../lib/i18n";

interface SidebarProps {
  onOpenSettings: () => void;
}

export default function Sidebar({ onOpenSettings }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { settings, updateSettings } = useSettingsStore();
  const { createSession } = useChatStore();
  const t = useT();

  const toggleTheme = () => {
    updateSettings({ theme: settings.theme === "dark" ? "light" : "dark" });
  };

  const toggleLocale = () => {
    updateSettings({ locale: settings.locale === "en" ? "zh" : "en" });
  };

  const handleOpenProject = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      createSession(selected, settings.model || "", settings.permissionMode || "");
    }
  };

  if (collapsed) {
    return (
      <div className="w-[70px] border-r border-border bg-bg-secondary flex flex-col items-center gap-3">
        {/* macOS traffic light spacing */}
        <div data-tauri-drag-region className="h-12 w-full flex-shrink-0" />
        <button
          onClick={() => setCollapsed(false)}
          className="p-2 rounded-lg hover:bg-bg-tertiary/50 text-text-secondary hover:text-text-primary transition-colors"
          title={t("sidebar.expandSidebar")}
        >
          <PanelLeft size={18} />
        </button>
      </div>
    );
  }

  return (
    <div className="w-64 border-r border-border bg-bg-secondary flex flex-col">
      {/* Header — with macOS traffic light inset */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between pl-[78px] pr-3 h-12 flex-shrink-0 border-b border-border"
      >
        <h1 className="text-sm font-bold text-text-primary tracking-wide pointer-events-none">
          ClaudeBox
        </h1>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1.5 rounded-lg hover:bg-bg-tertiary/50 text-text-secondary hover:text-text-primary transition-colors"
          title={t("sidebar.collapseSidebar")}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* Open Project */}
      <div className="px-2 py-2">
        <button
          onClick={handleOpenProject}
          className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg
                     bg-accent/10 text-accent hover:bg-accent/20 transition-colors
                     text-sm font-medium"
        >
          <FolderOpen size={16} />
          <span>{t("sidebar.openProject")}</span>
        </button>
      </div>

      {/* Session list */}
      <SessionList />

      {/* Footer */}
      <div className="border-t border-border px-2 py-2 flex items-center gap-1">
        <button
          onClick={toggleLocale}
          className="p-2 rounded-lg text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
          title={settings.locale === "en" ? "切换到中文" : "Switch to English"}
        >
          <Languages size={16} />
        </button>
        <button
          onClick={toggleTheme}
          className="p-2 rounded-lg text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
          title={settings.theme === "dark" ? t("sidebar.lightMode") : t("sidebar.darkMode")}
        >
          {settings.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          onClick={onOpenSettings}
          className="p-2 rounded-lg text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
          title={t("sidebar.settings")}
        >
          <Settings size={16} />
        </button>
      </div>
    </div>
  );
}

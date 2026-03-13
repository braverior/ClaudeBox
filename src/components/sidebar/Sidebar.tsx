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
      <div className="w-[70px] border-r border-border bg-bg-secondary flex flex-col items-center">
        {/* macOS traffic light spacing */}
        <div data-tauri-drag-region className="h-12 w-full flex-shrink-0" />
        <button
          onClick={() => setCollapsed(false)}
          className="p-2 rounded-lg hover:bg-bg-tertiary/50 text-text-secondary hover:text-text-primary transition-colors"
          title={t("sidebar.expandSidebar")}
        >
          <PanelLeft size={18} />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Footer buttons — vertical */}
        <div className="border-t border-border py-2 flex flex-col items-center gap-1 w-full">
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

  return (
    <div className="w-64 border-r border-border bg-bg-secondary flex flex-col">
      {/* Header — with macOS traffic light inset */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between pl-[78px] pr-3 h-14 flex-shrink-0"
      >
        <h1 className="text-sm font-bold text-text-primary tracking-wide pointer-events-none mt-2">
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
      <div className="px-2.5 py-2">
        <button
          onClick={handleOpenProject}
          className="group flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl
                     bg-bg-tertiary/25 backdrop-blur-sm
                     border border-border
                     text-text-secondary hover:text-text-primary
                     hover:bg-bg-tertiary/50 hover:border-accent/30
                     hover:shadow-lg hover:shadow-accent/5
                     active:scale-[0.98]
                     transition-all duration-200
                     text-sm font-medium"
        >
          <div className="flex items-center justify-center w-6 h-6 rounded-lg
                          bg-accent/10 group-hover:bg-accent/15
                          transition-colors duration-200">
            <FolderOpen size={14} className="text-accent/80 group-hover:text-accent transition-colors" />
          </div>
          <span>{t("sidebar.openProject")}</span>
        </button>
      </div>

      {/* Session list */}
      <SessionList />

      {/* Footer */}
      <div className="border-t border-border px-2 py-2 flex items-center justify-center gap-1">
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

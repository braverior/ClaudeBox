import { useState, useEffect, useRef } from "react";
import {
  Settings,
  PanelLeftClose,
  PanelLeft,
  FolderOpen,
  Sun,
  Moon,
  Languages,
  Info,
  RefreshCw,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import SessionList from "./SessionList";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useT } from "../../lib/i18n";
import type { UpdateStatus } from "../../lib/updater";

interface SidebarProps {
  onOpenSettings: () => void;
  updateStatus: UpdateStatus | null;
  onRestart: () => void;
}

export default function Sidebar({
  onOpenSettings,
  updateStatus,
  onRestart,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [versionPopover, setVersionPopover] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { settings, updateSettings } = useSettingsStore();
  const { createSession } = useChatStore();
  const t = useT();

  // Get app version on mount
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("unknown"));
  }, []);

  // Close popover on click outside
  useEffect(() => {
    if (!versionPopover) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setVersionPopover(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [versionPopover]);

  const toggleTheme = () => {
    updateSettings({ theme: settings.theme === "dark" ? "light" : "dark" });
  };

  const toggleLocale = () => {
    updateSettings({ locale: settings.locale === "en" ? "zh" : "en" });
  };

  const handleOpenProject = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      createSession(
        selected,
        settings.model || "",
        settings.permissionMode || ""
      );
    }
  };

  // Whether there's actionable update info (green dot indicator)
  const hasUpdate =
    updateStatus?.available &&
    (updateStatus.downloading || updateStatus.downloaded);

  // Build version status line
  const renderVersionStatus = () => {
    if (!updateStatus) return null;

    if (updateStatus.error) {
      return (
        <span className="text-xs text-text-muted">
          {t("version.checkFailed")}
        </span>
      );
    }

    if (updateStatus.downloaded && updateStatus.version) {
      return (
        <div className="flex items-center gap-2">
          <span className="text-xs text-success font-medium">
            {t("version.readyToInstall", { version: updateStatus.version })}
          </span>
          <button
            onClick={() => {
              setVersionPopover(false);
              onRestart();
            }}
            className="px-2 py-0.5 rounded-md bg-accent text-white text-xs font-medium
                       hover:bg-accent-hover transition-colors cursor-pointer"
          >
            {t("version.restart")}
          </button>
        </div>
      );
    }

    if (updateStatus.downloading && updateStatus.version) {
      return (
        <span className="text-xs text-accent flex items-center gap-1.5">
          <RefreshCw size={11} className="animate-spin" />
          {t("version.downloading", { version: updateStatus.version })}
        </span>
      );
    }

    if (updateStatus.available && updateStatus.version) {
      return (
        <span className="text-xs text-accent font-medium">
          {t("version.newVersion", { version: updateStatus.version })}
        </span>
      );
    }

    return (
      <span className="text-xs text-success">
        ✓ {t("version.upToDate")}
      </span>
    );
  };

  // Version button (shared between collapsed and expanded)
  const versionButton = (
    <button
      ref={buttonRef}
      onClick={() => setVersionPopover((v) => !v)}
      className="relative p-2 rounded-lg text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors cursor-pointer"
      title={`v${appVersion}`}
    >
      <Info size={16} />
      {hasUpdate && (
        <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-success ring-2 ring-bg-secondary" />
      )}
    </button>
  );

  // Version popover content
  const versionPopoverContent = versionPopover && (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-0 mb-2 ml-1 z-50
                 bg-bg-secondary border border-border rounded-xl
                 shadow-2xl shadow-black/20 px-4 py-3 min-w-[200px]
                 animate-fade-in"
    >
      <div className="text-xs font-semibold text-text-primary mb-1.5">
        ClaudeBox{" "}
        <span className="font-mono text-text-secondary">
          {t("version.current", { version: appVersion })}
        </span>
      </div>
      <div className="border-t border-border pt-1.5">{renderVersionStatus()}</div>
    </div>
  );

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
        <div className="relative border-t border-border py-2 flex flex-col items-center gap-1 w-full">
          {versionPopoverContent}
          {versionButton}
          <button
            onClick={toggleLocale}
            className="p-2 rounded-lg text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
            title={
              settings.locale === "en" ? "切换到中文" : "Switch to English"
            }
          >
            <Languages size={16} />
          </button>
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
            title={
              settings.theme === "dark"
                ? t("sidebar.lightMode")
                : t("sidebar.darkMode")
            }
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
          <div
            className="flex items-center justify-center w-6 h-6 rounded-lg
                          bg-accent/10 group-hover:bg-accent/15
                          transition-colors duration-200"
          >
            <FolderOpen
              size={14}
              className="text-accent/80 group-hover:text-accent transition-colors"
            />
          </div>
          <span>{t("sidebar.openProject")}</span>
        </button>
      </div>

      {/* Session list */}
      <SessionList />

      {/* Footer */}
      <div className="relative border-t border-border px-2 py-2 flex items-center justify-center gap-1">
        {versionPopoverContent}
        {versionButton}
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
          title={
            settings.theme === "dark"
              ? t("sidebar.lightMode")
              : t("sidebar.darkMode")
          }
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

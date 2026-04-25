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
  Github,
  BarChart2,
  Loader2,
  Send,
  History,
} from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import SessionList from "./SessionList";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useLarkStore, type LarkStatus } from "../../stores/larkStore";
import { startLarkBot, stopLarkBot } from "../../lib/lark-ipc";
import { useT } from "../../lib/i18n";
import { startWindowDrag, isWindows, handleTitleBarDoubleClick } from "../../lib/utils";
import type { UpdateStatus } from "../../lib/updater";

interface SidebarProps {
  onOpenSettings: () => void;
  onOpenTokenStats: () => void;
  updateStatus: UpdateStatus | null;
  onRestart: () => void;
  onCheckUpdate: () => Promise<void>;
  onShowChangelog: () => void;
}

export default function Sidebar({
  onOpenSettings,
  onOpenTokenStats,
  updateStatus,
  onRestart,
  onCheckUpdate,
  onShowChangelog,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [versionPopover, setVersionPopover] = useState(false);
  const [larkPopover, setLarkPopover] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [larkConnecting, setLarkConnecting] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const larkPopoverRef = useRef<HTMLDivElement>(null);
  const larkButtonRef = useRef<HTMLButtonElement>(null);
  const { settings, updateSettings } = useSettingsStore();
  const { createSession } = useChatStore();
  const { config: larkConfig, status: larkStatus, errorMessage: larkError, updateConfig: updateLarkConfig, setStatus: setLarkStatus, setError: setLarkError } = useLarkStore();
  const t = useT();

  // Get app version on mount
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("unknown"));
  }, []);

  // Close popover on click outside
  useEffect(() => {
    if (!versionPopover && !larkPopover) return;
    const handler = (e: MouseEvent) => {
      if (
        versionPopover &&
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setVersionPopover(false);
      }
      if (
        larkPopover &&
        larkPopoverRef.current &&
        !larkPopoverRef.current.contains(e.target as Node) &&
        larkButtonRef.current &&
        !larkButtonRef.current.contains(e.target as Node)
      ) {
        setLarkPopover(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [versionPopover, larkPopover]);

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
        settings.defaultModel || settings.model || "",
        settings.permissionMode || ""
      );
    }
  };

  // Reset checking state when updateStatus changes (check completed)
  useEffect(() => {
    if (isChecking && updateStatus !== null) {
      setIsChecking(false);
    }
  }, [updateStatus]);

  const handleCheckUpdate = async () => {
    setIsChecking(true);
    try {
      await onCheckUpdate();
    } catch {
      setIsChecking(false);
    }
  };

  // Whether there's actionable update info (green dot indicator)
  const hasUpdate =
    updateStatus?.available &&
    (updateStatus.downloading || updateStatus.downloaded);

  // Whether update check failed (yellow warning indicator)
  const hasUpdateError = !!updateStatus?.error;

  // Build version status line
  const renderVersionStatus = () => {
    if (!updateStatus) return null;

    if (updateStatus.error) {
      return (
        <div className="space-y-0.5">
          <span className="text-xs text-red-400">
            {t("version.checkFailed")}
          </span>
          <p className="text-[10px] text-text-muted break-all line-clamp-2" title={updateStatus.error}>
            {updateStatus.error}
          </p>
        </div>
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
      {!hasUpdate && hasUpdateError && (
        <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-yellow-500 ring-2 ring-bg-secondary" />
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
      {/* Check for Updates button — hide when downloading or downloaded */}
      {!updateStatus?.downloading && !updateStatus?.downloaded && (
        <button
          onClick={handleCheckUpdate}
          disabled={isChecking}
          className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg
                     text-xs font-medium text-text-secondary
                     bg-bg-tertiary/40 hover:bg-bg-tertiary/70 hover:text-text-primary
                     disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors cursor-pointer"
        >
          <RefreshCw size={11} className={isChecking ? "animate-spin" : ""} />
          {isChecking ? t("version.checking") : t("version.checkUpdate")}
        </button>
      )}
      {/* Changelog link */}
      <button
        onClick={() => { setVersionPopover(false); onShowChangelog(); }}
        className="mt-1.5 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg
                   text-xs font-medium text-text-secondary
                   hover:bg-bg-tertiary/50 hover:text-text-primary
                   transition-colors cursor-pointer"
      >
        <History size={11} />
        {t("changelog.viewHistory")}
      </button>
    </div>
  );

  // ── Lark helpers ──────────────────────────────────────────────────

  const larkIsRunning = larkStatus === "connected" || larkStatus === "connecting" || larkStatus === "reconnecting";

  const handleLarkToggle = async () => {
    if (larkIsRunning) {
      try {
        await stopLarkBot();
        setLarkStatus("stopped");
        setLarkError(null);
      } catch (err) {
        setLarkError(String(err));
      }
    } else {
      if (!larkConfig.appId || !larkConfig.appSecret) {
        setLarkError(t("lark.missingCredentials"));
        return;
      }
      setLarkConnecting(true);
      setLarkError(null);
      try {
        await startLarkBot({
          app_id: larkConfig.appId,
          app_secret: larkConfig.appSecret,
          project_dir: settings.workingDirectory || undefined,
          model: settings.model || undefined,
          api_key: settings.apiKey || undefined,
          base_url: settings.baseUrl || undefined,
        });
        setLarkStatus("connecting");
      } catch (err) {
        setLarkError(String(err));
        setLarkStatus("error");
      } finally {
        setLarkConnecting(false);
      }
    }
  };

  const larkStatusLabel: Record<LarkStatus, string> = {
    stopped: t("lark.stopped"),
    connecting: t("lark.connecting"),
    connected: t("lark.connected"),
    disconnected: t("lark.disconnected"),
    reconnecting: t("lark.reconnecting"),
    error: t("lark.error"),
  };

  // Lark status dot on the button
  const renderLarkDot = () => {
    if (larkStatus === "connected")
      return <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-success ring-2 ring-bg-secondary" />;
    if (larkStatus === "connecting" || larkStatus === "reconnecting")
      return <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-warning ring-2 ring-bg-secondary animate-pulse" />;
    if (larkStatus === "error")
      return <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-error ring-2 ring-bg-secondary" />;
    return null;
  };

  // Lark button (shared between collapsed and expanded)
  const larkButton = (
    <button
      ref={larkButtonRef}
      onClick={() => { setLarkPopover((v) => !v); setVersionPopover(false); }}
      className="relative p-2 rounded-lg text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors cursor-pointer"
      title={`${t("lark.title")} — ${larkStatusLabel[larkStatus]}`}
    >
      <Send size={16} />
      {renderLarkDot()}
    </button>
  );

  // Lark popover content
  const larkPopoverContent = larkPopover && (
    <div
      ref={larkPopoverRef}
      className="absolute bottom-full left-0 mb-2 ml-1 z-50
                 bg-bg-secondary border border-border rounded-xl
                 shadow-2xl shadow-black/20 px-4 py-3 w-[260px]
                 animate-fade-in"
    >
      {/* Header with status */}
      <div className="flex items-center gap-2 mb-3">
        <Send size={16} />
        <span className="text-xs font-semibold text-text-primary">{t("lark.title")}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-text-muted">
          {larkStatus === "connected" && <span className="inline-block w-2 h-2 rounded-full bg-success" />}
          {(larkStatus === "connecting" || larkStatus === "reconnecting") && <Loader2 size={10} className="animate-spin text-warning" />}
          {larkStatus === "error" && <span className="inline-block w-2 h-2 rounded-full bg-error" />}
          {(larkStatus === "stopped" || larkStatus === "disconnected") && <span className="inline-block w-2 h-2 rounded-full bg-text-muted/40" />}
          {larkStatusLabel[larkStatus]}
        </span>
      </div>

      {/* Config form */}
      <div className="space-y-2">
        <div>
          <label className="text-[10px] font-medium text-text-secondary block mb-0.5">App ID</label>
          <input
            type="text"
            value={larkConfig.appId}
            onChange={(e) => updateLarkConfig({ appId: e.target.value })}
            placeholder="cli_xxxxxxxx"
            disabled={larkIsRunning}
            className="w-full rounded-md bg-input-bg border border-border px-2 py-1 text-xs
                       text-text-primary placeholder:text-text-muted
                       focus:outline-none focus:ring-1 focus:ring-accent/50
                       disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-[10px] font-medium text-text-secondary block mb-0.5">App Secret</label>
          <input
            type="password"
            value={larkConfig.appSecret}
            onChange={(e) => updateLarkConfig({ appSecret: e.target.value })}
            placeholder="••••••••"
            disabled={larkIsRunning}
            className="w-full rounded-md bg-input-bg border border-border px-2 py-1 text-xs
                       text-text-primary placeholder:text-text-muted
                       focus:outline-none focus:ring-1 focus:ring-accent/50
                       disabled:opacity-50"
          />
        </div>

        <div className="flex items-center justify-between pt-1">
          <label className="flex items-center gap-1.5 text-[10px] text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={larkConfig.autoConnect}
              onChange={(e) => updateLarkConfig({ autoConnect: e.target.checked })}
              className="rounded border-border"
            />
            {t("lark.autoConnect")}
          </label>

          <button
            onClick={handleLarkToggle}
            disabled={larkConnecting}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1
              ${larkIsRunning
                ? "bg-error/10 text-error hover:bg-error/20 border border-error/30"
                : "bg-accent text-white hover:bg-accent-hover"
              } disabled:opacity-50 cursor-pointer`}
          >
            {larkConnecting && <Loader2 size={10} className="animate-spin" />}
            {larkIsRunning ? t("lark.disconnect") : t("lark.connect")}
          </button>
        </div>

        {larkError && (
          <p className="text-[10px] text-error">{larkError}</p>
        )}

        <p className="text-[10px] text-text-muted leading-relaxed pt-1 border-t border-border mt-1">
          {t("lark.hint")}
        </p>
      </div>
    </div>
  );

  if (collapsed) {
    return (
      <div className="w-[70px] border-r border-border bg-bg-secondary flex flex-col items-center">
        {/* macOS traffic light spacing */}
        <div data-tauri-drag-region onMouseDown={startWindowDrag} onDoubleClick={handleTitleBarDoubleClick} className={`${isWindows ? "h-4" : "h-12"} w-full flex-shrink-0`} />
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
          {larkPopoverContent}
          {versionButton}
          <button
            onClick={() => shellOpen("https://github.com/braverior/ClaudeBox/releases/")}
            className="p-2 rounded-lg text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
            title="GitHub"
          >
            <Github size={16} />
          </button>
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
            onClick={onOpenTokenStats}
            className="p-2 rounded-lg text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
            title="Token 统计"
          >
            <BarChart2 size={16} />
          </button>
          {larkButton}
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
        onMouseDown={startWindowDrag}
        onDoubleClick={handleTitleBarDoubleClick}
        className={`flex items-center ${isWindows ? "pl-4" : "pl-[78px]"} pr-3 h-14 flex-shrink-0`}
      >
        <h1 data-tauri-drag-region className="text-sm font-bold text-text-primary tracking-wide pointer-events-none mt-2">
          ClaudeBox
        </h1>
        {/* Drag spacer — fills remaining space for window dragging */}
        <div className="flex-1" data-tauri-drag-region />
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
        {larkPopoverContent}
        {versionButton}
        <button
          onClick={() => shellOpen("https://github.com/braverior/ClaudeBox/releases/")}
          className="p-2 rounded-lg text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
          title="GitHub"
        >
          <Github size={16} />
        </button>
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
          onClick={onOpenTokenStats}
          className="p-2 rounded-lg text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
          title="Token 统计"
        >
          <BarChart2 size={16} />
        </button>
        {larkButton}
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

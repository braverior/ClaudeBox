import { useState, useEffect, useCallback } from "react";
import {
  X, CheckCircle, XCircle, Loader2, Plus, Trash2, Bot,
  Monitor, Cpu, BarChart2, Info, ScrollText, RefreshCw,
} from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useLarkStore, type LarkStatus } from "../../stores/larkStore";
import { checkClaudeInstalled, checkModelAvailable, checkNodeVersion } from "../../lib/claude-ipc";
import { startLarkBot, stopLarkBot } from "../../lib/lark-ipc";
import { useT } from "../../lib/i18n";
import { NodeStatusSection, ClaudeInstallButton } from "./InstallWizard";
import { TokenStatsContent } from "./TokenStatsDialog";
import type { UpdateStatus } from "../../lib/updater";
import { getVersion } from "@tauri-apps/api/app";

// ── Tab types ─────────────────────────────────────────────────────────

type TabId = "environment" | "model" | "lark" | "tokens" | "about";

const TAB_LIST: { id: TabId; icon: typeof Monitor; labelKey: string }[] = [
  { id: "environment", icon: Monitor, labelKey: "settings.tab.environment" },
  { id: "model", icon: Cpu, labelKey: "settings.tab.model" },
  { id: "lark", icon: Bot, labelKey: "settings.tab.lark" },
  { id: "tokens", icon: BarChart2, labelKey: "settings.tab.tokens" },
  { id: "about", icon: Info, labelKey: "settings.tab.about" },
];

// ── Lark helpers ──────────────────────────────────────────────────────

function LarkStatusDot({ status }: { status: LarkStatus }) {
  if (status === "connected") return <span className="inline-block w-2 h-2 rounded-full bg-success" />;
  if (status === "connecting" || status === "reconnecting") return <Loader2 size={10} className="animate-spin text-warning" />;
  if (status === "error") return <span className="inline-block w-2 h-2 rounded-full bg-error" />;
  return <span className="inline-block w-2 h-2 rounded-full bg-text-muted/40" />;
}

// ── Environment Tab ───────────────────────────────────────────────────

function EnvironmentSection({
  nodeVersion, nodeChecking, nodeOk, recheckNode,
  claudeVersion, claudeError, claudeChecking, recheckClaude,
}: {
  nodeVersion: string | null;
  nodeChecking: boolean;
  nodeOk: boolean;
  recheckNode: () => void;
  claudeVersion: string | null;
  claudeError: string | null;
  claudeChecking: boolean;
  recheckClaude: () => void;
}) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();

  return (
    <div className="space-y-5">
      <NodeStatusSection
        nodeVersion={nodeVersion}
        nodeChecking={nodeChecking}
        onRecheck={recheckNode}
      />

      <div>
        <label className="text-sm font-medium text-text-primary block mb-2">
          {t("settings.cliStatus")}
        </label>
        <div className="flex items-center gap-2 text-sm">
          {claudeChecking ? (
            <>
              <Loader2 size={14} className="animate-spin text-text-muted" />
              <span className="text-text-muted">{t("settings.checking")}</span>
            </>
          ) : claudeVersion ? (
            <>
              <CheckCircle size={14} className="text-success" />
              <span className="text-success">{claudeVersion}</span>
            </>
          ) : (
            <>
              <XCircle size={14} className="text-error" />
              <span className="text-error text-xs">
                {claudeError || t("settings.notFound")}
              </span>
            </>
          )}
          <button
            onClick={recheckClaude}
            className="ml-auto text-xs text-accent hover:text-accent-hover transition-colors"
          >
            {t("settings.recheck")}
          </button>
        </div>
        {!claudeChecking && !claudeVersion && (
          <ClaudeInstallButton nodeOk={nodeOk} onComplete={recheckClaude} />
        )}
      </div>

      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">
          {t("settings.cliPath")}
        </label>
        <input
          type="text"
          value={settings.claudePath}
          onChange={(e) => updateSettings({ claudePath: e.target.value })}
          placeholder="claude"
          className="w-full rounded-lg bg-input-bg border border-border px-3 py-2 text-sm
                     text-text-primary placeholder:text-text-muted
                     focus:outline-none focus:ring-2 focus:ring-accent/50"
        />
        <p className="text-xs text-text-muted mt-1">
          {t("settings.cliPathHint")}
        </p>
      </div>
    </div>
  );
}

// ── Model Tab ─────────────────────────────────────────────────────────

function ModelSection() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [modelInput, setModelInput] = useState("");
  const [modelChecking, setModelChecking] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const addModel = async () => {
    const trimmed = modelInput.trim();
    if (!trimmed || settings.models.includes(trimmed)) return;

    setModelError(null);
    setModelChecking(true);
    try {
      await checkModelAvailable(
        trimmed,
        settings.apiKey || undefined,
        settings.baseUrl || undefined,
      );
      const newModels = [...settings.models, trimmed];
      updateSettings({ models: newModels, model: trimmed });
      setModelInput("");
    } catch (err) {
      const reason = String(err);
      if (reason.includes("no_api_key")) {
        const newModels = [...settings.models, trimmed];
        updateSettings({ models: newModels, model: trimmed });
        setModelInput("");
        setModelError(t("settings.modelNoApiKey"));
      } else {
        setModelError(t("settings.modelUnavailable", { reason }));
      }
    } finally {
      setModelChecking(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Models */}
      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">
          {t("settings.models")}
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={modelInput}
            onChange={(e) => {
              setModelInput(e.target.value);
              setModelError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addModel();
              }
            }}
            placeholder="e.g. claude-sonnet-4-20250514"
            disabled={modelChecking}
            className="flex-1 rounded-lg bg-input-bg border border-border px-3 py-2 text-sm
                       text-text-primary placeholder:text-text-muted
                       focus:outline-none focus:ring-2 focus:ring-accent/50
                       disabled:opacity-50"
          />
          <button
            onClick={addModel}
            disabled={!modelInput.trim() || settings.models.includes(modelInput.trim()) || modelChecking}
            className="px-3 py-2 rounded-lg bg-accent text-white hover:bg-accent-hover
                       transition-colors text-sm disabled:opacity-30 disabled:cursor-not-allowed
                       flex items-center gap-1"
          >
            {modelChecking ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            {t("settings.add")}
          </button>
        </div>
        {modelChecking && (
          <p className="text-xs text-text-muted mt-1 flex items-center gap-1">
            <Loader2 size={10} className="animate-spin" />
            {t("settings.modelChecking")}
          </p>
        )}
        {modelError && (
          <p className="text-xs text-error mt-1">{modelError}</p>
        )}
        {settings.models.length > 0 && (
          <div className="mt-2 space-y-1">
            {settings.models.map((m) => (
              <div
                key={m}
                className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-bg-secondary text-sm group"
              >
                <span className={`text-text-primary truncate ${m === settings.model ? "font-medium" : ""}`}>
                  {m}
                  {m === settings.model && (
                    <span className="ml-2 text-xs text-accent">{t("settings.active")}</span>
                  )}
                </span>
                <button
                  onClick={() => {
                    const newModels = settings.models.filter((x) => x !== m);
                    const updates: { models: string[]; model?: string } = { models: newModels };
                    if (settings.model === m) {
                      updates.model = newModels[0] || "";
                    }
                    updateSettings(updates);
                  }}
                  className="p-1 rounded hover:bg-error/20 text-text-muted hover:text-error
                             transition-colors opacity-0 group-hover:opacity-100"
                  title={t("settings.removeModel")}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-text-muted mt-1">
          {t("settings.modelsHint")}
        </p>
      </div>

      {/* API Key */}
      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">
          {t("settings.apiKey")}
        </label>
        <input
          type="password"
          value={settings.apiKey}
          onChange={(e) => updateSettings({ apiKey: e.target.value })}
          placeholder="sk-ant-..."
          className="w-full rounded-lg bg-input-bg border border-border px-3 py-2 text-sm
                     text-text-primary placeholder:text-text-muted
                     focus:outline-none focus:ring-2 focus:ring-accent/50"
        />
        <p className="text-xs text-text-muted mt-1">
          {t("settings.apiKeyHint")}
        </p>
      </div>

      {/* Base URL */}
      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">
          {t("settings.baseUrl")}
        </label>
        <input
          type="text"
          value={settings.baseUrl}
          onChange={(e) => updateSettings({ baseUrl: e.target.value })}
          placeholder="https://api.anthropic.com"
          className="w-full rounded-lg bg-input-bg border border-border px-3 py-2 text-sm
                     text-text-primary placeholder:text-text-muted
                     focus:outline-none focus:ring-2 focus:ring-accent/50"
        />
        <p className="text-xs text-text-muted mt-1">
          {t("settings.baseUrlHint")}
        </p>
      </div>
    </div>
  );
}

// ── Lark Tab ──────────────────────────────────────────────────────────

function LarkSettingsSection() {
  const t = useT();
  const { settings } = useSettingsStore();
  const { config, status, errorMessage, updateConfig, setStatus, setError } = useLarkStore();
  const [larkConnecting, setLarkConnecting] = useState(false);

  const statusLabel: Record<LarkStatus, string> = {
    stopped: t("lark.stopped"),
    connecting: t("lark.connecting"),
    connected: t("lark.connected"),
    disconnected: t("lark.disconnected"),
    reconnecting: t("lark.reconnecting"),
    error: t("lark.error"),
  };

  const handleToggle = async () => {
    if (status === "connected" || status === "connecting" || status === "reconnecting") {
      try {
        await stopLarkBot();
        setStatus("stopped");
        setError(null);
      } catch (err) {
        setError(String(err));
      }
    } else {
      if (!config.appId || !config.appSecret) {
        setError(t("lark.missingCredentials"));
        return;
      }
      setLarkConnecting(true);
      setError(null);
      try {
        await startLarkBot({
          app_id: config.appId,
          app_secret: config.appSecret,
          project_dir: settings.workingDirectory || undefined,
          model: settings.model || undefined,
          api_key: settings.apiKey || undefined,
          base_url: settings.baseUrl || undefined,
        });
        setStatus("connecting");
      } catch (err) {
        setError(String(err));
        setStatus("error");
      } finally {
        setLarkConnecting(false);
      }
    }
  };

  const isRunning = status === "connected" || status === "connecting" || status === "reconnecting";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="ml-auto flex items-center gap-1.5 text-xs text-text-muted">
          <LarkStatusDot status={status} />
          {statusLabel[status]}
        </span>
      </div>

      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1">
          App ID
        </label>
        <input
          type="text"
          value={config.appId}
          onChange={(e) => updateConfig({ appId: e.target.value })}
          placeholder="cli_xxxxxxxx"
          disabled={isRunning}
          className="w-full rounded-lg bg-input-bg border border-border px-3 py-1.5 text-sm
                     text-text-primary placeholder:text-text-muted
                     focus:outline-none focus:ring-2 focus:ring-accent/50
                     disabled:opacity-50"
        />
      </div>

      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1">
          App Secret
        </label>
        <input
          type="password"
          value={config.appSecret}
          onChange={(e) => updateConfig({ appSecret: e.target.value })}
          placeholder="••••••••"
          disabled={isRunning}
          className="w-full rounded-lg bg-input-bg border border-border px-3 py-1.5 text-sm
                     text-text-primary placeholder:text-text-muted
                     focus:outline-none focus:ring-2 focus:ring-accent/50
                     disabled:opacity-50"
        />
      </div>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={config.autoConnect}
            onChange={(e) => updateConfig({ autoConnect: e.target.checked })}
            className="rounded border-border"
          />
          {t("lark.autoConnect")}
        </label>

        <button
          onClick={handleToggle}
          disabled={larkConnecting}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5
            ${isRunning
              ? "bg-error/10 text-error hover:bg-error/20 border border-error/30"
              : "bg-accent text-white hover:bg-accent-hover"
            } disabled:opacity-50`}
        >
          {larkConnecting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : null}
          {isRunning ? t("lark.disconnect") : t("lark.connect")}
        </button>
      </div>

      {errorMessage && (
        <p className="text-xs text-error">{errorMessage}</p>
      )}

      <p className="text-[10px] text-text-muted">
        {t("lark.hint")}
      </p>
    </div>
  );
}

// ── About Tab ─────────────────────────────────────────────────────────

function AboutSection({
  updateStatus, onCheckUpdate, onRestart, onOpenDebug, onClose,
}: {
  updateStatus: UpdateStatus | null;
  onCheckUpdate?: () => Promise<void>;
  onRestart?: () => void;
  onOpenDebug?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [appVersion, setAppVersion] = useState("");
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  const handleCheckUpdate = async () => {
    if (!onCheckUpdate || isChecking) return;
    setIsChecking(true);
    try {
      await onCheckUpdate();
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Version */}
      <div>
        <label className="text-sm font-medium text-text-primary block mb-2">
          {t("about.version")}
        </label>
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-text-primary">
              ClaudeBox <span className="font-mono text-text-secondary">v{appVersion}</span>
            </span>
          </div>

          {/* Update status */}
          <div className="text-sm">
            {updateStatus?.downloaded && updateStatus.version ? (
              <div className="flex items-center justify-between">
                <span className="text-accent font-medium">
                  {t("about.readyToInstall", { version: updateStatus.version })}
                </span>
                {onRestart && (
                  <button
                    onClick={onRestart}
                    className="px-3 py-1 rounded-lg bg-accent text-white text-xs font-medium
                               hover:bg-accent-hover transition-colors"
                  >
                    {t("about.restart")}
                  </button>
                )}
              </div>
            ) : updateStatus?.downloading && updateStatus.version ? (
              <span className="text-accent flex items-center gap-1.5">
                <RefreshCw size={12} className="animate-spin" />
                {t("about.downloading", { version: updateStatus.version })}
              </span>
            ) : updateStatus?.available && updateStatus.version ? (
              <span className="text-accent font-medium">
                {t("about.newVersion", { version: updateStatus.version })}
              </span>
            ) : updateStatus?.error ? (
              <span className="text-xs text-warning">{updateStatus.error}</span>
            ) : (
              <span className="text-success flex items-center gap-1.5">
                <CheckCircle size={12} />
                {t("about.upToDate")}
              </span>
            )}
          </div>

          {/* Check for updates button */}
          {onCheckUpdate && !updateStatus?.downloading && !updateStatus?.downloaded && (
            <button
              onClick={handleCheckUpdate}
              disabled={isChecking}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg
                         text-xs font-medium text-text-secondary
                         bg-bg-tertiary/40 hover:bg-bg-tertiary/70 hover:text-text-primary
                         disabled:opacity-50 disabled:cursor-not-allowed
                         transition-colors"
            >
              {isChecking ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              {isChecking ? t("about.checking") : t("about.checkUpdate")}
            </button>
          )}
        </div>
      </div>

      {/* View Logs */}
      {onOpenDebug && (
        <div>
          <button
            onClick={() => {
              onClose();
              onOpenDebug();
            }}
            className="w-full py-2.5 rounded-lg border border-border text-text-secondary
                       hover:bg-bg-secondary hover:text-text-primary
                       transition-colors text-sm font-medium flex items-center justify-center gap-2"
          >
            <ScrollText size={14} />
            {t("about.viewLogs")}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main Dialog ───────────────────────────────────────────────────────

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onClaudeStatusChange: (available: boolean) => void;
  onOpenDebug?: () => void;
  updateStatus?: UpdateStatus | null;
  onRestart?: () => void;
  onCheckUpdate?: () => Promise<void>;
}

export default function SettingsDialog({
  open, onClose, onClaudeStatusChange, onOpenDebug,
  updateStatus, onRestart, onCheckUpdate,
}: SettingsDialogProps) {
  const { settings } = useSettingsStore();
  const t = useT();
  const [activeTab, setActiveTab] = useState<TabId>("environment");

  // Environment check state
  const [claudeVersion, setClaudeVersion] = useState<string | null>(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [claudeChecking, setClaudeChecking] = useState(false);
  const [nodeVersion, setNodeVersion] = useState<string | null>(null);
  const [nodeChecking, setNodeChecking] = useState(false);

  const nodeOk = nodeVersion !== null && (() => {
    const major = parseInt(nodeVersion.replace(/^v/, "").split(".")[0], 10);
    return !isNaN(major) && major >= 22;
  })();

  const recheckNode = useCallback(async () => {
    setNodeChecking(true);
    try {
      const ver = await checkNodeVersion();
      setNodeVersion(ver);
    } catch {
      setNodeVersion(null);
    } finally {
      setNodeChecking(false);
    }
  }, []);

  const recheckClaude = useCallback(async () => {
    setClaudeChecking(true);
    setClaudeError(null);
    try {
      const version = await checkClaudeInstalled(
        settings.claudePath || undefined
      );
      setClaudeVersion(version);
      setClaudeError(null);
      onClaudeStatusChange(true);
    } catch (err) {
      setClaudeVersion(null);
      setClaudeError(String(err));
      onClaudeStatusChange(false);
    } finally {
      setClaudeChecking(false);
    }
  }, [settings.claudePath, onClaudeStatusChange]);

  const recheckAll = useCallback(() => {
    recheckNode();
    recheckClaude();
  }, [recheckNode, recheckClaude]);

  useEffect(() => {
    if (open) recheckAll();
  }, [open, settings.claudePath]);

  if (!open) return null;

  const renderContent = () => {
    switch (activeTab) {
      case "environment":
        return (
          <EnvironmentSection
            nodeVersion={nodeVersion}
            nodeChecking={nodeChecking}
            nodeOk={nodeOk}
            recheckNode={recheckNode}
            claudeVersion={claudeVersion}
            claudeError={claudeError}
            claudeChecking={claudeChecking}
            recheckClaude={recheckClaude}
          />
        );
      case "model":
        return <ModelSection />;
      case "lark":
        return <LarkSettingsSection />;
      case "tokens":
        return <TokenStatsContent />;
      case "about":
        return (
          <AboutSection
            updateStatus={updateStatus ?? null}
            onCheckUpdate={onCheckUpdate}
            onRestart={onRestart}
            onOpenDebug={onOpenDebug}
            onClose={onClose}
          />
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-primary border border-border rounded-2xl w-[600px] h-[600px] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-lg font-semibold text-text-primary">{t("settings.title")}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body: sidebar tabs + content */}
        <div className="flex flex-1 min-h-0">
          {/* Left tab bar */}
          <div className="w-[160px] flex-shrink-0 border-r border-border py-2 px-2 space-y-0.5">
            {TAB_LIST.map(({ id, icon: Icon, labelKey }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left
                  ${activeTab === id
                    ? "bg-accent/10 text-accent font-medium"
                    : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
                  }`}
              >
                <Icon size={16} className="flex-shrink-0" />
                {t(labelKey)}
              </button>
            ))}
          </div>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto p-5">
            {renderContent()}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg bg-accent text-white hover:bg-accent-hover
                       transition-colors text-sm font-medium"
          >
            {t("settings.done")}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import { X, CheckCircle, XCircle, Loader2, ScrollText, Plus, Trash2, BarChart2, Bot } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useLarkStore, type LarkStatus } from "../../stores/larkStore";
import { checkClaudeInstalled, checkModelAvailable, checkNodeVersion } from "../../lib/claude-ipc";
import { startLarkBot, stopLarkBot } from "../../lib/lark-ipc";
import { useT } from "../../lib/i18n";
import InstallWizard from "./InstallWizard";

function LarkStatusDot({ status }: { status: LarkStatus }) {
  if (status === "connected") return <span className="inline-block w-2 h-2 rounded-full bg-success" />;
  if (status === "connecting" || status === "reconnecting") return <Loader2 size={10} className="animate-spin text-warning" />;
  if (status === "error") return <span className="inline-block w-2 h-2 rounded-full bg-error" />;
  return <span className="inline-block w-2 h-2 rounded-full bg-text-muted/40" />;
}

function getInstallInstructions(): { platform: string; command: string; note: string } {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac") || ua.includes("darwin")) {
    return {
      platform: "macOS",
      command: "brew install claude-code",
      note: "Requires Homebrew. Alternatively: npm install -g @anthropic-ai/claude-code",
    };
  } else if (ua.includes("win")) {
    return {
      platform: "Windows",
      command: "npm install -g @anthropic-ai/claude-code",
      note: "Requires Node.js 22+.",
    };
  } else {
    return {
      platform: "Linux",
      command: "npm install -g @anthropic-ai/claude-code",
      note: "Requires Node.js 22+. Or use: curl -fsSL https://cli.anthropic.com/install.sh | sh",
    };
  }
}

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onClaudeStatusChange: (available: boolean) => void;
  onOpenDebug?: () => void;
  onOpenTokenStats?: () => void;
}

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
      // Stop
      try {
        await stopLarkBot();
        setStatus("stopped");
        setError(null);
      } catch (err) {
        setError(String(err));
      }
    } else {
      // Start
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
    <div className="rounded-xl border border-border bg-bg-secondary/50 p-4 space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <Bot size={16} className="text-accent" />
        <span className="text-sm font-medium text-text-primary">{t("lark.title")}</span>
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

export default function SettingsDialog({
  open,
  onClose,
  onClaudeStatusChange,
  onOpenDebug,
  onOpenTokenStats,
}: SettingsDialogProps) {
  const { settings, updateSettings } = useSettingsStore();
  const t = useT();
  const [claudeVersion, setClaudeVersion] = useState<string | null>(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [nodeWarning, setNodeWarning] = useState<string | null>(null);
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
      // Model is valid — add it
      const newModels = [...settings.models, trimmed];
      updateSettings({ models: newModels, model: trimmed });
      setModelInput("");
    } catch (err) {
      const reason = String(err);
      if (reason.includes("no_api_key")) {
        // No API key — add without validation
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

  const checkClaude = async () => {
    setChecking(true);
    setClaudeError(null);
    setNodeWarning(null);
    // Check Node.js version in parallel
    checkNodeVersion().then((ver) => {
      const major = parseInt(ver.replace(/^v/, "").split(".")[0], 10);
      if (!isNaN(major) && major < 22) {
        setNodeWarning(ver);
      }
    }).catch(() => {});
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
      setChecking(false);
    }
  };

  useEffect(() => {
    if (open) checkClaude();
  }, [open, settings.claudePath]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-primary border border-border rounded-2xl w-[480px] max-h-[80vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">{t("settings.title")}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 space-y-5">
          {/* Claude CLI Status */}
          <div>
            <label className="text-sm font-medium text-text-primary block mb-2">
              {t("settings.cliStatus")}
            </label>
            <div className="flex items-center gap-2 text-sm">
              {checking ? (
                <>
                  <Loader2
                    size={14}
                    className="animate-spin text-text-muted"
                  />
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
                onClick={checkClaude}
                className="ml-auto text-xs text-accent hover:text-accent-hover transition-colors"
              >
                {t("settings.recheck")}
              </button>
            </div>
            {/* Install wizard when not found */}
            {!checking && !claudeVersion && (
              <InstallWizard
                onComplete={checkClaude}
                manualInstructions={getInstallInstructions()}
              />
            )}
            {/* Node.js version warning */}
            {!checking && nodeWarning && (
              <div className="mt-2 rounded-lg bg-warning/10 border border-warning/30 px-3 py-2 flex items-start gap-2">
                <span className="text-warning text-xs mt-0.5">⚠</span>
                <div className="text-xs text-warning/90">
                  Node.js {nodeWarning} is too old. Claude Code requires Node.js ≥ 22.
                  {" "}
                  <a
                    href="https://nodejs.org"
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-warning"
                    onClick={(e) => { e.preventDefault(); import("../../lib/claude-ipc").then(m => m.openInBrowser("https://nodejs.org")); }}
                  >
                    nodejs.org
                  </a>
                </div>
              </div>
            )}
          </div>

          {/* Claude CLI Path */}
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

          {/* ── Lark Bot ───────────────────────────────────────── */}
          <LarkSettingsSection />
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border space-y-2">
          {onOpenDebug && (
            <button
              onClick={() => {
                onClose();
                onOpenDebug();
              }}
              className="w-full py-2 rounded-lg border border-border text-text-secondary
                         hover:bg-bg-secondary hover:text-text-primary
                         transition-colors text-sm font-medium flex items-center justify-center gap-2"
            >
              <ScrollText size={14} />
              {t("settings.viewLogs")}
            </button>
          )}
          <button
            onClick={() => onOpenTokenStats?.()}
            className="w-full py-2 rounded-lg border border-border text-text-secondary
                       hover:bg-bg-secondary hover:text-text-primary
                       transition-colors text-sm font-medium flex items-center justify-center gap-2"
          >
            <BarChart2 size={14} />
            {t("settings.tokenStats")}
          </button>
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

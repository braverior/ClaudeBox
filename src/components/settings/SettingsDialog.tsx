import { useState, useEffect } from "react";
import { X, CheckCircle, XCircle, Loader2, ScrollText, Plus, Trash2, Copy, Check, BarChart2 } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { checkClaudeInstalled, checkModelAvailable, checkNodeVersion } from "../../lib/claude-ipc";
import { useT } from "../../lib/i18n";

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

function InstallInstructions() {
  const [copied, setCopied] = useState(false);
  const t = useT();
  const info = getInstallInstructions();
  const handleCopy = () => {
    navigator.clipboard.writeText(info.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="mt-2 rounded-lg bg-bg-secondary border border-border p-3">
      <p className="text-xs text-text-secondary mb-2">
        {t("settings.installFor")} <span className="font-medium text-text-primary">{info.platform}</span>:
      </p>
      <div className="flex items-center gap-2 bg-code-bg rounded-md px-3 py-2">
        <code className="text-xs text-text-primary flex-1 select-all">{info.command}</code>
        <button
          onClick={handleCopy}
          className="p-1 rounded text-text-muted hover:text-text-primary transition-colors flex-shrink-0"
          title={t("settings.copyCommand")}
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
        </button>
      </div>
      <p className="text-[10px] text-text-muted mt-1.5">{info.note}</p>
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
            {/* Install instructions when not found */}
            {!checking && !claudeVersion && <InstallInstructions />}
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

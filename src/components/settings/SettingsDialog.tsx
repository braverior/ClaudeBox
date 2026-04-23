import { useState, useEffect, useCallback } from "react";
import {
  X, CheckCircle, XCircle, Loader2, Plus, Trash2, Bot,
  Monitor, Cpu, BarChart2, Info, ScrollText, RefreshCw, Star, ChevronDown, ExternalLink, FileText, AlertTriangle, History, Eye, EyeOff, Zap, ChevronRight,
} from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useSettingsStore } from "../../stores/settingsStore";
import { useLarkStore, type LarkStatus } from "../../stores/larkStore";
import { checkClaudeInstalled, checkNodeVersion, checkModelAvailable } from "../../lib/claude-ipc";
import { startLarkBot, stopLarkBot } from "../../lib/lark-ipc";
import { useT } from "../../lib/i18n";
import { getProvider, resolveModelCreds, type ModelConfig } from "../../lib/providers";
import AddModelDialog from "./AddModelDialog";
import { NodeStatusSection, ClaudeInstallButton } from "./InstallWizard";
import { TokenStatsContent } from "./TokenStatsDialog";
import type { UpdateStatus } from "../../lib/updater";
import { getVersion } from "@tauri-apps/api/app";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";

// ── Toggle Switch ────────────────────────────────────────────────────

function ToggleSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors
        ${checked ? "bg-accent" : "bg-border"}
        ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform
          ${checked ? "translate-x-[18px]" : "translate-x-[3px]"}`}
      />
    </button>
  );
}

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
  const [autoStartChecked, setAutoStartChecked] = useState(settings.autoStart);

  useEffect(() => {
    isAutostartEnabled().then(setAutoStartChecked).catch(() => {});
  }, []);

  const handleAutoStartToggle = async (checked: boolean) => {
    setAutoStartChecked(checked);
    try {
      if (checked) await enableAutostart();
      else await disableAutostart();
      updateSettings({ autoStart: checked });
    } catch {
      setAutoStartChecked(!checked);
    }
  };

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

      {/* Auto Start & Notifications */}
      <div className="space-y-3 pt-2 border-t border-border">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-text-primary">{t("settings.autoStart")}</span>
            <p className="text-xs text-text-muted">{t("settings.autoStartHint")}</p>
          </div>
          <ToggleSwitch checked={autoStartChecked} onChange={handleAutoStartToggle} />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-text-primary">{t("settings.notifications")}</span>
            <p className="text-xs text-text-muted">{t("settings.notificationsHint")}</p>
          </div>
          <ToggleSwitch checked={settings.notifications} onChange={(v) => updateSettings({ notifications: v })} />
        </div>
      </div>
    </div>
  );
}

// ── Model Tab ─────────────────────────────────────────────────────────

function ProviderBadge({ providerId }: { providerId: string }) {
  const t = useT();
  const provider = getProvider(providerId);
  return (
    <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent/10 text-accent border border-accent/20">
      {t(`provider.${provider.id}`)}
    </span>
  );
}

function ModelSection() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [addOpen, setAddOpen] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { status: "testing" | "ok" | "error"; error?: string }>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const handleAdd = (config: ModelConfig) => {
    if (settings.models.some((m) => m.id === config.id)) return;
    const newModels = [...settings.models, config];
    updateSettings({ models: newModels, model: config.id });
  };

  const handleTest = async (m: ModelConfig) => {
    setTestResults((prev) => ({ ...prev, [m.id]: { status: "testing" } }));
    const { apiKey, baseUrl } = resolveModelCreds(m.id, settings.models, settings.apiKey, settings.baseUrl);
    try {
      await checkModelAvailable(m.id, apiKey || undefined, baseUrl || undefined);
      setTestResults((prev) => ({ ...prev, [m.id]: { status: "ok" } }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [m.id]: { status: "error", error: String(err) } }));
    }
  };

  const maskKey = (key: string) => {
    if (!key) return "—";
    if (key.length <= 8) return "••••••••";
    return `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
  };

  return (
    <div className="space-y-5">
      {/* Models */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-text-primary">
            {t("settings.models")}
          </label>
          <button
            onClick={() => setAddOpen(true)}
            className="px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent-hover
                       transition-colors text-xs font-medium flex items-center gap-1"
          >
            <Plus size={12} />
            {t("settings.addModel")}
          </button>
        </div>
        {settings.models.length > 0 ? (
          <div className="space-y-1">
            {settings.models.map((m) => {
              const isExpanded = !!expanded[m.id];
              const isRevealed = !!revealed[m.id];
              const result = testResults[m.id];
              const { apiKey, baseUrl } = resolveModelCreds(m.id, settings.models, settings.apiKey, settings.baseUrl);
              return (
                <div key={m.id} className="rounded-lg bg-bg-secondary overflow-hidden">
                  <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm group">
                    <button
                      onClick={() => setExpanded((p) => ({ ...p, [m.id]: !isExpanded }))}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left hover:text-text-primary transition-colors"
                    >
                      <ChevronRight
                        size={12}
                        className={`text-text-muted transition-transform flex-shrink-0 ${isExpanded ? "rotate-90" : ""}`}
                      />
                      <ProviderBadge providerId={m.providerId} />
                      <span className="text-text-primary truncate font-mono">{m.id}</span>
                      {m.id === settings.defaultModel && (
                        <span className="shrink-0 text-[10px] text-warning">{t("settings.defaultModel")}</span>
                      )}
                      {result?.status === "ok" && (
                        <span className="shrink-0 flex items-center gap-0.5 text-[10px] text-success">
                          <CheckCircle size={10} /> {t("settings.testOk")}
                        </span>
                      )}
                      {result?.status === "error" && (
                        <span className="shrink-0 flex items-center gap-0.5 text-[10px] text-error" title={result.error}>
                          <XCircle size={10} /> {t("settings.testFailed")}
                        </span>
                      )}
                    </button>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() => handleTest(m)}
                        disabled={result?.status === "testing"}
                        className="p-1 rounded text-text-muted hover:text-accent hover:bg-accent/10
                                   transition-colors disabled:opacity-40"
                        title={t("settings.testModel")}
                      >
                        {result?.status === "testing" ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Zap size={13} />
                        )}
                      </button>
                      <button
                        onClick={() => updateSettings({ defaultModel: settings.defaultModel === m.id ? "" : m.id })}
                        className={`p-1 rounded transition-colors ${
                          m.id === settings.defaultModel
                            ? "text-warning"
                            : "text-text-muted hover:text-warning opacity-0 group-hover:opacity-100"
                        }`}
                        title={t("settings.setDefault")}
                      >
                        <Star size={13} fill={m.id === settings.defaultModel ? "currentColor" : "none"} />
                      </button>
                      <button
                        onClick={() => {
                          const newModels = settings.models.filter((x) => x.id !== m.id);
                          const updates: { models: ModelConfig[]; model?: string; defaultModel?: string } = { models: newModels };
                          if (settings.model === m.id) {
                            updates.model = newModels[0]?.id || "";
                          }
                          if (settings.defaultModel === m.id) {
                            updates.defaultModel = "";
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
                  </div>
                  {isExpanded && (
                    <div className="border-t border-border/50 px-3 py-2 space-y-1.5 bg-bg-primary/40">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-text-muted w-14 shrink-0">{t("settings.baseUrl")}</span>
                        <span className="font-mono text-text-secondary truncate flex-1" title={baseUrl}>
                          {baseUrl || "—"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-text-muted w-14 shrink-0">{t("settings.apiKey")}</span>
                        <span className="font-mono text-text-secondary truncate flex-1">
                          {isRevealed ? (apiKey || "—") : maskKey(apiKey)}
                        </span>
                        {apiKey && (
                          <button
                            onClick={() => setRevealed((p) => ({ ...p, [m.id]: !isRevealed }))}
                            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors"
                            title={isRevealed ? t("settings.hideKey") : t("settings.revealKey")}
                          >
                            {isRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                          </button>
                        )}
                      </div>
                      {result?.status === "error" && result.error && (
                        <div className="text-[11px] text-error break-words pt-1 border-t border-border/40">
                          {result.error}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-text-muted py-4 text-center rounded-lg border border-dashed border-border">
            {t("settings.modelsHint")}
          </p>
        )}
      </div>

      {/* Model Tier Defaults */}
      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">
          {t("settings.tierModels")}
        </label>
        <div className="space-y-2">
          {([
            ["haikuModel", t("settings.haikuModel")],
            ["sonnetModel", t("settings.sonnetModel")],
            ["opusModel", t("settings.opusModel")],
          ] as const).map(([field, label]) => (
            <div key={field} className="flex items-center gap-2">
              <span className="text-xs text-text-secondary w-14 shrink-0">{label}</span>
              <div className="relative flex-1">
                <select
                  value={(settings as any)[field] || ""}
                  onChange={(e) => updateSettings({ [field]: e.target.value })}
                  className="appearance-none w-full rounded-lg bg-input-bg border border-border pl-3 pr-9 py-1.5 text-sm
                             text-text-primary cursor-pointer
                             focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent/50
                             hover:border-border-hover transition-colors"
                >
                  <option value="">{t("settings.tierModelDefault")}</option>
                  {settings.models.map((m) => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
                />
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-text-muted mt-1">
          {t("settings.tierModelsHint")}
        </p>
      </div>

      {/* Effort Level */}
      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">
          {t("settings.effort")}
        </label>
        <div className="flex gap-1">
          {(["low", "medium", "high", "max"] as const).map((level) => (
            <button
              key={level}
              onClick={() => updateSettings({ effort: level })}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                (settings.effort || "high") === level
                  ? "bg-accent text-white"
                  : "bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary"
              }`}
            >
              {t(`effort.${level}`)}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-muted mt-1">
          {t("settings.effortHint")}
        </p>
      </div>

      {/* Context Window */}
      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">
          {t("settings.contextWindow")}
        </label>
        <div className="flex gap-1">
          {(["200k", "1m"] as const).map((size) => (
            <button
              key={size}
              onClick={() => updateSettings({ contextWindow: size })}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                (settings.contextWindow || "200k") === size
                  ? "bg-accent text-white"
                  : "bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary"
              }`}
            >
              {t(`contextWindow.${size}`)}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-muted mt-1">
          {t("settings.contextWindowHint")}
        </p>
      </div>

      <AddModelDialog
        open={addOpen}
        existingIds={settings.models.map((m) => m.id)}
        onClose={() => setAddOpen(false)}
        onAdd={handleAdd}
      />
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
        const creds = resolveModelCreds(settings.model, settings.models, settings.apiKey, settings.baseUrl);
        await startLarkBot({
          app_id: config.appId,
          app_secret: config.appSecret,
          project_dir: settings.workingDirectory || undefined,
          model: settings.model || undefined,
          api_key: creds.apiKey || undefined,
          base_url: creds.baseUrl || undefined,
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

      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-3 min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <ToggleSwitch checked={config.autoConnect} onChange={(v) => updateConfig({ autoConnect: v })} />
            <span className="text-xs text-text-secondary">{t("lark.autoConnect")}</span>
          </div>
          <div className="flex items-center gap-2.5">
            <ToggleSwitch checked={config.notifyOnComplete ?? false} onChange={(v) => updateConfig({ notifyOnComplete: v })} />
            <span className="text-xs text-text-secondary">
              {t("lark.notifyOnComplete")}
              <span className="text-text-muted ml-1">— {t("lark.notifyOnCompleteHint")}</span>
            </span>
          </div>
        </div>

        <button
          onClick={handleToggle}
          disabled={larkConnecting}
          className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5
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

      <div className="rounded-lg border border-border bg-bg-tertiary/30 px-3 py-2.5 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-text-secondary">{t("lark.setupTitle")}</span>
          <button
            onClick={() => shellOpen("https://open.feishu.cn/app").catch(console.error)}
            className="flex items-center gap-1 text-[10px] text-accent hover:text-accent-hover transition-colors"
          >
            {t("lark.setupLink")}
            <ExternalLink size={10} />
          </button>
        </div>
        <ul className="space-y-1 text-[11px] text-text-muted">
          <li>
            <span className="text-text-secondary">{t("lark.setupScopes")}：</span>
            <code className="text-text-primary/80 bg-bg-primary/50 px-1 py-0.5 rounded text-[10px]">{t("lark.setupScopesValue")}</code>
          </li>
          <li>
            <span className="text-text-secondary">{t("lark.setupEvents")}：</span>
            <code className="text-text-primary/80 bg-bg-primary/50 px-1 py-0.5 rounded text-[10px]">{t("lark.setupEventsValue")}</code>
          </li>
          <li>
            <span className="text-text-secondary">{t("lark.setupConnection")}：</span>
            <span className="text-text-primary/80">{t("lark.setupConnectionValue")}</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

// ── About Tab ─────────────────────────────────────────────────────────

function AboutSection({
  updateStatus, onCheckUpdate, onRestart, onOpenDebug, onClose, onShowReleaseNotes, onShowChangelog,
}: {
  updateStatus: UpdateStatus | null;
  onCheckUpdate?: () => Promise<void>;
  onRestart?: () => void;
  onOpenDebug?: () => void;
  onClose: () => void;
  onShowReleaseNotes?: () => void;
  onShowChangelog?: () => void;
}) {
  const t = useT();
  const [appVersion, setAppVersion] = useState("");
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  const isNetworkError = (msg: string): boolean => {
    return /network|timeout|timed out|econn|enotfound|dns|fetch|unreachable|aborted|connection|socket|host/i.test(msg);
  };

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
            {onShowChangelog ? (
              <button
                onClick={onShowChangelog}
                className="text-sm font-semibold text-text-primary hover:text-accent
                           transition-colors inline-flex items-baseline gap-1.5 cursor-pointer"
                title={t("changelog.viewHistory")}
              >
                ClaudeBox <span className="font-mono text-text-secondary group-hover:text-accent">v{appVersion}</span>
              </button>
            ) : (
              <span className="text-sm font-semibold text-text-primary">
                ClaudeBox <span className="font-mono text-text-secondary">v{appVersion}</span>
              </span>
            )}
            {onShowChangelog && (
              <button
                onClick={onShowChangelog}
                className="text-xs text-text-muted hover:text-accent transition-colors
                           inline-flex items-center gap-1 cursor-pointer"
              >
                <History size={11} />
                {t("changelog.viewHistory")}
              </button>
            )}
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
              <div className="space-y-1.5">
                <div className="flex items-start gap-1.5 text-warning">
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {t(isNetworkError(updateStatus.error) ? "about.updateNetworkError" : "about.updateError")}
                    </p>
                    <p className="text-[11px] text-text-muted mt-0.5">
                      {t("about.updateErrorHint")}
                    </p>
                  </div>
                </div>
                <details className="text-[10px] text-text-muted ml-[18px]">
                  <summary className="cursor-pointer hover:text-text-secondary select-none">
                    {t("about.updateErrorDetails")}
                  </summary>
                  <p className="mt-1 font-mono break-words text-text-muted/80">{updateStatus.error}</p>
                </details>
              </div>
            ) : (
              <span className="text-success flex items-center gap-1.5">
                <CheckCircle size={12} />
                {t("about.upToDate")}
              </span>
            )}
          </div>

          {/* View release notes (when an update is available/ready) */}
          {onShowReleaseNotes &&
            updateStatus?.available &&
            updateStatus.version &&
            updateStatus.body && (
              <button
                onClick={onShowReleaseNotes}
                className="text-xs text-accent hover:text-accent-hover transition-colors
                           inline-flex items-center gap-1"
              >
                <FileText size={11} />
                {t("update.viewNotes")}
              </button>
            )}

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
              {isChecking ? t("about.checking") : updateStatus?.error ? t("about.retry") : t("about.checkUpdate")}
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
  onShowReleaseNotes?: () => void;
  onShowChangelog?: () => void;
}

export default function SettingsDialog({
  open, onClose, onClaudeStatusChange, onOpenDebug,
  updateStatus, onRestart, onCheckUpdate, onShowReleaseNotes, onShowChangelog,
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
            onShowReleaseNotes={onShowReleaseNotes}
            onShowChangelog={onShowChangelog}
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

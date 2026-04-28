import { useEffect, useMemo, useRef, useState } from "react";
import { X, Loader2, ExternalLink, ChevronDown, Check } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { BUILTIN_PROVIDERS, getProvider, type ModelConfig } from "../../lib/providers";
import { checkModelAvailable } from "../../lib/claude-ipc";
import { useT } from "../../lib/i18n";

interface AddModelDialogProps {
  open: boolean;
  existingIds: string[];
  onClose: () => void;
  onAdd: (config: ModelConfig) => void;
}

export default function AddModelDialog({ open, existingIds, onClose, onAdd }: AddModelDialogProps) {
  const t = useT();
  const [providerId, setProviderId] = useState<string>("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  const providerRef = useRef<HTMLDivElement>(null);

  const provider = useMemo(() => getProvider(providerId), [providerId]);

  useEffect(() => {
    if (!open) return;
    setProviderId("anthropic");
    setBaseUrl(BUILTIN_PROVIDERS[0].baseUrl);
    setApiKey("");
    setModelId("");
    setChecking(false);
    setError(null);
    setProviderOpen(false);
  }, [open]);

  useEffect(() => {
    setBaseUrl(provider.id === "custom" ? "" : provider.baseUrl);
    setModelId("");
    setError(null);
  }, [provider]);

  useEffect(() => {
    if (!providerOpen) return;
    const handler = (e: MouseEvent) => {
      if (providerRef.current && !providerRef.current.contains(e.target as Node)) {
        setProviderOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [providerOpen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const trimmedModel = modelId.trim();
  const duplicate = trimmedModel.length > 0 && existingIds.includes(trimmedModel);
  const canSubmit = trimmedModel.length > 0 && !duplicate && apiKey.trim().length > 0 && baseUrl.trim().length > 0 && !checking;

  const submit = async () => {
    if (!canSubmit) return;
    setChecking(true);
    setError(null);
    try {
      await checkModelAvailable(trimmedModel, apiKey.trim(), baseUrl.trim());
      onAdd({ id: trimmedModel, providerId: provider.id, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
      onClose();
    } catch (err) {
      const reason = String(err);
      if (reason.includes("no_api_key")) {
        onAdd({ id: trimmedModel, providerId: provider.id, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
        onClose();
        return;
      }
      setError(t("settings.modelUnavailable", { reason }));
    } finally {
      setChecking(false);
    }
  };

  const modelPlaceholder = provider.suggestedModels[0] || "e.g. claude-sonnet-4-6";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
    >
      <div className="bg-bg-primary border border-border rounded-2xl w-[520px] max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold text-text-primary">{t("settings.addModelTitle")}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Provider */}
          <div>
            <label className="text-xs font-medium text-text-secondary block mb-1.5">
              {t("settings.provider")}
            </label>
            <div ref={providerRef} className="relative">
              <button
                type="button"
                onClick={() => setProviderOpen(!providerOpen)}
                className={`w-full flex items-center justify-between rounded-lg bg-input-bg border
                           pl-3 pr-2.5 py-2 text-sm text-text-primary cursor-pointer
                           transition-colors
                           ${providerOpen
                             ? "border-accent/60 ring-2 ring-accent/30"
                             : "border-border hover:border-border-hover"
                           }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0
                      ${provider.id === "custom" ? "bg-text-muted" : "bg-accent"}`}
                  />
                  <span>{t(`provider.${provider.id}`)}</span>
                </span>
                <ChevronDown
                  size={14}
                  className={`text-text-muted transition-transform ${providerOpen ? "rotate-180" : ""}`}
                />
              </button>
              {providerOpen && (
                <div
                  className="absolute left-0 right-0 top-full mt-1.5 z-10 rounded-lg
                             bg-bg-secondary border border-border shadow-xl overflow-hidden py-1 max-h-64 overflow-y-auto"
                >
                  {BUILTIN_PROVIDERS.map((p) => {
                    const active = p.id === providerId;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setProviderId(p.id);
                          setProviderOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors
                          ${active
                            ? "bg-accent/10 text-text-primary"
                            : "text-text-secondary hover:bg-bg-tertiary/40 hover:text-text-primary"
                          }`}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className={`w-1.5 h-1.5 rounded-full flex-shrink-0
                              ${p.id === "custom" ? "bg-text-muted" : "bg-accent"}`}
                          />
                          <span>{t(`provider.${p.id}`)}</span>
                        </span>
                        {active && <Check size={13} className="text-accent" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* API Key */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-text-secondary">
                {t("settings.apiKey")}
              </label>
              {provider.consoleUrl && (
                <button
                  type="button"
                  onClick={() => shellOpen(provider.consoleUrl).catch(console.error)}
                  className="flex items-center gap-1 text-[10px] text-accent hover:text-accent-hover transition-colors"
                >
                  {t("settings.getApiKey")}
                  <ExternalLink size={10} />
                </button>
              )}
            </div>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setError(null); }}
              placeholder="sk-..."
              className="w-full rounded-lg bg-input-bg border border-border px-3 py-2 text-sm
                         text-text-primary placeholder:text-text-muted
                         focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </div>

          {/* Base URL */}
          <div>
            <label className="text-xs font-medium text-text-secondary block mb-1.5">
              {t("settings.baseUrl")}
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => { setBaseUrl(e.target.value); setError(null); }}
              placeholder="https://api.anthropic.com"
              className="w-full rounded-lg bg-input-bg border border-border px-3 py-2 text-sm font-mono
                         text-text-primary placeholder:text-text-muted
                         focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
            {provider.id !== "custom" && (
              <p className="text-[10px] text-text-muted mt-1">{t("settings.baseUrlOverrideHint")}</p>
            )}
          </div>

          {/* Model ID */}
          <div>
            <label className="text-xs font-medium text-text-secondary block mb-1.5">
              {t("settings.modelId")}
            </label>
            <input
              type="text"
              value={modelId}
              onChange={(e) => { setModelId(e.target.value); setError(null); }}
              placeholder={modelPlaceholder}
              className="w-full rounded-lg bg-input-bg border border-border px-3 py-2 text-sm font-mono
                         text-text-primary placeholder:text-text-muted
                         focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
            <p className="text-[10px] text-text-muted mt-1.5">{t("settings.modelIdHint")}</p>
          </div>

          {duplicate && (
            <p className="text-xs text-warning">· {trimmedModel} — already added</p>
          )}
          {error && (
            <p className="text-xs text-error break-words">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:bg-bg-secondary hover:text-text-primary transition-colors"
          >
            {t("settings.cancel")}
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-accent-hover
                       transition-colors text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed
                       flex items-center gap-1.5"
          >
            {checking && <Loader2 size={12} className="animate-spin" />}
            {t("settings.testAndAdd")}
          </button>
        </div>
      </div>
    </div>
  );
}

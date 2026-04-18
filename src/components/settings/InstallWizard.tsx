import { useState, useEffect, useRef, useCallback } from "react";
import { Download, Loader2, CheckCircle, XCircle, ChevronDown, ChevronUp, Copy, Check, ExternalLink } from "lucide-react";
import {
  checkNodeVersion,
  getNodeInstallerUrl,
  downloadAndOpenNodeInstaller,
  installClaudeCode,
  onInstallProgress,
  type InstallProgress,
} from "../../lib/claude-ipc";
import { useT } from "../../lib/i18n";

type Step =
  | "idle"
  | "checking"
  | "downloading_node"
  | "waiting_node_install"
  | "installing_claude"
  | "done"
  | "error";

interface InstallWizardProps {
  onComplete: () => void;
  manualInstructions: { platform: string; command: string; note: string };
}

export default function InstallWizard({ onComplete, manualInstructions }: InstallWizardProps) {
  const t = useT();
  const [step, setStep] = useState<Step>("idle");
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [npmLog, setNpmLog] = useState<string[]>([]);
  const [nodeVersion, setNodeVersion] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Listen to install-progress events
  useEffect(() => {
    const unlisten = onInstallProgress((p: InstallProgress) => {
      setStatusMsg(p.message);
      if (p.progress >= 0) setProgress(p.progress);
      if (p.step === "install_claude" && p.message && !p.done) {
        setNpmLog((prev) => [...prev.slice(-100), p.message]);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Auto-scroll npm log
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [npmLog]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startInstall = useCallback(async () => {
    setStep("checking");
    setError(null);
    setStatusMsg(t("install.checking"));

    // Check if Node.js is already available and sufficient
    try {
      const ver = await checkNodeVersion();
      const major = parseInt(ver.replace(/^v/, "").split(".")[0], 10);
      if (!isNaN(major) && major >= 22) {
        // Node is fine, skip to Claude install
        setStep("installing_claude");
        setNpmLog([]);
        try {
          await installClaudeCode();
          setStep("done");
          onComplete();
        } catch (e) {
          setError(String(e));
          setStep("error");
        }
        return;
      }
      // Node too old
      setNodeVersion(ver);
    } catch {
      // Node not found
    }

    // Need to install Node.js
    setStep("downloading_node");
    try {
      const info = await getNodeInstallerUrl();
      setNodeVersion(info.version);
      await downloadAndOpenNodeInstaller();
      // Installer opened — start polling for Node availability
      setStep("waiting_node_install");
      startNodePolling();
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  }, [onComplete, t]);

  const startNodePolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const ver = await checkNodeVersion();
        const major = parseInt(ver.replace(/^v/, "").split(".")[0], 10);
        if (!isNaN(major) && major >= 22) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          // Node is ready, install Claude Code
          setStep("installing_claude");
          setNpmLog([]);
          try {
            await installClaudeCode();
            setStep("done");
            onComplete();
          } catch (e) {
            setError(String(e));
            setStep("error");
          }
        }
      } catch {
        // Still not available, keep polling
      }
    }, 3000);
  }, [onComplete]);

  const handleRetry = useCallback(() => {
    setError(null);
    startInstall();
  }, [startInstall]);

  const handleCopy = () => {
    navigator.clipboard.writeText(manualInstructions.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-2 rounded-lg bg-bg-secondary border border-border overflow-hidden">
      {/* Main content */}
      <div className="p-3">
        {step === "idle" && (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-text-primary">{t("install.title")}</p>
              <p className="text-[10px] text-text-muted mt-0.5">{t("install.desc")}</p>
            </div>
            <button
              onClick={startInstall}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                         bg-accent text-white hover:bg-accent-hover transition-colors flex-shrink-0"
            >
              <Download size={12} />
              {t("install.button")}
            </button>
          </div>
        )}

        {step === "checking" && (
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="animate-spin text-accent" />
            <span className="text-xs text-text-secondary">{t("install.checking")}</span>
          </div>
        )}

        {step === "downloading_node" && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Loader2 size={14} className="animate-spin text-accent" />
              <span className="text-xs text-text-secondary">
                {t("install.downloadingNode", { version: nodeVersion })}
              </span>
            </div>
            <div className="relative w-full h-2 rounded-full bg-text-muted/15 overflow-hidden">
              <div
                className="absolute top-0 left-0 h-full bg-accent transition-all duration-300"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            {statusMsg && (
              <p className="text-[10px] text-text-muted mt-1">{statusMsg}</p>
            )}
          </div>
        )}

        {step === "waiting_node_install" && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Loader2 size={14} className="animate-spin text-warning" />
              <span className="text-xs font-medium text-text-primary">
                {t("install.waitingInstaller")}
              </span>
            </div>
            <p className="text-[10px] text-text-muted mb-2">
              {t("install.waitingInstallerDesc")}
            </p>
            <p className="text-[10px] text-text-muted/60 italic">
              {t("install.waitingDetect")}
            </p>
          </div>
        )}

        {step === "installing_claude" && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Loader2 size={14} className="animate-spin text-accent" />
              <span className="text-xs text-text-secondary">{t("install.installingClaude")}</span>
            </div>
            {/* Indeterminate progress bar */}
            <div className="relative w-full h-1.5 rounded-full bg-text-muted/15 overflow-hidden mb-2">
              <div className="absolute top-0 left-0 h-full w-1/3 bg-accent rounded-full animate-[shimmer_1.5s_ease-in-out_infinite]" />
            </div>
            {npmLog.length > 0 && (
              <div
                ref={logRef}
                className="max-h-[80px] overflow-y-auto rounded bg-code-bg p-2 text-[10px] font-mono text-text-muted leading-relaxed"
              >
                {npmLog.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {step === "done" && (
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-success" />
            <span className="text-xs font-medium text-success">{t("install.success")}</span>
          </div>
        )}

        {step === "error" && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <XCircle size={14} className="text-error" />
              <span className="text-xs text-error">
                {t("install.failed", { error: error || "Unknown error" })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleRetry}
                className="px-2.5 py-1 rounded-md text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
              >
                {t("install.retry")}
              </button>
              <a
                href="https://nodejs.org"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-text-secondary hover:text-text-primary transition-colors"
                onClick={(e) => {
                  e.preventDefault();
                  import("../../lib/claude-ipc").then((m) => m.openInBrowser("https://nodejs.org"));
                }}
              >
                <ExternalLink size={10} />
                {t("install.openUrl")}
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Manual setup toggle — always visible except when done */}
      {step !== "done" && (
        <div className="border-t border-border">
          <button
            onClick={() => setShowManual(!showManual)}
            className="flex items-center gap-1.5 w-full px-3 py-2 text-[10px] text-text-muted hover:text-text-secondary transition-colors"
          >
            {showManual ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            {t("install.manualSetup")}
          </button>
          {showManual && (
            <div className="px-3 pb-3">
              <p className="text-[10px] text-text-muted mb-1.5">
                {manualInstructions.platform}:
              </p>
              <div className="flex items-center gap-2 bg-code-bg rounded-md px-3 py-2">
                <code className="text-[10px] text-text-primary flex-1 select-all">
                  {manualInstructions.command}
                </code>
                <button
                  onClick={handleCopy}
                  className="p-1 rounded text-text-muted hover:text-text-primary transition-colors flex-shrink-0"
                >
                  {copied ? <Check size={10} className="text-success" /> : <Copy size={10} />}
                </button>
              </div>
              <p className="text-[10px] text-text-muted/70 mt-1">{manualInstructions.note}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

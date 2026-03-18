import { useState, useEffect, useRef, useCallback, Component, type ReactNode } from "react";
import Sidebar from "./components/sidebar/Sidebar";
import ChatPanel from "./components/chat/ChatPanel";
import SettingsDialog from "./components/settings/SettingsDialog";
import TokenStatsDialog from "./components/settings/TokenStatsDialog";
import DebugPanel from "./components/debug/DebugPanel";
import UpdateToast from "./components/UpdateToast";
import { checkClaudeInstalled, applySystemProxy, emitDebug } from "./lib/claude-ipc";
import {
  checkAndDownloadUpdate,
  applyUpdateAndRelaunch,
  type UpdateStatus,
} from "./lib/updater";
import { useSettingsStore } from "./stores/settingsStore";
import { useChatStore } from "./stores/chatStore";
import { useTokenUsageStore } from "./stores/tokenUsageStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2, AlertTriangle } from "lucide-react";

// ── Error Boundary ────────────────────────────────────────────────────
// Catches any render-time exception and shows a recovery screen
// instead of a blank white page.
interface ErrorBoundaryState { error: Error | null }
class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen bg-bg-primary items-center justify-center p-8">
          <div className="max-w-lg text-center">
            <p className="text-error font-semibold mb-2">Something went wrong</p>
            <pre className="text-xs text-text-muted bg-bg-secondary rounded p-3 text-left overflow-auto max-h-48">
              {this.state.error.message}
            </pre>
            <button
              className="mt-4 px-4 py-1.5 text-sm rounded-lg bg-accent text-white"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tokenStatsOpen, setTokenStatsOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [claudeAvailable, setClaudeAvailable] = useState(true);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const { settings, loaded: settingsLoaded, init: initSettings } = useSettingsStore();
  const { loaded: chatLoaded, init: initChat } = useChatStore();
  const { init: initTokenUsage } = useTokenUsageStore();
  // Fallback: force-show the app after 8s even if stores never finish loading
  // (guards against Tauri IPC hang on slow machines)
  const [forceReady, setForceReady] = useState(false);

  // Initialize stores from file storage on mount
  useEffect(() => {
    const timer = setTimeout(() => setForceReady(true), 8000);
    Promise.all([initSettings(), initChat(), initTokenUsage()])
      .catch(console.error)
      .finally(() => clearTimeout(timer));
    return () => clearTimeout(timer);
  }, []);

  // Apply theme class to root element
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "light") {
      root.classList.add("light");
    } else {
      root.classList.remove("light");
    }
  }, [settings.theme]);

  useEffect(() => {
    if (!settingsLoaded) return;
    checkClaudeInstalled(settings.claudePath || undefined)
      .then(() => setClaudeAvailable(true))
      .catch(() => {
        setClaudeAvailable(false);
        setSettingsOpen(true);
      });
  }, [settingsLoaded]);

  // Keyboard shortcut: Ctrl/Cmd+Shift+D to toggle debug
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "d") {
        e.preventDefault();
        setDebugOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── System proxy: detect on startup + poll every 30s for changes ──
  const proxyInitialized = useRef(false);

  const refreshProxy = useCallback(async () => {
    try {
      const { desc, changed } = await applySystemProxy();
      if (!proxyInitialized.current) {
        // First call — always log
        proxyInitialized.current = true;
        emitDebug("info", desc
          ? `[proxy] System proxy detected: ${desc}`
          : "[proxy] No system proxy found");
      } else if (changed) {
        // Subsequent calls — only log on change
        emitDebug("info", desc
          ? `[proxy] Proxy changed → ${desc}`
          : "[proxy] Proxy removed (no system proxy)");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitDebug("error", `[proxy] Detection failed: ${msg}`);
    }
  }, []);

  useEffect(() => {
    if (!settingsLoaded || !chatLoaded) return;
    // Initial detection, then start update check
    refreshProxy().finally(() => {
      checkAndDownloadUpdate(setUpdateStatus);
    });
    // Poll every 30s to pick up proxy changes (e.g. Clash on/off)
    const id = setInterval(refreshProxy, 30_000);
    return () => clearInterval(id);
  }, [settingsLoaded, chatLoaded, refreshProxy]);

  // ── Close-window intercept: warn if a task is still running ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(async (event) => {
      const { streamingSessions } = useChatStore.getState();
      const hasRunning = Object.values(streamingSessions).some(Boolean);
      if (hasRunning) {
        event.preventDefault();
        setCloseConfirmOpen(true);
      }
      // else: do nothing — window closes normally
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // Show loading screen until stores are ready (or timeout fires)
  if (!forceReady && (!settingsLoaded || !chatLoaded)) {
    return (
      <div className="flex h-screen bg-bg-primary items-center justify-center">
        <Loader2 size={32} className="animate-spin text-accent" />
      </div>
    );
  }

  return (
    <ErrorBoundary>
    <div className="flex h-screen bg-bg-primary">
      <Sidebar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenTokenStats={() => setTokenStatsOpen(true)}
        updateStatus={updateStatus}
        onRestart={applyUpdateAndRelaunch}
        onCheckUpdate={() => checkAndDownloadUpdate(setUpdateStatus)}
      />
      <ChatPanel claudeAvailable={claudeAvailable} />

      {/* Debug panel */}
      <DebugPanel visible={debugOpen} onClose={() => setDebugOpen(false)} />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onClaudeStatusChange={setClaudeAvailable}
        onOpenDebug={() => setDebugOpen(true)}
        onOpenTokenStats={() => setTokenStatsOpen(true)}
      />

      <TokenStatsDialog open={tokenStatsOpen} onClose={() => setTokenStatsOpen(false)} />

      {/* Close confirm dialog */}
      {closeConfirmOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60">
          <div className="bg-bg-primary border border-border rounded-2xl w-80 shadow-2xl p-6">
            <div className="flex items-center gap-3 mb-3">
              <AlertTriangle size={20} className="text-warning flex-shrink-0" />
              <h3 className="text-base font-semibold text-text-primary">任务运行中</h3>
            </div>
            <p className="text-sm text-text-secondary mb-5">
              当前有 AI 任务正在执行，关闭窗口将中断运行。确定要退出吗？
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setCloseConfirmOpen(false)}
                className="flex-1 py-2 rounded-lg border border-border text-text-secondary
                           hover:bg-bg-secondary hover:text-text-primary transition-colors text-sm font-medium"
              >
                继续等待
              </button>
              <button
                onClick={() => getCurrentWindow().destroy()}
                className="flex-1 py-2 rounded-lg bg-error text-white hover:bg-error/80
                           transition-colors text-sm font-medium"
              >
                强制退出
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Update toast — shows when update is downloading or ready */}
      {updateStatus?.available &&
        !updateDismissed &&
        (updateStatus.downloading || updateStatus.downloaded) && (
          <UpdateToast
            version={updateStatus.version!}
            body={updateStatus.body}
            downloading={updateStatus.downloading}
            onRestart={applyUpdateAndRelaunch}
            onDismiss={() => setUpdateDismissed(true)}
          />
        )}
    </div>
    </ErrorBoundary>
  );
}

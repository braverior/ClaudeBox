import { useState, useEffect, useRef, useCallback, Component, type ReactNode } from "react";
import Sidebar from "./components/sidebar/Sidebar";
import ChatPanel from "./components/chat/ChatPanel";
import SettingsDialog from "./components/settings/SettingsDialog";
import TokenStatsDialog from "./components/settings/TokenStatsDialog";
import DebugPanel from "./components/debug/DebugPanel";
import UpdateToast from "./components/UpdateToast";
import ReleaseNotesDialog, { type ReleaseNotesMode } from "./components/ReleaseNotesDialog";
import ChangelogDialog from "./components/ChangelogDialog";
import ImageLightbox from "./components/chat/ImageLightbox";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { checkClaudeInstalled, applySystemProxy, emitDebug, sendMessage, onStream } from "./lib/claude-ipc";
import {
  checkAndDownloadUpdate,
  applyUpdateAndRelaunch,
  readPendingReleaseNotes,
  clearPendingReleaseNotes,
  type UpdateStatus,
} from "./lib/updater";
import { getVersion } from "@tauri-apps/api/app";
import { useSettingsStore } from "./stores/settingsStore";
import { useChatStore } from "./stores/chatStore";
import { useTokenUsageStore } from "./stores/tokenUsageStore";
import { useLarkStore } from "./stores/larkStore";
import { useSkillsStore } from "./stores/skillsStore";
import { startLarkBot, onLarkEvent, larkSendNotification, larkSendCommand } from "./lib/lark-ipc";
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
  const [releaseNotes, setReleaseNotes] = useState<{
    open: boolean;
    mode: ReleaseNotesMode;
    version: string;
    body?: string;
    date?: string;
  }>({ open: false, mode: "available", version: "" });
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const { settings, loaded: settingsLoaded, init: initSettings } = useSettingsStore();
  const { loaded: chatLoaded, init: initChat } = useChatStore();
  const { init: initTokenUsage } = useTokenUsageStore();
  const { init: initLark, loaded: larkLoaded } = useLarkStore();
  // Fallback: force-show the app after 8s even if stores never finish loading
  // (guards against Tauri IPC hang on slow machines)
  const [forceReady, setForceReady] = useState(false);

  // Initialize stores from file storage on mount
  useEffect(() => {
    const timer = setTimeout(() => setForceReady(true), 8000);
    Promise.all([initSettings(), initChat(), initTokenUsage(), initLark()])
      .catch(console.error)
      .finally(() => clearTimeout(timer));
    getVersion().then(setAppVersion).catch(() => {});
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
    useSkillsStore.getState().preloadGlobal();
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

  // Global fallback: prevent any <a href="http(s)://..."> click from navigating
  // the webview away (would replace the app content and require a restart).
  // Route to the system browser instead. Runs in bubble phase so component-level
  // onClick handlers (which call preventDefault) take precedence.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      if (!/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      shellOpen(href).catch(() => {});
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
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
    // Check if the user just updated — show release notes once
    (async () => {
      try {
        const pending = await readPendingReleaseNotes();
        if (!pending) return;
        const current = await getVersion();
        if (pending.version === current) {
          setReleaseNotes({
            open: true,
            mode: "installed",
            version: pending.version,
            body: pending.body,
            date: pending.date,
          });
        }
        // Either matched (shown) or stale → clear
        await clearPendingReleaseNotes();
      } catch (err) {
        emitDebug("warn", `[updater] Failed to check pending release notes: ${err}`);
      }
    })();
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

  // ── Lark: execute handler — routes Lark intent to main chat flow ──
  const handleLarkExecute = useCallback(async (msg: { message_id: string; chat_id: string; prompt: string; project_path: string; summary: string }) => {
    const chatStore = useChatStore.getState();
    const larkStore = useLarkStore.getState();

    const projectPath = msg.project_path || settings.workingDirectory || "";
    if (!projectPath) {
      emitDebug("error", "[lark] No project path for execution");
      return;
    }

    // Find or create session for this project
    const sessionId = chatStore.createSession(
      projectPath,
      settings.defaultModel || settings.model || "claude-sonnet-4-20250514",
      "auto"
    );

    // Track as Lark execution
    larkStore.addLarkExecution({
      sessionId,
      chatId: msg.chat_id,
      messageId: msg.message_id,
      prompt: msg.prompt,
      summary: msg.summary,
      status: "running",
      startedAt: Date.now(),
    });

    // Switch to this session so user sees it
    chatStore.switchSession(sessionId);

    // Add user message and start streaming
    chatStore.addUserMessage(sessionId, `[飞书] ${msg.prompt}`);
    chatStore.setStreaming(sessionId, true);

    // Send through normal chat flow (same as manual typing)
    try {
      const session = chatStore.sessions.find((s) => s.id === sessionId);
      const resumeId = session?.claudeSessionId || undefined;
      await sendMessage({
        session_id: sessionId,
        message: msg.prompt,
        cwd: projectPath,
        model: settings.model || undefined,
        permission_mode: "auto",
        api_key: settings.apiKey || undefined,
        base_url: settings.baseUrl || undefined,
        resume_id: resumeId,
        effort: settings.effort || undefined,
        haiku_model: settings.haikuModel || undefined,
        sonnet_model: settings.sonnetModel || undefined,
        opus_model: settings.opusModel || undefined,
      });
    } catch (err) {
      chatStore.handleStreamDone(sessionId, String(err));
      larkStore.updateLarkExecution(sessionId, { status: "error" });
      larkSendNotification(
        msg.chat_id,
        "执行失败",
        `${msg.summary}\n\n错误: ${String(err)}`,
        "error"
      ).catch(() => {});
    }
  }, [settings]);

  // ── Lark: completion monitor — sends status updates back to Lark ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onStream((payload) => {
      if (!payload.done) return;

      // Extract last assistant message as summary
      const msgs = useChatStore.getState().messages[payload.session_id] || [];
      let lastMessage = "";
      let lastUserPrompt = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (!lastMessage && msgs[i].role === "assistant") {
          lastMessage = msgs[i].content
            .filter((b) => b.type === "text")
            .map((b) => b.text || "")
            .join("\n")
            .trim();
        }
        if (!lastUserPrompt && msgs[i].role === "user") {
          lastUserPrompt = msgs[i].content
            .filter((b) => b.type === "text")
            .map((b) => b.text || "")
            .join("\n")
            .trim();
        }
        if (lastMessage && lastUserPrompt) break;
      }

      // Sync completion to Lark bot sidecar (for all sessions, not just Lark-initiated)
      const larkStatus = useLarkStore.getState().status;
      if (larkStatus === "connected") {
        larkSendCommand(JSON.stringify({
          type: "app_activity",
          session_id: payload.session_id,
          status: payload.error ? "error" : "completed",
          last_message: lastMessage,
        })).catch(() => {});
      }

      // Lark-initiated execution: send notification card
      const larkStore = useLarkStore.getState();
      const execution = larkStore.getLarkExecution(payload.session_id);
      if (!execution || execution.status !== "running") {
        // Non-Lark-initiated task: notify if notifyOnComplete is enabled
        if (
          larkStore.config.notifyOnComplete &&
          larkStore.status === "connected" &&
          larkStore.config.lastChatId &&
          lastMessage
        ) {
          const session = useChatStore.getState().sessions.find((s) => s.id === payload.session_id);
          const title = payload.error ? "❌ 任务失败" : "✅ 任务完成";
          const projectLabel = session?.projectName || "Task";
          const promptLine = lastUserPrompt ? `**📝 ${lastUserPrompt}**\n\n` : "";
          const content = payload.error
            ? `**${projectLabel}**\n\n${promptLine}**错误：**\n${payload.error}`
            : `**${projectLabel}**\n\n${promptLine}${lastMessage}`;
          larkSendNotification(larkStore.config.lastChatId, title, content, payload.error ? "error" : "end").catch(() => {});
        }
        return;
      }

      const durationSec = Math.round((Date.now() - execution.startedAt) / 1000);
      const summary = lastMessage
        ? `${execution.summary}\n\n**执行结果：**\n${lastMessage}\n\n耗时: ${durationSec}秒`
        : `${execution.summary}\n\n耗时: ${durationSec}秒`;
      if (payload.error) {
        larkStore.updateLarkExecution(payload.session_id, { status: "error" });
        larkSendNotification(
          execution.chatId,
          "任务失败",
          `${execution.summary}\n\n错误: ${payload.error}\n耗时: ${durationSec}秒`,
          "error"
        ).catch(() => {});
      } else {
        larkStore.updateLarkExecution(payload.session_id, { status: "completed" });
        larkSendNotification(
          execution.chatId,
          "任务完成",
          summary,
          "end"
        ).catch(() => {});
      }
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // ── Lark bot: event listener ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onLarkEvent((payload) => {
      if (payload.done) {
        useLarkStore.getState().setStatus("stopped");
        return;
      }
      try {
        const msg = JSON.parse(payload.data);
        const larkStore = useLarkStore.getState();
        const chatStore = useChatStore.getState();

        if (msg.type === "status") {
          larkStore.setStatus(msg.status);
          if (msg.reason) larkStore.setError(msg.reason);
        } else if (msg.type === "lark_message") {
          larkStore.addMessage({
            id: `${msg.message_id}-${Date.now()}`,
            messageId: msg.message_id,
            senderId: msg.sender_id,
            content: msg.content,
            timestamp: msg.timestamp,
            status: "processing",
          });
          if (msg.chat_id) larkStore.setLastChatId(msg.chat_id);
        } else if (msg.type === "ai_reply") {
          larkStore.updateMessage(msg.message_id, {
            aiReply: msg.reply,
            status: "replied",
          });
        } else if (msg.type === "task_created" && msg.task) {
          larkStore.addTask(msg.task);
          // Create a session for this task so it shows in sidebar
          const projectDir = msg.task.projectPath || settings.workingDirectory || `lark://${msg.task.projectName || "task"}`;
          const sessionId = chatStore.createSession(projectDir, settings.defaultModel || settings.model || "claude-sonnet-4-20250514", "auto");
          larkStore.setTaskSession(msg.task.id, sessionId);
          chatStore.addSystemMessage(sessionId, `[飞书任务] ${msg.task.description}`);
        } else if (msg.type === "task_updated") {
          larkStore.updateTask(msg.task_id, { status: msg.status });
        } else if (msg.type === "lark_execute") {
          if (msg.chat_id) larkStore.setLastChatId(msg.chat_id);
          // AI understood intent — execute through main chat flow
          handleLarkExecute(msg).catch((err) =>
            emitDebug("error", `[lark] Execute failed: ${err}`)
          );
        } else if (msg.type === "error") {
          larkStore.setError(msg.message);
        }
      } catch { /* ignore malformed */ }
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // ── Lark bot: auto-connect on startup ──
  useEffect(() => {
    if (!settingsLoaded || !larkLoaded) return;
    const larkConfig = useLarkStore.getState().config;
    if (!larkConfig.autoConnect) return;
    if (!larkConfig.appId || !larkConfig.appSecret) return;

    startLarkBot({
      app_id: larkConfig.appId,
      app_secret: larkConfig.appSecret,
      project_dir: settings.workingDirectory || undefined,
      model: settings.model || undefined,
      api_key: settings.apiKey || undefined,
      base_url: settings.baseUrl || undefined,
    }).then(() => {
      useLarkStore.getState().setStatus("connecting");
    }).catch((err) => {
      emitDebug("error", `[lark] Auto-connect failed: ${err}`);
    });
  }, [settingsLoaded, larkLoaded]);

  // ── Release notes: open available-mode dialog from Settings / Toast ──
  const showAvailableReleaseNotes = useCallback(() => {
    if (!updateStatus?.version) return;
    setReleaseNotes({
      open: true,
      mode: "available",
      version: updateStatus.version,
      body: updateStatus.body,
      date: updateStatus.date,
    });
  }, [updateStatus]);

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
        onShowChangelog={() => setChangelogOpen(true)}
      />
      <ChatPanel claudeAvailable={claudeAvailable} />

      {/* Debug panel */}
      <DebugPanel visible={debugOpen} onClose={() => setDebugOpen(false)} />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onClaudeStatusChange={setClaudeAvailable}
        onOpenDebug={() => setDebugOpen(true)}
        updateStatus={updateStatus}
        onRestart={applyUpdateAndRelaunch}
        onCheckUpdate={() => checkAndDownloadUpdate(setUpdateStatus)}
        onShowReleaseNotes={showAvailableReleaseNotes}
        onShowChangelog={() => setChangelogOpen(true)}
      />

      <TokenStatsDialog open={tokenStatsOpen} onClose={() => setTokenStatsOpen(false)} />

      <ReleaseNotesDialog
        open={releaseNotes.open}
        mode={releaseNotes.mode}
        version={releaseNotes.version}
        body={releaseNotes.body}
        date={releaseNotes.date}
        onClose={() => setReleaseNotes((r) => ({ ...r, open: false }))}
      />

      <ChangelogDialog
        open={changelogOpen}
        currentVersion={appVersion}
        onClose={() => setChangelogOpen(false)}
      />

      <ImageLightbox />

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
            onShowNotes={showAvailableReleaseNotes}
          />
        )}
    </div>
    </ErrorBoundary>
  );
}

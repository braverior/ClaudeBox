import { useEffect, useRef, useCallback, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { sendMessage, stopSession, onStream, getGitBranch, sendResponse, clearSessionResume } from "../../lib/claude-ipc";
import { getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window";
import { useT } from "../../lib/i18n";
import { startWindowDrag } from "../../lib/utils";
import MessageBubble from "./MessageBubble";
import InputArea, { type Attachment } from "./InputArea";
import TaskBoard from "./TaskBoard";
import FileTree from "./FileTree";
import FileViewer from "./FileViewer";
import { Sparkles, FolderOpen, Terminal, GitBranch, PanelRightClose, PanelRight } from "lucide-react";

interface ChatPanelProps {
  claudeAvailable: boolean;
}

export default function ChatPanel({ claudeAvailable }: ChatPanelProps) {
  const {
    currentSessionId,
    sessions,
    messages,
    streamingSessions,
    streamError,
    streamStartTimes,
    pendingInteraction,
    addUserMessage,
    addSystemMessage,
    addLaunchMessage,
    handleStreamData,
    handleStreamDone,
    setStreaming,
    clearError,
    updateSession,
    clearPendingInteraction,
    clearClaudeSession,
  } = useChatStore();

  const { settings } = useSettingsStore();
  const t = useT();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const isStreaming = currentSessionId ? !!streamingSessions[currentSessionId] : false;
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [showFilePanel, setShowFilePanel] = useState(false);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);

  const FILE_PANEL_WIDTH = 256; // w-64

  const toggleFilePanel = useCallback(async () => {
    const next = !showFilePanel;
    setShowFilePanel(next);
    if (!next) setOpenFilePath(null);
    try {
      const win = getCurrentWindow();
      const size = await win.outerSize();
      const delta = next ? FILE_PANEL_WIDTH : -FILE_PANEL_WIDTH;
      await win.setSize(new PhysicalSize(size.width + delta, size.height));
    } catch {
      // ignore — window API may not be available in dev
    }
  }, [showFilePanel]);

  // Fetch git branch when session changes
  useEffect(() => {
    setGitBranch(null);
    if (currentSession?.projectPath) {
      getGitBranch(currentSession.projectPath)
        .then((branch) => setGitBranch(branch))
        .catch(() => setGitBranch(null));
    }
  }, [currentSession?.projectPath]);

  useEffect(() => {
    const unlisten = onStream((payload) => {
      if (payload.done) {
        handleStreamDone(payload.session_id, payload.error ?? undefined);
      } else if (payload.data) {
        handleStreamData(payload.session_id, payload.data, payload.stream);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [handleStreamData, handleStreamDone]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentSessionId]);

  const handleSend = useCallback(
    async (content: string, attachments?: Attachment[]) => {
      if (!currentSessionId || !currentSession) return;

      // Validate config before sending
      const effectiveModel = currentSession.model || settings.model;
      if (!settings.apiKey) {
        const missing = ["API Key"];
        if (!effectiveModel) missing.push("Model");
        addSystemMessage(
          currentSessionId,
          `⚠️ ${t("chat.missingConfig", { items: missing.join(", ") })}`
        );
        return;
      }
      if (!effectiveModel) {
        addSystemMessage(
          currentSessionId,
          `⚠️ ${t("chat.noModel")}`
        );
        return;
      }

      addUserMessage(
        currentSessionId,
        content,
        attachments?.map((a) => ({ name: a.name, type: a.type, path: a.path, dataUrl: a.dataUrl }))
      );
      setStreaming(currentSessionId, true);
      clearError();
      try {
        const resumeId = currentSession.claudeSessionId || undefined;
        const pid = await sendMessage({
          session_id: currentSessionId,
          message: content,
          cwd: currentSession.projectPath,
          model: currentSession.model || undefined,
          permission_mode: currentSession.permissionMode || undefined,
          claude_path: settings.claudePath || undefined,
          allowed_tools: currentSession.allowedTools?.length
            ? currentSession.allowedTools
            : undefined,
          api_key: settings.apiKey || undefined,
          base_url: settings.baseUrl || undefined,
          attachments: attachments?.map((a) => ({
            path: a.path,
            name: a.name,
            type: a.type,
          })),
          resume_id: resumeId,
        });
        addLaunchMessage(currentSessionId, pid, resumeId);
      } catch (err) {
        handleStreamDone(currentSessionId, String(err));
      }
    },
    [currentSessionId, currentSession, settings, addUserMessage, addSystemMessage, addLaunchMessage, setStreaming, clearError, handleStreamDone]
  );

  const handleStop = useCallback(async () => {
    if (currentSessionId) {
      try { await stopSession(currentSessionId); } catch { /* ignore */ }
    }
  }, [currentSessionId]);

  const handleModelChange = useCallback(
    (model: string) => {
      if (currentSessionId) updateSession(currentSessionId, { model });
    },
    [currentSessionId, updateSession]
  );

  const handlePermissionModeChange = useCallback(
    (permissionMode: string) => {
      if (currentSessionId) updateSession(currentSessionId, { permissionMode });
    },
    [currentSessionId, updateSession]
  );

  const handleAllowedToolsChange = useCallback(
    (allowedTools: string[]) => {
      if (currentSessionId) updateSession(currentSessionId, { allowedTools });
    },
    [currentSessionId, updateSession]
  );

  const handleClearSession = useCallback(() => {
    if (!currentSessionId) return;
    clearClaudeSession(currentSessionId);
    // Also clear the in-memory resume ID on Rust side to prevent fallback
    clearSessionResume(currentSessionId).catch(() => {});
    addSystemMessage(currentSessionId, t("chat.sessionCleared"));
  }, [currentSessionId, clearClaudeSession, addSystemMessage, t]);

  /** Send a response to the sidecar when user answers an interactive tool (AskUserQuestion / ExitPlanMode) */
  const handleRespond = useCallback(
    async (response: Record<string, unknown>) => {
      if (!currentSessionId) return;
      try {
        await sendResponse(currentSessionId, response);
        clearPendingInteraction();
      } catch (err) {
        console.error("Failed to send response:", err);
      }
    },
    [currentSessionId, clearPendingInteraction]
  );

  const currentMessages = currentSessionId
    ? messages[currentSessionId] || []
    : [];

  // Compute total tokens for the current turn (all assistant messages after last user message)
  const totalTokens = (() => {
    let tokens = 0;
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const m = currentMessages[i];
      if (m.role === "user") break;
      if (m.role === "assistant" && m.usage) {
        tokens += m.usage.input_tokens + m.usage.output_tokens;
      }
    }
    return tokens;
  })();

  // Compute duration from stream start
  const streamStartTime = currentSessionId ? streamStartTimes[currentSessionId] : undefined;

  // No session — welcome
  if (!currentSessionId) {
    return (
      <div className="flex-1 flex flex-col h-full">
        {/* Draggable titlebar area */}
        <div
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
          className="h-14 flex-shrink-0"
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center px-8">
            <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-4">
              <Sparkles size={32} className="text-accent" />
            </div>
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              {t("welcome.title")}
            </h2>
            <p className="text-text-secondary text-sm max-w-md mb-4">
              {t("welcome.desc")}
            </p>
            <div className="flex items-center gap-2 justify-center text-text-muted text-xs">
              <FolderOpen size={14} />
              <span>{t("welcome.hint")}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Session header */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-3 px-4 border-b border-border bg-bg-secondary/50 h-14 flex-shrink-0"
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          getCurrentWindow().startDragging();
        }}
      >
        <FolderOpen size={14} className="text-text-muted pointer-events-none" />
        <span
          className="text-sm text-text-secondary truncate max-w-[50%] pointer-events-none"
          title={currentSession?.projectPath}
        >
          {currentSession?.projectName}
        </span>
        <div className="flex-1 pointer-events-none" />
        {gitBranch && (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-muted pointer-events-none max-w-[150px]">
            <GitBranch size={11} className="flex-shrink-0" />
            <span className="truncate">{gitBranch}</span>
          </span>
        )}
        <button
          onClick={toggleFilePanel}
          className="flex-shrink-0 p-1.5 rounded-lg hover:bg-bg-tertiary/50 text-text-secondary hover:text-text-primary transition-colors"
          title={showFilePanel ? t("chat.closeFilePanel") : t("chat.openFilePanel")}
        >
          {showFilePanel ? <PanelRightClose size={16} /> : <PanelRight size={16} />}
        </button>
      </div>

      {/* Main content area with optional file panel */}
      <div className="flex-1 flex min-h-0">
        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          {openFilePath ? (
            /* File viewer overlay — covers entire chat area for maximum reading space */
            <FileViewer
              filePath={openFilePath}
              onClose={() => setOpenFilePath(null)}
            />
          ) : (
            <>
              {/* Messages */}
              <div className="flex-1 overflow-y-auto pt-4 pb-2">
                <div className="max-w-3xl mx-auto overflow-hidden">
                  {currentMessages.length === 0 && (
                    <div className="text-center py-16 text-text-muted">
                      <Terminal size={24} className="mx-auto mb-2 opacity-50" />
                      <p className="text-sm">
                        {t("chat.emptyHint")}
                      </p>
                    </div>
                  )}
                  {currentMessages.map((msg, i) => {
                    // Only show bot avatar on the first assistant message in a consecutive group
                    let showAvatar = true;
                    if (msg.role === "assistant" && i > 0) {
                      const prev = currentMessages[i - 1];
                      if (prev.role === "assistant") showAvatar = false;
                    }
                    // Last assistant in its consecutive run (before a user msg or end of list)
                    const isLastInTurn =
                      msg.role === "assistant" &&
                      (i + 1 >= currentMessages.length || currentMessages[i + 1].role !== "assistant");
                    // The very last assistant message overall
                    const isLastAssistant =
                      msg.role === "assistant" &&
                      !currentMessages.slice(i + 1).some((m) => m.role === "assistant");
                    return (
                      <MessageBubble
                        key={msg.id}
                        message={msg}
                        allMessages={currentMessages}
                        messageIndex={i}
                        showAvatar={showAvatar}
                        isLastInTurn={isLastInTurn}
                        isLastAssistant={isLastAssistant}
                        totalTokens={totalTokens}
                        streamStartTime={streamStartTime}
                        pendingInteraction={isLastAssistant ? pendingInteraction : undefined}
                        onRespond={isLastAssistant ? handleRespond : undefined}
                      />
                    );
                  })}
                </div>

                {streamError && (
                  <div className="max-w-3xl mx-auto px-4 mb-4">
                    <div className="rounded-lg bg-error/10 border border-error/30 px-4 py-3 text-error text-sm">
                      {streamError}
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* Task Board (above input) */}
              <TaskBoard sessionId={currentSessionId} />

              {/* Input */}
              <InputArea
                onSend={handleSend}
                onStop={handleStop}
                isStreaming={isStreaming}
                disabled={!claudeAvailable}
                model={currentSession?.model || ""}
                models={settings.models}
                permissionMode={currentSession?.permissionMode || ""}
                onModelChange={handleModelChange}
                onPermissionModeChange={handlePermissionModeChange}
                gitBranch={gitBranch}
                allowedTools={currentSession?.allowedTools || []}
                onAllowedToolsChange={handleAllowedToolsChange}
                hasClaudeSession={!!currentSession?.claudeSessionId}
                onClearSession={handleClearSession}
              />
            </>
          )}
        </div>

        {/* File panel — tree only, viewer is shown in the chat area */}
        {showFilePanel && currentSession?.projectPath && (
          <div className="w-64 border-l border-border bg-bg-secondary flex-shrink-0">
            <FileTree rootPath={currentSession.projectPath} onFileSelect={setOpenFilePath} />
          </div>
        )}
      </div>
    </div>
  );
}

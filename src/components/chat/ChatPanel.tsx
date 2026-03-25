import React, { useEffect, useRef, useCallback, useState, useMemo, memo, useLayoutEffect } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTaskStore } from "../../stores/taskStore";
import { sendMessage, stopSession, onStream, getGitBranch, listGitBranches, checkoutGitBranch, sendResponse, clearSessionResume, openInTerminal, gitDiffFiles } from "../../lib/claude-ipc";
import { getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window";
import { useT } from "../../lib/i18n";
import { startWindowDrag } from "../../lib/utils";
import MessageBubble from "./MessageBubble";
import ToolCallCard from "./ToolCallCard";
import InputArea, { type Attachment } from "./InputArea";
import TaskBoard from "./TaskBoard";
import FileTree from "./FileTree";
import FileViewer from "./FileViewer";
import NewSessionDialog from "./NewSessionDialog";
import { Sparkles, FolderOpen, Terminal, GitBranch, PanelRightClose, PanelRight, ChevronDown, ChevronRight, Loader2, CheckCircle, Check, FileText } from "lucide-react";
import type { ChatMessage, ContentBlock, PendingInteraction } from "../../lib/stream-parser";

interface ChatPanelProps {
  claudeAvailable: boolean;
}

// ── Agent run detection: groups Agent tool_use + all child messages ──

interface AgentRun {
  agentMsgIndex: number;
  agentBlock: ContentBlock;
  childIndices: number[]; // indices of messages that belong to this agent run
  hasResult: boolean;     // whether the Agent's tool_result has been received
}

function detectAgentRuns(msgs: ChatMessage[]): { runs: Map<number, AgentRun>; hidden: Set<number> } {
  const runs = new Map<number, AgentRun>();
  const hidden = new Set<number>();

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.role !== "assistant") continue;
    // If this message is already a child of another agent run, skip it as a parent.
    // Without this, a nested Agent tool_use (already hidden) would run its own inner loop
    // and incorrectly sweep subsequent text-only messages (visible break points) into hidden.
    if (hidden.has(i)) continue;

    const agentBlock = msg.content.find(
      (b) => b.type === "tool_use" && b.name === "Agent"
    );
    if (!agentBlock?.id) continue;

    // The Agent's tool_result gets appended to THIS message (the parent)
    // by the stream parser, not to a child message.
    const hasResult = msg.content.some(
      (b) => b.type === "tool_result" && b.tool_use_id === agentBlock.id
    );

    // Collect sub-agent assistant messages as children.
    // When the Agent is done (hasResult), stop at messages that have no tool_use blocks
    // — those are the parent's continuation text, not sub-agent work.
    const childIndices: number[] = [];
    for (let j = i + 1; j < msgs.length; j++) {
      const child = msgs[j];
      if (child.role === "user") break;

      if (hasResult) {
        const INTERACTIVE_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"]);
        const toolUseBlocks = child.content.filter((b) => b.type === "tool_use");
        const childHasToolUse = toolUseBlocks.length > 0;
        if (!childHasToolUse) break; // parent's continuation (text/thinking only)
        // If the only tool_use blocks are interactive tools (ExitPlanMode / AskUserQuestion),
        // this message belongs to the parent, not the sub-agent — stop collecting.
        const allInteractive = toolUseBlocks.every((b) => INTERACTIVE_TOOLS.has(b.name || ""));
        if (allInteractive) break;
      }

      childIndices.push(j);
      hidden.add(j);
    }

    if (childIndices.length > 0) {
      runs.set(i, { agentMsgIndex: i, agentBlock, childIndices, hasResult });
    }
  }

  return { runs, hidden };
}

/** Build a tool name breakdown like "Read x3 / Glob x2 / Bash x1" */
function toolBreakdown(blocks: ContentBlock[]): string {
  const counts = new Map<string, number>();
  for (const b of blocks) {
    const name = b.name || "Tool";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => `${name} x${count}`)
    .join(" / ");
}

/** Collapsible container for an Agent tool call and all its cross-message children */
const AgentRunContainer = memo(function AgentRunContainer({
  agentBlock,
  childMessages,
  isStreaming,
  hasResult,
  pendingInteraction,
  onRespond,
}: {
  agentBlock: ContentBlock;
  childMessages: ChatMessage[];
  isStreaming: boolean;
  hasResult: boolean;
  pendingInteraction?: PendingInteraction | null;
  onRespond?: (response: Record<string, unknown>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();
  const input = agentBlock.input || {};
  const description = String(input.description || input.prompt || "Agent").slice(0, 60);

  // Collect all tool_use blocks from children
  const toolBlocks: ContentBlock[] = [];
  const resultMap = new Map<string, ContentBlock>();

  for (const msg of childMessages) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolBlocks.push(block);
      } else if (block.type === "tool_result" && block.tool_use_id) {
        resultMap.set(block.tool_use_id, block);
      }
    }
  }

  // Only search/read tools stay collapsed; everything else is elevated (shown outside)
  const COLLAPSIBLE_TOOLS = new Set(["Read", "Glob", "Grep", "Bash"]);
  const elevatedBlocks: ContentBlock[] = [];
  const collapsibleBlocks: ContentBlock[] = [];
  for (const block of toolBlocks) {
    if (COLLAPSIBLE_TOOLS.has(block.name || "")) {
      collapsibleBlocks.push(block);
    } else {
      elevatedBlocks.push(block);
    }
  }

  const isDone = hasResult || !isStreaming;

  // Find currently running tool in the collapsed section
  let runningLabel = "";
  if (!isDone) {
    for (let i = collapsibleBlocks.length - 1; i >= 0; i--) {
      const tb = collapsibleBlocks[i];
      if (tb.id && !resultMap.has(tb.id)) {
        const name = tb.name || "Tool";
        const inp = tb.input || {};
        if (name === "Read") runningLabel = `Read: ${String(inp.file_path || "").split("/").pop()}`;
        else if (name === "Bash") runningLabel = String(inp.description || "") || String(inp.command || "").slice(0, 40);
        else if (name === "Glob") runningLabel = `Glob: ${String(inp.pattern || "")}`;
        else if (name === "Grep") runningLabel = `Grep: ${String(inp.pattern || "")}`;
        else runningLabel = name;
        break;
      }
    }
  }

  const breakdown = collapsibleBlocks.length > 0 ? toolBreakdown(collapsibleBlocks) : "";

  return (
    <>
      {/* Collapsible section: only Read/Glob/Grep/Bash */}
      {collapsibleBlocks.length > 0 && (
        <div className="flex justify-start px-4 mb-0.5">
          <div className="flex items-start gap-2.5 max-w-[90%] min-w-0">
            <div className="flex-shrink-0 w-7" />
            <div className="min-w-0 flex-1">
              <div className="rounded-lg border border-border bg-tool-bg overflow-hidden">
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-bg-secondary/50 transition-colors"
                >
                  {expanded ? (
                    <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
                  ) : (
                    <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
                  )}
                  {isDone ? (
                    <>
                      <CheckCircle size={13} className="text-success flex-shrink-0" />
                      <span className="text-text-secondary text-xs text-left truncate">
                        {description}
                      </span>
                      {breakdown && (
                        <span className="text-text-muted text-[11px] flex-shrink-0">
                          {breakdown}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <Loader2 size={13} className="animate-spin text-accent flex-shrink-0" />
                      <span className="text-text-secondary text-xs text-left truncate">
                        {runningLabel || description}
                      </span>
                      {breakdown && (
                        <span className="text-text-muted text-[11px] flex-shrink-0">
                          {breakdown}
                        </span>
                      )}
                      {!expanded && elevatedBlocks.length === 0 && (
                        <span className="text-text-muted/50 text-[11px] flex-shrink-0">
                          {t("tool.clickToExpand")}
                        </span>
                      )}
                    </>
                  )}
                </button>
                {expanded && (
                  <div className="px-2 pb-2 space-y-1 border-t border-border pt-1">
                    {collapsibleBlocks.map((block) => {
                      const result = block.id ? resultMap.get(block.id) : undefined;
                      return (
                        <ToolCallCard
                          key={block.id || `tool-${block.name}`}
                          block={block}
                          result={result}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Render elevated tools (write, interactive, etc.) OUTSIDE the collapsible container */}
      {elevatedBlocks.map((block) => (
        <div key={block.id || `elevated-${block.name}`} className="flex justify-start px-4 mb-0.5">
          <div className="flex items-start gap-2.5 max-w-[90%] min-w-0">
            <div className="flex-shrink-0 w-7" />
            <div className="min-w-0 flex-1">
              <ToolCallCard
                block={block}
                result={block.id ? resultMap.get(block.id) : undefined}
                pendingInteraction={pendingInteraction}
                onRespond={onRespond}
              />
            </div>
          </div>
        </div>
      ))}
    </>
  );
});

/** Branch dropdown switcher */
function BranchSwitcher({
  branch,
  projectPath,
  onBranchChange,
}: {
  branch: string;
  projectPath: string;
  onBranchChange: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleOpen = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }
    try {
      const list = await listGitBranches(projectPath);
      // Put current branch first
      const sorted = [branch, ...list.filter((b) => b !== branch)];
      setBranches(sorted);
    } catch {
      setBranches([branch]);
    }
    setOpen(true);
  }, [open, projectPath, branch]);

  const handleSwitch = useCallback(async (target: string) => {
    if (target === branch) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      await checkoutGitBranch(projectPath, target);
      onBranchChange(target);
    } catch (e) {
      console.error("Branch checkout failed:", e);
    } finally {
      setSwitching(false);
      setOpen(false);
    }
  }, [branch, projectPath, onBranchChange]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); handleOpen(); }}
        disabled={switching}
        className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full
                   bg-bg-tertiary text-text-muted hover:text-text-primary hover:bg-bg-tertiary/80
                   transition-colors max-w-[180px] cursor-pointer"
        title={t("branch.switch")}
      >
        {switching ? (
          <Loader2 size={11} className="flex-shrink-0 animate-spin" />
        ) : (
          <GitBranch size={11} className="flex-shrink-0" />
        )}
        <span className="truncate">{branch}</span>
        <ChevronDown size={10} className="flex-shrink-0 opacity-50" />
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 min-w-[160px] max-w-[260px] max-h-[240px]
                        overflow-y-auto rounded-lg bg-bg-secondary border border-border shadow-xl z-50 py-1">
          {branches.map((b) => (
            <button
              key={b}
              onClick={(e) => { e.stopPropagation(); handleSwitch(b); }}
              className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors truncate
                ${b === branch
                  ? "text-accent bg-accent/10"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/30"
                }`}
            >
              {b === branch && <Check size={10} className="flex-shrink-0" />}
              <span className="truncate">{b}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 返回"倒数第 showLastN 轮对话"的起始消息索引（以 user 消息为轮次起点） */
function getTurnStartIndex(messages: ChatMessage[], showLastN: number): number {
  let turnsFound = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      turnsFound++;
      if (turnsFound >= showLastN) return i;
    }
  }
  return 0;
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
    clearMessages,
  } = useChatStore();

  const { settings } = useSettingsStore();
  const { markAllCompleted } = useTaskStore();
  const t = useT();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const msgScrollRef = useRef<HTMLDivElement>(null);
  const loadingMoreTurns = useRef(false);
  const prevScrollHeight = useRef(0);
  const lastScrollTop = useRef(0);
  const overscrollRef = useRef(0);
  const resetPullTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const isStreaming = currentSessionId ? !!streamingSessions[currentSessionId] : false;
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [visibleTurns, setVisibleTurns] = useState(3);
  const [pullProgress, setPullProgress] = useState(0);   // 0–1，下拉进度
  const [pullTriggered, setPullTriggered] = useState(false); // 已触发，展示全速转圈
  const [showFilePanel, setShowFilePanel] = useState(false);
  // Per-session viewer state: each session independently remembers its open files,
  // active tab, and whether the viewer is minimized.
  const [sessionViewerStates, setSessionViewerStates] = useState<
    Record<string, { files: string[]; activeIndex: number; minimized: boolean }>
  >({});
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set());
  const [fileTreeRefreshKey, setFileTreeRefreshKey] = useState(0);
  const toolNameMapRef = useRef<Map<string, string>>(new Map());

  // Derive current session's viewer state
  const currentViewerState = currentSessionId
    ? (sessionViewerStates[currentSessionId] ?? { files: [], activeIndex: 0, minimized: false })
    : { files: [], activeIndex: 0, minimized: false };
  const openFiles = currentViewerState.files;
  const activeFileIndex = currentViewerState.activeIndex;
  const isViewerMinimized = currentViewerState.minimized;

  const updateViewerState = useCallback(
    (updates: Partial<{ files: string[]; activeIndex: number; minimized: boolean }>) => {
      if (!currentSessionId) return;
      setSessionViewerStates((prev) => {
        const existing = prev[currentSessionId] ?? { files: [], activeIndex: 0, minimized: false };
        return { ...prev, [currentSessionId]: { ...existing, ...updates } };
      });
    },
    [currentSessionId]
  );

  const FILE_PANEL_WIDTH = 256; // w-64，CSS 逻辑像素

  const toggleFilePanel = useCallback(async () => {
    const next = !showFilePanel;
    setShowFilePanel(next);
    if (!next) { updateViewerState({ files: [], activeIndex: 0, minimized: false }); }
    try {
      const win = getCurrentWindow();
      const [size, scale] = await Promise.all([win.outerSize(), win.scaleFactor()]);
      // 用 scaleFactor 将逻辑像素转换为物理像素，避免 Retina 屏扩展不足
      const delta = Math.round(FILE_PANEL_WIDTH * scale);
      await win.setSize(new PhysicalSize(size.width + (next ? delta : -delta), size.height));
    } catch {
      // dev 环境 window API 不可用时忽略
    }
  }, [showFilePanel, updateViewerState]);

  // 切换 session 时重置可见轮次
  useEffect(() => {
    setVisibleTurns(3);
    lastScrollTop.current = 0;
    overscrollRef.current = 0;
    setPullProgress(0);
    setPullTriggered(false);
  }, [currentSessionId]);

  // Fetch git branch when session changes
  useEffect(() => {
    setGitBranch(null);
    if (currentSession?.projectPath) {
      getGitBranch(currentSession.projectPath)
        .then((branch) => setGitBranch(branch))
        .catch(() => setGitBranch(null));
    }
  }, [currentSession?.projectPath]);

  // Fetch git diff files when file panel is open, refresh every 5s
  useEffect(() => {
    if (!showFilePanel || !currentSession?.projectPath) {
      setChangedFiles(new Set());
      return;
    }
    const path = currentSession.projectPath;
    const refresh = () => {
      gitDiffFiles(path)
        .then((files) => setChangedFiles(new Set(files)))
        .catch(() => setChangedFiles(new Set()));
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [showFilePanel, currentSession?.projectPath]);

  useEffect(() => {
    const unlisten = onStream((payload) => {
      if (payload.done) {
        handleStreamDone(payload.session_id, payload.error ?? undefined);
        markAllCompleted(payload.session_id);
        setFileTreeRefreshKey((k) => k + 1);
      } else if (payload.data) {
        handleStreamData(payload.session_id, payload.data, payload.stream);
        // Track tool_use ids → names, refresh tree on file-modifying tool results
        try {
          const msg = JSON.parse(payload.data) as { type: string; message?: { content?: Array<{ type: string; id?: string; name?: string; tool_use_id?: string }> } };
          if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === "tool_use" && block.id && block.name) {
                toolNameMapRef.current.set(block.id, block.name);
              }
            }
          } else if (msg.type === "user" && msg.message?.content) {
            const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "Bash"]);
            const hasFileOp = msg.message.content.some(
              (block) => block.type === "tool_result" && block.tool_use_id &&
                FILE_TOOLS.has(toolNameMapRef.current.get(block.tool_use_id) ?? "")
            );
            if (hasFileOp) setFileTreeRefreshKey((k) => k + 1);
          }
        } catch { /* ignore parse errors */ }
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [handleStreamData, handleStreamDone, markAllCompleted]);

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
      handleStreamDone(currentSessionId);
      addSystemMessage(currentSessionId, "__stopped__");
    }
  }, [currentSessionId, addSystemMessage, handleStreamDone]);

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
    setShowNewSessionDialog(true);
  }, []);

  const handleNewSessionConfirm = useCallback((clearHistory: boolean) => {
    setShowNewSessionDialog(false);
    if (!currentSessionId) return;
    clearClaudeSession(currentSessionId);
    clearSessionResume(currentSessionId).catch(() => {});
    if (clearHistory) {
      clearMessages(currentSessionId);
      addSystemMessage(currentSessionId, t("chat.historyCleared"));
    } else {
      addSystemMessage(currentSessionId, t("chat.sessionCleared"));
    }
  }, [currentSessionId, clearClaudeSession, clearMessages, addSystemMessage, t]);

  const handleOpenTerminal = useCallback(() => {
    if (currentSession?.projectPath) {
      openInTerminal(currentSession.projectPath).catch(console.error);
    }
  }, [currentSession?.projectPath]);

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

  // 分轮分页：计算起始索引
  const msgStartIndex = useMemo(
    () => getTurnStartIndex(currentMessages, visibleTurns),
    [currentMessages, visibleTurns]
  );
  const hasMoreTurns = msgStartIndex > 0;

  // 加载更多轮次，并恢复滚动位置避免跳动
  const loadMoreTurns = useCallback(() => {
    const el = msgScrollRef.current;
    if (!el) return;
    loadingMoreTurns.current = true;
    prevScrollHeight.current = el.scrollHeight;
    setVisibleTurns((n) => n + 3);
  }, []);

  // 下拉加载：滚轮在顶部向上滚时累积进度，到阈值后触发
  const PULL_THRESHOLD = 180; // wheel delta 累积阈值
  const handleMsgWheel = useCallback((e: React.WheelEvent) => {
    const el = msgScrollRef.current;
    if (!el || !hasMoreTurns || loadingMoreTurns.current || pullTriggered) return;

    if (el.scrollTop === 0 && e.deltaY < 0) {
      overscrollRef.current = Math.min(PULL_THRESHOLD, overscrollRef.current + Math.abs(e.deltaY));
      const progress = overscrollRef.current / PULL_THRESHOLD;
      setPullProgress(progress);

      if (overscrollRef.current >= PULL_THRESHOLD) {
        // 触发：展示全速转圈，短暂延迟后加载
        overscrollRef.current = 0;
        setPullTriggered(true);
        setPullProgress(1);
        setTimeout(() => {
          loadMoreTurns();
          setPullTriggered(false);
          setPullProgress(0);
        }, 400);
        return;
      }

      // 停止滚动后复位进度
      if (resetPullTimer.current) clearTimeout(resetPullTimer.current);
      resetPullTimer.current = setTimeout(() => {
        overscrollRef.current = 0;
        setPullProgress(0);
      }, 300);
    }
  }, [hasMoreTurns, pullTriggered, loadMoreTurns]);

  // onScroll 仅用于更新 lastScrollTop（不再负责触发加载）
  const handleMsgScroll = useCallback(() => {
    const el = msgScrollRef.current;
    if (!el) return;
    lastScrollTop.current = el.scrollTop;
  }, []);

  // 加载更多后恢复滚动位置
  useLayoutEffect(() => {
    if (loadingMoreTurns.current && msgScrollRef.current) {
      const el = msgScrollRef.current;
      el.scrollTop = el.scrollHeight - prevScrollHeight.current;
      loadingMoreTurns.current = false;
    }
  });

  // Detect Agent runs that span multiple messages
  const { runs: agentRuns, hidden: hiddenIndices } = useMemo(
    () => detectAgentRuns(currentMessages),
    [currentMessages]
  );

  // Compute total tokens for the current turn (all assistant messages after last user message)
  const totalTokens = (() => {
    let tokens = 0;
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const m = currentMessages[i];
      if (m.role === "user") break;
      if (m.role === "assistant" && m.usage) {
        tokens += (m.usage.input_tokens || 0)
          + (m.usage.output_tokens || 0)
          + (m.usage.cache_creation_input_tokens || 0)
          + (m.usage.cache_read_input_tokens || 0);
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
    <>
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
        {/* File preview indicator — toggle minimize/restore */}
        {openFiles.length > 0 && (
          <button
            onClick={() => updateViewerState({ minimized: !isViewerMinimized })}
            className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full
                       bg-accent/15 text-accent hover:bg-accent/25 transition-colors flex-shrink-0"
            title={isViewerMinimized ? t("viewer.restore") : t("viewer.minimize")}
          >
            <FileText size={11} />
            <span>{openFiles.length}</span>
          </button>
        )}
        <div className="flex-1 pointer-events-none" />
        {gitBranch && currentSession?.projectPath && (
          <BranchSwitcher
            branch={gitBranch}
            projectPath={currentSession.projectPath}
            onBranchChange={setGitBranch}
          />
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
          {openFiles.length > 0 && !isViewerMinimized ? (
            /* Tabbed file viewer — covers entire chat area for maximum reading space */
            <FileViewer
              files={openFiles}
              activeIndex={activeFileIndex}
              changedFiles={changedFiles}
              onSelectTab={(i) => updateViewerState({ activeIndex: i })}
              onCloseTab={(index) => {
                const next = openFiles.filter((_, i) => i !== index);
                let nextActive = activeFileIndex;
                if (next.length === 0) {
                  nextActive = 0;
                } else if (activeFileIndex >= next.length) {
                  nextActive = next.length - 1;
                } else if (index < activeFileIndex) {
                  nextActive = activeFileIndex - 1;
                }
                updateViewerState({ files: next, activeIndex: nextActive });
              }}
              onCloseAll={() => updateViewerState({ files: [], activeIndex: 0, minimized: false })}
              onMinimize={() => updateViewerState({ minimized: true })}
            />
          ) : (
            /* Messages */
            <div ref={msgScrollRef} onScroll={handleMsgScroll} onWheel={handleMsgWheel} className="flex-1 overflow-y-auto pt-4 pb-2">
              <div className="max-w-3xl mx-auto overflow-hidden">
                {/* 下拉加载指示器 */}
                {hasMoreTurns && pullProgress > 0 && (
                  <div
                    className="flex justify-center pb-2 transition-all duration-150"
                    style={{ opacity: pullProgress }}
                  >
                    <Loader2
                      size={16}
                      className={`text-accent ${pullTriggered ? "animate-spin" : ""}`}
                      style={!pullTriggered ? { transform: `rotate(${pullProgress * 360}deg)` } : undefined}
                    />
                  </div>
                )}
                {/* 点击加载更多按钮 */}
                {hasMoreTurns && pullProgress === 0 && (
                  <div className="text-center pb-3">
                    <button
                      onClick={loadMoreTurns}
                      className="text-sm font-semibold text-text-muted/60 hover:text-text-muted transition-colors px-3 py-1 rounded-full hover:bg-bg-tertiary/30"
                    >
                      ↑ 查看更早的对话
                    </button>
                  </div>
                )}
                {currentMessages.length === 0 && (
                  <div className="text-center py-16 text-text-muted">
                    <Terminal size={24} className="mx-auto mb-2 opacity-50" />
                    <p className="text-sm">
                      {t("chat.emptyHint")}
                    </p>
                  </div>
                )}
                {currentMessages.map((msg, i) => {
                  // 分页：只渲染 msgStartIndex 之后的消息
                  if (i < msgStartIndex) return null;
                  // Skip messages that are part of an Agent run (rendered inside AgentRunContainer)
                  if (hiddenIndices.has(i)) return null;

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

                  // If this message starts an Agent run, render the container
                  const agentRun = agentRuns.get(i);

                  return (
                    <React.Fragment key={msg.id}>
                      <MessageBubble
                        message={msg}
                        allMessages={currentMessages}
                        messageIndex={i}
                        showAvatar={showAvatar}
                        isLastInTurn={!agentRun && isLastInTurn}
                        isLastAssistant={isLastAssistant}
                        totalTokens={totalTokens}
                        streamStartTime={streamStartTime}
                        pendingInteraction={isLastAssistant ? pendingInteraction : undefined}
                        onRespond={isLastAssistant ? handleRespond : undefined}
                        skipAgentBlockId={agentRun?.agentBlock.id}
                      />
                      {agentRun && (
                        <AgentRunContainer
                          agentBlock={agentRun.agentBlock}
                          childMessages={agentRun.childIndices.map((j) => currentMessages[j])}
                          isStreaming={isStreaming}
                          hasResult={agentRun.hasResult}
                          pendingInteraction={isLastAssistant ? pendingInteraction : undefined}
                          onRespond={isLastAssistant ? handleRespond : undefined}
                        />
                      )}
                    </React.Fragment>
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
          )}

          {/* Task Board (above input) */}
          <TaskBoard sessionId={currentSessionId} />

          {/* Input — always mounted outside the viewer/messages toggle so draft text is preserved */}
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
            projectPath={currentSession?.projectPath}
            onBranchChange={setGitBranch}
            onOpenTerminal={handleOpenTerminal}
            allowedTools={currentSession?.allowedTools || []}
            onAllowedToolsChange={handleAllowedToolsChange}
            hasClaudeSession={!!currentSession?.claudeSessionId}
            onClearSession={handleClearSession}
          />
        </div>

        {/* File panel — tree only, viewer is shown in the chat area */}
        {showFilePanel && currentSession?.projectPath && (
          <div className="w-64 border-l border-border bg-bg-secondary flex-shrink-0">
            <FileTree rootPath={currentSession.projectPath} changedFiles={changedFiles} refreshKey={fileTreeRefreshKey} onFileSelect={(path) => {
              const existing = openFiles.indexOf(path);
              if (existing >= 0) {
                updateViewerState({ activeIndex: existing, minimized: false });
              } else {
                updateViewerState({ files: [...openFiles, path], activeIndex: openFiles.length, minimized: false });
              }
            }} />
          </div>
        )}
      </div>
    </div>

    <NewSessionDialog
      open={showNewSessionDialog}
      onConfirm={handleNewSessionConfirm}
      onCancel={() => setShowNewSessionDialog(false)}
    />
    </>
  );
}

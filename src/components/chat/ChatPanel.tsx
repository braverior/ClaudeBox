import React, { useEffect, useRef, useCallback, useState, useMemo, memo, useLayoutEffect } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTaskStore } from "../../stores/taskStore";
import { sendMessage, stopSession, onStream, getGitBranch, listGitBranches, checkoutGitBranch, sendResponse, openInTerminal, gitDiffFiles, gitDiffStat, getContextTokens } from "../../lib/claude-ipc";
import { larkSendCommand } from "../../lib/lark-ipc";
import { useLarkStore } from "../../stores/larkStore";
import { resolveModelCreds } from "../../lib/providers";
import { getCurrentWindow, currentMonitor, LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { useT } from "../../lib/i18n";
import { startWindowDrag, handleTitleBarDoubleClick, isWindows, formatRelativeDate } from "../../lib/utils";
import WindowControls from "../WindowControls";
import MessageBubble from "./MessageBubble";
import ToolCallCard from "./ToolCallCard";
import InputArea, { type Attachment } from "./InputArea";
import TaskBoard from "./TaskBoard";
import FileTree from "./FileTree";
import FileViewer from "./FileViewer";
import { Sparkles, FolderOpen, Terminal, GitBranch, PanelRightClose, PanelRight, ChevronDown, ChevronRight, Loader2, CheckCircle, Check, FileText, ShieldAlert, ShieldCheck, Edit3, MessageSquare, Plus, Trash2 } from "lucide-react";
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
    // When the Agent is done (hasResult), use the recorded child count to avoid
    // absorbing the parent's continuation messages as sub-agent children.
    const childIndices: number[] = [];
    const maxChildren = hasResult ? (msg.agentChildCount ?? Infinity) : Infinity;
    for (let j = i + 1; j < msgs.length; j++) {
      const child = msgs[j];
      if (child.role === "user") break;
      if (childIndices.length >= maxChildren) break;

      if (hasResult && maxChildren === Infinity) {
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
}: {
  agentBlock: ContentBlock;
  childMessages: ChatMessage[];
  isStreaming: boolean;
  hasResult: boolean;
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
              />
            </div>
          </div>
        </div>
      ))}
    </>
  );
});

/** Inline permission card shown when Claude tries to use a tool not in the auto-approve list */
function ToolPermissionCard({
  interaction,
  onRespond,
}: {
  interaction: PendingInteraction;
  onRespond: (response: Record<string, unknown>) => void;
}) {
  const t = useT();
  const toolName = interaction.toolName || "Unknown";
  const toolInput = interaction.toolInput || {};

  const inputSummary = (() => {
    if (toolName === "Bash" && toolInput.command) return String(toolInput.command).slice(0, 120);
    if (toolName === "Read" && toolInput.file_path) return String(toolInput.file_path);
    if (toolName === "Write" && toolInput.file_path) return String(toolInput.file_path);
    if (toolName === "Edit" && toolInput.file_path) return String(toolInput.file_path);
    if (toolName === "Glob" && toolInput.pattern) return String(toolInput.pattern);
    if (toolName === "Grep" && toolInput.pattern) return String(toolInput.pattern);
    if (toolName === "WebFetch" && toolInput.url) return String(toolInput.url);
    if (toolName === "WebSearch" && toolInput.query) return String(toolInput.query);
    if (toolInput.description) return String(toolInput.description).slice(0, 100);
    return "";
  })();

  return (
    <div className="max-w-3xl mx-auto px-4 mb-3">
      <div className="rounded-lg border border-warning/40 bg-warning/5 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-warning/20">
          <ShieldAlert size={15} className="text-warning flex-shrink-0" />
          <span className="text-sm font-medium text-text-primary">
            {t("tool.permissionRequired", { tool: toolName })}
          </span>
        </div>
        {inputSummary && (
          <div className="px-4 py-2 text-xs text-text-secondary font-mono bg-bg-secondary/30 border-b border-warning/10 truncate">
            {inputSummary}
          </div>
        )}
        <div className="flex items-center gap-2 px-4 py-2.5">
          <button
            onClick={() => onRespond({ type: "response", requestId: interaction.requestId, behavior: "allow" })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                       bg-success/15 text-success hover:bg-success/25 transition-colors cursor-pointer"
          >
            <ShieldCheck size={13} />
            {t("tool.allow")}
          </button>
          <button
            onClick={() => onRespond({ type: "response", requestId: interaction.requestId, behavior: "deny", message: "User denied tool use" })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                       bg-error/10 text-error hover:bg-error/20 transition-colors cursor-pointer"
          >
            {t("tool.deny")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Combined branch switcher + aggregate diff stats badge.
 *  Left half opens the branch dropdown; right half (when there are uncommitted changes)
 *  opens the global GitDiffDialog. The two sit inside a single rounded-full pill. */
function BranchDiffBadge({
  branch,
  projectPath,
  sessionId,
  isStreaming,
  onBranchChange,
}: {
  branch: string;
  projectPath: string;
  sessionId: string;
  isStreaming: boolean;
  onBranchChange: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ added: number; removed: number; files: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  const openDiffDialog = useChatStore((s) => s.openDiffDialog);

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
    setError(null);
    try {
      const list = await listGitBranches(projectPath);
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
    setError(null);
    try {
      await checkoutGitBranch(projectPath, target);
      onBranchChange(target);
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSwitching(false);
    }
  }, [branch, projectPath, onBranchChange]);

  const refreshStats = useCallback(async () => {
    try {
      const s = await gitDiffStat(projectPath);
      setStats(s);
      console.log("[BranchDiffBadge] stats refreshed", { projectPath, ...s });
    } catch (e) {
      console.warn("[BranchDiffBadge] gitDiffStat failed", { projectPath, error: e });
      setStats(null);
    }
  }, [projectPath]);

  useEffect(() => {
    console.log("[BranchDiffBadge] mounted", { projectPath, branch });
    return () => console.log("[BranchDiffBadge] unmounted", { projectPath });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshStats();
  }, [refreshStats, branch]);

  // Refresh once streaming finishes — Claude has likely just touched files.
  const wasStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) refreshStats();
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, refreshStats]);

  // Periodic poll — picks up changes made outside the app (terminal vim, git checkout, etc.)
  useEffect(() => {
    const id = window.setInterval(refreshStats, 10000);
    return () => window.clearInterval(id);
  }, [refreshStats]);

  // Refresh on window focus — instant sync when switching back from terminal/editor.
  useEffect(() => {
    const handler = () => refreshStats();
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [refreshStats]);

  const hasStats = !!stats && (stats.added > 0 || stats.removed > 0 || stats.files > 0);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <div className="flex items-stretch text-xs rounded-full bg-bg-tertiary overflow-hidden max-w-[280px]">
        {hasStats && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); openDiffDialog(sessionId); }}
              className="flex items-center gap-1 px-2 py-0.5 hover:bg-bg-tertiary/60
                         transition-colors flex-shrink-0 tabular-nums cursor-pointer"
              title={t("session.viewDiff")}
            >
              <Edit3 size={11} className="flex-shrink-0 text-text-muted" />
              <span className={stats!.added > 0 ? "text-success" : "text-text-muted/60"}>+{stats!.added}</span>
              <span className={stats!.removed > 0 ? "text-error" : "text-text-muted/60"}>-{stats!.removed}</span>
            </button>
            <span className="self-stretch w-px bg-border/50 flex-shrink-0" />
          </>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); handleOpen(); }}
          disabled={switching}
          className="flex items-center gap-1 px-2 py-0.5 text-text-muted
                     hover:text-text-primary hover:bg-bg-tertiary/60 transition-colors
                     min-w-0 cursor-pointer"
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
      </div>
      {open && (
        <div className="absolute top-full right-0 mt-1 min-w-[180px] max-w-[280px] max-h-[240px]
                        overflow-y-auto rounded-lg bg-bg-secondary border border-border shadow-xl z-50 py-1">
          {error && (
            <p className="px-3 py-1.5 text-[10px] text-error border-b border-border">{error}</p>
          )}
          {branches.map((b) => {
            const isCurrent = b === branch;
            return (
              <button
                key={b}
                onClick={(e) => { e.stopPropagation(); handleSwitch(b); }}
                className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors
                  ${isCurrent
                    ? "text-accent bg-accent/10"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50"
                  }`}
              >
                {isCurrent
                  ? <Check size={10} className="flex-shrink-0" />
                  : <span className="w-[10px] flex-shrink-0" />
                }
                <span className="truncate flex-1 min-w-0">{b}</span>
                {isCurrent && hasStats && (
                  <span className="flex items-center gap-1 flex-shrink-0 tabular-nums">
                    <span className={stats!.added > 0 ? "text-success" : "text-text-muted/60"}>+{stats!.added}</span>
                    <span className={stats!.removed > 0 ? "text-error" : "text-text-muted/60"}>-{stats!.removed}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Header dropdown to switch between / create sessions within the current
 *  project. Sessions are Claude Code transcripts under the same project dir. */
function SessionSwitcher({
  projectPath,
  currentSessionId,
}: {
  projectPath: string;
  currentSessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  const sessions = useChatStore((s) => s.sessions);
  const switchSession = useChatStore((s) => s.switchSession);
  const createProjectSession = useChatStore((s) => s.createProjectSession);
  const removeSession = useChatStore((s) => s.removeSession);
  const streamingSessions = useChatStore((s) => s.streamingSessions);
  const settings = useSettingsStore((s) => s.settings);

  const projectSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.projectPath === projectPath)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [sessions, projectPath]
  );
  const current = projectSessions.find((s) => s.id === currentSessionId);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleNew = useCallback(() => {
    setOpen(false);
    createProjectSession(
      projectPath,
      settings.defaultModel || settings.model || current?.model || "",
      current?.permissionMode || settings.permissionMode || ""
    );
  }, [createProjectSession, projectPath, settings, current]);

  const handlePick = useCallback(
    (id: string) => {
      setOpen(false);
      if (id !== currentSessionId) switchSession(id);
    },
    [currentSessionId, switchSession]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      if (!window.confirm(t("session.deleteConfirm"))) return;
      removeSession(id);
    },
    [removeSession, t]
  );

  // 收起态只显示通用「会话列表」标签(不用当前会话标题——标题可能是很长的 URL);
  // 具体会话标题在展开的下拉里看。
  const label = t("session.list");

  return (
    <div ref={ref} className="relative flex-shrink-0 min-w-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="flex items-center gap-1 max-w-[240px] px-2 py-0.5 rounded-full bg-bg-tertiary
                   text-xs text-text-muted hover:text-text-primary hover:bg-bg-tertiary/60
                   transition-colors cursor-pointer"
        title={t("session.switch")}
      >
        <MessageSquare size={11} className="flex-shrink-0" />
        <span className="truncate">{label}</span>
        {projectSessions.length > 1 && (
          <span className="flex-shrink-0 opacity-60">({projectSessions.length})</span>
        )}
        <ChevronDown size={10} className="flex-shrink-0 opacity-50" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[240px] max-w-[340px] max-h-[340px]
                        overflow-y-auto rounded-lg bg-bg-secondary border border-border shadow-xl z-50 py-1">
          <button
            onClick={(e) => { e.stopPropagation(); handleNew(); }}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs text-accent
                       hover:bg-accent/10 transition-colors"
          >
            <Plus size={12} className="flex-shrink-0" />
            <span>{t("session.newSession")}</span>
          </button>
          <div className="my-1 border-t border-border" />
          {projectSessions.map((s) => {
            const isCurrent = s.id === currentSessionId;
            const isRunning = !!streamingSessions[s.id];
            return (
              <div
                key={s.id}
                onClick={() => handlePick(s.id)}
                className={`group/item flex items-center gap-2 w-full px-3 py-1.5 text-xs cursor-pointer transition-colors
                  ${isCurrent
                    ? "text-accent bg-accent/10"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50"
                  }`}
              >
                {isCurrent
                  ? <Check size={10} className="flex-shrink-0" />
                  : <span className="w-[10px] flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="truncate">{s.title || t("session.untitled")}</div>
                  <div className="text-[10px] text-text-muted">{formatRelativeDate(s.updatedAt)}</div>
                </div>
                {isRunning && <Loader2 size={10} className="flex-shrink-0 animate-spin text-accent" />}
                <button
                  onClick={(e) => handleDelete(e, s.id)}
                  className="flex-shrink-0 opacity-0 group-hover/item:opacity-100 p-0.5 rounded
                             text-text-muted hover:text-error transition-all"
                  title={t("session.delete")}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            );
          })}
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
    messageQueue,
    streamError,
    streamStartTimes,
    pendingInteractions,
    addUserMessage,
    addSystemMessage,
    addLaunchMessage,
    handleStreamData,
    handleStreamDone,
    setStreaming,
    clearError,
    updateSession,
    clearPendingInteraction,
    createProjectSession,
    enqueueMessage,
    removeQueuedMessage,
    popQueuedMessage,
    clearMessageQueue,
    inputDrafts,
    saveInputDraft,
  } = useChatStore();

  const { settings } = useSettingsStore();
  const { markAllCompleted } = useTaskStore();
  const t = useT();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const msgScrollRef = useRef<HTMLDivElement>(null);
  const loadingMoreTurns = useRef(false);
  const prevScrollHeight = useRef(0);
  const lastScrollTop = useRef(0);
  const stickToBottom = useRef(true);
  // 程序化 pin 期间置真，屏蔽由此触发的 scroll 事件，避免误判"用户上滑"
  const pinningRef = useRef(false);
  const msgContentObserver = useRef<ResizeObserver | null>(null);
  const overscrollRef = useRef(0);
  const resetPullTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const isStreaming = currentSessionId ? !!streamingSessions[currentSessionId] : false;
  const pendingInteraction = currentSessionId ? pendingInteractions[currentSessionId] : undefined;
  const [gitBranch, setGitBranch] = useState<string | null>(null);

  // ── Diagnostic: log every render to confirm the latest bundle is loaded ──
  console.log("[ChatPanel] render", {
    currentSessionId,
    projectPath: currentSession?.projectPath,
    gitBranch,
    badgeShouldRender: !!(gitBranch && currentSession?.projectPath && currentSessionId),
  });
  const [visibleTurns, setVisibleTurns] = useState(3);
  const [pullProgress, setPullProgress] = useState(0);   // 0–1，下拉进度
  const [pullTriggered, setPullTriggered] = useState(false); // 已触发，展示全速转圈
  const [showFilePanel, setShowFilePanel] = useState(false);
  // Per-session viewer state: each session independently remembers its open files,
  // active tab, and whether the viewer is minimized.
  const [sessionViewerStates, setSessionViewerStates] = useState<
    Record<string, { files: string[]; activeIndex: number; minimized: boolean }>
  >({});
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set());
  const [contextTokensCache, setContextTokensCache] = useState<Record<string, number>>({});
  const [fileTreeRefreshKey, setFileTreeRefreshKey] = useState(0);
  const [injectedDraft, setInjectedDraft] = useState<{ content: string; nonce: number } | null>(null);
  const [injectedAttachment, setInjectedAttachment] = useState<{ path: string; isDir?: boolean; nonce: number } | null>(null);
  const toolNameMapRef = useRef<Map<string, string>>(new Map());

  const handleResendToInput = useCallback((text: string) => {
    setInjectedDraft({ content: text, nonce: Date.now() });
  }, []);

  const handleAddFileToChat = useCallback((path: string, isDir: boolean) => {
    setInjectedAttachment({ path, isDir, nonce: Date.now() });
  }, []);

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
  // Must match tauri.conf.json → app.windows[0].minWidth/minHeight. When the
  // file panel opens we raise the minimum so the user can't shrink the window
  // back into a state where the panel squashes the chat area.
  const BASE_MIN_WIDTH = 1000;
  const BASE_MIN_HEIGHT = 600;

  // 文件树展开/收起是改变窗口尺寸的唯一入口（见 toggleFilePanel）。
  // 地板宽度由 OS 通过 setMinSize 强制执行：文件树打开时抬到 1256，关闭时
  // 降回 1000。系统会在拖拽时硬性挡住，因此不需要 resize 监听去"纠正"尺寸。
  const toggleFilePanel = useCallback(async () => {
    const next = !showFilePanel;
    setShowFilePanel(next);
    if (!next) { updateViewerState({ files: [], activeIndex: 0, minimized: false }); }
    try {
      const win = getCurrentWindow();
      const [size, scale, position, monitor] = await Promise.all([
        win.outerSize(),
        win.scaleFactor(),
        win.outerPosition(),
        currentMonitor(),
      ]);
      // 用 scaleFactor 将逻辑像素转换为物理像素，避免 Retina 屏扩展不足
      const delta = Math.round(FILE_PANEL_WIDTH * scale);
      const openMinW = BASE_MIN_WIDTH + FILE_PANEL_WIDTH; // 文件树打开时的地板宽度
      if (next) {
        // 打开：先把 OS 最小宽度抬到地板（1256），系统据此在拖拽时硬性挡住；
        // 再把窗口撑大 256（macOS 上 setMinSize 不会自动撑大窗口，故仍需 setSize）。
        // 但地板不超过显示器逻辑宽度——否则在窄屏（如放大字体缩放）上会给系统一个
        // 无法满足的最小尺寸，可能把窗口推出屏外。窄屏放不下时，chat 的 min-w-0
        // 会让步、文件树照样完整显示，工具条横向滚动兜底。
        const monitorLogicalW = monitor ? monitor.size.width / monitor.scaleFactor : Infinity;
        await win.setMinSize(new LogicalSize(Math.min(openMinW, monitorLogicalW), BASE_MIN_HEIGHT));
        // Pre-flight: would the wider window run off the right edge of the
        // current monitor? If so, slide the window left first so the file
        // panel ends up on-screen instead of off-screen.
        const newWidth = size.width + delta;
        if (monitor) {
          // monitor.position is the screen's top-left in physical pixels;
          // monitor.size.width is the screen width in physical pixels.
          const screenRight = monitor.position.x + monitor.size.width;
          const windowRight = position.x + newWidth;
          if (windowRight > screenRight) {
            const newX = Math.max(monitor.position.x, screenRight - newWidth);
            await win.setPosition(new PhysicalPosition(newX, position.y));
          }
        }
        await win.setSize(new PhysicalSize(newWidth, size.height));
      } else {
        // 关闭：必须先把 OS 最小宽度降回 1000，再收缩。若顺序反了，从 1256
        // 收缩到 1000 会被尚未降低的 minSize(1256) 钳制，导致收不回去。
        await win.setMinSize(new LogicalSize(BASE_MIN_WIDTH, BASE_MIN_HEIGHT));
        await win.setSize(new PhysicalSize(size.width - delta, size.height));
      }
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

  // Fetch git branch when session changes, poll every 5s to catch external changes
  useEffect(() => {
    setGitBranch(null);
    if (!currentSession?.projectPath) return;
    const path = currentSession.projectPath;
    const refresh = () => {
      getGitBranch(path)
        .then((branch) => setGitBranch(branch))
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [currentSession?.projectPath]);

  // Poll context tokens from JSONL session file every 5s.
  // Cache per session so switching sessions doesn't clear the bar (avoids flash).
  useEffect(() => {
    const sessionId = currentSession?.claudeSessionId;
    const projectPath = currentSession?.projectPath;
    if (!sessionId || !projectPath) return;
    const key = `${sessionId}|${projectPath}`;
    const refresh = () => {
      getContextTokens(sessionId, projectPath)
        .then((tokens) => {
          if (tokens != null) {
            setContextTokensCache((prev) => (prev[key] === tokens ? prev : { ...prev, [key]: tokens }));
          }
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [currentSession?.claudeSessionId, currentSession?.projectPath]);

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

  const doSend = useCallback(
    async (sessionId: string, content: string, attachments?: Attachment[]) => {
      const session = useChatStore.getState().sessions.find((s) => s.id === sessionId);
      if (!session) return;
      const settings = useSettingsStore.getState().settings;

      // Validate config before sending. Resolve per-model credentials first,
      // so a model configured via "Add model" (with its own apiKey) works even
      // when the global apiKey field is empty.
      const effectiveModel = session.model || settings.model;
      const resolvedCreds = resolveModelCreds(
        effectiveModel,
        settings.models,
        settings.apiKey,
        settings.baseUrl,
      );
      if (!resolvedCreds.apiKey) {
        const missing = ["API Key"];
        if (!effectiveModel) missing.push("Model");
        addSystemMessage(
          sessionId,
          `⚠️ ${t("chat.missingConfig", { items: missing.join(", ") })}`
        );
        return;
      }
      if (!effectiveModel) {
        addSystemMessage(
          sessionId,
          `⚠️ ${t("chat.noModel")}`
        );
        return;
      }

      addUserMessage(
        sessionId,
        content,
        attachments?.map((a) => ({ name: a.name, type: a.type, path: a.path, dataUrl: a.dataUrl, size: a.size }))
      );
      setStreaming(sessionId, true);
      clearError();
      try {
        const resumeId = session.claudeSessionId || undefined;
        const creds = resolvedCreds;
        const pid = await sendMessage({
          session_id: sessionId,
          message: content,
          cwd: session.projectPath,
          model: session.model || undefined,
          permission_mode: session.permissionMode || undefined,
          claude_path: settings.claudePath || undefined,
          allowed_tools: session.allowedTools ?? [],
          api_key: creds.apiKey || undefined,
          base_url: creds.baseUrl || undefined,
          attachments: attachments?.map((a) => ({
            path: a.path,
            name: a.name,
            type: a.type,
          })),
          resume_id: resumeId,
          locale: settings.locale || undefined,
          effort: settings.effort || undefined,
          context_window: settings.contextWindow || undefined,
          haiku_model: settings.haikuModel || undefined,
          sonnet_model: settings.sonnetModel || undefined,
          opus_model: settings.opusModel || undefined,
        });
        addLaunchMessage(sessionId, pid, resumeId);
        // Sync activity to Lark bot if connected
        if (useLarkStore.getState().status === "connected") {
          larkSendCommand(JSON.stringify({
            type: "app_activity",
            session_id: sessionId,
            project_path: session.projectPath,
            prompt: content.slice(0, 100),
            status: "running",
          })).catch(() => {});
        }
      } catch (err) {
        handleStreamDone(sessionId, String(err));
      }
    },
    [addUserMessage, addSystemMessage, addLaunchMessage, setStreaming, clearError, handleStreamDone, t]
  );

  /** Public send handler from InputArea — enqueues if a task is running, otherwise sends now. */
  const handleSend = useCallback(
    (content: string, attachments?: Attachment[]) => {
      if (!currentSessionId) return;
      if (isStreaming) {
        enqueueMessage(
          currentSessionId,
          content,
          attachments?.map((a) => ({
            name: a.name,
            type: a.type,
            path: a.path,
            dataUrl: a.dataUrl,
            size: a.size,
          }))
        );
      } else {
        doSend(currentSessionId, content, attachments);
      }
    },
    [currentSessionId, isStreaming, enqueueMessage, doSend]
  );

  // Auto-pop queue when ANY session's task finishes — not just the current one —
  // so queued messages still run after the user switches to another project.
  const prevStreamingRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const prev = prevStreamingRef.current;
    const sids = new Set([...Object.keys(prev), ...Object.keys(streamingSessions)]);
    for (const sid of sids) {
      const finished = !!prev[sid] && !streamingSessions[sid];
      if (!finished) continue;
      const queue = useChatStore.getState().messageQueue[sid] || [];
      if (queue.length === 0) continue;
      const item = popQueuedMessage(sid);
      if (item) {
        const atts = item.attachments?.map((a) => ({
          name: a.name,
          type: a.type,
          path: a.path,
          dataUrl: a.dataUrl,
          size: a.size,
        }));
        doSend(sid, item.content, atts);
      }
    }
    prevStreamingRef.current = { ...streamingSessions };
  }, [streamingSessions, popQueuedMessage, doSend]);

  const handleStop = useCallback(async () => {
    if (currentSessionId) {
      try { await stopSession(currentSessionId); } catch { /* ignore */ }
      handleStreamDone(currentSessionId, undefined, true);
      addSystemMessage(currentSessionId, "__stopped__");
      clearMessageQueue(currentSessionId);
    }
  }, [currentSessionId, addSystemMessage, handleStreamDone, clearMessageQueue]);

  const handleModelChange = useCallback(
    (model: string) => {
      if (currentSessionId) updateSession(currentSessionId, { model });
    },
    [currentSessionId, updateSession]
  );

  const handleAllowedToolsChange = useCallback(
    (allowedTools: string[]) => {
      if (currentSessionId) updateSession(currentSessionId, { allowedTools });
    },
    [currentSessionId, updateSession]
  );

  // "新会话": create a brand-new session in the current project (a fresh Claude
  // conversation → new JSONL). The old session stays intact in the switcher.
  const handleClearSession = useCallback(() => {
    if (!currentSession?.projectPath) return;
    createProjectSession(
      currentSession.projectPath,
      currentSession.model || settings.defaultModel || settings.model || "",
      currentSession.permissionMode || settings.permissionMode || ""
    );
  }, [currentSession, createProjectSession, settings]);

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
        clearPendingInteraction(currentSessionId);
      } catch (err) {
        console.error("Failed to send response:", err);
      }
    },
    [currentSessionId, clearPendingInteraction]
  );

  const currentMessages = useMemo(
    () => (currentSessionId ? messages[currentSessionId] || [] : []),
    [messages, currentSessionId]
  );

  // 贴底跟随策略（不再依赖 60/200/400ms 魔法定时器）：
  // - stickToBottom 表示"用户此刻停在底部附近、希望跟随新内容"。只有用户主动
  //   滚动(handleMsgScroll)才更新它；程序化 pin 期间用 pinningRef 屏蔽，避免流式
  //   内容一帧涨高超过阈值时被误判成"用户上滑"而停止跟随。
  // - pinToBottom 把滚动条钉到底，由三处驱动：切换会话、消息数组变化(发送/流式)、
  //   以及 ResizeObserver。ResizeObserver 覆盖 React 状态之外的异步布局(图片
  //   onload、代码高亮、字体、markdown 二次渲染、工具卡展开)，这些正是旧实现
  //   靠定时器也常常错过的时刻。
  const pinToBottom = useCallback(() => {
    const e = msgScrollRef.current;
    if (!e || loadingMoreTurns.current) return;
    pinningRef.current = true;
    e.scrollTop = e.scrollHeight;
    requestAnimationFrame(() => {
      pinningRef.current = false;
    });
  }, []);

  // 切换会话：强制贴底并立即钉一次。冷会话是异步懒加载的(先切 id、后到消息)，
  // 此刻内容可能为空，随后的消息 effect / ResizeObserver 会在真正内容到达并完成
  // 布局后再次钉底——这修复了"首次打开的会话滚不到底"。
  useLayoutEffect(() => {
    stickToBottom.current = true;
    pinToBottom();
  }, [currentSessionId, pinToBottom]);

  // 消息数组变化：发送用户消息时强制贴底；流式增长时若仍贴底则跟随。
  useLayoutEffect(() => {
    const last = currentMessages[currentMessages.length - 1];
    if (last?.role === "user") stickToBottom.current = true;
    if (stickToBottom.current) pinToBottom();
  }, [currentMessages, pinToBottom]);

  // 出现待人工接管的交互(AskUserQuestion / ExitPlanMode / 工具授权)时，强制滚到
  // 底部。这类卡片需要用户立即操作，不能被"用户上滑看历史"(stickToBottom=false)
  // 抑制——否则卡片停在视口下方，用户会以为"提示要接管却找不到对话框"。
  useEffect(() => {
    if (!pendingInteraction) return;
    stickToBottom.current = true;
    pinToBottom();
    // 卡片是较大的异步布局，补几帧确保稳定停到底部
    const r = requestAnimationFrame(pinToBottom);
    const t1 = setTimeout(pinToBottom, 120);
    return () => { cancelAnimationFrame(r); clearTimeout(t1); };
  }, [pendingInteraction?.requestId, pendingInteraction?.type, pinToBottom]);

  // 观察内容容器尺寸变化，兜住一切 React 状态之外的异步布局。用回调 ref 挂载，
  // 这样在消息视图/文件视图切换导致节点重建时也能正确重新观察。
  const msgContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      msgContentObserver.current?.disconnect();
      msgContentObserver.current = null;
      if (node && typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => {
          if (stickToBottom.current) pinToBottom();
        });
        ro.observe(node);
        msgContentObserver.current = ro;
      }
    },
    [pinToBottom]
  );


  // 分轮分页：计算起始索引
  const msgStartIndex = useMemo(
    () => getTurnStartIndex(currentMessages, visibleTurns),
    [currentMessages, visibleTurns]
  );
  const hasMoreTurns = msgStartIndex > 0;

  // 待接管的 ask_user / exit_plan:正常由「最后一条 assistant 消息里对应的
  // tool_use 块」内联渲染表单。但若流式重建导致那个块不在最后一条 assistant
  // 消息里(或压根没进消息树),内联卡就不出现 → 用户看到侧边栏「等待接管」却
  // 找不到对话框。这里检测该情况,必要时在底部渲染独立兜底卡(与工具授权卡一致)。
  const fallbackInteractionTool = useMemo(() => {
    const type = pendingInteraction?.type;
    const name =
      type === "ask_user" ? "AskUserQuestion" : type === "exit_plan" ? "ExitPlanMode" : null;
    if (!name) return null;
    let lastAsst = -1;
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      if (currentMessages[i].role === "assistant") { lastAsst = i; break; }
    }
    const inlineWillRender =
      lastAsst >= 0 &&
      currentMessages[lastAsst].content.some(
        (b) => b.type === "tool_use" && b.name === name
      );
    return inlineWillRender ? null : name;
  }, [pendingInteraction?.type, pendingInteraction?.requestId, currentMessages]);

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
    // 程序化 pin 触发的 scroll 事件不参与"用户是否上滑"判断，否则流式内容一帧
    // 涨高超过阈值时会把 stickToBottom 误置为 false 而停止跟随。
    if (pinningRef.current) return;
    // 记录用户是否停在底部附近，供流式自动跟随判断（上滑看历史时不强拽）
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
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

  // Extract contextWindow from the latest assistant message with usage data
  const sdkContextWindow = (() => {
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const m = currentMessages[i];
      if (m.role === "assistant" && m.usage?.contextWindow) {
        return m.usage.contextWindow;
      }
    }
    return undefined;
  })();

  const contextTokensKey =
    currentSession?.claudeSessionId && currentSession?.projectPath
      ? `${currentSession.claudeSessionId}|${currentSession.projectPath}`
      : null;
  const contextTokens = contextTokensKey ? contextTokensCache[contextTokensKey] ?? null : null;

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
          onDoubleClick={handleTitleBarDoubleClick}
          className="h-14 flex-shrink-0 flex items-center justify-end"
        >
          <WindowControls />
        </div>
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
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Session header */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-3 px-4 border-b border-border bg-bg-secondary/50 h-14 flex-shrink-0"
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          if (isWindows && e.detail >= 2) return;
          getCurrentWindow().startDragging();
        }}
        onDoubleClick={handleTitleBarDoubleClick}
      >
        <FolderOpen size={14} className="text-text-muted pointer-events-none" />
        <span
          className="text-sm text-text-secondary truncate max-w-[35%] pointer-events-none"
          title={currentSession?.projectPath}
        >
          {currentSession?.projectName}
        </span>
        {currentSession?.projectPath && currentSessionId && (
          <SessionSwitcher projectPath={currentSession.projectPath} currentSessionId={currentSessionId} />
        )}
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

        {gitBranch && currentSession?.projectPath && currentSessionId && (
          <BranchDiffBadge
            branch={gitBranch}
            projectPath={currentSession.projectPath}
            sessionId={currentSessionId}
            isStreaming={isStreaming}
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
        <WindowControls />
      </div>

      {/* Main content area with optional file panel.
          @container + relative: the file panel queries THIS row's width and,
          when there isn't room for chat(744)+panel(256), floats above the chat
          (absolute) instead of pushing it — so the chat is never compressed.
          See the panel's @max-[999px]: classes below. */}
      <div className="flex-1 flex min-h-0 overflow-hidden @container relative">
        {/* Chat area. min-w-0 so it fills the content row regardless of the
            file panel: when the row is wide enough (>=1000) the panel sits
            beside it (inline), otherwise the panel floats above the chat's
            right edge (see @max-[999px]: on the panel) so the chat is never
            compressed. The input toolbar scrolls horizontally if it ever
            outgrows the chat width. */}
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
            <div ref={msgScrollRef} onScroll={handleMsgScroll} onWheel={handleMsgWheel} style={{ overflowAnchor: "none" }} className="flex-1 overflow-y-auto pt-4 pb-2">
              <div ref={msgContentRef} className="max-w-3xl mx-auto overflow-hidden">
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
                      className="text-sm font-semibold text-text-muted/60 hover:text-text-muted transition-colors px-3 py-1 rounded-full hover:bg-bg-tertiary/50"
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
                        onResendToInput={msg.role === "user" ? handleResendToInput : undefined}
                        skipAgentBlockId={agentRun?.agentBlock.id}
                      />
                      {agentRun && (
                        <AgentRunContainer
                          agentBlock={agentRun.agentBlock}
                          childMessages={agentRun.childIndices.map((j) => currentMessages[j])}
                          isStreaming={isStreaming}
                          hasResult={agentRun.hasResult}
                        />
                      )}
                    </React.Fragment>
                  );
                })}
              </div>

              {/* Tool permission card */}
              {pendingInteraction?.type === "tool_permission" && (
                <ToolPermissionCard
                  interaction={pendingInteraction}
                  onRespond={handleRespond}
                />
              )}

              {/* 兜底:ask_user / exit_plan 的交互块不在消息树里时,独立渲染接管卡,
                  保证「等待人工接管」时用户一定能看到并响应(不依赖消息树/滚动)。 */}
              {fallbackInteractionTool && pendingInteraction && (
                <div className="max-w-3xl mx-auto px-4 mb-4">
                  <ToolCallCard
                    // 按 会话+requestId 唯一,确保每个新交互都是全新实例——否则
                    // ToolCallCard 内部的答案 state 会被上一个问题(甚至上一个项目)
                    // 复用,导致"未接管就预填了上个问题的答案"。
                    key={`fallback-${currentSessionId}-${pendingInteraction.requestId}`}
                    block={{
                      type: "tool_use",
                      name: fallbackInteractionTool,
                      id: `fallback-${currentSessionId}-${pendingInteraction.requestId}`,
                      input:
                        pendingInteraction.input ||
                        ({ questions: pendingInteraction.questions } as Record<string, unknown>),
                    }}
                    pendingInteraction={pendingInteraction}
                    onRespond={handleRespond}
                  />
                </div>
              )}

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

          {/* Task Board + Input. In float mode (@max-[1000px]) the file panel
              floats above the chat; lift this region above it (z-30 > panel's
              z-20) with an opaque bg so the send button / model picker stay
              clickable and their popovers render in front of the drawer. In
              inline mode (>=1000) none of these classes apply — layout unchanged. */}
          <div className="flex-shrink-0 @max-[1000px]:relative @max-[1000px]:z-30 @max-[1000px]:bg-bg-primary">
          {/* Task Board (above input) */}
          <TaskBoard sessionId={currentSessionId} />

          {/* Input — always mounted outside the viewer/messages toggle so draft text is preserved */}
          <InputArea
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            disabled={!claudeAvailable}
            model={currentSession?.model || ""}
            models={settings.models.map((m) => m.id)}
            onModelChange={handleModelChange}
            projectPath={currentSession?.projectPath}
            onOpenTerminal={handleOpenTerminal}
            allowedTools={currentSession?.allowedTools || []}
            onAllowedToolsChange={handleAllowedToolsChange}
            hasClaudeSession={!!currentSession?.claudeSessionId}
            onClearSession={handleClearSession}
            contextTokens={contextTokens ?? undefined}
            contextWindow={sdkContextWindow}
            streamStartTime={streamStartTime}
            queue={currentSessionId ? messageQueue[currentSessionId] || [] : []}
            onRemoveQueued={(id) => {
              if (currentSessionId) removeQueuedMessage(currentSessionId, id);
            }}
            sessionKey={currentSessionId}
            initialDraft={
              currentSessionId && inputDrafts[currentSessionId]
                ? {
                    content: inputDrafts[currentSessionId].content,
                    attachments: inputDrafts[currentSessionId].attachments,
                  }
                : { content: "", attachments: [] }
            }
            onPersistDraft={(sid, d) => saveInputDraft(sid, d)}
            injectedDraft={injectedDraft}
            injectedAttachment={injectedAttachment}
          />
          </div>
        </div>

        {/* File panel — tree only, viewer is shown in the chat area */}
        {showFilePanel && currentSession?.projectPath && (
          <div className="w-64 min-w-[16rem] border-l border-border bg-bg-secondary flex-shrink-0 @max-[1000px]:absolute @max-[1000px]:right-0 @max-[1000px]:top-0 @max-[1000px]:bottom-0 @max-[1000px]:z-20 @max-[1000px]:shadow-[-12px_0_24px_-6px_rgba(0,0,0,0.45)]">
            <FileTree rootPath={currentSession.projectPath} changedFiles={changedFiles} refreshKey={fileTreeRefreshKey} onAddToChat={handleAddFileToChat} onFileSelect={(path) => {
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
    </>
  );
}

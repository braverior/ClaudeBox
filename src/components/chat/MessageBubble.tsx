import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfmSafe from "../../lib/remark-gfm-safe";
import type { ChatMessage, ContentBlock, PendingInteraction } from "../../lib/stream-parser";
import CodeBlock from "./CodeBlock";
import ToolCallCard, { shortPath } from "./ToolCallCard";
import { formatTimeWithSeconds, formatDuration } from "../../lib/utils";
import { useT, type TFunction } from "../../lib/i18n";
import { User, Loader2, Brain, ChevronDown, ChevronRight, Info, FileCode2, FileText, Image, FileType, Terminal, Globe, Settings2, Rocket, Sparkles, Layers, CheckCircle, CircleStop, Clock, Timer, Hash, DollarSign, RefreshCw } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { ComponentPropsWithoutRef } from "react";

// remarkGfmSafe: tables / strikethrough / task-lists without autolink-literal
// (autolink-literal uses lookbehind regex unsupported on macOS ≤ 12 / WebKit < 16.4)
const remarkPlugins = [remarkGfmSafe];

// ── File category styling (shared with InputArea) ──────────────────

type FileCategory = "code" | "config" | "doc" | "web" | "shell" | "image" | "other";

const EXT_CATEGORY: Record<string, FileCategory> = {
  ts: "code", tsx: "code", js: "code", jsx: "code", py: "code",
  rs: "code", go: "code", java: "code", rb: "code", php: "code",
  c: "code", cpp: "code", h: "code", lua: "code",
  json: "config", yaml: "config", yml: "config", toml: "config",
  ini: "config", cfg: "config", conf: "config",
  md: "doc", txt: "doc", log: "doc",
  html: "web", css: "web", xml: "web", svg: "web",
  sh: "shell", sql: "shell",
  png: "image", jpg: "image", jpeg: "image", gif: "image",
  webp: "image", bmp: "image",
};

const CATEGORY_STYLE: Record<FileCategory, { bg: string; text: string; border: string }> = {
  code:   { bg: "bg-blue-500/10",    text: "text-blue-400",    border: "border-blue-500/20" },
  config: { bg: "bg-amber-500/10",   text: "text-amber-400",   border: "border-amber-500/20" },
  doc:    { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20" },
  web:    { bg: "bg-purple-500/10",  text: "text-purple-400",  border: "border-purple-500/20" },
  shell:  { bg: "bg-orange-500/10",  text: "text-orange-400",  border: "border-orange-500/20" },
  image:  { bg: "bg-rose-500/10",    text: "text-rose-400",    border: "border-rose-500/20" },
  other:  { bg: "bg-zinc-500/10",    text: "text-zinc-400",    border: "border-zinc-500/20" },
};

function getCategoryIcon(cat: FileCategory) {
  switch (cat) {
    case "code":   return FileCode2;
    case "config": return Settings2;
    case "doc":    return FileText;
    case "web":    return Globe;
    case "shell":  return Terminal;
    case "image":  return Image;
    default:       return FileType;
  }
}

function getFileCategory(name: string): FileCategory {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return EXT_CATEGORY[ext] || "other";
}

/** Memoized text block — only re-renders if text actually changes */
const TextBlock = memo(function TextBlock({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={{
          a({ href, children }) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href) shellOpen(href).catch(() => {});
                }}
              >
                {children}
              </a>
            );
          },
          code(props: ComponentPropsWithoutRef<"code">) {
            const { className, children, ...rest } = props;
            const match = /language-(\w+)/.exec(className || "");
            const code = String(children).replace(/\n$/, "");
            const isBlock = match || code.includes("\n");
            if (isBlock) {
              return (
                <CodeBlock
                  code={code}
                  language={match ? match[1] : undefined}
                />
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Collapsible thinking block */
const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
}: {
  thinking: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = thinking.slice(0, 100).replace(/\n/g, " ");

  return (
    <div className="rounded-lg border border-border/50 bg-bg-tertiary/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-bg-tertiary/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown size={14} className="text-text-muted" />
        ) : (
          <ChevronRight size={14} className="text-text-muted" />
        )}
        <Brain size={14} className="text-purple-400" />
        <span className="text-text-muted text-xs">Thinking</span>
        {!expanded && (
          <span className="text-text-muted/50 text-xs truncate flex-1 text-left">
            {preview}...
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-border/50">
          <pre className="text-xs text-text-muted whitespace-pre-wrap mt-2 max-h-64 overflow-y-auto leading-relaxed">
            {thinking}
          </pre>
        </div>
      )}
    </div>
  );
});

/** Memoized tool call — only re-renders if inputs change */
const MemoToolCallCard = memo(ToolCallCard);

// ── Exploration tool grouping ────────────────────────────────────────
// Agent tool calls become collapsible containers for all their children.
// Consecutive read-only tool calls are also collapsed when 2+ in a row.

const EXPLORATION_TOOLS = new Set(["Read", "Glob", "Grep", "Bash"]);
const EXPLORATION_GROUP_THRESHOLD = 2;

type GroupItem = { block: ContentBlock; blockIndex: number };
type RenderItem =
  | { kind: "single"; block: ContentBlock; blockIndex: number }
  | { kind: "group"; items: GroupItem[] };

function groupBlocks(blocks: ContentBlock[]): RenderItem[] {
  const result: RenderItem[] = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];

    // ── Consecutive exploration tool_use blocks
    if (block.type === "tool_use" && EXPLORATION_TOOLS.has(block.name || "")) {
      const group: GroupItem[] = [];
      let j = i;
      while (j < blocks.length) {
        const b = blocks[j];
        if (b.type === "tool_use" && EXPLORATION_TOOLS.has(b.name || "")) {
          group.push({ block: b, blockIndex: j });
          j++;
        } else if (b.type === "tool_result") {
          j++; // skip, don't break
        } else if (b.type === "text") {
          // Never absorb text blocks — they must always be visible to the user.
          // Break the group so text renders as a standalone item.
          break;
        } else {
          break;
        }
      }
      if (group.length >= EXPLORATION_GROUP_THRESHOLD) {
        result.push({ kind: "group", items: group });
      } else {
        for (const item of group) {
          result.push({ kind: "single", block: item.block, blockIndex: item.blockIndex });
        }
      }
      i = j;
      continue;
    }

    // ── Skip standalone tool_result (rendered inside ToolCallCard)
    if (block.type === "tool_result") {
      i++;
      continue;
    }

    // ── Everything else: single block
    result.push({ kind: "single", block, blockIndex: i });
    i++;
  }

  return result;
}

/** Build a short description of what an exploration tool is doing */
function toolShortLabel(block: ContentBlock): string {
  const name = block.name || "";
  const input = block.input || {};
  if (name === "Read") {
    const fp = String(input.file_path || "");
    return fp.split("/").pop() || fp;
  }
  if (name === "Bash") {
    return String(input.description || "") || String(input.command || "").slice(0, 30);
  }
  if (name === "Glob") return String(input.pattern || "");
  if (name === "Grep") return String(input.pattern || "");
  return name;
}

/** Find the currently running tool label in a list of items */
function findRunningLabel(items: GroupItem[], findResult: (id: string) => ContentBlock | undefined): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const { block } = items[i];
    if (block.id && !findResult(block.id)) {
      const name = block.name || "Tool";
      const input = block.input || {};
      if (name === "Read") return `Read: ${shortPath(String(input.file_path || ""))}`;
      if (name === "Bash") {
        const desc = String(input.description || "");
        const cmd = String(input.command || "").trim();
        return desc || (cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd) || "Bash";
      }
      if (name === "Glob") return `Glob: ${String(input.pattern || "")}`;
      if (name === "Grep") return `Grep: ${String(input.pattern || "")}`;
      if (name === "WebFetch" || name === "WebSearch") return `${name}: ${String(input.url || input.query || "")}`;
      if (name === "Agent") return String(input.description || input.prompt || "").slice(0, 40);
      return name;
    }
  }
  return "";
}

/** Collapsible group of exploration tool calls (standalone, no Agent parent) */
const ExplorationGroup = memo(function ExplorationGroup({
  items,
  findToolResult,
  t,
}: {
  items: GroupItem[];
  findToolResult: (id: string) => ContentBlock | undefined;
  t: TFunction;
}) {
  const [expanded, setExpanded] = useState(false);

  const labels: string[] = [];
  for (const { block } of items) {
    const lbl = toolShortLabel(block);
    if (lbl && !labels.includes(lbl)) {
      labels.push(lbl);
      if (labels.length >= 3) break;
    }
  }
  const remaining = items.length - labels.length;
  let summaryDetail = labels.join(", ");
  if (remaining > 0) summaryDetail += ` +${remaining}`;

  const runningLabel = findRunningLabel(items, findToolResult);

  return (
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
        <Layers size={14} className="text-accent flex-shrink-0" />
        <span className="text-text-secondary text-xs flex-1 text-left truncate">
          {t("tool.explorationSteps", { count: String(items.length) })}
          {summaryDetail && (
            <span className="text-text-muted ml-1.5">— {summaryDetail}</span>
          )}
        </span>
        {runningLabel ? (
          <span className="flex items-center gap-1 text-text-muted text-[11px] flex-shrink-0 max-w-[40%] truncate">
            <Loader2 size={11} className="animate-spin flex-shrink-0" />
            {runningLabel}
          </span>
        ) : (
          <CheckCircle size={13} className="text-success flex-shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1 border-t border-border pt-1">
          {items.map(({ block }) => {
            const result = block.id ? findToolResult(block.id) : undefined;
            return (
              <MemoToolCallCard
                key={block.id || `tool-${block.name}`}
                block={block}
                result={result}
              />
            );
          })}
        </div>
      )}
    </div>
  );
});

interface MessageBubbleProps {
  message: ChatMessage;
  allMessages: ChatMessage[];
  messageIndex: number;
  /** Whether to show the bot avatar (false for consecutive bot messages) */
  showAvatar?: boolean;
  /** Whether this is the last assistant message in its consecutive run (before next user msg or end) */
  isLastInTurn?: boolean;
  /** Whether this is the last assistant message overall */
  isLastAssistant?: boolean;
  /** Total tokens for the current turn */
  totalTokens?: number;
  /** Timestamp when streaming started (for duration calc) */
  streamStartTime?: number;
  /** Pending interactive request from the sidecar */
  pendingInteraction?: PendingInteraction | null;
  /** Callback when user responds to an interactive tool */
  onRespond?: (response: Record<string, unknown>) => void;
  skipAgentBlockId?: string;
}

export default function MessageBubble({
  message,
  allMessages,
  messageIndex,
  showAvatar = true,
  isLastInTurn = false,
  isLastAssistant = false,
  totalTokens = 0,
  streamStartTime,
  pendingInteraction,
  onRespond,
  skipAgentBlockId,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const t = useT();

  const findToolResult = (toolUseId: string): ContentBlock | undefined => {
    // First search within the same message
    for (const block of message.content) {
      if (block.type === "tool_result" && block.tool_use_id === toolUseId)
        return block;
    }
    // Then search subsequent messages
    for (let i = messageIndex + 1; i < allMessages.length; i++) {
      for (const block of allMessages[i].content) {
        if (block.type === "tool_result" && block.tool_use_id === toolUseId)
          return block;
      }
    }
    return undefined;
  };

  if (isUser) {
    // Skip user messages that only contain tool_result blocks (internal, not user-typed)
    const hasText = message.content.some((b) => b.type === "text" && b.text);
    if (!hasText) return null;

    const imageAtts = message.attachments?.filter((a) => a.type === "image") || [];
    const textAtts = message.attachments?.filter((a) => a.type !== "image") || [];
    const openFile = (path?: string) => {
      if (path) shellOpen(path).catch(() => {});
    };

    return (
      <div className="flex justify-end mb-4 px-4">
        <div className="flex items-start gap-2.5 max-w-[80%] min-w-0 w-fit">
          <div className="min-w-0 w-full flex flex-col items-end gap-1.5">
            {/* Image previews */}
            {imageAtts.length > 0 && (
              <div className="flex flex-wrap gap-2 justify-end">
                {imageAtts.map((att, i) => (
                  <div
                    key={i}
                    className="relative rounded-xl overflow-hidden border border-border/50 cursor-pointer
                               hover:border-accent/40 transition-colors shadow-sm"
                    onDoubleClick={() => openFile(att.path)}
                    title={`${att.name}\nDouble-click to open`}
                  >
                    {att.dataUrl ? (
                      <img src={att.dataUrl} alt={att.name} className="max-w-[240px] max-h-[180px] object-cover" />
                    ) : (
                      <div className="w-24 h-24 flex items-center justify-center bg-rose-500/5">
                        <Image size={24} className="text-rose-400/40" />
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
                      <span className="text-[11px] text-white/90 truncate block">{att.name}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Text file attachment tags */}
            {textAtts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 justify-end">
                {textAtts.map((att, i) => {
                  const cat = getFileCategory(att.name);
                  const style = CATEGORY_STYLE[cat];
                  const Icon = getCategoryIcon(cat);
                  const ext = att.name.split(".").pop()?.toLowerCase() || "";
                  return (
                    <span
                      key={i}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border cursor-pointer
                                   hover:brightness-125 transition-all ${style.bg} ${style.text} ${style.border}`}
                      onDoubleClick={() => openFile(att.path)}
                      title={`${att.path || att.name}\nDouble-click to open`}
                    >
                      <Icon size={13} />
                      <span className="text-xs truncate max-w-[140px]">{att.name}</span>
                      <span className="text-[9px] uppercase font-semibold opacity-60">{ext}</span>
                    </span>
                  );
                })}
              </div>
            )}
            {/* Message text */}
            <div className="rounded-2xl rounded-tr-sm px-4 py-2.5 bg-user-bubble text-text-primary min-w-0 max-w-full">
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[0.9375rem] leading-relaxed">
                {message.content[0]?.text || ""}
              </p>
            </div>
          </div>
          <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-blue-500/15 flex items-center justify-center mt-0.5">
            <User size={14} className="text-blue-400" />
          </div>
        </div>
      </div>
    );
  }

  // System message — info line (e.g. "Task started, PID: 12345")
  if (message.role === "system") {
    const text = message.content[0]?.text || "";
    if (!text) return null;

    // Special card for user-initiated stop
    if (text === "__stopped__") {
      return (
        <div className="flex justify-start px-4 mb-1.5 mt-1">
          <div className="flex items-start gap-2.5 max-w-[90%] min-w-0">
            <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-orange-500/10 flex items-center justify-center mt-0.5">
              <CircleStop size={14} className="text-orange-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-orange-500/5 border border-orange-500/20">
                <span className="text-xs text-orange-400">{t("chat.stoppedByUser")}</span>
                <span className="text-[10px] text-text-muted">{formatTimeWithSeconds(message.timestamp)}</span>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Special card for context compaction
    if (text === "__compacting__" || text.startsWith("__compacted__:")) {
      const isCompacting = text === "__compacting__";
      const preTokens = !isCompacting ? parseInt(text.split(":")[1], 10) : 0;
      return (
        <div className="flex justify-start px-4 mb-1.5 mt-1">
          <div className="flex items-start gap-2.5 max-w-[90%] min-w-0">
            <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-purple-500/10 flex items-center justify-center mt-0.5">
              <RefreshCw size={14} className={`text-purple-400 ${isCompacting ? "animate-spin" : ""}`} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-purple-500/5 border border-purple-500/20">
                {isCompacting ? (
                  <>
                    <Loader2 size={12} className="animate-spin text-purple-400 flex-shrink-0" />
                    <span className="text-xs text-purple-400">{t("chat.compacting")}</span>
                  </>
                ) : (
                  <>
                    <CheckCircle size={12} className="text-purple-400 flex-shrink-0" />
                    <span className="text-xs text-purple-400">
                      {t("chat.compacted")}
                      {preTokens > 0 && (
                        <span className="text-text-muted ml-1.5">
                          {Math.round(preTokens / 1000)}K tokens
                        </span>
                      )}
                    </span>
                  </>
                )}
                <span className="text-[10px] text-text-muted">{formatTimeWithSeconds(message.timestamp)}</span>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-center gap-2 my-1 px-4">
        <Info size={12} className="text-text-muted flex-shrink-0" />
        <span className="text-xs text-text-muted">{text}</span>
      </div>
    );
  }

  // Assistant message — render each content block as a separate element
  const blocks = message.content;
  const totalBlocks = blocks.length;

  // Detect launch placeholder message
  const launchText = blocks[0]?.text;
  const isLaunch = message.streamMessageId === "__launch__" && launchText?.startsWith("__launch__:");
  if (isLaunch) {
    let info: { pid?: number; sessionId?: string; resumeFrom?: string } = {};
    try { info = JSON.parse((launchText ?? "").replace("__launch__:", "")); } catch { /* */ }
    // Determine "launched" state: either isStreaming is false, or there are real assistant messages after this one
    const hasContentAfter = allMessages.slice(messageIndex + 1).some(
      (m) => m.role === "assistant" && m.streamMessageId !== "__launch__"
    );
    const launched = !message.isStreaming || hasContentAfter;
    return (
      <div className="flex justify-start px-4 mb-1.5 mt-1">
        <div className="flex items-start gap-2.5 max-w-[90%] min-w-0">
          <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center mt-0.5">
            <Sparkles size={14} className="text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-bg-tertiary/40 border border-border/50">
              {!launched && (
                <Loader2 size={14} className="animate-spin text-accent flex-shrink-0" />
              )}
              {launched && (
                <Rocket size={14} className="text-accent flex-shrink-0" />
              )}
              <div className="flex items-center gap-2 text-xs text-text-secondary flex-wrap">
                <span>{launched ? t("chat.launched") : t("chat.launching")}</span>
                {info.pid && (
                  <span className="px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted text-[10px] font-mono">
                    PID {info.pid}
                  </span>
                )}
                {info.resumeFrom && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-[10px] font-mono">
                    {t("chat.resumeFrom")}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex justify-start px-4 ${showAvatar ? "mb-1.5 mt-1" : "mb-0.5"}`}>
      <div className="flex items-start gap-2.5 max-w-[90%] min-w-0">
        {/* Avatar or spacer */}
        {showAvatar ? (
          <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center mt-0.5">
            <Sparkles size={14} className="text-accent" />
          </div>
        ) : (
          <div className="flex-shrink-0 w-7" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          {groupBlocks(blocks).map((item, ri) => {
            if (item.kind === "group") {
              return (
                <ExplorationGroup
                  key={`group-${ri}`}
                  items={item.items}
                  findToolResult={findToolResult}
                  t={t}
                />
              );
            }

            const block = item.block;
            const i = item.blockIndex;
            const key = block.id || `${block.type}-${i}`;
            const isLastBlock = i === totalBlocks - 1;

            if (block.type === "thinking" && block.thinking) {
              return <ThinkingBlock key={key} thinking={block.thinking} />;
            }

            if (block.type === "text" && block.text) {
              return (
                <div key={key} className="px-1 text-text-primary">
                  <TextBlock text={block.text} />
                  {/* Streaming indicator on the last text block */}
                  {message.isStreaming && isLastBlock && (
                    <span className="inline-flex items-center gap-1.5 mt-1 text-text-muted">
                      <Loader2 size={12} className="animate-spin" />
                    </span>
                  )}
                </div>
              );
            }

            if (block.type === "tool_use") {
              // Skip Agent blocks that are rendered by AgentRunContainer
              if (block.id === skipAgentBlockId) return null;
              const result = block.id ? findToolResult(block.id) : undefined;
              // Pass interactive props only to the last tool_use block that matches
              const isInteractiveTool =
                block.name === "AskUserQuestion" || block.name === "ExitPlanMode";
              return (
                <MemoToolCallCard
                  key={key}
                  block={block}
                  result={result}
                  pendingInteraction={isInteractiveTool ? pendingInteraction : undefined}
                  onRespond={isInteractiveTool ? onRespond : undefined}
                />
              );
            }

            // tool_result rendered inside ToolCallCard, skip standalone
            if (block.type === "tool_result") return null;

            return null;
          })}

          {/* Thinking state when no content yet */}
          {message.isStreaming && blocks.length === 0 && (
            <div className="px-1 py-2 text-text-primary">
              <div className="flex items-center gap-2 text-text-muted">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-sm">Thinking...</span>
              </div>
            </div>
          )}

          {/* Metadata — show on last assistant message of each completed turn */}
          {isLastInTurn && !message.isStreaming && (() => {
            const duration = message.turnMeta && message.turnMeta.durationMs > 0
              ? formatDuration(message.turnMeta.durationMs)
              : isLastAssistant && streamStartTime
                ? formatDuration(Math.max(0, message.timestamp - streamStartTime))
                : null;
            const tokens = message.turnMeta && message.turnMeta.tokens > 0
              ? message.turnMeta.tokens
              : isLastAssistant && totalTokens > 0 ? totalTokens : null;
            const cost = message.turnMeta?.costUsd != null && message.turnMeta.costUsd > 0
              ? message.turnMeta.costUsd : null;
            const outputTokens = message.turnMeta?.outputTokens;
            const displayTokens = outputTokens != null && outputTokens > 0 ? outputTokens : tokens;

            const sep = <span className="text-text-muted/30">·</span>;

            // Build tooltip for token breakdown
            const meta = message.turnMeta;
            const hasBreakdown = meta && (
              (meta.inputTokens != null && meta.inputTokens > 0) ||
              (meta.cacheCreationTokens != null && meta.cacheCreationTokens > 0) ||
              (meta.cacheReadTokens != null && meta.cacheReadTokens > 0) ||
              (meta.outputTokens != null && meta.outputTokens > 0)
            );
            const tokenTooltip = hasBreakdown && meta ? [
              meta.inputTokens != null && meta.inputTokens > 0 ? `输入: ${meta.inputTokens.toLocaleString()}` : null,
              meta.cacheCreationTokens != null && meta.cacheCreationTokens > 0 ? `缓存写: ${meta.cacheCreationTokens.toLocaleString()}` : null,
              meta.cacheReadTokens != null && meta.cacheReadTokens > 0 ? `缓存读: ${meta.cacheReadTokens.toLocaleString()}` : null,
              meta.outputTokens != null && meta.outputTokens > 0 ? `输出: ${meta.outputTokens.toLocaleString()}` : null,
            ].filter(Boolean).join("  |  ") : null;

            return (
              <div className="flex items-center gap-1.5 px-1 mt-1.5 mb-2 text-[11px] text-text-muted/60 flex-wrap">
                <span className="flex items-center gap-1">
                  <Clock size={10} className="shrink-0" />
                  {formatTimeWithSeconds(message.timestamp)}
                </span>
                {duration && <>{sep}<span className="flex items-center gap-1"><Timer size={10} className="shrink-0" />{duration}</span></>}
                {message.model && <>{sep}<span className="px-1.5 py-px rounded bg-white/5 border border-white/8 font-mono text-[10px] text-text-muted/70">{message.model}</span></>}
                {displayTokens != null && <>{sep}<span className="flex items-center gap-1" title={tokenTooltip || undefined}><Hash size={10} className="shrink-0" />{displayTokens.toLocaleString()} tokens</span></>}
                {cost != null && <>{sep}<span className="flex items-center gap-1 text-emerald-400/60"><DollarSign size={10} className="shrink-0" />{cost.toFixed(4)}</span></>}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

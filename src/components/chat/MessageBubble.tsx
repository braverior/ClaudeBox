import { memo, useState, useRef, useCallback, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfmSafe from "../../lib/remark-gfm-safe";
import type { ChatMessage, ContentBlock, PendingInteraction } from "../../lib/stream-parser";
import CodeBlock from "./CodeBlock";
import ToolCallCard, { shortPath } from "./ToolCallCard";
import { formatTimeWithSeconds, formatDuration, formatFileSize } from "../../lib/utils";
import { useT, type TFunction } from "../../lib/i18n";
import { User, Loader2, Brain, ChevronDown, ChevronRight, Info, Image, Rocket, Sparkles, Layers, CheckCircle, CircleStop, Clock, Timer, Hash, DollarSign, RefreshCw, Share2, Copy, ImageIcon, Check } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import QRCode from "qrcode";
import logoUrl from "../../assets/app-icon.png";
import { copyImageToClipboard, getFileSize } from "../../lib/claude-ipc";
import { useImageViewerStore } from "../../stores/imageViewerStore";
import type { ComponentPropsWithoutRef } from "react";

// remarkGfmSafe: tables / strikethrough / task-lists without autolink-literal
// (autolink-literal uses lookbehind regex unsupported on macOS ≤ 12 / WebKit < 16.4)
const remarkPlugins = [remarkGfmSafe];

// ── File category styling (shared with InputArea) ──────────────────

type FileCategory = "code" | "config" | "doc" | "web" | "shell" | "image" | "office" | "other";

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
  pdf: "office", pptx: "office", ppt: "office",
  docx: "office", doc: "office",
  xlsx: "office", xls: "office", xlsm: "office", csv: "office",
};

const CATEGORY_STYLE: Record<FileCategory, { bg: string; text: string; border: string }> = {
  code:   { bg: "bg-blue-500/10",    text: "text-blue-400",    border: "border-blue-500/20" },
  config: { bg: "bg-amber-500/10",   text: "text-amber-400",   border: "border-amber-500/20" },
  doc:    { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20" },
  web:    { bg: "bg-purple-500/10",  text: "text-purple-400",  border: "border-purple-500/20" },
  shell:  { bg: "bg-orange-500/10",  text: "text-orange-400",  border: "border-orange-500/20" },
  image:  { bg: "bg-rose-500/10",    text: "text-rose-400",    border: "border-rose-500/20" },
  office: { bg: "bg-sky-500/10",     text: "text-sky-400",     border: "border-sky-500/20" },
  other:  { bg: "bg-zinc-500/10",    text: "text-zinc-400",    border: "border-zinc-500/20" },
};

/** Office/PDF per-extension palette (overrides `office` category color). */
const OFFICE_EXT_STYLE: Record<string, { bg: string; text: string; border: string }> = {
  pdf:  { bg: "bg-red-500/10",     text: "text-red-400",     border: "border-red-500/20" },
  pptx: { bg: "bg-orange-500/10",  text: "text-orange-400",  border: "border-orange-500/20" },
  ppt:  { bg: "bg-orange-500/10",  text: "text-orange-400",  border: "border-orange-500/20" },
  docx: { bg: "bg-sky-500/10",     text: "text-sky-400",     border: "border-sky-500/20" },
  doc:  { bg: "bg-sky-500/10",     text: "text-sky-400",     border: "border-sky-500/20" },
  xlsx: { bg: "bg-green-500/10",   text: "text-green-400",   border: "border-green-500/20" },
  xls:  { bg: "bg-green-500/10",   text: "text-green-400",   border: "border-green-500/20" },
  xlsm: { bg: "bg-green-500/10",   text: "text-green-400",   border: "border-green-500/20" },
  csv:  { bg: "bg-green-500/10",   text: "text-green-400",   border: "border-green-500/20" },
};

function getFileCategory(name: string): FileCategory {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return EXT_CATEGORY[ext] || "other";
}

/** Left-logo + right-text chip for non-image attachments in message bubbles.
 *  Lazily fetches file size for legacy messages persisted before size was stored. */
function TextAttachmentChip({
  att,
  onOpen,
}: {
  att: { name: string; type: string; path?: string; size?: number };
  onOpen: () => void;
}) {
  const cat = getFileCategory(att.name);
  const ext = att.name.split(".").pop()?.toLowerCase() || "";
  const style = OFFICE_EXT_STYLE[ext] || CATEGORY_STYLE[cat];
  const extLabel = ext.length > 4 ? ext.slice(0, 4).toUpperCase() : ext.toUpperCase();

  const [size, setSize] = useState<number | undefined>(att.size);
  useEffect(() => {
    if (att.size != null || !att.path) return;
    let cancelled = false;
    getFileSize(att.path).then((s) => {
      if (!cancelled) setSize(s);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [att.path, att.size]);

  const sizeStr = formatFileSize(size);

  return (
    <div
      className="flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-lg border border-border
                 bg-bg-secondary cursor-pointer hover:brightness-110 transition-all"
      onDoubleClick={onOpen}
      title={`${att.path || att.name}\nDouble-click to open`}
    >
      <div
        className={`flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center
                    ${style.bg} border ${style.border}`}
      >
        <span
          className={`font-bold tracking-wider uppercase ${style.text}
                      ${extLabel.length >= 4 ? "text-[9px]" : "text-[11px]"}`}
        >
          {extLabel}
        </span>
      </div>
      <div className="flex flex-col min-w-0 leading-tight">
        <span className="text-[12px] font-medium text-text-primary truncate max-w-[150px]">
          {att.name}
        </span>
        {sizeStr && (
          <span className="text-[10px] text-text-muted mt-0.5">{sizeStr}</span>
        )}
      </div>
    </div>
  );
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
  const openImage = useImageViewerStore((s) => s.openImage);
  const contentRef = useRef<HTMLDivElement>(null);
  const sharePopoverRef = useRef<HTMLDivElement>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!shareOpen) return;
    const handler = (e: MouseEvent) => {
      if (sharePopoverRef.current && !sharePopoverRef.current.contains(e.target as Node)) {
        setShareOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [shareOpen]);

  const getMarkdownText = useCallback(() => {
    return message.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("\n\n");
  }, [message.content]);

  const handleShareText = useCallback(() => {
    const text = getMarkdownText();
    if (!text) return;
    navigator.clipboard.writeText(text);
    setShareFeedback("text");
    setShareOpen(false);
    setTimeout(() => setShareFeedback(null), 2000);
  }, [getMarkdownText]);

  const handleShareImage = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    setShareOpen(false);
    try {
      const answerText = getMarkdownText();
      if (!answerText) return;

      // Find the user question before this assistant message
      let questionText = "";
      for (let i = messageIndex - 1; i >= 0; i--) {
        const m = allMessages[i];
        if (m.role === "user") {
          questionText = m.content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n\n")
            .trim();
          break;
        }
      }

      const PADDING = 40;
      const WIDTH = 800;
      const FONT_SIZE = 14;
      const LINE_HEIGHT = 22;
      const CODE_FONT = "13px 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, Consolas, monospace";
      const TEXT_FONT = `${FONT_SIZE}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
      const QUESTION_FONT = `${FONT_SIZE}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
      const HEADING_FONTS: Record<string, string> = {
        "# ": "bold 22px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        "## ": "bold 18px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        "### ": "bold 16px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      };
      const BG_COLOR = "#0f0f23";
      const TEXT_COLOR = "#e2e8f0";
      const MUTED_COLOR = "#64748b";
      // Match chat area CodeBlock: --color-code-bg / --color-code-header / --color-border
      const CODE_BG = "#0d1117";
      const CODE_HEADER_BG = "#161b22";
      const CODE_BORDER = "#2a2a4a";
      const CODE_TEXT_COLOR = "#e2e8f0";
      const CODE_LANG_COLOR = "#9ca3af";
      const QUESTION_BG = "#1a1a38";
      const QUESTION_COLOR = "#94a3b8";
      const FOOTER_HEIGHT = 96;
      const CODE_BLOCK_PAD = 16;
      const CODE_HEADER_H = 32;
      const CODE_RADIUS = 12;
      const CODE_LINE_H = 20;

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      const scale = 2;
      const maxTextWidth = WIDTH - PADDING * 2;
      const contentMaxW = WIDTH - PADDING * 2;

      const wrapLines = (text: string, font: string, maxW = maxTextWidth): string[] => {
        ctx.font = font;
        const result: string[] = [];
        const words = text.split(" ");
        let current = "";
        for (const word of words) {
          if (ctx.measureText(word).width > maxW) {
            if (current) { result.push(current); current = ""; }
            let chunk = "";
            for (const ch of word) {
              if (ctx.measureText(chunk + ch).width > maxW && chunk) {
                result.push(chunk);
                chunk = ch;
              } else {
                chunk += ch;
              }
            }
            current = chunk;
            continue;
          }
          const test = current ? `${current} ${word}` : word;
          if (ctx.measureText(test).width > maxW && current) {
            result.push(current);
            current = word;
          } else {
            current = test;
          }
        }
        if (current) result.push(current);
        return result;
      };

      // Preserve leading whitespace + wrap; never splits on spaces within indentation.
      const wrapCodeLine = (text: string, font: string, maxW: number): string[] => {
        ctx.font = font;
        if (!text) return [""];
        if (ctx.measureText(text).width <= maxW) return [text];
        const result: string[] = [];
        let chunk = "";
        for (const ch of text) {
          if (ctx.measureText(chunk + ch).width > maxW && chunk) {
            result.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        if (chunk) result.push(chunk);
        return result;
      };

      // --- Question section ---
      const questionWrapped: { text: string; font: string }[] = [];
      if (questionText) {
        for (const ql of questionText.split("\n")) {
          if (!ql.trim()) { questionWrapped.push({ text: "", font: QUESTION_FONT }); continue; }
          for (const wl of wrapLines(ql, QUESTION_FONT, contentMaxW)) {
            questionWrapped.push({ text: wl, font: QUESTION_FONT });
          }
        }
        while (questionWrapped.length > 0 && !questionWrapped[questionWrapped.length - 1].text.trim()) questionWrapped.pop();
      }
      const questionBlockHeight = questionWrapped.length > 0
        ? 12 * 2 + (questionWrapped.length - 1) * LINE_HEIGHT + FONT_SIZE + 4 + 16
        : 0;

      // --- Answer section (block-based parser) ---
      const BOLD_FONT = `bold ${FONT_SIZE}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
      type LineItem = { text: string; font: string; color: string };
      type Block =
        | { type: 'lines'; items: LineItem[] }
        | { type: 'hr' }
        | { type: 'code'; language: string; lines: string[] }
        | { type: 'table'; headers: string[]; rows: string[][] };

      const blocks: Block[] = [];
      let currentLines: LineItem[] = [];
      let inCodeBlock = false;
      let codeLang = "";
      let codeBuffer: string[] = [];
      let tableHeaders: string[] | null = null;
      let tableRows: string[][] = [];

      const flushLines = () => {
        if (currentLines.length > 0) { blocks.push({ type: 'lines', items: [...currentLines] }); currentLines = []; }
      };
      const flushTable = () => {
        if (tableHeaders) { blocks.push({ type: 'table', headers: tableHeaders, rows: [...tableRows] }); tableHeaders = null; tableRows = []; }
      };
      const codeInnerW = contentMaxW - CODE_BLOCK_PAD * 2;
      const flushCode = () => {
        const wrapped: string[] = [];
        for (const line of codeBuffer) {
          for (const wl of wrapCodeLine(line, CODE_FONT, codeInnerW)) wrapped.push(wl);
        }
        while (wrapped.length > 0 && !wrapped[0].trim()) wrapped.shift();
        while (wrapped.length > 0 && !wrapped[wrapped.length - 1].trim()) wrapped.pop();
        if (wrapped.length > 0) blocks.push({ type: 'code', language: codeLang, lines: wrapped });
        codeBuffer = [];
        codeLang = "";
      };

      for (const line of answerText.split("\n")) {
        if (line.startsWith("```")) {
          if (!inCodeBlock) {
            flushLines();
            flushTable();
            codeLang = line.slice(3).trim();
            codeBuffer = [];
          } else {
            flushCode();
          }
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) {
          codeBuffer.push(line);
          continue;
        }
        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
          flushLines(); flushTable(); blocks.push({ type: 'hr' }); continue;
        }
        if (/^\|[-:\s|]+\|?\s*$/.test(line)) { continue; }
        if (line.trim().startsWith("|") && line.includes("|", 1)) {
          flushLines();
          const cells = line.split("|").map(c => c.trim()).filter(Boolean);
          if (!tableHeaders) tableHeaders = cells;
          else tableRows.push(cells);
          continue;
        }
        flushTable();
        if (!line.trim()) { currentLines.push({ text: "", font: TEXT_FONT, color: TEXT_COLOR }); continue; }

        let font = TEXT_FONT;
        let displayLine = line;
        for (const [prefix, hFont] of Object.entries(HEADING_FONTS)) {
          if (line.startsWith(prefix)) { font = hFont; displayLine = line.slice(prefix.length); break; }
        }
        if (/^[-*]\s/.test(line)) displayLine = "  " + line.replace(/^[-*]\s/, "• ");
        if (/^\d+\.\s/.test(line)) displayLine = "  " + line;
        displayLine = displayLine.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1");
        for (const wl of wrapLines(displayLine, font, contentMaxW)) {
          currentLines.push({ text: wl, font, color: TEXT_COLOR });
        }
      }
      flushLines(); flushTable();
      if (inCodeBlock && codeBuffer.length > 0) flushCode();

      // Trim trailing empty lines
      while (blocks.length > 0) {
        const last = blocks[blocks.length - 1];
        if (last.type === 'lines') {
          while (last.items.length > 0 && !last.items[last.items.length - 1].text.trim()) last.items.pop();
          if (last.items.length === 0) { blocks.pop(); continue; }
        }
        break;
      }

      const TABLE_PAD = 8;
      const TABLE_ROW_H = LINE_HEIGHT + 12;
      const calcTableH = (t: { rows: string[][] }) => (1 + t.rows.length) * TABLE_ROW_H + TABLE_PAD * 2;
      const calcCodeH = (c: { lines: string[] }) =>
        CODE_HEADER_H + CODE_BLOCK_PAD * 2 + c.lines.length * CODE_LINE_H;

      let answerContentHeight = 0;
      for (const block of blocks) {
        if (block.type === 'lines') answerContentHeight += block.items.length * LINE_HEIGHT;
        else if (block.type === 'hr') answerContentHeight += 8;
        else if (block.type === 'code') answerContentHeight += calcCodeH(block) + 16;
        else if (block.type === 'table') answerContentHeight += calcTableH(block) + 8;
      }
      const totalHeight = PADDING + questionBlockHeight + answerContentHeight + PADDING + FOOTER_HEIGHT;

      canvas.width = WIDTH * scale;
      canvas.height = totalHeight * scale;
      ctx.scale(scale, scale);

      // Background
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, WIDTH, totalHeight);

      let y = PADDING;

      // --- Draw question ---
      if (questionWrapped.length > 0) {
        const qPad = 12;
        const qBlockH = qPad * 2 + (questionWrapped.length - 1) * LINE_HEIGHT + FONT_SIZE + 4;
        ctx.fillStyle = QUESTION_BG;
        ctx.beginPath();
        ctx.roundRect(PADDING - 12, y, WIDTH - PADDING * 2 + 24, qBlockH, 12);
        ctx.fill();

        ctx.save();
        ctx.textBaseline = "top";
        ctx.fillStyle = QUESTION_COLOR;
        let ty = y + qPad;
        for (const ql of questionWrapped) {
          ctx.font = ql.font;
          ctx.fillText(ql.text, PADDING, ty);
          ty += LINE_HEIGHT;
        }
        ctx.restore();

        y += qBlockH + 16;
      }

      // --- Draw answer ---
      const answerStartX = PADDING;
      y += FONT_SIZE;

      for (const block of blocks) {
        if (block.type === 'hr') {
          ctx.strokeStyle = "#2a2a4a";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(answerStartX, y - 2);
          ctx.lineTo(WIDTH - PADDING, y - 2);
          ctx.stroke();
          y += 8;
          continue;
        }
        if (block.type === 'lines') {
          for (const item of block.items) {
            ctx.fillStyle = item.color;
            ctx.font = item.font;
            ctx.fillText(item.text, answerStartX, y);
            y += LINE_HEIGHT;
          }
          continue;
        }
        if (block.type === 'code') {
          const boxX = answerStartX - 8;
          const boxW = WIDTH - PADDING - boxX;
          const boxH = calcCodeH(block);

          // Container
          ctx.save();
          ctx.fillStyle = CODE_BG;
          ctx.beginPath();
          ctx.roundRect(boxX, y, boxW, boxH, CODE_RADIUS);
          ctx.fill();
          ctx.strokeStyle = CODE_BORDER;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();

          // Header
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(boxX, y, boxW, CODE_HEADER_H, [CODE_RADIUS, CODE_RADIUS, 0, 0]);
          ctx.clip();
          ctx.fillStyle = CODE_HEADER_BG;
          ctx.fillRect(boxX, y, boxW, CODE_HEADER_H);
          ctx.restore();

          // Header bottom border
          ctx.strokeStyle = CODE_BORDER;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(boxX, y + CODE_HEADER_H);
          ctx.lineTo(boxX + boxW, y + CODE_HEADER_H);
          ctx.stroke();

          // Language label + line count
          ctx.font = "500 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
          ctx.fillStyle = CODE_LANG_COLOR;
          ctx.textBaseline = "middle";
          const labelY = y + CODE_HEADER_H / 2;
          const lang = block.language || "text";
          ctx.fillText(lang, boxX + CODE_BLOCK_PAD, labelY);
          const langW = ctx.measureText(lang).width;
          ctx.fillStyle = "#6b7280";
          ctx.fillText(`${block.lines.length} lines`, boxX + CODE_BLOCK_PAD + langW + 10, labelY);
          ctx.textBaseline = "alphabetic";

          // Code body
          ctx.font = CODE_FONT;
          ctx.fillStyle = CODE_TEXT_COLOR;
          let cy = y + CODE_HEADER_H + CODE_BLOCK_PAD + 13;
          const cx = boxX + CODE_BLOCK_PAD;
          for (const ln of block.lines) {
            ctx.fillText(ln, cx, cy);
            cy += CODE_LINE_H;
          }

          y += boxH + 16;
          continue;
        }
        if (block.type === 'table') {
          const colCount = block.headers.length;
          const tableX = answerStartX - 8;
          const tableW = WIDTH - PADDING - tableX;

          ctx.font = BOLD_FONT;
          const hdrW = block.headers.map(h => ctx.measureText(h).width + TABLE_PAD * 3);
          ctx.font = TEXT_FONT;
          const dataW = Array(colCount).fill(0) as number[];
          for (const row of block.rows) {
            for (let i = 0; i < colCount && i < row.length; i++) {
              dataW[i] = Math.max(dataW[i], ctx.measureText(row[i] || "").width + TABLE_PAD * 3);
            }
          }
          const natural = hdrW.map((hw, i) => Math.max(hw, dataW[i] || 0));
          const totalN = natural.reduce((a, b) => a + b, 0);
          const colWidths = totalN <= tableW
            ? natural.map(w => w + (tableW - totalN) / colCount)
            : natural.map(w => Math.max(50, (w / totalN) * tableW));

          const tableH = calcTableH(block);

          // Table background
          ctx.fillStyle = "#161630";
          ctx.beginPath();
          ctx.roundRect(tableX, y, tableW, tableH, 8);
          ctx.fill();

          let ty = y + TABLE_PAD;

          // Header row background
          ctx.fillStyle = "#1e1e3e";
          ctx.beginPath();
          ctx.roundRect(tableX, y, tableW, TABLE_ROW_H + TABLE_PAD, [8, 8, 0, 0]);
          ctx.fill();

          // Header text
          let tx = tableX + TABLE_PAD;
          ctx.font = BOLD_FONT;
          ctx.fillStyle = TEXT_COLOR;
          for (let i = 0; i < colCount; i++) {
            const maxCW = colWidths[i] - TABLE_PAD * 2;
            let text = block.headers[i] || "";
            if (ctx.measureText(text).width > maxCW) {
              while (ctx.measureText(text + "…").width > maxCW && text.length > 1) text = text.slice(0, -1);
              text += "…";
            }
            ctx.fillText(text, tx, ty + TABLE_ROW_H / 2 + FONT_SIZE / 2 - 2);
            tx += colWidths[i];
          }
          ty += TABLE_ROW_H;

          // Header separator
          ctx.strokeStyle = "#3a3a5a";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(tableX + 4, ty);
          ctx.lineTo(tableX + tableW - 4, ty);
          ctx.stroke();

          // Data rows
          for (let ri = 0; ri < block.rows.length; ri++) {
            const row = block.rows[ri];
            tx = tableX + TABLE_PAD;
            ctx.font = TEXT_FONT;
            ctx.fillStyle = TEXT_COLOR;
            for (let i = 0; i < colCount; i++) {
              const maxCW = colWidths[i] - TABLE_PAD * 2;
              let text = (row[i] || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1");
              if (ctx.measureText(text).width > maxCW) {
                while (ctx.measureText(text + "…").width > maxCW && text.length > 1) text = text.slice(0, -1);
                text += "…";
              }
              ctx.fillText(text, tx, ty + TABLE_ROW_H / 2 + FONT_SIZE / 2 - 2);
              tx += colWidths[i];
            }
            ty += TABLE_ROW_H;
            if (ri < block.rows.length - 1) {
              ctx.strokeStyle = "#222244";
              ctx.lineWidth = 0.5;
              ctx.beginPath();
              ctx.moveTo(tableX + 4, ty);
              ctx.lineTo(tableX + tableW - 4, ty);
              ctx.stroke();
            }
          }

          // Column separators
          tx = tableX;
          ctx.strokeStyle = "#222244";
          ctx.lineWidth = 0.5;
          for (let i = 0; i < colCount - 1; i++) {
            tx += colWidths[i];
            ctx.beginPath();
            ctx.moveTo(tx, y + TABLE_PAD + TABLE_ROW_H + 4);
            ctx.lineTo(tx, y + tableH - TABLE_PAD);
            ctx.stroke();
          }

          y += tableH + 8;
          continue;
        }
      }

      // --- Footer ---
      const footerY = totalHeight - FOOTER_HEIGHT;
      ctx.fillStyle = "#1a1a30";
      ctx.fillRect(0, footerY, WIDTH, FOOTER_HEIGHT);
      ctx.strokeStyle = "#2a2a4a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, footerY);
      ctx.lineTo(WIDTH, footerY);
      ctx.stroke();

      const logoImg = new window.Image();
      logoImg.crossOrigin = "anonymous";
      const qrDataUrl = await QRCode.toDataURL("https://github.com/braverior/ClaudeBox", {
        width: 80, margin: 0,
        color: { dark: "#e2e8f0", light: "#00000000" },
      });
      const qrImg = new window.Image();
      await Promise.all([
        new Promise<void>((res) => { logoImg.onload = () => res(); logoImg.onerror = () => res(); logoImg.src = logoUrl; }),
        new Promise<void>((res) => { qrImg.onload = () => res(); qrImg.onerror = () => res(); qrImg.src = qrDataUrl; }),
      ]);

      // Logo + name — vertically centered in footer
      const logoSize = 28;
      const logoX = PADDING;
      const contentH = 60;
      const logoY = footerY + (FOOTER_HEIGHT - contentH) / 2;
      if (logoImg.complete && logoImg.naturalWidth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(logoX, logoY, logoSize, logoSize, 6);
        ctx.clip();
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(logoX, logoY, logoSize, logoSize);
        ctx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);
        ctx.restore();
      }
      ctx.fillStyle = TEXT_COLOR;
      ctx.font = "bold 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      const textX = logoX + logoSize + 10;
      ctx.fillText("ClaudeBox", textX, logoY + 14);

      // Install commands — show both platforms
      const monoFont = "11px 'SF Mono', Menlo, Monaco, Consolas, monospace";
      ctx.fillStyle = MUTED_COLOR;
      ctx.font = monoFont;
      ctx.fillText("macOS:    brew tap braverior/tap && brew install --cask claudebox", textX, logoY + 30);
      ctx.fillText("Windows:  扫描右侧二维码或打开下方链接下载安装", textX, logoY + 44);

      // GitHub URL — aligned with install commands
      ctx.fillText("github.com/braverior/ClaudeBox", textX, logoY + 58);

      // QR code
      const qrSize = 48;
      const qrX = WIDTH - PADDING - qrSize;
      const qrY = footerY + (FOOTER_HEIGHT - qrSize) / 2;
      if (qrImg.complete && qrImg.naturalWidth > 0) {
        ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
      }

      const dataUrl = canvas.toDataURL("image/png");
      const base64 = dataUrl.split(",")[1];
      await copyImageToClipboard(base64);
      setShareFeedback("image");
      setTimeout(() => setShareFeedback(null), 2000);
    } catch (err) {
      console.error("Failed to share as image:", err);
    } finally {
      setGenerating(false);
    }
  }, [generating, getMarkdownText, allMessages, messageIndex]);

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
                    onClick={() => {
                      if (att.dataUrl) openImage(att.dataUrl, att.name, att.path);
                    }}
                    title={`${att.name}\n点击查看`}
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
                {textAtts.map((att, i) => (
                  <TextAttachmentChip
                    key={i}
                    att={att}
                    onOpen={() => openFile(att.path)}
                  />
                ))}
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
        <div ref={contentRef} className="min-w-0 flex-1 space-y-1">
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
                {sep}
                {shareFeedback ? (
                  <span className="flex items-center gap-1 text-success">
                    <Check size={10} />
                    {t("message.copied")}
                  </span>
                ) : generating ? (
                  <span className="flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" />
                    {t("message.generating")}
                  </span>
                ) : (
                  <div className="relative" ref={sharePopoverRef}>
                    <button
                      onClick={() => setShareOpen(!shareOpen)}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-white/5 transition-colors"
                    >
                      <Share2 size={10} />
                      <span>{t("message.share")}</span>
                    </button>
                    {shareOpen && (
                      <div className="absolute bottom-full left-0 mb-1.5 bg-bg-secondary border border-border rounded-lg shadow-2xl overflow-hidden z-50 min-w-[140px]">
                        <button
                          onClick={handleShareText}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                        >
                          <Copy size={12} />
                          {t("message.shareAsText")}
                        </button>
                        <button
                          onClick={handleShareImage}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                        >
                          <ImageIcon size={12} />
                          {t("message.shareAsImage")}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

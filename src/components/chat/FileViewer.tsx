import { useState, useEffect, useRef, useCallback, memo } from "react";
import { X, Copy, Check, Loader2, Code2, Eye } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { readFile, readImageBase64 } from "../../lib/claude-ipc";
import { useT } from "../../lib/i18n";
import CodeBlock from "./CodeBlock";
import hljs from "highlight.js";
import type { ComponentPropsWithoutRef } from "react";

// Same lookbehind guard as MessageBubble
let supportsLookbehind = false;
try { new RegExp("(?<=a)b"); supportsLookbehind = true; } catch { /* old WebKit */ }
const remarkPlugins = supportsLookbehind ? [remarkGfm] : [];

// ── Types ────────────────────────────────────────────────────────────

export interface FileViewerProps {
  /** Ordered list of open file paths */
  files: string[];
  /** Index of the currently active tab */
  activeIndex: number;
  /** Switch to a tab */
  onSelectTab: (index: number) => void;
  /** Close a single tab */
  onCloseTab: (index: number) => void;
  /** Close all tabs (exit viewer) */
  onCloseAll: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  rs: "rust", py: "python", go: "go", json: "json",
  html: "html", css: "css", scss: "scss", md: "markdown",
  yaml: "yaml", yml: "yaml", toml: "toml",
  sh: "bash", zsh: "bash", bash: "bash", sql: "sql", xml: "xml",
  swift: "swift", kt: "kotlin", java: "java",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  rb: "ruby", php: "php", lua: "lua", zig: "zig",
  mjs: "javascript", cjs: "javascript",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const SVG_EXT = "svg";
const MD_EXT = "md";
const HTML_EXTS = new Set(["html", "htm"]);

function getExt(filePath: string): string {
  return filePath.split(".").pop()?.toLowerCase() || "";
}

function getLang(filePath: string): string | undefined {
  return EXT_TO_LANG[getExt(filePath)];
}

function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

type PreviewType = "image" | "svg" | "markdown" | "html" | "code";

function getPreviewType(filePath: string): PreviewType {
  const ext = getExt(filePath);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === SVG_EXT) return "svg";
  if (ext === MD_EXT) return "markdown";
  if (HTML_EXTS.has(ext)) return "html";
  return "code";
}

// ── Per-tab content panel (memoized to avoid re-fetching on tab switch) ──

interface TabContentProps {
  filePath: string;
  isActive: boolean;
}

const TabContent = memo(function TabContent({ filePath, isActive }: TabContentProps) {
  const [content, setContent] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const t = useT();

  const previewType = getPreviewType(filePath);
  const lang = getLang(filePath);
  const lineCount = content?.split("\n").length ?? 0;

  // Fetch content
  useEffect(() => {
    setContent(null);
    setImageDataUrl(null);
    setError(null);
    setShowSource(false);

    if (previewType === "image") {
      readImageBase64(filePath)
        .then(setImageDataUrl)
        .catch((err) => setError(String(err)));
    } else {
      readFile(filePath)
        .then(setContent)
        .catch((err) => setError(String(err)));
    }
  }, [filePath, previewType]);

  // Syntax highlight for code view
  useEffect(() => {
    if (codeRef.current && content !== null && lang && (previewType === "code" || showSource)) {
      try {
        codeRef.current.removeAttribute("data-highlighted");
        hljs.highlightElement(codeRef.current);
      } catch { /* ignore */ }
    }
  }, [content, lang, previewType, showSource]);

  const handleCopy = useCallback(() => {
    if (content) {
      navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [content]);

  if (!isActive) return null;

  // ── Toolbar (right side of header) ──
  const toolbar = (
    <div className="flex items-center gap-1 flex-shrink-0">
      {/* Toggle source / preview for markdown & html */}
      {(previewType === "markdown" || previewType === "html" || previewType === "svg") && content !== null && (
        <button
          onClick={() => setShowSource((v) => !v)}
          className="flex items-center gap-1 px-1.5 py-1 rounded text-text-muted hover:text-text-primary transition-colors text-[11px]"
          title={showSource ? t("viewer.preview") : t("viewer.source")}
        >
          {showSource ? <Eye size={12} /> : <Code2 size={12} />}
          <span>{showSource ? t("viewer.preview") : t("viewer.source")}</span>
        </button>
      )}
      {content !== null && (
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-1.5 py-1 rounded text-text-muted hover:text-text-primary transition-colors"
          title={t("viewer.copyContent")}
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
        </button>
      )}
    </div>
  );

  // ── Meta info (below tabs, above content) ──
  const metaBar = (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-code-header/50 flex-shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        {lang && (
          <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded bg-bg-tertiary/50 flex-shrink-0">
            {lang}
          </span>
        )}
        {content !== null && previewType === "code" && (
          <span className="text-[10px] text-text-muted/50 flex-shrink-0">
            {lineCount} {t("viewer.lines")}
          </span>
        )}
      </div>
      {toolbar}
    </div>
  );

  // ── Loading / Error ──
  if ((previewType === "image" ? imageDataUrl : content) === null && !error) {
    return (
      <>
        {metaBar}
        <div className="flex-1 flex items-center gap-2 p-4 text-xs text-text-muted bg-code-bg">
          <Loader2 size={12} className="animate-spin" />
          {t("viewer.loading")}
        </div>
      </>
    );
  }
  if (error) {
    return (
      <>
        {metaBar}
        <div className="flex-1 p-4 text-xs text-error bg-code-bg">{error}</div>
      </>
    );
  }

  // ── Image preview ──
  if (previewType === "image" && imageDataUrl) {
    return (
      <>
        {metaBar}
        <div className="flex-1 overflow-auto bg-code-bg flex items-center justify-center p-4">
          <img
            src={imageDataUrl}
            alt={getFileName(filePath)}
            className="max-w-full max-h-full object-contain rounded shadow-lg"
            style={{ imageRendering: "auto" }}
          />
        </div>
      </>
    );
  }

  // ── SVG — preview or source ──
  if (previewType === "svg" && content !== null) {
    return (
      <>
        {metaBar}
        {showSource ? (
          <div className="flex-1 overflow-auto bg-code-bg">
            <pre className="p-3 text-[0.8rem] leading-[1.6] m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
              <code ref={codeRef} className="language-xml">{content}</code>
            </pre>
          </div>
        ) : (
          <div
            className="flex-1 overflow-auto bg-code-bg flex items-center justify-center p-4"
            dangerouslySetInnerHTML={{ __html: content }}
          />
        )}
      </>
    );
  }

  // ── Markdown — rendered or source ──
  if (previewType === "markdown" && content !== null) {
    return (
      <>
        {metaBar}
        {showSource ? (
          <div className="flex-1 overflow-auto bg-code-bg">
            <pre className="p-3 text-[0.8rem] leading-[1.6] m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
              <code ref={codeRef} className="language-markdown">{content}</code>
            </pre>
          </div>
        ) : (
          <div className="flex-1 overflow-auto bg-code-bg p-4">
            <div className="markdown-body max-w-none prose-invert">
              <ReactMarkdown
                remarkPlugins={remarkPlugins}
                components={{
                  code(props: ComponentPropsWithoutRef<"code">) {
                    const { className, children, ...rest } = props;
                    const match = /language-(\w+)/.exec(className || "");
                    const code = String(children).replace(/\n$/, "");
                    const isBlock = match || code.includes("\n");
                    if (isBlock) {
                      return <CodeBlock code={code} language={match ? match[1] : undefined} />;
                    }
                    return <code className={className} {...rest}>{children}</code>;
                  },
                  pre({ children }) { return <>{children}</>; },
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </>
    );
  }

  // ── HTML — rendered or source ──
  if (previewType === "html" && content !== null) {
    return (
      <>
        {metaBar}
        {showSource ? (
          <div className="flex-1 overflow-auto bg-code-bg">
            <pre className="p-3 text-[0.8rem] leading-[1.6] m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
              <code ref={codeRef} className="language-html">{content}</code>
            </pre>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden bg-white">
            <iframe
              srcDoc={content}
              title={getFileName(filePath)}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        )}
      </>
    );
  }

  // ── Default: code with syntax highlighting + line numbers ──
  const lines = content?.split("\n") ?? [];
  return (
    <>
      {metaBar}
      <div className="flex-1 overflow-auto bg-code-bg">
        <div className="flex min-w-0">
          {/* Line numbers */}
          <div
            aria-hidden
            className="select-none flex-shrink-0 text-right py-3 pr-3 pl-3
                       text-[0.75rem] leading-[1.6] text-text-muted/30 bg-code-bg
                       border-r border-border/20 font-mono"
          >
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          {/* Code */}
          <pre className="flex-1 py-3 px-3 text-[0.8rem] leading-[1.6] m-0 whitespace-pre [overflow-wrap:normal] overflow-x-auto">
            <code ref={codeRef} className={lang ? `language-${lang}` : ""}>{content}</code>
          </pre>
        </div>
      </div>
    </>
  );
});

// ── Main tabbed viewer ───────────────────────────────────────────────

export default function FileViewer({
  files,
  activeIndex,
  onSelectTab,
  onCloseTab,
  onCloseAll,
}: FileViewerProps) {
  const t = useT();
  const tabBarRef = useRef<HTMLDivElement>(null);

  // Handle mouse wheel on tab bar for horizontal scrolling
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (tabBarRef.current) {
      tabBarRef.current.scrollLeft += e.deltaY;
    }
  }, []);

  // Close tab via middle-click
  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, index: number) => {
      if (e.button === 1) {
        e.preventDefault();
        onCloseTab(index);
      }
    },
    [onCloseTab]
  );

  const activeFile = files[activeIndex];
  if (!activeFile) return null;

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center bg-code-header border-b border-border flex-shrink-0">
        <div
          ref={tabBarRef}
          className="flex-1 flex items-center overflow-x-auto scrollbar-none min-w-0"
          onWheel={handleWheel}
        >
          {files.map((filePath, i) => {
            const name = getFileName(filePath);
            const isActive = i === activeIndex;
            return (
              <div
                key={filePath}
                className={`group flex items-center gap-1.5 pl-3 pr-1 py-1.5 cursor-pointer
                  border-r border-border/50 flex-shrink-0 max-w-[180px] transition-colors
                  ${isActive
                    ? "bg-code-bg text-text-primary border-b-2 border-b-accent"
                    : "text-text-muted hover:text-text-secondary hover:bg-code-bg/50 border-b-2 border-b-transparent"
                  }`}
                onClick={() => onSelectTab(i)}
                onMouseDown={(e) => handleTabMouseDown(e, i)}
                title={filePath}
              >
                <span className="text-xs truncate select-none">{name}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onCloseTab(i); }}
                  className="flex-shrink-0 p-0.5 rounded hover:bg-bg-tertiary/50 opacity-0 group-hover:opacity-100
                             transition-opacity text-text-muted hover:text-text-primary"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
        {/* Close all button */}
        <button
          onClick={onCloseAll}
          className="flex-shrink-0 p-1.5 mx-1 rounded hover:bg-bg-tertiary/50 text-text-muted hover:text-text-primary transition-colors"
          title={t("viewer.closeAll")}
        >
          <X size={14} />
        </button>
      </div>

      {/* Active tab content */}
      {files.map((filePath, i) => (
        <TabContent key={filePath} filePath={filePath} isActive={i === activeIndex} />
      ))}
    </div>
  );
}

import { useState, useEffect, useRef, useCallback, memo, useMemo } from "react";
import { X, Copy, Check, Loader2, Code2, Eye, Minus, Save } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfmSafe from "../../lib/remark-gfm-safe";
import { readFile, readImageBase64, writeFile } from "../../lib/claude-ipc";
import { useT } from "../../lib/i18n";
import CodeBlock from "./CodeBlock";
import hljs from "highlight.js";
import type { ComponentPropsWithoutRef } from "react";

const remarkPlugins = [remarkGfmSafe];

// ── Types ────────────────────────────────────────────────────────────

export interface FileViewerProps {
  files: string[];
  activeIndex: number;
  changedFiles?: Set<string>;
  onSelectTab: (index: number) => void;
  onCloseTab: (index: number) => void;
  onCloseAll: () => void;
  onMinimize: () => void;
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

function isTextFile(filePath: string): boolean {
  return !IMAGE_EXTS.has(getExt(filePath));
}

function computeHighlightedHtml(text: string, language: string | undefined): string {
  if (!text) return "";
  if (language) {
    try {
      return hljs.highlight(text, { language }).value;
    } catch { /* ignore */ }
  }
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Editable code area (textarea overlaid on highlighted pre) ─────────

interface EditableCodeAreaProps {
  editContent: string;
  lang: string | undefined;
  onChange: (value: string) => void;
  onSave?: () => void;
  lineNumbersRef?: React.RefObject<HTMLDivElement | null>;
}

function EditableCodeArea({ editContent, lang, onChange, onSave, lineNumbersRef }: EditableCodeAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const [activeLine, setActiveLine] = useState(0);

  const highlightedHtml = useMemo(
    () => computeHighlightedHtml(editContent, lang),
    [editContent, lang]
  );

  const lines = editContent.split("\n");

  const updateActiveLine = useCallback((ta: HTMLTextAreaElement) => {
    const line = ta.value.substring(0, ta.selectionStart).split("\n").length - 1;
    setActiveLine(line);
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    updateActiveLine(e.target);
  }, [onChange, updateActiveLine]);

  const syncScroll = useCallback(() => {
    if (!textareaRef.current) return;
    const { scrollTop, scrollLeft } = textareaRef.current;
    if (preRef.current) {
      preRef.current.scrollTop = scrollTop;
      preRef.current.scrollLeft = scrollLeft;
    }
    if (lineNumbersRef?.current) {
      lineNumbersRef.current.scrollTop = scrollTop;
    }
  }, [lineNumbersRef]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = textareaRef.current!;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const spaces = "  ";
      const newValue = editContent.substring(0, start) + spaces + editContent.substring(end);
      onChange(newValue);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = start + spaces.length;
          textareaRef.current.selectionEnd = start + spaces.length;
          updateActiveLine(textareaRef.current);
        }
      });
    }
  }, [editContent, onChange, onSave, updateActiveLine]);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-code-bg">
      {/* Line numbers — block divs naturally align with code rows */}
      <div
        ref={lineNumbersRef}
        aria-hidden
        className="flex-shrink-0 text-right py-3 pr-3 pl-3 select-none
                   text-[0.8rem] leading-[1.6] text-text-muted/60 bg-code-bg
                   border-r border-border/20 font-mono overflow-hidden"
      >
        {lines.map((_, i) => (
          <div
            key={i}
            className={i === activeLine ? "text-text-primary bg-white/[0.12] -mx-3 px-3" : ""}
          >
            {i + 1}
          </div>
        ))}
      </div>
      {/* Code area */}
      <div className="relative flex-1 min-w-0 overflow-hidden">
        <pre
          ref={preRef}
          aria-hidden
          className="file-editor-pre absolute inset-0 py-3 px-3 m-0 pointer-events-none font-mono
                     text-[0.8rem] leading-[1.6] overflow-hidden whitespace-pre"
          style={{ zIndex: 1 }}
        >
          <code
            className={lang ? `language-${lang} hljs` : "hljs"}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        </pre>
        <textarea
          ref={textareaRef}
          value={editContent}
          onChange={handleChange}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          onKeyUp={(e) => updateActiveLine(e.currentTarget)}
          onClick={(e) => updateActiveLine(e.currentTarget)}
          onSelect={(e) => updateActiveLine(e.currentTarget)}
          className="absolute inset-0 w-full h-full py-3 px-3 font-mono
                     text-[0.8rem] leading-[1.6] bg-transparent text-transparent resize-none
                     border-none outline-none ring-0 whitespace-pre overflow-auto
                     [caret-color:#e2e8f0]"
          style={{ zIndex: 3 }}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>
    </div>
  );
}

// ── Per-tab content panel (memoized to avoid re-fetching on tab switch) ──

interface TabContentProps {
  filePath: string;
  isActive: boolean;
  onDirtyChange: (filePath: string, dirty: boolean) => void;
}

const TabContent = memo(function TabContent({ filePath, isActive, onDirtyChange }: TabContentProps) {
  const [content, setContent] = useState<string | null>(null); // original from disk
  const [editContent, setEditContent] = useState<string>("");   // working copy
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [saving, setSaving] = useState(false);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const t = useT();

  const previewType = getPreviewType(filePath);
  const lang = getLang(filePath);
  const canEdit = isTextFile(filePath);
  const isDirty = canEdit && content !== null && editContent !== content;

  // Fetch content on mount / path change
  useEffect(() => {
    setContent(null);
    setEditContent("");
    setImageDataUrl(null);
    setError(null);
    setShowSource(false);
    onDirtyChange(filePath, false);

    if (previewType === "image") {
      readImageBase64(filePath)
        .then(setImageDataUrl)
        .catch((err) => setError(String(err)));
    } else {
      readFile(filePath)
        .then((text) => {
          setContent(text);
          setEditContent(text);
        })
        .catch((err) => setError(String(err)));
    }
  }, [filePath, previewType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify parent whenever dirty state changes
  useEffect(() => {
    onDirtyChange(filePath, isDirty);
  }, [isDirty, filePath, onDirtyChange]);

  const handleEditChange = useCallback((value: string) => {
    setEditContent(value);
  }, []);

  const handleCopy = useCallback(() => {
    const text = content;
    if (text) {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [content]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await writeFile(filePath, editContent);
      setContent(editContent); // update baseline → isDirty becomes false
      onDirtyChange(filePath, false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [filePath, editContent, saving, onDirtyChange]);

  if (!isActive) return null;

  // Source language for md/html/svg source view
  const sourceLang =
    previewType === "markdown" ? "markdown"
    : previewType === "html" ? "html"
    : previewType === "svg" ? "xml"
    : lang;

  // ── Toolbar ──
  const toolbar = (
    <div className="flex items-center gap-1 flex-shrink-0">
      {/* Source/Preview toggle for md, html, svg */}
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
      {/* Save button — only when dirty */}
      {isDirty && (
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1 px-1.5 py-1 rounded bg-accent/15 text-accent
                     hover:bg-accent/25 transition-colors text-[11px] disabled:opacity-50"
          title={t("viewer.save")}
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          <span>{t("viewer.save")}</span>
        </button>
      )}
      {/* Copy */}
      {content !== null && !isDirty && (
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

  // ── Meta bar ──
  const lineCount = editContent.split("\n").length;
  const metaBar = (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-code-header/50 flex-shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        {(sourceLang || lang) && (
          <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded bg-bg-tertiary/50 flex-shrink-0">
            {previewType === "code" ? lang : (showSource ? sourceLang : t("viewer.preview"))}
          </span>
        )}
        {content !== null && (previewType === "code" || showSource) && (
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

  // ── Image ──
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

  // ── SVG: source (editable) or rendered ──
  if (previewType === "svg" && content !== null) {
    return (
      <>
        {metaBar}
        {showSource ? (
          <EditableCodeArea
            editContent={editContent}
            lang="xml"
            onChange={handleEditChange}
            onSave={handleSave}
            lineNumbersRef={lineNumbersRef}
          />
        ) : (
          <div
            className="flex-1 overflow-auto bg-code-bg flex items-center justify-center p-4"
            dangerouslySetInnerHTML={{ __html: editContent }}
          />
        )}
      </>
    );
  }

  // ── Markdown: source (editable) or rendered ──
  if (previewType === "markdown" && content !== null) {
    return (
      <>
        {metaBar}
        {showSource ? (
          <EditableCodeArea
            editContent={editContent}
            lang="markdown"
            onChange={handleEditChange}
            onSave={handleSave}
            lineNumbersRef={lineNumbersRef}
          />
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
                {editContent}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </>
    );
  }

  // ── HTML: source (editable) or rendered ──
  if (previewType === "html" && content !== null) {
    return (
      <>
        {metaBar}
        {showSource ? (
          <EditableCodeArea
            editContent={editContent}
            lang="html"
            onChange={handleEditChange}
            onSave={handleSave}
            lineNumbersRef={lineNumbersRef}
          />
        ) : (
          <div className="flex-1 overflow-hidden bg-white">
            <iframe
              srcDoc={editContent}
              title={getFileName(filePath)}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        )}
      </>
    );
  }

  // ── Default: editable code with syntax highlighting ──
  return (
    <>
      {metaBar}
      <EditableCodeArea
        editContent={editContent}
        lang={lang}
        onChange={handleEditChange}
        onSave={handleSave}
        lineNumbersRef={lineNumbersRef}
      />
    </>
  );
});

// ── Main tabbed viewer ───────────────────────────────────────────────

export default function FileViewer({
  files,
  activeIndex,
  changedFiles,
  onSelectTab,
  onCloseTab,
  onCloseAll,
  onMinimize,
}: FileViewerProps) {
  const t = useT();
  const tabBarRef = useRef<HTMLDivElement>(null);
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});

  const handleDirtyChange = useCallback((filePath: string, dirty: boolean) => {
    setDirtyFiles((prev) => {
      if (prev[filePath] === dirty) return prev;
      return { ...prev, [filePath]: dirty };
    });
  }, []);

  // Confirm before closing a dirty tab
  const handleCloseTab = useCallback((index: number) => {
    const filePath = files[index];
    if (dirtyFiles[filePath]) {
      const name = getFileName(filePath);
      if (!window.confirm(`"${name}" ${t("viewer.unsaved")}，确定关闭？`)) return;
    }
    // Clean up dirty state
    setDirtyFiles((prev) => {
      const next = { ...prev };
      delete next[files[index]];
      return next;
    });
    onCloseTab(index);
  }, [files, dirtyFiles, t, onCloseTab]);

  const handleCloseAll = useCallback(() => {
    const hasDirty = files.some((f) => dirtyFiles[f]);
    if (hasDirty) {
      if (!window.confirm(t("viewer.unsaved") + " — 确定关闭全部？")) return;
    }
    setDirtyFiles({});
    onCloseAll();
  }, [files, dirtyFiles, t, onCloseAll]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (tabBarRef.current) {
      tabBarRef.current.scrollLeft += e.deltaY;
    }
  }, []);

  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, index: number) => {
      if (e.button === 1) {
        e.preventDefault();
        handleCloseTab(index);
      }
    },
    [handleCloseTab]
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
            const isDirty = dirtyFiles[filePath] === true;
            const isGitChanged = changedFiles?.has(filePath) === true;
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
                {/* Unsaved dot (amber) */}
                {isDirty && (
                  <span
                    className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-amber-400"
                    title={t("viewer.unsaved")}
                  />
                )}
                {/* Git-changed dot (emerald) — only when no unsaved changes */}
                {!isDirty && isGitChanged && (
                  <span
                    className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-400"
                    title={t("viewer.gitChanged")}
                  />
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleCloseTab(i); }}
                  className="flex-shrink-0 p-0.5 rounded hover:bg-bg-tertiary/50 opacity-0 group-hover:opacity-100
                             transition-opacity text-text-muted hover:text-text-primary"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          onClick={onMinimize}
          className="flex-shrink-0 p-1.5 mx-0.5 rounded hover:bg-bg-tertiary/50 text-text-muted hover:text-text-primary transition-colors"
          title={t("viewer.minimize")}
        >
          <Minus size={14} />
        </button>
        <button
          onClick={handleCloseAll}
          className="flex-shrink-0 p-1.5 mr-1 rounded hover:bg-bg-tertiary/50 text-text-muted hover:text-text-primary transition-colors"
          title={t("viewer.closeAll")}
        >
          <X size={14} />
        </button>
      </div>

      {/* Active tab content */}
      {files.map((filePath, i) => (
        <TabContent
          key={filePath}
          filePath={filePath}
          isActive={i === activeIndex}
          onDirtyChange={handleDirtyChange}
        />
      ))}
    </div>
  );
}

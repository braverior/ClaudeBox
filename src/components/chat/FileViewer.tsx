import { useState, useEffect, useRef, useCallback } from "react";
import { X, Copy, Check, Loader2 } from "lucide-react";
import { readFile } from "../../lib/claude-ipc";
import { useT } from "../../lib/i18n";
import hljs from "highlight.js";

interface FileViewerProps {
  filePath: string;
  onClose: () => void;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  rs: "rust",
  py: "python",
  go: "go",
  json: "json",
  html: "html",
  css: "css",
  scss: "scss",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  zsh: "bash",
  bash: "bash",
  sql: "sql",
  xml: "xml",
  swift: "swift",
  kt: "kotlin",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  lua: "lua",
  zig: "zig",
  mjs: "javascript",
  cjs: "javascript",
};

function getLang(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return EXT_TO_LANG[ext];
}

export default function FileViewer({ filePath, onClose }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const t = useT();
  const fileName = filePath.split("/").pop() || filePath;
  const lang = getLang(filePath);

  useEffect(() => {
    setContent(null);
    setError(null);
    readFile(filePath)
      .then(setContent)
      .catch((err) => setError(String(err)));
  }, [filePath]);

  useEffect(() => {
    if (codeRef.current && content !== null && lang) {
      try {
        codeRef.current.removeAttribute("data-highlighted");
        hljs.highlightElement(codeRef.current);
      } catch {
        // ignore
      }
    }
  }, [content, lang]);

  const handleCopy = useCallback(() => {
    if (content) {
      navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [content]);

  const lineCount = content?.split("\n").length ?? 0;

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-code-header flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-text-primary truncate">
            {fileName}
          </span>
          {lang && (
            <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded bg-bg-tertiary/50 flex-shrink-0">
              {lang}
            </span>
          )}
          {content !== null && (
            <span className="text-[10px] text-text-muted/50 flex-shrink-0">
              {lineCount} {t("viewer.lines")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {content !== null && (
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-text-muted hover:text-text-primary transition-colors"
              title={t("viewer.copyContent")}
            >
              {copied ? (
                <Check size={12} className="text-success" />
              ) : (
                <Copy size={12} />
              )}
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-tertiary/50 text-text-muted hover:text-text-primary transition-colors"
            title={t("viewer.close")}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto bg-code-bg">
        {content === null && !error && (
          <div className="flex items-center gap-2 p-4 text-xs text-text-muted">
            <Loader2 size={12} className="animate-spin" />
            {t("viewer.loading")}
          </div>
        )}
        {error && (
          <div className="p-4 text-xs text-error">{error}</div>
        )}
        {content !== null && (
          <pre className="p-3 text-[0.8rem] leading-[1.6] m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
            <code
              ref={codeRef}
              className={lang ? `language-${lang}` : ""}
            >
              {content}
            </code>
          </pre>
        )}
      </div>
    </div>
  );
}

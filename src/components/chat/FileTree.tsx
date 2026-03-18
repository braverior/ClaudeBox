import { useState, useEffect, useCallback, useRef } from "react";
import { listDir, revealInFinder, gitDiff, type DirEntry } from "../../lib/claude-ipc";
import { useT } from "../../lib/i18n";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileText,
  FileCode,
  FileJson,
  Image,
  File,
  RefreshCw,
  GitBranch,
  X,
} from "lucide-react";

// ── File icons ───────────────────────────────────────────────────────

const EXT_ICONS: Record<string, React.ReactNode> = {
  ts: <FileCode size={14} className="text-blue-400" />,
  tsx: <FileCode size={14} className="text-blue-400" />,
  js: <FileCode size={14} className="text-yellow-400" />,
  jsx: <FileCode size={14} className="text-yellow-400" />,
  json: <FileJson size={14} className="text-yellow-600" />,
  md: <FileText size={14} className="text-text-muted" />,
  css: <FileCode size={14} className="text-purple-400" />,
  html: <FileCode size={14} className="text-orange-400" />,
  rs: <FileCode size={14} className="text-orange-500" />,
  go: <FileCode size={14} className="text-cyan-400" />,
  py: <FileCode size={14} className="text-green-400" />,
  png: <Image size={14} className="text-pink-400" />,
  jpg: <Image size={14} className="text-pink-400" />,
  svg: <Image size={14} className="text-pink-400" />,
};

function getFileIcon(name: string): React.ReactNode {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return EXT_ICONS[ext] || <File size={14} className="text-text-muted" />;
}

// ── Context menu ─────────────────────────────────────────────────────

interface ContextMenuState {
  x: number;
  y: number;
  entry: DirEntry;
}

function ContextMenu({ menu, onClose, onShowDiff }: {
  menu: ContextMenuState;
  onClose: () => void;
  onShowDiff: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const handleReveal = useCallback(() => {
    revealInFinder(menu.entry.path).catch(() => {});
    onClose();
  }, [menu.entry.path, onClose]);

  const handleShowDiff = useCallback(() => {
    onClose();
    onShowDiff();
  }, [onClose, onShowDiff]);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-bg-secondary shadow-xl py-1 animate-fade-in"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        onClick={handleReveal}
        className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-accent/10 hover:text-text-primary transition-colors"
      >
        {menu.entry.is_dir ? t("files.openInFinder") : t("files.revealInFinder")}
      </button>
      <div className="my-1 border-t border-border/50" />
      <button
        onClick={handleShowDiff}
        className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-accent/10 hover:text-text-primary transition-colors flex items-center gap-2"
      >
        <GitBranch size={11} />
        查看全部 Diff
      </button>
    </div>
  );
}

// ── DiffViewer Modal ──────────────────────────────────────────────────

interface DiffFile {
  filename: string;
  lines: string[];
}

function parseDiffByFile(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      // Extract filename: "diff --git a/foo/bar.ts b/foo/bar.ts" → "foo/bar.ts"
      const m = line.match(/diff --git a\/.+ b\/(.+)/);
      current = { filename: m ? m[1] : line, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) files.push(current);
  return files;
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-text-muted";
  if (line.startsWith("+")) return "text-emerald-400 bg-emerald-400/5";
  if (line.startsWith("-")) return "text-red-400 bg-red-400/5";
  if (line.startsWith("@@")) return "text-blue-400 bg-blue-400/5";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-accent/70";
  return "text-text-secondary";
}

function DiffViewer({ rootPath, onClose }: { rootPath: string; onClose: () => void }) {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    setLoading(true);
    gitDiff(rootPath)
      .then((d) => {
        const parsed = parseDiffByFile(d);
        setFiles(parsed);
        if (parsed.length > 0) setActiveFile(parsed[0].filename);
        setLoading(false);
      })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [rootPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Update activeFile as user scrolls
  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    let current = files[0]?.filename ?? "";
    for (const f of files) {
      const el = fileRefs.current[f.filename];
      if (!el) continue;
      const top = el.getBoundingClientRect().top - containerTop;
      if (top <= 4) current = f.filename;
    }
    setActiveFile(current);
  }, [files]);

  const scrollToFile = useCallback((filename: string) => {
    const el = fileRefs.current[filename];
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveFile(filename);
  }, []);

  const shortName = (f: string) => f.split("/").pop() ?? f;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative flex flex-col bg-bg-primary border border-border rounded-xl shadow-2xl w-[900px] max-w-[92vw] h-[75vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <GitBranch size={13} className="text-accent" />
            Git Diff
            <span className="text-xs text-text-muted font-normal">{rootPath.split("/").pop()}</span>
            {files.length > 0 && (
              <span className="text-[10px] px-1.5 py-px rounded bg-accent/15 text-accent/80">{files.length} 个文件</span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-tertiary/50 text-text-muted hover:text-text-primary transition-colors">
            <X size={14} />
          </button>
        </div>

        {loading && (
          <div className="flex items-center gap-2 px-4 py-6 text-xs text-text-muted flex-1">
            <RefreshCw size={12} className="animate-spin" /> 加载中...
          </div>
        )}
        {error && <div className="px-4 py-4 text-xs text-red-400 flex-1">{error}</div>}
        {!loading && !error && files.length === 0 && (
          <div className="px-4 py-6 text-xs text-text-muted flex-1">没有未提交的改动</div>
        )}

        {!loading && !error && files.length > 0 && (
          <div className="flex flex-1 min-h-0">
            {/* Left: file list */}
            <div className="w-52 flex-shrink-0 border-r border-border overflow-y-auto py-1">
              {files.map((f) => (
                <button
                  key={f.filename}
                  onClick={() => scrollToFile(f.filename)}
                  title={f.filename}
                  className={`w-full text-left px-3 py-1.5 text-[11px] truncate transition-colors
                    ${activeFile === f.filename
                      ? "bg-accent/15 text-accent font-medium"
                      : "text-text-muted hover:text-text-primary hover:bg-bg-tertiary/40"}`}
                >
                  {shortName(f.filename)}
                  <div className="text-[10px] opacity-50 truncate">{f.filename.split("/").slice(0, -1).join("/")}</div>
                </button>
              ))}
            </div>

            {/* Right: diff content */}
            <div className="flex-1 flex flex-col min-w-0">
              {/* Sticky current file banner */}
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-bg-secondary border-b border-border flex-shrink-0 text-[11px]">
                <FileCode size={11} className="text-accent flex-shrink-0" />
                <span className="text-text-primary font-medium truncate">{activeFile}</span>
              </div>

              <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-auto">
                {files.map((f) => (
                  <div key={f.filename} ref={(el) => { fileRefs.current[f.filename] = el; }}>
                    {/* Per-file header */}
                    <div className="sticky top-0 z-10 flex items-center gap-1.5 px-3 py-1 bg-bg-secondary/95 backdrop-blur-sm border-b border-border text-[11px]">
                      <FileCode size={10} className="text-accent/70 flex-shrink-0" />
                      <span className="text-text-muted truncate">{f.filename}</span>
                    </div>
                    <pre className="text-[11px] leading-5 font-mono whitespace-pre">
                      {f.lines.map((line, i) => (
                        <span key={i} className={`block px-3 ${lineClass(line)}`}>{line || "\u00a0"}</span>
                      ))}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── TreeNode ──────────────────────────────────────────────────────────

function TreeNode({
  entry,
  depth,
  changedFiles,
  onFileSelect,
  onContextMenu,
}: {
  entry: DirEntry;
  depth: number;
  changedFiles: Set<string>;
  onFileSelect?: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: DirEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const t = useT();

  const toggle = useCallback(async () => {
    if (!entry.is_dir) { onFileSelect?.(entry.path); return; }
    if (!expanded && children === null) {
      setLoading(true);
      try { setChildren(await listDir(entry.path)); }
      catch { setChildren([]); }
      setLoading(false);
    }
    setExpanded(!expanded);
  }, [entry, expanded, children, onFileSelect]);

  const isChanged = entry.is_dir
    ? [...changedFiles].some((f) => f.startsWith(entry.path + "/"))
    : changedFiles.has(entry.path);

  return (
    <div>
      <button
        onClick={toggle}
        onContextMenu={(e) => onContextMenu(e, entry)}
        className={`flex items-center gap-1.5 w-full text-left py-1 pr-2 text-xs
                    hover:bg-accent/10 active:bg-accent/15 transition-colors rounded-sm
                    ${entry.is_dir ? "text-text-primary" : "text-text-secondary hover:text-text-primary"}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {entry.is_dir ? (
          <>
            {expanded
              ? <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
              : <ChevronRight size={12} className="text-text-muted flex-shrink-0" />}
            <Folder size={14} className="text-accent/70 flex-shrink-0" />
          </>
        ) : (
          <>
            <span className="w-3 flex-shrink-0" />
            {getFileIcon(entry.name)}
          </>
        )}
        <span className="flex items-center gap-1 min-w-0 flex-1">
          <span className="truncate">{entry.name}</span>
          {isChanged && (
            <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-400" title="Uncommitted changes" />
          )}
        </span>
      </button>
      {entry.is_dir && expanded && (
        <div>
          {loading && (
            <div className="flex items-center gap-1.5 py-1 text-xs text-text-muted" style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}>
              <RefreshCw size={10} className="animate-spin" />
              {t("files.loading")}
            </div>
          )}
          {children?.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1}
              changedFiles={changedFiles} onFileSelect={onFileSelect} onContextMenu={onContextMenu} />
          ))}
          {children?.length === 0 && !loading && (
            <div className="py-1 text-xs text-text-muted italic" style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}>
              {t("files.empty")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── FileTree ──────────────────────────────────────────────────────────

interface FileTreeProps {
  rootPath: string;
  changedFiles?: Set<string>;
  onFileSelect?: (path: string) => void;
  refreshKey?: number;
}

export default function FileTree({ rootPath, changedFiles = new Set(), onFileSelect, refreshKey }: FileTreeProps) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const t = useT();

  const loadRoot = useCallback(async () => {
    setLoading(true);
    try { setEntries(await listDir(rootPath)); }
    catch { setEntries([]); }
    setLoading(false);
  }, [rootPath]);

  useEffect(() => { loadRoot(); }, [loadRoot, refreshKey]);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 100);
    setContextMenu({ x, y, entry });
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-text-secondary">{t("files.title")}</span>
        <button onClick={loadRoot} className="p-1 rounded hover:bg-bg-tertiary/50 text-text-muted hover:text-text-primary transition-colors" title={t("files.refresh")}>
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-text-muted">
            <RefreshCw size={12} className="animate-spin" />{t("files.loading")}
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-4 text-xs text-text-muted">{t("files.noFiles")}</div>
        ) : (
          entries.map((entry) => (
            <TreeNode key={entry.path} entry={entry} depth={0}
              changedFiles={changedFiles} onFileSelect={onFileSelect} onContextMenu={handleContextMenu} />
          ))
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onShowDiff={() => setShowDiff(true)}
        />
      )}
      {showDiff && <DiffViewer rootPath={rootPath} onClose={() => setShowDiff(false)} />}
    </div>
  );
}

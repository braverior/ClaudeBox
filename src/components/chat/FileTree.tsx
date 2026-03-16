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

function DiffViewer({ rootPath, onClose }: { rootPath: string; onClose: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    gitDiff(rootPath)
      .then((d) => { setDiff(d); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [rootPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative flex flex-col bg-bg-primary border border-border rounded-xl shadow-2xl w-[800px] max-w-[90vw] h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <GitBranch size={14} className="text-accent" />
            Git Diff
            <span className="text-xs text-text-muted font-normal ml-1">{rootPath.split("/").pop()}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-tertiary/50 text-text-muted hover:text-text-primary transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="flex items-center gap-2 px-4 py-6 text-xs text-text-muted">
              <RefreshCw size={12} className="animate-spin" /> 加载中...
            </div>
          )}
          {error && (
            <div className="px-4 py-4 text-xs text-red-400">{error}</div>
          )}
          {!loading && !error && (!diff || diff.trim() === "") && (
            <div className="px-4 py-6 text-xs text-text-muted">没有未提交的改动</div>
          )}
          {!loading && !error && diff && diff.trim() !== "" && (
            <pre className="text-[11px] leading-5 font-mono px-4 py-3 whitespace-pre">
              {diff.split("\n").map((line, i) => {
                const cls =
                  line.startsWith("+++") || line.startsWith("---")
                    ? "text-text-muted"
                    : line.startsWith("+")
                    ? "text-emerald-400"
                    : line.startsWith("-")
                    ? "text-red-400"
                    : line.startsWith("@@")
                    ? "text-blue-400"
                    : line.startsWith("diff ") || line.startsWith("index ")
                    ? "text-accent/80"
                    : "text-text-secondary";
                return <span key={i} className={`block ${cls}`}>{line || "\u00a0"}</span>;
              })}
            </pre>
          )}
        </div>
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
}

export default function FileTree({ rootPath, changedFiles = new Set(), onFileSelect }: FileTreeProps) {
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

  useEffect(() => { loadRoot(); }, [loadRoot]);

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

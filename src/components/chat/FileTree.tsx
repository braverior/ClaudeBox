import { useState, useEffect, useCallback } from "react";
import { listDir, type DirEntry } from "../../lib/claude-ipc";
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
} from "lucide-react";

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

function TreeNode({ entry, depth, onFileSelect }: { entry: DirEntry; depth: number; onFileSelect?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const t = useT();

  const toggle = useCallback(async () => {
    if (!entry.is_dir) {
      onFileSelect?.(entry.path);
      return;
    }
    if (!expanded && children === null) {
      setLoading(true);
      try {
        const items = await listDir(entry.path);
        setChildren(items);
      } catch {
        setChildren([]);
      }
      setLoading(false);
    }
    setExpanded(!expanded);
  }, [entry, expanded, children, onFileSelect]);

  return (
    <div>
      <button
        onClick={toggle}
        className={`flex items-center gap-1.5 w-full text-left py-1 pr-2 text-xs
                    hover:bg-accent/10 active:bg-accent/15 transition-colors rounded-sm
                    ${entry.is_dir ? "text-text-primary" : "text-text-secondary hover:text-text-primary"}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {entry.is_dir ? (
          <>
            {expanded ? (
              <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
            ) : (
              <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
            )}
            <Folder size={14} className="text-accent/70 flex-shrink-0" />
          </>
        ) : (
          <>
            <span className="w-3 flex-shrink-0" />
            {getFileIcon(entry.name)}
          </>
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {entry.is_dir && expanded && (
        <div>
          {loading && (
            <div
              className="flex items-center gap-1.5 py-1 text-xs text-text-muted"
              style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
            >
              <RefreshCw size={10} className="animate-spin" />
              {t("files.loading")}
            </div>
          )}
          {children?.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} onFileSelect={onFileSelect} />
          ))}
          {children?.length === 0 && !loading && (
            <div
              className="py-1 text-xs text-text-muted italic"
              style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
            >
              {t("files.empty")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface FileTreeProps {
  rootPath: string;
  onFileSelect?: (path: string) => void;
}

export default function FileTree({ rootPath, onFileSelect }: FileTreeProps) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const t = useT();

  const loadRoot = useCallback(async () => {
    setLoading(true);
    try {
      const items = await listDir(rootPath);
      setEntries(items);
    } catch {
      setEntries([]);
    }
    setLoading(false);
  }, [rootPath]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-text-secondary">{t("files.title")}</span>
        <button
          onClick={loadRoot}
          className="p-1 rounded hover:bg-bg-tertiary/50 text-text-muted hover:text-text-primary transition-colors"
          title={t("files.refresh")}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-text-muted">
            <RefreshCw size={12} className="animate-spin" />
            {t("files.loading")}
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-4 text-xs text-text-muted">{t("files.noFiles")}</div>
        ) : (
          entries.map((entry) => (
            <TreeNode key={entry.path} entry={entry} depth={0} onFileSelect={onFileSelect} />
          ))
        )}
      </div>
    </div>
  );
}

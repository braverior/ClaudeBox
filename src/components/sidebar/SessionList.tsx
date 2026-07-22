import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { useChatStore, type Session } from "../../stores/chatStore";
import { formatRelativeDate } from "../../lib/utils";
import { FolderOpen, GitCompare } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useT } from "../../lib/i18n";

interface ContextMenu {
  x: number;
  y: number;
  projectPath: string;
  sessionId: string;
}

interface ProjectGroup {
  projectPath: string;
  projectName: string;
  sessions: Session[];
  latest: Session;
  updatedAt: number;
  count: number;
  unread: boolean;
  running: boolean;
  waiting: boolean;
}

interface SessionListProps {
  searchQuery?: string;
}

export default function SessionList({ searchQuery = "" }: SessionListProps) {
  const {
    sessions,
    currentSessionId,
    streamingSessions,
    pendingInteractions,
    switchSession,
    openDiffDialog,
  } = useChatStore();
  const t = useT();
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isSearching = searchQuery.trim().length > 0;
  const matchSearch = useCallback(
    (g: { projectName: string; projectPath: string }) => {
      if (!isSearching) return true;
      const q = searchQuery.trim().toLowerCase();
      return (
        (g.projectName || "").toLowerCase().includes(q) ||
        (g.projectPath || "").toLowerCase().includes(q)
      );
    },
    [searchQuery, isSearching]
  );

  const currentProjectPath = useMemo(
    () => sessions.find((s) => s.id === currentSessionId)?.projectPath ?? null,
    [sessions, currentSessionId]
  );

  // Group sessions by project; sort projects by most-recent activity.
  const groups = useMemo<ProjectGroup[]>(() => {
    const byPath = new Map<string, Session[]>();
    for (const s of sessions) {
      const arr = byPath.get(s.projectPath);
      if (arr) arr.push(s);
      else byPath.set(s.projectPath, [s]);
    }
    const out: ProjectGroup[] = [];
    for (const [projectPath, arr] of byPath) {
      const sorted = [...arr].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const latest = sorted[0];
      out.push({
        projectPath,
        projectName: latest.projectName,
        sessions: sorted,
        latest,
        updatedAt: latest.updatedAt || 0,
        count: sorted.length,
        unread: sorted.some((s) => s.unread),
        running: sorted.some((s) => !!streamingSessions[s.id]),
        waiting: sorted.some((s) => !!pendingInteractions[s.id]),
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }, [sessions, streamingSessions, pendingInteractions]);

  const visibleGroups = useMemo(() => groups.filter(matchSearch), [groups, matchSearch]);

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, projectPath: string, sessionId: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, projectPath, sessionId });
    },
    []
  );

  // Clamp the menu inside the viewport once it has rendered.
  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    let nextX = contextMenu.x;
    let nextY = contextMenu.y;
    if (rect.right > vw - margin) nextX = Math.max(margin, vw - rect.width - margin);
    if (rect.bottom > vh - margin) nextY = Math.max(margin, vh - rect.height - margin);
    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu({ ...contextMenu, x: nextX, y: nextY });
    }
  }, [contextMenu]);

  const handleOpenFolder = useCallback((projectPath: string) => {
    setContextMenu(null);
    shellOpen(projectPath);
  }, []);

  const handleViewDiff = useCallback(
    (sessionId: string) => {
      setContextMenu(null);
      openDiffDialog(sessionId);
    },
    [openDiffDialog]
  );

  const handleClickProject = useCallback(
    (g: ProjectGroup) => {
      // Already viewing a session in this project → stay on it.
      if (currentProjectPath === g.projectPath) return;
      switchSession(g.latest.id);
    },
    [currentProjectPath, switchSession]
  );

  if (sessions.length === 0) {
    return (
      <div className="flex-1 px-3 py-8 text-center text-text-muted text-sm">
        {t("session.empty")}
        <br />
        {t("session.emptyHint")}
      </div>
    );
  }

  if (visibleGroups.length === 0) {
    return (
      <div className="flex-1 px-3 py-8 text-center text-text-muted text-sm">
        {t("session.noMatch")}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {visibleGroups.map((g) => {
        const isActive = currentProjectPath === g.projectPath;
        const isUnread = g.unread && !isActive;
        return (
          <div
            key={g.projectPath}
            onClick={() => handleClickProject(g)}
            onContextMenu={(e) => handleContextMenu(e, g.projectPath, g.latest.id)}
            className={`group relative flex items-center gap-2 pl-3 pr-3 py-2.5 rounded-lg mb-0.5 cursor-pointer overflow-hidden transition-colors ${
              isActive
                ? "bg-bg-tertiary/50 text-text-primary"
                : "text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary"
            }`}
          >
            {/* Left indicator bar — shown when active or running */}
            {(isActive || g.running) && (
              <span
                className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] bg-accent rounded-r"
                aria-hidden
              />
            )}
            {/* Running: gradient wave sweeping from left to right */}
            {g.running && (
              <span
                className="absolute inset-y-0 left-0 w-2/3 bg-gradient-to-r from-accent/25 via-accent/10 to-transparent animate-running-sweep pointer-events-none"
                aria-hidden
              />
            )}
            <FolderOpen size={14} className="flex-shrink-0 opacity-60" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm truncate" title={g.projectPath}>
                  {g.projectName}
                </span>
                {g.count > 1 && (
                  <span className="flex-shrink-0 text-[10px] px-1.5 py-px rounded-full bg-bg-tertiary/70 text-text-muted">
                    {g.count}
                  </span>
                )}
                {isUnread && (
                  <span
                    className="flex-shrink-0 w-2 h-2 rounded-full bg-warning"
                    title={t("session.unread")}
                  />
                )}
              </div>
              <div className="text-xs mt-0.5">
                {g.waiting ? (
                  <span className="text-warning font-medium">{t("session.waitingTakeover")}</span>
                ) : (
                  <span className="text-text-muted">{formatRelativeDate(g.updatedAt)}</span>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] py-1 rounded-lg bg-bg-secondary border border-border shadow-xl shadow-black/20 animate-fade-in"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => handleOpenFolder(contextMenu.projectPath)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
          >
            <FolderOpen size={14} />
            {t("session.openFolder")}
          </button>
          <button
            onClick={() => handleViewDiff(contextMenu.sessionId)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
          >
            <GitCompare size={14} />
            {t("session.viewDiff")}
          </button>
        </div>
      )}
    </div>
  );
}

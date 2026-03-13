import { useState, useEffect, useRef, useCallback } from "react";
import { useChatStore } from "../../stores/chatStore";
import { stopSession } from "../../lib/claude-ipc";
import { formatRelativeDate } from "../../lib/utils";
import { FolderOpen, Trash2 } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useT } from "../../lib/i18n";

interface ContextMenu {
  x: number;
  y: number;
  sessionId: string;
  projectPath: string;
}

export default function SessionList() {
  const {
    sessions,
    currentSessionId,
    streamingSessions,
    switchSession,
    removeSession,
  } = useChatStore();
  const t = useT();
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
    (e: React.MouseEvent, sessionId: string, projectPath: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, sessionId, projectPath });
    },
    []
  );

  const handleDelete = useCallback(
    async (sessionId: string) => {
      setContextMenu(null);
      try {
        await stopSession(sessionId);
      } catch {
        // ignore
      }
      removeSession(sessionId);
    },
    [removeSession]
  );

  const handleOpenFolder = useCallback((projectPath: string) => {
    setContextMenu(null);
    shellOpen(projectPath);
  }, []);

  if (sessions.length === 0) {
    return (
      <div className="flex-1 px-3 py-8 text-center text-text-muted text-sm">
        {t("session.empty")}
        <br />
        {t("session.emptyHint")}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {sessions.map((session) => {
        const isActive = session.id === currentSessionId;
        const isRunning = !!streamingSessions[session.id];
        return (
          <div
            key={session.id}
            onClick={() => switchSession(session.id)}
            onContextMenu={(e) =>
              handleContextMenu(e, session.id, session.projectPath)
            }
            className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg mb-0.5 cursor-pointer transition-colors ${
              isActive
                ? "bg-bg-tertiary/50 text-text-primary"
                : "text-text-secondary hover:bg-bg-secondary/50 hover:text-text-primary"
            }`}
          >
            <FolderOpen size={14} className="flex-shrink-0 opacity-60" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm truncate" title={session.projectPath}>
                  {session.projectName}
                </span>
                {isRunning && (
                  <span className="flex-shrink-0 w-2 h-2 rounded-full bg-success animate-pulse" />
                )}
              </div>
              <div className="text-xs text-text-muted mt-0.5">
                <span>{formatRelativeDate(session.updatedAt)}</span>
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(session.id);
              }}
              className="flex-shrink-0 opacity-0 group-hover:opacity-100 p-1 hover:text-error transition-all"
              title={t("session.delete")}
            >
              <Trash2 size={12} />
            </button>
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
          <div className="my-1 border-t border-border" />
          <button
            onClick={() => handleDelete(contextMenu.sessionId)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-error/80 hover:bg-error/10 hover:text-error transition-colors"
          >
            <Trash2 size={14} />
            {t("session.delete")}
          </button>
        </div>
      )}
    </div>
  );
}

import { useChatStore } from "../../stores/chatStore";
import { stopSession } from "../../lib/claude-ipc";
import { formatRelativeDate } from "../../lib/utils";
import { FolderOpen, Trash2 } from "lucide-react";
import { useT } from "../../lib/i18n";

export default function SessionList() {
  const {
    sessions,
    currentSessionId,
    switchSession,
    removeSession,
  } = useChatStore();
  const t = useT();

  if (sessions.length === 0) {
    return (
      <div className="flex-1 px-3 py-8 text-center text-text-muted text-sm">
        {t("session.empty")}
        <br />
        {t("session.emptyHint")}
      </div>
    );
  }

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      await stopSession(sessionId);
    } catch {
      // ignore
    }
    removeSession(sessionId);
  };

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {sessions.map((session) => {
        const isActive = session.id === currentSessionId;
        return (
          <div
            key={session.id}
            onClick={() => switchSession(session.id)}
            className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg mb-0.5 cursor-pointer transition-colors ${
              isActive
                ? "bg-bg-tertiary/50 text-text-primary"
                : "text-text-secondary hover:bg-bg-secondary/50 hover:text-text-primary"
            }`}
          >
            <FolderOpen size={14} className="flex-shrink-0 opacity-60" />
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate" title={session.projectPath}>
                {session.projectName}
              </div>
              <div className="text-xs text-text-muted mt-0.5">
                <span>{formatRelativeDate(session.updatedAt)}</span>
              </div>
            </div>
            <button
              onClick={(e) => handleDelete(e, session.id)}
              className="flex-shrink-0 opacity-0 group-hover:opacity-100 p-1 hover:text-error transition-all"
              title={t("session.delete")}
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

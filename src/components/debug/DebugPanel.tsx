import { useEffect, useRef, useState } from "react";
import { Bug, X, Trash2 } from "lucide-react";
import { onDebug } from "../../lib/claude-ipc";
import { useT } from "../../lib/i18n";
import type { DebugEvent } from "../../lib/stream-parser";

const LEVEL_COLORS: Record<string, string> = {
  info: "text-blue-400",
  warn: "text-yellow-400",
  error: "text-red-400",
  stdin: "text-green-400",
  stdout: "text-cyan-300",
  stderr: "text-orange-400",
  process: "text-purple-400",
};

const LEVEL_LABELS: Record<string, string> = {
  info: "INFO",
  warn: "WARN",
  error: "ERR ",
  stdin: "STDIN",
  stdout: "OUT ",
  stderr: "ERR-IO",
  process: "PROC",
};

interface DebugPanelProps {
  visible: boolean;
  onClose: () => void;
}

export default function DebugPanel({ visible, onClose }: DebugPanelProps) {
  const [logs, setLogs] = useState<DebugEvent[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const bottomRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    const unlisten = onDebug((event) => {
      setLogs((prev) => {
        const next = [...prev, event];
        // Keep last 1000 entries
        if (next.length > 1000) next.splice(0, next.length - 1000);
        return next;
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll]);

  if (!visible) return null;

  const filtered =
    filter === "all" ? logs : logs.filter((l) => l.level === filter);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return (
      d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }) +
      "." +
      ms
    );
  };

  return (
    <div className="w-[480px] border-l border-border bg-[#0a0a1a] flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-[#0f0f2a]">
        <div className="flex items-center gap-2">
          <Bug size={14} className="text-purple-400" />
          <span className="text-sm font-semibold text-text-primary">
            {t("debug.title")}
          </span>
          <span className="text-xs text-text-muted">({logs.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setLogs([])}
            className="p-1 rounded hover:bg-bg-secondary text-text-muted hover:text-text-primary transition-colors"
            title={t("debug.clearLogs")}
          >
            <Trash2 size={12} />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-secondary text-text-muted hover:text-text-primary transition-colors"
            title={t("debug.close")}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-[#0d0d22] overflow-x-auto">
        {["all", "process", "stdin", "stdout", "stderr", "info", "error"].map(
          (f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                filter === f
                  ? "bg-accent/20 text-accent"
                  : "text-text-muted hover:text-text-secondary hover:bg-bg-secondary/50"
              }`}
            >
              {f.toUpperCase()}
            </button>
          )
        )}
        <div className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="w-3 h-3"
          />
          {t("debug.autoScroll")}
        </label>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto font-mono text-xs leading-relaxed">
        {filtered.length === 0 && (
          <div className="text-center py-8 text-text-muted">
            {t("debug.empty")}
          </div>
        )}
        {filtered.map((log, i) => (
          <div
            key={i}
            className="flex gap-2 px-2 py-0.5 hover:bg-white/3 border-b border-white/3"
          >
            <span className="text-text-muted flex-shrink-0 w-20">
              {formatTime(log.timestamp)}
            </span>
            <span
              className={`flex-shrink-0 w-12 font-bold ${
                LEVEL_COLORS[log.level] || "text-text-muted"
              }`}
            >
              {LEVEL_LABELS[log.level] || log.level}
            </span>
            <span className="text-gray-300 break-all whitespace-pre-wrap min-w-0">
              {log.message}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

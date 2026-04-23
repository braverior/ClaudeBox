import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfmSafe from "../lib/remark-gfm-safe";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { X, History } from "lucide-react";
import { useT } from "../lib/i18n";
import { loadChangelog } from "../lib/changelog";

interface ChangelogDialogProps {
  open: boolean;
  currentVersion: string;
  onClose: () => void;
}

const remarkPlugins = [remarkGfmSafe];

export default function ChangelogDialog({ open, currentVersion, onClose }: ChangelogDialogProps) {
  const t = useT();
  const entries = useMemo(() => loadChangelog(), []);
  const defaultVersion = entries[0]?.version || "";
  const [selected, setSelected] = useState<string>(defaultVersion);

  if (!open) return null;

  const active = entries.find((e) => e.version === selected) ?? entries[0];

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-primary border border-border rounded-2xl w-[720px] max-h-[82vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-accent/10 text-accent flex items-center justify-center">
              <History size={14} />
            </div>
            <h2 className="text-base font-semibold text-text-primary">
              {t("changelog.title")}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body: 2-column layout */}
        <div className="flex-1 flex min-h-0">
          {/* Version list */}
          <div className="w-44 border-r border-border overflow-y-auto flex-shrink-0 py-2">
            {entries.length === 0 ? (
              <p className="px-4 py-2 text-xs text-text-muted">{t("changelog.empty")}</p>
            ) : (
              entries.map((entry) => {
                const isCurrent = entry.version === currentVersion;
                const isActive = entry.version === (active?.version ?? "");
                return (
                  <button
                    key={entry.version}
                    onClick={() => setSelected(entry.version)}
                    className={`w-full text-left px-4 py-2 border-l-2 transition-colors
                      ${isActive
                        ? "border-accent bg-accent/5 text-text-primary"
                        : "border-transparent text-text-secondary hover:bg-bg-secondary/60 hover:text-text-primary"
                      }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-semibold">v{entry.version}</span>
                      {isCurrent && (
                        <span className="text-[9px] px-1 py-[1px] rounded bg-accent/15 text-accent font-medium">
                          {t("changelog.current")}
                        </span>
                      )}
                    </div>
                    {entry.date && (
                      <div className="text-[10px] text-text-muted mt-0.5 font-mono">{entry.date}</div>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-6 py-5 min-w-0">
            {active ? (
              <>
                <div className="flex items-baseline gap-2 mb-3 pb-3 border-b border-border">
                  <h3 className="text-lg font-semibold text-text-primary font-mono">
                    v{active.version}
                  </h3>
                  {active.date && (
                    <span className="text-xs text-text-muted font-mono">{active.date}</span>
                  )}
                  {active.version === currentVersion && (
                    <span className="text-[10px] px-1.5 py-[1px] rounded bg-accent/15 text-accent font-medium">
                      {t("changelog.current")}
                    </span>
                  )}
                </div>
                {active.body.trim() ? (
                  <div className="markdown-body text-sm">
                    <ReactMarkdown
                      remarkPlugins={remarkPlugins}
                      components={{
                        a({ href, children }) {
                          return (
                            <a
                              href={href}
                              onClick={(e) => {
                                e.preventDefault();
                                if (href) shellOpen(href).catch(() => {});
                              }}
                            >
                              {children}
                            </a>
                          );
                        },
                      }}
                    >
                      {active.body}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-text-muted">{t("changelog.noNotes")}</p>
                )}
              </>
            ) : (
              <p className="text-sm text-text-muted">{t("changelog.empty")}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

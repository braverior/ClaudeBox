import ReactMarkdown from "react-markdown";
import remarkGfmSafe from "../lib/remark-gfm-safe";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { X, Sparkles, RefreshCw } from "lucide-react";
import { useT } from "../lib/i18n";

export type ReleaseNotesMode = "available" | "installed";

interface ReleaseNotesDialogProps {
  open: boolean;
  mode: ReleaseNotesMode;
  version: string;
  body?: string;
  date?: string;
  onClose: () => void;
}

const remarkPlugins = [remarkGfmSafe];

export default function ReleaseNotesDialog({
  open,
  mode,
  version,
  body,
  date,
  onClose,
}: ReleaseNotesDialogProps) {
  const t = useT();
  if (!open) return null;

  const Icon = mode === "installed" ? Sparkles : RefreshCw;
  const heading =
    mode === "installed"
      ? t("update.installedNotes", { version })
      : t("update.newVersionNotes", { version });

  const subtitle = date
    ? t("update.notesForVersion", { version, date })
    : `v${version}`;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-primary border border-border rounded-2xl w-[560px] max-h-[80vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center">
              <Icon size={16} />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-text-primary truncate">{heading}</h2>
              <p className="text-[11px] text-text-muted mt-0.5 font-mono truncate">{subtitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-text-primary transition-colors flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {body && body.trim().length > 0 ? (
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
                {body}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-text-muted">{t("update.noNotes")}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-accent text-white hover:bg-accent-hover
                       transition-colors text-sm font-medium"
          >
            {t("update.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

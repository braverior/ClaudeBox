import { Download, RefreshCw, X } from "lucide-react";
import { useT } from "../lib/i18n";

interface UpdateToastProps {
  version: string;
  body?: string;
  downloading: boolean;
  onRestart: () => void;
  onDismiss: () => void;
}

export default function UpdateToast({
  version,
  body,
  downloading,
  onRestart,
  onDismiss,
}: UpdateToastProps) {
  const t = useT();

  return (
    <div
      className="fixed top-2 left-1/2 -translate-x-1/2 z-[100]
                 bg-bg-secondary border border-accent/30 rounded-xl
                 shadow-2xl shadow-accent/10 px-5 py-3
                 flex items-center gap-3 max-w-md animate-slide-down"
    >
      {/* Icon */}
      <div className="flex-shrink-0">
        {downloading ? (
          <Download size={18} className="text-accent animate-pulse" />
        ) : (
          <RefreshCw size={18} className="text-success" />
        )}
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">
          {downloading
            ? t("update.downloading", { version })
            : t("update.ready", { version })}
        </p>
        {body && !downloading && (
          <p className="text-xs text-text-secondary mt-0.5 truncate">{body}</p>
        )}
      </div>

      {/* Restart button (only when download is complete) */}
      {!downloading && (
        <button
          onClick={onRestart}
          className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium
                     hover:bg-accent-hover transition-colors flex-shrink-0 cursor-pointer"
        >
          {t("update.restart")}
        </button>
      )}

      {/* Dismiss button */}
      <button
        onClick={onDismiss}
        className="p-1 rounded-lg hover:bg-bg-tertiary/50 text-text-muted
                   hover:text-text-primary transition-colors flex-shrink-0 cursor-pointer"
      >
        <X size={14} />
      </button>
    </div>
  );
}

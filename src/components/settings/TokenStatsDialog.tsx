import { useState } from "react";
import { X, Trash2, RotateCcw } from "lucide-react";
import { useTokenUsageStore, type ProjectTokenStats } from "../../stores/tokenUsageStore";
import { useT } from "../../lib/i18n";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface ProjectRowProps {
  stat: ProjectTokenStats;
  onReset: () => void;
}

function ProjectRow({ stat, onReset }: ProjectRowProps) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);

  const handleReset = () => {
    if (confirming) {
      onReset();
      setConfirming(false);
    } else {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
    }
  };

  return (
    <div className="rounded-lg bg-bg-secondary border border-border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary truncate">{stat.projectName}</p>
          <p className="text-[10px] text-text-muted truncate mt-0.5">{stat.projectPath}</p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-[10px] text-text-muted">{formatDate(stat.lastUpdated)}</span>
          <button
            onClick={handleReset}
            className={`p-1 rounded transition-colors ${
              confirming
                ? "bg-error/20 text-error"
                : "hover:bg-bg-tertiary text-text-muted hover:text-error"
            }`}
            title={confirming ? t("tokenStats.confirmReset") : t("tokenStats.resetProject")}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1.5 text-center">
        <div className="bg-bg-primary rounded px-1.5 py-1.5">
          <p className="text-[10px] text-text-muted">{t("tokenStats.input")}</p>
          <p className="text-xs font-medium text-text-primary mt-0.5">{formatTokens(stat.inputTokens)}</p>
        </div>
        <div className="bg-bg-primary rounded px-1.5 py-1.5">
          <p className="text-[10px] text-text-muted">{t("tokenStats.cacheWrite")}</p>
          <p className="text-xs font-medium text-text-primary mt-0.5">{formatTokens(stat.cacheCreationTokens)}</p>
        </div>
        <div className="bg-bg-primary rounded px-1.5 py-1.5">
          <p className="text-[10px] text-text-muted">{t("tokenStats.cacheRead")}</p>
          <p className="text-xs font-medium text-text-primary mt-0.5">{formatTokens(stat.cacheReadTokens)}</p>
        </div>
        <div className="bg-bg-primary rounded px-1.5 py-1.5">
          <p className="text-[10px] text-text-muted">{t("tokenStats.output")}</p>
          <p className="text-xs font-medium text-text-primary mt-0.5">{formatTokens(stat.outputTokens)}</p>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-text-muted">
          {stat.turnCount} {t("tokenStats.turns")}
        </span>
        <span className="font-semibold text-accent">{formatCost(stat.costUsd)}</span>
      </div>
    </div>
  );
}

export function TokenStatsContent() {
  const t = useT();
  const { stats, resetProject, resetAll } = useTokenUsageStore();
  const [confirmingAll, setConfirmingAll] = useState(false);

  const projects = Object.values(stats).sort((a, b) => b.lastUpdated - a.lastUpdated);

  const totals = projects.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + s.inputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + s.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + s.cacheReadTokens,
      outputTokens: acc.outputTokens + s.outputTokens,
      costUsd: acc.costUsd + s.costUsd,
      turnCount: acc.turnCount + s.turnCount,
    }),
    { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, turnCount: 0 }
  );

  const handleResetAll = () => {
    if (confirmingAll) {
      resetAll();
      setConfirmingAll(false);
    } else {
      setConfirmingAll(true);
      setTimeout(() => setConfirmingAll(false), 3000);
    }
  };

  return (
    <div className="space-y-4">
      {projects.length > 0 && (
        <div className="rounded-xl bg-accent/10 border border-accent/20 p-4">
          <p className="text-xs font-medium text-accent mb-3">{t("tokenStats.allProjects")}</p>
          <div className="grid grid-cols-4 gap-1.5 text-center mb-3">
            <div>
              <p className="text-[10px] text-text-muted">{t("tokenStats.input")}</p>
              <p className="text-sm font-semibold text-text-primary mt-0.5">{formatTokens(totals.inputTokens)}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-muted">{t("tokenStats.cacheWrite")}</p>
              <p className="text-sm font-semibold text-text-primary mt-0.5">{formatTokens(totals.cacheCreationTokens)}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-muted">{t("tokenStats.cacheRead")}</p>
              <p className="text-sm font-semibold text-text-primary mt-0.5">{formatTokens(totals.cacheReadTokens)}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-muted">{t("tokenStats.output")}</p>
              <p className="text-sm font-semibold text-text-primary mt-0.5">{formatTokens(totals.outputTokens)}</p>
            </div>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-muted">{totals.turnCount} {t("tokenStats.turns")}</span>
            <span className="font-bold text-accent text-base">{formatCost(totals.costUsd)}</span>
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="text-center py-12 text-text-muted text-sm">
          {t("tokenStats.empty")}
        </div>
      ) : (
        <div className="space-y-2">
          {projects.map((stat) => (
            <ProjectRow
              key={stat.projectPath}
              stat={stat}
              onReset={() => resetProject(stat.projectPath)}
            />
          ))}
        </div>
      )}

      {projects.length > 0 && (
        <button
          onClick={handleResetAll}
          className={`w-full py-2 rounded-lg border transition-colors text-sm font-medium flex items-center justify-center gap-2 ${
            confirmingAll
              ? "border-error/50 bg-error/10 text-error"
              : "border-border text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
          }`}
        >
          <RotateCcw size={14} />
          {confirmingAll ? t("tokenStats.confirmResetAll") : t("tokenStats.resetAll")}
        </button>
      )}
    </div>
  );
}

interface TokenStatsDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function TokenStatsDialog({ open, onClose }: TokenStatsDialogProps) {
  const t = useT();

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-primary border border-border rounded-2xl w-[480px] max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-lg font-semibold text-text-primary">{t("tokenStats.title")}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4">
          <TokenStatsContent />
        </div>

        <div className="px-6 py-4 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors text-sm font-medium"
          >
            {t("settings.done")}
          </button>
        </div>
      </div>
    </div>
  );
}

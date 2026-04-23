import { useState } from "react";
import { X, FolderOpen, Play } from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";

interface NewSessionDialogProps {
  projectPath: string;
  onClose: () => void;
}

export default function NewSessionDialog({
  projectPath,
  onClose,
}: NewSessionDialogProps) {
  const { settings } = useSettingsStore();
  const { createSession } = useChatStore();

  const [model, setModel] = useState(settings.defaultModel || settings.model || "");
  const [permissionMode, setPermissionMode] = useState(
    settings.permissionMode || ""
  );

  const handleStart = () => {
    createSession(projectPath, model, permissionMode);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-primary border border-border rounded-2xl w-[440px] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">
            New Session
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Project path */}
          <div>
            <label className="text-sm font-medium text-text-primary block mb-1.5">
              Project
            </label>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-input-bg border border-border text-sm">
              <FolderOpen size={14} className="text-text-muted flex-shrink-0" />
              <span className="text-text-primary truncate">{projectPath}</span>
            </div>
          </div>

          {/* Model */}
          <div>
            <label className="text-sm font-medium text-text-primary block mb-1.5">
              Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-lg bg-input-bg border border-border px-3 py-2 text-sm
                         text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              <option value="">Default (Sonnet)</option>
              {settings.models.map((m) => (
                <option key={m.id} value={m.id}>{m.id}</option>
              ))}
              {!settings.models.some((x) => x.id === "sonnet") && <option value="sonnet">Sonnet</option>}
              {!settings.models.some((x) => x.id === "opus") && <option value="opus">Opus</option>}
              {!settings.models.some((x) => x.id === "haiku") && <option value="haiku">Haiku</option>}
            </select>
          </div>

          {/* Permission Mode */}
          <div>
            <label className="text-sm font-medium text-text-primary block mb-1.5">
              Permission Mode
            </label>
            <select
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value)}
              className="w-full rounded-lg bg-input-bg border border-border px-3 py-2 text-sm
                         text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              <option value="">Default</option>
              <option value="auto">Auto Accept (auto-approve tools)</option>
              <option value="plan">Plan Mode (plan before acting)</option>
            </select>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border">
          <button
            onClick={handleStart}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg
                       bg-accent text-white hover:bg-accent-hover transition-colors
                       text-sm font-medium"
          >
            <Play size={14} />
            Start Session
          </button>
        </div>
      </div>
    </div>
  );
}

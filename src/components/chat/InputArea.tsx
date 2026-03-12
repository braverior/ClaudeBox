import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Square, AlertCircle, ChevronDown, ChevronUp, GitBranch, Wrench, Check } from "lucide-react";
import { useT } from "../../lib/i18n";

interface InputAreaProps {
  onSend: (message: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  model?: string;
  models?: string[];
  permissionMode?: string;
  onModelChange?: (model: string) => void;
  onPermissionModeChange?: (mode: string) => void;
  gitBranch?: string | null;
  allowedTools?: string[];
  onAllowedToolsChange?: (tools: string[]) => void;
}

const ALL_TOOLS = [
  { value: "Read", label: "Read" },
  { value: "Write", label: "Write" },
  { value: "Edit", label: "Edit" },
  { value: "Bash", label: "Bash" },
  { value: "Glob", label: "Glob" },
  { value: "Grep", label: "Grep" },
  { value: "WebFetch", label: "WebFetch" },
  { value: "WebSearch", label: "WebSearch" },
  { value: "NotebookEdit", label: "NotebookEdit" },
  { value: "Agent", label: "Agent" },
];

function DropdownSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) || options[0];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs
                   text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50
                   transition-colors"
      >
        <span>{current.label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[100px] rounded-lg
                        bg-bg-secondary border border-border shadow-xl z-20 py-1">
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`block w-full text-left px-3 py-1.5 text-xs transition-colors
                ${
                  opt.value === value
                    ? "text-accent bg-accent/10"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/30"
                }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolsSelector({
  selected,
  onChange,
  t,
}: {
  selected: string[];
  onChange: (tools: string[]) => void;
  t: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggle = (tool: string) => {
    if (selected.includes(tool)) {
      onChange(selected.filter((t) => t !== tool));
    } else {
      onChange([...selected, tool]);
    }
  };

  const allSelected = selected.length === ALL_TOOLS.length;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs
                   text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50
                   transition-colors"
      >
        <Wrench size={11} />
        <span>{t("input.tools")} ({selected.length})</span>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[150px] rounded-lg
                        bg-bg-secondary border border-border shadow-xl z-20 py-1">
          {/* Select all / none */}
          <button
            onClick={() => onChange(allSelected ? [] : ALL_TOOLS.map((t) => t.value))}
            className="block w-full text-left px-3 py-1.5 text-xs text-text-muted
                       hover:text-text-primary hover:bg-bg-tertiary/30 transition-colors border-b border-border"
          >
            {allSelected ? t("input.deselectAll") : t("input.selectAll")}
          </button>
          {ALL_TOOLS.map((tool) => {
            const isSelected = selected.includes(tool.value);
            return (
              <button
                key={tool.value}
                onClick={() => toggle(tool.value)}
                className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors
                  ${isSelected
                    ? "text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                  } hover:bg-bg-tertiary/30`}
              >
                <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0
                  ${isSelected
                    ? "bg-accent border-accent"
                    : "border-border"
                  }`}>
                  {isSelected && <Check size={10} className="text-white" />}
                </span>
                <span>{tool.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function InputArea({
  onSend,
  onStop,
  isStreaming,
  disabled,
  model = "",
  models = [],
  permissionMode = "",
  onModelChange,
  onPermissionModeChange,
  gitBranch,
  allowedTools = [],
  onAllowedToolsChange,
}: InputAreaProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const t = useT();

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) return;
      handleSend();
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
  }, [input]);

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="border-t border-border px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("input.placeholder")}
            rows={1}
            disabled={disabled}
            className="flex-1 resize-none rounded-xl bg-input-bg border border-border px-4 py-3
                       text-text-primary placeholder:text-text-muted
                       focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent
                       disabled:opacity-50 transition-colors
                       overflow-hidden"
          />
          {isStreaming ? (
            <button
              onClick={onStop}
              className="flex items-center justify-center w-10 h-10 rounded-xl
                         bg-error/20 text-error hover:bg-error/30 transition-colors"
              title={t("input.stop")}
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() || disabled}
              className="flex items-center justify-center w-10 h-10 rounded-xl
                         bg-accent text-white hover:bg-accent-hover transition-colors
                         disabled:opacity-30 disabled:cursor-not-allowed"
              title={t("input.send")}
            >
              <Send size={18} />
            </button>
          )}
        </div>

        {/* Toolbar: model, mode, tools, git branch */}
        {onModelChange && onPermissionModeChange && (
          <div className="flex items-center gap-1 mt-1.5 px-1">
            <span className="text-[10px] text-text-muted mr-0.5">{t("input.model")}</span>
            {models.length > 0 ? (
              <DropdownSelect
                value={model}
                options={models.map((m) => ({ value: m, label: m }))}
                onChange={(v) => onModelChange?.(v)}
              />
            ) : (
              <input
                type="text"
                value={model}
                onChange={(e) => onModelChange?.(e.target.value)}
                placeholder={t("input.addModelsHint")}
                className="w-48 px-2 py-0.5 rounded-md text-xs bg-transparent border border-transparent
                           text-text-secondary hover:border-border focus:border-accent focus:outline-none
                           placeholder:text-text-muted/50 transition-colors"
              />
            )}
            <span className="text-border mx-1">|</span>
            <span className="text-[10px] text-text-muted mr-0.5">{t("input.mode")}</span>
            <DropdownSelect
              value={permissionMode}
              options={[
                { value: "", label: t("mode.default") },
                { value: "auto", label: t("mode.auto") },
                { value: "plan", label: t("mode.plan") },
              ]}
              onChange={onPermissionModeChange}
            />
            {onAllowedToolsChange && (
              <>
                <span className="text-border mx-1">|</span>
                <ToolsSelector
                  selected={allowedTools}
                  onChange={onAllowedToolsChange}
                  t={t}
                />
              </>
            )}
            {gitBranch && (
              <>
                <span className="text-border mx-1">|</span>
                <GitBranch size={11} className="text-text-muted" />
                <span className="text-xs text-text-muted">{gitBranch}</span>
              </>
            )}
          </div>
        )}

        {disabled && (
          <div className="flex items-center gap-2 text-warning text-sm mt-2">
            <AlertCircle size={14} />
            <span>{t("input.cliNotDetected")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send, Square, AlertCircle, ChevronDown, ChevronUp, GitBranch,
  Wrench, Check, Paperclip, X, FileCode2, FileText,
  Image, FileType, Terminal, Globe, Settings2, Cpu, Shield, Eraser,
  Loader2, SquareTerminal,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { readImageBase64, saveClipboardImage, listGitBranches, checkoutGitBranch } from "../../lib/claude-ipc";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useT } from "../../lib/i18n";

export interface Attachment {
  path: string;
  name: string;
  type: "text" | "image";
  /** Base64 data URL for image preview */
  dataUrl?: string;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);

function getAttachmentType(filename: string): "text" | "image" {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return IMAGE_EXTENSIONS.has(ext) ? "image" : "text";
}

/** File category for visual styling */
type FileCategory = "code" | "config" | "doc" | "web" | "shell" | "image" | "other";

const EXT_CATEGORY: Record<string, FileCategory> = {
  ts: "code", tsx: "code", js: "code", jsx: "code", py: "code",
  rs: "code", go: "code", java: "code", rb: "code", php: "code",
  c: "code", cpp: "code", h: "code", lua: "code",
  json: "config", yaml: "config", yml: "config", toml: "config",
  ini: "config", cfg: "config", conf: "config",
  md: "doc", txt: "doc", log: "doc",
  html: "web", css: "web", xml: "web", svg: "web",
  sh: "shell", sql: "shell",
  png: "image", jpg: "image", jpeg: "image", gif: "image",
  webp: "image", bmp: "image",
};

const CATEGORY_STYLE: Record<FileCategory, { bg: string; text: string; border: string }> = {
  code:   { bg: "bg-blue-500/10",   text: "text-blue-400",   border: "border-blue-500/20" },
  config: { bg: "bg-amber-500/10",  text: "text-amber-400",  border: "border-amber-500/20" },
  doc:    { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20" },
  web:    { bg: "bg-purple-500/10", text: "text-purple-400", border: "border-purple-500/20" },
  shell:  { bg: "bg-orange-500/10", text: "text-orange-400", border: "border-orange-500/20" },
  image:  { bg: "bg-rose-500/10",   text: "text-rose-400",   border: "border-rose-500/20" },
  other:  { bg: "bg-zinc-500/10",   text: "text-zinc-400",   border: "border-zinc-500/20" },
};

function getCategoryIcon(cat: FileCategory) {
  switch (cat) {
    case "code":   return FileCode2;
    case "config": return Settings2;
    case "doc":    return FileText;
    case "web":    return Globe;
    case "shell":  return Terminal;
    case "image":  return Image;
    default:       return FileType;
  }
}

function getFileCategory(filename: string): FileCategory {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return EXT_CATEGORY[ext] || "other";
}

interface InputAreaProps {
  onSend: (message: string, attachments?: Attachment[]) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  model?: string;
  models?: string[];
  permissionMode?: string;
  onModelChange?: (model: string) => void;
  onPermissionModeChange?: (mode: string) => void;
  gitBranch?: string | null;
  projectPath?: string;
  onBranchChange?: (branch: string) => void;
  onOpenTerminal?: () => void;
  allowedTools?: string[];
  onAllowedToolsChange?: (tools: string[]) => void;
  /** Whether session has a resumable claude session id */
  hasClaudeSession?: boolean;
  /** Callback to clear the session memory */
  onClearSession?: () => void;
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
  icon,
  tooltip,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  icon?: React.ReactNode;
  tooltip?: string;
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
        title={tooltip}
      >
        {icon}
        <span className="truncate max-w-[160px]">{current.label}</span>
        <ChevronDown size={12} className="flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[120px] max-w-[260px] rounded-lg
                        bg-bg-secondary border border-border shadow-xl z-50 py-1">
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`block w-full text-left px-3 py-1.5 text-xs transition-colors truncate
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
                        bg-bg-secondary border border-border shadow-xl z-50 py-1">
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

/** Branch dropdown for inline toolbar */
function BranchDropdown({
  branch,
  projectPath,
  onBranchChange,
}: {
  branch: string;
  projectPath: string;
  onBranchChange: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleOpen = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }
    try {
      const list = await listGitBranches(projectPath);
      const sorted = [branch, ...list.filter((b) => b !== branch)];
      setBranches(sorted);
    } catch {
      setBranches([branch]);
    }
    setOpen(true);
  }, [open, projectPath, branch]);

  const handleSwitch = useCallback(async (target: string) => {
    if (target === branch) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      await checkoutGitBranch(projectPath, target);
      onBranchChange(target);
    } catch (e) {
      console.error("Branch checkout failed:", e);
    } finally {
      setSwitching(false);
      setOpen(false);
    }
  }, [branch, projectPath, onBranchChange]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleOpen}
        disabled={switching}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs
                   text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50
                   transition-colors cursor-pointer"
        title={t("branch.switch")}
      >
        {switching ? (
          <Loader2 size={11} className="flex-shrink-0 animate-spin" />
        ) : (
          <GitBranch size={11} className="flex-shrink-0" />
        )}
        <span className="truncate max-w-[100px]">{branch}</span>
        <ChevronDown size={10} className="flex-shrink-0 opacity-50" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[160px] max-w-[260px] max-h-[240px]
                        overflow-y-auto rounded-lg bg-bg-secondary border border-border shadow-xl z-50 py-1">
          {branches.map((b) => (
            <button
              key={b}
              onClick={() => handleSwitch(b)}
              className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors truncate
                ${b === branch
                  ? "text-accent bg-accent/10"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/30"
                }`}
            >
              {b === branch && <Check size={10} className="flex-shrink-0" />}
              <span className="truncate">{b}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Single attachment chip */
function AttachmentChip({
  att,
  onRemove,
  onOpen,
}: {
  att: Attachment;
  onRemove: () => void;
  onOpen: () => void;
}) {
  const cat = getFileCategory(att.name);
  const style = CATEGORY_STYLE[cat];
  const Icon = getCategoryIcon(cat);
  const ext = att.name.split(".").pop()?.toLowerCase() || "";

  if (att.type === "image") {
    return (
      <div
        className={`relative group rounded-lg overflow-hidden border ${style.border} flex-shrink-0 cursor-pointer`}
        onDoubleClick={onOpen}
        title={att.name}
      >
        {att.dataUrl ? (
          <img src={att.dataUrl} alt={att.name} className="w-16 h-16 object-cover" />
        ) : (
          <div className="w-16 h-16 flex items-center justify-center bg-rose-500/5">
            <Image size={20} className="text-rose-400/50" />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1">
          <span className="text-[10px] text-white/90 truncate block">{att.name}</span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 flex items-center justify-center
                     opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
        >
          <X size={10} className="text-white" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1.5 pl-2 pr-1 py-1.5 rounded-lg border ${style.border} ${style.bg}
                   group flex-shrink-0 cursor-pointer hover:brightness-110 transition-all`}
      onDoubleClick={onOpen}
      title={att.path}
    >
      <Icon size={14} className={style.text} />
      <div className="flex flex-col min-w-0 leading-none">
        <span className="text-[11px] text-text-primary truncate max-w-[100px]">{att.name}</span>
        <span className={`text-[9px] ${style.text} uppercase font-medium`}>{ext}</span>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0
                   text-text-muted opacity-0 group-hover:opacity-100 hover:text-error hover:bg-error/10
                   transition-all"
      >
        <X size={10} />
      </button>
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
  projectPath,
  onBranchChange,
  onOpenTerminal,
  allowedTools = [],
  onAllowedToolsChange,
  onClearSession,
}: InputAreaProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const t = useT();

  const handleAttach = useCallback(async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "All Supported",
            extensions: [
              "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp",
              "ts", "tsx", "js", "jsx", "json", "md", "txt", "rs", "py", "go",
              "html", "css", "yaml", "yml", "toml", "sh", "sql", "xml", "c",
              "cpp", "h", "java", "rb", "php", "lua", "log", "conf", "cfg", "ini",
            ],
          },
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"],
          },
          {
            name: "Code & Text",
            extensions: [
              "ts", "tsx", "js", "jsx", "json", "md", "txt", "rs", "py", "go",
              "html", "css", "yaml", "yml", "toml", "sh", "sql", "xml", "c",
              "cpp", "h", "java", "rb", "php", "lua", "log", "conf", "cfg", "ini",
            ],
          },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const newAttachments: Attachment[] = [];
      for (const p of paths) {
        const name = p.split(/[\\/]/).pop() || p;
        const type = getAttachmentType(name);
        let dataUrl: string | undefined;
        if (type === "image") {
          try {
            dataUrl = await readImageBase64(p);
          } catch (e) {
            console.error("Failed to read image:", e);
          }
        }
        newAttachments.push({ path: p, name, type, dataUrl });
      }
      setAttachments((prev) => [...prev, ...newAttachments]);
    } catch (e) {
      console.error("File dialog error:", e);
    }
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /** Handle clipboard paste – intercept images, let text pass through */
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }

    // No images → let the default text-paste behaviour through
    if (imageFiles.length === 0) return;
    e.preventDefault();

    for (const file of imageFiles) {
      try {
        // Read the blob as raw base64
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let j = 0; j < bytes.length; j++) {
          binary += String.fromCharCode(bytes[j]);
        }
        const base64 = btoa(binary);

        // Derive a sensible filename
        const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
        const name =
          file.name && file.name !== "image.png"
            ? file.name
            : `clipboard-${Date.now()}.${ext}`;

        // Persist to disk via Rust so the sidecar can read it by path
        const savedPath = await saveClipboardImage(base64, name);

        // Build a data-URL for the inline preview
        const dataUrl = `data:${file.type};base64,${base64}`;

        setAttachments((prev) => [
          ...prev,
          { path: savedPath, name, type: "image" as const, dataUrl },
        ]);
      } catch (err) {
        console.error("Failed to paste image:", err);
      }
    }
  }, []);

  const openAttachment = useCallback((att: Attachment) => {
    shellOpen(att.path).catch(() => {});
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;
    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setInput("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, attachments, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) return;
      handleSend();
    }
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
  }, [input]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const hasContent = input.trim() || attachments.length > 0;

  return (
    <div className="px-4 pt-1 pb-4">
      <div className="max-w-3xl mx-auto">
        {/* Unified input container */}
        <div className={`rounded-2xl border transition-colors overflow-visible
          ${disabled ? "opacity-50 border-border bg-input-bg" : "border-border bg-input-bg focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/20"}`}
        >
          {/* Attachment area */}
          {attachments.length > 0 && (
            <div className="px-3 pt-3 pb-1">
              <div className="flex flex-wrap gap-2">
                {attachments.map((att, i) => (
                  <AttachmentChip
                    key={`${att.path}-${i}`}
                    att={att}
                    onRemove={() => removeAttachment(i)}
                    onOpen={() => openAttachment(att)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t("input.placeholder")}
            rows={1}
            disabled={disabled}
            className="w-full resize-none bg-transparent px-4 py-2
                       text-text-primary placeholder:text-text-muted
                       focus:outline-none disabled:cursor-not-allowed
                       overflow-hidden text-[0.9375rem]"
          />

          {/* Bottom bar: attach + toolbar + send */}
          <div className="flex items-center gap-1 px-2 pb-1">
            <button
              onClick={handleAttach}
              disabled={disabled}
              className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0
                         text-text-muted hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors
                         disabled:opacity-30 disabled:cursor-not-allowed"
              title={t("input.attach")}
            >
              <Paperclip size={16} />
            </button>

            {/* Inline toolbar */}
            {onModelChange && onPermissionModeChange && (
              <div className="flex items-center gap-1 min-w-0 flex-wrap">
                {/* Clear session button — always visible when callback exists */}
                {onClearSession && (
                  <>
                    <button
                      onClick={() => {
                        if (confirmClear) {
                          clearTimeout(confirmTimerRef.current);
                          setConfirmClear(false);
                          onClearSession();
                        } else {
                          setConfirmClear(true);
                          confirmTimerRef.current = setTimeout(() => setConfirmClear(false), 3000);
                        }
                      }}
                      className={`flex items-center justify-center gap-1 rounded-md text-xs px-1.5 py-0.5
                                 transition-colors ${
                                   confirmClear
                                     ? "text-warning bg-warning/10 hover:bg-warning/20"
                                     : "text-text-muted hover:text-text-primary hover:bg-bg-tertiary/50"
                                 }`}
                      title={confirmClear ? t("chat.clearSessionConfirm") : t("chat.clearSession")}
                    >
                      <Eraser size={12} className="flex-shrink-0" />
                      {confirmClear && <span className="text-[11px]">?</span>}
                    </button>
                    <span className="text-border/40 mx-0.5 flex-shrink-0">|</span>
                  </>
                )}
                {models.length > 0 ? (
                  <DropdownSelect
                    value={model}
                    options={models.map((m) => ({ value: m, label: m }))}
                    onChange={(v) => onModelChange?.(v)}
                    icon={<Cpu size={12} className="flex-shrink-0" />}
                    tooltip={t("input.model")}
                  />
                ) : (
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => onModelChange?.(e.target.value)}
                    placeholder={t("input.addModelsHint")}
                    className="w-40 px-2 py-1 rounded-md text-xs bg-transparent border border-transparent
                               text-text-secondary hover:border-border focus:border-accent focus:outline-none
                               placeholder:text-text-muted/50 transition-colors"
                  />
                )}
                <span className="text-border/40 mx-0.5 flex-shrink-0">|</span>
                <DropdownSelect
                  value={permissionMode}
                  options={[
                    { value: "", label: t("mode.default") },
                    { value: "auto", label: t("mode.auto") },
                    { value: "plan", label: t("mode.plan") },
                  ]}
                  onChange={onPermissionModeChange}
                  icon={<Shield size={12} className="flex-shrink-0" />}
                  tooltip={t("input.mode")}
                />
                {onAllowedToolsChange && (
                  <>
                    <span className="text-border/40 mx-0.5 flex-shrink-0">|</span>
                    <ToolsSelector
                      selected={allowedTools}
                      onChange={onAllowedToolsChange}
                      t={t}
                    />
                  </>
                )}
                {gitBranch && projectPath && onBranchChange && (
                  <>
                    <span className="text-border/40 mx-0.5 flex-shrink-0">|</span>
                    <BranchDropdown
                      branch={gitBranch}
                      projectPath={projectPath}
                      onBranchChange={onBranchChange}
                    />
                  </>
                )}
                {onOpenTerminal && (
                  <>
                    <span className="text-border/40 mx-0.5 flex-shrink-0">|</span>
                    <button
                      onClick={onOpenTerminal}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-xs
                                 text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50
                                 transition-colors"
                      title={t("input.openTerminal")}
                    >
                      <SquareTerminal size={13} />
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="flex-1" />

            <div className="flex items-center gap-1.5 flex-shrink-0">
              {isStreaming ? (
                <button
                  onClick={onStop}
                  className="flex items-center justify-center w-8 h-8 rounded-lg
                             bg-error/15 text-error hover:bg-error/25 transition-colors"
                  title={t("input.stop")}
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!hasContent || disabled}
                  className={`flex items-center justify-center w-8 h-8 rounded-lg transition-all
                    ${hasContent && !disabled
                      ? "bg-accent text-white hover:bg-accent-hover shadow-sm shadow-accent/20"
                      : "bg-bg-tertiary/50 text-text-muted cursor-not-allowed"
                    }`}
                  title={t("input.send")}
                >
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

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

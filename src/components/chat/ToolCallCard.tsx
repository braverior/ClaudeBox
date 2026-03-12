import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Terminal,
  Search,
  Edit3,
  FolderOpen,
  Globe,
  CheckCircle,
  XCircle,
  Loader2,
  FilePlus,
  NotebookPen,
  Bot,
  ListTodo,
  ExternalLink,
  MessageCircleQuestion,
  ClipboardCheck,
} from "lucide-react";
import type { ContentBlock, PendingInteraction } from "../../lib/stream-parser";
import { openInBrowser } from "../../lib/claude-ipc";

const TOOL_ICONS: Record<string, React.ReactNode> = {
  Read: <FileText size={14} />,
  Edit: <Edit3 size={14} />,
  Write: <FilePlus size={14} />,
  NotebookEdit: <NotebookPen size={14} />,
  Bash: <Terminal size={14} />,
  Grep: <Search size={14} />,
  Glob: <FolderOpen size={14} />,
  WebFetch: <Globe size={14} />,
  WebSearch: <Globe size={14} />,
  Agent: <Bot size={14} />,
  TaskCreate: <ListTodo size={14} />,
  TaskUpdate: <ListTodo size={14} />,
  TodoWrite: <ListTodo size={14} />,
  AskUserQuestion: <MessageCircleQuestion size={14} />,
  ExitPlanMode: <ClipboardCheck size={14} />,
};

/** Extract a short filename from a full path */
function shortPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, "/").split("/");
  return parts.length > 2
    ? `.../${parts.slice(-2).join("/")}`
    : fullPath;
}

/** Count lines in a string */
function lineCount(s: string): number {
  if (!s) return 0;
  return s.split("\n").length;
}

/** Detect local URLs with ports (e.g. http://localhost:3000) */
function detectLocalUrl(text: string): string | null {
  const match = text.match(
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/\S*)?/
  );
  return match ? match[0].replace("0.0.0.0", "localhost") : null;
}

interface ToolCallCardProps {
  block: ContentBlock;
  result?: ContentBlock;
  /** Pending interactive request matching this tool call (if any) */
  pendingInteraction?: PendingInteraction | null;
  /** Callback when the user responds to an interactive tool */
  onRespond?: (response: Record<string, unknown>) => void;
}

export default function ToolCallCard({ block, result, pendingInteraction, onRespond }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [answered, setAnswered] = useState(false);
  const toolName = block.name || "Tool";
  const icon = TOOL_ICONS[toolName] || <Terminal size={14} />;
  const input = block.input || {};
  const isError = result?.is_error;
  const isDone = !!result;

  // Check if this tool call is the one with a pending interaction
  const isAskUser = toolName === "AskUserQuestion" && pendingInteraction?.type === "ask_user" && !answered;
  const isExitPlan = toolName === "ExitPlanMode" && pendingInteraction?.type === "exit_plan" && !answered;

  // Build summary and detail based on tool type
  let summary = toolName;
  let detail = "";

  if (toolName === "AskUserQuestion") {
    const questions = pendingInteraction?.questions || (input.questions as unknown[]);
    const firstQ = questions?.[0] as { question?: string } | undefined;
    summary = firstQ?.question
      ? `Question: ${firstQ.question.length > 60 ? firstQ.question.slice(0, 60) + "..." : firstQ.question}`
      : "Asking a question...";
  } else if (toolName === "ExitPlanMode") {
    summary = "Ready to implement — approve plan?";
  } else if (toolName === "Write" || toolName === "NotebookEdit") {
    const fp = (input.file_path || input.notebook_path || "") as string;
    const content = (input.content || input.new_source || "") as string;
    const lines = lineCount(content);
    summary = `${toolName}: ${shortPath(fp)}`;
    detail = `${lines} lines`;
  } else if (toolName === "Edit") {
    const fp = (input.file_path || "") as string;
    const oldStr = (input.old_string || "") as string;
    const newStr = (input.new_string || "") as string;
    const removedLines = lineCount(oldStr);
    const addedLines = lineCount(newStr);
    summary = `Edit: ${shortPath(fp)}`;
    detail = `+${addedLines} / -${removedLines}`;
  } else if (toolName === "Read") {
    const fp = (input.file_path || "") as string;
    summary = `Read: ${shortPath(fp)}`;
  } else if (toolName === "Bash") {
    const cmd = String(input.command || "").trim();
    const desc = input.description as string | undefined;
    // Shorten long absolute paths in commands
    const shortCmd = cmd.replace(/\/\S{40,}/g, (match) => shortPath(match));
    summary = desc || (shortCmd.length > 60 ? shortCmd.slice(0, 60) + "..." : shortCmd);
  } else if (toolName === "Agent") {
    const desc = (input.description || input.prompt || "") as string;
    summary = desc ? `Agent: ${desc.length > 50 ? desc.slice(0, 50) + "..." : desc}` : "Agent";
  } else if (toolName === "Grep" || toolName === "Glob") {
    const pattern = (input.pattern || "") as string;
    summary = `${toolName}: ${pattern}`;
  } else if (input.file_path) {
    summary = `${toolName}: ${shortPath(input.file_path as string)}`;
  } else if (input.command) {
    summary = `${toolName}: ${String(input.command).slice(0, 60)}`;
  } else if (input.url) {
    summary = `${toolName}: ${input.url}`;
  }

  // Extract result text
  let resultText = "";
  if (result) {
    if (typeof result.content === "string") {
      resultText = result.content;
    } else if (Array.isArray(result.content)) {
      resultText = result.content
        .map((c) => (typeof c === "string" ? c : c.text || ""))
        .join("\n");
    }
  }

  // Detect local URL with port in Bash results
  const detectedUrl =
    toolName === "Bash" && resultText ? detectLocalUrl(resultText) : null;

  // ── Handlers for interactive tools ──────────────────────────────

  /** Accumulated answers for multi-question AskUserQuestion */
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const handleSelectAnswer = (questionText: string, answer: string) => {
    setAnswers((prev) => ({ ...prev, [questionText]: answer }));
  };

  const handleSubmitAnswers = () => {
    if (!onRespond || !pendingInteraction) return;
    setAnswered(true);
    onRespond({
      type: "response",
      requestId: pendingInteraction.requestId,
      behavior: "allow",
      answers,
    });
  };

  /** For single-question: answer immediately on click */
  const handleQuickAnswer = (questionText: string, answer: string) => {
    if (!onRespond || !pendingInteraction) return;
    setAnswered(true);
    onRespond({
      type: "response",
      requestId: pendingInteraction.requestId,
      behavior: "allow",
      answers: { [questionText]: answer },
    });
  };

  const handleExitPlanApprove = () => {
    if (!onRespond || !pendingInteraction) return;
    setAnswered(true);
    onRespond({
      type: "response",
      requestId: pendingInteraction.requestId,
      behavior: "allow",
    });
  };

  const handleExitPlanReject = (reason?: string) => {
    if (!onRespond || !pendingInteraction) return;
    setAnswered(true);
    onRespond({
      type: "response",
      requestId: pendingInteraction.requestId,
      behavior: "deny",
      message: reason || "Plan rejected by user",
    });
  };

  // ── Render: AskUserQuestion interactive UI ──────────────────────

  if (isAskUser && pendingInteraction?.questions) {
    const questions = pendingInteraction.questions;
    const isSingleQuestion = questions.length === 1;

    return (
      <div className="rounded-lg border-2 border-accent/50 bg-accent/5 overflow-hidden">
        <div className="px-3 py-2 flex items-center gap-2 bg-accent/10">
          <MessageCircleQuestion size={14} className="text-accent" />
          <span className="text-sm font-medium text-text-primary">Claude needs your input</span>
        </div>
        <div className="px-3 py-3 space-y-4">
          {questions.map((q, qi) => (
            <div key={qi}>
              <p className="text-sm text-text-primary mb-2">{q.question}</p>
              {q.header && (
                <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-muted mb-2">
                  {q.header}
                </span>
              )}
              <div className="flex flex-wrap gap-2 mb-2">
                {q.options.map((opt, oi) => {
                  const isSelected = answers[q.question] === opt.label;
                  return (
                    <button
                      key={oi}
                      onClick={() =>
                        isSingleQuestion
                          ? handleQuickAnswer(q.question, opt.label)
                          : handleSelectAnswer(q.question, opt.label)
                      }
                      className={`px-3 py-1.5 text-sm rounded-lg border text-text-primary
                                 transition-colors text-left ${
                                   isSelected
                                     ? "border-accent bg-accent/15"
                                     : "border-border bg-bg-secondary hover:bg-accent/10 hover:border-accent/50"
                                 }`}
                      title={opt.description}
                    >
                      <span className="font-medium">{opt.label}</span>
                      {opt.description && (
                        <span className="block text-[11px] text-text-muted mt-0.5">
                          {opt.description}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {/* Custom "Other" input */}
              <div className="flex items-center gap-2 mt-2">
                <input
                  type="text"
                  placeholder="Other..."
                  value={customInputs[q.question] || ""}
                  onChange={(e) =>
                    setCustomInputs({ ...customInputs, [q.question]: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && customInputs[q.question]?.trim()) {
                      if (isSingleQuestion) {
                        handleQuickAnswer(q.question, customInputs[q.question].trim());
                      } else {
                        handleSelectAnswer(q.question, customInputs[q.question].trim());
                      }
                    }
                  }}
                  className="flex-1 px-2.5 py-1.5 text-sm rounded-lg border border-border
                             bg-bg-primary text-text-primary placeholder:text-text-muted
                             focus:outline-none focus:border-accent/50"
                />
                {isSingleQuestion && (
                  <button
                    onClick={() => {
                      if (customInputs[q.question]?.trim()) {
                        handleQuickAnswer(q.question, customInputs[q.question].trim());
                      }
                    }}
                    disabled={!customInputs[q.question]?.trim()}
                    className="px-3 py-1.5 text-sm rounded-lg bg-accent text-white
                               hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed
                               transition-colors"
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          ))}
          {/* Submit All button for multi-question */}
          {!isSingleQuestion && (
            <button
              onClick={handleSubmitAnswers}
              disabled={Object.keys(answers).length < questions.length}
              className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white font-medium
                         hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed
                         transition-colors"
            >
              Submit Answers ({Object.keys(answers).length}/{questions.length})
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Render: ExitPlanMode approval UI ────────────────────────────

  if (isExitPlan) {
    const allowedPrompts = (pendingInteraction?.input?.allowedPrompts || []) as {
      tool: string;
      prompt: string;
    }[];
    const planContent = pendingInteraction?.planContent || "";
    return (
      <div className="rounded-lg border-2 border-accent/50 bg-accent/5 overflow-hidden">
        <div className="px-3 py-2 flex items-center gap-2 bg-accent/10">
          <ClipboardCheck size={14} className="text-accent" />
          <span className="text-sm font-medium text-text-primary">Plan ready — approve to proceed</span>
        </div>
        <div className="px-3 py-3">
          {/* Plan content preview */}
          {planContent && (
            <div className="mb-3">
              <div className="text-xs text-text-muted mb-1">Plan:</div>
              <pre className="text-xs bg-code-bg rounded p-3 max-h-64 overflow-y-auto whitespace-pre-wrap text-text-secondary">
                {planContent}
              </pre>
            </div>
          )}
          {allowedPrompts.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-text-muted mb-1">Requested permissions:</div>
              <ul className="text-xs text-text-secondary space-y-0.5">
                {allowedPrompts.map((p, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <Terminal size={10} className="text-text-muted flex-shrink-0" />
                    <span>{p.prompt}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handleExitPlanApprove}
              className="px-4 py-1.5 text-sm rounded-lg bg-success/90 text-white
                         hover:bg-success transition-colors font-medium"
            >
              Approve
            </button>
            <button
              onClick={() => handleExitPlanReject()}
              className="px-4 py-1.5 text-sm rounded-lg bg-bg-secondary border border-border
                         text-text-secondary hover:bg-error/10 hover:text-error hover:border-error/30
                         transition-colors"
            >
              Reject
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Answered state for interactive tools ─────────────────

  if (answered && (toolName === "AskUserQuestion" || toolName === "ExitPlanMode")) {
    return (
      <div className="rounded-lg border border-border bg-tool-bg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
          <span className="text-accent flex-shrink-0">{icon}</span>
          <span className="text-text-secondary text-xs flex-1">{summary}</span>
          <CheckCircle size={13} className="text-success" />
        </div>
      </div>
    );
  }

  // ── Render: Standard tool call card (unchanged) ─────────────────

  return (
    <div className="rounded-lg border border-border bg-tool-bg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-bg-secondary/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
        )}
        <span className="text-accent flex-shrink-0">{icon}</span>
        <span className="text-text-secondary truncate flex-1 text-left text-xs">
          {summary}
        </span>
        {detail && (
          <span className="text-text-muted text-[11px] flex-shrink-0 tabular-nums">
            {detail}
          </span>
        )}
        {detectedUrl && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              openInBrowser(detectedUrl);
            }}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px]
                       bg-accent/10 text-accent hover:bg-accent/20 transition-colors flex-shrink-0"
            title={`Open ${detectedUrl}`}
          >
            <ExternalLink size={10} />
            Open
          </span>
        )}
        {isDone ? (
          <span className={isError ? "text-error" : "text-success"}>
            {isError ? <XCircle size={13} /> : <CheckCircle size={13} />}
          </span>
        ) : (
          <Loader2 size={13} className="text-text-muted animate-spin flex-shrink-0" />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-border">
          {/* Input */}
          <div className="mt-2">
            <div className="text-xs text-text-muted mb-1">Input</div>
            <pre className="text-xs bg-code-bg rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {resultText && (
            <div className="mt-2">
              <div className="text-xs text-text-muted mb-1">
                {isError ? "Error" : "Output"}
              </div>
              <pre
                className={`text-xs rounded p-2 overflow-x-auto max-h-48 overflow-y-auto ${
                  isError ? "bg-error/10 text-error" : "bg-code-bg"
                }`}
              >
                {resultText.slice(0, 2000)}
                {resultText.length > 2000 && "\n... (truncated)"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

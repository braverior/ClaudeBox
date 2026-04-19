/** Types for Claude CLI stream-json output */

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
  is_error?: boolean;
  /** For thinking blocks */
  thinking?: string;
  signature?: string;
  /** For tool_result blocks — references the tool_use id */
  tool_use_id?: string;
}

export interface StreamMessage {
  type: "assistant" | "user" | "system" | "result" | "ask_user" | "exit_plan" | "error";
  subtype?: string;
  session_id?: string;
  message?: {
    id?: string;
    role: "assistant" | "user";
    content: ContentBlock[];
    model?: string;
    stop_reason?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      server_tool_use_input_tokens?: number;
      contextWindow?: number;
    };
  };
  // For result type
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  // For system status events (compacting)
  status?: "compacting" | null;
  compact_metadata?: { trigger: "manual" | "auto"; pre_tokens: number };
  // For user type — enriched tool result info
  tool_use_result?: {
    stdout?: string;
    stderr?: string;
    type?: string;
    filePath?: string;
    content?: string;
  };
  // For ask_user type (interactive question from Claude)
  requestId?: string;
  questions?: AskUserQuestion[];
  // For exit_plan type
  input?: Record<string, unknown>;
  planContent?: string;
}

export interface StreamPayload {
  session_id: string;
  data: string;
  done: boolean;
  error?: string;
  /** "stdout" or "stderr" */
  stream: string;
}

export interface DebugEvent {
  session_id: string;
  level: string; // "info" | "warn" | "error" | "stdin" | "stdout" | "stderr" | "process"
  message: string;
  timestamp: number;
}

/** Parsed message for display in the UI */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  timestamp: number;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    server_tool_use_input_tokens?: number;
    contextWindow?: number;
  };
  isStreaming?: boolean;
  /** Track the original stream message id so we can append content blocks for the same turn */
  streamMessageId?: string;
  /** Attachment metadata for user messages */
  attachments?: { name: string; type: string; path?: string; dataUrl?: string }[];
  /** Number of child messages belonging to an Agent tool run (set when Agent tool_result arrives) */
  agentChildCount?: number;
  /** Per-turn metadata, stored on the last assistant message when the turn completes */
  turnMeta?: {
    tokens: number;
    durationMs: number;
    costUsd?: number;
    inputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    outputTokens?: number;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

// ── Interactive event types (from sidecar) ──────────────────────────

export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

export interface PendingInteraction {
  type: "ask_user" | "exit_plan";
  requestId: string;
  sessionId: string;
  /** For ask_user: the questions array */
  questions?: AskUserQuestion[];
  /** For exit_plan: the tool input (allowedPrompts, etc.) */
  input?: Record<string, unknown>;
  /** For exit_plan: the plan markdown content */
  planContent?: string;
}

export type AnsweredToolData =
  | { type: "ask_user"; answers: { question: string; answer: string }[] }
  | { type: "exit_plan"; planContent: string; rejected?: boolean };

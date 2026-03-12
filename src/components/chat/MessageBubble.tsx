import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ContentBlock, PendingInteraction } from "../../lib/stream-parser";
import CodeBlock from "./CodeBlock";
import ToolCallCard from "./ToolCallCard";
import { formatTimeWithSeconds, formatDuration } from "../../lib/utils";
import { User, Bot, Loader2, Brain, ChevronDown, ChevronRight, Info } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

/** Memoized text block — only re-renders if text actually changes */
const TextBlock = memo(function TextBlock({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props: ComponentPropsWithoutRef<"code">) {
            const { className, children, ...rest } = props;
            const match = /language-(\w+)/.exec(className || "");
            const code = String(children).replace(/\n$/, "");
            const isBlock = match || code.includes("\n");
            if (isBlock) {
              return (
                <CodeBlock
                  code={code}
                  language={match ? match[1] : undefined}
                />
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Collapsible thinking block */
const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
}: {
  thinking: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = thinking.slice(0, 100).replace(/\n/g, " ");

  return (
    <div className="rounded-lg border border-border/50 bg-bg-tertiary/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-bg-tertiary/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown size={14} className="text-text-muted" />
        ) : (
          <ChevronRight size={14} className="text-text-muted" />
        )}
        <Brain size={14} className="text-purple-400" />
        <span className="text-text-muted text-xs">Thinking</span>
        {!expanded && (
          <span className="text-text-muted/50 text-xs truncate flex-1 text-left">
            {preview}...
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-border/50">
          <pre className="text-xs text-text-muted whitespace-pre-wrap mt-2 max-h-64 overflow-y-auto leading-relaxed">
            {thinking}
          </pre>
        </div>
      )}
    </div>
  );
});

/** Memoized tool call — only re-renders if inputs change */
const MemoToolCallCard = memo(ToolCallCard);

interface MessageBubbleProps {
  message: ChatMessage;
  allMessages: ChatMessage[];
  messageIndex: number;
  /** Whether to show the bot avatar (false for consecutive bot messages) */
  showAvatar?: boolean;
  /** Whether this is the last assistant message in its consecutive run (before next user msg or end) */
  isLastInTurn?: boolean;
  /** Whether this is the last assistant message overall */
  isLastAssistant?: boolean;
  /** Total tokens for the current turn */
  totalTokens?: number;
  /** Timestamp when streaming started (for duration calc) */
  streamStartTime?: number;
  /** Pending interactive request from the sidecar */
  pendingInteraction?: PendingInteraction | null;
  /** Callback when user responds to an interactive tool */
  onRespond?: (response: Record<string, unknown>) => void;
}

export default function MessageBubble({
  message,
  allMessages,
  messageIndex,
  showAvatar = true,
  isLastInTurn = false,
  isLastAssistant = false,
  totalTokens = 0,
  streamStartTime,
  pendingInteraction,
  onRespond,
}: MessageBubbleProps) {
  const isUser = message.role === "user";

  const findToolResult = (toolUseId: string): ContentBlock | undefined => {
    // First search within the same message
    for (const block of message.content) {
      if (block.type === "tool_result" && block.tool_use_id === toolUseId)
        return block;
    }
    // Then search subsequent messages
    for (let i = messageIndex + 1; i < allMessages.length; i++) {
      for (const block of allMessages[i].content) {
        if (block.type === "tool_result" && block.tool_use_id === toolUseId)
          return block;
      }
    }
    return undefined;
  };

  if (isUser) {
    // Skip user messages that only contain tool_result blocks (internal, not user-typed)
    const hasText = message.content.some((b) => b.type === "text" && b.text);
    if (!hasText) return null;

    return (
      <div className="flex justify-end mb-4 px-4">
        <div className="flex items-start gap-2.5 max-w-[80%] min-w-0">
          <div className="rounded-2xl rounded-tr-sm px-4 py-2.5 bg-user-bubble text-text-primary overflow-hidden min-w-0">
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[0.9375rem] leading-relaxed">
              {message.content[0]?.text || ""}
            </p>
          </div>
          <div className="flex-shrink-0 w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center mt-0.5">
            <User size={14} className="text-accent" />
          </div>
        </div>
      </div>
    );
  }

  // System message — info line (e.g. "Task started, PID: 12345")
  if (message.role === "system") {
    const text = message.content[0]?.text || "";
    if (!text) return null;
    return (
      <div className="flex items-center justify-center gap-2 my-1 px-4">
        <Info size={12} className="text-text-muted flex-shrink-0" />
        <span className="text-xs text-text-muted">{text}</span>
      </div>
    );
  }

  // Assistant message — render each content block as a separate element
  const blocks = message.content;
  const totalBlocks = blocks.length;

  return (
    <div className={`flex justify-start px-4 ${showAvatar ? "mb-1.5 mt-1" : "mb-0.5"}`}>
      <div className="flex items-start gap-2.5 max-w-[90%] min-w-0">
        {/* Avatar or spacer */}
        {showAvatar ? (
          <div className="flex-shrink-0 w-7 h-7 rounded-full bg-bg-tertiary flex items-center justify-center mt-0.5">
            <Bot size={14} className="text-text-secondary" />
          </div>
        ) : (
          <div className="flex-shrink-0 w-7" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          {blocks.map((block, i) => {
            const key = block.id || `${block.type}-${i}`;
            const isLastBlock = i === totalBlocks - 1;

            if (block.type === "thinking" && block.thinking) {
              return <ThinkingBlock key={key} thinking={block.thinking} />;
            }

            if (block.type === "text" && block.text) {
              return (
                <div key={key} className="px-1 text-text-primary">
                  <TextBlock text={block.text} />
                  {/* Streaming indicator on the last text block */}
                  {message.isStreaming && isLastBlock && (
                    <span className="inline-flex items-center gap-1.5 mt-1 text-text-muted">
                      <Loader2 size={12} className="animate-spin" />
                    </span>
                  )}
                </div>
              );
            }

            if (block.type === "tool_use") {
              const result = block.id ? findToolResult(block.id) : undefined;
              // Pass interactive props only to the last tool_use block that matches
              const isInteractiveTool =
                block.name === "AskUserQuestion" || block.name === "ExitPlanMode";
              return (
                <MemoToolCallCard
                  key={key}
                  block={block}
                  result={result}
                  pendingInteraction={isInteractiveTool ? pendingInteraction : undefined}
                  onRespond={isInteractiveTool ? onRespond : undefined}
                />
              );
            }

            // tool_result rendered inside ToolCallCard, skip standalone
            if (block.type === "tool_result") return null;

            return null;
          })}

          {/* Thinking state when no content yet */}
          {message.isStreaming && blocks.length === 0 && (
            <div className="px-1 py-2 text-text-primary">
              <div className="flex items-center gap-2 text-text-muted">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-sm">Thinking...</span>
              </div>
            </div>
          )}

          {/* Metadata — show on last assistant message of each completed turn */}
          {isLastInTurn && !message.isStreaming && (
            <div className="flex items-center gap-3 px-1 mt-1 mb-2 text-xs text-text-muted">
              <span>{formatTimeWithSeconds(message.timestamp)}</span>
              {/* Duration: from stored turnMeta (completed) or live calc (most recent) */}
              {message.turnMeta && message.turnMeta.durationMs > 0 ? (
                <span>{formatDuration(message.turnMeta.durationMs)}</span>
              ) : isLastAssistant && streamStartTime ? (
                <span>{formatDuration(Math.max(0, message.timestamp - streamStartTime))}</span>
              ) : null}
              {message.model && <span>{message.model}</span>}
              {/* Tokens: from stored turnMeta (completed) or live calc (most recent) */}
              {message.turnMeta && message.turnMeta.tokens > 0 ? (
                <span>{message.turnMeta.tokens.toLocaleString()} tokens</span>
              ) : isLastAssistant && totalTokens > 0 ? (
                <span>{totalTokens.toLocaleString()} tokens</span>
              ) : null}
              {/* Cost from turnMeta */}
              {message.turnMeta?.costUsd != null && message.turnMeta.costUsd > 0 && (
                <span>${message.turnMeta.costUsd.toFixed(4)}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

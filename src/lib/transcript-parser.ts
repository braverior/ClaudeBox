/**
 * Parse a Claude Code JSONL transcript (the contents of
 * `~/.claude/projects/<encoded>/<sessionUuid>.jsonl`) into the `ChatMessage[]`
 * model the UI renders. This mirrors the in-memory reconstruction done live in
 * `chatStore.handleStreamData` (assistant block merging, tool_use↔tool_result
 * pairing, agent child counting, compaction markers, per-turn token metadata),
 * but operates on a static file instead of a live event stream.
 *
 * Live-only markers (`__launch__`, `__streaming__`, `__compacting__`) never
 * appear in the JSONL, so they are not produced here. `__compacted__:<n>` is
 * reconstructed from `compact_boundary` system lines.
 *
 * Phase 1: text / thinking / tool_use / tool_result / compaction. Sub-agent
 * (`isSidechain`) lines are skipped — their parent Agent tool_use + tool_result
 * still render, just without the collapsible child transcript.
 */

import type { ChatMessage, ContentBlock } from "./stream-parser";
import { v4Style } from "./utils";

interface RawLine {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  uuid?: string;
  timestamp?: string;
  subtype?: string;
  compact_metadata?: { pre_tokens?: number };
  message?: {
    id?: string;
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
    usage?: ChatMessage["usage"];
  };
}

function tsToMs(ts?: string): number {
  if (!ts) return Date.now();
  const n = Date.parse(ts);
  return Number.isNaN(n) ? Date.now() : n;
}

/**
 * Append newly-seen blocks onto an assistant message's content. Claude writes
 * one JSONL line per completed block (or block group), all sharing the same
 * `message.id`, so we merge by block id / trailing text — a static copy of the
 * logic in `chatStore.ts:appendNewBlocks`.
 */
function appendNewBlocks(existing: ContentBlock[], incoming: ContentBlock[]): ContentBlock[] {
  if (incoming.length === 0) return existing;
  const existingIds = new Set(existing.map((b) => b.id).filter(Boolean));
  const result = [...existing];
  for (const block of incoming) {
    if (block.id && existingIds.has(block.id)) {
      const idx = result.findIndex((b) => b.id === block.id);
      if (idx >= 0) result[idx] = block;
      continue;
    }
    const last = result[result.length - 1];
    if (block.type === "text" && last?.type === "text" && !block.id && !last.id) {
      result[result.length - 1] = block;
      continue;
    }
    result.push(block);
    if (block.id) existingIds.add(block.id);
  }
  return result;
}

/**
 * Second pass: attach per-turn token/duration metadata to the last assistant
 * message of each turn (a "turn" = a user message and the assistant messages
 * that follow until the next user message). Mirrors the `result`-event
 * aggregation in `chatStore.ts`, minus cost (not present in the JSONL).
 */
function computeTurnMeta(msgs: ChatMessage[]): void {
  let turnStart = 0;
  const flush = (endExclusive: number) => {
    let turnTokens = 0;
    let lastAssistantIdx = -1;
    let inputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0, outputTokens = 0;
    for (let i = turnStart; i < endExclusive; i++) {
      if (msgs[i].role !== "assistant") continue;
      lastAssistantIdx = i;
      const u = msgs[i].usage;
      if (u) {
        inputTokens += u.input_tokens || 0;
        outputTokens += u.output_tokens || 0;
        cacheCreationTokens += u.cache_creation_input_tokens || 0;
        cacheReadTokens += u.cache_read_input_tokens || 0;
        turnTokens += (u.input_tokens || 0) + (u.output_tokens || 0)
          + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      }
    }
    if (lastAssistantIdx >= 0 && turnTokens > 0) {
      // Duration is unknown from the JSONL; approximate from message timestamps.
      let firstAssistantTs = 0;
      for (let i = turnStart; i < endExclusive; i++) {
        if (msgs[i].role === "assistant") { firstAssistantTs = msgs[i].timestamp; break; }
      }
      const durationMs = Math.max(0, msgs[lastAssistantIdx].timestamp - firstAssistantTs);
      msgs[lastAssistantIdx] = {
        ...msgs[lastAssistantIdx],
        turnMeta: { tokens: turnTokens, durationMs, inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens },
      };
    }
  };
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "user" && i > turnStart) {
      flush(i);
      turnStart = i;
    }
  }
  flush(msgs.length);
}

export function parseTranscript(raw: string): ChatMessage[] {
  if (!raw) return [];
  const msgs: ChatMessage[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: RawLine;
    try {
      o = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // Sub-agent internal transcript lines — skip in phase 1.
    if (o.isSidechain === true) continue;

    const ts = tsToMs(o.timestamp);

    if (o.type === "assistant" && o.message) {
      const content = Array.isArray(o.message.content) ? o.message.content : [];
      if (content.length === 0) continue;
      const streamMsgId = o.message.id;
      const usage = o.message.usage;
      const existingIdx = streamMsgId
        ? msgs.findIndex((m) => m.role === "assistant" && m.streamMessageId === streamMsgId)
        : -1;
      if (existingIdx >= 0) {
        const ex = msgs[existingIdx];
        msgs[existingIdx] = {
          ...ex,
          content: appendNewBlocks(ex.content, content),
          model: o.message.model || ex.model,
          usage: usage ?? ex.usage,
        };
      } else {
        msgs.push({
          id: streamMsgId || o.uuid || v4Style(),
          streamMessageId: streamMsgId,
          role: "assistant",
          content,
          timestamp: ts,
          model: o.message.model,
          usage,
        });
      }
    } else if (o.type === "user" && o.message) {
      const content = o.message.content;
      if (typeof content === "string") {
        if (content.length === 0) continue;
        msgs.push({ id: o.uuid || v4Style(), role: "user", content: [{ type: "text", text: content }], timestamp: ts });
      } else if (Array.isArray(content)) {
        // tool_result blocks get appended onto the matching assistant tool_use;
        // any remaining blocks form a real user message bubble.
        const nonToolResults: ContentBlock[] = [];
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i];
              if (m.role !== "assistant") continue;
              const hasToolUse = m.content.some((b) => b.type === "tool_use" && b.id === block.tool_use_id);
              if (!hasToolUse) continue;
              const updates: Partial<ChatMessage> = { content: [...m.content, block] };
              const isAgent = m.content.some(
                (b) => b.type === "tool_use" && b.id === block.tool_use_id && b.name === "Agent"
              );
              if (isAgent) {
                let childCount = 0;
                for (let k = i + 1; k < msgs.length; k++) {
                  if (msgs[k].role === "user") break;
                  childCount++;
                }
                updates.agentChildCount = childCount;
              }
              msgs[i] = { ...m, ...updates };
              break;
            }
          } else if (block.type !== "tool_result") {
            nonToolResults.push(block);
          }
        }
        if (nonToolResults.length > 0) {
          msgs.push({ id: o.uuid || v4Style(), role: "user", content: nonToolResults, timestamp: ts });
        }
      }
    } else if (o.type === "system") {
      if (o.subtype === "compact_boundary" && o.compact_metadata) {
        msgs.push({
          id: o.uuid || v4Style(),
          role: "system",
          content: [{ type: "text", text: `__compacted__:${o.compact_metadata.pre_tokens ?? 0}` }],
          timestamp: ts,
        });
      }
    }
    // attachment / mode / permission-mode / ai-title / last-prompt /
    // queue-operation / agent-name / file-history-snapshot → ignored.
  }

  computeTurnMeta(msgs);
  return msgs;
}

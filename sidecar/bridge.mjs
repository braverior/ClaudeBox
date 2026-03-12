#!/usr/bin/env node
/**
 * ClaudeBox Sidecar Bridge
 *
 * Bridges the @anthropic-ai/claude-agent-sdk query() API with the Rust
 * backend via NDJSON over stdin/stdout.
 *
 * Protocol (Rust → Sidecar, stdin):
 *   {"type":"start","prompt":"…","cwd":"…","model":"…","resume":"…","allowedTools":[…],"permissionMode":"…"}
 *   {"type":"response","requestId":"req-1","behavior":"allow","answers":{…}}
 *   {"type":"response","requestId":"req-2","behavior":"deny","message":"…"}
 *   {"type":"abort"}
 *
 * Protocol (Sidecar → Rust, stdout):
 *   {"type":"system","subtype":"init","session_id":"…",…}
 *   {"type":"assistant","message":{…}}
 *   {"type":"user","message":{…}}
 *   {"type":"result","session_id":"…","total_cost_usd":…}
 *   {"type":"ask_user","requestId":"req-1","questions":[…]}
 *   {"type":"exit_plan","requestId":"req-2","input":{…}}
 *   {"type":"error","message":"…"}
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";
import { execSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, chmodSync, unlinkSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// ── Pre-flight & diagnostics ────────────────────────────────────────

/** Build a clean env (no CLAUDECODE) for the SDK child process */
function cleanEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

function preflight() {
  // Check CLAUDECODE env var
  if (process.env.CLAUDECODE) {
    console.error(`[bridge] WARNING: CLAUDECODE=${process.env.CLAUDECODE} found, will be removed for child`);
  }

  // Check claude is accessible
  try {
    const ver = execSync("claude --version", { encoding: "utf-8", timeout: 5000, env: cleanEnv() }).trim();
    console.error(`[bridge] claude --version: ${ver}`);
  } catch (e) {
    console.error(`[bridge] claude --version FAILED: ${e.message}`);
    if (e.stderr) console.error(`[bridge] stderr: ${e.stderr}`);
  }
}

/**
 * Create a wrapper script around `claude` that tees stderr to a temp file.
 * Returns { wrapperPath, stderrPath, cleanup }.
 */
function createClaudeWrapper() {
  const dir = mkdtempSync(join(tmpdir(), "claudebox-"));
  const stderrPath = join(dir, "claude-stderr.log");
  const wrapperPath = join(dir, "claude-wrapper.sh");

  // Find real claude path
  let claudePath = "claude";
  try {
    claudePath = execSync("which claude", { encoding: "utf-8", env: cleanEnv() }).trim();
  } catch { /* use default */ }

  writeFileSync(wrapperPath, `#!/bin/bash
exec "${claudePath}" "$@" 2> >(tee "${stderrPath}" >&2)
`);
  chmodSync(wrapperPath, 0o755);

  return {
    wrapperPath,
    stderrPath,
    cleanup() {
      try { unlinkSync(wrapperPath); } catch {}
      try { unlinkSync(stderrPath); } catch {}
    },
    readStderr() {
      try {
        return readFileSync(stderrPath, "utf-8");
      } catch { return ""; }
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitError(message) {
  emit({ type: "error", message: String(message) });
}

/** Emit detailed error info from Error objects */
function emitDetailedError(err) {
  const parts = [];
  parts.push(err.message || String(err));
  if (err.cause) parts.push(`Cause: ${err.cause.message || err.cause}`);
  if (err.stderr) parts.push(`Stderr: ${err.stderr}`);
  if (err.code) parts.push(`Code: ${err.code}`);
  if (err.exitCode !== undefined) parts.push(`Exit code: ${err.exitCode}`);
  emitError(parts.join(" | "));
}

// ── Pending permission requests ─────────────────────────────────────

let requestCounter = 0;
/** @type {Map<string, { resolve: (val: any) => void }>} */
const pendingRequests = new Map();

function nextRequestId() {
  return `req-${++requestCounter}`;
}

/** Reject all pending requests (e.g. on stdin close or abort) */
function rejectAllPending(reason) {
  for (const [, { resolve }] of pendingRequests) {
    resolve({ behavior: "deny", message: reason });
  }
  pendingRequests.clear();
}

// ── stdin reader ────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });
/** @type {((line: string) => void) | null} */
let onFirstLine = null;

rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;

  // First line is handled by the startup code
  if (onFirstLine) {
    const cb = onFirstLine;
    onFirstLine = null;
    cb(line);
    return;
  }

  try {
    const msg = JSON.parse(line);

    if (msg.type === "response" && msg.requestId) {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        pendingRequests.delete(msg.requestId);
        pending.resolve(msg);
      }
      return;
    }

    if (msg.type === "abort") {
      rejectAllPending("Session aborted");
      if (activeAbort) activeAbort.abort();
      return;
    }
  } catch {
    // ignore malformed lines
  }
});

rl.on("close", () => {
  // stdin closed — reject pending requests and abort any running query
  rejectAllPending("Session terminated");
  if (activeAbort) activeAbort.abort();
  process.exit(0);
});

// ── Main ────────────────────────────────────────────────────────────

/** @type {AbortController | null} */
let activeAbort = null;

/**
 * Wait for a response from Rust for a given requestId.
 * @param {string} requestId
 * @returns {Promise<any>}
 */
function waitForResponse(requestId) {
  return new Promise((resolve) => {
    pendingRequests.set(requestId, { resolve });
  });
}

/**
 * canUseTool callback — intercepts AskUserQuestion and ExitPlanMode.
 * For other tools, auto-allow if in allowedTools list or deny.
 */
function makeCanUseTool(allowedTools, cwd) {
  return async (toolName, input, _options) => {
    // AskUserQuestion — send to frontend, wait for user answer
    if (toolName === "AskUserQuestion") {
      // Fix: model sometimes sends questions as a JSON string instead of array
      let questions = input.questions || [];
      if (typeof questions === "string") {
        try {
          questions = JSON.parse(questions);
        } catch {
          console.error(`[bridge] Failed to parse questions string: ${questions.slice(0, 200)}`);
          questions = [];
        }
      }

      const requestId = nextRequestId();
      emit({
        type: "ask_user",
        requestId,
        questions,
      });
      const resp = await waitForResponse(requestId);
      if (resp.behavior === "allow") {
        return {
          behavior: "allow",
          updatedInput: {
            ...input,
            questions, // ensure it's the parsed array
            answers: resp.answers || {},
            annotations: resp.annotations,
          },
        };
      }
      return { behavior: "deny", message: resp.message || "User cancelled" };
    }

    // ExitPlanMode — read plan file content, send to frontend, wait for approval
    if (toolName === "ExitPlanMode") {
      // Try to find and read the most recent plan file
      let planContent = "";
      try {
        planContent = findLatestPlanContent(cwd);
      } catch (e) {
        console.error(`[bridge] Failed to read plan file: ${e.message}`);
      }

      const requestId = nextRequestId();
      emit({
        type: "exit_plan",
        requestId,
        input,
        planContent,
      });
      const resp = await waitForResponse(requestId);
      if (resp.behavior === "allow") {
        return { behavior: "allow" };
      }
      return {
        behavior: "deny",
        message: resp.message || "Plan rejected by user",
      };
    }

    // All other tools: auto-allow
    // (The SDK + permissionMode handles the rest)
    return { behavior: "allow" };
  };
}

/**
 * Find and read the most recently modified plan file from .claude/plans/
 */
function findLatestPlanContent(cwd) {
  // Plans are stored in ~/.claude/projects/{project-key}/plans/ or in the project's .claude/plans/
  const searchDirs = [];

  // 1. Project-local .claude/plans/
  if (cwd) {
    searchDirs.push(join(cwd, ".claude", "plans"));
  }

  // 2. Global ~/.claude/projects/ (search for directories matching the cwd)
  const globalBase = join(homedir(), ".claude", "projects");
  try {
    for (const entry of readdirSync(globalBase)) {
      const plansDir = join(globalBase, entry, "plans");
      try {
        statSync(plansDir);
        searchDirs.push(plansDir);
      } catch { /* not a dir */ }
    }
  } catch { /* no global projects dir */ }

  // Find the most recently modified .md file across all search dirs
  let latestFile = null;
  let latestMtime = 0;

  for (const dir of searchDirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const fullPath = join(dir, file);
        const st = statSync(fullPath);
        if (st.mtimeMs > latestMtime) {
          latestMtime = st.mtimeMs;
          latestFile = fullPath;
        }
      }
    } catch { /* dir doesn't exist */ }
  }

  if (latestFile && Date.now() - latestMtime < 60000) {
    // Only read if modified within the last 60 seconds (likely the current plan)
    console.error(`[bridge] Reading plan file: ${latestFile}`);
    return readFileSync(latestFile, "utf-8");
  }

  return "";
}

async function main() {
  // Capture stderr from SDK internals for diagnostics
  const stderrChunks = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(String(chunk));
    // Keep last 50 lines
    if (stderrChunks.length > 50) stderrChunks.shift();
    return origStderrWrite(chunk, ...args);
  };

  // Wait for the first "start" message from Rust
  const startMsg = await new Promise((resolve) => {
    onFirstLine = (line) => {
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        emitError(`Invalid start message: ${e.message}`);
        process.exit(1);
      }
    };
  });

  if (startMsg.type !== "start") {
    emitError(`Expected 'start' message, got '${startMsg.type}'`);
    process.exit(1);
  }

  const {
    prompt,
    cwd,
    model,
    resume,
    allowedTools,
    permissionMode,
  } = startMsg;

  // Log config for diagnostics (to stderr, which Rust captures)
  console.error(`[bridge] model=${model || "(default)"} cwd=${cwd} permissionMode=${permissionMode || "(default)"}`);
  console.error(`[bridge] ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "set (" + process.env.ANTHROPIC_API_KEY.slice(0, 10) + "...)" : "NOT SET"}`);
  console.error(`[bridge] ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL || "NOT SET"}`);

  // Run pre-flight diagnostics
  preflight();

  // Create wrapper to capture claude CLI stderr
  const wrapper = createClaudeWrapper();
  console.error(`[bridge] Using claude wrapper: ${wrapper.wrapperPath}`);

  const abortController = new AbortController();
  activeAbort = abortController;

  /** @type {import("@anthropic-ai/claude-agent-sdk").Options} */
  const options = {
    abortController,
    canUseTool: makeCanUseTool(allowedTools || [], cwd),
    // Pass clean env without CLAUDECODE
    env: cleanEnv(),
    // Use wrapper to capture stderr
    pathToClaudeCodeExecutable: wrapper.wrapperPath,
  };

  if (cwd) options.cwd = cwd;
  if (model) options.model = model;
  if (resume) options.resume = resume;
  if (permissionMode) options.permissionMode = permissionMode;
  if (allowedTools && allowedTools.length > 0) {
    options.allowedTools = allowedTools;
  }

  try {
    const conversation = query({ prompt, options });

    for await (const message of conversation) {
      // Emit messages in a format compatible with the existing stream-json output
      switch (message.type) {
        case "system": {
          // The init message — includes session_id, tools, model, etc.
          emit({
            type: "system",
            subtype: message.subtype,
            session_id: message.session_id,
            tools: message.tools,
            model: message.model,
            cwd: message.cwd,
          });
          break;
        }

        case "assistant": {
          // The assistant message — contains Anthropic BetaMessage
          const m = message.message;
          emit({
            type: "assistant",
            message: {
              id: m.id,
              role: m.role,
              content: m.content,
              model: m.model,
              stop_reason: m.stop_reason,
              usage: m.usage,
            },
          });
          break;
        }

        case "user": {
          // Tool result messages
          const m = message.message;
          emit({
            type: "user",
            message: {
              role: "user",
              content: Array.isArray(m.content) ? m.content : m,
            },
          });
          break;
        }

        case "result": {
          emit({
            type: "result",
            subtype: message.subtype,
            session_id: message.session_id,
            result: message.result,
            is_error: message.is_error,
            total_cost_usd: message.total_cost_usd,
            duration_ms: message.duration_ms,
            duration_api_ms: message.duration_api_ms,
            num_turns: message.num_turns,
          });
          break;
        }

        default:
          // Other message types (status, auth, etc.) — skip for now
          break;
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      emit({ type: "result", subtype: "aborted", is_error: false });
    } else {
      // Dump ALL error properties for debugging
      const allProps = {};
      for (const key of Object.getOwnPropertyNames(err)) {
        try {
          const val = err[key];
          if (typeof val !== "function") allProps[key] = val;
        } catch { /* ignore */ }
      }

      const parts = [err.message || String(err)];
      if (err.cause) {
        const causeMsg = typeof err.cause === "object"
          ? JSON.stringify(err.cause, Object.getOwnPropertyNames(err.cause))
          : String(err.cause);
        parts.push(`Cause: ${causeMsg}`);
      }
      if (err.stderr) parts.push(`Stderr: ${err.stderr}`);
      if (err.code) parts.push(`Code: ${err.code}`);
      if (err.exitCode !== undefined) parts.push(`ExitCode: ${err.exitCode}`);

      // Append captured stderr for context
      const recentStderr = stderrChunks.join("").trim();
      if (recentStderr) {
        parts.push(`\nBridge stderr:\n${recentStderr.slice(-1000)}`);
      }

      // Read claude CLI stderr captured by wrapper script
      const capturedStderr = wrapper.readStderr();
      if (capturedStderr) {
        parts.push(`\nClaude CLI stderr:\n${capturedStderr.slice(-2000)}`);
      }

      // Append full error dump
      parts.push(`\nError properties: ${JSON.stringify(allProps).slice(0, 2000)}`);

      emitError(parts.join(" | "));
    }
  }

  wrapper.cleanup();
  process.exit(0);
}

main().catch((err) => {
  emitDetailedError(err);
  process.exit(1);
});

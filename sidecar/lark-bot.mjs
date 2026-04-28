#!/usr/bin/env node
/**
 * ClaudeBox Lark Bot Sidecar
 *
 * Long-running Node.js process that bridges Lark (飞书) bot messages
 * with the Claude Agent SDK. Communicates with Rust backend via NDJSON
 * over stdin/stdout.
 *
 * Protocol (Rust → Sidecar, stdin):
 *   {"type":"start","app_id":"…","app_secret":"…","project_dir":"…","model":"…","api_key":"…","base_url":"…"}
 *   {"type":"notify","title":"…","content":"…","card_type":"start|end|todo|error"}
 *   {"type":"create_task","project_path":"…","project_name":"…","description":"…"}
 *   {"type":"update_task","task_id":"…","status":"in_progress|done"}
 *   {"type":"sync_sessions","sessions":[…]}
 *   {"type":"stop"}
 *
 * Protocol (Sidecar → Rust, stdout):
 *   {"type":"status","status":"connecting|connected|disconnected|error","reason":"…"}
 *   {"type":"lark_message","message_id":"…","sender_id":"…","sender_name":"…","content":"…","chat_id":"…","chat_type":"…","timestamp":…}
 *   {"type":"lark_execute","message_id":"…","chat_id":"…","prompt":"…","project_path":"…","summary":"…"}
 *   {"type":"ai_reply","message_id":"…","reply":"…"}
 *   {"type":"notification_sent","success":true|false,"error":"…"}
 *   {"type":"task_created","task":{…}}
 *   {"type":"task_updated","task_id":"…","status":"…"}
 *   {"type":"error","message":"…"}
 */

import * as lark from "@larksuiteoapi/node-sdk";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Helpers ─────────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitError(message) {
  emit({ type: "error", message: String(message) });
}

// ── State ───────────────────────────────────────────────────────────

let config = null;        // Start config from Rust
let client = null;        // lark.Client instance
let wsClient = null;      // lark.WSClient instance
let sessions = [];        // ClaudeBox sessions data (synced from frontend)
let devTasks = [];         // Development tasks
let taskIdCounter = 0;

/** App-initiated sessions tracked for Lark visibility: sessionId → { sessionId, projectPath, prompt, status, startedAt } */
let appActivities = [];

/**
 * Per-chat persistent memory.
 *
 * @typedef {{
 *   turns: Array<{ role: string, content: any }>,
 *   messageLog: Array<{ ts: number, dir: "in"|"out", text: string, messageId?: string }>,
 *   executions: Array<{ ts: number, sessionId?: string, project?: string, prompt?: string, status: string, summary?: string, output?: string }>,
 *   defaultProject?: string,
 *   senderName?: string,
 *   lastActivity: number,
 * }} ChatState
 *
 * @type {Map<string, ChatState>}
 */
const conversationState = new Map();
const CONVERSATION_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_TURNS = 24;        // ~12 exchanges (incl tool_use/tool_result)
const MAX_MSG_LOG = 40;
const MAX_EXECUTIONS = 20;
const MAX_TOOL_LOOPS = 6;

/** Map session_id → chat_id, for routing execution completion back to memory. */
const sessionChatMap = new Map();

// Persistent memory file
const MEMORY_DIR = join(homedir(), ".claudebox", "data");
const MEMORY_PATH = join(MEMORY_DIR, "lark-memory.json");

function loadMemory() {
  try {
    if (!existsSync(MEMORY_PATH)) return;
    const raw = JSON.parse(readFileSync(MEMORY_PATH, "utf-8"));
    let loaded = 0;
    for (const [chatId, state] of Object.entries(raw)) {
      if (!state || typeof state !== "object") continue;
      if (Date.now() - (state.lastActivity || 0) > CONVERSATION_EXPIRE_MS) continue;
      conversationState.set(chatId, {
        turns: Array.isArray(state.turns) ? state.turns : [],
        messageLog: Array.isArray(state.messageLog) ? state.messageLog : [],
        executions: Array.isArray(state.executions) ? state.executions : [],
        defaultProject: state.defaultProject || undefined,
        senderName: state.senderName || undefined,
        lastActivity: state.lastActivity || Date.now(),
      });
      loaded++;
    }
    console.error(`[lark-bot] Loaded memory for ${loaded} chats`);
  } catch (e) {
    console.error(`[lark-bot] loadMemory failed: ${e.message}`);
  }
}

let saveTimer = null;
function saveMemoryDebounced() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(MEMORY_DIR, { recursive: true });
      const obj = Object.fromEntries(conversationState);
      writeFileSync(MEMORY_PATH, JSON.stringify(obj, null, 2));
    } catch (e) {
      console.error(`[lark-bot] saveMemory failed: ${e.message}`);
    }
  }, 500);
}

function getOrInitChatState(chatId) {
  let state = conversationState.get(chatId);
  if (!state) {
    state = {
      turns: [],
      messageLog: [],
      executions: [],
      lastActivity: Date.now(),
    };
    conversationState.set(chatId, state);
  }
  // Expire stale turns (keep executions / defaultProject longer)
  if (Date.now() - state.lastActivity > CONVERSATION_EXPIRE_MS) {
    state.turns = [];
  }
  return state;
}

function pushMessageLog(state, dir, text, messageId) {
  state.messageLog.push({ ts: Date.now(), dir, text: (text || "").slice(0, 2000), messageId });
  if (state.messageLog.length > MAX_MSG_LOG) {
    state.messageLog = state.messageLog.slice(-MAX_MSG_LOG);
  }
}

/** Dedup: recently processed message IDs (Lark WebSocket may redeliver on reconnect) */
const processedMessages = new Set();
const MAX_PROCESSED = 200;

// ── ClaudeBox Sessions Reader ───────────────────────────────────────

/**
 * Read ClaudeBox sessions from persistent storage.
 * Sessions are stored in ~/.claudebox/data/sessions.json
 */
function readStoredSessions() {
  try {
    const sessionsPath = join(homedir(), ".claudebox", "data", "sessions.json");
    if (existsSync(sessionsPath)) {
      const data = readFileSync(sessionsPath, "utf-8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.error(`[lark-bot] Failed to read sessions: ${e.message}`);
  }
  return [];
}

/**
 * Build a project summary from sessions data.
 */
function buildProjectSummary() {
  const storedSessions = sessions.length > 0 ? sessions : readStoredSessions();
  if (!storedSessions || storedSessions.length === 0) {
    return "当前没有已记录的项目会话。";
  }

  // Group sessions by project path
  const projects = new Map();
  for (const s of storedSessions) {
    const path = s.projectPath || s.cwd || "unknown";
    const name = s.projectName || s.name || path.split("/").pop();
    if (!projects.has(path)) {
      projects.set(path, { name, path, sessions: [] });
    }
    projects.get(path).sessions.push(s);
  }

  const lines = [];
  for (const [, proj] of projects) {
    const count = proj.sessions.length;
    const lastSession = proj.sessions[proj.sessions.length - 1];
    const lastTime = lastSession?.updatedAt
      ? new Date(lastSession.updatedAt).toLocaleString("zh-CN")
      : "未知";
    lines.push(`**${proj.name}**\n📂 \`${proj.path}\`\n💬 ${count} 个会话 · 最近活跃: ${lastTime}`);
  }
  return lines.join("\n\n---\n\n");
}

// ── Dev Tasks ───────────────────────────────────────────────────────

function createTask(projectPath, projectName, description) {
  const task = {
    id: `t${++taskIdCounter}`,
    projectPath,
    projectName,
    description,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  devTasks.push(task);
  return task;
}

function updateTask(taskId, status) {
  const task = devTasks.find((t) => t.id === taskId);
  if (task) {
    task.status = status;
    task.updatedAt = Date.now();
    return task;
  }
  return null;
}

function formatTaskList() {
  // Include both Lark-created tasks and app-initiated active sessions
  const allItems = [];

  for (const t of devTasks) {
    const statusEmoji = t.status === "done" ? "✅" : t.status === "in_progress" ? "🔄" : "⏳";
    allItems.push(`${statusEmoji} **${t.projectName}**\n📌 ${t.description}\n状态: \`${t.status}\``);
  }

  for (const a of appActivities) {
    const elapsed = Math.round((Date.now() - a.startedAt) / 1000);
    const statusEmoji = a.status === "completed" ? "✅" : a.status === "error" ? "❌" : "🔄";
    const statusLabel = a.status === "completed" ? "已完成" : a.status === "error" ? "失败" : "运行中";
    const projectName = (a.projectPath || "").split("/").pop() || "未知项目";
    const timeStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}分${elapsed % 60}秒` : `${elapsed}秒`;
    let line = `${statusEmoji} **${projectName}**\n📝 ${a.prompt}\n⏱️ ${timeStr} · ${statusLabel}`;
    if (a.lastMessage) {
      line += `\n\n> ${a.lastMessage.replace(/\n/g, "\n> ")}`;
    }
    allItems.push(line);
  }

  if (allItems.length === 0) return "当前没有开发任务。";
  return allItems.join("\n\n---\n\n");
}

// ── Lark Notification Cards ─────────────────────────────────────────

function buildNotificationCard(title, content, cardType) {
  const colorMap = {
    start: "green",
    end: "blue",
    todo: "orange",
    error: "red",
    green: "green",
    blue: "blue",
    orange: "orange",
    red: "red",
    purple: "purple",
  };

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template: colorMap[cardType] || "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content,
        },
      },
      {
        tag: "note",
        elements: [
          { tag: "plain_text", content: `ClaudeBox · ${new Date().toLocaleString("zh-CN")}` },
        ],
      },
    ],
  };
}

async function sendNotification(chatId, title, content, cardType) {
  if (!client) {
    emitError("Lark client not initialized");
    return;
  }

  // If no chatId, we can't send notification
  if (!chatId) {
    emitError("No chat_id specified for notification");
    return;
  }

  try {
    const card = buildNotificationCard(title, content, cardType);
    await client.im.message.create({
      data: {
        receive_id: chatId,
        content: JSON.stringify(card),
        msg_type: "interactive",
      },
      params: { receive_id_type: "chat_id" },
    });
    emit({ type: "notification_sent", success: true });
  } catch (err) {
    emit({ type: "notification_sent", success: false, error: err.message });
  }
}

// ── Lark Command Parsing ────────────────────────────────────────────

/**
 * Parse special commands from Lark messages.
 * Returns { isCommand: true, response: "..." } if it's a command,
 * or { isCommand: false } if it should go to AI.
 */
function parseCommand(text) {
  const trimmed = text.trim();

  // /tasks — list tasks
  if (trimmed === "/tasks" || trimmed === "任务列表") {
    return { isCommand: true, response: formatTaskList(), cardTitle: "📋 任务列表", cardType: "orange" };
  }

  // /task <project> <description> — create task
  const taskMatch = trimmed.match(/^\/task\s+(\S+)\s+(.+)$/);
  if (taskMatch) {
    const [, projectName, description] = taskMatch;
    // Resolve projectPath from stored sessions by matching project name
    let projectPath = "";
    const storedSessions = sessions.length > 0 ? sessions : readStoredSessions();
    for (const s of storedSessions) {
      const name = s.projectName || s.name || (s.projectPath || "").split("/").pop();
      if (name && name.toLowerCase() === projectName.toLowerCase()) {
        projectPath = s.projectPath || s.cwd || "";
        break;
      }
    }
    const task = createTask(projectPath, projectName, description);
    emit({ type: "task_created", task });
    return {
      isCommand: true,
      response: `已创建开发任务 **[${task.id}]**\n\n📦 项目: ${projectName}${projectPath ? `\n📂 路径: \`${projectPath}\`` : ""}\n📝 内容: ${description}`,
      cardTitle: "✅ 任务已创建",
      cardType: "green",
      triggerAI: true,
      aiPrompt: `请在项目 ${projectName}${projectPath ? ` (${projectPath})` : ""} 中执行以下开发任务：${description}`,
      aiCwd: projectPath || config?.project_dir || "",
    };
  }

  // /done <taskId> — complete task
  const doneMatch = trimmed.match(/^\/done\s+(\S+)$/);
  if (doneMatch) {
    const task = updateTask(doneMatch[1], "done");
    if (task) {
      emit({ type: "task_updated", task_id: task.id, status: "done" });
      return { isCommand: true, response: `任务 **[${task.id}]** 已标记完成 ✅`, cardTitle: "任务完成", cardType: "blue" };
    }
    return { isCommand: true, response: `未找到任务 \`${doneMatch[1]}\``, cardTitle: "⚠️ 未找到", cardType: "orange" };
  }

  // /start <taskId> — start task
  const startMatch = trimmed.match(/^\/start\s+(\S+)$/);
  if (startMatch) {
    const task = updateTask(startMatch[1], "in_progress");
    if (task) {
      emit({ type: "task_updated", task_id: task.id, status: "in_progress" });
      return { isCommand: true, response: `任务 **[${task.id}]** 已开始 🔄`, cardTitle: "任务开始", cardType: "green" };
    }
    return { isCommand: true, response: `未找到任务 \`${startMatch[1]}\``, cardTitle: "⚠️ 未找到", cardType: "orange" };
  }

  // 项目列表 / "我有哪些项目"
  if (trimmed === "项目列表" || trimmed.includes("有哪些项目") || trimmed === "/projects") {
    return { isCommand: true, response: buildProjectSummary(), cardTitle: "📂 项目列表", cardType: "blue" };
  }

  // /use <项目> — 设置当前聊天默认项目
  const useMatch = trimmed.match(/^\/use\s+(.+)$/);
  if (useMatch) {
    return {
      isCommand: true,
      cardTitle: "✅ 默认项目已设置",
      cardType: "green",
      response: "",
      setDefaultProject: useMatch[1].trim(),
    };
  }

  // /忘记 /reset /forget — 清空当前聊天记忆
  if (trimmed === "/忘记" || trimmed === "/reset" || trimmed === "/forget") {
    return {
      isCommand: true,
      cardTitle: "🧹 已清空记忆",
      cardType: "orange",
      response: "该聊天的对话历史、默认项目、执行记录已全部清空。",
      clearMemory: true,
    };
  }

  // /help
  if (trimmed === "/help" || trimmed === "帮助") {
    return {
      isCommand: true,
      cardTitle: "📖 使用帮助",
      cardType: "blue",
      response: [
        "直接发送消息，助理会调用工具理解并完成任务。",
        "例如：「dmads 项目帮我验证聚合 SDK 竞价只会返回一个广告对象」",
        "",
        "**快捷指令：**",
        "• `/projects` — 查看所有项目",
        "• `/tasks` — 查看开发任务",
        "• `/task <项目名> <开发内容>` — 创建开发任务",
        "• `/start <任务ID>` — 开始任务",
        "• `/done <任务ID>` — 完成任务",
        "• `/use <项目>` — 设置当前聊天默认项目",
        "• `/忘记` — 清空本聊天的记忆",
        "• `/help` — 显示此帮助",
      ].join("\n"),
    };
  }

  return { isCommand: false };
}

// ── Tool Definitions ───────────────────────────────────────────────

/** Resolve a project name/path fragment to a full path via sessions. */
function resolveProjectPath(query) {
  if (!query) return { path: "", name: "" };
  const q = query.trim().toLowerCase();
  const storedSessions = sessions.length > 0 ? sessions : readStoredSessions();

  // Exact path match first
  for (const s of storedSessions) {
    const path = s.projectPath || s.cwd || "";
    if (path.toLowerCase() === q) {
      return { path, name: s.projectName || s.name || path.split("/").pop() || "" };
    }
  }
  // Name match
  for (const s of storedSessions) {
    const name = (s.projectName || s.name || "").toLowerCase();
    if (name && (name === q || name.includes(q) || q.includes(name))) {
      const path = s.projectPath || s.cwd || "";
      return { path, name: s.projectName || s.name || path.split("/").pop() || "" };
    }
  }
  // Path fragment match
  for (const s of storedSessions) {
    const path = (s.projectPath || s.cwd || "").toLowerCase();
    if (path && (path.endsWith(`/${q}`) || path.includes(`/${q}/`))) {
      const full = s.projectPath || s.cwd || "";
      return { path: full, name: s.projectName || s.name || full.split("/").pop() || "" };
    }
  }
  // Fallback: treat the query as a raw path if it looks absolute
  if (query.startsWith("/") || /^[A-Za-z]:[\\/]/.test(query)) {
    return { path: query, name: query.split(/[\\/]/).pop() || query };
  }
  return { path: "", name: query };
}

function listProjectsTool() {
  const storedSessions = sessions.length > 0 ? sessions : readStoredSessions();
  const map = new Map();
  for (const s of storedSessions) {
    const path = s.projectPath || s.cwd || "unknown";
    const name = s.projectName || s.name || path.split("/").pop() || path;
    if (!map.has(path)) map.set(path, { name, path, sessions: 0, lastActivity: 0 });
    const p = map.get(path);
    p.sessions++;
    const t = s.updatedAt || 0;
    if (t > p.lastActivity) p.lastActivity = t;
  }
  return Array.from(map.values())
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((p) => ({
      name: p.name,
      path: p.path,
      sessionCount: p.sessions,
      lastActivityIso: p.lastActivity ? new Date(p.lastActivity).toISOString() : null,
    }));
}

function viewProjectTool(query) {
  const resolved = resolveProjectPath(query);
  if (!resolved.path) {
    return { found: false, message: `未找到项目 "${query}"` };
  }
  const storedSessions = sessions.length > 0 ? sessions : readStoredSessions();
  const related = storedSessions
    .filter((s) => (s.projectPath || s.cwd) === resolved.path)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 5)
    .map((s) => ({
      sessionId: s.id,
      title: s.title || s.name || "(未命名会话)",
      updatedIso: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
    }));
  return {
    found: true,
    name: resolved.name,
    path: resolved.path,
    recentSessions: related,
  };
}

function listTasksTool() {
  const tasks = devTasks.map((t) => ({
    id: t.id,
    project: t.projectName,
    projectPath: t.projectPath || "",
    description: t.description,
    status: t.status,
    createdIso: new Date(t.createdAt).toISOString(),
  }));
  const activities = appActivities.map((a) => ({
    sessionId: a.sessionId,
    project: (a.projectPath || "").split("/").pop() || "unknown",
    projectPath: a.projectPath || "",
    prompt: a.prompt,
    status: a.status,
    lastMessage: a.lastMessage || "",
    startedIso: new Date(a.startedAt).toISOString(),
  }));
  return { tasks, activeRuns: activities };
}

function viewTaskTool(taskId) {
  const t = devTasks.find((x) => x.id === taskId);
  if (t) {
    return {
      found: true,
      id: t.id,
      project: t.projectName,
      projectPath: t.projectPath || "",
      description: t.description,
      status: t.status,
      createdIso: new Date(t.createdAt).toISOString(),
      updatedIso: new Date(t.updatedAt).toISOString(),
    };
  }
  const a = appActivities.find((x) => x.sessionId === taskId);
  if (a) {
    return {
      found: true,
      kind: "activeRun",
      sessionId: a.sessionId,
      project: (a.projectPath || "").split("/").pop() || "unknown",
      prompt: a.prompt,
      status: a.status,
      lastMessage: a.lastMessage || "",
      startedIso: new Date(a.startedAt).toISOString(),
    };
  }
  return { found: false, message: `未找到任务 ${taskId}` };
}

/**
 * Create a task in the indicated project and emit lark_execute so the frontend
 * actually runs it through Claude Code.
 */
function createTaskTool({ project, description, chatId, messageId }) {
  const resolved = resolveProjectPath(project);
  if (!resolved.path) {
    return { ok: false, message: `无法定位项目 "${project}"，请先用 list_projects 确认` };
  }
  const task = createTask(resolved.path, resolved.name, description);
  emit({ type: "task_created", task });

  const execMsgId = `${messageId || `chat-${chatId}`}-t${task.id}`;
  emit({
    type: "lark_execute",
    message_id: execMsgId,
    chat_id: chatId,
    prompt: description,
    project_path: resolved.path,
    summary: `${resolved.name}: ${description.slice(0, 40)}`,
  });

  return {
    ok: true,
    taskId: task.id,
    project: resolved.name,
    projectPath: resolved.path,
    description,
    status: task.status,
    note: "任务已创建并提交 ClaudeBox 执行；执行结束后结果会进入 executions 记忆。",
  };
}

function updateTaskTool({ task_id, status }) {
  const task = updateTask(task_id, status);
  if (!task) return { ok: false, message: `未找到任务 ${task_id}` };
  emit({ type: "task_updated", task_id: task.id, status: task.status });
  return { ok: true, taskId: task.id, status: task.status };
}

function recallMemoryTool({ state, limit = 5 }) {
  const execs = state.executions.slice(-limit).map((e) => ({
    ts: new Date(e.ts).toISOString(),
    project: e.project || "",
    prompt: e.prompt || "",
    status: e.status,
    summary: e.summary || "",
  }));
  const msgs = state.messageLog.slice(-limit).map((m) => ({
    ts: new Date(m.ts).toISOString(),
    dir: m.dir,
    text: m.text,
  }));
  return {
    defaultProject: state.defaultProject || null,
    recentExecutions: execs,
    recentMessages: msgs,
  };
}

const TOOL_DEFS = [
  {
    name: "list_projects",
    description: "列出 ClaudeBox 记录过的所有项目（按最近活跃排序）。当用户问'我有哪些项目'或需要选项目时使用。",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "view_project",
    description: "查看某个项目的详细信息（路径、最近会话等）。支持按项目名、路径片段模糊匹配。",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "项目名称或路径片段" } },
      required: ["query"],
    },
  },
  {
    name: "list_tasks",
    description: "列出所有开发任务和正在运行的执行。",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "view_task",
    description: "查看某个任务或活跃会话的详情。",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string", description: "任务 ID 或 session_id" } },
      required: ["task_id"],
    },
  },
  {
    name: "create_task",
    description:
      "在指定项目中创建开发任务并立即交给 ClaudeBox 执行。用户描述任何具体技术动作（修 bug、实现功能、验证逻辑、分析代码、对齐接口等）都应使用此工具——不要再追问'请更具体'。调用后 ClaudeBox 会启动 Claude Code 会话去实际完成，执行结果会异步回流到记忆。",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名或路径（模糊匹配）；若未指定且存在 defaultProject，使用它" },
        description: {
          type: "string",
          description: "详尽的任务描述——尽量保留用户原话里的技术细节（涉及的模块/接口/期望结论）。这会作为 prompt 直接喂给 Claude Code。",
        },
      },
      required: ["project", "description"],
    },
  },
  {
    name: "update_task",
    description: "更新任务状态（pending / in_progress / done）。",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "done"] },
      },
      required: ["task_id", "status"],
    },
  },
  {
    name: "set_default_project",
    description: "把当前聊天的默认项目设为指定项目，后续用户不再显式说项目时默认使用它。",
    input_schema: {
      type: "object",
      properties: { project: { type: "string", description: "项目名或路径" } },
      required: ["project"],
    },
  },
  {
    name: "recall_memory",
    description: "读取当前聊天的历史执行记录与最近消息，用于追溯之前做过的事。",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", description: "返回的条目上限，默认 5" } },
      required: [],
    },
  },
];

async function dispatchTool(name, input, ctx) {
  try {
    switch (name) {
      case "list_projects":
        return listProjectsTool();
      case "view_project":
        return viewProjectTool(input.query || "");
      case "list_tasks":
        return listTasksTool();
      case "view_task":
        return viewTaskTool(input.task_id || "");
      case "create_task": {
        const project = input.project || ctx.state.defaultProject || "";
        if (!project) return { ok: false, message: "尚无默认项目，请让用户指定 project" };
        const result = createTaskTool({
          project,
          description: input.description || "",
          chatId: ctx.chatId,
          messageId: ctx.messageId,
        });
        if (result.ok && result.projectPath) {
          ctx.state.defaultProject = result.projectPath;
          ctx.state.executions.push({
            ts: Date.now(),
            sessionId: undefined,
            project: result.project,
            prompt: input.description || "",
            status: "dispatched",
            summary: `已提交执行：${result.project}`,
          });
          if (ctx.state.executions.length > MAX_EXECUTIONS) {
            ctx.state.executions = ctx.state.executions.slice(-MAX_EXECUTIONS);
          }
        }
        return result;
      }
      case "update_task":
        return updateTaskTool(input);
      case "set_default_project": {
        const resolved = resolveProjectPath(input.project || "");
        if (!resolved.path) return { ok: false, message: `无法定位项目 "${input.project}"` };
        ctx.state.defaultProject = resolved.path;
        saveMemoryDebounced();
        return { ok: true, defaultProject: resolved.path, name: resolved.name };
      }
      case "recall_memory":
        return recallMemoryTool({ state: ctx.state, limit: input.limit || 5 });
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// ── Anthropic Messages API (tool-use agent) ────────────────────────

function getRouterModel() {
  // Prefer the model configured by ClaudeBox. Fall back to sonnet-4-6;
  // never downgrade to haiku here because tool-calling on small models is brittle.
  const m = (config?.model || "").trim();
  if (m) return m;
  return "claude-sonnet-4-6";
}

function buildAgentSystemPrompt(state) {
  const projectList = listProjectsTool();
  const projectsBrief = projectList.length
    ? projectList
        .slice(0, 10)
        .map((p) => `  - ${p.name} (${p.path}) · ${p.sessionCount} 会话`)
        .join("\n")
    : "  （暂无记录的项目）";

  const defaultProjectLine = state.defaultProject
    ? `\n【默认项目】${state.defaultProject}（用户未指定其他项目时一律使用它）`
    : "\n【默认项目】尚未设置——如果用户在消息里明确提到某个项目名，请用 set_default_project 记住它。";

  const recentExecs = state.executions.slice(-3);
  const execsLine = recentExecs.length
    ? "\n【最近执行记录】\n" +
      recentExecs
        .map(
          (e) =>
            `  - [${new Date(e.ts).toLocaleString("zh-CN")}] ${e.project || ""} · ${e.status}${e.summary ? " · " + e.summary : ""}`,
        )
        .join("\n")
    : "";

  const senderLine = state.senderName ? `\n【用户】${state.senderName}` : "";

  return `你是 ClaudeBox 的飞书助理，帮助研发/产品跟进项目和任务。你有一组工具可以实际做事。

【可用项目】
${projectsBrief}
${defaultProjectLine}${execsLine}${senderLine}

【行为铁律】
1. 用户描述任何具体技术动作——修 bug、实现功能、改代码、分析、验证逻辑、对齐接口、写脚本、排查问题——直接调用 create_task，**不要**追问"请更具体地描述你的需求"。
2. 描述超过 20 字且含技术关键词（代码、接口、SDK、验证、bug、模块、字段、逻辑、渠道、竞价...）即视为具体需求，可以直接 create_task。
3. 只有当完全无法判断用户要做什么时，才用自然语言询问澄清。
4. 用户若问信息（"我有哪些项目"、"最近在做什么"），调用 list_projects / list_tasks / recall_memory 获取后用自然语言答复。
5. 所有面向用户的回复用中文，简洁、直接、不要啰嗦。
6. 不要暴露内部 ID（如路径全串）给用户，除非必要；但工具调用的 input 要用完整字段。
7. 同一轮允许调用多个工具。完成后直接给用户一段 Markdown 回复即可。`;
}

function antropicEndpoint() {
  const baseUrl = (config?.base_url || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  return `${baseUrl}/v1/messages`;
}

async function callModel(messages, system) {
  const apiKey = config?.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("未配置 API Key，请在 ClaudeBox 设置中配置。");

  const resp = await fetch(antropicEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: getRouterModel(),
      max_tokens: 2048,
      system,
      tools: TOOL_DEFS,
      messages,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`API request failed (${resp.status}): ${errText}`);
  }
  return resp.json();
}

/**
 * Run the tool-use loop. Mutates state.turns with the exchange.
 * Returns the final assistant text to send to the user (may be empty).
 */
async function agenticReply(userText, chatId, messageId, senderName) {
  const state = getOrInitChatState(chatId);
  if (senderName && !state.senderName) state.senderName = senderName;
  state.lastActivity = Date.now();

  // Push the new user turn
  state.turns.push({ role: "user", content: userText });

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const system = buildAgentSystemPrompt(state);
    const resp = await callModel(state.turns, system);
    const blocks = Array.isArray(resp.content) ? resp.content : [];

    // Add the assistant turn to transcript verbatim (preserves tool_use ids)
    state.turns.push({ role: "assistant", content: blocks });

    const toolUses = blocks.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const finalText = blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("\n").trim();
      trimTurns(state);
      saveMemoryDebounced();
      return finalText;
    }

    // Execute each tool call
    const toolResults = [];
    for (const tu of toolUses) {
      const result = await dispatchTool(tu.name, tu.input || {}, {
        chatId,
        messageId,
        state,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    state.turns.push({ role: "user", content: toolResults });
  }

  trimTurns(state);
  saveMemoryDebounced();
  return "（工具调用超出循环上限，请重新描述需求。）";
}

function trimTurns(state) {
  if (state.turns.length <= MAX_TURNS) return;
  // Keep the most recent window but don't dangle a tool_result without its tool_use
  let start = state.turns.length - MAX_TURNS;
  while (start > 0) {
    const turn = state.turns[start];
    const prev = state.turns[start - 1];
    // Avoid starting at a tool_result (orphaned)
    if (
      turn.role === "user" &&
      Array.isArray(turn.content) &&
      turn.content.some((b) => b && b.type === "tool_result")
    ) {
      start++;
      if (start >= state.turns.length) break;
      continue;
    }
    // Avoid starting right after an assistant that emits tool_use without the result
    if (prev && prev.role === "assistant" && Array.isArray(prev.content) && prev.content.some((b) => b && b.type === "tool_use")) {
      start++;
      continue;
    }
    break;
  }
  state.turns = state.turns.slice(start);
}

// ── Lark Message Handler ──────────────────────────────────────────

async function handleLarkMessage(data) {
  const messageContent = JSON.parse(data.message.content);
  const text = messageContent.text || "";
  const messageId = data.message.message_id;
  const chatId = data.message.chat_id;
  const chatType = data.message.chat_type;
  const senderId = data.sender?.sender_id?.open_id || "unknown";
  const senderName = data.sender?.sender_id?.user_id || data.sender?.sender_id?.union_id || undefined;

  // Dedup: skip if already processed (Lark WebSocket may redeliver)
  if (processedMessages.has(messageId)) {
    console.error(`[lark-bot] Skipping duplicate message: ${messageId}`);
    return;
  }
  processedMessages.add(messageId);
  if (processedMessages.size > MAX_PROCESSED) {
    // Evict oldest entries
    const iter = processedMessages.values();
    for (let i = 0; i < 50; i++) iter.next();
    const keep = new Set();
    for (const v of iter) keep.add(v);
    processedMessages.clear();
    for (const v of keep) processedMessages.add(v);
  }

  // Log to chat memory
  const chatState = getOrInitChatState(chatId);
  pushMessageLog(chatState, "in", text, messageId);
  saveMemoryDebounced();

  // Emit raw message to frontend
  emit({
    type: "lark_message",
    message_id: messageId,
    sender_id: senderId,
    content: text,
    chat_id: chatId,
    chat_type: chatType,
    timestamp: Date.now(),
  });

  // 1. Check built-in commands first (kept for power users)
  const cmd = parseCommand(text);
  if (cmd.isCommand) {
    // Apply memory side-effects
    if (cmd.setDefaultProject) {
      const resolved = resolveProjectPath(cmd.setDefaultProject);
      const st = getOrInitChatState(chatId);
      if (resolved.path) {
        st.defaultProject = resolved.path;
        cmd.response = `后续对话默认使用项目：**${resolved.name}**\n\`${resolved.path}\`\n\n发 \`/忘记\` 可清空。`;
      } else {
        st.defaultProject = cmd.setDefaultProject;
        cmd.response = `后续对话默认使用：\`${cmd.setDefaultProject}\`（未在已知项目中找到同名项，已原样记住）`;
      }
      saveMemoryDebounced();
    }
    if (cmd.clearMemory) {
      conversationState.delete(chatId);
      saveMemoryDebounced();
    }

    try {
      const card = buildNotificationCard(
        cmd.cardTitle || "ClaudeBox",
        cmd.response,
        cmd.cardType || "blue",
      );
      await client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
      pushMessageLog(getOrInitChatState(chatId), "out", cmd.response);
      saveMemoryDebounced();
      emit({ type: "ai_reply", message_id: messageId, reply: cmd.response });
    } catch (err) {
      emitError(`Failed to reply command: ${err.message}`);
    }
    // If the command triggers execution (e.g. /task), emit lark_execute
    if (cmd.triggerAI && cmd.aiPrompt) {
      emit({
        type: "lark_execute",
        message_id: `${messageId}-task`,
        chat_id: chatId,
        prompt: cmd.aiPrompt,
        project_path: cmd.aiCwd || "",
        summary: cmd.response.split("\n")[0],
      });
    }
    return;
  }

  // 2. Hand off to tool-using agent
  try {
    const reply = await agenticReply(text, chatId, messageId, senderName);

    const finalReply = (reply || "").trim() || "（已处理。）";
    try {
      const card = buildNotificationCard("ClaudeBox 助理", finalReply, "blue");
      await client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
      pushMessageLog(getOrInitChatState(chatId), "out", finalReply, messageId);
      saveMemoryDebounced();
      emit({ type: "ai_reply", message_id: messageId, reply: finalReply });
    } catch (err) {
      emitError(`Failed to reply: ${err.message}`);
    }
  } catch (err) {
    emitError(`Agent reply failed: ${err.message}`);
    try {
      await client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text: `[助理异常] ${err.message}` }),
          msg_type: "text",
        },
      });
    } catch { /* ignore */ }
  }
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

    switch (msg.type) {
      case "notify":
        sendNotification(msg.chat_id, msg.title, msg.content, msg.card_type).catch((e) =>
          emitError(`Notification failed: ${e.message}`)
        );
        break;

      case "create_task": {
        const task = createTask(msg.project_path, msg.project_name, msg.description);
        emit({ type: "task_created", task });
        break;
      }

      case "update_task": {
        const task = updateTask(msg.task_id, msg.status);
        if (task) {
          emit({ type: "task_updated", task_id: task.id, status: task.status });
        }
        break;
      }

      case "sync_sessions":
        sessions = msg.sessions || [];
        console.error(`[lark-bot] Synced ${sessions.length} sessions`);
        break;

      case "app_activity": {
        const idx = appActivities.findIndex((a) => a.sessionId === msg.session_id);
        if (msg.status === "running") {
          if (idx === -1) {
            appActivities.push({
              sessionId: msg.session_id,
              projectPath: msg.project_path || "",
              prompt: msg.prompt || "",
              lastMessage: "",
              status: "running",
              startedAt: Date.now(),
            });
          }
          if (msg.chat_id) sessionChatMap.set(msg.session_id, msg.chat_id);
        } else if (idx !== -1) {
          appActivities[idx].status = msg.status;
          if (msg.last_message) appActivities[idx].lastMessage = msg.last_message;
        }

        // Persist terminal outcomes into the originating chat's memory
        if (msg.status === "completed" || msg.status === "error") {
          const chatId = msg.chat_id || sessionChatMap.get(msg.session_id);
          if (chatId) {
            const st = conversationState.get(chatId);
            if (st) {
              const activity = idx !== -1 ? appActivities[idx] : null;
              st.executions.push({
                ts: Date.now(),
                sessionId: msg.session_id,
                project: activity?.projectPath || msg.project_path || undefined,
                prompt: activity?.prompt || "",
                status: msg.status,
                summary: activity ? `${(activity.projectPath || "").split("/").pop()}: ${(activity.prompt || "").slice(0, 60)}` : "",
                output: (msg.last_message || "").slice(0, 2000),
              });
              if (st.executions.length > MAX_EXECUTIONS) {
                st.executions = st.executions.slice(-MAX_EXECUTIONS);
              }
              st.lastActivity = Date.now();
              saveMemoryDebounced();
            }
          }
          sessionChatMap.delete(msg.session_id);
        }

        // Prune completed activities older than 30 minutes
        const cutoff = Date.now() - 30 * 60 * 1000;
        appActivities = appActivities.filter(
          (a) => a.status === "running" || a.startedAt > cutoff
        );
        console.error(`[lark-bot] App activity: ${msg.session_id} → ${msg.status} (tracking ${appActivities.length})`);
        break;
      }

      case "stop":
        console.error("[lark-bot] Received stop command");
        process.exit(0);
        break;

      default:
        console.error(`[lark-bot] Unknown command type: ${msg.type}`);
    }
  } catch (e) {
    console.error(`[lark-bot] Failed to parse stdin: ${e.message}`);
  }
});

rl.on("close", () => {
  console.error("[lark-bot] stdin closed, exiting");
  process.exit(0);
});

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  loadMemory();
  console.error("[lark-bot] Waiting for start command...");

  // Wait for the "start" message from Rust
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

  config = startMsg;
  console.error(`[lark-bot] app_id=${config.app_id} project_dir=${config.project_dir || "(none)"}`);
  console.error(`[lark-bot] model=${config.model || "(default)"}`);

  // Create Lark client
  client = new lark.Client({
    appId: config.app_id,
    appSecret: config.app_secret,
    disableTokenCache: false,
  });

  // Create event dispatcher
  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      try {
        // Only handle text messages
        if (data.message.message_type === "text") {
          await handleLarkMessage(data);
        } else {
          console.error(`[lark-bot] Ignoring non-text message type: ${data.message.message_type}`);
        }
      } catch (err) {
        emitError(`Message handler error: ${err.message}`);
      }
    },
    "im.message.message_read_v1": () => {},
  });

  // Create WebSocket client and connect
  emit({ type: "status", status: "connecting" });

  try {
    wsClient = new lark.WSClient({
      appId: config.app_id,
      appSecret: config.app_secret,
      loggerLevel: lark.LoggerLevel.info,
    });

    await wsClient.start({ eventDispatcher });
    emit({ type: "status", status: "connected" });
    console.error("[lark-bot] WebSocket connected successfully");
  } catch (err) {
    emit({ type: "status", status: "error", reason: err.message });
    emitError(`WebSocket connection failed: ${err.message}`);

    // Retry with exponential backoff
    let attempt = 1;
    const maxDelay = 30000;
    while (true) {
      const delay = Math.min(1000 * Math.pow(2, attempt), maxDelay);
      console.error(`[lark-bot] Retrying in ${delay}ms (attempt ${attempt})...`);
      emit({ type: "status", status: "reconnecting", attempt });
      await new Promise((r) => setTimeout(r, delay));

      try {
        wsClient = new lark.WSClient({
          appId: config.app_id,
          appSecret: config.app_secret,
          loggerLevel: lark.LoggerLevel.info,
        });
        await wsClient.start({ eventDispatcher });
        emit({ type: "status", status: "connected" });
        console.error("[lark-bot] WebSocket reconnected successfully");
        break;
      } catch (retryErr) {
        emit({ type: "status", status: "error", reason: retryErr.message });
        attempt++;
      }
    }
  }
}

main().catch((err) => {
  emitError(`Fatal error: ${err.message}`);
  process.exit(1);
});

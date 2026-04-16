import { useSettingsStore } from "../stores/settingsStore";

type TranslationDict = Record<string, string>;

const en: TranslationDict = {
  // Sidebar
  "sidebar.openProject": "Open Project",
  "sidebar.expandSidebar": "Expand sidebar",
  "sidebar.collapseSidebar": "Collapse sidebar",
  "sidebar.lightMode": "Switch to light mode",
  "sidebar.darkMode": "Switch to dark mode",
  "sidebar.settings": "Settings",

  // SessionList
  "session.empty": "No sessions yet.",
  "session.emptyHint": "Open a project to start!",
  "session.delete": "Delete session",
  "session.openFolder": "Open in Finder",

  // ChatPanel — welcome
  "welcome.title": "Welcome to ClaudeBox",
  "welcome.desc": "Open a project folder to start a Claude Code session.",
  "welcome.hint": 'Click "Open Project" in the sidebar to begin',
  "chat.emptyHint": "Send a message to start working with Claude in this project.",
  "chat.closeFilePanel": "Close file panel",
  "chat.openFilePanel": "Open file panel",
  "chat.missingConfig": "Missing configuration: {items}. Please configure in Settings (API Key is required for Agent SDK mode).",
  "chat.noModel": "No model configured. Please set a model (e.g. claude-sonnet-4-20250514) in Settings or session toolbar.",

  // InputArea
  "input.placeholder": "Send a message...",
  "input.stop": "Stop generation",
  "input.send": "Send message",
  "input.model": "Model:",
  "input.mode": "Mode:",
  "input.addModelsHint": "Add models in Settings",
  "input.cliNotDetected": "Claude CLI not detected. Check Settings.",
  "input.tools": "Tools",
  "input.selectAll": "Select All",
  "input.deselectAll": "Deselect All",
  "input.attach": "Attach files",
  "input.attachFiles": "Attach Files",
  "chat.launching": "Claude is starting...",
  "chat.launched": "Claude started",
  "chat.resumeFrom": "Session resumed",
  "chat.clearSession": "New session",
  "chat.clearSessionConfirm": "Clear session memory? The next message will start a fresh conversation without previous context.",
  "chat.sessionCleared": "Session memory cleared. Next message will start fresh.",
  "chat.newSession.title": "Start New Session",
  "chat.newSession.desc": "This will reset Claude's memory. Your conversation history will be preserved unless you choose to clear it.",
  "chat.newSession.clearHistory": "Also clear chat history",
  "chat.newSession.clearHistoryHint": "Permanently removes all messages in this session",
  "chat.newSession.confirm": "Start New Session",
  "chat.newSession.cancel": "Cancel",
  "chat.historyCleared": "Chat history cleared.",
  "chat.stoppedByUser": "Generation stopped by user",

  // Permission modes
  "mode.default": "Default",
  "mode.auto": "Auto",
  "mode.plan": "Plan",

  // SettingsDialog
  "settings.title": "Settings",
  "settings.cliStatus": "Claude CLI Status",
  "settings.checking": "Checking...",
  "settings.notFound": "Not found",
  "settings.recheck": "Re-check",
  "settings.installFor": "Install Claude Code for",
  "settings.cliPath": "Claude CLI Path",
  "settings.cliPathHint": 'Path to claude CLI binary. Use "claude" for global install.',
  "settings.models": "Models",
  "settings.add": "Add",
  "settings.active": "(active)",
  "settings.removeModel": "Remove model",
  "settings.modelsHint": "Add model IDs to switch between them in the chat toolbar.",
  "settings.modelChecking": "Checking model availability...",
  "settings.modelUnavailable": "Model unavailable: {reason}",
  "settings.modelNoApiKey": "Cannot validate model (no API key). The model will be added without validation.",
  "settings.apiKey": "Anthropic API Key",
  "settings.apiKeyHint": "Optional. Leave empty to use Claude CLI's built-in auth or shell env ANTHROPIC_API_KEY.",
  "settings.baseUrl": "API Base URL",
  "settings.baseUrlHint": "Optional. Override the Anthropic API endpoint (for proxies).",
  "settings.viewLogs": "View Logs",
  "settings.tokenStats": "Token Usage",
  "settings.done": "Done",
  "settings.copyCommand": "Copy command",

  // Token Stats
  "tokenStats.title": "Token Usage",
  "tokenStats.allProjects": "All Projects",
  "tokenStats.input": "Input",
  "tokenStats.cacheWrite": "Cache Write",
  "tokenStats.cacheRead": "Cache Read",
  "tokenStats.output": "Output",
  "tokenStats.turns": "turns",
  "tokenStats.empty": "No token usage recorded yet.",
  "tokenStats.resetProject": "Reset this project",
  "tokenStats.confirmReset": "Click again to confirm reset",
  "tokenStats.resetAll": "Reset All",
  "tokenStats.confirmResetAll": "Click again to confirm",

  // FileTree
  "files.title": "Files",
  "files.refresh": "Refresh",
  "files.loading": "Loading...",
  "files.noFiles": "No files",
  "files.empty": "Empty",
  "files.revealInFinder": "Reveal in Finder",
  "files.openInFinder": "Open in Finder",

  // FileViewer
  "viewer.lines": "lines",
  "viewer.copyContent": "Copy content",
  "viewer.close": "Close",
  "viewer.closeAll": "Close all tabs",
  "viewer.minimize": "Hide file preview",
  "viewer.restore": "Open file preview",
  "viewer.restoreBar": "{count} file(s) open — click to restore",
  "viewer.loading": "Loading...",
  "viewer.source": "Source",
  "viewer.preview": "Preview",
  "viewer.edit": "Edit",
  "viewer.view": "View",
  "viewer.save": "Save",
  "viewer.unsaved": "Unsaved changes",
  "viewer.gitChanged": "Uncommitted changes",

  // DebugPanel
  "debug.title": "Debug Console",
  "debug.clearLogs": "Clear logs",
  "debug.close": "Close debug panel",
  "debug.autoScroll": "Auto-scroll",
  "debug.empty": "No debug logs yet. Start a session and send a message.",

  // ToolCallCard
  "tool.needsInput": "Claude needs your input",
  "tool.planReady": "Plan ready — approve to proceed",
  "tool.plan": "Plan:",
  "tool.permissions": "Requested permissions:",
  "tool.approve": "Approve",
  "tool.reject": "Reject",
  "tool.other": "Other...",
  "tool.send": "Send",
  "tool.submitAnswers": "Submit Answers",
  "tool.input": "Input",
  "tool.output": "Output",
  "tool.error": "Error",
  "tool.open": "Open",
  "tool.truncated": "... (truncated)",
  "tool.askQuestion": "Question:",
  "tool.planApprove": "Ready to implement — approve plan?",
  "tool.explorationSteps": "{count} exploration steps",
  "tool.removed": "Removed",
  "tool.added": "Added",
  "tool.agentRunning": "Running",
  "tool.agentDone": "Done",
  "tool.clickToExpand": "Click to expand",

  // Update
  "update.downloading": "Downloading update v{version}...",
  "update.ready": "Update v{version} is ready to install",
  "update.restart": "Restart Now",
  "update.later": "Later",

  // Version
  "version.current": "v{version}",
  "version.upToDate": "Up to date",
  "version.newVersion": "v{version} available",
  "version.downloading": "Downloading v{version}...",
  "version.readyToInstall": "v{version} ready to install",
  "version.checkFailed": "Update check failed",
  "version.restart": "Restart",
  "version.checkUpdate": "Check for Updates",
  "version.checking": "Checking...",

  // Branch
  "branch.switch": "Switch branch",
  "branch.switchFailed": "Failed to switch branch",

  // Terminal
  "input.openTerminal": "Open in Terminal",
  "input.terminal": "Terminal",

  // Lark Bot
  "lark.title": "Lark Bot",
  "lark.stopped": "Stopped",
  "lark.connecting": "Connecting...",
  "lark.connected": "Connected",
  "lark.disconnected": "Disconnected",
  "lark.reconnecting": "Reconnecting...",
  "lark.error": "Error",
  "lark.connect": "Connect",
  "lark.disconnect": "Disconnect",
  "lark.autoConnect": "Auto-connect on startup",
  "lark.missingCredentials": "Please enter App ID and App Secret.",
  "lark.hint": "Connect a Lark bot to remotely control Claude Code from your phone or any Lark client — send coding tasks, review results, and manage projects on the go via WebSocket (no public URL needed).",
};

const zh: TranslationDict = {
  // Sidebar
  "sidebar.openProject": "打开项目",
  "sidebar.expandSidebar": "展开侧边栏",
  "sidebar.collapseSidebar": "收起侧边栏",
  "sidebar.lightMode": "切换到浅色模式",
  "sidebar.darkMode": "切换到深色模式",
  "sidebar.settings": "设置",

  // SessionList
  "session.empty": "暂无会话",
  "session.emptyHint": "打开一个项目开始吧！",
  "session.delete": "删除会话",
  "session.openFolder": "打开文件夹",

  // ChatPanel — welcome
  "welcome.title": "欢迎使用 ClaudeBox",
  "welcome.desc": "打开一个项目文件夹以启动 Claude Code 会话。",
  "welcome.hint": "点击侧边栏的「打开项目」开始",
  "chat.emptyHint": "发送消息以开始在此项目中使用 Claude。",
  "chat.closeFilePanel": "关闭文件面板",
  "chat.openFilePanel": "打开文件面板",
  "chat.missingConfig": "缺少配置：{items}。请在设置中配置（Agent SDK 模式需要 API Key）。",
  "chat.noModel": "未配置模型。请在设置或会话工具栏中设置模型（如 claude-sonnet-4-20250514）。",

  // InputArea
  "input.placeholder": "输入消息...",
  "input.stop": "停止生成",
  "input.send": "发送消息",
  "input.model": "模型：",
  "input.mode": "模式：",
  "input.addModelsHint": "请在设置中添加模型",
  "input.cliNotDetected": "未检测到 Claude CLI，请检查设置。",
  "input.tools": "工具",
  "input.selectAll": "全选",
  "input.deselectAll": "取消全选",
  "input.attach": "附加文件",
  "input.attachFiles": "添加附件",
  "chat.launching": "Claude 启动中...",
  "chat.launched": "Claude 已启动",
  "chat.resumeFrom": "会话已恢复",
  "chat.clearSession": "新会话",
  "chat.clearSessionConfirm": "清除会话记忆？下次发送消息将开启全新对话，不保留之前的上下文。",
  "chat.sessionCleared": "会话记忆已清除，下次发送消息将开启全新对话。",
  "chat.newSession.title": "开启新会话",
  "chat.newSession.desc": "此操作将重置 Claude 的记忆，下次对话将从头开始。历史聊天记录默认保留，可勾选下方选项一并清除。",
  "chat.newSession.clearHistory": "同时清除历史聊天记录",
  "chat.newSession.clearHistoryHint": "将永久删除本会话中的所有消息",
  "chat.newSession.confirm": "确认开启",
  "chat.newSession.cancel": "取消",
  "chat.historyCleared": "历史聊天记录已清除。",
  "chat.stoppedByUser": "用户已停止生成",

  // Permission modes
  "mode.default": "默认",
  "mode.auto": "自动",
  "mode.plan": "计划",

  // SettingsDialog
  "settings.title": "设置",
  "settings.cliStatus": "Claude CLI 状态",
  "settings.checking": "检查中...",
  "settings.notFound": "未找到",
  "settings.recheck": "重新检查",
  "settings.installFor": "为以下系统安装 Claude Code",
  "settings.cliPath": "Claude CLI 路径",
  "settings.cliPathHint": "Claude CLI 二进制文件路径，全局安装可填 \"claude\"。",
  "settings.models": "模型",
  "settings.add": "添加",
  "settings.active": "（当前）",
  "settings.removeModel": "移除模型",
  "settings.modelsHint": "添加模型 ID 以便在聊天工具栏中切换。",
  "settings.modelChecking": "正在检查模型可用性...",
  "settings.modelUnavailable": "模型不可用：{reason}",
  "settings.modelNoApiKey": "无法验证模型（未设置 API Key）。模型将直接添加，不进行验证。",
  "settings.apiKey": "Anthropic API 密钥",
  "settings.apiKeyHint": "可选。留空则使用 Claude CLI 内置认证或环境变量 ANTHROPIC_API_KEY。",
  "settings.baseUrl": "API 基础地址",
  "settings.baseUrlHint": "可选。用于代理时覆盖 Anthropic API 端点。",
  "settings.viewLogs": "查看日志",
  "settings.tokenStats": "Token 统计",
  "settings.done": "完成",
  "settings.copyCommand": "复制命令",

  // Token Stats
  "tokenStats.title": "Token 使用统计",
  "tokenStats.allProjects": "所有项目合计",
  "tokenStats.input": "输入",
  "tokenStats.cacheWrite": "缓存写入",
  "tokenStats.cacheRead": "缓存读取",
  "tokenStats.output": "输出",
  "tokenStats.turns": "轮",
  "tokenStats.empty": "暂无 Token 使用记录。",
  "tokenStats.resetProject": "重置此项目",
  "tokenStats.confirmReset": "再次点击确认重置",
  "tokenStats.resetAll": "清空全部",
  "tokenStats.confirmResetAll": "再次点击确认",

  // FileTree
  "files.title": "文件",
  "files.refresh": "刷新",
  "files.loading": "加载中...",
  "files.noFiles": "没有文件",
  "files.empty": "空",
  "files.revealInFinder": "在 Finder 中显示",
  "files.openInFinder": "在 Finder 中打开",

  // FileViewer
  "viewer.lines": "行",
  "viewer.copyContent": "复制内容",
  "viewer.close": "关闭",
  "viewer.closeAll": "关闭所有标签",
  "viewer.minimize": "隐藏文件预览",
  "viewer.restore": "打开文件预览窗口",
  "viewer.restoreBar": "已打开 {count} 个文件 — 点击恢复",
  "viewer.loading": "加载中...",
  "viewer.source": "源码",
  "viewer.preview": "预览",
  "viewer.edit": "编辑",
  "viewer.view": "查看",
  "viewer.save": "保存",
  "viewer.unsaved": "未保存的更改",
  "viewer.gitChanged": "未提交的更改",

  // DebugPanel
  "debug.title": "调试控制台",
  "debug.clearLogs": "清空日志",
  "debug.close": "关闭调试面板",
  "debug.autoScroll": "自动滚动",
  "debug.empty": "暂无调试日志。启动会话并发送消息后即可查看。",

  // ToolCallCard
  "tool.needsInput": "Claude 需要你的输入",
  "tool.planReady": "计划已就绪 — 是否批准执行？",
  "tool.plan": "计划：",
  "tool.permissions": "请求的权限：",
  "tool.approve": "批准",
  "tool.reject": "拒绝",
  "tool.other": "其他...",
  "tool.send": "发送",
  "tool.submitAnswers": "提交回答",
  "tool.input": "输入",
  "tool.output": "输出",
  "tool.error": "错误",
  "tool.open": "打开",
  "tool.truncated": "...（已截断）",
  "tool.askQuestion": "提问：",
  "tool.planApprove": "计划已就绪 — 是否批准执行？",
  "tool.explorationSteps": "{count} 个探索步骤",
  "tool.removed": "移除",
  "tool.added": "添加",
  "tool.agentRunning": "运行中",
  "tool.agentDone": "已完成",
  "tool.clickToExpand": "点击展开",

  // Update
  "update.downloading": "正在下载更新 v{version}...",
  "update.ready": "更新 v{version} 已准备就绪",
  "update.restart": "立即重启",
  "update.later": "稍后",

  // Version
  "version.current": "v{version}",
  "version.upToDate": "已是最新版本",
  "version.newVersion": "v{version} 可更新",
  "version.downloading": "正在下载 v{version}...",
  "version.readyToInstall": "v{version} 已准备安装",
  "version.checkFailed": "检查更新失败",
  "version.restart": "重启",
  "version.checkUpdate": "检查更新",
  "version.checking": "检查中...",

  // Branch
  "branch.switch": "切换分支",
  "branch.switchFailed": "切换分支失败",

  // Terminal
  "input.openTerminal": "在终端中打开",
  "input.terminal": "终端",

  // Lark Bot
  "lark.title": "飞书机器人",
  "lark.stopped": "未连接",
  "lark.connecting": "连接中...",
  "lark.connected": "已连接",
  "lark.disconnected": "已断开",
  "lark.reconnecting": "重连中...",
  "lark.error": "错误",
  "lark.connect": "连接",
  "lark.disconnect": "断开",
  "lark.autoConnect": "启动时自动连接",
  "lark.missingCredentials": "请输入 App ID 和 App Secret。",
  "lark.hint": "配置飞书机器人后，可通过手机或任意飞书客户端远程操控 Claude Code —— 发送编码任务、查看执行结果、管理项目，随时随地 Remote Coding。使用 WebSocket 长连接，无需公网地址。",
};

const dictionaries: Record<string, TranslationDict> = { en, zh };

export type TFunction = (key: string, params?: Record<string, string>) => string;

export function useT(): TFunction {
  const locale = useSettingsStore((s) => s.settings.locale);
  const dict = dictionaries[locale] || en;
  return (key: string, params?: Record<string, string>) => {
    let text = dict[key] || en[key] || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, v);
      }
    }
    return text;
  };
}

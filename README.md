<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" height="128" alt="ClaudeBox Logo">
</p>

<h1 align="center">ClaudeBox</h1>

<p align="center">
  <strong>A native desktop GUI for Claude Code</strong>
</p>

<p align="center">
  <a href="https://github.com/braverior/ClaudeBox/releases">
    <img src="https://img.shields.io/github/v/release/braverior/ClaudeBox?style=flat-square" alt="Release">
  </a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/Tauri-v2-orange?style=flat-square" alt="Tauri v2">
  <img src="https://img.shields.io/github/license/braverior/ClaudeBox?style=flat-square" alt="License">
</p>

<p align="center">
  <a href="#features">Features</a> &bull;
  <a href="#installation">Installation</a> &bull;
  <a href="#development">Development</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a> | English
</p>

---

ClaudeBox wraps [Claude Code](https://docs.anthropic.com/en/docs/claude-code) in a lightweight native desktop app powered by [Tauri v2](https://v2.tauri.app). It provides a visual chat interface for multi-project Claude Code sessions, interactive tool approvals, file attachments, task tracking, and more — all without leaving your desktop.

<p align="center">
  <img src="screenshot.png" width="800" alt="ClaudeBox Screenshot">
</p>

## Features

### Core

- **Multi-session management** — Open multiple project folders simultaneously, each with its own Claude Code session. A green indicator shows which sessions are actively running.
- **Streaming chat UI** — Real-time message streaming with Markdown rendering, syntax-highlighted code blocks, and GitHub Flavored Markdown support.
- **Session resume** — Conversations are automatically resumed across app restarts using Claude's session ID, preserving full context without re-sending history.
- **Persistent storage** — All session data is stored in `~/.claudebox/data/`, surviving app updates and WebView resets (auto-migrated from localStorage on first run).

### Interactive Tools

- **Tool approval cards** — Visual cards for every tool call (Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, NotebookEdit, Agent, Skill, etc.) with approve/deny controls.
- **AskUserQuestion** — Renders as an interactive form with selectable options and a custom text input.
- **Plan mode (ExitPlanMode)** — Displays the full plan file content from `.claude/plans/` for review before approving or rejecting execution.
- **Agent sub-run containers** — Nested agent tool calls are grouped into collapsible containers showing progress, running tool label, and breakdown summary.
- **Extended thinking** — Claude's thinking/reasoning blocks are displayed in collapsible sections with visual indicators.

### Attachments & Images

- **File attachments** — Attach code files and images via the toolbar. Text files are embedded inline; images are passed to Claude's Read tool.
- **Clipboard image paste** — Paste images directly from the system clipboard (Ctrl/Cmd+V). Images are saved to `~/.claudebox/tmp/` and attached automatically. Temp files older than 24 hours are cleaned up on startup.

### Git Integration

- **Branch display** — Current Git branch is shown in the input toolbar.
- **Branch switching** — List and switch between local branches directly from the UI without leaving the app.

### Network & Proxy

- **System proxy auto-detection** — Automatically detects system proxy settings on macOS (`scutil --proxy`) and Windows (registry). Distinguishes between HTTP and SOCKS5 proxies.
- **Dynamic proxy polling** — Polls for proxy changes every 30 seconds, supporting dynamic proxy toggling (e.g., Clash, V2Ray).
- **Custom API endpoint** — Configure a custom Base URL for API proxies or compatible endpoints.

### Configuration

- **Model & mode selection** — Switch models and permission modes (Default / Auto / Plan) per session from the input toolbar.
- **Model validation** — Validates model availability via API before adding to the model list.
- **Tool allow-list** — Configure which tools Claude can use per session (Read, Write, Edit, Glob, Grep, Bash, etc.).
- **Dark & Light themes** — Toggle between dark and light themes from the sidebar.
- **i18n** — English and Chinese (Simplified) interfaces with 100+ translation keys.

### Project Tools

- **File browser** — Built-in file tree and file viewer with syntax highlighting, line numbers, and copy-to-clipboard.
- **Task board** — Displays Claude's `TodoWrite` task progress in a visual board above the input area, with completion tracking and in-progress indicators.
- **Open in terminal** — Quick action to open the project folder in the system terminal.
- **Debug panel** — Toggle with `Cmd+Shift+D`. Shows color-coded logs (info, warn, error, stdin, stdout, stderr, process) from both the Rust backend and frontend. Filterable and auto-scrolling.

### Updates & Platform

- **Auto-updates** — Built-in update checker with Cloudflare Workers proxy and GitHub Releases fallback. Supports background download with progress tracking and signature verification.
- **Cross-platform** — macOS (Apple Silicon + Intel) and Windows builds.

## Installation

### Download

Download the latest release from [GitHub Releases](https://github.com/braverior/ClaudeBox/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `ClaudeBox_x.x.x_aarch64.dmg` |
| macOS (Intel) | `ClaudeBox_x.x.x_x64.dmg` |
| Windows | `ClaudeBox_x.x.x_x64-setup.exe` |

### Prerequisites

- **Node.js** >= 18 (required to run the sidecar bridge)
- **Claude Code CLI** installed globally:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
- **Anthropic API Key** — Configure in Settings after launching the app

## Development

### Requirements

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://rustup.rs/) (stable toolchain)
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)

### Setup

```bash
# Clone the repository
git clone https://github.com/braverior/ClaudeBox.git
cd ClaudeBox

# Install dependencies
npm install

# Start dev mode (launches Tauri + Vite dev server)
npx tauri dev
```

### Build

```bash
# Build the sidecar bridge + frontend + Tauri app
npm run build:sidecar && npx tauri build
```

The output will be in `src-tauri/target/release/bundle/`.

### Project Structure

```
ClaudeBox/
├── src/                          # React frontend
│   ├── components/
│   │   ├── chat/                 # ChatPanel, MessageBubble, InputArea,
│   │   │                         # ToolCallCard, CodeBlock, FileTree,
│   │   │                         # FileViewer, TaskBoard
│   │   ├── sidebar/              # Sidebar, SessionList, NewSessionDialog
│   │   ├── settings/             # SettingsDialog
│   │   └── debug/                # DebugPanel (Cmd+Shift+D)
│   ├── stores/                   # Zustand stores
│   │   ├── chatStore.ts          # Sessions, messages, streaming state
│   │   ├── settingsStore.ts      # Settings, theme, locale
│   │   └── taskStore.ts          # Task tracking
│   ├── lib/
│   │   ├── claude-ipc.ts         # Tauri IPC wrappers (25+ commands)
│   │   ├── stream-parser.ts      # Stream event type definitions
│   │   ├── storage.ts            # Persistent file-based storage
│   │   ├── i18n.ts               # Internationalization (en/zh)
│   │   ├── updater.ts            # Auto-update with failover endpoints
│   │   └── utils.ts              # Utility functions
│   └── index.css                 # Tailwind CSS v4 + theme variables
├── src-tauri/                    # Rust backend
│   └── src/
│       ├── claude.rs             # Process management, IPC commands,
│       │                         # proxy detection, git operations
│       ├── lib.rs                # Tauri app setup
│       └── main.rs               # Entry point
├── sidecar/
│   └── bridge.mjs                # Node.js sidecar (Agent SDK bridge)
└── .github/workflows/
    └── release.yml               # CI: build macOS + Windows releases
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     React Frontend                          │
│  ┌───────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐ │
│  │ ChatPanel │  │  Sidebar  │  │ Settings │  │  Debug   │ │
│  │ Messages  │  │ Sessions  │  │  Dialog  │  │  Panel   │ │
│  │ InputArea │  │ FileTree  │  │          │  │          │ │
│  └─────┬─────┘  └───────────┘  └──────────┘  └──────────┘ │
│        │  Zustand stores (chatStore, settingsStore)        │
├────────┼───────────────────────────────────────────────────┤
│        │  Tauri IPC (invoke / listen)                      │
├────────┼───────────────────────────────────────────────────┤
│        ▼         Rust Backend (Tauri v2)                   │
│  ┌────────────────────────────────────────────────────┐    │
│  │ claude.rs                                          │    │
│  │  - Spawn / manage Node.js sidecar processes        │    │
│  │  - Pipe stdin/stdout (NDJSON protocol)             │    │
│  │  - Emit stream events to frontend                  │    │
│  │  - Shell env resolution (PATH, API keys)           │    │
│  │  - System proxy detection & injection              │    │
│  │  - Git branch operations                           │    │
│  └──────────┬─────────────────────────────────────────┘    │
├─────────────┼──────────────────────────────────────────────┤
│             ▼     Node.js Sidecar (bridge.mjs)             │
│  ┌────────────────────────────────────────────────────┐    │
│  │ @anthropic-ai/claude-agent-sdk  query() API        │    │
│  │  - Receives NDJSON commands on stdin                │    │
│  │  - Streams events on stdout                        │    │
│  │  - canUseTool: AskUserQuestion / ExitPlanMode      │    │
│  │  - File attachment processing                      │    │
│  │  - Session resume support                          │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Communication Flow

**User sends a message:**

1. React `InputArea` calls `handleSend()`
2. `chatStore` stores the user message, sets streaming state
3. `claude-ipc.ts` invokes Rust `send_message` command
4. Rust spawns `node bridge.bundle.mjs`, writes NDJSON `start` message to stdin
5. Sidecar calls `query()` from the Agent SDK, streams results to stdout
6. Rust reads stdout line-by-line, emits `claude-stream` events to frontend
7. `chatStore.handleStreamData` parses events, updates messages reactively

**Interactive tool approval:**

1. Sidecar `canUseTool` intercepts `AskUserQuestion` / `ExitPlanMode`
2. Emits `ask_user` / `exit_plan` event with a `requestId`
3. Frontend renders interactive UI in `ToolCallCard`
4. User responds, frontend calls `sendResponse` IPC
5. Rust writes JSON response to sidecar stdin
6. Sidecar resolves the pending promise, SDK continues

## Configuration

Open **Settings** from the sidebar gear icon:

| Setting | Description |
|---------|-------------|
| **API Key** | Your Anthropic API key (required) |
| **Base URL** | Custom API base URL (optional, for proxies) |
| **Models** | Available model IDs (validated before adding) |
| **Claude CLI Path** | Custom path to `claude` binary (auto-detected by default) |
| **Theme** | Dark / Light |
| **Language** | English / Chinese |

Per-session settings are available in the input toolbar:
- **Model** — Select which model to use for this session
- **Permission Mode** — Default (manual approval) / Auto / Plan
- **Allowed Tools** — Toggle individual tools on/off

Data is stored in `~/.claudebox/data/` and persists across app updates.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line in input |
| `Cmd/Ctrl+V` | Paste image from clipboard |
| `Cmd+Shift+D` | Toggle debug panel |

## FAQ

**Q: Do I need Claude Code CLI installed?**
A: Yes. ClaudeBox uses the [Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) which requires Claude Code (`@anthropic-ai/claude-code`) to be installed and accessible in your PATH.

**Q: Where are sessions stored?**
A: Sessions and messages are persisted in `~/.claudebox/data/`. This is independent of the WebView storage and survives app updates.

**Q: Can I use a custom API endpoint?**
A: Yes. Set the **Base URL** in Settings to point to your proxy or compatible API endpoint.

**Q: Does ClaudeBox support system proxies?**
A: Yes. ClaudeBox automatically detects system proxy settings (HTTP/SOCKS5) and injects them into the sidecar environment. Proxy changes are polled every 30 seconds, so toggling your proxy tool (Clash, V2Ray, etc.) is picked up automatically.

**Q: macOS says the app is damaged / can't be opened?**
A: Run `xattr -cr /Applications/ClaudeBox.app` in Terminal to remove the quarantine flag.

**Q: Can I resume a previous conversation?**
A: Yes. ClaudeBox automatically stores the Claude session ID. When you send a new message in an existing session, the conversation resumes with full context.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE)

---

<p align="center">
  Built with <a href="https://v2.tauri.app">Tauri</a> + <a href="https://react.dev">React</a> + <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>
</p>

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

## Features

- **Multi-session management** — Open multiple project folders simultaneously, each with its own Claude Code session. A green indicator shows which sessions are actively running.
- **Streaming chat UI** — Real-time message streaming with Markdown rendering, syntax-highlighted code blocks, and GitHub Flavored Markdown support.
- **Interactive tool approvals** — Visual cards for tool calls (Read, Write, Edit, Bash, etc.) with approve/deny controls. `AskUserQuestion` and `ExitPlanMode` render as interactive forms.
- **File attachments** — Attach code files and images to messages. Text files are embedded inline; images are passed to Claude's Read tool.
- **Task board** — Displays Claude's `TaskCreate` / `TaskUpdate` progress in a visual task board above the input area.
- **Project file browser** — Built-in file tree and file viewer panel for browsing your project without switching windows.
- **Model & mode selection** — Switch models and permission modes (Default / Auto / Plan) per session from the input toolbar.
- **Tool allow-list** — Configure which tools Claude can use per session (Read, Write, Edit, Glob, Grep, Bash, etc.).
- **Dark & Light themes** — Toggle between dark and light themes from the sidebar.
- **i18n** — English and Chinese (simplified) interfaces.
- **Auto-updates** — Built-in update checker via GitHub Releases with signature verification.
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
│   │   ├── chat/                 # ChatPanel, MessageBubble, InputArea, ToolCallCard, CodeBlock, FileTree, FileViewer, TaskBoard
│   │   ├── sidebar/              # Sidebar, SessionList, NewSessionDialog
│   │   ├── settings/             # SettingsDialog
│   │   └── debug/                # DebugPanel (Cmd+Shift+D)
│   ├── stores/                   # Zustand stores
│   │   ├── chatStore.ts          # Sessions, messages, streaming state
│   │   ├── settingsStore.ts      # Settings, theme, locale
│   │   └── taskStore.ts          # Task tracking
│   ├── lib/
│   │   ├── claude-ipc.ts         # Tauri IPC wrappers
│   │   ├── stream-parser.ts      # Stream event type definitions
│   │   ├── i18n.ts               # Internationalization (en/zh)
│   │   ├── updater.ts            # Auto-update logic
│   │   └── utils.ts              # Utility functions
│   └── index.css                 # Tailwind + theme variables
├── src-tauri/                    # Rust backend
│   └── src/
│       ├── claude.rs             # Process management, IPC commands
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
│  └──────────┬─────────────────────────────────────────┘    │
├─────────────┼──────────────────────────────────────────────┤
│             ▼     Node.js Sidecar (bridge.mjs)             │
│  ┌────────────────────────────────────────────────────┐    │
│  │ @anthropic-ai/claude-agent-sdk  query() API        │    │
│  │  - Receives NDJSON commands on stdin                │    │
│  │  - Streams events on stdout                        │    │
│  │  - canUseTool: AskUserQuestion / ExitPlanMode      │    │
│  │  - File attachment processing                      │    │
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
| **Models** | List of available model IDs to choose from |
| **Claude CLI Path** | Custom path to `claude` binary (auto-detected by default) |
| **Theme** | Dark / Light |
| **Language** | English / Chinese |

Per-session settings are available in the input toolbar:
- **Model** — Select which model to use for this session
- **Permission Mode** — Default (manual approval) / Auto / Plan
- **Allowed Tools** — Toggle individual tools on/off

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line in input |
| `Cmd+Shift+D` | Toggle debug panel |

## FAQ

**Q: Do I need Claude Code CLI installed?**
A: Yes. ClaudeBox uses the [Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) which requires Claude Code (`@anthropic-ai/claude-code`) to be installed and accessible in your PATH.

**Q: Where are sessions stored?**
A: Sessions and messages are persisted in the browser's `localStorage` via Tauri's WebView. They survive app restarts but are cleared if you reset the app data.

**Q: Can I use a custom API endpoint?**
A: Yes. Set the **Base URL** in Settings to point to your proxy or compatible API endpoint.

**Q: macOS says the app is damaged / can't be opened?**
A: Run `xattr -cr /Applications/ClaudeBox.app` in Terminal to remove the quarantine flag.

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

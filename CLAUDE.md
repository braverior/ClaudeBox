# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ClaudeBox is a native desktop GUI for Claude Code, built with **Tauri v2 + React 19 + TypeScript**. It wraps the `@anthropic-ai/claude-agent-sdk` in a visual chat interface with interactive tool approvals, multi-session management, and a task board.

## Common commands

```bash
# Dev (Tauri + Vite hot-reload)
npx tauri dev

# Full production build (macOS .dmg / Windows installer)
npm run build:sidecar && npm run build:lark-sidecar && npx tauri build
# OR via build.sh (sign + notarize + publish workflow — see build.sh header for env vars)
./build.sh dmg            # build .app + DMG
./build.sh sign           # codesign + notarize (requires APPLE_* env vars)
./build.sh publish        # upload to GH Release + update Homebrew Cask
./build.sh all            # dmg → sign → publish

# Sidecar-only rebuild (after editing sidecar/bridge.mjs or lark-bot.mjs)
npm run build:sidecar
npm run build:lark-sidecar

# Frontend-only build/typecheck
npm run build             # tsc + vite build
```

No test runner is configured. No lint script is defined — rely on `tsc` (via `npm run build`) for typechecking.

## Architecture (three-tier)

The app is a three-process system. Understanding the boundary between them is critical — most bugs live at the seams.

```
React Frontend  ⇄  Tauri IPC  ⇄  Rust Backend  ⇄  stdin/stdout NDJSON  ⇄  Node.js Sidecar  ⇄  Agent SDK query()
```

1. **React frontend** (`src/`) — UI, Zustand stores, IPC wrappers. Never talks to Node directly.
2. **Rust backend** (`src-tauri/src/claude.rs`, `lark.rs`, `lib.rs`) — spawns/manages the Node.js sidecar child processes, pipes stdin/stdout, emits `claude-stream` events to the frontend, handles OS-specific work (proxy detection, git, file system, clipboard images).
3. **Node.js sidecar** (`sidecar/bridge.mjs`) — the only place that imports `@anthropic-ai/claude-agent-sdk`. Receives NDJSON commands on stdin, streams events on stdout. `canUseTool` callback intercepts `AskUserQuestion` / `ExitPlanMode` to hand off to interactive UI.

The sidecar is bundled to `sidecar/bridge.bundle.mjs` via esbuild and shipped as a Tauri resource. At runtime, Rust spawns `node bridge.bundle.mjs`. **Editing `bridge.mjs` without running `npm run build:sidecar` will have no effect on the production build** (dev mode reloads the bundle on `tauri dev` too — always rebuild).

### Interactive tool flow (AskUserQuestion / ExitPlanMode)

```
Sidecar canUseTool intercepts
  → emits {type:"ask_user"|"exit_plan", requestId} to stdout
  → Rust forwards as claude-stream event
  → chatStore sets pendingInteraction
  → ToolCallCard renders interactive UI
  → user responds → ChatPanel.handleRespond
  → sendResponse IPC → Rust stdin_handles[session].write(JSON)
  → Sidecar resolves pending promise → SDK continues
```

`stdin_handles: HashMap<session_id, ChildStdin>` in `claude.rs` is how Rust routes the response back to the correct running sidecar.

### Session resume

The real Claude session ID arrives in the system `init` stream event and is stored on `Session.claudeSessionId`. On the next `send_message`, it's passed as `resume_id` → `--resume` flag. This is why sending two messages in a row continues the same conversation.

## Key files

| File | What lives here |
|---|---|
| `src-tauri/src/claude.rs` | Process manager, send_message / send_response / stop_session commands, proxy detection (scutil / reg), git ops, file browser commands, clipboard image save, skill preload. ~2k lines — the critical hub. |
| `src-tauri/src/lark.rs` | Feishu/Lark bot sidecar — separate sidecar process for task completion notifications. |
| `src-tauri/src/lib.rs` | Tauri builder, plugin registration, invoke_handler list (single source of truth for IPC commands exposed to JS). |
| `sidecar/bridge.mjs` | Agent SDK bridge. Handles attachment processing (text → fenced code block, image → `[Attached image: path]`), env cleaning (`CLAUDECODE` removed), canUseTool interactive handoff. |
| `sidecar/lark-bot.mjs` | Lark notification bot sidecar. |
| `src/lib/claude-ipc.ts` | Typed wrappers around every Tauri invoke. Add new IPC calls here AND in `lib.rs` `invoke_handler!`. |
| `src/stores/chatStore.ts` | Sessions, messages, streaming state, `pendingInteraction`, stream event parsing via `handleStreamData`. Persisted to `~/.claudebox/data/` (not localStorage — see `src/lib/storage.ts`). |
| `src/stores/settingsStore.ts` | API key, base URL, models, theme, locale. |
| `src/components/chat/ChatPanel.tsx` | Top-level chat container. Wires stream listener, `handleRespond` for interactive tools. |
| `src/components/chat/ToolCallCard.tsx` | Renders every tool call with approve/deny controls + interactive forms for AskUserQuestion / ExitPlanMode. |
| `src/components/chat/InputArea.tsx` | Message input, attachments, model/mode/tools pickers, git branch switcher. |
| `src-tauri/capabilities/default.json` | Tauri v2 permission list — adding a new `core:*` invoke often requires adding the permission here too. |
| `build.sh` | Sign + notarize + publish pipeline. Reads version from `tauri.conf.json`, uploads DMG to GH Release, updates Homebrew Cask at `braverior/homebrew-tap`. |
| `cloudflare-worker/` | Update proxy Worker for users in regions with GitHub connectivity issues. Rewrites `latest.json` download URLs to the Worker's own proxy endpoints. |

## Adding a new Tauri command

1. Add `#[tauri::command] async fn my_cmd(...)` in `claude.rs` (or a new module registered in `lib.rs`).
2. Register it in `lib.rs` `invoke_handler![...]`.
3. If it touches a new capability (filesystem, shell, window), add the permission to `src-tauri/capabilities/default.json`.
4. Add a typed wrapper in `src/lib/claude-ipc.ts` — always invoke via this wrapper, never raw `invoke()` in components.

## Storage

Data persists to `~/.claudebox/data/` via `storage_read/write/remove` IPC commands (Rust-side file I/O). First launch auto-migrates from localStorage. Do **not** use `localStorage` / `sessionStorage` for session data — WebView resets clear them.

Clipboard images go to `~/.claudebox/tmp/`, cleaned up on startup if older than 24h.

## Bundle identifier

`com.claudebox.desktop` — not `com.claudebox.app`. The `.app` suffix conflicts with macOS app bundle semantics (see git history for the fix).

## Window drag (Tauri v2 gotcha)

`data-tauri-drag-region` alone is unreliable when the header has child elements. The working pattern is **both**:
1. `core:window:allow-start-dragging` in `capabilities/default.json` (JS `startDragging()` silently fails without it).
2. `onMouseDown` fallback that calls `getCurrentWindow().startDragging()`, with `.closest("button")` to skip interactive children.
3. Keep `titleBarStyle: "Overlay"` — `"Transparent"` shows an ugly native title bar stripe.

Full writeup: `tauri-drag-region.md` (if present in user memory).

## Proxy handling

System proxy is detected via `scutil --proxy` (macOS) or registry (Windows) and polled every 30s. SOCKS5 is preferred for HTTPS in regions with GFW TLS fingerprinting (uses `socks5h://` for remote DNS). Reqwest is built with the `socks` feature; this also upgrades `tauri-plugin-updater`'s reqwest via Cargo feature unification.

## Signing & release

macOS release requires `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_ID_PASSWORD`, `APPLE_TEAM_ID` (notarization). Tauri updater signing uses `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`. See `build.sh` header for the full env var list and `docs/code-signing.md` for the cert setup.

## Release workflow (CHANGELOG required before tagging)

Before pushing a new `vX.Y.Z` tag, always update `CHANGELOG.md` at the repo root. The app bundles this file (`import "../../CHANGELOG.md?raw"` in `src/lib/changelog.ts`) and renders it in the in-app history dialog, so GitHub outage does **not** affect users seeing release notes.

Steps:
1. Bump `version` in `src-tauri/tauri.conf.json` (and `package.json` if mirrored).
2. Run `git log <previous-tag>..HEAD --oneline --no-merges` to list new commits since last tag.
3. Prepend a new section to `CHANGELOG.md` using Keep-a-Changelog format:
   ```
   ## [X.Y.Z] - YYYY-MM-DD

   ### 新增
   - …

   ### 优化
   - …

   ### 修复
   - …
   ```
   Group commits by category; drop noisy/internal-only commits; write user-facing Chinese bullets (the dialog audience is end users). Omit empty subsections.
4. Commit: `git commit -am "vX.Y.Z: <短描述>"` then `git tag vX.Y.Z && git push --follow-tags`.
5. `./build.sh all` to build/sign/publish.

The parser at `src/lib/changelog.ts` relies on the `## [X.Y.Z] - YYYY-MM-DD` heading format — don't change it without updating the regex.

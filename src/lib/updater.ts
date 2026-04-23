import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { emitDebug, probeUrl } from "./claude-ipc";
import { storageRead, storageWrite, storageRemove } from "./storage";

export interface UpdateStatus {
  available: boolean;
  version?: string;
  body?: string;
  date?: string;
  downloading: boolean;
  downloaded: boolean;
  error?: string;
}

export type UpdateCallback = (status: UpdateStatus) => void;

/** Update endpoints (must match tauri.conf.json → plugins.updater.endpoints) */
const UPDATE_ENDPOINTS = [
  "https://claudebox-update-proxy.braverior.workers.dev/latest.json",
  "https://github.com/braverior/ClaudeBox/releases/latest/download/latest.json",
];

/** Log to both console and the app's Debug Panel */
function log(level: "info" | "warn" | "error", msg: string) {
  const text = `[updater] ${msg}`;
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
  emitDebug(level, text);
}

/** Simple elapsed timer */
function timer() {
  const start = performance.now();
  return () => `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

/** Format bytes to human-readable */
function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "unknown";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Shorten URL for display: keep host + first path segment */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

/**
 * Probe each update endpoint using native curl (via Rust IPC).
 * Bypasses WebView CORS and uses SOCKS5 proxy for reliability.
 */
async function probeEndpoints(): Promise<void> {
  log("info", `Probing ${UPDATE_ENDPOINTS.length} update endpoint(s) via native curl...`);

  const results = await Promise.allSettled(
    UPDATE_ENDPOINTS.map(async (url) => {
      const host = shortUrl(url);
      try {
        const result = await probeUrl(url);
        if (result.ok) {
          const versionInfo = result.version ? ` → v${result.version}` : "";
          log("info", `  ✓ ${host} — OK, ${result.size} bytes, ${(result.time_ms / 1000).toFixed(1)}s${versionInfo}`);
          return true;
        } else {
          log("warn", `  ✗ ${host} — ${result.error}, ${(result.time_ms / 1000).toFixed(1)}s`);
          return false;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("warn", `  ✗ ${host} — IPC error: ${msg}`);
        return false;
      }
    })
  );

  const ok = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
  log("info", `Endpoint probe done: ${ok}/${UPDATE_ENDPOINTS.length} reachable`);
}

/**
 * Check for updates on startup, download silently in background,
 * then notify via callback when ready to install.
 */
export async function checkAndDownloadUpdate(
  onStatus: UpdateCallback
): Promise<void> {
  const elapsed = timer();
  log("info", "Starting update check...");

  // Diagnostic: probe each endpoint independently
  await probeEndpoints();

  try {
    log("info", "Calling Tauri updater check()...");
    const update: Update | null = await check();
    log("info", `Tauri check() completed in ${elapsed()}`);

    if (!update) {
      log("info", "No update available — already on latest version");
      onStatus({ available: false, downloading: false, downloaded: false });
      return;
    }

    log(
      "info",
      `Update available: v${update.version}` +
        (update.date ? ` (released ${update.date})` : "") +
        (update.body
          ? ` — "${update.body.slice(0, 80)}${update.body.length > 80 ? "..." : ""}"`
          : "")
    );

    // Update available — start silent download
    onStatus({
      available: true,
      version: update.version,
      body: update.body ?? undefined,
      date: update.date ?? undefined,
      downloading: true,
      downloaded: false,
    });

    // Download and stage the update
    const dlTimer = timer();
    let totalBytes: number | null = null;
    let receivedBytes = 0;
    let lastLogPercent = 0;

    await update.downloadAndInstall((event: DownloadEvent) => {
      switch (event.event) {
        case "Started":
          totalBytes = event.data.contentLength ?? null;
          log("info", `Download started — size: ${fmtBytes(totalBytes)}`);
          break;
        case "Progress":
          receivedBytes += event.data.chunkLength;
          if (totalBytes && totalBytes > 0) {
            const pct = Math.floor((receivedBytes / totalBytes) * 100);
            // Log at every 25%
            if (pct >= lastLogPercent + 25) {
              lastLogPercent = Math.floor(pct / 25) * 25;
              log(
                "info",
                `Download progress: ${pct}% (${fmtBytes(receivedBytes)} / ${fmtBytes(totalBytes)}, ${dlTimer()})`
              );
            }
          }
          break;
        case "Finished":
          log(
            "info",
            `Download finished — ${fmtBytes(receivedBytes)} in ${dlTimer()}`
          );
          break;
      }
    });

    log("info", `Update staged, total elapsed: ${elapsed()}`);

    // Persist release notes so the app can show a "What's new" dialog
    // after the user restarts into the new version.
    try {
      await savePendingReleaseNotes({
        version: update.version,
        body: update.body ?? "",
        date: update.date ?? "",
      });
    } catch (err) {
      log("warn", `Failed to persist release notes: ${err}`);
    }

    // Ready to install — prompt user to restart
    onStatus({
      available: true,
      version: update.version,
      body: update.body ?? undefined,
      date: update.date ?? undefined,
      downloading: false,
      downloaded: true,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log("error", `Update check/download FAILED after ${elapsed()}: ${errMsg}`);
    if (err instanceof Error && err.stack) {
      log("error", `Stack trace: ${err.stack}`);
    }
    onStatus({
      available: false,
      downloading: false,
      downloaded: false,
      error: errMsg,
    });
  }
}

/**
 * Relaunch the app to apply the downloaded update.
 */
export async function applyUpdateAndRelaunch(): Promise<void> {
  log("info", "Relaunching app to apply update...");
  await relaunch();
}

// ── Release notes persistence ─────────────────────────────────────────
// After a successful download, we save `{version, body, date}` so that
// the next launch (running the new version) can show a "What's new" dialog.

const PENDING_RELEASE_NOTES_KEY = "pending_release_notes";

export interface PendingReleaseNotes {
  version: string;
  body: string;
  date: string;
}

async function savePendingReleaseNotes(notes: PendingReleaseNotes): Promise<void> {
  await storageWrite(PENDING_RELEASE_NOTES_KEY, JSON.stringify(notes));
}

export async function readPendingReleaseNotes(): Promise<PendingReleaseNotes | null> {
  try {
    const raw = await storageRead(PENDING_RELEASE_NOTES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version !== "string") return null;
    return {
      version: parsed.version,
      body: typeof parsed.body === "string" ? parsed.body : "",
      date: typeof parsed.date === "string" ? parsed.date : "",
    };
  } catch {
    return null;
  }
}

export async function clearPendingReleaseNotes(): Promise<void> {
  try {
    await storageRemove(PENDING_RELEASE_NOTES_KEY);
  } catch { /* ignore */ }
}

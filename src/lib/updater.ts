import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateStatus {
  available: boolean;
  version?: string;
  body?: string;
  downloading: boolean;
  downloaded: boolean;
  error?: string;
}

export type UpdateCallback = (status: UpdateStatus) => void;

/**
 * Check for updates on startup, download silently in background,
 * then notify via callback when ready to install.
 */
export async function checkAndDownloadUpdate(
  onStatus: UpdateCallback
): Promise<void> {
  try {
    const update: Update | null = await check();

    if (!update) {
      onStatus({ available: false, downloading: false, downloaded: false });
      return;
    }

    // Update available — start silent download
    onStatus({
      available: true,
      version: update.version,
      body: update.body ?? undefined,
      downloading: true,
      downloaded: false,
    });

    // Download and stage the update
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          console.log(
            `[updater] Download started, size: ${event.data.contentLength ?? "unknown"} bytes`
          );
          break;
        case "Progress":
          // Silent — no progress UI needed
          break;
        case "Finished":
          console.log("[updater] Download finished");
          break;
      }
    });

    // Ready to install — prompt user to restart
    onStatus({
      available: true,
      version: update.version,
      body: update.body ?? undefined,
      downloading: false,
      downloaded: true,
    });
  } catch (err) {
    console.warn("[updater] Update check failed:", err);
    onStatus({
      available: false,
      downloading: false,
      downloaded: false,
      error: String(err),
    });
  }
}

/**
 * Relaunch the app to apply the downloaded update.
 */
export async function applyUpdateAndRelaunch(): Promise<void> {
  await relaunch();
}

/**
 * Persistent file-based storage via Tauri Rust backend.
 * Data is stored in ~/.claudebox/data/{key}.json — stable across app updates,
 * no size limits, independent of WebView localStorage.
 */
import { invoke } from "@tauri-apps/api/core";

export async function storageRead(key: string): Promise<string | null> {
  return invoke<string | null>("storage_read", { key });
}

export async function storageWrite(key: string, value: string): Promise<void> {
  return invoke("storage_write", { key, value });
}

export async function storageRemove(key: string): Promise<void> {
  return invoke("storage_remove", { key });
}

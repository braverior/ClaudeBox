import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ── Types ────────────────────────────────────────────────────────────

export interface StartLarkBotRequest {
  app_id: string;
  app_secret: string;
  project_dir?: string;
  model?: string;
  api_key?: string;
  base_url?: string;
}

export interface LarkStreamPayload {
  data: string;
  done: boolean;
  error?: string;
}

// ── Commands ─────────────────────────────────────────────────────────

/** Start the Lark bot sidecar process. Returns the PID. */
export async function startLarkBot(request: StartLarkBotRequest): Promise<number> {
  return invoke("start_lark_bot", { request });
}

/** Stop the running Lark bot process. */
export async function stopLarkBot(): Promise<void> {
  return invoke("stop_lark_bot");
}

/** Get the current Lark bot connection status. */
export async function getLarkStatus(): Promise<string> {
  return invoke("get_lark_status");
}

/** Send a notification card via the Lark bot. */
export async function larkSendNotification(
  chatId: string,
  title: string,
  content: string,
  cardType: string,
): Promise<void> {
  return invoke("lark_send_notification", { chatId, title, content, cardType });
}

/** Send a raw JSON command to the Lark bot sidecar. */
export async function larkSendCommand(command: string): Promise<void> {
  return invoke("lark_send_command", { command });
}

// ── Events ───────────────────────────────────────────────────────────

/** Listen for Lark bot events (status, messages, etc.) */
export function onLarkEvent(
  callback: (payload: LarkStreamPayload) => void,
): Promise<UnlistenFn> {
  return listen<LarkStreamPayload>("lark-event", (event) => {
    callback(event.payload);
  });
}

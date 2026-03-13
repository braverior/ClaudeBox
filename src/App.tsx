import { useState, useEffect } from "react";
import Sidebar from "./components/sidebar/Sidebar";
import ChatPanel from "./components/chat/ChatPanel";
import SettingsDialog from "./components/settings/SettingsDialog";
import DebugPanel from "./components/debug/DebugPanel";
import UpdateToast from "./components/UpdateToast";
import { checkClaudeInstalled } from "./lib/claude-ipc";
import {
  checkAndDownloadUpdate,
  applyUpdateAndRelaunch,
  type UpdateStatus,
} from "./lib/updater";
import { useSettingsStore } from "./stores/settingsStore";

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [claudeAvailable, setClaudeAvailable] = useState(true);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const { settings } = useSettingsStore();

  // Apply theme class to root element
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "light") {
      root.classList.add("light");
    } else {
      root.classList.remove("light");
    }
  }, [settings.theme]);

  useEffect(() => {
    checkClaudeInstalled(settings.claudePath || undefined)
      .then(() => setClaudeAvailable(true))
      .catch(() => {
        setClaudeAvailable(false);
        setSettingsOpen(true);
      });
  }, []);

  // Keyboard shortcut: Ctrl/Cmd+Shift+D to toggle debug
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "d") {
        e.preventDefault();
        setDebugOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Check for updates on startup (silent background download)
  useEffect(() => {
    checkAndDownloadUpdate(setUpdateStatus);
  }, []);

  return (
    <div className="flex h-screen bg-bg-primary">
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      <ChatPanel claudeAvailable={claudeAvailable} />

      {/* Debug panel */}
      <DebugPanel visible={debugOpen} onClose={() => setDebugOpen(false)} />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onClaudeStatusChange={setClaudeAvailable}
        onOpenDebug={() => setDebugOpen(true)}
      />

      {/* Update toast — shows when update is downloading or ready */}
      {updateStatus?.available &&
        !updateDismissed &&
        (updateStatus.downloading || updateStatus.downloaded) && (
          <UpdateToast
            version={updateStatus.version!}
            body={updateStatus.body}
            downloading={updateStatus.downloading}
            onRestart={applyUpdateAndRelaunch}
            onDismiss={() => setUpdateDismissed(true)}
          />
        )}
    </div>
  );
}

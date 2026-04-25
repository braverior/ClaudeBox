import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Copy } from "lucide-react";
import { isWindows } from "../lib/utils";

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isWindows) return;
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized);
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  if (!isWindows) return null;

  const win = getCurrentWindow();

  const btn =
    "inline-flex items-center justify-center w-[46px] h-[34px] transition-colors text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50";

  return (
    <div className="flex items-center flex-shrink-0 -mr-1">
      <button className={btn} onClick={() => win.minimize()}>
        <Minus size={16} />
      </button>
      <button className={btn} onClick={() => win.toggleMaximize()}>
        {maximized ? <Copy size={14} className="scale-x-[-1]" /> : <Square size={13} />}
      </button>
      <button
        className={`${btn} hover:!bg-red-500 hover:!text-white`}
        onClick={() => win.close()}
      >
        <X size={16} />
      </button>
    </div>
  );
}

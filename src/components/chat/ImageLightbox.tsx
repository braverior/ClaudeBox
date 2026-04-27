import { useCallback, useEffect, useRef, useState } from "react";
import { X, ZoomIn, ZoomOut, RotateCcw, ExternalLink } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useImageViewerStore } from "../../stores/imageViewerStore";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const WHEEL_STEP = 0.1;
const BTN_STEP = 0.25;

export default function ImageLightbox() {
  const { open, src, name, path, closeImage } = useImageViewerStore();

  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const reset = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  // Reset on each open
  useEffect(() => {
    if (open) reset();
  }, [open, src, reset]);

  // Keyboard: Esc / + / - / 0
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeImage();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setScale((s) => Math.min(MAX_SCALE, +(s + BTN_STEP).toFixed(2)));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setScale((s) => Math.max(MIN_SCALE, +(s - BTN_STEP).toFixed(2)));
      } else if (e.key === "0") {
        e.preventDefault();
        reset();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, closeImage, reset]);

  // Wheel zoom
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -WHEEL_STEP : WHEEL_STEP;
    setScale((s) => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, +(s + delta).toFixed(2)));
      if (next <= 1) setTranslate({ x: 0, y: 0 });
      return next;
    });
  };

  // Drag to pan (only when zoomed in)
  const onMouseDown = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: translate.x,
      origY: translate.y,
    };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setTranslate({
        x: dragRef.current.origX + (e.clientX - dragRef.current.startX),
        y: dragRef.current.origY + (e.clientY - dragRef.current.startY),
      });
    };
    const up = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [dragging]);

  // Double-click image: toggle 1x / 2x
  const onImageDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (scale === 1) {
      setScale(2);
    } else {
      reset();
    }
  };

  // Background click: close
  const onBackgroundClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closeImage();
  };

  if (!open || !src) return null;

  const pct = Math.round(scale * 100);

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/85 backdrop-blur-sm flex items-center justify-center select-none"
      onClick={onBackgroundClick}
      onWheel={onWheel}
    >
      {/* Top-right toolbar */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        {path && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              shellOpen(path).catch(() => {});
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20
                       text-white/90 text-xs transition-colors backdrop-blur-md"
            title="在系统中打开"
          >
            <ExternalLink size={14} />
            <span>在系统中打开</span>
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            closeImage();
          }}
          className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center
                     transition-colors backdrop-blur-md"
          title="关闭 (Esc)"
        >
          <X size={18} />
        </button>
      </div>

      {/* File name */}
      {name && (
        <div className="absolute top-5 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-white/10
                        backdrop-blur-md text-white/90 text-xs max-w-[50%] truncate">
          {name}
        </div>
      )}

      {/* Image */}
      <img
        src={src}
        alt={name || "preview"}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={onImageDoubleClick}
        onMouseDown={onMouseDown}
        className="max-w-[90vw] max-h-[85vh] object-contain shadow-2xl"
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          transition: dragging ? "none" : "transform 150ms ease-out",
          cursor: scale > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
        }}
      />

      {/* Bottom zoom toolbar */}
      <div
        className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1.5 rounded-xl
                   bg-white/10 backdrop-blur-md"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => setScale((s) => Math.max(MIN_SCALE, +(s - BTN_STEP).toFixed(2)))}
          className="w-8 h-8 rounded-lg hover:bg-white/15 text-white/90 flex items-center justify-center transition-colors"
          title="缩小 (-)"
        >
          <ZoomOut size={16} />
        </button>
        <div className="min-w-[56px] text-center text-xs text-white/90 tabular-nums">{pct}%</div>
        <button
          onClick={() => setScale((s) => Math.min(MAX_SCALE, +(s + BTN_STEP).toFixed(2)))}
          className="w-8 h-8 rounded-lg hover:bg-white/15 text-white/90 flex items-center justify-center transition-colors"
          title="放大 (+)"
        >
          <ZoomIn size={16} />
        </button>
        <div className="w-px h-5 bg-white/15 mx-1" />
        <button
          onClick={reset}
          className="w-8 h-8 rounded-lg hover:bg-white/15 text-white/90 flex items-center justify-center transition-colors"
          title="重置 (0)"
        >
          <RotateCcw size={15} />
        </button>
      </div>
    </div>
  );
}

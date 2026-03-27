import { useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { PanelId } from "../hooks/usePanelState";
import { usePanelState } from "../hooks/usePanelState";

interface PanelProps {
  id: PanelId;
  title: string;
  defaultX?: number;
  defaultY?: number;
  defaultW?: number;
  defaultH?: number;
  /** @deprecated use defaultW */
  width?: number;
  minW?: number;
  minH?: number;
  /** Whether this panel is currently in PiP mode */
  pipActive?: boolean;
  /** If provided, a PiP button appears in the title bar */
  onPip?: () => void;
  /** Remove content area padding — use for full-bleed media like the camera feed */
  noPadding?: boolean;
  children: React.ReactNode;
}

// Resize handle edges/corners
type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLE_SIZE = 6;

const handleStyle = (dir: ResizeDir): React.CSSProperties => {
  const base: React.CSSProperties = { position: "absolute", zIndex: 10 };
  const cursors: Record<ResizeDir, string> = {
    n: "n-resize", s: "s-resize", e: "e-resize", w: "w-resize",
    ne: "ne-resize", nw: "nw-resize", se: "se-resize", sw: "sw-resize",
  };
  const positions: Record<ResizeDir, React.CSSProperties> = {
    n:  { top: 0, left: HANDLE_SIZE, right: HANDLE_SIZE, height: HANDLE_SIZE },
    s:  { bottom: 0, left: HANDLE_SIZE, right: HANDLE_SIZE, height: HANDLE_SIZE },
    e:  { right: 0, top: HANDLE_SIZE, bottom: HANDLE_SIZE, width: HANDLE_SIZE },
    w:  { left: 0, top: HANDLE_SIZE, bottom: HANDLE_SIZE, width: HANDLE_SIZE },
    ne: { top: 0, right: 0, width: HANDLE_SIZE, height: HANDLE_SIZE },
    nw: { top: 0, left: 0, width: HANDLE_SIZE, height: HANDLE_SIZE },
    se: { bottom: 0, right: 0, width: HANDLE_SIZE, height: HANDLE_SIZE },
    sw: { bottom: 0, left: 0, width: HANDLE_SIZE, height: HANDLE_SIZE },
  };
  return { ...base, cursor: cursors[dir], ...positions[dir] };
};

export function Panel({
  id, title,
  defaultX = 100, defaultY = 60,
  defaultW, defaultH = 400,
  width,
  minW = 240, minH = 160,
  pipActive = false,
  onPip,
  noPadding = false,
  children,
}: PanelProps) {
  const resolvedW = defaultW ?? width ?? 320;
  const { panels, close } = usePanelState();
  const isOpen = panels[id] === "open";

  const [pos, setPos]   = useState({ x: defaultX, y: defaultY });
  const [size, setSize] = useState({ w: resolvedW, h: defaultH });

  // Drag to move
  const dragRef = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);
  const onTitleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({ x: dragRef.current.px + ev.clientX - dragRef.current.mx,
               y: dragRef.current.py + ev.clientY - dragRef.current.my });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pos]);

  // Resize
  const resizeRef = useRef<{
    dir: ResizeDir; mx: number; my: number;
    px: number; py: number; pw: number; ph: number;
  } | null>(null);

  const onResizeMouseDown = useCallback((e: React.MouseEvent, dir: ResizeDir) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { dir, mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y, pw: size.w, ph: size.h };
    const onMove = (ev: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const dx = ev.clientX - r.mx;
      const dy = ev.clientY - r.my;
      let nx = r.px, ny = r.py, nw = r.pw, nh = r.ph;
      if (r.dir.includes("e")) nw = Math.max(minW, r.pw + dx);
      if (r.dir.includes("s")) nh = Math.max(minH, r.ph + dy);
      if (r.dir.includes("w")) { nw = Math.max(minW, r.pw - dx); nx = r.px + r.pw - nw; }
      if (r.dir.includes("n")) { nh = Math.max(minH, r.ph - dy); ny = r.py + r.ph - nh; }
      setPos({ x: nx, y: ny });
      setSize({ w: nw, h: nh });
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pos, size, minW, minH]);

  const dirs: ResizeDir[] = ["n","s","e","w","ne","nw","se","sw"];

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.15 }}
          style={{
            position: "fixed",
            left: pos.x,
            top: pos.y,
            width: size.w,
            height: size.h,
            zIndex: 20,
            display: "flex",
            flexDirection: "column",
            background: "#141414",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 10,
            boxShadow: "0 12px 40px rgba(0,0,0,0.8)",
            fontFamily: "'Urbanist', -apple-system, sans-serif",
            overflow: "hidden",
          }}
        >
          {/* Resize handles */}
          {dirs.map((dir) => (
            <div key={dir} style={handleStyle(dir)} onMouseDown={(e) => onResizeMouseDown(e, dir)} />
          ))}

          {/* Title bar */}
          <div
            onMouseDown={onTitleMouseDown}
            style={{
              height: 36,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              padding: "0 12px",
              borderBottom: "none",
              cursor: "grab",
              userSelect: "none",
              position: "relative",
              background: "#1a1a1a",
            }}
          >
            {/* Traffic lights */}
            <div style={{ display: "flex", gap: 6 }}>
              <div
                onClick={(e) => { e.stopPropagation(); close(id); }}
                title="Close"
                style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff3b30", cursor: "pointer" }}
              />
              <div
                onClick={(e) => { e.stopPropagation(); close(id); }}
                title="Minimize"
                style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff9f0a", cursor: "pointer" }}
              />
              <div
                title="Fullscreen"
                style={{ width: 12, height: 12, borderRadius: "50%", background: "#34c759", cursor: "default" }}
              />
            </div>

            <span style={{
              fontSize: 12,
              color: "rgba(255,255,255,0.55)",
              fontWeight: 500,
              position: "absolute",
              left: "50%",
              transform: "translateX(-50%)",
            }}>
              {title}
            </span>

            {/* PiP button — only shown when onPip is provided */}
            {onPip && (
              <button
                onClick={(e) => { e.stopPropagation(); onPip(); }}
                title={pipActive ? "Close Picture-in-Picture" : "Open in Picture-in-Picture"}
                style={{
                  marginLeft: "auto",
                  background: pipActive ? "rgba(10,132,255,0.2)" : "none",
                  border: `1px solid ${pipActive ? "rgba(10,132,255,0.5)" : "rgba(255,255,255,0.15)"}`,
                  borderRadius: 5,
                  cursor: "pointer",
                  padding: "2px 5px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.2s, border-color 0.2s",
                }}
              >
                {/* PiP icon — two overlapping rectangles */}
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect x="1" y="3" width="12" height="8" rx="1.5"
                    stroke={pipActive ? "#0a84ff" : "rgba(255,255,255,0.5)"} strokeWidth="1.2"/>
                  <rect x="7" y="6" width="5" height="3.5" rx="1"
                    fill={pipActive ? "#0a84ff" : "rgba(255,255,255,0.5)"}/>
                </svg>
              </button>
            )}
          </div>

          {/* Scrollable content */}
          <div style={{ flex: 1, overflow: "auto", padding: noPadding ? 0 : 12 }}>
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

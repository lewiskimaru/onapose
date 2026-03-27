import { useWsStatus } from "../hooks/useWsStatus";
import { usePanelState } from "../hooks/usePanelState";
import { useFps } from "../hooks/useFps";
import { useState, useCallback } from "react";

const BAR: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  height: 28,
  zIndex: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 8px",
  background: "rgba(0,0,0,0.55)",
  backdropFilter: "blur(20px) saturate(180%)",
  WebkitBackdropFilter: "blur(20px) saturate(180%)",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  fontFamily: "'Urbanist', -apple-system, BlinkMacSystemFont, sans-serif",
  fontSize: 13,
  userSelect: "none",
};

const BTN: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "rgba(255,255,255,0.75)",
  fontSize: 13,
  cursor: "pointer",
  padding: "0 8px",
  height: 28,
  display: "flex",
  alignItems: "center",
};

const STATUS_COLOR: Record<string, string> = {
  connected: "#34c759",
  connecting: "#ff9f0a",
  disconnected: "#ff3b30",
};

const STATUS_LABEL: Record<string, string> = {
  connected: "Bridge: connected",
  connecting: "Bridge: connecting",
  disconnected: "Bridge: disconnected",
};

export function MenuBar() {
  const status = useWsStatus((s) => s.status);
  const { toggle, open } = usePanelState();
  const fps = useFps();

  // Global PiP state — MenuBar button mirrors the panel's PiP button
  // We read from window.documentPictureInPicture directly so we don't need
  // to thread state up from CameraPanel
  const [pipActive, setPipActive] = useState(false);
  const pipSupported = typeof window !== "undefined" && "documentPictureInPicture" in window;

  // Listen for PiP window open/close to keep the icon in sync
  if (pipSupported) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).documentPictureInPicture.addEventListener?.("enter", () => setPipActive(true));
  }

  const handlePip = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dpip = (window as any).documentPictureInPicture;
    if (dpip?.window) {
      dpip.window.close();
      setPipActive(false);
    } else {
      // Open the camera panel first so CameraPanel's usePip can handle it
      open("camera");
      // Dispatch a custom event that CameraPanel listens for
      window.dispatchEvent(new CustomEvent("onapose:pip-request"));
    }
  }, [open]);

  const handleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  return (
    <div style={BAR}>
      {/* Left */}
      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        <img
          src="/logo.png"
          alt="OnaPose"
          style={{ width: 16, height: 16, marginRight: 6, marginLeft: 4 }}
        />
        <span style={{ color: "rgba(255,255,255,0.9)", fontWeight: 600, marginRight: 8 }}>
          OnaPose
        </span>
        <button style={BTN} onClick={() => open("about")}>About</button>
        <button
          style={BTN}
          onClick={() => window.open("https://github.com", "_blank")}
        >
          GitHub
        </button>
        <button style={BTN} onClick={() => toggle("settings")}>Settings</button>
      </div>

      {/* Right */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* FPS counter */}
        <span
          title="Render frames per second"
          style={{
            fontSize: 11,
            fontVariantNumeric: "tabular-nums",
            color: fps >= 50 ? "#34c759" : fps >= 30 ? "#ff9f0a" : "#ff3b30",
            minWidth: 42,
            textAlign: "right",
            letterSpacing: "0.02em",
          }}
        >
          {fps} fps
        </span>

        {/* WS status indicator */}
        <div
          title={STATUS_LABEL[status]}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: STATUS_COLOR[status],
            boxShadow: `0 0 6px ${STATUS_COLOR[status]}`,
            transition: "background 0.3s, box-shadow 0.3s",
          }}
        />

        {/* PiP button — only shown when Document PiP is supported (Chrome 116+) */}
        {pipSupported && (
          <button
            style={{ ...BTN, padding: "0 6px" }}
            title={pipActive ? "Close Picture-in-Picture" : "Camera: Picture-in-Picture"}
            onClick={handlePip}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="3.5" width="14" height="9" rx="1.5"
                stroke={pipActive ? "#0a84ff" : "rgba(255,255,255,0.6)"} strokeWidth="1.3"/>
              <rect x="8.5" y="7" width="5.5" height="4" rx="1"
                fill={pipActive ? "#0a84ff" : "rgba(255,255,255,0.6)"}/>
            </svg>
          </button>
        )}

        {/* Fullscreen */}
        <button
          style={{ ...BTN, fontSize: 11 }}
          title="Toggle fullscreen"
          onClick={handleFullscreen}
        >
          ⛶
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { Panel } from "./Panel";
import { CameraWidget } from "../components/CameraWidget";
import { usePanelState } from "../hooks/usePanelState";
import { usePip } from "../hooks/usePip";

export function CameraPanel() {
  const isOpen = usePanelState((s) => s.panels.camera === "open");

  // Refs forwarded into CameraWidget and shared with usePip for mirroring
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef  = useRef<HTMLVideoElement>(null);

  const pip = usePip(canvasRef, videoRef);

  // Listen for the MenuBar PiP button event
  useEffect(() => {
    const handler = () => pip.open();
    window.addEventListener("onapose:pip-request", handler);
    return () => window.removeEventListener("onapose:pip-request", handler);
  }, [pip.open]);

  return (
    <>
      {/* PiP active backdrop — dims the main window to signal the floating window is open */}
      {pip.active && (
        <div
          onClick={pip.close}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 25,
            background: "rgba(0,0,0,0.55)",
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            animation: "pip-fade-in 0.25s ease",
          }}
        />
      )}
      <style>{`@keyframes pip-fade-in { from { opacity: 0 } to { opacity: 1 } }`}</style>

      <Panel
      id="camera"
      title="Camera"
      defaultX={window.innerWidth - 360}
      defaultY={window.innerHeight - 340}
      defaultW={312}
      defaultH={276}
      pipActive={pip.active}
      onPip={pip.supported ? pip.toggle : undefined}
    >
      <CameraWidget
        active={isOpen}
        canvasRef={canvasRef}
        videoRef={videoRef}
      />
    </Panel>
    </>
  );
}

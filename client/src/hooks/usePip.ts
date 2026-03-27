import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "./useSettings";

/**
 * Document Picture-in-Picture hook — mirror canvas approach.
 *
 * Instead of moving React-managed DOM nodes (which breaks React's reconciler),
 * we open a PiP window and paint a copy of the source canvas into it every
 * animation frame. The original video + canvas stay in React's DOM untouched.
 * MediaPipe keeps running normally against the original elements.
 *
 * sourceCanvasRef — the MediaPipe overlay canvas inside CameraWidget.
 * sourceVideoRef  — the webcam video element inside CameraWidget.
 *
 * Only available in Chrome 116+. Returns `supported: false` on other browsers.
 */
export function usePip(
  sourceCanvasRef: React.RefObject<HTMLCanvasElement | null>,
  sourceVideoRef: React.RefObject<HTMLVideoElement | null>,
) {
  const [active, setActive] = useState(false);
  const pipWindowRef = useRef<Window | null>(null);
  const rafRef = useRef<number | null>(null);
  const cameraPrivacy = useSettings((s) => s.cameraPrivacy);
  // Ref so the paint loop always reads the latest privacy setting
  const privacyRef = useRef(cameraPrivacy);
  useEffect(() => { privacyRef.current = cameraPrivacy; }, [cameraPrivacy]);

  const supported =
    typeof window !== "undefined" && "documentPictureInPicture" in window;

  const stopMirror = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const open = useCallback(async () => {
    if (!supported) return;
    if (pipWindowRef.current) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pip = await (window as any).documentPictureInPicture.requestWindow({
      width: 320,
      height: 240,
      disallowReturnToOpener: false,
    });

    pipWindowRef.current = pip;

    // Minimal styles for the PiP window
    pip.document.body.style.cssText =
      "margin:0;padding:0;background:#000;overflow:hidden;";

    // Create a mirror canvas inside the PiP window
    const mirrorCanvas = pip.document.createElement("canvas");
    mirrorCanvas.width = 640;
    mirrorCanvas.height = 480;
    mirrorCanvas.style.cssText =
      "width:100%;height:100%;display:block;transform:scale(-1,1);transform-origin:center;";
    pip.document.body.appendChild(mirrorCanvas);
    const mirrorCtx = mirrorCanvas.getContext("2d")!;

    // Paint loop — skeleton only (privacy mode) or video + skeleton
    const paint = () => {
      if (!pipWindowRef.current) return;

      mirrorCtx.clearRect(0, 0, 640, 480);

      // Only draw the raw video feed when privacy mode is OFF
      if (!privacyRef.current) {
        const vid = sourceVideoRef.current;
        if (vid && vid.readyState >= 2) {
          mirrorCtx.drawImage(vid, 0, 0, 640, 480);
        }
      }

      // Always draw the skeleton overlay
      const src = sourceCanvasRef.current;
      if (src && src.width > 0 && src.height > 0) {
        mirrorCtx.save();
        mirrorCtx.scale(-1, 1);
        mirrorCtx.drawImage(src, -640, 0, 640, 480);
        mirrorCtx.restore();
      }

      rafRef.current = requestAnimationFrame(paint);
    };

    rafRef.current = requestAnimationFrame(paint);
    setActive(true);

    pip.addEventListener("pagehide", () => {
      stopMirror();
      pipWindowRef.current = null;
      setActive(false);
    });
  }, [supported, sourceCanvasRef, sourceVideoRef, stopMirror]);

  const close = useCallback(() => {
    stopMirror();
    if (pipWindowRef.current) {
      pipWindowRef.current.close();
      pipWindowRef.current = null;
    }
    setActive(false);
  }, [stopMirror]);

  const toggle = useCallback(() => {
    if (active) close();
    else open();
  }, [active, open, close]);

  useEffect(() => {
    return () => {
      stopMirror();
      if (pipWindowRef.current) {
        pipWindowRef.current.close();
        pipWindowRef.current = null;
      }
    };
  }, [stopMirror]);

  return { supported, active, toggle, open, close };
}

import { Camera } from "@mediapipe/camera_utils";
import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";
import {
  FACEMESH_TESSELATION,
  HAND_CONNECTIONS,
  Holistic,
  POSE_CONNECTIONS,
} from "@mediapipe/holistic";
import { useEffect, useRef, useState } from "react";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { useSettings } from "../hooks/useSettings";

interface CameraWidgetProps {
  /** When true the camera feed is active. Controlled externally by the panel. */
  active: boolean;
  /** Forwarded ref to the skeleton overlay canvas — used by usePip to mirror into PiP. */
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /** Forwarded ref to the video element — used by usePip to mirror into PiP. */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}

/**
 * Renders the webcam feed with a MediaPipe skeleton overlay.
 * Stateless with respect to open/closed — the parent panel controls that.
 */
export function CameraWidget({ active, canvasRef, videoRef }: CameraWidgetProps) {
  const [loading, setLoading] = useState(false);
  const internalVideo = useRef<HTMLVideoElement>(null);
  const internalCanvas = useRef<HTMLCanvasElement>(null);
  // Use forwarded refs if provided, otherwise fall back to internal refs
  const videoElement = (videoRef ?? internalVideo) as React.RefObject<HTMLVideoElement>;
  const drawCanvas = (canvasRef ?? internalCanvas) as React.RefObject<HTMLCanvasElement>;
  const setVideoElement = useVideoRecognition((state) => state.setVideoElement);
  const cameraPrivacy = useSettings((s) => s.cameraPrivacy);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drawResults = (results: any) => {
    if (!drawCanvas.current || !videoElement.current) return;
    drawCanvas.current.width = videoElement.current.videoWidth;
    drawCanvas.current.height = videoElement.current.videoHeight;
    const ctx = drawCanvas.current.getContext("2d")!;
    ctx.save();
    ctx.clearRect(0, 0, drawCanvas.current.width, drawCanvas.current.height);
    drawConnectors(ctx, results.poseLandmarks, POSE_CONNECTIONS, { color: "#00cff7", lineWidth: 4 });
    drawLandmarks(ctx, results.poseLandmarks, { color: "#ff0364", lineWidth: 2 });
    drawConnectors(ctx, results.faceLandmarks, FACEMESH_TESSELATION, { color: "#C0C0C070", lineWidth: 1 });
    if (results.faceLandmarks && results.faceLandmarks.length === 478) {
      drawLandmarks(ctx, [results.faceLandmarks[468], results.faceLandmarks[473]], { color: "#ffe603", lineWidth: 2 });
    }
    drawConnectors(ctx, results.leftHandLandmarks, HAND_CONNECTIONS, { color: "#eb1064", lineWidth: 5 });
    drawLandmarks(ctx, results.leftHandLandmarks, { color: "#00cff7", lineWidth: 2 });
    drawConnectors(ctx, results.rightHandLandmarks, HAND_CONNECTIONS, { color: "#22c3e3", lineWidth: 5 });
    drawLandmarks(ctx, results.rightHandLandmarks, { color: "#ff0364", lineWidth: 2 });
    ctx.restore();
  };

  useEffect(() => {
    if (!active) {
      setVideoElement(null);
      setLoading(false);
      return;
    }

    setVideoElement(videoElement.current);
    setLoading(true);

    let destroyed = false;

    const holistic = new Holistic({
      locateFile: (file) => `/mediapipe/holistic/${file}`,
    });

    holistic.setOptions({
      // Complexity 1 (default in XR Animator). One Euro Filter in VRMAvatar
      // compensates for any landmark quality delta vs complexity 2 while saving
      // ~15 ms/frame on mid-range hardware.
      modelComplexity: 1,
      smoothLandmarks: true,
      // 0.5 matches XR Animator — more robust when user enters frame or moves fast.
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
      refineFaceLandmarks: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    holistic.onResults((results: any) => {
      if (destroyed) return;
      setLoading(false);
      drawResults(results);
      useVideoRecognition.getState().resultsCallback?.(results);
    });

    const camera = new Camera(videoElement.current!, {
      onFrame: async () => {
        if (destroyed || !videoElement.current) return;
        await holistic.send({ image: videoElement.current });
      },
      width: 640,
      height: 480,
    });

    camera.start();

    return () => {
      destroyed = true;
      camera.stop();
      // Defer close to prevent WASM destructor crash if the module is busy predicting
      // (very common in React 18 Strict Mode double-mounts).
      setTimeout(() => {
        try { holistic.close(); } catch (e) { console.warn("holistic.close error:", e); }
      }, 500);
      setVideoElement(null);
      setLoading(false);
    };
  }, [active, setVideoElement]);

  return (
    <div
      style={{ position: "relative", width: "100%", aspectRatio: "4/3", borderRadius: 8, overflow: "hidden", background: "#000" }}
    >
      {loading && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 20,
          background: "rgba(0,0,0,0.75)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10,
          fontFamily: "monospace", color: "#aaa", fontSize: 11,
        }}>
          <span>loading mediapipe models...</span>
          <div style={{ width: "70%", height: 3, background: "#333", borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%", width: "40%", background: "#00cff7", borderRadius: 2,
              animation: "mp-loading 1.4s ease-in-out infinite",
            }} />
          </div>
          <style>{`@keyframes mp-loading { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }`}</style>
        </div>
      )}
      <canvas ref={drawCanvas} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", transform: "scale(-1,1)", zIndex: 10 }} />
      {/* Video is always mounted so MediaPipe can read frames — visibility is controlled by privacy mode */}
      <video
        ref={videoElement}
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          transform: "scale(-1,1)",
          opacity: cameraPrivacy ? 0 : 1,
        }}
        playsInline
        muted
      />
    </div>
  );
}

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

/**
 * Renders the webcam feed with a MediaPipe skeleton overlay.
 * Matches the reference implementation (r3f-vrm-final/CameraWidget.jsx) exactly:
 * - setVideoElement is called before holistic setup
 * - resultsCallback is read via getState() to avoid subscribing to per-frame updates
 * - CDN version is pinned to 0.5.1635989137 (WASM files must exist at this path)
 */
export function CameraWidget() {
  const [start, setStart] = useState(false);
  const [loading, setLoading] = useState(false);
  const videoElement = useRef<HTMLVideoElement>(null);
  const drawCanvas = useRef<HTMLCanvasElement>(null);
  const setVideoElement = useVideoRecognition((state) => state.setVideoElement);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drawResults = (results: any) => {
    if (!drawCanvas.current || !videoElement.current) return;
    drawCanvas.current.width = videoElement.current.videoWidth;
    drawCanvas.current.height = videoElement.current.videoHeight;
    const canvasCtx = drawCanvas.current.getContext("2d")!;
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, drawCanvas.current.width, drawCanvas.current.height);

    drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, {
      color: "#00cff7", lineWidth: 4,
    });
    drawLandmarks(canvasCtx, results.poseLandmarks, {
      color: "#ff0364", lineWidth: 2,
    });
    drawConnectors(canvasCtx, results.faceLandmarks, FACEMESH_TESSELATION, {
      color: "#C0C0C070", lineWidth: 1,
    });
    if (results.faceLandmarks && results.faceLandmarks.length === 478) {
      drawLandmarks(
        canvasCtx,
        [results.faceLandmarks[468], results.faceLandmarks[468 + 5]],
        { color: "#ffe603", lineWidth: 2 }
      );
    }
    drawConnectors(canvasCtx, results.leftHandLandmarks, HAND_CONNECTIONS, {
      color: "#eb1064", lineWidth: 5,
    });
    drawLandmarks(canvasCtx, results.leftHandLandmarks, {
      color: "#00cff7", lineWidth: 2,
    });
    drawConnectors(canvasCtx, results.rightHandLandmarks, HAND_CONNECTIONS, {
      color: "#22c3e3", lineWidth: 5,
    });
    drawLandmarks(canvasCtx, results.rightHandLandmarks, {
      color: "#ff0364", lineWidth: 2,
    });

    canvasCtx.restore();
  };

  useEffect(() => {
    if (!start) {
      setVideoElement(null);
      return;
    }

    // Set video element in store before holistic setup
    setVideoElement(videoElement.current);
    setLoading(true);

    const holistic = new Holistic({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1635989137/${file}`,
    });

    holistic.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.7,
      refineFaceLandmarks: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    holistic.onResults((results: any) => {
      setLoading(false);
      drawResults(results);
      // getState() used here intentionally — avoids subscribing to per-frame updates
      useVideoRecognition.getState().resultsCallback?.(results);
    });

    const camera = new Camera(videoElement.current!, {
      onFrame: async () => {
        await holistic.send({ image: videoElement.current! });
      },
      width: 640,
      height: 480,
    });

    camera.start();

    return () => {
      camera.stop();
      holistic.close();
      setVideoElement(null);
      setLoading(false);
    };
  }, [start, setVideoElement]);

  return (
    <>
      <button
        onClick={() => setStart((prev) => !prev)}
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          zIndex: 20,
          padding: "12px 20px",
          background: start ? "#c0392b" : "#2c2c2c",
          color: "#fff",
          border: "1px solid #444",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 13,
          fontFamily: "monospace",
        }}
      >
        {start ? "stop camera" : "start camera"}
      </button>

      <div
        style={{
          position: "fixed",
          bottom: 64,
          right: 16,
          width: 320,
          height: 240,
          borderRadius: 12,
          overflow: "hidden",
          display: start ? "block" : "none",
          zIndex: 10,
        }}
      >
        {loading && (
          <div style={{
            position: "absolute",
            inset: 0,
            zIndex: 20,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            fontFamily: "monospace",
            color: "#aaa",
            fontSize: 12,
          }}>
            <span>loading mediapipe models...</span>
            <div style={{
              width: "70%",
              height: 3,
              background: "#333",
              borderRadius: 2,
              overflow: "hidden",
            }}>
              <div style={{
                height: "100%",
                width: "40%",
                background: "#00cff7",
                borderRadius: 2,
                animation: "mp-loading 1.4s ease-in-out infinite",
              }} />
            </div>
            <style>{`
              @keyframes mp-loading {
                0%   { transform: translateX(-100%); }
                100% { transform: translateX(350%); }
              }
            `}</style>
          </div>
        )}
        <canvas
          ref={drawCanvas}
          style={{
            position: "absolute",
            zIndex: 10,
            width: "100%",
            height: "100%",
            top: 0,
            left: 0,
            transform: "scale(-1, 1)",
          }}
        />
        <video
          ref={videoElement}
          style={{
            position: "absolute",
            zIndex: 0,
            width: "100%",
            height: "100%",
            top: 0,
            left: 0,
            transform: "scale(-1, 1)",
          }}
          playsInline
          muted
        />
      </div>
    </>
  );
}

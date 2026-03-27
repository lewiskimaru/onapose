import { create } from "zustand";

/**
 * Zustand store bridging CameraWidget and VRMAvatar.
 *
 * Per-frame landmark data is NOT stored here — that would trigger
 * React re-renders at 60fps. Instead, a callback function is stored
 * once and called directly by CameraWidget with each MediaPipe result.
 */
interface VideoRecognitionStore {
  videoElement: HTMLVideoElement | null;
  setVideoElement: (el: HTMLVideoElement | null) => void;
  resultsCallback: ((results: unknown) => void) | null;
  setResultsCallback: (cb: ((results: unknown) => void) | null) => void;
}

export const useVideoRecognition = create<VideoRecognitionStore>((set) => ({
  videoElement: null,
  setVideoElement: (videoElement) => set({ videoElement }),
  resultsCallback: null,
  setResultsCallback: (resultsCallback) => set({ resultsCallback }),
}));

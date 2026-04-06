import { create } from "zustand";
import { persist } from "zustand/middleware";

export type WallpaperOption =
  | "galaxy"
  | "nebula"
  | "void"
  | "futuristic_room"
  | "sci-fi_room_or_industrial_space";

export const WALLPAPERS: { id: WallpaperOption; label: string; glb?: string }[] = [
  { id: "galaxy",                          label: "Galaxy"                  },
  { id: "nebula",                          label: "Nebula"                  },
  { id: "void",                            label: "Void"                    },
  { id: "futuristic_room",                 label: "Futuristic Room",         glb: "wallpaper/futuristic_room.glb" },
  { id: "sci-fi_room_or_industrial_space", label: "Sci-Fi Industrial Space", glb: "wallpaper/sci-fi_room_or_industrial_space.glb" },
];

/** Pose solver backend */
export type SolverMode = "kalidokit" | "custom";

export const SOLVER_OPTIONS: { id: SolverMode; label: string; description: string }[] = [
  {
    id: "custom",
    label: "Custom (XR Animator)",
    description: "Gimbal-free setFromUnitVectors arm solver, YZX wrist roll, full 3D finger solving",
  },
  {
    id: "kalidokit",
    label: "Kalidokit (fallback)",
    description: "Original Kalidokit solver with One Euro Filter + palm-normal wrist roll",
  },
];

interface SettingsState {
  /** When true, the raw camera feed is hidden — only the skeleton overlay is shown. Default on for privacy. */
  cameraPrivacy: boolean;
  setCameraPrivacy: (v: boolean) => void;

  /** Active wallpaper selection. Persisted across sessions. */
  wallpaper: WallpaperOption;
  setWallpaper: (v: WallpaperOption) => void;

  /**
   * Pose solver backend.
   * "custom"    = XR Animator-style (gimbal-free, YZX wrist roll, 3D fingers).
   * "kalidokit" = original fallback with OEF + palm-normal roll.
   * Defaults to "custom" in dev mode — switch to "kalidokit" if you hit issues.
   */
  solver: SolverMode;
  setSolver: (v: SolverMode) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      cameraPrivacy: true,
      setCameraPrivacy: (v) => set({ cameraPrivacy: v }),

      wallpaper: "nebula",
      setWallpaper: (v) => set({ wallpaper: v }),

      // Default to "custom" in dev mode so new changes take effect immediately.
      // End-users can fall back to "kalidokit" if behaviour is unexpected.
      solver: "custom",
      setSolver: (v) => set({ solver: v }),
    }),
    { name: "onapose-settings" }
  )
);

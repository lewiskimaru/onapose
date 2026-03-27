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

interface SettingsState {
  /** When true, the raw camera feed is hidden — only the skeleton overlay is shown. Default on for privacy. */
  cameraPrivacy: boolean;
  setCameraPrivacy: (v: boolean) => void;

  /** Active wallpaper selection. Persisted across sessions. */
  wallpaper: WallpaperOption;
  setWallpaper: (v: WallpaperOption) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      cameraPrivacy: true,
      setCameraPrivacy: (v) => set({ cameraPrivacy: v }),

      wallpaper: "nebula",
      setWallpaper: (v) => set({ wallpaper: v }),
    }),
    { name: "onapose-settings" }
  )
);

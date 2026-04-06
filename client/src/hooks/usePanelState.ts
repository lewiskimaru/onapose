import { create } from "zustand";

export type PanelId = "camera" | "settings" | "docs" | "about" | "terminal" | "debug";
export type PanelStatus = "open" | "closed" | "minimized";

interface PanelState {
  panels: Record<PanelId, PanelStatus>;
  toggle: (id: PanelId) => void;
  open: (id: PanelId) => void;
  close: (id: PanelId) => void;
  minimize: (id: PanelId) => void;
}

export const usePanelState = create<PanelState>((set) => ({
  panels: {
    camera: "closed",
    settings: "closed",
    docs: "closed",
    about: "closed",
    terminal: "closed",
    debug: "closed",
  },
  toggle: (id) =>
    set((s) => ({
      panels: {
        ...s.panels,
        [id]: s.panels[id] === "open" ? "closed" : "open",
      },
    })),
  open: (id) =>
    set((s) => ({ panels: { ...s.panels, [id]: "open" } })),
  close: (id) =>
    set((s) => ({ panels: { ...s.panels, [id]: "closed" } })),
  minimize: (id) =>
    set((s) => ({ panels: { ...s.panels, [id]: "minimized" } })),
}));

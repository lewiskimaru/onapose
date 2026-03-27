import { create } from "zustand";

export type WsStatus = "connected" | "connecting" | "disconnected";

interface WsStatusStore {
  status: WsStatus;
  setStatus: (s: WsStatus) => void;
}

export const useWsStatus = create<WsStatusStore>((set) => ({
  status: "disconnected",
  setStatus: (status) => set({ status }),
}));

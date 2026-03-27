import { useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import type { MocapFrame } from "@onapose/shared";
import { useWsStatus } from "./useWsStatus";

const BRIDGE_URL = import.meta.env.VITE_WS_URL ?? "http://localhost:8080";

export function useWebSocket() {
  const socketRef = useRef<Socket | null>(null);
  const setStatus = useWsStatus((s) => s.setStatus);

  useEffect(() => {
    let active = true;
    setStatus("connecting");

    const socket = io(BRIDGE_URL, {
      transports: ["websocket"],
      reconnectionDelay: 3000,
    });

    socket.on("connect", () => {
      if (active) {
        console.log("[ws] connected to bridge at", BRIDGE_URL);
        setStatus("connected");
      }
    });

    socket.on("disconnect", (reason) => {
      if (active) {
        console.log("[ws] disconnected from bridge:", reason);
        setStatus("disconnected");
      }
    });

    socket.on("connect_error", () => {
      if (active) setStatus("disconnected");
    });

    socketRef.current = socket;

    return () => {
      active = false;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [setStatus]);

  const send = useCallback((frame: MocapFrame) => {
    socketRef.current?.emit("mocap_frame", frame);
  }, []);

  return { send };
}

import { useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import type { MocapFrame } from "@onapose/shared";

const BRIDGE_URL = import.meta.env.VITE_WS_URL ?? "http://localhost:8080";

/**
 * Manages the socket.io connection to the NestJS bridge.
 * Returns a stable `send` function that emits a MocapFrame.
 * socket.io handles reconnection automatically.
 *
 * The `active` flag prevents the StrictMode double-invoke from logging
 * a spurious disconnect when the first effect instance is torn down
 * before the socket has connected.
 */
export function useWebSocket() {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    let active = true;

    const socket = io(BRIDGE_URL, {
      transports: ["websocket"],
      reconnectionDelay: 3000,
    });

    socket.on("connect", () => {
      if (active) console.log("[ws] connected to bridge at", BRIDGE_URL);
    });

    socket.on("disconnect", (reason) => {
      if (active) console.log("[ws] disconnected from bridge:", reason);
    });

    socket.on("connect_error", (err) => {
      if (active) console.warn("[ws] connection error:", err.message);
    });

    socketRef.current = socket;

    return () => {
      active = false;
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const send = useCallback((frame: MocapFrame) => {
    socketRef.current?.emit("mocap_frame", frame);
  }, []);

  return { send };
}

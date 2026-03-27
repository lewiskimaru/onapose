import { useEffect, useRef, useState } from "react";

/**
 * Returns a live FPS value sampled every `intervalMs` milliseconds.
 * Uses requestAnimationFrame — measures actual render frame rate.
 */
export function useFps(intervalMs = 500): number {
  const [fps, setFps] = useState(0);
  const frames = useRef(0);
  const last = useRef(performance.now());

  useEffect(() => {
    let raf: number;

    const tick = () => {
      frames.current++;
      const now = performance.now();
      const elapsed = now - last.current;
      if (elapsed >= intervalMs) {
        setFps(Math.round((frames.current * 1000) / elapsed));
        frames.current = 0;
        last.current = now;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [intervalMs]);

  return fps;
}

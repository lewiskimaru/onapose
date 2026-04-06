/**
 * useDebugStore — centralised per-frame diagnostic data store.
 *
 * VRMAvatar writes to this store at a throttled rate (~5 Hz).
 * DebugPanel reads from it to display live values without flooding React renders.
 *
 * This store is NOT persisted — all data resets on page reload.
 */

import { create } from "zustand";

export interface Vec3 { x: number; y: number; z: number; }
export interface Vec4 { x: number; y: number; z: number; w: number; }

export interface LandmarkSnapshot {
  leftShoulder:  Vec3;
  rightShoulder: Vec3;
  leftElbow:     Vec3;
  rightElbow:    Vec3;
  leftWrist:     Vec3;
  rightWrist:    Vec3;
  leftHip:       Vec3;
  rightHip:      Vec3;
}

export interface SolverSnapshot {
  solver:        string;
  hipsQ:         Vec4;
  spineQ:        Vec4;
  leftUpperArmQ: Vec4;
  leftLowerArmQ: Vec4;
  rightUpperArmQ:Vec4;
  rightLowerArmQ:Vec4;
  bodyYaw:       number;   // radians
  leftRoll:      number;   // radians (palm roll)
  rightRoll:     number;
}

export interface FilterSnapshot {
  poseLmRaw:    Vec3;  // shoulder landmark before filter
  poseLmFilt:   Vec3;  // shoulder landmark after filter
}

export interface HeadSnapshot {
  kalidokitEuler: Vec3;  // what Face.solve() gives for head
  neckBoneQ:      Vec4;  // what actually gets written to the bone
}

export interface DebugFrame {
  ts:          number;
  landmarks:   LandmarkSnapshot | null;
  solver:      SolverSnapshot   | null;
  filter:      FilterSnapshot   | null;
  head:        HeadSnapshot     | null;
  errors:      string[];
}

interface DebugState {
  /** Current frame's diagnostic data */
  frame:        DebugFrame;
  setFrame:     (f: DebugFrame) => void;

  /** Arbitrary log lines (capped at 200) */
  logs:         string[];
  pushLog:      (msg: string) => void;
  clearLogs:    () => void;
}

const emptyFrame = (): DebugFrame => ({
  ts: 0,
  landmarks: null,
  solver: null,
  filter: null,
  head: null,
  errors: [],
});

export const useDebugStore = create<DebugState>()((set, get) => ({
  frame:    emptyFrame(),
  setFrame: (f) => set({ frame: f }),

  logs:     [],
  pushLog:  (msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] ${msg}`;
    // Keep last 200 lines
    set((s) => ({ logs: [...s.logs.slice(-199), line] }));
    // Also echo to browser console for easy copying
    console.log("[onapose-debug]", msg);
  },
  clearLogs: () => set({ logs: [] }),
}));

// ─── Throttle helper ──────────────────────────────────────────────────────────

/** Returns true every `intervalMs` ms. Use inside tight loops to avoid flooding. */
export function throttle(lastRef: { value: number }, intervalMs: number): boolean {
  const now = performance.now();
  if (now - lastRef.value >= intervalMs) {
    lastRef.value = now;
    return true;
  }
  return false;
}

// ─── Radians→degrees helper for readability in logs ──────────────────────────
export const r2d = (r: number) => (r * 180 / Math.PI).toFixed(1) + "°";

// ─── Quaternion to abbreviated string ────────────────────────────────────────
export const fmtQ = (q: { x: number; y: number; z: number; w: number }) =>
  `(${q.x.toFixed(3)}, ${q.y.toFixed(3)}, ${q.z.toFixed(3)}, ${q.w.toFixed(3)})`;

export const fmtV = (v: { x: number; y: number; z: number }) =>
  `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;

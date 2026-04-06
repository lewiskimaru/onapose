import { create } from "zustand";
import type { MocapFrame } from "@onapose/shared";

export interface FrameStats {
  fps: number;
  frameCount: number;
  lastFrameAt: number | null;
  avgLatencyMs: number;
  bonesActive: number;
  blendShapesActive: number;
}

export interface OscLogEntry {
  id: number;
  ts: number;
  address: string;
  summary: string;
}

interface TelemetryState {
  stats: FrameStats;
  oscLog: OscLogEntry[];
  /** The last raw MocapFrame received — kept for snapshot copy */
  lastFrame: MocapFrame | null;
  /** Call this every time a MocapFrame is sent to the bridge */
  recordFrame: (frame: MocapFrame) => void;
  clearLog: () => void;
  /** Returns a formatted string snapshot of current state for clipboard */
  buildSnapshot: (format: "health" | "osc" | "vmc") => string;
}

let _logId = 0;
const MAX_LOG = 80;

// Rolling FPS calculation
let _frameCount = 0;
let _windowStart = performance.now();
let _latencyBucket: number[] = [];

export const useBridgeTelemetry = create<TelemetryState>((set, get) => ({
  stats: {
    fps: 0,
    frameCount: 0,
    lastFrameAt: null,
    avgLatencyMs: 0,
    bonesActive: 0,
    blendShapesActive: 0,
  },
  oscLog: [],
  lastFrame: null,

  recordFrame: (frame) => {
    const now = performance.now();
    const latency = now - frame.timestamp;

    _frameCount++;
    _latencyBucket.push(latency);
    if (_latencyBucket.length > 30) _latencyBucket.shift();

    const elapsed = now - _windowStart;
    let fps = 0;
    if (elapsed >= 500) {
      fps = Math.round((_frameCount * 1000) / elapsed);
      _frameCount = 0;
      _windowStart = now;
    }

    // Count active bones (non-zero rotations)
    const pose = frame.riggedPose;
    const bonesActive = [
      pose.Spine, pose.Chest, pose.LeftUpperArm, pose.LeftLowerArm,
      pose.RightUpperArm, pose.RightLowerArm, pose.LeftUpperLeg,
      pose.LeftLowerLeg, pose.RightUpperLeg, pose.RightLowerLeg,
    ].filter((b) => b && (Math.abs(b.x) + Math.abs(b.y) + Math.abs(b.z)) > 0.001).length;

    const s = frame.riggedFace.mouth.shape;
    const blendShapesActive = [s.A, s.E, s.I, s.O, s.U,
      1 - frame.riggedFace.eye.l, 1 - frame.riggedFace.eye.r,
    ].filter((v) => v > 0.05).length;

    // Build OSC log entries for this frame (sample — not every message, just key ones)
    const entries: OscLogEntry[] = [
      {
        id: _logId++, ts: now,
        address: "/VMC/Ext/Root/Pos",
        summary: `Hips  x:${pose.Hips.position.x.toFixed(3)} y:${pose.Hips.position.y.toFixed(3)} z:${(-pose.Hips.position.z).toFixed(3)}`,
      },
      // Log all body bones so the VMC tab can highlight them correctly
      ...(
        [
          ["Spine",        pose.Spine],
          ["Chest",        pose.Chest],
          ["LeftUpperArm", pose.LeftUpperArm],
          ["LeftLowerArm", pose.LeftLowerArm],
          ["RightUpperArm",pose.RightUpperArm],
          ["RightLowerArm",pose.RightLowerArm],
          ["LeftUpperLeg", pose.LeftUpperLeg],
          ["LeftLowerLeg", pose.LeftLowerLeg],
          ["RightUpperLeg",pose.RightUpperLeg],
          ["RightLowerLeg",pose.RightLowerLeg],
          ["Neck",         (frame.riggedFace as any)?.head],
        ] as [string, { x: number; y: number; z: number } | undefined][]
      )
        .filter(([, r]) => r != null)
        .map(([name, r]) => ({
          id: _logId++, ts: now,
          address: "/VMC/Ext/Bone/Pos",
          summary: `${name}  x:${r!.x.toFixed(3)} y:${r!.y.toFixed(3)} z:${r!.z.toFixed(3)}`,
        }))
      ,
      {
        id: _logId++, ts: now,
        address: "/VMC/Ext/Blend/Val",
        summary: `aa:${s.A.toFixed(2)}  ih:${s.I.toFixed(2)}  ee:${s.E.toFixed(2)}  oh:${s.O.toFixed(2)}  ou:${s.U.toFixed(2)}`,
      },
    ];

    set((state) => ({
      stats: {
        fps: fps > 0 ? fps : state.stats.fps,
        frameCount: state.stats.frameCount + 1,
        lastFrameAt: now,
        avgLatencyMs: Math.round(_latencyBucket.reduce((a, b) => a + b, 0) / _latencyBucket.length),
        bonesActive,
        blendShapesActive,
      },
      lastFrame: frame,
      oscLog: [...entries, ...state.oscLog].slice(0, MAX_LOG),
    }));
  },

  clearLog: () => set({ oscLog: [] }),

  buildSnapshot: (format) => {
    const { stats, oscLog, lastFrame } = get();
    const ts = new Date().toISOString();

    if (format === "health") {
      return [
        `# OnaPose — Health Snapshot`,
        `# Generated: ${ts}`,
        ``,
        `bridge_url:       ${import.meta.env.VITE_WS_URL ?? "http://localhost:8080"}`,
        `frame_rate:       ${stats.fps} fps`,
        `total_frames:     ${stats.frameCount}`,
        `avg_latency_ms:   ${stats.avgLatencyMs}`,
        `bones_active:     ${stats.bonesActive} / 12`,
        `blendshapes:      ${stats.blendShapesActive} / 7`,
        `last_frame_at:    ${stats.lastFrameAt ? new Date(stats.lastFrameAt).toISOString() : "never"}`,
      ].join("\n");
    }

    if (format === "osc") {
      const lines = oscLog.map((e) => {
        const time = new Date(e.ts).toLocaleTimeString("en", { hour12: false });
        return `${time}  ${e.address.padEnd(24)}  ${e.summary}`;
      });
      return [
        `# OnaPose — OSC Log Snapshot`,
        `# Generated: ${ts}`,
        `# Target: ${import.meta.env.VITE_OSC_TARGET_HOST ?? "127.0.0.1"}:${import.meta.env.VITE_OSC_TARGET_PORT ?? "39539"}`,
        `# Protocol: VMC / OSC over UDP`,
        ``,
        ...lines,
      ].join("\n");
    }

    // vmc — full last frame as JSON, most useful for debugging
    if (format === "vmc") {
      if (!lastFrame) return "# No frame data captured yet.";
      return [
        `# OnaPose — VMC Frame Snapshot`,
        `# Generated: ${ts}`,
        `# This is the last MocapFrame sent to the bridge, in raw JSON.`,
        `# Euler angles are in radians. Hips.position is in meters (hip-relative).`,
        ``,
        JSON.stringify(lastFrame, null, 2),
      ].join("\n");
    }

    return "";
  },
}));

import { Panel } from "./Panel";
import { useWsStatus } from "../hooks/useWsStatus";
import { useSettings, WALLPAPERS, SOLVER_OPTIONS } from "../hooks/useSettings";
import { usePanelState } from "../hooks/usePanelState";

const MODELS = [
  "default.vrm",
  "onapose-model1.vrm",
  "262410318834873893.vrm",
  "3636451243928341470.vrm",
  "3859814441197244330.vrm",
  "8087383217573817818.vrm",
];

interface SettingsPanelProps {
  avatar: string;
  onAvatarChange: (v: string) => void;
}

// ─── Style tokens ─────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: "#1c1c1e",
  borderRadius: 8,
  padding: "12px 14px",
  marginBottom: 8,
};

const innerCard: React.CSSProperties = {
  background: "#2c2c2e",
  borderRadius: 6,
  padding: "8px 12px",
  marginTop: 8,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "rgba(255,255,255,0.35)",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  marginBottom: 8,
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  background: "#3a3a3c",
  border: "none",
  borderRadius: 6,
  color: "rgba(255,255,255,0.85)",
  fontSize: 13,
  padding: "6px 10px",
  cursor: "pointer",
  fontFamily: "'Urbanist', -apple-system, sans-serif",
  outline: "none",
};

const infoRow = (label: string, value: string) => (
  <div key={label} style={{ ...innerCard, marginTop: 4 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.65)", textAlign: "right" }}>{value}</span>
    </div>
  </div>
);

// ─── Toggle component ─────────────────────────────────────────────────────────

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={{
        width: 44, height: 26, borderRadius: 13, border: "none", cursor: "pointer",
        background: on ? "#30d158" : "#3a3a3c",
        position: "relative", transition: "background 0.2s",
        flexShrink: 0,
      }}
    >
      <div style={{
        position: "absolute", top: 3,
        left: on ? 21 : 3,
        width: 20, height: 20, borderRadius: "50%",
        background: "#fff",
        transition: "left 0.2s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
      }} />
    </button>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SettingsPanel({ avatar, onAvatarChange }: SettingsPanelProps) {
  const status = useWsStatus((s) => s.status);
  const statusColor = { connected: "#34c759", connecting: "#ff9f0a", disconnected: "#ff3b30" }[status];
  const { cameraPrivacy, setCameraPrivacy, wallpaper, setWallpaper, solver, setSolver } = useSettings();
  
  const { panels, open, close } = usePanelState();
  const debugVisible = panels.debug === "open";
  const setDebugVisible = (v: boolean) => v ? open("debug") : close("debug");

  const activeSolver = SOLVER_OPTIONS.find((s) => s.id === solver);

  return (
    <Panel id="settings" title="Settings" defaultX={window.innerWidth - 360} defaultY={80} defaultW={312} defaultH={600}>

      {/* ── Wallpaper ────────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={sectionLabel}>Wallpaper</div>
        <select
          style={selectStyle}
          value={wallpaper}
          onChange={(e) => setWallpaper(e.target.value as typeof wallpaper)}
        >
          {WALLPAPERS.map((w) => (
            <option key={w.id} value={w.id}>{w.label}</option>
          ))}
        </select>
      </div>

      {/* ── Avatar ───────────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={sectionLabel}>Avatar</div>
        <select style={selectStyle} value={avatar} onChange={(e) => onAvatarChange(e.target.value)}>
          {MODELS.map((m) => (
            <option key={m} value={m}>{m.replace(".vrm", "")}</option>
          ))}
        </select>
      </div>

      {/* ── Pose Solver ──────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={sectionLabel}>Pose Solver</div>
        <select
          style={selectStyle}
          value={solver}
          onChange={(e) => setSolver(e.target.value as typeof solver)}
        >
          {SOLVER_OPTIONS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        {activeSolver && (
          <div style={{ ...innerCard, marginTop: 8 }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", lineHeight: 1.5 }}>
              {activeSolver.description}
            </div>
          </div>
        )}
        {/* Show warning badge when using custom solver (still in development) */}
        {solver === "custom" && (
          <div style={{
            ...innerCard, marginTop: 4,
            background: "rgba(255,159,10,0.12)",
            border: "1px solid rgba(255,159,10,0.25)",
          }}>
            <div style={{ fontSize: 11, color: "#ff9f0a" }}>
              ⚠ Custom solver — dev mode. Switch to Kalidokit if tracking behaves unexpectedly.
            </div>
          </div>
        )}
      </div>

      {/* ── Camera ───────────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={sectionLabel}>Camera</div>
        <div style={innerCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.85)" }}>Privacy mode</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                {cameraPrivacy ? "Skeleton only — feed hidden" : "Raw feed visible"}
              </div>
            </div>
            <Toggle on={cameraPrivacy} onChange={setCameraPrivacy} />
          </div>
        </div>
      </div>

      {/* ── Developer ────────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={sectionLabel}>Developer</div>
        <div style={innerCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.85)" }}>Debug overlay</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                {debugVisible ? "Live solver diagnostics visible" : "Hidden"}
              </div>
            </div>
            <Toggle on={debugVisible} onChange={setDebugVisible} />
          </div>
        </div>
      </div>

      {/* ── MediaPipe info (updated to reflect current config) ───────────────── */}
      <div style={card}>
        <div style={sectionLabel}>MediaPipe</div>
        {[
          { label: "Package",           value: "@mediapipe/holistic 0.5" },
          { label: "Complexity",        value: "1 — Balanced (OEF compensates)" },
          { label: "Detection conf.",   value: "0.5" },
          { label: "Tracking conf.",    value: "0.5" },
          { label: "Smooth landmarks",  value: "Enabled (MediaPipe)" },
          { label: "OEF on landmarks",  value: "Enabled (β=0.5 pose, β=0.001 hands)" },
          { label: "Refine face",       value: "Enabled (iris tracking)" },
          { label: "Source",            value: "Local — /mediapipe/holistic/" },
        ].map(({ label, value }) => infoRow(label, value))}
      </div>

      {/* ── Bridge ───────────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={sectionLabel}>Bridge</div>
        <div style={innerCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>Status</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor }} />
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", textTransform: "capitalize" }}>{status}</span>
            </div>
          </div>
        </div>
        <div style={{ ...innerCard, marginTop: 4 }}>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>WebSocket</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginTop: 2, wordBreak: "break-all" }}>
            {import.meta.env.VITE_WS_URL ?? "http://localhost:8080"}
          </div>
        </div>
      </div>

    </Panel>
  );
}

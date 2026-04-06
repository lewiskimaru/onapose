import { useDebugStore, r2d, fmtQ, fmtV } from "../hooks/useDebugStore";
import { Panel } from "./Panel";

// ─── Style tokens ─────────────────────────────────────────────────────────────
const mono: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
};
const section: React.CSSProperties = {
  background: "#1c1c1e",
  borderRadius: 8,
  padding: "10px 12px",
  marginBottom: 6,
};
const sectionTitle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: "rgba(255,255,255,0.3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  marginBottom: 6,
};
const row: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 3,
  gap: 8,
};
const label: React.CSSProperties = {
  color: "rgba(255,255,255,0.4)",
  ...mono,
  flexShrink: 0,
};
const value: React.CSSProperties = {
  color: "rgba(255,255,255,0.85)",
  ...mono,
  textAlign: "right",
  wordBreak: "break-all",
};

function Row({ k, v, highlight }: { k: string; v: string; highlight?: boolean }) {
  return (
    <div style={row}>
      <span style={label}>{k}</span>
      <span style={{ ...value, color: highlight ? "#ff9f0a" : "rgba(255,255,255,0.85)" }}>{v}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={section}>
      <div style={sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
import { useState } from "react";

export function DebugPanel() {
  const { frame, logs, clearLogs } = useDebugStore();
  const [copied, setCopied] = useState(false);

  const { landmarks, solver, filter, head, errors, ts } = frame;
  const age = ts ? `${((performance.now() - ts) / 1000).toFixed(2)}s ago` : "no data";

  const handleCopy = () => {
    const data = JSON.stringify({ frame, logs: logs.slice(-20) }, null, 2);
    navigator.clipboard.writeText(data).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Panel
      id="debug"
      title="🔬 Solver Debug"
      defaultX={20}
      defaultY={80}
      defaultW={360}
      defaultH={700}
    >
      {/* ── Freshness indicator ─────────────────────────────────────────────── */}
      <Section title="Frame">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>Update: {age}</span>
          <button
            onClick={handleCopy}
            style={{
              background: copied ? "#30d158" : "#3a3a3c",
              border: "none", borderRadius: 4, color: copied ? "#000" : "rgba(255,255,255,0.85)",
              fontSize: 10, padding: "4px 8px", cursor: "pointer", transition: "all 0.2s"
            }}
          >
            {copied ? "Copied!" : "Copy Debug State"}
          </button>
        </div>
      </Section>

      {/* ── Errors ─────────────────────────────────────────────────────────── */}
      {errors.length > 0 && (
        <Section title={`⚠ Errors (${errors.length})`}>
          {errors.map((e, i) => (
            <div key={i} style={{ ...mono, fontSize: 10, color: "#ff453a", marginBottom: 2 }}>{e}</div>
          ))}
        </Section>
      )}

      {/* ── World landmarks ────────────────────────────────────────────────── */}
      {landmarks && (
        <Section title="World Landmarks (za)">
          <Row k="L.shoulder [11]" v={fmtV(landmarks.leftShoulder)} />
          <Row k="R.shoulder [12]" v={fmtV(landmarks.rightShoulder)} />
          <Row k="L.elbow [13]"    v={fmtV(landmarks.leftElbow)} />
          <Row k="R.elbow [14]"    v={fmtV(landmarks.rightElbow)} />
          <Row k="L.wrist [15]"    v={fmtV(landmarks.leftWrist)} />
          <Row k="R.wrist [16]"    v={fmtV(landmarks.rightWrist)} />
          <Row k="L.hip [23]"      v={fmtV(landmarks.leftHip)} />
          <Row k="R.hip [24]"      v={fmtV(landmarks.rightHip)} />
        </Section>
      )}

      {/* ── Solver output ──────────────────────────────────────────────────── */}
      {solver && (
        <Section title={`Solver: ${solver.solver}`}>
          <Row k="Body yaw"       v={r2d(solver.bodyYaw)} />
          <Row k="Hips Q"         v={fmtQ(solver.hipsQ)} />
          <Row k="Spine Q"        v={fmtQ(solver.spineQ)} />
          <Row k="L.UpperArm Q"   v={fmtQ(solver.leftUpperArmQ)} />
          <Row k="L.LowerArm Q"   v={fmtQ(solver.leftLowerArmQ)} />
          <Row k="R.UpperArm Q"   v={fmtQ(solver.rightUpperArmQ)} />
          <Row k="R.LowerArm Q"   v={fmtQ(solver.rightLowerArmQ)} />
          <Row k="L.palm roll"    v={r2d(solver.leftRoll)} />
          <Row k="R.palm roll"    v={r2d(solver.rightRoll)} />
        </Section>
      )}

      {/* ── OEF filter delta ───────────────────────────────────────────────── */}
      {filter && (
        <Section title="OEF Filter (shoulder lm 11)">
          <Row k="Raw"      v={fmtV(filter.poseLmRaw)} />
          <Row k="Filtered" v={fmtV(filter.poseLmFilt)} />
          <Row k="Delta X"  v={(filter.poseLmFilt.x - filter.poseLmRaw.x).toFixed(4)} />
          <Row k="Delta Y"  v={(filter.poseLmFilt.y - filter.poseLmRaw.y).toFixed(4)} />
          <Row k="Delta Z"  v={(filter.poseLmFilt.z - filter.poseLmRaw.z).toFixed(4)} />
        </Section>
      )}

      {/* ── Head / neck ────────────────────────────────────────────────────── */}
      {head && (
        <Section title="Head / Neck">
          <Row k="Face.head euler" v={fmtV(head.kalidokitEuler)} />
          <Row k="Neck bone Q"     v={fmtQ(head.neckBoneQ)} />
        </Section>
      )}

      {/* ── Log console ────────────────────────────────────────────────────── */}
      <Section title={`Log (${logs.length})`}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
          <button
            onClick={clearLogs}
            style={{
              background: "#3a3a3c", border: "none", borderRadius: 4, color: "rgba(255,255,255,0.7)",
              fontSize: 10, padding: "2px 8px", cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
        <div style={{
          maxHeight: 200, overflowY: "auto",
          background: "#0a0a0c", borderRadius: 4, padding: "6px 8px",
        }}>
          {logs.length === 0 && (
            <div style={{ ...mono, fontSize: 10, color: "rgba(255,255,255,0.25)" }}>No logs yet</div>
          )}
          {[...logs].reverse().map((l, i) => (
            <div key={i} style={{
              ...mono, fontSize: 10,
              color: l.includes("ERR") ? "#ff453a" : l.includes("WARN") ? "#ff9f0a" : "rgba(255,255,255,0.6)",
              marginBottom: 2,
            }}>{l}</div>
          ))}
        </div>
      </Section>
    </Panel>
  );
}

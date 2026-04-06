import { useState } from "react";
import { Panel } from "./Panel";
import { useWsStatus } from "../hooks/useWsStatus";
import { useBridgeTelemetry } from "../hooks/useBridgeTelemetry";

const BRIDGE_URL = import.meta.env.VITE_WS_URL ?? "http://localhost:8080";
const OSC_HOST   = import.meta.env.VITE_OSC_TARGET_HOST ?? "127.0.0.1";
const OSC_PORT   = import.meta.env.VITE_OSC_TARGET_PORT ?? "39539";

// ─── copy hook ────────────────────────────────────────────────────────────────

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return [copied, copy];
}

// ─── design tokens (mirrors SettingsPanel exactly) ────────────────────────────

const mono: React.CSSProperties = {
  fontFamily: "'SF Mono', 'Fira Code', 'Menlo', monospace",
  fontSize: 11,
};

// Outer card — same as SettingsPanel `card`
const card: React.CSSProperties = {
  background: "#1c1c1e",
  borderRadius: 8,
  padding: "12px 14px",
  marginBottom: 8,
};

// Inner row card — same as SettingsPanel `innerCard`
const innerCard: React.CSSProperties = {
  background: "#2c2c2e",
  borderRadius: 6,
  padding: "8px 12px",
  marginTop: 4,
};

// Section label — same as SettingsPanel `sectionLabel`
const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "rgba(255,255,255,0.35)",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  marginBottom: 8,
};

const rowLabel: React.CSSProperties = {
  fontSize: 11,
  color: "rgba(255,255,255,0.35)",
  flexShrink: 0,
};

const rowValue: React.CSSProperties = {
  ...mono,
  color: "rgba(255,255,255,0.75)",
  textAlign: "right",
};

const statusPill = (color: string): React.CSSProperties => ({
  display: "inline-block",
  padding: "1px 7px",
  borderRadius: 10,
  fontSize: 10,
  fontWeight: 600,
  background: color + "22",
  color,
  border: `1px solid ${color}44`,
});

// ─── copy icon SVG ────────────────────────────────────────────────────────────

function CopyIcon({ done }: { done: boolean }) {
  return done ? (
    // checkmark
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2.5 7.5L5.5 10.5L11.5 4" stroke="#30d158" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ) : (
    // clipboard
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="4" y="3" width="7" height="9" rx="1.5" stroke="rgba(255,255,255,0.45)" strokeWidth="1.2"/>
      <path d="M6 3V2.5C6 2.22 6.22 2 6.5 2H7.5C7.78 2 8 2.22 8 2.5V3" stroke="rgba(255,255,255,0.45)" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}

// ─── toolbar copy button ──────────────────────────────────────────────────────

function CopyButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <button
      onClick={onCopy}
      title="Copy to clipboard"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        height: 26,
        borderRadius: 6,
        border: `1px solid ${copied ? "rgba(48,209,88,0.35)" : "rgba(255,255,255,0.12)"}`,
        background: copied ? "rgba(48,209,88,0.1)" : "rgba(255,255,255,0.05)",
        cursor: "pointer",
        transition: "background 0.2s, border-color 0.2s",
        flexShrink: 0,
      }}
    >
      <CopyIcon done={copied} />
    </button>
  );
}

// ─── Health tab ───────────────────────────────────────────────────────────────

function HealthTab({ onCopy }: { onCopy: (text: string) => void }) {
  const status = useWsStatus((s) => s.status);
  const { stats, buildSnapshot } = useBridgeTelemetry();

  const statusColor = { connected: "#34c759", connecting: "#ff9f0a", disconnected: "#ff3b30" }[status];
  const isStreaming = stats.lastFrameAt !== null && (performance.now() - stats.lastFrameAt) < 2000;

  // Wire copy to parent toolbar
  useState(() => { /* expose snapshot builder via prop */ });

  const rows: { label: string; val: React.ReactNode }[] = [
    { label: "Bridge",        val: <span style={statusPill(statusColor)}>{status}</span> },
    { label: "WebSocket",     val: BRIDGE_URL },
    { label: "Streaming",     val: <span style={statusPill(isStreaming ? "#34c759" : "#ff3b30")}>{isStreaming ? "active" : "idle"}</span> },
    { label: "Frame rate",    val: `${stats.fps} fps` },
    { label: "Total frames",  val: stats.frameCount.toLocaleString() },
    { label: "Avg latency",   val: `${stats.avgLatencyMs} ms` },
    { label: "Bones active",  val: `${stats.bonesActive} / 12` },
    { label: "Blendshapes",   val: `${stats.blendShapesActive} / 7` },
  ];

  // Expose snapshot to parent on mount/update via callback
  // We call onCopy lazily — parent calls buildSnapshot when user clicks
  void onCopy; // acknowledged — parent calls buildSnapshot("health") directly

  return (
    <div style={card}>
      <div style={sectionLabel}>Bridge Health</div>
      {rows.map(({ label: l, val }) => (
        <div key={l} style={{ ...innerCard, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span style={rowLabel}>{l}</span>
          <span style={rowValue}>{val}</span>
        </div>
      ))}
    </div>
  );
}

// ─── OSC tab ──────────────────────────────────────────────────────────────────

const OSC_COLORS: Record<string, string> = {
  "/VMC/Ext/Root/Pos":  "#0a84ff",
  "/VMC/Ext/Bone/Pos":  "#30d158",
  "/VMC/Ext/Blend/Val": "#ff9f0a",
};

function OscTab() {
  const { oscLog, clearLog } = useBridgeTelemetry();

  return (
    <>
      {/* Target info card */}
      <div style={card}>
        <div style={sectionLabel}>Output Target</div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ ...innerCard, flex: 1 }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginBottom: 3 }}>Host : Port</div>
            <div style={{ ...mono, color: "#0a84ff" }}>{OSC_HOST}:{OSC_PORT}</div>
          </div>
          <div style={{ ...innerCard, flex: 1 }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginBottom: 3 }}>Protocol</div>
            <div style={{ ...mono, color: "rgba(255,255,255,0.65)" }}>VMC / OSC / UDP</div>
          </div>
        </div>
      </div>

      {/* Log card */}
      <div style={{ ...card, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={sectionLabel}>Message Log</div>
          <button
            onClick={clearLog}
            style={{
              background: "none", border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 5, color: "rgba(255,255,255,0.3)",
              fontSize: 10, padding: "1px 7px", cursor: "pointer",
              fontFamily: "'Urbanist', -apple-system, sans-serif",
              marginBottom: 8,
            }}
          >
            clear
          </button>
        </div>
        <div style={{ ...innerCard, flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3, padding: "8px 10px" }}>
          {oscLog.length === 0 ? (
            <div style={{ color: "rgba(255,255,255,0.2)", fontSize: 11, textAlign: "center", paddingTop: 12 }}>
              No frames yet — start the camera to see OSC output
            </div>
          ) : (
            oscLog.map((entry) => (
              <div key={entry.id} style={{ display: "flex", gap: 8, alignItems: "baseline", ...mono }}>
                <span style={{ color: "rgba(255,255,255,0.2)", flexShrink: 0, fontSize: 10 }}>
                  {new Date(entry.ts).toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <span style={{ color: OSC_COLORS[entry.address] ?? "#aaa", flexShrink: 0, minWidth: 156 }}>
                  {entry.address}
                </span>
                <span style={{ color: "rgba(255,255,255,0.45)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.summary}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ─── VMC tab ──────────────────────────────────────────────────────────────────

const VMC_BONES = [
  "Hips", "Spine", "Chest",
  "LeftUpperArm", "LeftLowerArm",
  "RightUpperArm", "RightLowerArm",
  "LeftUpperLeg", "LeftLowerLeg",
  "RightUpperLeg", "RightLowerLeg",
  "Neck",
];

const VMC_BLENDS = [
  { key: "aa",         label: "aa"      },
  { key: "ih",         label: "ih"      },
  { key: "ee",         label: "ee"      },
  { key: "oh",         label: "oh"      },
  { key: "ou",         label: "ou"      },
  { key: "blinkLeft",  label: "blink L" },
  { key: "blinkRight", label: "blink R" },
];

function VmcTab() {
  const { oscLog } = useBridgeTelemetry();

  const latestBlend = oscLog.find((e) => e.address === "/VMC/Ext/Blend/Val");
  const hasData = oscLog.some((e) => e.address === "/VMC/Ext/Root/Pos");

  return (
    <>
      {/* Bones card */}
      <div style={card}>
        <div style={sectionLabel}>Bone Stream  /VMC/Ext/Bone/Pos</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
          {VMC_BONES.map((bone) => {
            const entry = oscLog.find((e) => e.summary.startsWith(bone));
            // Parse "BoneName  x:0.000 y:0.000 z:0.000" and check for meaningful rotation
            let active = false;
            if (entry) {
              const m = entry.summary.match(/x:([-\d.]+).*y:([-\d.]+).*z:([-\d.]+)/);
              if (m) {
                active = Math.abs(parseFloat(m[1])) + Math.abs(parseFloat(m[2])) + Math.abs(parseFloat(m[3])) > 0.001;
              }
            }
            return (
              <div key={bone} style={{
                background: active ? "rgba(48,209,88,0.08)" : "#2c2c2e",
                border: `1px solid ${active ? "rgba(48,209,88,0.25)" : "rgba(255,255,255,0.06)"}`,
                borderRadius: 6, padding: "5px 8px",
                transition: "background 0.3s, border-color 0.3s",
              }}>
                <div style={{ fontSize: 10, color: active ? "#30d158" : "rgba(255,255,255,0.22)", lineHeight: 1.3 }}>{bone}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Blend shapes card */}
      <div style={card}>
        <div style={sectionLabel}>Blend Shapes  /VMC/Ext/Blend/Val</div>
        {latestBlend ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {VMC_BLENDS.map(({ key, label: blendLabel }) => {
              const match = latestBlend.summary.match(new RegExp(`${key}:(\\d+\\.\\d+)`));
              const v = match ? parseFloat(match[1]) : 0;
              return (
                <div key={key} style={{ ...innerCard, display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ ...mono, fontSize: 10, color: "rgba(255,255,255,0.35)", width: 48, flexShrink: 0 }}>{blendLabel}</span>
                  <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${v * 100}%`, background: "#ff9f0a", borderRadius: 2, transition: "width 0.1s" }} />
                  </div>
                  <span style={{ ...mono, fontSize: 10, color: "rgba(255,255,255,0.4)", width: 30, textAlign: "right", flexShrink: 0 }}>{v.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ ...innerCard, color: "rgba(255,255,255,0.2)", fontSize: 11, textAlign: "center" }}>
            {hasData ? "No blend data in recent frames" : "No frames yet — start the camera"}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Panel shell ──────────────────────────────────────────────────────────────

type Tab = "health" | "osc" | "vmc";

export function TerminalPanel() {
  const [tab, setTab] = useState<Tab>("health");
  const [copied, copy] = useCopy();
  const { buildSnapshot } = useBridgeTelemetry();

  const handleCopy = () => copy(buildSnapshot(tab));

  const pillTab = (id: Tab, label: string) => (
    <button
      key={id}
      onClick={() => setTab(id)}
      style={{
        background: tab === id ? "rgba(255,255,255,0.12)" : "transparent",
        border: `1px solid ${tab === id ? "rgba(255,255,255,0.18)" : "transparent"}`,
        borderRadius: 20,
        color: tab === id ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.35)",
        fontSize: 11,
        fontWeight: tab === id ? 600 : 400,
        padding: "3px 12px",
        cursor: "pointer",
        fontFamily: "'Urbanist', -apple-system, sans-serif",
        transition: "background 0.15s, color 0.15s, border-color 0.15s",
        lineHeight: "18px",
      }}
    >
      {label}
    </button>
  );

  return (
    <Panel
      id="terminal"
      title="Terminal"
      defaultX={Math.max(40, window.innerWidth / 2 - 340)}
      defaultY={window.innerHeight - 340}
      defaultW={680}
      defaultH={300}
    >
      {/* Toolbar: pill tabs left, copy icon right — always visible */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 10,
        gap: 8,
      }}>
        <div style={{ display: "flex", gap: 4 }}>
          {pillTab("health", "Health")}
          {pillTab("osc",    "OSC")}
          {pillTab("vmc",    "VMC")}
        </div>
        <CopyButton copied={copied} onCopy={handleCopy} />
      </div>

      {/* Tab content — all cards */}
      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
        {tab === "health" && <HealthTab onCopy={handleCopy} />}
        {tab === "osc"    && <OscTab />}
        {tab === "vmc"    && <VmcTab />}
      </div>
    </Panel>
  );
}

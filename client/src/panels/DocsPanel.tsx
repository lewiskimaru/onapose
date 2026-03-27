import { Panel } from "./Panel";

const DOCS = [
  {
    title: "Getting Started",
    content: `1. Run: npm run dev
2. Open http://localhost:5173 in Chrome or Safari
3. Click the Camera icon in the dock
4. Allow camera access when prompted
5. Wait for MediaPipe models to load
6. Your movements will drive the avatar in real time`,
  },
  {
    title: "OSC Output",
    content: `Default target: 127.0.0.1:39539

Compatible receivers:
- Unreal Engine: VRM4U + OSC plugin
- Blender: VMC4B addon
- TouchDesigner: OSC In CHOP

Configure in .env:
  OSC_TARGET_HOST=127.0.0.1
  OSC_TARGET_PORT=39539`,
  },
  {
    title: "Troubleshooting",
    content: `Camera not starting:
Ensure you are on localhost or HTTPS.
Check browser camera permissions.

Avatar not moving:
Wait for MediaPipe to finish loading (20-30s first load).
Ensure you are well-lit and fully visible.

Bridge not connecting:
Check the WS indicator in the menu bar.
Ensure npm run dev is running.`,
  },
];

const STACK: { layer: string; tech: string; purpose: string }[] = [
  { layer: "UI", tech: "React 19 + Vite", purpose: "Component framework and dev server" },
  { layer: "3D", tech: "React Three Fiber", purpose: "Declarative Three.js scene" },
  { layer: "Avatar", tech: "@pixiv/three-vrm 3.x", purpose: "VRM model loading and bone API" },
  { layer: "Tracking", tech: "@mediapipe/holistic 0.5", purpose: "Face, pose, and hand landmark detection (WASM)" },
  { layer: "Solving", tech: "Kalidokit 1.1", purpose: "Converts landmarks to bone rotations" },
  { layer: "State", tech: "Zustand 5", purpose: "Cross-component state without re-renders" },
  { layer: "Bridge", tech: "NestJS + WS", purpose: "WebSocket server receiving bone data" },
  { layer: "Protocol", tech: "OSC / VMC", purpose: "UDP broadcast to Unreal, Blender, TouchDesigner" },
];

const card: React.CSSProperties = {
  background: "#1c1c1e",
  borderRadius: 8,
  padding: "12px 14px",
  marginBottom: 8,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "rgba(255,255,255,0.35)",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  marginBottom: 8,
};

const contentStyle: React.CSSProperties = {
  background: "#2c2c2e",
  borderRadius: 6,
  padding: "10px 12px",
  fontSize: 12,
  color: "rgba(255,255,255,0.6)",
  lineHeight: 1.7,
  whiteSpace: "pre-wrap",
  fontFamily: "'Urbanist', -apple-system, sans-serif",
};

export function DocsPanel() {
  return (
    <Panel
      id="docs"
      title="Docs"
      defaultX={Math.max(40, window.innerWidth / 2 - 280)}
      defaultY={60}
      defaultW={520}
      defaultH={480}
    >
      {DOCS.map((section) => (
        <div key={section.title} style={card}>
          <div style={sectionLabel}>{section.title}</div>
          <div style={contentStyle}>{section.content}</div>
        </div>
      ))}

      {/* Tech stack */}
      <div style={card}>
        <div style={sectionLabel}>Tech Stack</div>
        <div style={{ background: "#2c2c2e", borderRadius: 6, overflow: "hidden" }}>
          {STACK.map(({ layer, tech, purpose }, i) => (
            <div
              key={layer}
              style={{
                display: "grid",
                gridTemplateColumns: "72px 1fr",
                gap: 8,
                padding: "7px 12px",
                borderTop: i > 0 ? "1px solid rgba(255,255,255,0.06)" : "none",
              }}
            >
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em", paddingTop: 1 }}>{layer}</span>
              <div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", fontWeight: 500 }}>{tech}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 1 }}>{purpose}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

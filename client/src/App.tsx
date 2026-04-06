import { useState, Suspense } from "react";
import { Loader } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { MenuBar } from "./shell/MenuBar";
import { Dock } from "./shell/Dock";
import { CameraPanel } from "./panels/CameraPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { DocsPanel } from "./panels/DocsPanel";
import { AboutModal } from "./panels/AboutModal";
import { TerminalPanel } from "./panels/TerminalPanel";
import { Experience } from "./components/Experience";
import { DebugPanel } from "./panels/DebugPanel";

export default function App() {
  const [avatar, setAvatar] = useState("default.vrm");

  return (
    <>
      {/* 3D scene — always behind everything */}
      <Canvas
        shadows
        camera={{ position: [0.25, 0.25, 2], fov: 30 }}
        style={{ position: "fixed", inset: 0, zIndex: 0 }}
      >
        <color attach="background" args={["#000008"]} />
        <Suspense>
          <Experience avatar={avatar} />
        </Suspense>
      </Canvas>

      {/* R3F loading bar */}
      <Loader />

      {/* Shell chrome */}
      <MenuBar />
      <Dock />

      {/* Floating panels */}
      <CameraPanel />
      <SettingsPanel avatar={avatar} onAvatarChange={setAvatar} />
      <TerminalPanel />
      <DocsPanel />
      <AboutModal />
      <DebugPanel />
    </>
  );
}

import { Loader } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import { CameraWidget } from "./components/CameraWidget";
import { Experience } from "./components/Experience";

export default function App() {
  return (
    <>
      <CameraWidget />
      <Loader />
      <Canvas
        shadows
        camera={{ position: [0.25, 0.25, 2], fov: 30 }}
        style={{ position: "fixed", inset: 0 }}
      >
        <color attach="background" args={["#333"]} />
        <fog attach="fog" args={["#333", 10, 20]} />
        <Suspense>
          <Experience />
        </Suspense>
      </Canvas>
    </>
  );
}

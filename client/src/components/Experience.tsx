import { CameraControls, Environment, useGLTF } from "@react-three/drei";
import { useThree, useFrame } from "@react-three/fiber";
import { Suspense, useRef, useEffect } from "react";
import * as THREE from "three";
import { VRMAvatar } from "./VRMAvatar";
import { useSettings, WALLPAPERS } from "../hooks/useSettings";
import { GalaxyWallpaper } from "./wallpapers/GalaxyWallpaper";
import { NebulaWallpaper } from "./wallpapers/NebulaWallpaper";
import { VoidWallpaper } from "./wallpapers/VoidWallpaper";

interface ExperienceProps {
  avatar: string;
}

function GlbWallpaper({ glb }: { glb: string }) {
  const { scene } = useGLTF(glb);
  return <primitive object={scene} />;
}

/**
 * Fix: R3F defaults to ACESFilmicToneMapping which crushes dark particle
 * colors to near-black. We switch to LinearToneMapping with exposure 1.0
 * so AdditiveBlending particles render at their actual brightness.
 * The avatar still looks correct because it's lit by the HDRI.
 */
function ToneMappingFix() {
  const { gl } = useThree();
  useEffect(() => {
    gl.toneMapping = THREE.LinearToneMapping;
    gl.toneMappingExposure = 1.0;
  }, [gl]);
  return null;
}

function Wallpaper({ id, glb }: { id: string; glb?: string }) {
  if (glb) {
    return (
      <Suspense fallback={null}>
        <GlbWallpaper glb={glb} />
      </Suspense>
    );
  }
  if (id === "galaxy") return <GalaxyWallpaper />;
  if (id === "nebula") return <NebulaWallpaper />;
  if (id === "void")   return <VoidWallpaper />;
  return null;
}

export function Experience({ avatar }: ExperienceProps) {
  const controls = useRef(null);
  const wallpaperId  = useSettings((s) => s.wallpaper);
  const wallpaperDef = WALLPAPERS.find((w) => w.id === wallpaperId);
  const solver = useSettings((s) => s.solver);

  return (
    <>
      <ToneMappingFix />

      <CameraControls
        ref={controls}
        maxPolarAngle={Math.PI / 2}
        minDistance={1}
        maxDistance={10}
      />

      {/* HDRI lights the avatar — not used as visible background */}
      <Environment preset="night" background={false} />

      <Wallpaper id={wallpaperId} glb={wallpaperDef?.glb} />

      <ambientLight intensity={0.2} />
      <pointLight position={[0, 2, 2]}   intensity={1.5} color="#6699ff" />
      <pointLight position={[-2, 1, -1]} intensity={0.8} color="#ff6644" />

      <group position-y={-1.25}>
        <VRMAvatar modelPath={`models/${avatar}`} solver={solver} />
      </group>
    </>
  );
}

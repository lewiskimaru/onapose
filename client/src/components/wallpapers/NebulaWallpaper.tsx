import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Nebula — two layers:
 * 1. A large particle cloud using 3D Perlin-like noise to cluster particles
 *    into cloud shapes with color variation (purple/teal/pink).
 * 2. A background star field for depth.
 *
 * No external assets. Pure BufferGeometry + AdditiveBlending.
 */

// Simple hash-based pseudo-random for deterministic noise
function hash(n: number): number {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

// 3D value noise — smooth interpolation between random values at integer coords
function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  // Smoothstep
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const v000 = hash(ix     + iy * 57     + iz * 113);
  const v100 = hash(ix + 1 + iy * 57     + iz * 113);
  const v010 = hash(ix     + (iy+1) * 57 + iz * 113);
  const v110 = hash(ix + 1 + (iy+1) * 57 + iz * 113);
  const v001 = hash(ix     + iy * 57     + (iz+1) * 113);
  const v101 = hash(ix + 1 + iy * 57     + (iz+1) * 113);
  const v011 = hash(ix     + (iy+1) * 57 + (iz+1) * 113);
  const v111 = hash(ix + 1 + (iy+1) * 57 + (iz+1) * 113);

  return v000 * (1-ux)*(1-uy)*(1-uz) + v100 * ux*(1-uy)*(1-uz) +
         v010 * (1-ux)*uy*(1-uz)     + v110 * ux*uy*(1-uz) +
         v001 * (1-ux)*(1-uy)*uz     + v101 * ux*(1-uy)*uz +
         v011 * (1-ux)*uy*uz         + v111 * ux*uy*uz;
}

// Fractal Brownian Motion — 4 octaves of noise
function fbm(x: number, y: number, z: number): number {
  let v = 0, a = 0.5;
  for (let i = 0; i < 4; i++) {
    v += a * noise3(x, y, z);
    x *= 2; y *= 2; z *= 2;
    a *= 0.5;
  }
  return v;
}

export function NebulaWallpaper() {
  const cloudRef = useRef<THREE.Points>(null!);
  const starsRef = useRef<THREE.Points>(null!);

  const cloudData = useMemo(() => {
    const COUNT = 60_000;
    const positions = new Float32Array(COUNT * 3);
    const colors    = new Float32Array(COUNT * 3);

    // Nebula color palette
    const palette = [
      new THREE.Color("#7b2fff"), // purple
      new THREE.Color("#00d4ff"), // cyan
      new THREE.Color("#ff3399"), // pink
      new THREE.Color("#ff8800"), // amber
      new THREE.Color("#00ff88"), // green
    ];

    let written = 0;
    let attempts = 0;
    const MAX_ATTEMPTS = COUNT * 8;

    while (written < COUNT && attempts < MAX_ATTEMPTS) {
      attempts++;
      const x = (Math.random() - 0.5) * 20;
      const y = (Math.random() - 0.5) * 12;
      const z = (Math.random() - 0.5) * 20;

      // Use fbm to determine particle density — only place particles in
      // high-density regions, creating cloud-like clustering
      const density = fbm(x * 0.15 + 1.7, y * 0.15 + 3.2, z * 0.15 + 0.9);
      if (density < 0.52) continue; // reject low-density regions

      const i3 = written * 3;
      positions[i3]     = x;
      positions[i3 + 1] = y;
      positions[i3 + 2] = z;

      // Color based on a second noise sample — different region = different hue
      const colorNoise = fbm(x * 0.1 + 5.1, y * 0.1 + 2.3, z * 0.1 + 7.8);
      const colorIdx = Math.floor(colorNoise * palette.length) % palette.length;
      const c = palette[colorIdx];
      // Vary brightness by density
      const bright = (density - 0.52) * 4;
      colors[i3]     = c.r * bright;
      colors[i3 + 1] = c.g * bright;
      colors[i3 + 2] = c.b * bright;

      written++;
    }

    return { positions: positions.slice(0, written * 3), colors: colors.slice(0, written * 3), count: written };
  }, []);

  const starData = useMemo(() => {
    const COUNT = 8_000;
    const positions = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 40 + Math.random() * 20;
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    return positions;
  }, []);

  useFrame((_, delta) => {
    if (cloudRef.current) cloudRef.current.rotation.y += delta * 0.015;
    if (starsRef.current) starsRef.current.rotation.y += delta * 0.003;
  });

  return (
    <>
      {/* Background stars */}
      <points ref={starsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[starData, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.08}
          sizeAttenuation
          color="#ffffff"
          transparent
          opacity={0.7}
          depthWrite={false}
        />
      </points>

      {/* Nebula cloud */}
      <points ref={cloudRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[cloudData.positions, 3]} />
          <bufferAttribute attach="attributes-color"    args={[cloudData.colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.06}
          sizeAttenuation
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          vertexColors
          transparent
          opacity={0.85}
        />
      </points>
    </>
  );
}

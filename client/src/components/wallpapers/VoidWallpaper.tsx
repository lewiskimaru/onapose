import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Void — three depth layers of stars with parallax drift.
 * Uses ShaderMaterial for correct point sizing at all distances.
 * The most minimal and cinematic of the three wallpapers.
 */

function makeStarShader(baseSize: number, color: string, opacity: number) {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      uniform float uSize;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        float s = 1.0 - smoothstep(0.0, 0.5, d);
        s = pow(s, 1.8);
        if (s < 0.05) discard;
        gl_FragColor = vec4(uColor * s, s * uOpacity);
      }
    `,
    uniforms: {
      uSize:    { value: baseSize },
      uColor:   { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
    },
    depthWrite: false,
    transparent: true,
  });
}

function makeStarGeo(count: number, radius: number) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.75 + Math.random() * 0.25);
    pos[i*3]   = r * Math.sin(p) * Math.cos(t);
    pos[i*3+1] = r * Math.sin(p) * Math.sin(t);
    pos[i*3+2] = r * Math.cos(p);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return geo;
}

interface LayerProps {
  count: number; radius: number; size: number;
  color: string; opacity: number; speed: number;
}

function StarLayer({ count, radius, size, color, opacity, speed }: LayerProps) {
  const ref = useRef<THREE.Points>(null!);
  const geo = useMemo(() => makeStarGeo(count, radius), [count, radius]);
  const mat = useMemo(() => makeStarShader(size, color, opacity), [size, color, opacity]);
  useFrame((_, delta) => {
    if (ref.current) {
      ref.current.rotation.y += delta * speed;
      ref.current.rotation.x += delta * speed * 0.25;
    }
  });
  return <points ref={ref} geometry={geo} material={mat} />;
}

export function VoidWallpaper() {
  // Bright feature stars — large, additive blending
  const featureRef = useRef<THREE.Points>(null!);
  const featureGeo = useMemo(() => makeStarGeo(150, 20), []);
  const featureMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = 4.5 * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */`
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        float s = 1.0 - smoothstep(0.0, 0.5, d);
        s = pow(s, 1.2);
        if (s < 0.05) discard;
        // Warm white with a slight blue tint for realism
        gl_FragColor = vec4(vec3(1.0, 0.97, 0.92) * s, s);
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true,
  }), []);

  useFrame((_, delta) => {
    if (featureRef.current) featureRef.current.rotation.y += delta * 0.006;
  });

  return (
    <>
      {/* Far — dense, tiny, blue-white */}
      <StarLayer count={14000} radius={80} size={1.2} color="#aaccff" opacity={0.55} speed={0.004} />
      {/* Mid — medium, neutral white */}
      <StarLayer count={5000}  radius={50} size={1.8} color="#ffffff" opacity={0.7}  speed={0.010} />
      {/* Near — sparse, larger, warm */}
      <StarLayer count={1500}  radius={28} size={2.5} color="#fff8ee" opacity={0.85} speed={0.018} />
      {/* Feature stars */}
      <points ref={featureRef} geometry={featureGeo} material={featureMat} />
    </>
  );
}

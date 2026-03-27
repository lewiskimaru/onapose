import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Spiral galaxy — 80,000 particles in 4 arms.
 *
 * Uses ShaderMaterial (not PointsMaterial) so we control gl_PointSize
 * directly in GLSL. PointsMaterial with sizeAttenuation renders sub-pixel
 * dots at the distances we need — ShaderMaterial fixes this.
 *
 * Technique: Bruno Simon / Three.js Journey galaxy generator.
 * AdditiveBlending makes overlapping particles add light.
 */

const vertexShader = /* glsl */`
  varying vec3 vColor;
  uniform float uSize;

  void main() {
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */`
  varying vec3 vColor;

  void main() {
    // Soft circular point — distance from center of gl_PointCoord
    float d = distance(gl_PointCoord, vec2(0.5));
    // Smooth falloff: bright center, transparent edge
    float strength = 1.0 - smoothstep(0.0, 0.5, d);
    // Boost the core brightness
    strength = pow(strength, 1.5);
    if (strength < 0.01) discard;
    gl_FragColor = vec4(vColor * strength, strength);
  }
`;

export function GalaxyWallpaper() {
  const pointsRef = useRef<THREE.Points>(null!);

  const { positions, colors } = useMemo(() => {
    const COUNT   = 80_000;
    const ARMS    = 4;
    const RADIUS  = 14;
    const SPIN    = 1.8;
    const SCATTER = 0.35;
    const INNER   = new THREE.Color("#ff9944");
    const MID     = new THREE.Color("#ffffff");
    const OUTER   = new THREE.Color("#3355ff");

    const positions = new Float32Array(COUNT * 3);
    const colors    = new Float32Array(COUNT * 3);

    for (let i = 0; i < COUNT; i++) {
      const i3 = i * 3;
      const r = Math.pow(Math.random(), 1.4) * RADIUS;
      const armAngle   = ((i % ARMS) / ARMS) * Math.PI * 2;
      const spinAngle  = r * SPIN;
      const angle      = armAngle + spinAngle;

      const scatter = () =>
        (Math.pow(Math.random(), 3) * SCATTER * r * 0.6) *
        (Math.random() < 0.5 ? 1 : -1);

      positions[i3]     = Math.cos(angle) * r + scatter();
      positions[i3 + 1] = scatter() * 0.25;
      positions[i3 + 2] = Math.sin(angle) * r + scatter();

      // Three-stop color gradient: warm core → white mid → blue outer
      const t = r / RADIUS;
      let c: THREE.Color;
      if (t < 0.4) {
        c = INNER.clone().lerp(MID, t / 0.4);
      } else {
        c = MID.clone().lerp(OUTER, (t - 0.4) / 0.6);
      }
      // Brighten core particles
      const brightness = 1.0 - t * 0.3;
      colors[i3]     = c.r * brightness;
      colors[i3 + 1] = c.g * brightness;
      colors[i3 + 2] = c.b * brightness;
    }

    return { positions, colors };
  }, []);

  useFrame((_, delta) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y += delta * 0.035;
    }
  });

  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { uSize: { value: 2.5 } },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    vertexColors: true,
  }), []);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color",    new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [positions, colors]);

  return (
    <points ref={pointsRef} geometry={geometry} material={material} position={[0, -1, 0]} />
  );
}

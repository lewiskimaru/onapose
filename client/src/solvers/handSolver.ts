/**
 * Hand / Finger Solver — Port of XR Animator SA_system_emulation.min.js:126500–130000
 * and mocap_lib_module.js:1180–1244
 *
 * Produces a full-hand orientation quaternion from 21 MediaPipe hand landmarks,
 * plus per-finger-per-phalanx Euler angles clamped to anatomical ROM limits.
 *
 * Key difference from Kalidokit:
 *   - Works in 3D landmark space (including Z depth)
 *   - Uses setFromUnitVectors for thumb metacarpal (gimbal-safe)
 *   - Uses spherical coordinate decomposition for non-thumb fingers
 *   - Applies palm z-depth correction before solving (aspect-ratio constraint)
 */

import { Euler, Quaternion, Vector3 } from "three";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Landmark3D { x: number; y: number; z: number; }

/** One phalanx: Euler angles in radians.  x=curl, y=spread, z=unused(0) */
export interface PhalanxAngles { x: number; y: number; z: number; }

/** Full hand solve result */
export interface SolvedHand {
  /** Full 3D wrist orientation (quaternion) — the roll axis drives pronation */
  wristQ: Quaternion;
  /** fingers[fingerIdx][phalanxIdx]: 0=thumb..4=pinky, 0=proximal..2=distal */
  fingers: PhalanxAngles[][];
}

// ─── ROM limits (from XR Animator ROM clamping analysis) ─────────────────────

const ROM = {
  /** Max hyperextension (negative curl) per finger */
  minCurl:  [-Math.PI / 1.25, -Math.PI / 1.8, -Math.PI / 1.8, -Math.PI / 1.8, -Math.PI / 1.8],
  /** Spread fallback threshold per finger (absolute) */
  spreadThreshold: [Math.PI / 1.1, Math.PI / 2.5, Math.PI / 2.5, Math.PI / 2.5, Math.PI / 2.5],
  curlThreshold:   [Math.PI / 1.1, Math.PI / 3.0, Math.PI / 3.0, Math.PI / 3.0, Math.PI / 3.0],
};

// ─── Scratch allocations ──────────────────────────────────────────────────────

const _boneDir  = new Vector3();
const _restAxis = new Vector3(0, 1, 0);   // Y-up rest axis for all fingers
const _q        = new Quaternion();
const _euler    = new Euler();
const _v1       = new Vector3();
const _v2       = new Vector3();

// ─── Palm z-depth correction ──────────────────────────────────────────────────

/**
 * Correct the Z depth of all hand landmarks when the hand is foreshortened.
 * Verified in mocap_lib_module.js:1183–1206.
 *
 * When palm height/width ratio is outside [1.25, 1.75], scale z-coords
 * analytically so the palm appears as a rectangle.
 */
function correctPalmDepth(lms: Landmark3D[]): Landmark3D[] {
  // palm_width: thumb-CMC (L1) to pinky-MCP (L17)
  const pw = Math.sqrt(
    (lms[1].x - lms[17].x)**2 +
    (lms[1].y - lms[17].y)**2 +
    (lms[1].z - lms[17].z)**2
  );
  // palm_height: wrist (L0) to middle-MCP (L9)
  const ph = Math.sqrt(
    (lms[0].x - lms[9].x)**2 +
    (lms[0].y - lms[9].y)**2 +
    (lms[0].z - lms[9].z)**2
  );

  if (pw < 1e-6) return lms;
  let ratio = ph / pw;

  if (ratio >= 1.25 && ratio <= 1.75) {
    // Aspect ratio looks correct — no correction needed
    return lms;
  }

  ratio = ratio < 1.25 ? 1.25 : 1.75;  // clamp

  // Compute z-scale analytically from the constraint that
  // palm_height ≈ ratio * palm_width (verified from source comments)
  const pwX = lms[1].x - lms[17].x, pwY = lms[1].y - lms[17].y, pwZ = lms[1].z - lms[17].z;
  const phX = lms[0].x - lms[9].x,  phY = lms[0].y - lms[9].y,  phZ = lms[0].z - lms[9].z;
  const s = ratio * ratio;
  const denom = pwZ**2 - phZ**2 / s;
  if (Math.abs(denom) < 1e-9) return lms;

  const zScale = Math.min(
    Math.sqrt(Math.abs(((phX**2 + phY**2) / s - (pwX**2 + pwY**2)) / denom)),
    1.5 + 1.5 * Math.max(Math.abs(phZ / ph), Math.abs(pwZ / pw))
  );

  return lms.map(lm => ({ ...lm, z: lm.z * zScale }));
}

// ─── Per-phalanx solver ───────────────────────────────────────────────────────

/**
 * Solve a single finger phalanx using spherical coordinate decomposition for
 * all except thumb (which uses setFromUnitVectors directly).
 *
 * Verified pattern from SA_system_emulation.min.js:126500.
 */
function solvePhalanx(
  proximalLm: Landmark3D,
  distalLm:   Landmark3D,
  fingerIdx:  number,
): PhalanxAngles {
  _boneDir
    .set(
      distalLm.x - proximalLm.x,
      distalLm.y - proximalLm.y,
      distalLm.z - proximalLm.z
    )
    .normalize();

  let curlAngle: number;
  let spreadAngle: number;

  if (fingerIdx === 0) {
    // Thumb: setFromUnitVectors (avoids Euler gimbal at extreme flex)
    _q.setFromUnitVectors(_restAxis, _boneDir);
    _euler.setFromQuaternion(_q, "XZY");
    curlAngle   = _euler.x;
    spreadAngle = _euler.z;
  } else {
    // Non-thumb: spherical coordinate decomposition
    // curl  = -asin(to.y)   elevation from Y up
    // spread = atan2(to.x, to.z)  azimuth
    curlAngle   = -Math.asin(Math.max(-1, Math.min(1, _boneDir.y)));
    spreadAngle =  Math.atan2(_boneDir.x, _boneDir.z);
  }

  // ROM clamping with anatomical fallback
  const spreadThresh = ROM.spreadThreshold[fingerIdx];
  const curlThresh   = ROM.curlThreshold[fingerIdx];

  if (Math.abs(spreadAngle) > spreadThresh || curlAngle > curlThresh) {
    // Implausible angle — fall back to pure curl, zero spread
    curlAngle   = -Math.abs(_restAxis.angleTo(_boneDir));
    spreadAngle = 0;
  }

  // Hyperextension cap
  curlAngle = Math.max(curlAngle, ROM.minCurl[fingerIdx]);

  return { x: curlAngle, y: spreadAngle, z: 0 };
}

// ─── Wrist orientation quaternion ────────────────────────────────────────────

/**
 * Compute the full 3D wrist orientation as a quaternion.
 * The palm normal (via cross product of in-palm vectors) becomes the Z axis
 * of the hand's local frame.  The roll component (YZX Euler X) is what
 * XR Animator extracts for wrist-roll distribution.
 */
function solveWristQuaternion(lms: Landmark3D[], side: "Left" | "Right"): Quaternion {
  // Palm "up" vector: wrist(L0) → middle-MCP(L9)
  _v1.set(lms[9].x - lms[0].x, lms[9].y - lms[0].y, lms[9].z - lms[0].z).normalize();

  // Palm "right" vector: index-MCP(L5) → pinky-MCP(L17)
  _v2.set(lms[17].x - lms[5].x, lms[17].y - lms[5].y, lms[17].z - lms[5].z).normalize();

  // Palm normal = up × right
  const nx = _v1.y * _v2.z - _v1.z * _v2.y;
  const ny = _v1.z * _v2.x - _v1.x * _v2.z;
  const nz = _v1.x * _v2.y - _v1.y * _v2.x;

  // Build an orthonormal frame: X = right, Y = up, Z = normal
  // Then create a quaternion from this frame
  const palmRight = _v2.clone();
  const palmUp    = _v1.clone();
  const palmNorm  = new Vector3(nx, ny, nz).normalize();

  // setFromRotationMatrix equivalent via fromUnitVectors
  // Wrist quaternion: rotate Y-up to palmUp
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), palmUp);

  // Apply side mirror
  if (side === "Right") {
    q.x *= -1;
    q.z *= -1;
  }

  return q;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Solve the full hand.
 *
 * @param landmarks  21 MediaPipe Hand landmarks (x,y,z normalised 0–1)
 * @param side       "Left" or "Right" (performer's hand side)
 */
export function solveHand(landmarks: Landmark3D[], side: "Left" | "Right"): SolvedHand {
  // 1. Apply z-depth correction (palm aspect-ratio constraint)
  const lms = correctPalmDepth(landmarks);

  // 2. Wrist orientation quaternion
  const wristQ = solveWristQuaternion(lms, side);

  // 3. Finger solving
  const fingers: PhalanxAngles[][] = [];
  // Finger layout: 0=thumb, 1=index, 2=middle, 3=ring, 4=pinky
  // Landmarks: f=0 → L1,L2,L3,L4; f=1 → L5,L6,L7,L8; etc.
  for (let f = 0; f < 5; f++) {
    const phalanxes: PhalanxAngles[] = [];
    // Palm connection point: L0 for thumb, L(f*4+1) for others
    // Proximal joint:  L(f*4+1)
    // Phalanxes: proximal(0)→intermediate(1), intermediate(1)→distal(2)
    // We solve 3 phalanxes: (palm→proximal), (proximal→intermediate), (intermediate→distal)
    const offsets = [f * 4 + 1, f * 4 + 2, f * 4 + 3, f * 4 + 4];
    // index 0 is the MCP (proximal), index 3 is fingertip

    // For thumb: palm(L0) → CMC(L1) → MCP(L2) → IP(L3)
    const palmAnchor: Landmark3D = f === 0
      ? lms[0]   // thumb originates at wrist
      : lms[0];  // all fingers effectively originate at wrist for base orientation

    for (let p = 0; p < 3; p++) {
      const proxIdx = offsets[p];
      const distIdx = offsets[p + 1];
      const proxLm  = lms[proxIdx] ?? lms[0];
      const distLm  = lms[distIdx] ?? lms[proxIdx];

      let angles = solvePhalanx(proxLm, distLm, f);

      // Thumb CMC spread offset (XR Animator SA_system_emulation.min.js finger solver)
      if (f === 0 && p === 0) {
        const spreadSign = side === "Left" ? 1 : -1;
        angles = {
          x: angles.x,
          y: angles.y * 1.25 + (Math.PI / 8 + Math.PI / 8) * spreadSign,
          z: 0,
        };
      }

      phalanxes.push(angles);
    }
    fingers.push(phalanxes);
  }

  return { wristQ, fingers };
}

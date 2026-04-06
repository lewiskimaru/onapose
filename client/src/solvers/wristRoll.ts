/**
 * Wrist Roll Solver — Port of XR Animator SA_system_emulation.min.js:153800–154300
 *
 * Extracts the forearm pronation/supination angle from the full wrist quaternion
 * and distributes it 50/50 between the LowerArm and Hand bones.
 *
 * Verified directly from minified source:
 *   let t = nt.setEulerFromQuaternion(l, "YZX").x * -M;
 *   // ±π wrap-around protection
 *   const D = k[s];
 *   if (D.angle != null && D.timestamp > RAF_timestamp - 250 && Math.abs(t - D.angle) > Math.PI) {
 *     let e = t + Math.PI * 2 * (t > 0 ? -1 : 1);
 *     if (Math.abs(e) < Math.PI * (Math.sign(e) == M ? 1.5 : 1)) t = e;
 *   }
 *   D.angle = t; D.timestamp = RAF_timestamp;
 *   d = -t * 0.5;
 *   m = setFromAxisAngle(fixedAxis, d);
 *   // handTwist bone gets half, lowerArm gets conjugate
 *   lowerArmBone.quaternion.multiplyQuaternions(m.conjugate(), lowerArmBone.quaternion);
 */

import { Euler, Quaternion, Vector3 } from "three";

const _euler      = new Euler();
const _rollQ      = new Quaternion();
const _conjugateQ = new Quaternion();

export interface WristRollState {
  /** Last unwrapped roll angle in radians */
  angle: number;
  /** performance.now() timestamp of the last update */
  ts: number;
}

export interface WristRollResult {
  /** Quaternion to MULTIPLY onto the LowerArm bone (XR Animator: m.conjugate()) */
  lowerArmDelta: Quaternion;
  /** Roll angle for the Hand bone (applied as half the total roll) */
  handRollAngle: number;
}

/**
 * Extract wrist roll from the hand's full 3D orientation quaternion,
 * apply ±π wrap-around protection, and compute the 50/50 split.
 *
 * @param wristQ        Full wrist orientation from the hand solver
 * @param forearmAxis   T-pose longitudinal axis of the forearm (from TPosePara)
 * @param state         Mutable state object tracking the previous angle + timestamp
 * @param side          +1 for left, -1 for right (XR Animator 'M' variable)
 * @param nowMs         performance.now() in milliseconds
 */
export function solveWristRoll(
  wristQ:      Quaternion,
  forearmAxis: Vector3,
  state:       WristRollState,
  side:        1 | -1,
  nowMs:       number,
): WristRollResult {
  // ── 1. Extract roll from YZX Euler X component ─────────────────────────────
  // Verified: `nt.setEulerFromQuaternion(l, "YZX").x * -M`
  _euler.setFromQuaternion(wristQ, "YZX");
  let rawRoll = _euler.x * -side;

  // ── 2. ±π Wrap-around protection ────────────────────────────────────────────
  // Prevents arm spinning 360° when Euler representation crosses ±π boundary.
  // Verified directly from minified source (250ms window, same logic).
  const prevAngle = state.angle;
  const prevTs    = state.ts;
  const hasHistory = (nowMs - prevTs) < 250 && prevTs > 0;

  if (hasHistory && Math.abs(rawRoll - prevAngle) > Math.PI) {
    const wrapped = rawRoll + Math.PI * 2 * (rawRoll > 0 ? -1 : 1);
    const limit = Math.PI * (Math.sign(wrapped) === side ? 1.5 : 1);
    if (Math.abs(wrapped) < limit) {
      rawRoll = wrapped;
    }
  }

  state.angle = rawRoll;
  state.ts    = nowMs;

  // ── 3. 50/50 split via setFromAxisAngle ───────────────────────────────────
  // Verified: `d = -t * 0.5;  m = setFromAxisAngle(fixedAxis, d)`
  const halfAngle = -rawRoll * 0.5;
  _rollQ.setFromAxisAngle(forearmAxis, halfAngle);

  // LowerArm gets the conjugate (negative rotation) — verified from source:
  // `lowerArmBone.quaternion.multiplyQuaternions(m.conjugate(), lowerArmBone.quaternion)`
  _conjugateQ.copy(_rollQ).conjugate();

  return {
    lowerArmDelta: _conjugateQ.clone(),  // premultiply onto lowerArm
    handRollAngle: halfAngle,            // apply as axisAngle on hand
  };
}

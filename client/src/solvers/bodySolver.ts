/**
 * Body Rotation Solver — Port of XR Animator SA_system_emulation.min.js:75180–75714
 *
 * Derives the body yaw (Y-rotation) from the shoulder-to-shoulder vector.
 * This is more stable than Kalidokit's hip landmark approach because the
 * shoulder vector is clearly visible even when the hips are partially occluded.
 *
 * Verified from minified source at offset 75714:
 *   e = rightShoulder.clone().sub(leftShoulder)
 *   o = setEulerFromQuaternion(setFromUnitVectors(Vector3(1,0,0), e.normalize()), "ZYX").y
 *
 * Also derives forward-lean (spine pitch) from the spine vector, and
 * lateral tilt (spine roll) from the hip vector — giving a complete
 * upper-body orientation from three robust landmark pairs.
 */

import { Euler, Quaternion, Vector3 } from "three";

interface Landmark3D { x: number; y: number; z: number; }

const _shoulderVec = new Vector3();
const _xAxisRef    = new Vector3(-1, 0, 0); // In our world, right - left points to -X
const _yAxis       = new Vector3(0, 1, 0);
const _q           = new Quaternion();
const _euler       = new Euler();

export interface BodyRotation {
  /** Quaternion representing hips orientation (yaw from shoulders, lean from spine) */
  hipsQ: Quaternion;
  /** Quaternion representing spine orientation (forward tilt) */
  spineQ: Quaternion;
  /** Yaw angle in radians (for debugging / blending) */
  yaw: number;
}

/**
 * Solve body orientation from shoulder and hip landmarks (world-space 3D).
 *
 * @param leftShoulder   World-space left shoulder (BlazePose index 11)
 * @param rightShoulder  World-space right shoulder (BlazePose index 12)
 * @param leftHip        World-space left hip (BlazePose index 23)
 * @param rightHip       World-space right hip (BlazePose index 24)
 */
export function solveBodyRotation(
  leftShoulder: Landmark3D,
  rightShoulder: Landmark3D,
  leftHip: Landmark3D,
  rightHip: Landmark3D,
): BodyRotation {
  // ── Yaw from shoulder vector ────────────────────────────────────────────────
  // right (-X) minus left (+X) points to -X.
  _shoulderVec
    .set(
      rightShoulder.x - leftShoulder.x,
      rightShoulder.y - leftShoulder.y,
      rightShoulder.z - leftShoulder.z
    )
    .normalize();

  _q.setFromUnitVectors(_xAxisRef, _shoulderVec);
  _euler.setFromQuaternion(_q, "ZYX");
  const yaw = _euler.y;

  // ── Roll from shoulder tilt ─────────────────────────────────────────────────
  // Using left.x - right.x ensures dx is positive, so roll is 0 when level.
  const roll = Math.atan2(
    leftShoulder.y - rightShoulder.y,
    leftShoulder.x - rightShoulder.x
  );

  // ── Pitch from spine — neck-to-hip vertical projection ─────────────────────
  // Forward lean of the torso: positive = leaning toward camera.
  const midShoulderX = (leftShoulder.x + rightShoulder.x) * 0.5;
  const midShoulderY = (leftShoulder.y + rightShoulder.y) * 0.5;
  const midShoulderZ = (leftShoulder.z + rightShoulder.z) * 0.5;
  const midHipX = (leftHip.x + rightHip.x) * 0.5;
  const midHipY = (leftHip.y + rightHip.y) * 0.5;
  const midHipZ = (leftHip.z + rightHip.z) * 0.5;

  // Spine vector from hip mid to shoulder mid — Z component = forward lean
  const spineDX = midShoulderX - midHipX;
  const spineDY = midShoulderY - midHipY;
  const spineDZ = midShoulderZ - midHipZ;
  const spineLen = Math.sqrt(spineDX**2 + spineDY**2 + spineDZ**2) || 1;

  // Pitch = angle of spine deviation from the upright Y axis
  const pitch = Math.atan2(spineDZ / spineLen, spineDY / spineLen);

  // ── Compose hips quaternion ─────────────────────────────────────────────────
  // Build as Euler(pitch, yaw, roll, "YXZ") — matches typical body rotation order
  _euler.set(pitch * 0.5, yaw, roll * 0.4, "YXZ");
  const hipsQ = new Quaternion().setFromEuler(_euler);

  // ── Spine quaternion — forward tilt relative to hips ───────────────────────
  // Spine adds the remaining pitch that wasn't absorbed into hips
  _euler.set(pitch * 0.5, 0, 0, "XYZ");
  const spineQ = new Quaternion().setFromEuler(_euler);

  return { hipsQ, spineQ, yaw };
}

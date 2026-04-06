/**
 * Arm Solver — Port of XR Animator SA_system_emulation.min.js:109491–111516
 *
 * Derives UpperArm and LowerArm quaternions from raw 3D landmark positions
 * using setFromUnitVectors, which is gimbal-lock-free by construction.
 *
 * This is the core of what XR Animator does differently from Kalidokit:
 * instead of decomposing angles from 2D image coordinates, it works entirely
 * in 3D world space using two-point direction vectors.
 *
 * Verified from minified source at offsets 109491 and 111516:
 *   g = (elbow-shoulder).normalize().applyQuaternion(upperBodyRotInv)
 *   b = setFromUnitVectors(Vector3(L,0,0), g)
 *
 *   e = (wrist-elbow).normalize().applyQuaternion(upperBodyRotInv).applyQuaternion(b.conjugate())
 *   k = setFromUnitVectors(Vector3(L,0,0), e)
 */

import { Quaternion, Vector3 } from "three";

interface Landmark3D { x: number; y: number; z: number; }

// Scratch objects — module-level, reused every call
const _dirUpper  = new Vector3();
const _dirLower  = new Vector3();
const _restAxis  = new Vector3();
const _qConjUpper = new Quaternion();

/**
 * Solve UpperArm quaternion from shoulder→elbow direction.
 *
 * @param shoulder  World-space shoulder landmark
 * @param elbow     World-space elbow landmark
 * @param parentInvQ  Inverse of the upper-body (Hips+Spine+Chest) world quaternion —
 *                    transforms landmarks from world space into parent-bone space.
 * @param sign      +1 for left arm, -1 for right arm (T-pose arm direction along X)
 * @returns UpperArm quaternion in parent-bone local space
 */
export function solveUpperArm(
  shoulder: Landmark3D,
  elbow: Landmark3D,
  parentInvQ: Quaternion,
  sign: 1 | -1
): Quaternion {
  // Direction vector shoulder → elbow, rotated into parent-bone space
  _dirUpper
    .set(elbow.x - shoulder.x, elbow.y - shoulder.y, elbow.z - shoulder.z)
    .normalize()
    .applyQuaternion(parentInvQ);

  // T-pose rest axis: left arm points in +X, right arm in -X
  _restAxis.set(sign, 0, 0);

  // setFromUnitVectors = minimal-arc (swing) rotation, no twist
  return new Quaternion().setFromUnitVectors(_restAxis, _dirUpper);
}

/**
 * Solve LowerArm quaternion from elbow→wrist direction.
 *
 * @param elbow     World-space elbow landmark
 * @param wrist     World-space wrist landmark
 * @param upperArmQ  The already-solved UpperArm quaternion (in parent space)
 * @param parentInvQ  Inverse of the upper-body world quaternion
 * @param sign      +1 for left, -1 for right
 * @returns LowerArm quaternion in UpperArm-local space
 */
export function solveLowerArm(
  elbow: Landmark3D,
  wrist: Landmark3D,
  upperArmQ: Quaternion,
  parentInvQ: Quaternion,
  sign: 1 | -1
): Quaternion {
  // Direction vector elbow → wrist
  // Step 1: transform into upper-body space
  _dirLower
    .set(wrist.x - elbow.x, wrist.y - elbow.y, wrist.z - elbow.z)
    .normalize()
    .applyQuaternion(parentInvQ);

  // Step 2: conjugate removes the UpperArm rotation, expressing the direction
  //         in UpperArm-local space (critical — verified in minified source)
  _qConjUpper.copy(upperArmQ).conjugate();
  _dirLower.applyQuaternion(_qConjUpper);

  _restAxis.set(sign, 0, 0);
  return new Quaternion().setFromUnitVectors(_restAxis, _dirLower);
}

/**
 * Build the inverse of the accumulated upper-body world quaternion.
 *
 * XR Animator uses `re` (the inverse of the upper-body rotation) to project
 * landmark directions from world space into the parent-bone's local frame
 * before computing arm rotations.  This is just the conjugate of the composed:
 *   hips * spine * chest (or spine if no chest)
 *
 * @param hipsQ    Solved hips quaternion
 * @param spineQ   Solved spine quaternion
 * @param chestQ   Solved chest quaternion (identity if bone absent)
 */
export function buildUpperBodyInvQ(
  hipsQ: Quaternion,
  spineQ: Quaternion,
  chestQ: Quaternion
): Quaternion {
  const composed = hipsQ.clone().multiply(spineQ).multiply(chestQ);
  return composed.conjugate();
}

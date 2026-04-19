/**
 * T-Pose Precomputation — Port of XR Animator MMD_SA.js:9064–9148
 *
 * At VRM model load time, traverses the bone hierarchy to capture the T-pose
 * world-space position and orientation of every relevant bone.  The results
 * are used every frame to:
 *   - scale landmark distances to model proportions (arm-length normalisation)
 *   - compute lower_arm_fixedAxis for wrist-roll distribution
 *   - compute spine_to_hips_ratio for models without a Chest bone
 *   - detect and correct bad rest-pose orientations (hands-up, feet-sideways, etc.)
 *     caused by VRM models exported without proper normalization
 */

import { Quaternion, Vector3 } from "three";
import type { VRM } from "@pixiv/three-vrm";
import { VRMHumanBoneName } from "@pixiv/three-vrm";

export interface TPosePara {
  /** World-space positions of bones in T-pose (VRM/Three.js coordinate space) */
  pos0: Partial<Record<string, [number, number, number]>>;

  /** Arm model measurements (derived from T-pose, used to scale landmarks) */
  shoulderWidth: number;     // X-distance between leftUpperArm and rightUpperArm
  leftArmLength: number;     // shoulder → wrist
  rightArmLength: number;

  /** Anatomical forearm longitudinal axis for wrist-roll distribution.
   *  Matches XR Animator para.lower_arm_fixedAxis['左'/'右'].
   *  Vector points from LowerArm origin toward Hand origin in world space. */
  leftForearmAxis:  Vector3;  // unit vector, world space
  rightForearmAxis: Vector3;

  /** 0 if the model has a Chest bone; else the fraction of spine rotation to
   *  push into hips.  Matches XR Animator MMD_SA.js:9147. */
  spineToHipsRatio: number;

  /** Whether the loaded model is VRM1 */
  isVRM1: boolean;

  /**
   * Rest-pose correction quaternions for bones that deviate from the VRM T-pose spec.
   *
   * The VRM spec requires all bones to be exported with identity local rotations
   * (normalization baked into the mesh). Many community models skip this step,
   * leaving residual rotations that cause hands to face up, feet to point sideways, etc.
   *
   * These corrections are the INVERSE of the detected rest-pose deviation.
   * Apply them by premultiplying onto the solved rotation before writing to the bone:
   *   bone.quaternion.copy(correction).multiply(solvedQ)
   *
   * If a bone's rest pose is correct, its correction is identity (no-op).
   */
  restPoseCorrections: Partial<Record<string, Quaternion>>;
}

// Bone names we care about
const BONES = [
  "hips", "spine", "chest", "neck", "head",
  "leftUpperArm", "leftLowerArm", "leftHand",
  "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot",
  "rightUpperLeg", "rightLowerLeg", "rightFoot",
] as const;

const _v1 = new Vector3();
const _v2 = new Vector3();
const _q  = new Quaternion();

/** Compute the world-space position of a VRM normalised bone node by summing
 *  local positions up the chain (mirrors XR Animator's para.pos0 logic). */
function worldPos(vrm: VRM, boneName: string): Vector3 | null {
  const node = vrm.humanoid.getNormalizedBoneNode(boneName as VRMHumanBoneName);
  if (!node) return null;

  // three-vrm normalised bones already expose world position after scene update
  const wp = new Vector3();
  node.getWorldPosition(wp);
  return wp;
}

/**
 * Detect rest-pose correction quaternions for arm, hand, and foot bones.
 *
 * The VRM T-pose spec + three-vrm normalized space defines:
 *   - leftUpperArm / rightUpperArm:
 *       local +Z should point toward camera (-Z world).
 *       Kalidokit drives raise/lower via UpperArm.z (rotation around local Z).
 *       If local Z is flipped (+Z world), the raise direction is inverted —
 *       raising your arm makes the model drop its arm.
 *   - leftHand / rightHand:  palm faces DOWN (local +Y → -Y world)
 *   - leftFoot / rightFoot:  toes point forward, not sideways
 *
 * The correction is applied as:  finalQ = correction × solvedQ
 */
function detectRestPoseCorrections(vrm: VRM): Partial<Record<string, Quaternion>> {
  const corrections: Partial<Record<string, Quaternion>> = {};

  vrm.scene.updateMatrixWorld(true);

  // ── UpperArm Z-axis check ───────────────────────────────────────────────────
  // In three-vrm normalized space, the UpperArm's local +Z should point toward
  // the camera (-Z world). Kalidokit's UpperArm.z rotation raises/lowers the arm
  // around this axis. If local +Z points away from camera (+Z world), the rotation
  // is inverted — raising your arm makes the model drop its arm.
  for (const [boneName] of [
    ["leftUpperArm"] as const,
    ["rightUpperArm"] as const,
  ]) {
    const boneNode = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!boneNode) continue;

    const worldQ = new Quaternion();
    boneNode.getWorldQuaternion(worldQ);

    // Local +Z in world space — should point toward camera (negative Z world)
    const localZ = new Vector3(0, 0, 1).applyQuaternion(worldQ);

    // If localZ.z > 0.3, the bone's Z axis is pointing away — inversion needed
    if (localZ.z > 0.3) {
      // 180° around the arm's outward axis (local +X direction in world space)
      const localX = new Vector3(1, 0, 0).applyQuaternion(worldQ);
      const correction = new Quaternion().setFromAxisAngle(localX, Math.PI);
      corrections[boneName] = correction;
    }
  }

  // ── Hand palm orientation check ─────────────────────────────────────────────
  // In a correct VRM T-pose, the palm faces down: the hand bone's local +Y axis
  // points in the -Y world direction (palm down = back of hand faces up).
  // If it points +Y (palm up), we need a 180° correction around the forearm axis.
  for (const [boneName, forearmName, sign] of [
    ["leftHand",  "leftLowerArm",  1] as const,
    ["rightHand", "rightLowerArm", -1] as const,
  ]) {
    const handNode = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!handNode) continue;

    const worldQ = new Quaternion();
    handNode.getWorldQuaternion(worldQ);

    const palmNormal = new Vector3(0, 1, 0).applyQuaternion(worldQ);

    if (palmNormal.y > 0.5) {
      const lowerArmNode = vrm.humanoid.getNormalizedBoneNode(forearmName);
      const handPos = new Vector3();
      const lowerArmPos = new Vector3();
      handNode.getWorldPosition(handPos);
      if (lowerArmNode) lowerArmNode.getWorldPosition(lowerArmPos);

      const forearmAxis = handPos.clone().sub(lowerArmPos).normalize();
      if (forearmAxis.lengthSq() < 0.01) forearmAxis.set(sign, 0, 0);

      const correction = new Quaternion().setFromAxisAngle(forearmAxis, Math.PI);
      corrections[boneName] = correction;
    }
  }

  // ── Foot orientation check ──────────────────────────────────────────────────
  for (const boneName of ["leftFoot", "rightFoot"] as const) {
    const footNode = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!footNode) continue;

    const worldQ = new Quaternion();
    footNode.getWorldQuaternion(worldQ);

    const footForward = new Vector3(0, 0, 1).applyQuaternion(worldQ);

    if (Math.abs(footForward.x) > 0.7) {
      const angle = Math.atan2(footForward.x, footForward.z) * -1;
      const correction = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle);
      corrections[boneName] = correction;
    }
  }

  return corrections;
}

export function computeTPosePara(vrm: VRM): TPosePara {
  // Ensure the scene matrices are current (safe to call at model load)
  vrm.scene.updateMatrixWorld(true);

  const pos0: TPosePara["pos0"] = {};
  for (const name of BONES) {
    const wp = worldPos(vrm, name);
    if (wp) pos0[name] = [wp.x, wp.y, wp.z];
  }

  // ── Shoulder width (X distance, world space) ────────────────────────────────
  // XR Animator MMD_SA.js:9123
  const lsh = pos0["leftUpperArm"]  ?? [0, 0, 0];
  const rsh = pos0["rightUpperArm"] ?? [0, 0, 0];
  const shoulderWidth = Math.abs(lsh[0] - rsh[0]);

  // ── Arm lengths (shoulder → wrist) ─────────────────────────────────────────
  // XR Animator MMD_SA.js:9124
  function dist(a?: [number,number,number], b?: [number,number,number]): number {
    if (!a || !b) return 1;
    return Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
  }
  const leftArmLength  = dist(pos0["leftUpperArm"],  pos0["leftHand"]);
  const rightArmLength = dist(pos0["rightUpperArm"], pos0["rightHand"]);

  // ── Forearm longitudinal axes ───────────────────────────────────────────────
  // XR Animator MMD_SA.js:9140–9143
  // "The unit vector from LowerArm origin toward Hand origin in T-pose."
  function forearmAxis(lowerArm?: [number,number,number], hand?: [number,number,number]): Vector3 {
    if (!lowerArm || !hand) return new Vector3(1, 0, 0);
    return _v1.set(hand[0] - lowerArm[0], hand[1] - lowerArm[1], hand[2] - lowerArm[2]).normalize().clone();
  }
  const leftForearmAxis  = forearmAxis(pos0["leftLowerArm"],  pos0["leftHand"]);
  const rightForearmAxis = forearmAxis(pos0["rightLowerArm"], pos0["rightHand"]);

  // ── spine_to_hips_ratio ─────────────────────────────────────────────────────
  // XR Animator MMD_SA.js:9147
  const hasChest = !!vrm.humanoid.getNormalizedBoneNode("chest");
  let spineToHipsRatio = 0;
  if (!hasChest) {
    const neck  = pos0["neck"]         ?? [0, 1.5, 0];
    const spine = pos0["spine"]        ?? [0, 1.0, 0];
    const hips  = pos0["hips"]         ?? [0, 0.9, 0];
    const neckY  = neck[1];
    const spineY = spine[1];
    const hipsY  = hips[1];
    const ratio = (neckY - hipsY) > 0
      ? 1 - Math.max(0, Math.min(1, (neckY - spineY) / (neckY - hipsY) * 2))
      : 0;
    spineToHipsRatio = ratio;
  }

  // ── VRM version ─────────────────────────────────────────────────────────────
  const isVRM1 = parseInt((vrm.meta as { metaVersion?: string }).metaVersion ?? "0") > 0;

  // ── Rest-pose corrections ───────────────────────────────────────────────────
  const restPoseCorrections = detectRestPoseCorrections(vrm);

  return {
    pos0,
    shoulderWidth: shoulderWidth || 0.3,
    leftArmLength: leftArmLength || 0.5,
    rightArmLength: rightArmLength || 0.5,
    leftForearmAxis,
    rightForearmAxis,
    spineToHipsRatio,
    isVRM1,
    restPoseCorrections,
  };
}

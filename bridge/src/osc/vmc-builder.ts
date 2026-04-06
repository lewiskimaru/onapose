import { eulerToQuat } from "../math/euler-to-quat";
import type { MocapFrame, EulerRotation } from "@onapose/shared";

export interface OscMessage {
  address: string;
  args: Array<{ type: string; value: number | string }>;
}

// ---------------------------------------------------------------------------
// Coordinate system conversion: Three.js (right-handed, Y-up) → Unity (left-handed, Y-up)
//
// XR Animator applies this on every bone before sending OSC.
// Required so VRM4U / VSeeFace receive rotations in the correct handedness.
//
//   position: negate Z
//   quaternion: negate X and Y   (equivalent to conjugating the imaginary XY parts)
// ---------------------------------------------------------------------------

const IDENTITY: EulerRotation = { x: 0, y: 0, z: 0 };

/**
 * Builds a /VMC/Ext/Bone/Pos message with the Three.js → Unity axis conversion applied.
 * Position defaults to (0, 0, 0) — correct for non-root bones in local space.
 */
function boneMessage(
  boneName: string,
  rotation: EulerRotation,
  position = { x: 0, y: 0, z: 0 }
): OscMessage {
  const q = eulerToQuat(rotation);
  return {
    address: "/VMC/Ext/Bone/Pos",
    args: [
      { type: "s", value: boneName },
      // Position: negate Z for Unity left-handed space
      { type: "f", value: position.x },
      { type: "f", value: position.y },
      { type: "f", value: -position.z },
      // Quaternion: negate X and Y for Unity left-handed space
      { type: "f", value: -q.x },
      { type: "f", value: -q.y },
      { type: "f", value: q.z },
      { type: "f", value: q.w },
    ],
  };
}

/**
 * Builds a /VMC/Ext/Bone/Pos message with an identity quaternion (0,0,0,1).
 * Used for bones that are tracked but have no live data this frame,
 * so VRM4U sees the bind-pose rather than a frozen stale rotation.
 */
function identityBoneMessage(boneName: string): OscMessage {
  return {
    address: "/VMC/Ext/Bone/Pos",
    args: [
      { type: "s", value: boneName },
      { type: "f", value: 0 }, // px
      { type: "f", value: 0 }, // py
      { type: "f", value: 0 }, // pz
      { type: "f", value: 0 }, // qx
      { type: "f", value: 0 }, // qy
      { type: "f", value: 0 }, // qz
      { type: "f", value: 1 }, // qw  (identity)
    ],
  };
}

function blendMessage(name: string, value: number): OscMessage {
  return {
    address: "/VMC/Ext/Blend/Val",
    args: [
      { type: "s", value: name },
      { type: "f", value },
    ],
  };
}

// ---------------------------------------------------------------------------
// VRM0 thumb bone renaming
//
// Kalidokit / three-vrm outputs VRM1 thumb names. VRM4U expects VRM0 names:
//   ThumbMetacarpal  → ThumbProximal       (VRM0 has no Metacarpal)
//   ThumbProximal    → ThumbIntermediate   (VRM0 Proximal is VRM1 Metacarpal's child)
// ---------------------------------------------------------------------------
const VRM0_THUMB_REMAP: Record<string, string> = {
  LeftThumbMetacarpal: "leftThumbProximal",
  LeftThumbProximal: "leftThumbIntermediate",
  RightThumbMetacarpal: "rightThumbProximal",
  RightThumbProximal: "rightThumbIntermediate",
};

/**
 * Converts a raw Kalidokit hand-bone key to the VRM0 camelCase name expected by VRM4U:
 *   1. Applies the VRM0 thumb remap if relevant.
 *   2. Otherwise lowercases the first character (PascalCase → camelCase).
 *   3. Remaps "LeftWrist" / "RightWrist" → "leftHand" / "rightHand".
 */
function toVrm0BoneName(kalidokitKey: string): string {
  if (kalidokitKey === "LeftWrist") return "leftHand";
  if (kalidokitKey === "RightWrist") return "rightHand";
  if (kalidokitKey in VRM0_THUMB_REMAP) return VRM0_THUMB_REMAP[kalidokitKey];
  // Generic PascalCase → camelCase
  return kalidokitKey.charAt(0).toLowerCase() + kalidokitKey.slice(1);
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Converts a MocapFrame into a fully VMC-spec-compliant array of OscMessages.
 *
 * Message order matches XR Animator's send order:
 *   1. /VMC/Ext/Root/Pos  — root world transform
 *   2. /VMC/Ext/Bone/Pos  — all humanoid bones (one per message)
 *   3. /VMC/Ext/Blend/Val — per-expression weights  (VRM0 preset names)
 *   4. /VMC/Ext/Blend/Apply — commits the blend batch (no args, required)
 *   5. /VMC/Ext/OK         — frame-complete heartbeat (int 1, required)
 */
export function buildVmcMessages(frame: MocapFrame): OscMessage[] {
  const messages: OscMessage[] = [];
  const { riggedPose, riggedFace, riggedLeftHand, riggedRightHand } = frame;

  // ── 1. Root ──────────────────────────────────────────────────────────────
  // Name must be "root" (VMC spec-defined literal). VRM4U ignores the packet
  // if any other string is used.
  const hipsQ = eulerToQuat(riggedPose.Hips.rotation);
  messages.push({
    address: "/VMC/Ext/Root/Pos",
    args: [
      { type: "s", value: "root" },                           // spec-required literal
      { type: "f", value: riggedPose.Hips.position.x },
      { type: "f", value: riggedPose.Hips.position.y },
      { type: "f", value: -riggedPose.Hips.position.z },     // negate Z
      { type: "f", value: -hipsQ.x },                        // negate qX
      { type: "f", value: -hipsQ.y },                        // negate qY
      { type: "f", value: hipsQ.z },
      { type: "f", value: hipsQ.w },
    ],
  });

  // ── 2. Body bones (VRM0 camelCase names) ─────────────────────────────────
  // All names use camelCase VRM0 convention (e.g. "leftUpperArm", not "LeftUpperArm").
  // VRM4U does a case-sensitive lookup — PascalCase names are silently dropped.

  // Hips bone (local rotation, position already handled by Root/Pos above)
  messages.push(boneMessage("hips", riggedPose.Hips.rotation));

  // Spine chain
  messages.push(boneMessage("spine", riggedPose.Spine));
  if (riggedPose.Chest) messages.push(boneMessage("chest", riggedPose.Chest));
  // upperChest — emit identity so VRM4U doesn't freeze it at bind pose
  messages.push(identityBoneMessage("upperChest"));

  // Neck + Head
  // riggedFace.head is the face solver's head rotation; map it to both bones.
  // "neck" carries the orientation, "head" fine-tunes it on top.
  messages.push(boneMessage("neck", riggedFace.head));
  messages.push(boneMessage("head", riggedFace.head));

  // Shoulders — Kalidokit Pose doesn't solve shoulder abduction; emit identity
  // so the VRM shoulder compensation rig remains at its neutral position.
  messages.push(identityBoneMessage("leftShoulder"));
  messages.push(identityBoneMessage("rightShoulder"));

  // Arms
  messages.push(boneMessage("leftUpperArm", riggedPose.LeftUpperArm));
  messages.push(boneMessage("leftLowerArm", riggedPose.LeftLowerArm));
  messages.push(boneMessage("rightUpperArm", riggedPose.RightUpperArm));
  messages.push(boneMessage("rightLowerArm", riggedPose.RightLowerArm));

  // Wrists — Kalidokit Pose only gives a single Z-axis wrist roll; use that
  // if present, otherwise emit identity.
  // The full wrist rotation comes from the Hand solver below ("LeftWrist" key).
  // We emit identity here and let the hand loop overwrite via "leftHand".
  messages.push(identityBoneMessage("leftHand"));
  messages.push(identityBoneMessage("rightHand"));

  // Legs
  messages.push(boneMessage("leftUpperLeg", riggedPose.LeftUpperLeg));
  messages.push(boneMessage("leftLowerLeg", riggedPose.LeftLowerLeg));
  messages.push(boneMessage("rightUpperLeg", riggedPose.RightUpperLeg));
  messages.push(boneMessage("rightLowerLeg", riggedPose.RightLowerLeg));

  // Feet + Toes — no solver data; emit identity
  messages.push(identityBoneMessage("leftFoot"));
  messages.push(identityBoneMessage("rightFoot"));
  messages.push(identityBoneMessage("leftToes"));
  messages.push(identityBoneMessage("rightToes"));

  // Eyes + Jaw — no solver data; emit identity
  messages.push(identityBoneMessage("leftEye"));
  messages.push(identityBoneMessage("rightEye"));
  messages.push(identityBoneMessage("jaw"));

  // ── 3. Hand fingers ──────────────────────────────────────────────────────
  // Kalidokit Hand.solve() returns PascalCase keys (e.g. "LeftThumbProximal").
  // toVrm0BoneName() converts them to VRM0 camelCase and applies the thumb remap.
  // "LeftWrist" / "RightWrist" keys are remapped to "leftHand" / "rightHand"
  // so the wrist rotation from the hand solver overwrites the identity placeholder above.

  for (const [rawKey, rotation] of Object.entries(riggedLeftHand)) {
    if (rotation && typeof rotation === "object" && "x" in rotation) {
      messages.push(boneMessage(toVrm0BoneName(rawKey), rotation as EulerRotation));
    }
  }

  for (const [rawKey, rotation] of Object.entries(riggedRightHand)) {
    if (rotation && typeof rotation === "object" && "x" in rotation) {
      messages.push(boneMessage(toVrm0BoneName(rawKey), rotation as EulerRotation));
    }
  }

  // ── 4. Blend shapes (VRM0 preset names) ──────────────────────────────────
  // VRM4U parses VRM0 preset names by default. VRM1 names ("aa", "blinkLeft", etc.)
  // are not recognised in a standard VRM0 + VRM4U setup.
  messages.push(blendMessage("a", riggedFace.mouth.shape.A));
  messages.push(blendMessage("i", riggedFace.mouth.shape.I));
  messages.push(blendMessage("e", riggedFace.mouth.shape.E));
  messages.push(blendMessage("o", riggedFace.mouth.shape.O));
  messages.push(blendMessage("u", riggedFace.mouth.shape.U));
  // Eye openness from Kalidokit is 0=closed, 1=open; VMC blink is 1=closed, 0=open.
  messages.push(blendMessage("blink_l", 1 - riggedFace.eye.l));
  messages.push(blendMessage("blink_r", 1 - riggedFace.eye.r));

  // ── 5. Blend/Apply — commit the blend batch ───────────────────────────────
  // Required by the VMC spec. Without this, blend shapes may never visually update
  // in VRM4U / VSeeFace because the receiver waits for the batch-commit signal.
  messages.push({
    address: "/VMC/Ext/Blend/Apply",
    args: [],
  });

  // ── 6. OK — frame-complete heartbeat ─────────────────────────────────────
  // VRM4U polls /VMC/Ext/OK to confirm a sender is active. Without it the
  // receiver stays in "disconnected" state and ignores all pose data.
  messages.push({
    address: "/VMC/Ext/OK",
    args: [{ type: "i", value: 1 }],
  });

  return messages;
}

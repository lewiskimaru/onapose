import { eulerToQuat } from "../math/euler-to-quat";
import type { MocapFrame, EulerRotation } from "@onapose/shared";

export interface OscMessage {
  address: string;
  args: Array<{ type: string; value: number | string }>;
}

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
      { type: "f", value: position.x },
      { type: "f", value: position.y },
      { type: "f", value: position.z },
      { type: "f", value: q.x },
      { type: "f", value: q.y },
      { type: "f", value: q.z },
      { type: "f", value: q.w },
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

/**
 * Converts a MocapFrame into an array of VMC-spec OSC messages.
 * One message per bone (/VMC/Ext/Bone/Pos) and per blend shape (/VMC/Ext/Blend/Val).
 */
export function buildVmcMessages(frame: MocapFrame): OscMessage[] {
  const messages: OscMessage[] = [];
  const { riggedPose, riggedFace, riggedLeftHand, riggedRightHand } = frame;

  // Root bone with position
  const hipsQ = eulerToQuat(riggedPose.Hips.rotation);
  messages.push({
    address: "/VMC/Ext/Root/Pos",
    args: [
      { type: "s", value: "Hips" },
      { type: "f", value: riggedPose.Hips.position.x },
      { type: "f", value: riggedPose.Hips.position.y },
      { type: "f", value: -riggedPose.Hips.position.z }, // Z negated for Three.js convention
      { type: "f", value: hipsQ.x },
      { type: "f", value: hipsQ.y },
      { type: "f", value: hipsQ.z },
      { type: "f", value: hipsQ.w },
    ],
  });

  // Body bones
  messages.push(boneMessage("Spine", riggedPose.Spine));
  if (riggedPose.Chest) messages.push(boneMessage("Chest", riggedPose.Chest));
  messages.push(boneMessage("LeftUpperArm", riggedPose.LeftUpperArm));
  messages.push(boneMessage("LeftLowerArm", riggedPose.LeftLowerArm));
  messages.push(boneMessage("RightUpperArm", riggedPose.RightUpperArm));
  messages.push(boneMessage("RightLowerArm", riggedPose.RightLowerArm));
  messages.push(boneMessage("LeftUpperLeg", riggedPose.LeftUpperLeg));
  messages.push(boneMessage("LeftLowerLeg", riggedPose.LeftLowerLeg));
  messages.push(boneMessage("RightUpperLeg", riggedPose.RightUpperLeg));
  messages.push(boneMessage("RightLowerLeg", riggedPose.RightLowerLeg));

  // Head
  messages.push(boneMessage("Neck", riggedFace.head));

  // Left hand fingers
  for (const [boneName, rotation] of Object.entries(riggedLeftHand)) {
    if (rotation && typeof rotation === "object" && "x" in rotation) {
      messages.push(boneMessage(boneName, rotation as EulerRotation));
    }
  }

  // Right hand fingers
  for (const [boneName, rotation] of Object.entries(riggedRightHand)) {
    if (rotation && typeof rotation === "object" && "x" in rotation) {
      messages.push(boneMessage(boneName, rotation as EulerRotation));
    }
  }

  // Blend shapes
  messages.push(blendMessage("aa", riggedFace.mouth.shape.A));
  messages.push(blendMessage("ih", riggedFace.mouth.shape.I));
  messages.push(blendMessage("ee", riggedFace.mouth.shape.E));
  messages.push(blendMessage("oh", riggedFace.mouth.shape.O));
  messages.push(blendMessage("ou", riggedFace.mouth.shape.U));
  messages.push(blendMessage("blinkLeft", 1 - riggedFace.eye.l));
  messages.push(blendMessage("blinkRight", 1 - riggedFace.eye.r));

  return messages;
}

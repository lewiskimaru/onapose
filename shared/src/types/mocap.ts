/**
 * Euler rotation angles in radians, as output by Kalidokit solvers.
 */
export interface EulerRotation {
  x: number;
  y: number;
  z: number;
}

/**
 * 3D position in world space (meters, hip-relative).
 */
export interface Position3D {
  x: number;
  y: number;
  z: number;
}

/**
 * Hips bone carries both position and rotation.
 */
export interface HipsPose {
  position: Position3D;
  rotation: EulerRotation;
}

/**
 * Full body pose as output by Kalidokit Pose.solve().
 * All values are Euler angles in radians except Hips.position.
 */
export interface RiggedPose {
  Hips: HipsPose;
  Spine: EulerRotation;
  Chest?: EulerRotation;
  RightUpperArm: EulerRotation;
  RightLowerArm: EulerRotation;
  LeftUpperArm: EulerRotation;
  LeftLowerArm: EulerRotation;
  /** Only Z axis is reliable from pose landmarks alone. */
  RightHand: { z: number };
  /** Only Z axis is reliable from pose landmarks alone. */
  LeftHand: { z: number };
  RightUpperLeg: EulerRotation;
  RightLowerLeg: EulerRotation;
  LeftUpperLeg: EulerRotation;
  LeftLowerLeg: EulerRotation;
}

/**
 * Hand pose as output by Kalidokit Hand.solve().
 * Prefix matches the side passed to the solver ("Left" or "Right").
 */
export interface RiggedHand {
  [boneName: string]: EulerRotation;
}

/**
 * Mouth vowel blend shape values, 0 to 1.
 */
export interface MouthShape {
  A: number;
  E: number;
  I: number;
  O: number;
  U: number;
}

/**
 * Face data as output by Kalidokit Face.solve().
 */
export interface RiggedFace {
  head: EulerRotation;
  eye: { l: number; r: number };
  pupil: { x: number; y: number };
  mouth: {
    x: number;
    y: number;
    shape: MouthShape;
  };
}

/**
 * The full mocap frame sent from the browser client to the bridge
 * over WebSocket every time MediaPipe produces a result.
 */
export interface MocapFrame {
  riggedPose: RiggedPose;
  riggedFace: RiggedFace;
  riggedLeftHand: RiggedHand;
  riggedRightHand: RiggedHand;
  /** Unix timestamp (ms) when the frame was solved in the browser. */
  timestamp: number;
}

import { Euler, Quaternion } from "three";
import type { EulerRotation } from "@onapose/shared";

const _euler = new Euler();
const _quat = new Quaternion();

/**
 * Converts a Kalidokit Euler rotation (radians) to a Three.js Quaternion.
 * Reuses a single Euler/Quaternion instance — do not hold references to the return value.
 * Clone if you need to store it.
 */
export function eulerToQuat(rotation: EulerRotation): {
  x: number;
  y: number;
  z: number;
  w: number;
} {
  _euler.set(rotation.x, rotation.y, rotation.z, "XYZ");
  _quat.setFromEuler(_euler);
  return { x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w };
}

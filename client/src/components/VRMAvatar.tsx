import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Face, Hand, Pose } from "kalidokit";
import { useCallback, useEffect, useRef } from "react";
import { Euler, Object3D, Quaternion, Vector3 } from "three";
import { lerp } from "three/src/math/MathUtils.js";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { useWebSocket } from "../hooks/useWebSocket";
import { useBridgeTelemetry } from "../hooks/useBridgeTelemetry";
import type { MocapFrame, RiggedFace, RiggedPose, RiggedHand } from "@onapose/shared";

// Allocated once at module level — avoids per-frame GC pressure
const tmpQuat = new Quaternion();
const tmpEuler = new Euler();

interface VRMAvatarProps {
  modelPath: string;
}

export function VRMAvatar({ modelPath }: VRMAvatarProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { scene, userData } = useGLTF(modelPath, undefined, undefined, (loader: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loader.register((parser: any) => new VRMLoaderPlugin(parser));
  });

  const currentVrm = userData.vrm;

  const { camera } = useThree();
  const { send } = useWebSocket();
  const recordFrame = useBridgeTelemetry((s) => s.recordFrame);

  const setResultsCallback = useVideoRecognition((state) => state.setResultsCallback);
  const videoElement = useVideoRecognition((state) => state.videoElement);

  // Per-frame solved data — stored in refs, never in state (no re-renders)
  const riggedFace = useRef<RiggedFace | undefined>(undefined);
  const riggedPose = useRef<RiggedPose | undefined>(undefined);
  const riggedLeftHand = useRef<RiggedHand | undefined>(undefined);
  const riggedRightHand = useRef<RiggedHand | undefined>(undefined);

  // Eye look-at
  const lookAtDestination = useRef(new Vector3(0, 0, 0));
  const lookAtTarget = useRef<Object3D | undefined>(undefined);

  useEffect(() => {
    const vrm = userData.vrm;
    if (!vrm) return;
    console.log("[vrm] loaded:", vrm);
    VRMUtils.removeUnnecessaryVertices(scene);
    VRMUtils.combineSkeletons(scene);
    VRMUtils.combineMorphs(vrm);
    vrm.scene.traverse((obj: Object3D) => {
      obj.frustumCulled = false;
    });
    // VRM0 faces away from camera; VRM1 faces toward camera
    if (vrm.meta?.metaVersion === "0") {
      vrm.scene.rotation.y = Math.PI;
    }
  }, [scene, userData.vrm]);

  useEffect(() => {
    const target = new Object3D();
    camera.add(target);
    lookAtTarget.current = target;
    return () => { camera.remove(target); };
  }, [camera]);

  // Kalidokit solving — called directly from MediaPipe results, exactly as the reference does
  const resultsCallback = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (results: any) => {
      if (!videoElement || !currentVrm) return;

      if (results.faceLandmarks) {
        riggedFace.current = Face.solve(results.faceLandmarks, {
          runtime: "mediapipe",
          video: videoElement,
          imageSize: { width: 640, height: 480 },
          smoothBlink: false,
          blinkSettings: [0.25, 0.75],
        }) as RiggedFace;
      }

      if (results.za && results.poseLandmarks) {
        riggedPose.current = Pose.solve(results.za, results.poseLandmarks, {
          runtime: "mediapipe",
          video: videoElement,
        }) as RiggedPose;
      }

      // Mirror swap: MediaPipe "left" = performer's right when facing camera
      if (results.leftHandLandmarks) {
        riggedRightHand.current = Hand.solve(results.leftHandLandmarks, "Right") as RiggedHand;
      }
      if (results.rightHandLandmarks) {
        riggedLeftHand.current = Hand.solve(results.rightHandLandmarks, "Left") as RiggedHand;
      }

      // Send frame to bridge when we have at minimum pose + face
      if (riggedPose.current && riggedFace.current) {
        const frame: MocapFrame = {
          riggedPose: riggedPose.current,
          riggedFace: riggedFace.current,
          riggedLeftHand: riggedLeftHand.current ?? {},
          riggedRightHand: riggedRightHand.current ?? {},
          timestamp: Date.now(),
        };
        send(frame);
        recordFrame(frame);
      }
    },
    [videoElement, currentVrm, send, recordFrame]
  );

  useEffect(() => {
    setResultsCallback(resultsCallback);
  }, [resultsCallback, setResultsCallback]);

  const lerpExpression = (name: string, value: number, lerpFactor: number) => {
    userData.vrm.expressionManager.setValue(
      name,
      lerp(userData.vrm.expressionManager.getValue(name), value, lerpFactor)
    );
  };

  const rotateBone = (
    boneName: string,
    value: { x: number; y: number; z: number },
    slerpFactor: number,
    flip = { x: 1, y: 1, z: 1 }
  ) => {
    const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!bone) {
      console.warn(`[vrm] bone not found: ${boneName}`);
      return;
    }
    tmpEuler.set(value.x * flip.x, value.y * flip.y, value.z * flip.z);
    tmpQuat.setFromEuler(tmpEuler);
    bone.quaternion.slerp(tmpQuat, slerpFactor);
  };

  useFrame((_, delta) => {
    if (!userData.vrm) return;

    if (riggedFace.current) {
      [
        { name: "aa",         value: riggedFace.current.mouth.shape.A },
        { name: "ih",         value: riggedFace.current.mouth.shape.I },
        { name: "ee",         value: riggedFace.current.mouth.shape.E },
        { name: "oh",         value: riggedFace.current.mouth.shape.O },
        { name: "ou",         value: riggedFace.current.mouth.shape.U },
        { name: "blinkLeft",  value: 1 - riggedFace.current.eye.l },
        { name: "blinkRight", value: 1 - riggedFace.current.eye.r },
      ].forEach((item) => lerpExpression(item.name, item.value, delta * 12));

      if (lookAtTarget.current && riggedFace.current.pupil) {
        userData.vrm.lookAt.target = lookAtTarget.current;
        lookAtDestination.current.set(
          -2 * riggedFace.current.pupil.x,
          2 * riggedFace.current.pupil.y,
          0
        );
        lookAtTarget.current.position.lerp(lookAtDestination.current, delta * 5);
      }

      rotateBone("neck", riggedFace.current.head, delta * 5, { x: 0.7, y: 0.7, z: 0.7 });
    }

    if (riggedPose.current) {
      rotateBone("chest", riggedPose.current.Spine, delta * 5, { x: 0.3, y: 0.3, z: 0.3 });
      rotateBone("spine", riggedPose.current.Spine, delta * 5, { x: 0.3, y: 0.3, z: 0.3 });
      rotateBone("hips",  riggedPose.current.Hips.rotation, delta * 5, { x: 0.7, y: 0.7, z: 0.7 });

      rotateBone("leftUpperArm",  riggedPose.current.LeftUpperArm,  delta * 5);
      rotateBone("leftLowerArm",  riggedPose.current.LeftLowerArm,  delta * 5);
      rotateBone("rightUpperArm", riggedPose.current.RightUpperArm, delta * 5);
      rotateBone("rightLowerArm", riggedPose.current.RightLowerArm, delta * 5);

      rotateBone("leftUpperLeg",  riggedPose.current.LeftUpperLeg,  delta * 5);
      rotateBone("leftLowerLeg",  riggedPose.current.LeftLowerLeg,  delta * 5);
      rotateBone("rightUpperLeg", riggedPose.current.RightUpperLeg, delta * 5);
      rotateBone("rightLowerLeg", riggedPose.current.RightLowerLeg, delta * 5);

      if (riggedLeftHand.current) {
        rotateBone("leftHand", {
          z: riggedPose.current.LeftHand.z,
          y: riggedLeftHand.current.LeftWrist.y,
          x: riggedLeftHand.current.LeftWrist.x,
        }, delta * 12);
        rotateBone("leftRingProximal",        riggedLeftHand.current.LeftRingProximal,        delta * 12);
        rotateBone("leftRingIntermediate",    riggedLeftHand.current.LeftRingIntermediate,    delta * 12);
        rotateBone("leftRingDistal",          riggedLeftHand.current.LeftRingDistal,          delta * 12);
        rotateBone("leftIndexProximal",       riggedLeftHand.current.LeftIndexProximal,       delta * 12);
        rotateBone("leftIndexIntermediate",   riggedLeftHand.current.LeftIndexIntermediate,   delta * 12);
        rotateBone("leftIndexDistal",         riggedLeftHand.current.LeftIndexDistal,         delta * 12);
        rotateBone("leftMiddleProximal",      riggedLeftHand.current.LeftMiddleProximal,      delta * 12);
        rotateBone("leftMiddleIntermediate",  riggedLeftHand.current.LeftMiddleIntermediate,  delta * 12);
        rotateBone("leftMiddleDistal",        riggedLeftHand.current.LeftMiddleDistal,        delta * 12);
        rotateBone("leftThumbProximal",       riggedLeftHand.current.LeftThumbProximal,       delta * 12);
        rotateBone("leftThumbMetacarpal",     riggedLeftHand.current.LeftThumbIntermediate,   delta * 12);
        rotateBone("leftThumbDistal",         riggedLeftHand.current.LeftThumbDistal,         delta * 12);
        rotateBone("leftLittleProximal",      riggedLeftHand.current.LeftLittleProximal,      delta * 12);
        rotateBone("leftLittleIntermediate",  riggedLeftHand.current.LeftLittleIntermediate,  delta * 12);
        rotateBone("leftLittleDistal",        riggedLeftHand.current.LeftLittleDistal,        delta * 12);
      }

      if (riggedRightHand.current) {
        rotateBone("rightHand", {
          z: riggedPose.current.RightHand.z,
          y: riggedRightHand.current.RightWrist.y,
          x: riggedRightHand.current.RightWrist.x,
        }, delta * 12);
        rotateBone("rightRingProximal",       riggedRightHand.current.RightRingProximal,       delta * 12);
        rotateBone("rightRingIntermediate",   riggedRightHand.current.RightRingIntermediate,   delta * 12);
        rotateBone("rightRingDistal",         riggedRightHand.current.RightRingDistal,         delta * 12);
        rotateBone("rightIndexProximal",      riggedRightHand.current.RightIndexProximal,      delta * 12);
        rotateBone("rightIndexIntermediate",  riggedRightHand.current.RightIndexIntermediate,  delta * 12);
        rotateBone("rightIndexDistal",        riggedRightHand.current.RightIndexDistal,        delta * 12);
        rotateBone("rightMiddleProximal",     riggedRightHand.current.RightMiddleProximal,     delta * 12);
        rotateBone("rightMiddleIntermediate", riggedRightHand.current.RightMiddleIntermediate, delta * 12);
        rotateBone("rightMiddleDistal",       riggedRightHand.current.RightMiddleDistal,       delta * 12);
        rotateBone("rightThumbProximal",      riggedRightHand.current.RightThumbProximal,      delta * 12);
        rotateBone("rightThumbMetacarpal",    riggedRightHand.current.RightThumbIntermediate,  delta * 12);
        rotateBone("rightThumbDistal",        riggedRightHand.current.RightThumbDistal,        delta * 12);
        rotateBone("rightLittleProximal",     riggedRightHand.current.RightLittleProximal,     delta * 12);
        rotateBone("rightLittleIntermediate", riggedRightHand.current.RightLittleIntermediate, delta * 12);
        rotateBone("rightLittleDistal",       riggedRightHand.current.RightLittleDistal,       delta * 12);
      }
    }

    // Must be last — runs spring bone physics
    userData.vrm.update(delta);
  });

  return (
    <group>
      <primitive object={scene} />
    </group>
  );
}

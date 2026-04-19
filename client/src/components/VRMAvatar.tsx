/**
 * VRMAvatar — dual solver backend with full debug instrumentation.
 *
 * Solver backends:
 *   "kalidokit"  — Kalidokit + OEF upstream + palm-normal roll
 *   "custom"     — XR Animator-style: setFromUnitVectors arm solver,
 *                  YZX wrist roll, 3D finger solving
 *
 * Known coordinate conventions (verified from Kalidokit source):
 *   - za (poseWorldLandmarks): MediaPipe world space — Y is DOWN (y=0 head, y>0 feet)
 *     Kalidokit uses these landmarks WITHOUT Y-negation.
 *   - poseLandmarks: normalised [0,1] image space — Y is DOWN.
 *
 * Bug fixes in this revision:
 *   1. HEAD TWITCHING: maintain prevNeckQ ref; slerp from previous value, not from
 *      T-pose (which resetNormalizedPose() would return to each frame).
 *   2. Y-FLIP REMOVED: za world landmarks are Y-down; our custom solver now treats
 *      them the same way Kalidokit does — no negation.
 *   3. HAND OEF BETA: changed from 0.001 (glacial) to 0.1 (responsive).
 */

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
import { OneEuroFilter } from "../lib/one-euro-filter";
import { computeTPosePara, type TPosePara } from "../solvers/tPosePrecompute";
import { solveUpperArm, solveLowerArm, buildUpperBodyInvQ } from "../solvers/armSolver";
import { solveBodyRotation } from "../solvers/bodySolver";
import { solveHand } from "../solvers/handSolver";
import { solveWristRoll, type WristRollState } from "../solvers/wristRoll";
import { usePanelState } from "../hooks/usePanelState";
import {
  useDebugStore, throttle,
  type DebugFrame, type LandmarkSnapshot, type SolverSnapshot, type FilterSnapshot, type HeadSnapshot,
} from "../hooks/useDebugStore";

// ─── One Euro Filter defaults ─────────────────────────────────────────────────
const OEF_FREQ    = 30;
const OEF_MINCUT  = 1.0;
const OEF_BETA    = 0.5;   // pose landmarks
const OEF_DCUTOFF = 1.0;
// FIX #3: hand OEF beta 0.001 was "glacial" (too smooth = lag).
// 0.1 is responsive enough for hand tracking speed.
const OEF_HAND_BETA = 0.1;

// ─── Finger ROM clamp limits ──────────────────────────────────────────────────
const CURL_MIN   = -0.05;
const CURL_MAX   =  1.80;
const SPREAD_MIN = -0.30;
const SPREAD_MAX =  0.30;

// ─── Scratch allocations ──────────────────────────────────────────────────────
const tmpQuat   = new Quaternion();
const tmpEuler  = new Euler();
const identityQ = new Quaternion();

// ─── Types ────────────────────────────────────────────────────────────────────
type Lm = { x: number; y: number; z: number; visibility?: number };
type SolverMode = "kalidokit" | "custom";

interface VRMAvatarProps {
  modelPath: string;
  solver?: SolverMode;
}

// ─── Filter helpers ───────────────────────────────────────────────────────────

function filterLandmarks(lms: Lm[], bank: OneEuroFilter[], ts: number): Lm[] {
  while (bank.length < lms.length)
    bank.push(new OneEuroFilter(OEF_FREQ, OEF_MINCUT, OEF_BETA, OEF_DCUTOFF));
  return lms.map((lm, i) => {
    const f = bank[i].filterVec3([lm.x, lm.y, lm.z], ts);
    return { ...lm, x: f[0], y: f[1], z: f[2] };
  });
}

function filterHandLandmarks(lms: Lm[], bank: OneEuroFilter[], ts: number): Lm[] {
  while (bank.length < lms.length)
    bank.push(new OneEuroFilter(OEF_FREQ, OEF_MINCUT, OEF_HAND_BETA, OEF_DCUTOFF));
  return lms.map((lm, i) => {
    const f = bank[i].filterVec3([lm.x, lm.y, lm.z], ts);
    return { ...lm, x: f[0], y: f[1], z: f[2] };
  });
}

function clampFinger(e: { x: number; y: number; z: number }) {
  return {
    x: Math.max(CURL_MIN,   Math.min(CURL_MAX,   e.x)),
    y: Math.max(SPREAD_MIN, Math.min(SPREAD_MAX, e.y)),
    z: Math.max(CURL_MIN,   Math.min(CURL_MAX,   e.z)),
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function VRMAvatar({ modelPath, solver = "kalidokit" }: VRMAvatarProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { scene, userData } = useGLTF(modelPath, undefined, undefined, (loader: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loader.register((parser: any) => new VRMLoaderPlugin(parser));
  });

  const currentVrm = userData.vrm;
  const { camera } = useThree();
  const { send }   = useWebSocket();
  const recordFrame = useBridgeTelemetry((s) => s.recordFrame);
  const setResultsCallback = useVideoRecognition((s) => s.setResultsCallback);
  const videoElement       = useVideoRecognition((s) => s.videoElement);

  // Debug store
  const { setFrame, pushLog } = useDebugStore.getState();
  const debugThrottleRef = useRef({ value: 0 });

  // ── Solved data refs ──────────────────────────────────────────────────────
  const riggedFace      = useRef<RiggedFace | undefined>(undefined);
  const riggedPose      = useRef<RiggedPose | undefined>(undefined);
  const riggedLeftHand  = useRef<RiggedHand | undefined>(undefined);
  const riggedRightHand = useRef<RiggedHand | undefined>(undefined);

  // ── FIX #1: head twitching — persist neck rotation across resetNormalizedPose ──
  // resetNormalizedPose() resets all bones to T-pose (identity) each frame.
  // If we slerp from bone.quaternion (which is now identity), the neck snaps
  // to ~16% of target every frame from zero = twitching.
  // Fix: maintain our own "current smooth neck quaternion" and slerp that ref.
  const smoothNeckQ = useRef(new Quaternion());

  // ── Custom solver frame data ──────────────────────────────────────────────
  const customHipsQ          = useRef<Quaternion>(new Quaternion());
  const customSpineQ         = useRef<Quaternion>(new Quaternion());
  const customLeftUpperArmQ  = useRef<Quaternion>(new Quaternion());
  const customLeftLowerArmQ  = useRef<Quaternion>(new Quaternion());
  const customRightUpperArmQ = useRef<Quaternion>(new Quaternion());
  const customRightLowerArmQ = useRef<Quaternion>(new Quaternion());

  // ── Wrist roll state ──────────────────────────────────────────────────────
  const leftRollState  = useRef<WristRollState>({ angle: 0, ts: 0 }).current;
  const rightRollState = useRef<WristRollState>({ angle: 0, ts: 0 }).current;

  // Custom solver: full hand quaternion (for YZX Euler roll extraction)
  const leftHandQ  = useRef<Quaternion | null>(null);
  const rightHandQ = useRef<Quaternion | null>(null);

  // Custom solver: full finger data
  interface FingerData { fingers: { x: number; y: number; z: number }[][] }
  const leftFingerData  = useRef<FingerData | null>(null);
  const rightFingerData = useRef<FingerData | null>(null);

  // ── T-pose precomputed data ───────────────────────────────────────────────
  const tPosePara = useRef<TPosePara | null>(null);

  // ── Eye look-at ───────────────────────────────────────────────────────────
  const lookAtTarget = useRef<Object3D | undefined>(undefined);

  // ── One Euro Filter banks ─────────────────────────────────────────────────
  const poseFilterBank      = useRef<OneEuroFilter[]>([]);
  const poseWorldFilterBank = useRef<OneEuroFilter[]>([]);
  const leftHandFilterBank  = useRef<OneEuroFilter[]>([]);
  const rightHandFilterBank = useRef<OneEuroFilter[]>([]);

  // ── Model load ────────────────────────────────────────────────────────────
  useEffect(() => {
    const vrm = userData.vrm;
    if (!vrm) return;

    VRMUtils.removeUnnecessaryVertices(scene);
    VRMUtils.combineSkeletons(scene);
    VRMUtils.combineMorphs(vrm);
    vrm.scene.traverse((obj: Object3D) => { obj.frustumCulled = false; });
    if (vrm.meta?.metaVersion === "0") vrm.scene.rotation.y = Math.PI;

    const para = computeTPosePara(vrm);
    tPosePara.current = para;

    pushLog(`VRM loaded | solver=${solver} | spineToHipsRatio=${para.spineToHipsRatio.toFixed(3)} | hasChest=${para.spineToHipsRatio === 0}`);
    pushLog(`T-pose | shoulderWidth=${para.shoulderWidth.toFixed(3)} | leftArmLen=${para.leftArmLength.toFixed(3)}`);
    pushLog(`ForearmAxis L=(${para.leftForearmAxis.toArray().map((v: number)=>v.toFixed(2)).join(',')}) R=(${para.rightForearmAxis.toArray().map((v: number)=>v.toFixed(2)).join(',')})`);
    const corrected = Object.keys(para.restPoseCorrections);
    if (corrected.length > 0) {
      pushLog(`RestPoseCorrections applied to: ${corrected.join(', ')}`);
    } else {
      pushLog(`RestPoseCorrections: none needed (model normalized correctly)`);
    }
    // Reset state on new model load
    smoothNeckQ.current.identity();
    poseFilterBank.current      = [];
    poseWorldFilterBank.current = [];
    leftHandFilterBank.current  = [];
    rightHandFilterBank.current = [];
  }, [scene, userData.vrm, solver]);

  useEffect(() => {
    const target = new Object3D();
    camera.add(target);
    lookAtTarget.current = target;
    return () => { camera.remove(target); };
  }, [camera]);

  // ── Results callback ──────────────────────────────────────────────────────
  const resultsCallback = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (results: any) => {
      if (!videoElement || !currentVrm) return;

      const ts = performance.now();
      const para = tPosePara.current;
      const debugVisible = usePanelState.getState().panels.debug === "open";
      const doDebug = debugVisible && throttle(debugThrottleRef.current, 200); // ~5 Hz

      const errors: string[] = [];
      let landmarkSnap: LandmarkSnapshot | null  = null;
      let solverSnap:   SolverSnapshot   | null  = null;
      let filterSnap:   FilterSnapshot   | null  = null;
      let headSnap:     HeadSnapshot     | null  = null;

      // ── Face ──────────────────────────────────────────────────────────────
      if (results.faceLandmarks) {
        riggedFace.current = Face.solve(results.faceLandmarks, {
          runtime: "mediapipe",
          video: videoElement,
          imageSize: { width: 640, height: 480 },
          smoothBlink: false,
          blinkSettings: [0.25, 0.75],
        }) as RiggedFace;
      }

      // ── Pose ──────────────────────────────────────────────────────────────
      if (results.za && results.poseLandmarks) {
        // Capture raw landmark BEFORE filtering (for debug delta display)
        const rawShoulder11 = results.za[11];

        const filteredWorld = filterLandmarks(results.za,            poseWorldFilterBank.current, ts);
        const filteredImage = filterLandmarks(results.poseLandmarks, poseFilterBank.current,      ts);

        if (doDebug) {
          // Show how much the filter moved landmark 11
          filterSnap = {
            poseLmRaw:  { x: rawShoulder11.x, y: rawShoulder11.y, z: rawShoulder11.z },
            poseLmFilt: { x: filteredWorld[11].x, y: filteredWorld[11].y, z: filteredWorld[11].z },
          };
        }

        if (solver === "custom" && para) {
          // ── Custom solver ─────────────────────────────────────────────────
          //
          // FIX #2: za world landmarks are Y-down (same convention Kalidokit uses).
          // Verified by reading Kalidokit source: findRotation(lm[11], lm[13]) uses
          // .y directly with NO negation. Our previous flip(lm) = {y:-lm.y} was
          // WRONG — it produced an inverted coordinate system.
          const za = filteredWorld;

          // Converts MediaPipe left-handed Y-down world space to ThreeJS right-handed Y-up.
          // Native za landmarks have left arm at +X (non-mirrored), which directly matches VRM +X.
          const toTh = (lm: Lm) => ({ x: lm.x, y: -lm.y, z: -lm.z });

          // Mirror pose-side assignment into selfie/avatar space.
          // The camera preview is mirrored for the user, and the avatar faces the user,
          // so using MediaPipe's raw side labels directly produces anatomical behavior
          // (user right -> avatar screen-left). Swapping here yields mirror behavior
          // (user right -> avatar screen-right), which matches XR Animator-style selfie motion.
          const ls = toTh(za[12]), rs = toTh(za[11]); // shoulders
          const le = toTh(za[14]), re_lm = toTh(za[13]); // elbows
          const lw = toTh(za[16]), rw = toTh(za[15]); // wrists
          const lh = toTh(za[24]), rh = toTh(za[23]); // hips

          // Sanity check: in raw config, shoulder Y values are negative (Y-down means head is
          // at y≈-1, feet at y≈+1 in MediaPipe world coords with hip origin).
          // But our toTh converted shoulders should have POSITIVE Y (above hips).
          if (doDebug && Math.abs(ls.y) < 0.001 && Math.abs(rs.y) < 0.001) {
            errors.push("WARN: shoulder Y values near 0 — is za populated correctly?");
          }

          const bodyRot = solveBodyRotation(ls, rs, lh, rh);
          customHipsQ.current.copy(bodyRot.hipsQ);
          customSpineQ.current.copy(bodyRot.spineQ);

          if (doDebug) {
            pushLog(`Body | yaw=${(bodyRot.yaw * 180 / Math.PI).toFixed(1)}° | hips=(${bodyRot.hipsQ.x.toFixed(2)},${bodyRot.hipsQ.y.toFixed(2)},${bodyRot.hipsQ.z.toFixed(2)},${bodyRot.hipsQ.w.toFixed(2)})`);
          }

          const parentInvQ = buildUpperBodyInvQ(bodyRot.hipsQ, bodyRot.spineQ, identityQ);

          const leftUpperArmQ  = solveUpperArm(ls,    le,    parentInvQ, 1);
          const leftLowerArmQ  = solveLowerArm(le,    lw,    leftUpperArmQ, parentInvQ, 1);
          const rightUpperArmQ = solveUpperArm(rs,    re_lm, parentInvQ, -1);
          const rightLowerArmQ = solveLowerArm(re_lm, rw,   rightUpperArmQ, parentInvQ, -1);

          customLeftUpperArmQ.current.copy(leftUpperArmQ);
          customLeftLowerArmQ.current.copy(leftLowerArmQ);
          customRightUpperArmQ.current.copy(rightUpperArmQ);
          customRightLowerArmQ.current.copy(rightLowerArmQ);

          if (doDebug) {
            pushLog(`LUpperArm=(${leftUpperArmQ.x.toFixed(2)},${leftUpperArmQ.y.toFixed(2)},${leftUpperArmQ.z.toFixed(2)},${leftUpperArmQ.w.toFixed(2)})`);
            pushLog(`RUpperArm=(${rightUpperArmQ.x.toFixed(2)},${rightUpperArmQ.y.toFixed(2)},${rightUpperArmQ.z.toFixed(2)},${rightUpperArmQ.w.toFixed(2)})`);
            landmarkSnap = {
              leftShoulder:  { x: ls.x,    y: ls.y,    z: ls.z    },
              rightShoulder: { x: rs.x,    y: rs.y,    z: rs.z    },
              leftElbow:     { x: le.x,    y: le.y,    z: le.z    },
              rightElbow:    { x: re_lm.x, y: re_lm.y, z: re_lm.z },
              leftWrist:     { x: lw.x,    y: lw.y,    z: lw.z    },
              rightWrist:    { x: rw.x,    y: rw.y,    z: rw.z    },
              leftHip:       { x: lh.x,    y: lh.y,    z: lh.z    },
              rightHip:      { x: rh.x,    y: rh.y,    z: rh.z    },
            };
            solverSnap = {
              solver:        "custom",
              hipsQ:         { x: bodyRot.hipsQ.x,       y: bodyRot.hipsQ.y,       z: bodyRot.hipsQ.z,       w: bodyRot.hipsQ.w       },
              spineQ:        { x: bodyRot.spineQ.x,      y: bodyRot.spineQ.y,      z: bodyRot.spineQ.z,      w: bodyRot.spineQ.w      },
              leftUpperArmQ: { x: leftUpperArmQ.x,       y: leftUpperArmQ.y,       z: leftUpperArmQ.z,       w: leftUpperArmQ.w       },
              leftLowerArmQ: { x: leftLowerArmQ.x,       y: leftLowerArmQ.y,       z: leftLowerArmQ.z,       w: leftLowerArmQ.w       },
              rightUpperArmQ:{ x: rightUpperArmQ.x,      y: rightUpperArmQ.y,      z: rightUpperArmQ.z,      w: rightUpperArmQ.w      },
              rightLowerArmQ:{ x: rightLowerArmQ.x,      y: rightLowerArmQ.y,      z: rightLowerArmQ.z,      w: rightLowerArmQ.w      },
              bodyYaw:       bodyRot.yaw,
              leftRoll:      leftRollState.angle,
              rightRoll:     rightRollState.angle,
            };
          }

          // Still use Kalidokit for legs
          // Apply the same wrist-y clamp here so leg solve doesn't get corrupted
          // by the offscreen arm fallback path inside Kalidokit.
          const worldForKalidokit = filteredWorld.map((lm, i) =>
            (i === 15 || i === 16) ? { ...lm, y: Math.min(lm.y, 0) } : lm
          );
          riggedPose.current = Pose.solve(worldForKalidokit, filteredImage, {
            runtime: "mediapipe",
            video: videoElement,
          }) as RiggedPose;

        } else {
          // ── Kalidokit solver ──────────────────────────────────────────────
          // Kalidokit's offscreen detection checks `lm3d[15/16].y > 0.1` to decide
          // whether to lock arms to RestingDefault (z:±1.25). But MediaPipe world
          // landmarks are Y-DOWN, so wrists at a normal standing position have y > 0
          // and always trip that check — freezing the arms every frame.
          // Fix: clamp wrist y to ≤ 0 in the world landmark copy so Kalidokit's
          // offscreen guard never fires falsely. Visibility is still the real guard.
          const worldForKalidokit = filteredWorld.map((lm, i) =>
            (i === 15 || i === 16) ? { ...lm, y: Math.min(lm.y, 0) } : lm
          );
          riggedPose.current = Pose.solve(worldForKalidokit, filteredImage, {
            runtime: "mediapipe",
            video: videoElement,
          }) as RiggedPose;

          if (doDebug && riggedPose.current) {
            const hp = riggedPose.current.Hips.rotation;
            solverSnap = {
              solver: "kalidokit",
              hipsQ:  { x: hp.x, y: hp.y, z: hp.z, w: 1 },
              spineQ: { x: 0, y: 0, z: 0, w: 1 },
              leftUpperArmQ:  { x: 0, y: 0, z: 0, w: 1 },
              leftLowerArmQ:  { x: 0, y: 0, z: 0, w: 1 },
              rightUpperArmQ: { x: 0, y: 0, z: 0, w: 1 },
              rightLowerArmQ: { x: 0, y: 0, z: 0, w: 1 },
              bodyYaw:  hp.y,
              leftRoll: leftRollState.angle,
              rightRoll: rightRollState.angle,
            };
          }
        }
      }

      // ── Hands ─────────────────────────────────────────────────────────────
      // Hands use normalized [0,1] space. X: 0 (left) to 1 (right). Y: 0 (top) to 1 (bottom).
      // Map to 3D space: standard X, inverted Y, inverted Z.
      const toHandSpace = (lm: Lm) => ({ x: lm.x - 0.5, y: -(lm.y - 0.5), z: -lm.z });

      // Keep hand routing in the same selfie/mirror convention as the custom body solve:
      // user-right drives avatar screen-right, user-left drives avatar screen-left.
      // Because the avatar faces the user, that means MediaPipe anatomical sides are
      // intentionally mapped to the opposite avatar side.
      if (results.leftHandLandmarks) {
        const filtered = filterHandLandmarks(results.leftHandLandmarks, rightHandFilterBank.current, ts);
        if (solver === "custom") {
          const solved = solveHand(filtered.map(toHandSpace), "Right");
          rightHandQ.current = solved.wristQ;
          rightFingerData.current = { fingers: solved.fingers };
        } else {
          riggedRightHand.current = Hand.solve(filtered, "Right") as RiggedHand;
        }
        if (tPosePara.current && solver === "custom" && rightHandQ.current) {
          solveWristRoll(rightHandQ.current, tPosePara.current.rightForearmAxis, rightRollState, -1, ts);
        }
      } else {
        riggedRightHand.current = undefined;
        rightHandQ.current      = null;
        rightFingerData.current = null;
        rightRollState.angle    = 0;
        rightRollState.ts       = 0;
        rightHandFilterBank.current.forEach(f => f.reset());
      }

      if (results.rightHandLandmarks) {
        const filtered = filterHandLandmarks(results.rightHandLandmarks, leftHandFilterBank.current, ts);
        if (solver === "custom") {
          const solved = solveHand(filtered.map(toHandSpace), "Left");
          leftHandQ.current = solved.wristQ;
          leftFingerData.current = { fingers: solved.fingers };
        } else {
          riggedLeftHand.current = Hand.solve(filtered, "Left") as RiggedHand;
        }
        if (tPosePara.current && solver === "custom" && leftHandQ.current) {
          solveWristRoll(leftHandQ.current, tPosePara.current.leftForearmAxis, leftRollState, 1, ts);
        }
      } else {
        riggedLeftHand.current = undefined;
        leftHandQ.current      = null;
        leftFingerData.current = null;
        leftRollState.angle    = 0;
        leftRollState.ts       = 0;
        leftHandFilterBank.current.forEach(f => f.reset());
      }

      // ── Bridge ────────────────────────────────────────────────────────────
      if (riggedPose.current && riggedFace.current) {
        // When using the custom solver, the arm/hips/spine rotations live in
        // separate quaternion refs and are never written back into riggedPose.current.
        // vmc-builder reads riggedPose directly, so without this patch it would
        // send Kalidokit's stale T-pose Euler values for the arms every frame.
        // We extract Euler from the custom quaternions and overwrite the relevant
        // keys on a shallow copy so the local riggedPose ref is not mutated.
        let poseForBridge = riggedPose.current;
        if (solver === "custom") {
          const qToEuler = (q: Quaternion) => {
            tmpEuler.setFromQuaternion(q);
            return { x: tmpEuler.x, y: tmpEuler.y, z: tmpEuler.z };
          };
          poseForBridge = {
            ...riggedPose.current,
            Hips: {
              ...riggedPose.current.Hips,
              rotation: qToEuler(customHipsQ.current),
            },
            Spine:         qToEuler(customSpineQ.current),
            LeftUpperArm:  qToEuler(customLeftUpperArmQ.current),
            LeftLowerArm:  qToEuler(customLeftLowerArmQ.current),
            RightUpperArm: qToEuler(customRightUpperArmQ.current),
            RightLowerArm: qToEuler(customRightLowerArmQ.current),
          };
        }
        const frame: MocapFrame = {
          riggedPose:      poseForBridge,
          riggedFace:      riggedFace.current,
          riggedLeftHand:  riggedLeftHand.current ?? {},
          riggedRightHand: riggedRightHand.current ?? {},
          timestamp:       Date.now(),
        };
        send(frame);
        recordFrame(frame);
      }

      // ── Push debug frame ──────────────────────────────────────────────────
      if (doDebug) {
        if (riggedFace.current) {
          headSnap = {
            kalidokitEuler: { x: riggedFace.current.head.x, y: riggedFace.current.head.y, z: riggedFace.current.head.z },
            neckBoneQ: { x: smoothNeckQ.current.x, y: smoothNeckQ.current.y, z: smoothNeckQ.current.z, w: smoothNeckQ.current.w },
          };
        }
        const debugFrame: DebugFrame = {
          ts: performance.now(),
          landmarks: landmarkSnap,
          solver:    solverSnap,
          filter:    filterSnap,
          head:      headSnap,
          errors,
        };
        setFrame(debugFrame);
      }
    },
    [videoElement, currentVrm, solver, send, recordFrame, setFrame, pushLog]
  );

  useEffect(() => {
    setResultsCallback(resultsCallback);
  }, [resultsCallback, setResultsCallback]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const lerpExpression = (name: string, value: number, factor: number) => {
    const em = userData.vrm.expressionManager;
    em.setValue(name, lerp(em.getValue(name), value, factor));
  };

  const rotateBoneDirect = (boneName: string, q: Quaternion) => {
    const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!bone) return;
    const correction = tPosePara.current?.restPoseCorrections[boneName];
    if (correction) {
      // Apply rest-pose correction: correction × solvedQ
      // This compensates for models exported without proper normalization
      bone.quaternion.copy(correction).multiply(q);
    } else {
      bone.quaternion.copy(q);
    }
  };

  const rotateBoneFromEuler = (
    boneName: string,
    value: { x: number; y: number; z: number },
    flip = { x: 1, y: 1, z: 1 }
  ) => {
    const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!bone) return;
    tmpEuler.set(value.x * flip.x, value.y * flip.y, value.z * flip.z);
    tmpQuat.setFromEuler(tmpEuler);
    const correction = tPosePara.current?.restPoseCorrections[boneName];
    if (correction) {
      bone.quaternion.copy(correction).multiply(tmpQuat);
    } else {
      bone.quaternion.copy(tmpQuat);
    }
  };

  // ── Render loop ───────────────────────────────────────────────────────────
  useFrame((_, delta) => {
    const vrm = userData.vrm;
    if (!vrm) return;
    const para = tPosePara.current;

    // Reset to T-pose before applying any rotations
    vrm.humanoid.resetNormalizedPose?.();

    // ── Face expressions ──────────────────────────────────────────────────
    if (riggedFace.current) {
      [
        { name: "aa",         value: riggedFace.current.mouth.shape.A },
        { name: "ih",         value: riggedFace.current.mouth.shape.I },
        { name: "ee",         value: riggedFace.current.mouth.shape.E },
        { name: "oh",         value: riggedFace.current.mouth.shape.O },
        { name: "ou",         value: riggedFace.current.mouth.shape.U },
        { name: "blinkLeft",  value: 1 - riggedFace.current.eye.l },
        { name: "blinkRight", value: 1 - riggedFace.current.eye.r },
      ].forEach(({ name, value }) => lerpExpression(name, value, delta * 12));

      if (lookAtTarget.current && riggedFace.current.pupil) {
        vrm.lookAt.target = lookAtTarget.current;
        lookAtTarget.current.position.lerp(
          { x: -2 * riggedFace.current.pupil.x, y: 2 * riggedFace.current.pupil.y, z: 0 },
          delta * 5
        );
      }

      // ── FIX #1: neck slerp from persistent ref, NOT from bone.quaternion ──
      // resetNormalizedPose() resets bone.quaternion to identity each frame.
      // We must slerp our own "current" ref toward the target so the smooth
      // trajectory is preserved across frames.
      tmpEuler.set(riggedFace.current.head.x, riggedFace.current.head.y, riggedFace.current.head.z);
      tmpQuat.setFromEuler(tmpEuler);
      smoothNeckQ.current.slerp(tmpQuat, Math.min(delta * 8, 1));

      const neckBone = vrm.humanoid.getNormalizedBoneNode("neck");
      if (neckBone) neckBone.quaternion.copy(smoothNeckQ.current);
    }

    // ── Body ──────────────────────────────────────────────────────────────
    if (solver === "custom") {
      rotateBoneDirect("hips",  customHipsQ.current);
      rotateBoneDirect("spine", customSpineQ.current);

      if (para && para.spineToHipsRatio > 0) {
        const hipsBone  = vrm.humanoid.getNormalizedBoneNode("hips");
        const spineBone = vrm.humanoid.getNormalizedBoneNode("spine");
        if (hipsBone && spineBone) {
          const contrib = identityQ.clone().slerp(spineBone.quaternion, para.spineToHipsRatio);
          hipsBone.quaternion.multiply(contrib);
          const contribInv = contrib.clone().conjugate();
          vrm.humanoid.getNormalizedBoneNode("leftUpperLeg")?.quaternion.premultiply(contribInv);
          vrm.humanoid.getNormalizedBoneNode("rightUpperLeg")?.quaternion.premultiply(contribInv);
        }
      }

      rotateBoneDirect("leftUpperArm",  customLeftUpperArmQ.current);
      rotateBoneDirect("leftLowerArm",  customLeftLowerArmQ.current);
      rotateBoneDirect("rightUpperArm", customRightUpperArmQ.current);
      rotateBoneDirect("rightLowerArm", customRightLowerArmQ.current);

      // Wrist roll + fingers — left hand
      if (leftHandQ.current && para) {
        const { lowerArmDelta, handRollAngle } = solveWristRoll(
          leftHandQ.current, para.leftForearmAxis, leftRollState, 1, performance.now()
        );
        vrm.humanoid.getNormalizedBoneNode("leftLowerArm")?.quaternion.premultiply(lowerArmDelta);
        const handBone = vrm.humanoid.getNormalizedBoneNode("leftHand");
        if (handBone) {
          tmpQuat.setFromAxisAngle(para.leftForearmAxis, handRollAngle);
          handBone.quaternion.copy(tmpQuat);
        }
        if (leftFingerData.current) applyCustomFingers(vrm, leftFingerData.current.fingers, "left");
      }

      // Wrist roll + fingers — right hand
      if (rightHandQ.current && para) {
        const { lowerArmDelta, handRollAngle } = solveWristRoll(
          rightHandQ.current, para.rightForearmAxis, rightRollState, -1, performance.now()
        );
        vrm.humanoid.getNormalizedBoneNode("rightLowerArm")?.quaternion.premultiply(lowerArmDelta);
        const handBone = vrm.humanoid.getNormalizedBoneNode("rightHand");
        if (handBone) {
          tmpQuat.setFromAxisAngle(para.rightForearmAxis, handRollAngle);
          handBone.quaternion.copy(tmpQuat);
        }
        if (rightFingerData.current) applyCustomFingers(vrm, rightFingerData.current.fingers, "right");
      }

      // Legs still from Kalidokit, but routed through the same selfie/mirror
      // convention as the custom upper body so the whole avatar agrees on side mapping.
      if (riggedPose.current) {
        rotateBoneFromEuler("leftUpperLeg",  riggedPose.current.RightUpperLeg);
        rotateBoneFromEuler("leftLowerLeg",  riggedPose.current.RightLowerLeg);
        rotateBoneFromEuler("rightUpperLeg", riggedPose.current.LeftUpperLeg);
        rotateBoneFromEuler("rightLowerLeg", riggedPose.current.LeftLowerLeg);
      }

    } else {
      // ── Kalidokit path ────────────────────────────────────────────────────
      if (riggedPose.current) {
        rotateBoneFromEuler("hips", riggedPose.current.Hips.rotation);

        const spineRot = riggedPose.current.Spine;
        rotateBoneFromEuler("spine", spineRot);

        if (para && para.spineToHipsRatio > 0) {
          const hipsBone = vrm.humanoid.getNormalizedBoneNode("hips");
          if (hipsBone) {
            tmpEuler.set(
              spineRot.x * para.spineToHipsRatio,
              spineRot.y * para.spineToHipsRatio,
              spineRot.z * para.spineToHipsRatio
            );
            tmpQuat.setFromEuler(tmpEuler);
            hipsBone.quaternion.multiply(tmpQuat);
          }
        }

        if (riggedPose.current.Chest) rotateBoneFromEuler("chest", riggedPose.current.Chest);

        rotateBoneFromEuler("leftUpperArm",  riggedPose.current.LeftUpperArm);
        rotateBoneFromEuler("leftLowerArm",  riggedPose.current.LeftLowerArm);
        rotateBoneFromEuler("rightUpperArm", riggedPose.current.RightUpperArm);
        rotateBoneFromEuler("rightLowerArm", riggedPose.current.RightLowerArm);

        rotateBoneFromEuler("leftUpperLeg",  riggedPose.current.LeftUpperLeg);
        rotateBoneFromEuler("leftLowerLeg",  riggedPose.current.LeftLowerLeg);
        rotateBoneFromEuler("rightUpperLeg", riggedPose.current.RightUpperLeg);
        rotateBoneFromEuler("rightLowerLeg", riggedPose.current.RightLowerLeg);

        // Wrist + fingers — Kalidokit path.
        // Hand.solve() returns LeftWrist/RightWrist as full Euler rotations.
        // Apply them directly — no separate roll solver needed here.
        if (riggedLeftHand.current) {
          const leftHandBone = vrm.humanoid.getNormalizedBoneNode("leftHand");
          if (leftHandBone && riggedLeftHand.current.LeftWrist) {
            tmpEuler.set(
              riggedLeftHand.current.LeftWrist.x,
              riggedLeftHand.current.LeftWrist.y,
              riggedLeftHand.current.LeftWrist.z,
            );
            tmpQuat.setFromEuler(tmpEuler);
            leftHandBone.quaternion.slerp(tmpQuat, Math.min(delta * 12, 1));
          }
          applyKalidokitFingers(vrm, riggedLeftHand.current, "left");
        }

        if (riggedRightHand.current) {
          const rightHandBone = vrm.humanoid.getNormalizedBoneNode("rightHand");
          if (rightHandBone && riggedRightHand.current.RightWrist) {
            tmpEuler.set(
              riggedRightHand.current.RightWrist.x,
              riggedRightHand.current.RightWrist.y,
              riggedRightHand.current.RightWrist.z,
            );
            tmpQuat.setFromEuler(tmpEuler);
            rightHandBone.quaternion.slerp(tmpQuat, Math.min(delta * 12, 1));
          }
          applyKalidokitFingers(vrm, riggedRightHand.current, "right");
        }
      }
    }

    vrm.update(delta);
  });

  return (
    <group>
      <primitive object={scene} />
    </group>
  );
}

// ─── Finger application helpers ───────────────────────────────────────────────

const FINGER_BONE_NAMES: Record<string, [string, string, string]> = {
  "left-0":  ["leftThumbMetacarpal",  "leftThumbProximal",       "leftThumbDistal"],
  "left-1":  ["leftIndexProximal",    "leftIndexIntermediate",   "leftIndexDistal"],
  "left-2":  ["leftMiddleProximal",   "leftMiddleIntermediate",  "leftMiddleDistal"],
  "left-3":  ["leftRingProximal",     "leftRingIntermediate",    "leftRingDistal"],
  "left-4":  ["leftLittleProximal",   "leftLittleIntermediate",  "leftLittleDistal"],
  "right-0": ["rightThumbMetacarpal", "rightThumbProximal",      "rightThumbDistal"],
  "right-1": ["rightIndexProximal",   "rightIndexIntermediate",  "rightIndexDistal"],
  "right-2": ["rightMiddleProximal",  "rightMiddleIntermediate", "rightMiddleDistal"],
  "right-3": ["rightRingProximal",    "rightRingIntermediate",   "rightRingDistal"],
  "right-4": ["rightLittleProximal",  "rightLittleIntermediate", "rightLittleDistal"],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyCustomFingers(vrm: any, fingers: { x: number; y: number; z: number }[][], side: "left" | "right") {
  for (let f = 0; f < 5; f++) {
    const boneNames = FINGER_BONE_NAMES[`${side}-${f}`];
    if (!boneNames) continue;
    for (let p = 0; p < 3; p++) {
      const angles = fingers[f]?.[p];
      if (!angles) continue;
      const bone = vrm.humanoid.getNormalizedBoneNode(boneNames[p]);
      if (!bone) continue;
      tmpEuler.set(angles.x, angles.y, 0, "XZY");
      tmpQuat.setFromEuler(tmpEuler);
      bone.quaternion.copy(tmpQuat);
    }
  }
}

const FINGER_MAP = {
  left: {
    keys: [
      ["LeftThumbProximal","LeftThumbIntermediate","LeftThumbDistal"],
      ["LeftIndexProximal","LeftIndexIntermediate","LeftIndexDistal"],
      ["LeftMiddleProximal","LeftMiddleIntermediate","LeftMiddleDistal"],
      ["LeftRingProximal","LeftRingIntermediate","LeftRingDistal"],
      ["LeftLittleProximal","LeftLittleIntermediate","LeftLittleDistal"],
    ],
    bones: [
      ["leftThumbMetacarpal","leftThumbProximal","leftThumbDistal"],
      ["leftIndexProximal","leftIndexIntermediate","leftIndexDistal"],
      ["leftMiddleProximal","leftMiddleIntermediate","leftMiddleDistal"],
      ["leftRingProximal","leftRingIntermediate","leftRingDistal"],
      ["leftLittleProximal","leftLittleIntermediate","leftLittleDistal"],
    ],
  },
  right: {
    keys: [
      ["RightThumbProximal","RightThumbIntermediate","RightThumbDistal"],
      ["RightIndexProximal","RightIndexIntermediate","RightIndexDistal"],
      ["RightMiddleProximal","RightMiddleIntermediate","RightMiddleDistal"],
      ["RightRingProximal","RightRingIntermediate","RightRingDistal"],
      ["RightLittleProximal","RightLittleIntermediate","RightLittleDistal"],
    ],
    bones: [
      ["rightThumbMetacarpal","rightThumbProximal","rightThumbDistal"],
      ["rightIndexProximal","rightIndexIntermediate","rightIndexDistal"],
      ["rightMiddleProximal","rightMiddleIntermediate","rightMiddleDistal"],
      ["rightRingProximal","rightRingIntermediate","rightRingDistal"],
      ["rightLittleProximal","rightLittleIntermediate","rightLittleDistal"],
    ],
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyKalidokitFingers(vrm: any, handData: any, side: "left" | "right") {
  const map = FINGER_MAP[side];
  for (let f = 0; f < 5; f++) {
    for (let p = 0; p < 3; p++) {
      const raw = handData[map.keys[f][p]];
      if (!raw || !("x" in raw)) continue;
      const clamped = clampFinger(raw);
      const bone = vrm.humanoid.getNormalizedBoneNode(map.bones[f][p]);
      if (!bone) continue;
      tmpEuler.set(clamped.x, clamped.y, clamped.z);
      tmpQuat.setFromEuler(tmpEuler);
      bone.quaternion.copy(tmpQuat);
    }
  }
}

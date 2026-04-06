# XR Animator Custom Pose Solver — Deep-Dive Technical Reference

**Purpose:** A precise, implementation-ready specification of XR Animator's custom
MediaPipe-to-bone-rotation pipeline. Every claim is tied to a source file and position
in that file. A developer should be able to re-implement this solver in TypeScript
from this document alone.

**Primary sources:**
- `forks/SystemAnimatorOnline/js/mocap_lib_module.js` (1970 lines)
- `forks/SystemAnimatorOnline/js/one_euro_filter.js`
- `forks/SystemAnimatorOnline/js/SA_system_emulation.min.js` (minified; byte offsets cited)
- `forks/SystemAnimatorOnline/MMD.js/MMD_SA.js` (18 825 lines)

---

## Table of Contents

1. [Landmark Ingestion & Coordinate Space](#1-landmark-ingestion--coordinate-space)
2. [One Euro Filter — Complete Specification](#2-one-euro-filter--complete-specification)
3. [Per-Region Filter Parameters](#3-per-region-filter-parameters)
4. [Bone Direction Solving — Upper & Lower Arm](#4-bone-direction-solving--upper--lower-arm)
5. [Wrist Roll — Lower-Arm Fixed Axis Method](#5-wrist-roll--lower-arm-fixed-axis-method)
6. [MMD Twist Bone Pipeline](#6-mmd-twist-bone-pipeline)
7. [T-Pose Precomputation](#7-t-pose-precomputation)
8. [Finger Solving](#8-finger-solving)
9. [Hip / Root Rotation & Spine Redistribution](#9-hip--root-rotation--spine-redistribution)
10. [Visibility Gating — `blend_default_motion`](#10-visibility-gating--blend_default_motion)
11. [Coordinate System Conversion — `process_rotation`](#11-coordinate-system-conversion--process_rotation)
12. [Frame-Level VRM Application](#12-frame-level-vrm-application)
13. [TypeScript Re-Implementation Checklist](#13-typescript-re-implementation-checklist)

---

## 1. Landmark Ingestion & Coordinate Space

### 1a. MediaPipe configuration
*Source: `mocap_lib_module.js:203–210`*

```js
holistic.setOptions({
  modelComplexity: 1,          // "heavy" model; better at non-frontal poses
  smoothLandmarks: true,       // MediaPipe's own internal EMA smoothing
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
  refineFaceLandmarks: true,   // 468-point iris mesh (needed for eye-gaze bones)
});
```

For hands (standalone `Hands` model, `mocap_lib_module.js:543–548`):
```js
hands.setOptions({
  maxNumHands: 2,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
  modelComplexity: 1,
});
```

### 1b. BlazePose keypoint index table
*Source: `mocap_lib_module.js:1901–1935`, `1937–1943`*

The 33-point BlazePose skeleton is indexed 0–32. XR Animator maps them to a subset:

```
blazepose_translated = [0, 2,5, 7,8, 11,12,13,14,15,16, 23,24,25,26,27,28]
```

Relevant indices (0-based):
| Index | Name            | Used for              |
|-------|-----------------|-----------------------|
| 11    | left_shoulder   | UpperArm proximal, shoulder width, body yaw |
| 12    | right_shoulder  | UpperArm proximal, shoulder width, body yaw |
| 13    | left_elbow      | UpperArm distal / LowerArm proximal |
| 14    | right_elbow     | LowerArm proximal |
| 15    | left_wrist      | LowerArm distal |
| 16    | right_wrist     | LowerArm distal |
| 23    | left_hip        | Root position, hip vector |
| 24    | right_hip       | Root position, hip vector |
| 25    | left_knee       | Leg direction |
| 26    | right_knee      | Leg direction |
| 27    | left_ankle      | Foot position |
| 28    | right_ankle     | Foot position |

### 1c. Coordinate space
Raw landmark space after `pose_adjust()` (`mocap_lib_module.js:782–802`):
- **x**: image pixels, right is positive
- **y**: image pixels, **down** is positive (screen convention)
- **z**: depth in same scale as x (negative = closer to camera in BlazePose world coords)

`shoulder_width` is recomputed every frame as the 3D Euclidean distance between
landmark 11 and 12 (`mocap_lib_module.js:810–813`):
```js
const arm_diff = [armL.x - armR.x, armL.y - armR.y, (armL.z - armR.z)/3];
shoulder_width = Math.sqrt(arm_diff[0]**2 + arm_diff[1]**2 + arm_diff[2]**2);
```

### 1d. Hand landmark annotations
*Source: `mocap_lib_module.js:1247–1255`*

MediaPipe Hands returns 21 landmarks. XR Animator reorganises them into named groups:

```
palm:   [0]                           (wrist)
thumb:  [1, 2, 3, 4]                  (CMC, MCP, IP, TIP)
index:  [5, 6, 7, 8]                  (MCP, PIP, DIP, TIP)
middle: [9, 10, 11, 12]
ring:   [13, 14, 15, 16]
pinky:  [17, 18, 19, 20]
```

**Palm aspect-ratio correction** (`mocap_lib_module.js:1183–1207`):
When `palm_height / palm_width` is outside `[1.25, 1.75]`, the solver adjusts the z-depth
of all landmarks by a computed scale factor to correct for foreshortening. This correction
is derived from the algebraic constraint that the palm width should be ≈ 0.65× palm
height when the hand is in a neutral pose:

```
palm_width  = L17 - L1  (thumb base to pinky base vector)
palm_height = L0 - L9   (wrist to middle MCP vector)
_adjust_ratio = h_palm / w_palm
if 1.25 < _adjust_ratio < 1.75 → compute z-scale analytically
h.forEach(j => { j[2] *= _adjust_ratio });  // scale all z coords
```

---

## 2. One Euro Filter — Complete Specification

*Source: `one_euro_filter.js` (full file)*

The One Euro Filter is an adaptive low-pass filter that adjusts its cutoff frequency
based on the current rate of change. It simultaneously achieves low jitter at rest
and low lag during fast motion — properties that a fixed-alpha lerp cannot combine.

### 2a. Low-pass filter primitive

```typescript
class LowPassFilter {
  private y: number | null = null;
  private a: number = 0;

  setAlpha(alpha: number) { this.a = alpha; }

  filter(value: number): number {
    if (this.y === null) { this.y = value; return value; }
    this.y = this.a * value + (1 - this.a) * this.y;
    return this.y;
  }

  lastValue(): number { return this.y ?? 0; }
}
```

### 2b. Alpha from cutoff frequency
```typescript
function alpha(cutoff: number, freq: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  const te  = 1 / freq;
  return 1 / (1 + tau / te);
}
```

### 2c. One Euro Filter (scalar)
```typescript
class OneEuroFilterScalar {
  private xFilter: LowPassFilter;
  private dxFilter: LowPassFilter;
  private lastTimestamp: number | null = null;

  constructor(
    private freq: number,
    private minCutOff: number = 1,
    private beta: number = 0,
    private dCutOff: number = 1,
  ) {
    this.xFilter  = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
    this.dxFilter.setAlpha(alpha(dCutOff, freq));
  }

  filter(x: number, timestamp?: number): number {
    // Update frequency from real elapsed time
    if (timestamp != null && this.lastTimestamp != null) {
      this.freq = 1000 / (timestamp - this.lastTimestamp);
    }
    this.lastTimestamp = timestamp ?? null;

    // Derivative estimate (velocity)
    const prev = this.xFilter.lastValue();
    const dx = (x - prev) * this.freq;
    this.dxFilter.setAlpha(alpha(this.dCutOff, this.freq));
    const edx = this.dxFilter.filter(dx);

    // Adaptive cutoff: higher speed → higher cutoff → less lag
    const cutoff = this.minCutOff + this.beta * Math.abs(edx);
    this.xFilter.setAlpha(alpha(cutoff, this.freq));
    return this.xFilter.filter(x);
  }
}
```

### 2d. Vector overload (XR Animator extension)
XR Animator wraps the scalar filter into a vector filter:

```typescript
class OneEuroFilter {
  private filters: OneEuroFilterScalar[];

  constructor(freq: number, minCutOff = 1, beta = 0, dCutOff = 1, dims = 3) {
    this.filters = Array.from({ length: dims }, () =>
      new OneEuroFilterScalar(freq, minCutOff, beta, dCutOff)
    );
  }

  filter(vec: number[], timestamp?: number): number[] {
    return vec.map((v, i) => this.filters[i].filter(v, timestamp));
  }
}
```

---

## 3. Per-Region Filter Parameters

All filters share the constructor signature `OneEuroFilter(freq, minCutOff, beta, dCutOff, dims)`.

| Region | freq | minCutOff | beta | dCutOff | dims | Source |
|--------|------|-----------|------|---------|------|--------|
| Pose landmarks (z only) | 30 | 1 | 1 | 2 | 3 | `mocap_lib_module.js:355` |
| Hand landmarks (per point) | 30 | 1 | 1/1000 | 1 | 3 | `mocap_lib_module.js:705` |
| Shoulder rotation | 30 | 0.5 | 0.25 | 1 | 1 | `SA_system_emulation.min.js:63138` |
| Hip rotation (quaternion) | 30 | 1 | 0.2 | 0.2 | 4 | `SA_system_emulation.min.js:162098` |
| Hip position | 30 | 1 | 0.2 | 0.2 | 3 | `SA_system_emulation.min.js:162098` |
| Arm IK position | 30 | 1 | 1/5 | 1 | 3 | `SA_system_emulation.min.js:155000` |
| Arm IK transform | 30 | 1 | 1/5 | 1 | 3 | `SA_system_emulation.min.js:155004` |
| Magnet (prop) vectors | 30 | 0.5 | 0.5 | 1 | 4 | `SA_system_emulation.min.js:140873` |
| Lean (z-axis) | 30 | 0.5 | 0.5 | 1 | 1 | `SA_system_emulation.min.js:82480` |

**Adaptive beta per distance** (`mocap_lib_module.js:814–828`):
When the detected person is far from the camera (`shoulder_width` is small relative to
frame width), `filter_factor` increases and is applied to the pose landmark filters:

```typescript
let filter_factor = Math.max(w, h) / shoulder_width;
filter_factor = (filter_factor < 5) ? 1 : Math.min(filter_factor / 5, 3);
// Applied to ALL 33 pose landmark filters:
f.beta    = filter_factor;       // faster tracking when close; smoother when far
f.dCutOff = 2 * filter_factor;
```

Interpretation: when `shoulder_width` occupies 1/5 of the frame or less,
`filter_factor` ramps from 1 to 3. The larger `beta`, the more responsive the filter
becomes to fast motion. The effect is that a distant (small) person gets more smoothing
to combat the increased noise, while a close-up person gets more responsiveness.

---

## 4. Bone Direction Solving — Upper & Lower Arm

*Source: `SA_system_emulation.min.js:109484–112000`*

XR Animator does **not** use Kalidokit. It derives bone rotations from raw 3D landmark
vectors using `THREE.Quaternion.setFromUnitVectors`, which is gimbal-lock-free.

### 4a. Variable mapping (deobfuscated from minified)

| Minified | Meaning |
|----------|---------|
| `f` | shoulder landmark position (Vector3, proximal of UpperArm) |
| `u` | elbow landmark position (Vector3, distal of UpperArm) |
| `h` | wrist landmark position (Vector3, distal of LowerArm) |
| `re` | inverse of upper-body rotation quaternion (transforms world → parent space) |
| `L` | ±1 — +1 for left arm, -1 for right arm (T-pose arm direction) |
| `b` | UpperArm quaternion result |
| `k` | LowerArm (elbow) quaternion result |
| `g` | normalized UpperArm direction in parent (shoulder) space |
| `e` | normalized LowerArm direction in UpperArm space |
| `y` | T-pose rest axis for the arm bone: `Vector3(L, 0, 0)` |

### 4b. UpperArm rotation

```typescript
// Step 1: direction vector shoulder → elbow, in world space
const shoulderToElbow = elbow.clone().sub(shoulder).normalize();

// Step 2: rotate into parent (upper-body) local space
const g = shoulderToElbow.applyQuaternion(upperBodyRotInv);

// Step 3: T-pose rest axis of the UpperArm bone
const restAxis = new THREE.Vector3(sign, 0, 0);  // sign = +1 left, -1 right

// Step 4: setFromUnitVectors → swing quaternion (no twist yet)
const upperArmQ = new THREE.Quaternion().setFromUnitVectors(restAxis, g);
```

This quaternion represents the "swing" of the UpperArm — the rotation that brings
the arm from its T-pose direction to the observed direction. It contains no roll
(twist) information, which is correct because MediaPipe Pose gives no forearm roll.

### 4c. LowerArm rotation

```typescript
// Step 1: direction vector elbow → wrist
const elbowToWrist = wrist.clone().sub(elbow).normalize();

// Step 2: transform into upper-body space, then into UpperArm-local space
const e = elbowToWrist
  .applyQuaternion(upperBodyRotInv)
  .applyQuaternion(upperArmQ.clone().conjugate());  // now in UpperArm space

// Step 3: same T-pose rest axis
const restAxis = new THREE.Vector3(sign, 0, 0);

// Step 4: setFromUnitVectors → elbow rotation in UpperArm space
const lowerArmQ = new THREE.Quaternion().setFromUnitVectors(restAxis, e);
```

The `conjugate()` in step 2 is essential: it removes the UpperArm rotation from the
coordinate frame, so `lowerArmQ` is expressed *relative to the UpperArm*, not the world.
This is the correct local-space rotation for the LowerArm bone.

### 4d. One Euro Filter on the UpperArm quaternion

Before writing the quaternion to the MMD bone, the UpperArm result is filtered:

```typescript
// SA_system_emulation.min.js:111700 (deobfuscated)
// je[c] is the per-arm One Euro Filter for quaternion components
upperArmQ.fromArray(
  armFilter[side].filter(upperArmQ.toArray())  // 4-component quaternion filter
);
```

The arm IK filter params: `freq=30, minCutOff=1, beta=1/5, dCutOff=1, dims=3`.

### 4e. Body collider arm-push correction

*Source: `SA_system_emulation.min.js:110200–110600`*

If the arm enters the body volume (detected via `MMD_SA_options.model_para_obj.colliders_for_hands`),
XR Animator applies a push-out rotation around the arm axis:

```typescript
// Arms near chest: rotate arm outward by up to π/4 * pushFactor
const pushFactor = /* sigmoid of penetration depth */ ...;
const armAxis = wrist.clone().sub(elbow).normalize();
const pushQ = new THREE.Quaternion().setFromAxisAngle(armAxis, -Math.PI/4 * pushFactor * sign);
elbow.applyQuaternion(pushQ);  // move elbow point before solving UpperArm
```

---

## 5. Wrist Roll — Lower-Arm Fixed Axis Method

*Sources: `MMD_SA.js:9140–9144` (precomputation), `SA_system_emulation.min.js:153800–154300` (runtime)*

MediaPipe Pose does not provide forearm roll (pronation/supination). XR Animator
derives it from the hand orientation quaternion using the following pipeline.

### 5a. Precomputation at model load
*Source: `MMD_SA.js:9140–9144`*

```typescript
// Stored once per model, in T-pose world coordinates
para.lower_arm_fixedAxis[side] = new THREE.Vector3()
  .fromArray(para.pos0[side + 'Hand'])
  .sub(new THREE.Vector3().fromArray(para.pos0[side + 'LowerArm']))
  .normalize()
  .toArray();
```

This gives the unit vector along the forearm's longitudinal axis in T-pose — the axis
around which pronation/supination rotates.

### 5b. Runtime wrist-roll extraction
*Source: `SA_system_emulation.min.js:153900–154250`*

```typescript
// l = full wrist quaternion solved from hand landmarks
// s = side string ('左' or '右')
// o = VRM model object
// M = sign multiplier (+1 left, -1 right)

const fixedAxis = new THREE.Vector3().fromArray(o.para.lower_arm_fixedAxis[s]);

// Extract the pronation angle from the wrist quaternion in YZX Euler decomposition.
// The X component of YZX Euler corresponds to the forearm's roll axis.
const euler = new THREE.Euler().setEulerFromQuaternion(wristQ, 'YZX');
let t = euler.x * -M;  // raw roll angle

// Wrap-around protection (handles ±π discontinuity in Euler representation)
const D = angleHistory[s];
if (D.angle != null && D.timestamp > RAF_timestamp - 250 &&
    Math.abs(t - D.angle) > Math.PI) {
  const e = t + Math.PI * 2 * (t > 0 ? -1 : 1);
  if (Math.abs(e) < Math.PI * (Math.sign(e) === M ? 1.5 : 1)) t = e;
}
D.angle     = t;
D.timestamp = RAF_timestamp;

// Distribute roll 50/50: half to LowerArm, half to hand-twist bone (手捩)
const d = -t * 0.5;
const rollQ = new THREE.Quaternion().setFromAxisAngle(fixedAxis, d);
handTwistBoneData.rot.copy(rollQ);               // 手捩 gets half
lowerArmBone.quaternion.multiplyQuaternions(rollQ.conjugate(), lowerArmBone.quaternion);
// Conjugate: the other half goes into the LowerArm bone itself
```

**Key insight:** XR Animator does NOT compute a palm-normal cross product. Instead,
the hand landmarks provide a full hand-orientation quaternion; the roll component is
then extracted via Euler decomposition (YZX order, take X). This works because the
hand-landmark solver inherently captures the wrist roll as part of its full 3D orientation.

---

## 6. MMD Twist Bone Pipeline

*Source: `MMD_SA.js:9561–9574`*

MMD rigs include dedicated twist (捩) bones: `左腕捩` (left arm twist), `右腕捩` (right arm twist),
`左手捩` (left hand twist), `右手捩` (right hand twist). These are MMD-specific bones that
encode the roll axis structurally. XR Animator reads back the accumulated roll from the
motion system and applies it to the VRM arm bones.

```typescript
// Executed every frame, after all MMD bone animations are applied:
for (const [LR, d] of [['左', 0], ['右', 1]]) {
  for (const [bName, bIdx] of [['腕', 0], ['手', 1]]) {
    const twistBone = mmdBones[LR + bName + '捩'];  // '左腕捩' or '右手捩'
    if (!twistBone) continue;

    const [axis, angle] = twistBone.quaternion.toAxisAngle();
    if (angle === 0) continue;

    // axis.x sign encodes which direction (left=+1, right=-1)
    const dir = (d === 0) ? 1 : -1;
    const sign = (Math.sign(axis.x) === dir) ? 1 : -1;

    // VRM bone name: 'leftUpperArm' or 'rightLowerArm'
    const vrmName = (dir === 1 ? 'left' : 'right') + (bIdx === 0 ? 'Upper' : 'Lower') + 'Arm';

    // Apply the twist angle around the X-axis (dir encodes sign)
    const twistQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(dir * sign, 0, 0),
      angle
    );
    this.process_rotation(twistQ, vrmName);  // coordinate flip for VRM0

    this.getBoneNode(vrmName).quaternion.multiply(twistQ);
  }
}
```

**When MMD twist bones are not present** (pure VRM model without MMD intermediate),
the wrist roll computed in §5 is applied directly to the LowerArm bone.

---

## 7. T-Pose Precomputation

*Source: `MMD_SA.js:9064–9148`*

At VRM model load time, XR Animator traverses the entire bone tree and stores the
full world-space T-pose state of every humanoid bone.

### 7a. World quaternion accumulation (`para.q0`)

```typescript
// Walk from each bone up to the scene root, accumulating quaternions
for (const name in humanBones) {
  let bone = humanBones[name].node;
  const q = new THREE.Quaternion();
  while (bone.type === 'Bone') {
    q.premultiply(bone.quaternion);  // parent-first accumulation
    bone = bone.parent;
  }
  para.q0[name] = q.toArray();  // world quaternion of this bone in T-pose
}
```

### 7b. World position accumulation (`para.pos0`)

```typescript
for (const name in humanBones) {
  let bone = humanBones[name].node;
  const pos = new THREE.Vector3();
  while (bone.type === 'Bone') {
    const parentWorldQ = para.q0[bone.name]
      ? new THREE.Quaternion().fromArray(para.q0[bone.name])
      : new THREE.Quaternion();
    pos.add(bone.position.clone().applyQuaternion(parentWorldQ));
    bone = bone.parent;
  }
  // Apply VRM0/VRM1 coordinate flip
  para.pos0[name] = this.process_position(pos).toArray();
}
```

### 7c. Derived measurements (computed once, used every frame)
*Source: `MMD_SA.js:9123–9147`*

```typescript
// Shoulder width (X-axis distance between upper arm attachment points)
para.shoulder_width = (para.pos0['leftUpperArm'][0] - para.pos0['rightUpperArm'][0]) * vrm_scale;

// Full arm length: shoulder → wrist (for IK scaling)
para.left_arm_length =
  distance(para.pos0['leftUpperArm'], para.pos0['leftHand']) * vrm_scale;

// Palm length (for finger scaling)
para.left_palm_length = para.pos0['leftMiddleProximal']
  ? distance(para.pos0['leftHand'], para.pos0['leftMiddleProximal']) * vrm_scale
  : model_defaults.left_palm_length;

// Leg length: thigh + shin (for ground-plane scaling)
para.left_leg_length =
  (para.pos0['leftUpperLeg'][1] - para.pos0['leftLowerLeg'][1] +
   para.pos0['leftLowerLeg'][1] - para.pos0['leftFoot'][1]) * vrm_scale;

// Spine height ratio (used for spine-to-hips redistribution)
para.spine_length = (para.pos0['neck'][1] - para.pos0['leftUpperLeg'][1]) * vrm_scale;

// Forearm longitudinal axis (VRM coordinate space)
para.lower_arm_fixedAxis['左'] = normalize(
  vec3(para.pos0['leftHand']).sub(vec3(para.pos0['leftLowerArm']))
);
para.lower_arm_fixedAxis['右'] = normalize(
  vec3(para.pos0['rightHand']).sub(vec3(para.pos0['rightLowerArm']))
);

// Spine-to-hips ratio: 0 = model has Chest bone, >0 = distribute spine rot into hips
para.spine_to_hips_ratio = para.pos0['chest'] ? 0 :
  1 - clamp(
    (para.pos0['neck'][1] - para.pos0['spine'][1]) /
    (para.pos0['neck'][1] - para.pos0['hips'][1]) * 2,
    0, 1
  );
```

**How `pos0` is used every frame:** The arm-solver scales landmark distances by the
ratio `model.left_arm_length / landmark_arm_length` before computing bone directions,
so the solved rotations are always relative to the model's actual proportions rather
than the user's body proportions. This ensures a small-headed VRM with long arms does
not produce a distorted result even when the user has short arms.

---

## 8. Finger Solving

*Source: `SA_system_emulation.min.js:126500–130000`*

### 8a. Per-joint direction solve

For each finger (0=thumb, 1=index, 2=middle, 3=ring, 4=pinky), for each phalanx:

```typescript
const restAxis = new THREE.Vector3(0, 1, 0);  // Y-up rest axis
const boneDir = distal.clone().sub(proximal).normalize();  // bone direction

let euler = new THREE.Vector3();
let quaternion = new THREE.Quaternion();

if (fingerIdx > 0 || phalanxIdx === 2) {
  // Non-thumb fingers and all distal phalanges: spherical coordinate decomposition
  euler.setFromVectorSpherical(restAxis, boneDir);  // custom extension
  quaternion.setFromEuler(euler, 'XZY');
} else {
  // Thumb (gimbal-lock-prone): use setFromUnitVectors directly
  quaternion.setFromUnitVectors(restAxis, boneDir);
  euler.setEulerFromQuaternion(quaternion, 'XZY');
}
```

**`setFromVectorSpherical`** is a Three.js extension that computes the Euler angles
representing the spherical-coordinate rotation from `from` to `to`:
```typescript
// Approximately: atan2 the azimuth and elevation separately
euler.x = -Math.asin(to.y);   // elevation (pitch/curl)
euler.z = Math.atan2(to.x, to.z);  // azimuth (spread)
// (actual implementation uses atan2 of vector components)
```
This avoids the Euler gimbal-lock issue that `setFromUnitVectors` → `Euler` decomposition
can produce at extreme (straight) finger poses.

### 8b. ROM clamping and anatomical constraints

```typescript
// Hard clamp: if bend-angle magnitude is implausible, force to pure curl
if (Math.abs(euler.z) > Math.PI / (fingerIdx === 0 ? 1.1 : 2.5) ||
    euler.x > Math.PI / (fingerIdx === 0 ? 1.1 : 3.0)) {
  // Fall back to angle-only (no spread)
  euler.set(-Math.abs(restAxis.angleTo(boneDir)), 0, 0);
}

// Maximum extension limit (hyperextension cap)
const minBend = -Math.PI / (fingerIdx === 0 ? 1.25 : 1.8);
if (euler.x < 0) euler.x = Math.max(euler.x, minBend);

// Spread scaling: reduce spread when finger is curled
const curlFactor = 1 - (minCurlAngle < -Math.PI/6 ? ... : 0);
euler.z *= curlFactor;
```

### 8c. Thumb metacarpal (CMC) special handling

The thumb CMC joint (`d === 0, m === 0`) uses a larger spread offset:
```typescript
// Thumb MCP spread: constant outward offset + tracked spread
euler.z = euler.z * (d === 0 ? 1.25 : 1) + (Math.PI/8 + (d === 0 ? Math.PI/8 : 0)) * sign;
```

Where `sign = (+1 for left, -1 for right)`.

---

## 9. Hip / Root Rotation & Spine Redistribution

### 9a. Body yaw from shoulder vector
*Source: `SA_system_emulation.min.js:75180–75714`*

The user's facing direction (yaw) is derived from the shoulder-to-shoulder vector:

```typescript
// d = right shoulder - left shoulder (image-space 3D)
const shoulderVec = rightShoulder.clone().sub(leftShoulder);

// Project onto the horizontal plane, use angle from X-axis to derive yaw
const euler = new THREE.Euler().setEulerFromQuaternion(
  new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), shoulderVec.normalize()),
  'ZYX'
);
const yaw = euler.y;  // body yaw (y-axis rotation)
```

The shoulder vector also provides the roll (Z-tilt), which is used to distinguish
when the person is leaning vs. physically rotating.

### 9b. Hip lean from neck-to-hip vector
*Source: `SA_system_emulation.min.js:100365–100500`*

```typescript
// m = mid-hip position, u = mid-shoulder position (both 3D)
const spineDir = shoulderMid.clone().add(hipMid).multiplyScalar(0.5);
// n is lerp'd toward world origin to compute relative spine tilt
// One Euro filter applied (minCutOff adapts with depth):
Re.filters[0].filter.minCutOff = (person_z_ratio < 1) ? 0.5 : Math.pow(...);
n.fromArray(Re.filter(n.toArray()));
// n.z = forward lean amount → feeds into upper-body pitch rotation
```

### 9c. Spine-to-hips redistribution
*Source: `MMD_SA.js:9550–9558`*

Applied every frame when the VRM model lacks a Chest bone (`para.spine_to_hips_ratio > 0`):

```typescript
const ratio = para.spine_to_hips_ratio;  // in [0, 1]

// Take a fraction of the solved spine rotation and push it into the hips
const spineContrib = new THREE.Quaternion()
  .set(0, 0, 0, 1)
  .slerp(spineBone.quaternion, ratio);
const spineContribInv = spineContrib.clone().conjugate();

// Hips absorb the extracted spine component
hipsBone.quaternion.multiply(spineContrib);

// Legs compensate (un-rotate) so they don't tilt with the hips
leftUpperLegBone.quaternion.premultiply(spineContribInv);
rightUpperLegBone.quaternion.premultiply(spineContribInv);

// Spine loses the component it gave to hips
spineBone.quaternion.premultiply(spineContribInv);
```

**Why this matters:** On models without a Chest bone, 100% of upper-body bend goes
into Spine. Without redistribution, the legs visually slide when the character bends
forward. This correction makes the hip "tilt with" the spine proportionally.

---

## 10. Visibility Gating — `blend_default_motion`

*Source: `SA_system_emulation.min.js:162000–163500`*

`blend_default_motion` is a per-bone scalar `[0, 1]` where:
- `0` = bone is fully controlled by live tracking
- `1` = bone is fully controlled by the idle/default animation

### 10a. State machine

Each tracked bone has a `_blend_default_motion` timestamp field:
- `> 0`: tracking just lost — holds the timestamp when loss was detected
- `< 0`: tracking just regained — negative timestamp marks re-entry
- `== 0`: steadily tracking

```typescript
// frames.get_blend_default_motion(channel, boneName, eased?)
function getBlendRatio(bone: BoneData, eased: boolean): number {
  const ENTRY_MS  = 250 * limb_entry_duration_pct / 100;   // blend-in duration (tracking regained)
  const RETURN_MS = 500 * limb_return_duration_pct / 100;  // blend-out duration (tracking lost)

  let n: number;
  if (bone._blend_default_motion > 0) {
    // Tracking lost: n ramps 0 → 1 over RETURN_MS
    n = Math.min((RAF_timestamp - bone._blend_default_motion) / RETURN_MS, 1);
  } else if (bone._blend_default_motion < 0) {
    // Tracking regained: n ramps 1 → 0 over ENTRY_MS
    n = 1 - Math.min((RAF_timestamp + bone._blend_default_motion) / ENTRY_MS, 1);
  } else {
    n = 0;
  }

  if (eased) {
    // Smooth-step easing (sine curve)
    n = n < 0.5
      ? (1 - Math.cos(n * Math.PI)) * 0.5
      : 0.5 + Math.sin((n - 0.5) * Math.PI) * 0.5;
  }
  return n;
}
```

### 10b. Usage in bone update

```typescript
const blendRatio = getBlendRatio(boneFrameData, /* eased= */ true);
// blendRatio = 0 → use live tracking; = 1 → use default animation

const finalQ = liveTrackedQ.clone().slerp(defaultAnimationQ, blendRatio);
vrmBone.quaternion.copy(finalQ);
```

### 10c. Triggering blend_default_motion

Visibility-based triggering (`SA_system_emulation.min.js:82452`):

```typescript
// Called when motion_tracking_upper_body_only is true (arm goes off-screen):
lt.set_blend_default_motion('skin', side + '腕',   true);  // UpperArm → idle
lt.set_blend_default_motion('skin', side + '手首', true);  // Wrist → idle
lt.set_blend_default_motion('skin', side + '肩',   true);  // Shoulder → idle
```

Score-based triggering (when landmark score < threshold):
```typescript
// animate.js:5242
const handOccluded = frames.get_blend_default_motion('skin', side + '手首') > 0.5;
if (handOccluded) {
  // Stop following the hand-camera target; use default arm position
}
```

---

## 11. Coordinate System Conversion — `process_rotation`

*Source: `MMD_SA.js:9320–9338`*

XR Animator's entire solver runs in **Three.js coordinate space**
(right-handed, Y-up: +X right, +Y up, +Z toward camera).

VRM0 uses **Unity/MMD coordinate space** (left-handed, Y-up: +X left, +Y up, +Z away).

The conversion applied to every bone quaternion before writing to VRM:

```typescript
// VRM0 only (is_VRM1 = false):
function process_rotation(q: THREE.Quaternion): THREE.Quaternion {
  q.x *= -1;  // flip X component
  q.z *= -1;  // flip Z component
  return q;
}

function process_position(p: THREE.Vector3): THREE.Vector3 {
  p.x *= -1;
  p.z *= -1;
  return p;
}
```

**Mathematical justification:** The transformation `R' = diag(-1, 1, -1) R diag(-1, 1, -1)`
maps a right-handed quaternion to its left-handed equivalent. In quaternion form,
this is equivalent to negating the X and Z components (since the Y-axis is the "up"
axis that is preserved in the handedness change).

For VRM1 models, `vrm.humanoid.autoUpdateHumanBones = true` is set, and `three-vrm`
handles the coordinate normalization internally. The `process_rotation` function
is not called for VRM1 bones.

---

## 12. Frame-Level VRM Application

*Source: `MMD_SA.js:9340–9400`*

At the start of every rendered frame, before applying any solved rotations:

```typescript
// 1. Reset all bones to their bind pose
if (is_VRM1) {
  vrm.humanoid.autoUpdateHumanBones = true;
  vrm.humanoid.resetNormalizedPose();  // VRM1: reset in normalized space
} else {
  vrm.humanoid.resetPose();             // VRM0: reset to T-pose
}

// 2. For VRM0: apply initial Y-axis flip (model faces +Z in Three.js, not -Z)
if (!is_VRM1) {
  mesh.quaternion.premultiply(q.set(0, 1, 0, 0));  // 180° Y-rotation
}

// 3. Apply solved bone quaternions directly
for (const boneName of allHumanoidBones) {
  const bone = getBoneNode(boneName);
  if (!bone) continue;
  bone.quaternion.copy(process_rotation(solvedQ[boneName], boneName));
  // bone.quaternion.copy(q) — NOT bone.rotation.set(euler) — avoids Euler order issues
}

// 4. Apply wrist roll (§6 twist bone pipeline)
applyTwistBones();

// 5. Apply spine redistribution (§9c)
applySpineToHipsRatio();

// 6. Update physics (spring bones)
vrm.update(deltaTime);
```

The critical invariant is that **every frame starts with a full pose reset**. Solved
rotations are absolute (relative to T-pose), not incremental. This prevents drift
from accumulating over time.

---

## 13. TypeScript Re-Implementation Checklist

To re-implement this solver in onapose (`client/src/`):

| # | Component | File to create/modify | Key API |
|---|---|---|---|
| 1 | `OneEuroFilter` class (scalar + vector) | `src/filters/OneEuroFilter.ts` | `filter(vec, timestamp)` |
| 2 | Per-landmark filter instances (33 pose + 21×2 hand) | `src/hooks/useVideoRecognition.ts` | Instantiate at init |
| 3 | Adaptive `beta` from `shoulder_width` | `src/hooks/useVideoRecognition.ts` | Before each predict call |
| 4 | `T-posePrecompute(vrm)` → `para` object | `src/solvers/tPosePrecompute.ts` | Run once at VRM load |
| 5 | `solveUpperArm(shoulder, elbow, parentInvQ, sign)` | `src/solvers/armSolver.ts` | Returns `THREE.Quaternion` |
| 6 | `solveLowerArm(elbow, wrist, upperArmQ, parentInvQ, sign)` | `src/solvers/armSolver.ts` | Returns `THREE.Quaternion` |
| 7 | `solveWristRoll(handQ, fixedAxis, sign)` → `{lowerArmDelta, handTwistQ}` | `src/solvers/wristRoll.ts` | YZX Euler X extraction |
| 8 | `solveFinger(landmarks, fingerIdx, phalanxIdx)` | `src/solvers/fingerSolver.ts` | `setFromVectorSpherical` custom |
| 9 | `blend_default_motion` state machine | `src/solvers/visibilityGate.ts` | Per-bone state + `getBlendRatio()` |
| 10 | `process_rotation(q, isVRM1)` | `src/solvers/coordinateConvert.ts` | Negate X+Z for VRM0 |
| 11 | `resetPose()` at frame start | `src/components/VRMAvatar.tsx` | Before any `bone.quaternion.copy()` |
| 12 | `spineToHipsRatio` redistribution | `src/components/VRMAvatar.tsx` | After spine bone is set |
| 13 | Switch from `.rotation` to `.quaternion.copy(q)` | `src/components/VRMAvatar.tsx` | All bone writes |

### Priority order
1. **Items 10, 11, 13** — eliminate coordinate errors and drift accumulation.  
   Zero code-risk, immediate visual improvement.
2. **Items 1, 2, 3** — One Euro Filter on landmarks.  
   Biggest quality improvement for effort; replaces Kalidokit's fixed lerp.
3. **Items 4, 5, 6** — custom arm solver (replaces Kalidokit Pose).  
   Eliminates gimbal lock at extreme arm angles.
4. **Item 7** — wrist roll.  
   Requires items 4–6 to be done first.
5. **Items 8, 9** — finger ROM + visibility gating.  
   Polish-tier improvements.
6. **Item 12** — spine redistribution.  
   Only noticeable on models without a Chest bone.

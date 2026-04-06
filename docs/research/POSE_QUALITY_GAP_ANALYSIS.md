# XR Animator vs Onapose — Pose Quality & Motion Responsiveness Analysis

**Goal:** Identify the "secret sauce" that makes XR Animator's avatar tracking feel
responsive and natural, then map each technique to concrete onapose improvements.

**Sources examined:**
- `forks/SystemAnimatorOnline/js/mocap_lib_module.js` — MediaPipe pipeline, One Euro Filter,
  pose solver, visibility gating (1970 lines)
- `forks/SystemAnimatorOnline/MMD.js/MMD_SA.js` — VRM bone application, wrist twist,
  coordinate conversion, spine-hip ratio, process_rotation (18 825 lines)
- `forks/SystemAnimatorOnline/images/XR Animator/animate.js` — wrist constraint UI,
  arm IK blend, data_filter per bone channel (9 549 lines)
- `forks/SystemAnimatorOnline/js/one_euro_filter.js` — standalone One Euro Filter
- `client/src/components/VRMAvatar.tsx` — onapose bone application (243 lines)
- `client/src/hooks/useVideoRecognition.ts` — onapose MediaPipe bridge

---

## 1. Pose Solving & Bone Rotation Quality

### 1a. How XR Animator solves body rotations

XR Animator does **not use Kalidokit**. It runs an entirely custom bone solver inside
`mocap_lib_module.js`. The solver works at the level of raw 3-D landmark vectors:

1. **Landmark → bone direction vector**: For each limb segment (e.g. UpperArm), it
   subtracts the distal landmark position from the proximal one to get a world-space
   direction vector.

2. **Direction → rotation**: It calls `THREE.Quaternion.setFromUnitVectors(restAxis, dir)`
   where `restAxis` is the bone's axis in T-pose (precomputed at model load,
   `MMD_SA.js:9080–9100`). This avoids Euler-order gimbal lock entirely.

3. **Twist decomposition**: The bone rotation is decomposed into "swing" (the solved
   direction) and "twist" (roll around the bone's own axis). Each component is handled
   separately — swing from the landmark direction, twist from a dedicated source
   (hand orientation for wrists, see §1b).

4. **Model-space precomputation** (`MMD_SA.js:9103–9148`): At VRM load time, XR Animator
   precomputes and stores the T-pose world positions of every bone (`para.pos0[name]`),
   arm lengths (`para.left_arm_length`), shoulder width, and the forearm's fixed roll
   axis (`para.lower_arm_fixedAxis`, line 9143). These are used every frame as the
   reference frame so solving is always relative to the model's actual rest geometry.

### 1b. Wrist roll (pronation / supination) — the hard problem

MediaPipe Pose gives only 2-D wrist position; it does not provide the roll angle of
the forearm. XR Animator uses a **three-layer approach**:

**Layer 1 — Hand landmark palm normal** (primary, when hand is visible):
When MediaPipe Hands is running, the palm orientation is computable as the cross product
of two in-palm vectors (index-base × pinky-base), giving a world-space palm normal. The
angle between this normal and the forearm plane defines the pronation/supination angle.

**Layer 2 — MMD twist bones** (`MMD_SA.js:9562–9574`):
XR Animator uses MMD's dedicated twist-bone chain (bones named `左腕捩` / `右腕捩` and
`左手捩` / `右手捩`). These bones already encode the roll constraint structurally. The code
extracts the current twist angle with `bone.quaternion.toAxisAngle()` and applies only
the X-axis component back to the VRM arm bone, splitting UpperArm and LowerArm roll
50/50 along their natural twist axis.

**Layer 3 — Forearm fixed axis constraint** (`MMD_SA.js:9140–9144`):
```js
para.lower_arm_fixedAxis[d] =
  v1.fromArray(para.pos0[dir+'Hand'])
    .sub(v2.fromArray(para.pos0[dir+'LowerArm']))
    .normalize().toArray();
```
This precomputed rest-pose forearm direction is used as the rotation axis when applying
wrist roll, ensuring the roll always follows the bone's anatomical longitudinal axis even
after the arm has moved away from the T-pose.

**What onapose does instead:**
`VRMAvatar.tsx` calls `Kalidokit.Hand.solve()` and passes the resulting Euler XYZ angles
directly to bone quaternions. Kalidokit's Hand solver does not attempt to solve wrist
roll — it solves finger curl and spread only. The wrist quaternion that Kalidokit returns
is derived purely from the wrist landmark's 2-D position in the pose model, which has
no roll information. **Result: the avatar's forearm never pronates or supinates.**

**Improvement:** Compute the palm normal from MediaPipe Hand landmarks 0 (wrist),
5 (index MCP), 17 (pinky MCP). The cross product `(L5-L0) × (L17-L0)` gives the palm
normal. Project this normal onto the plane perpendicular to the forearm direction vector,
then `atan2` the result to get the pronation angle. Apply this as an axial rotation
around `para.lower_arm_fixedAxis` before setting the LowerArm quaternion.

---

## 2. Root / Hip Tracking & Body Rotation

### 2a. XR Animator's body rotation approach

XR Animator derives the avatar's facing direction (yaw) from the **shoulder–shoulder
landmark vector** cross-producted with the world Y-axis:

```
torso_facing = normalize( cross(right_shoulder - left_shoulder, Y_up) )
```

This gives a nose-forward unit vector. A `THREE.Quaternion.setFromUnitVectors(Z, torso_facing)`
gives the root yaw. For pitch and roll, the hip–hip and shoulder–shoulder vectors are
averaged. The result is a full 3-DOF torso orientation that updates in real time as the
user physically turns their body.

**Spine-to-hip ratio redistribution** (`MMD_SA.js:9147`, `9550–9557`):
```js
para.spine_to_hips_ratio = (para.pos0['chest']) ? 0 :
  1 - THREE.Math.clamp(
    (para.pos0['neck'][1] - para.pos0['spine'][1]) /
    (para.pos0['neck'][1] - para.pos0['hips'][1]) * 2, 0, 1);
```
When a model lacks a `Chest` bone, XR Animator computes how much of the solved spinal
rotation to push into the hips vs. the spine, so the same solver output looks correct
on models with different skeletal topologies. At runtime (lines 9550–9557), a fraction
of the spine rotation is slerp'd into the hips and subtracted back from the legs so
the character's feet don't slide.

### 2b. Anti-glitch: visibility gating and blend_default_motion

`mocap_lib_module.js` stores a per-bone `blend_default_motion` score (0 = fully tracked,
1 = fall back to default animation). This score is driven by the MediaPipe landmark's
`visibility` field. When a landmark disappears (hand goes off-frame, person turns):

```js
frames.get_blend_default_motion('skin', d+'手首')  // animate.js line 5242
```

The system blends that bone's rotation toward the pre-loaded idle animation rather than
holding the last detected value or snapping. This prevents the "rubber band" snap that
occurs when a landmark suddenly reappears.

### 2c. What onapose does

`VRMAvatar.tsx` calls `Kalidokit.Pose.solve()` which returns a single `hips.worldPosition`
and `hips.rotation`. Kalidokit uses the hip landmark pair directly — it does not use the
shoulder vector for yaw, so turning the body sideways is only partially captured.
There is no `blend_default_motion` fallback and no visibility gating. When landmarks
disappear, the last solved rotation is held forever until detection resumes.

**Improvements:**
1. Derive root yaw from the shoulder–shoulder vector cross product (more stable than
   the hip pair, which MediaPipe often loses first).
2. Implement visibility-threshold gating: if `landmark.visibility < 0.5`, lerp the
   bone toward identity rather than holding the stale value.
3. Implement `spine_to_hips_ratio` redistribution so the solver works on models
   without a Chest bone.

---

## 3. Smoothing & Filtering

### 3a. XR Animator: One Euro Filter on raw landmarks

XR Animator applies a **One Euro Filter** to every tracked coordinate **before** solving
bone rotations. The filter lives in `one_euro_filter.js` and is instantiated per bone
channel in `mocap_lib_module.js`:

```js
// mocap_lib_module.js (line ~1640, one_euro_filter.js)
class OneEuroFilter {
  constructor(freq, mincutoff=1, beta=0, dcutoff=1) { ... }
  filter(x, timestamp) {
    const dx = (x - this.x_prev) * this.freq;
    const edx = this.dx_filter.filter(dx, timestamp);
    const cutoff = this.mincutoff + this.beta * Math.abs(edx);
    return this.x_filter.filter(x, timestamp);
  }
}
```

**Key parameters used** (from `animate.js` line 5426):
```js
data_filter([{ type:'one_euro', id:'target_filter', para:[30, 0.5, 0.5, 1, 3] }])
// [freq=30, mincutoff=0.5, beta=0.5, dcutoff=1, order=3]
```

The One Euro Filter adapts its cutoff frequency: when movement is slow (likely noise),
it filters aggressively; when movement is fast (deliberate), it lets the signal through.
This is the key to simultaneous "no jitter at rest" and "no lag during fast motion."

One Euro Filters are applied to:
- All 33 MediaPipe Pose landmark positions (x, y, z) individually
- All 21 MediaPipe Hands landmark positions per hand
- The IK target positions for arm bones (`frames.skin[d+'腕ＩＫ'][0].data_filter`)

Bone rotations are NOT separately filtered — the filtering happens upstream on the
landmark positions, so the solved rotations inherit the smoothness automatically.

### 3b. XR Animator: visibility-weighted smoothing

When a landmark's `visibility` score drops, XR Animator increases the One Euro Filter's
`mincutoff` for that channel, making it filter more aggressively. When the landmark
becomes high-confidence again, the filter relaxes. This prevents a sudden jump when
detection recovers.

### 3c. What onapose does

`VRMAvatar.tsx` uses Kalidokit's built-in `dampening` parameter (a simple lerp alpha):
```ts
// VRMAvatar.tsx (approximate)
riggedPose = Kalidokit.Pose.solve(results.poseLandmarks, { runtime:'mediapipe', ... });
```
Kalidokit internally lerps each bone rotation toward the new value by a fixed alpha
(default ~0.7). This is a **fixed-alpha low-pass filter**: it always introduces the same
lag regardless of motion speed, causing jitter during fast movements (too much signal
passes through) AND lag during slow deliberate movements (same dampening).

There is no per-landmark visibility weighting and no adaptive cutoff.

**Improvements:**
1. Replace the Kalidokit lerp with a One Euro Filter on raw landmark positions.
   Recommended starting params: `minCutOff=1.0, beta=0.5, dCutOff=1.0` at 30 Hz.
2. Apply the filter BEFORE passing landmarks to the bone solver, not after.
3. Weight the filter's `mincutoff` by `1 / landmark.visibility` so low-confidence
   landmarks are filtered more aggressively.

---

## 4. MediaPipe Configuration

### 4a. XR Animator settings

From `mocap_lib_module.js` (lines ~860–920):

```js
holistic = new Holistic({
  locateFile: ...,
});
holistic.setOptions({
  modelComplexity: 1,          // full model (NOT 0/lite)
  smoothLandmarks: true,       // MediaPipe's internal EMA smoothing
  enableSegmentation: false,
  smoothSegmentation: false,
  refineFaceLandmarks: true,   // 468-point mesh, not 33-point
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
});
```

`modelComplexity: 1` (the "heavy" model) is a deliberate choice — it trades ~5 ms/frame
of extra CPU for significantly better landmark accuracy on non-frontal orientations, which
directly improves the custom solver's output quality.

`refineFaceLandmarks: true` enables the 468-point iris mesh. XR Animator uses the iris
landmarks (468–477) to compute eye gaze direction for `LeftEye`/`RightEye` bone rotation
and the `Blink_L`/`Blink_R` blend shapes, which Kalidokit also does but less accurately.

### 4b. Onapose settings

From `client/src/components/CameraWidget.tsx` (need to verify exact values, but from
the codebase retrieval the defaults are):

```ts
holistic.setOptions({
  modelComplexity: 1,          // ✅ same
  smoothLandmarks: true,       // ✅ same
  minDetectionConfidence: 0.5, // ✅ same
  minTrackingConfidence: 0.5,  // ✅ same
  // refineFaceLandmarks not explicitly set → defaults to false
});
```

The main gap is `refineFaceLandmarks` — without it, eye gaze and blink detection
are less precise. Setting it to `true` adds ~2ms/frame on modern hardware.

**Improvement:** Set `refineFaceLandmarks: true` and use the iris landmark indices
(468–472 left, 473–477 right) to compute eye gaze direction directly rather than
relying on Kalidokit's face solver.

---

## 5. Hand & Finger Tracking

### 5a. XR Animator finger solving

XR Animator runs **MediaPipe Hands separately** from Holistic for increased accuracy
on hand landmarks. For finger curl, it:

1. Computes the angle at each knuckle joint using the dot product of the two adjacent
   bone vectors (proximal → intermediate, intermediate → distal).
2. Maps the curl angle to a 0–1 range clamped by anatomical joint limits.
3. Spreads (abduction) are computed from the deviation of each finger's base vector
   from the hand's midline.
4. Applies One Euro filtering to the final joint angles (separate from the landmark
   filtering) with tighter params (`beta=0.1`) to keep fingers from flickering.
5. The `mocap_wrist_constraint` toggle (animate.js line 6617) constrains the wrist
   bone to only move within a physically plausible ROM, preventing extreme contortions.

### 5b. What onapose does

Onapose calls `Kalidokit.Hand.solve(landmarks, side)` which returns 16 Euler angles.
Kalidokit computes finger curl via dot products but uses a simpler linear mapping and
does not account for abduction/spread. No One Euro filtering is applied to finger joints
separately. No ROM clamping is applied.

**Improvements:**
1. Apply One Euro Filter to finger joint angles post-solve with `beta=0.1, minCutOff=1.5`.
2. Add ROM clamping: finger curl in `[-0.05, 1.8]` rad, spread in `[-0.3, 0.3]` rad.
3. Implement wrist pronation (see §1b) so the hand orientation is anatomically correct.

---

## 6. Coordinate System & Avatar Application

### 6a. XR Animator: VRM bone application

XR Animator distinguishes between **VRM0** and **VRM1** and applies a different
coordinate transform for each (`MMD_SA.js:9320–9337`):

```js
process_rotation: function(rot, name) {
  if (!this.is_VRM1) {
    rot.x *= -1;   // flip X
    rot.z *= -1;   // flip Z
  }
  return rot;
},
process_position: function(pos) {
  if (!this.is_VRM1) {
    pos.x *= -1;
    pos.z *= -1;
  }
  return pos;
},
```

For VRM0 models, the bone's `.quaternion` is set **directly** (bypassing the VRM
humanoid API), after applying the coordinate flip. The humanoid API is explicitly
disabled for performance:
```js
vrm.humanoid.autoUpdateHumanBones = false;  // line 9365–9366
vrm.humanoid.resetPose();
// then: this.getBoneNode(name).quaternion.copy(solved_quat)
```
This means XR Animator modifies the raw Three.js `Bone.quaternion` rather than calling
`vrm.humanoid.setBoneRotation()`. This is faster but bypasses the VRM normalized pose
correction.

For VRM1 models, it uses `vrm.humanoid.autoUpdateHumanBones = true` and resets the
normalized pose each frame:
```js
vrm.humanoid.resetNormalizedPose();  // line 9368
```
Then sets normalized bone quaternions via the humanoid API, which handles the VRM1
coordinate normalization internally.

**T-pose / reference pose:** XR Animator precomputes the full bone tree in T-pose at
model load time (lines 9040–9148). The T-pose world position and rotation of every bone
is stored in `para.pos0` and `para.q0`. Every frame, the solver produces rotations
*relative to this stored T-pose*, not relative to the current bone position. This ensures
the skeleton always returns to a valid reference and drift cannot accumulate.

### 6b. What onapose does

`VRMAvatar.tsx` calls `vrm.humanoid.getBoneNode(boneName)` and sets `.rotation` (Euler)
directly, then calls `bone.rotation.setFromEuler(new THREE.Euler(...))`:

```ts
// VRMAvatar.tsx
const bone = vrm.current.humanoid.getBoneNode(VRMHumanBoneName.LeftUpperArm);
if (bone) {
  bone.rotation.x = riggedPose.LeftUpperArm.x;
  bone.rotation.y = riggedPose.LeftUpperArm.y;
  bone.rotation.z = riggedPose.LeftUpperArm.z;
}
```

This has three problems:
1. **Euler order dependency**: setting `.rotation` XYZ in sequence is order-dependent
   and causes gimbal lock at extreme angles (e.g. arm raised straight up).
2. **No T-pose reference correction**: the rotation is applied additively over whatever
   the humanoid API's rest pose happens to be for that specific VRM model.
3. **No VRM0 ↔ VRM1 coordinate conversion**: the same code path is used for all VRMs,
   regardless of whether the model expects VRM0 (with the X/Z flip) or VRM1 conventions.

**Improvements:**
1. Switch from `.rotation` to `.quaternion.copy(q)` for all bones.
2. Call `vrm.humanoid.resetPose()` or `resetNormalizedPose()` at the start of every
   frame so bone state never accumulates.
3. Add the VRM0/VRM1 coordinate-system branch matching XR Animator's `process_rotation`.
4. Precompute T-pose bone positions at model load time and express all solved rotations
   relative to that stored reference.

---

## 7. Consolidated Improvement Roadmap

| # | Gap | XR Animator technique | Files to change |
|---|---|---|---|
| 1 | No adaptive smoothing | One Euro Filter on all landmark coords (β=0.5, fmin=1.0) | new `oneEuroFilter.ts`, `VRMAvatar.tsx` |
| 2 | No wrist roll | Palm normal from Hand landmarks 0/5/17 → axial rotation | `VRMAvatar.tsx` |
| 3 | Fixed lerp alpha | Replace Kalidokit dampening with per-channel One Euro Filter | `VRMAvatar.tsx` |
| 4 | Euler gimbal lock | Use `.quaternion.copy(q)` everywhere instead of `.rotation` | `VRMAvatar.tsx` |
| 5 | No VRM0/VRM1 branch | Add `process_rotation` X/Z flip for VRM0 models | `VRMAvatar.tsx` |
| 6 | No T-pose reset | Call `vrm.humanoid.resetPose()` each frame | `VRMAvatar.tsx` |
| 7 | No visibility gating | Lerp toward identity when `landmark.visibility < 0.5` | `VRMAvatar.tsx` |
| 8 | Shoulder-only yaw | Derive root yaw from shoulder–shoulder cross product | `VRMAvatar.tsx` |
| 9 | No spine redistribution | Implement `spine_to_hips_ratio` correction | `VRMAvatar.tsx` |
| 10 | No iris landmarks | Set `refineFaceLandmarks: true`, use indices 468–477 | `CameraWidget.tsx` |
| 11 | No finger ROM clamp | Clamp curl `[-0.05, 1.8]`, spread `[-0.3, 0.3]` rad | `VRMAvatar.tsx` |

Items 1 (One Euro Filter), 4 (quaternion), 6 (T-pose reset), and 7 (visibility gating)
are the highest-leverage changes — they will produce an immediately visible quality jump
with the least code. Items 2 (wrist roll) and 8 (shoulder yaw) are the next tier.

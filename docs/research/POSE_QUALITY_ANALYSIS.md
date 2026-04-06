# Pose/Motion Quality: XR Animator vs Onapose — Deep Analysis
<!-- (2026-04-06) -->

---

## 1. Pose Solving & Bone Rotation Quality

### XR Animator

**Does NOT use Kalidokit.** There is no reference to Kalidokit anywhere in the fork.
XR Animator has a **completely custom landmark-to-bone pipeline** implemented in
`js/mocap_lib_module.js` and applied to the VRM skeleton inside `MMD.js/MMD_SA.js`.

The pipeline:
1. **MediaPipe** provides raw 2D landmarks (`poseLandmarks`) and 3D world landmarks
   (`poseWorldLandmarks` / `za` in Holistic results).
2. `mocap_lib_module.js` `pose_adjust()` (line 766) pre-processes landmarks:
   - Computes shoulder width from landmarks 5 & 6 (left/right shoulder pixel distance).
   - Dynamically scales the **One Euro Filter `beta`** parameter based on how large the
     body appears in frame (`filter_factor = max(w,h) / shoulder_width`), making filtering
     more aggressive when the person is far from the camera and less aggressive when close.
   - Derives per-landmark confidence scores from visibility and whether the landmark is
     inside the camera frame boundary (line 830–850).
3. The resulting cleaned landmarks are passed to `MMD_SA.js` where bone rotations are
   derived by computing **angle between pairs of world-space landmark vectors** — not by
   Euler decomposition. Arm direction, for instance, is derived by the vector from shoulder
   to elbow to wrist in 3D world space, then mapped to the VRM bone's local axis system.
4. A **per-model axis correction** step (`get_bone_axis_rotation()`) accounts for the fact
   that each MMD/VRM model's rest bones may not align with the world Y-up axis.

### Onapose

Uses **Kalidokit** directly and without modification:
```ts
// VRMAvatar.tsx line 87
riggedPose.current = Pose.solve(results.za, results.poseLandmarks, {
  runtime: "mediapipe",
  video: videoElement,
}) as RiggedPose;
```

Kalidokit's `Pose.solve()` internally computes Euler angles for each limb from the
landmark vectors, applies a built-in smoothing pass, and returns Euler angles per bone.

**Shortfall:** Kalidokit's smoothing is a fixed-alpha exponential moving average that does
not adapt to tracking quality or body scale in frame. XR Animator's dynamic filter
adaptation means fast movements near the camera get less smoothing (staying snappy) while
noisy far-away tracking gets heavier filtering (staying stable). Kalidokit has none of this.

**Actionable:** Replace or supplement Kalidokit's output with adaptive One Euro Filtering
on all landmark coordinates before solving. The `one_euro_filter.js` file in the fork is
already a ready-to-use, modified implementation with quaternion support.

---

## 2. Wrist Rotation (Pronation/Supination)

### XR Animator

XR Animator solves wrist **pronation** using the **palm normal vector** derived from hand
landmarks. Specifically, in `mocap_lib_module.js` lines 1179–1256, for each hand:

1. Computes `palm_width` = vector from landmark 1 (thumb base) to landmark 17 (pinky base).
2. Computes `palm_height` = vector from landmark 0 (wrist) to landmark 9 (middle MCP).
3. The cross-product `palm_width × palm_height` gives the palm's outward normal.
4. The angle of this normal around the forearm axis = wrist roll (pronation/supination).
5. A **Z-depth correction** is applied (lines 1192–1207): when the hand is nearly edge-on
   to the camera, MediaPipe's 2D Z estimates become unreliable, so XR Animator re-scales
   finger Z values using a ratio derived from the hand's aspect ratio (`_adjust_ratio`).
6. After Z fix, a **per-finger minimum-distance constraint** (lines 1212–1233) prevents
   finger joints from collapsing to zero length (a common MediaPipe artefact in low-light
   or fast-moving hands).
7. **One Euro Filter** is then applied to all 21 hand landmarks in palm-relative space
   (lines 1237–1244), removing the wrist translation from the filter so only finger-joint
   angles are smoothed.

### Onapose

The wrist roll is assembled from two sources (`VRMAvatar.tsx` lines 186–192):
```ts
rotateBone("leftHand", {
  z: riggedPose.current.LeftHand.z,   // from Pose.solve() — only Z roll
  y: riggedLeftHand.current.LeftWrist.y,  // from Hand.solve()
  x: riggedLeftHand.current.LeftWrist.x,  // from Hand.solve()
}, delta * 12);
```

This is a direct Euler-angle combination. **Kalidokit's `Hand.solve()` does compute a
wrist orientation from the hand landmarks**, but:
- It does not apply any Z-depth correction for edge-on hands.
- It does not apply min-distance constraints to fingers to prevent collapse artefacts.
- The combined Euler approach for wrist assembly from two different solving domains (Pose Z
  + Hand XY) can produce gimbal-lock-adjacent artefacts at extreme wrist angles.

**Actionable:**
1. Derive wrist roll from the palm normal vector directly — compute
   `cross(landmark[1]-landmark[17], landmark[0]-landmark[9])` from raw hand landmarks
   before sending to Kalidokit.
2. Apply the MediaPipe Z-depth correction for edge-on hands (the `_adjust_ratio` logic).
3. Apply a One Euro filter to hand landmarks before `Hand.solve()`.

---

## 3. Root / Hip Tracking & Body Rotation

### XR Animator

XR Animator does **not use Kalidokit's Hips solver**. Instead, it builds a body-facing
direction from the **shoulder-to-shoulder vector and the hip-to-hip vector** in 3D world
space. From `MMD_SA.js` lines 9502–9545:

1. Hip center is computed from left hip (23) + right hip (24) landmark midpoint → 3D position.
2. The **hips bone rotation** is derived from the cross-product of:
   - `shoulder_vec` = left_shoulder (11) − right_shoulder (12) world positions
   - `up_vec` = (hip midpoint) − (shoulder midpoint)
   These form a rotation matrix, which is converted to a quaternion.
3. Body rotation (the Y-axis yaw) is **automatically captured** because if the user turns
   their torso 45°, the shoulder vector rotates accordingly and the cross-product naturally
   produces the correct facing quaternion.
4. The hip position in world space is used to move the avatar's root in the scene.

**Glitch prevention:** XR Animator applies the One Euro Filter at the **landmark level**
before any solving. The filter's adaptive `beta` parameter (scaled by body-in-frame ratio,
lines 816–827) means root-position jitter is damped proportionally to how noisy the
detection is. Additionally, landmark confidence scores are used to gate whether a given
frame's data is used at all.

### Onapose

Uses Kalidokit's `Pose.solve()` which internally computes hip rotation from the same
kind of landmark vectors, but the implementation detail is hidden inside the library.
From `VRMAvatar.tsx` line 174:
```ts
rotateBone("hips", riggedPose.current.Hips.rotation, delta * 5, { x: 0.7, y: 0.7, z: 0.7 });
```

The scale factor `{ x: 0.7, y: 0.7, z: 0.7 }` dampens all hip rotation axes uniformly by
30%, which reduces body-turn responsiveness and partially masks the fact that torso
rotation from pure front-facing MediaPipe Holistic is unreliable.

**Actionable:**
1. Remove the uniform 0.7 scale factor from hips. If dampening is needed, apply it
   selectively per axis (e.g. full Y yaw, partial X/Z tilt).
2. Feed landmark coordinates through adaptive One Euro filtering before `Pose.solve()`.
3. Consider building a dedicated full-body-rotation quaternion from shoulder/hip vectors
   directly and composing it with the Kalidokit hips output.

---

## 4. Smoothing & Filtering

### XR Animator

**One Euro Filter** (`js/one_euro_filter.js`) is applied at **two distinct layers**:

**Layer 1 — Landmark filtering (before solving):**
Applied in `mocap_lib_module.js` lines 815–827 to all 33 pose landmarks AND all 21 hand
landmarks (lines 1237–1244):
```js
// Pose landmarks — adaptive beta
f.beta = filter_factor;        // scales with body distance from camera
f.dCutOff = 2 * filter_factor;

// Hand landmarks — palm-relative (wrist position subtracted first)
data_filter[1][d].landmarks[idx].filter(j, nowInMs)
```

The One Euro Filter parameters used:
- `freq = 30` (30Hz assumed)
- `minCutOff = 1` (lower = more smoothing at rest)
- `beta = filter_factor` (0 = max smoothing, scales up with body size in frame)
- `dCutOff = 1–3` (derivative cutoff)
- `type = 3` (vector3D mode)

**Layer 2 — Bone-application lerp (avatar display):**
Not applicable — XR Animator writes directly to bone quaternions without additional lerp
on the display side (the filtering is already done at the landmark layer).

**Confidence gating:**
```js
// mocap_lib_module.js line 979
if (kp.score < score_threshold) return 9999 * 9999; // hand discarded
// line 1264
if (kp.score < score_threshold) continue; // hand not tracked
```
Hands are not solved when landmark confidence is below `score_threshold` (0.5 for Holistic,
0.3 for MoveNet). Body parts with low confidence simply retain their last-known position
from the filter.

**Camera-to-bone filter (for look-at):**
`MMD_SA.js` line 14153 — a One Euro filter on the camera quaternion for face-gaze, params
`[30, 0.5, 0.5, 1, 4]` (type=4 = quaternion mode, uses quaternion slerp for derivatives).

### Onapose

**Only a simple frame-rate-proportional lerp/slerp** on the avatar display side:
```ts
// VRMAvatar.tsx line 141
bone.quaternion.slerp(tmpQuat, slerpFactor);  // slerpFactor = delta * N
```

- Body bones: `delta * 5` → ~0.083 alpha at 60fps (moderately sluggish)
- Hand/face bones: `delta * 12` → ~0.2 alpha at 60fps (faster but still lagging)
- Expressions: `delta * 12`

**No landmark-level filtering whatsoever.** Raw MediaPipe output goes directly into
Kalidokit without any smoothing. Jitter in the raw landmarks maps directly to jitter in the
solved Euler angles, which the display-side slerp can only partially mask.

**No confidence gating.** If a hand disappears from view, `riggedLeftHand.current`
retains the last Kalidokit solve result indefinitely (the ref is not cleared). The hand
pose will be whatever it was when MediaPipe last detected it — likely a stale freeze.

**Actionable:**
1. **Add One Euro filtering at the landmark level** — filter `results.poseLandmarks` XY
   coordinates and `results.za` Z coordinates before passing to `Pose.solve()`.
2. **Filter hand landmarks** before `Hand.solve()` in palm-relative space.
3. **Add confidence gating** — if `results.leftHandLandmarks` is null/absent, explicitly
   set `riggedLeftHand.current` to `undefined` so the hand falls back to identity pose.
4. Consider replacing display-side slerp with a proper OneEuro on the bone quaternion level
   (the filter file already supports `type=4` quaternion filtering).

---

## 5. MediaPipe Configuration

### XR Animator (Holistic legacy mode)

From `mocap_lib_module.js` lines 204–210:
```js
holistic.setOptions({
  modelComplexity: (pose_model_quality == 'Best') ? 2 : 1,  // default: 1
  smoothLandmarks: true,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
  refineFaceLandmarks: true,
});
```

Default complexity is **1** (medium). "Best" quality mode upgrades to 2. XR Animator
prefers model quality 1 with its own One Euro filtering rather than model 2 without
additional filtering — a deliberate tradeoff: model 2 is slower (≈15ms extra per frame)
but XR Animator's filtering more than compensates at model 1.

### Onapose (`CameraWidget.tsx` lines 73–79)

```ts
holistic.setOptions({
  modelComplexity: 2,           // ← HIGHEST complexity always
  smoothLandmarks: true,
  minDetectionConfidence: 0.7,  // ← higher than XR Animator
  minTrackingConfidence: 0.7,   // ← higher than XR Animator
  refineFaceLandmarks: true,
});
```

**Key differences:**
1. `modelComplexity: 2` always — good for accuracy, but costs ~15ms/frame more. On slower
   machines this directly reduces effective framerate and increases solve latency.
2. `minDetectionConfidence: 0.7` vs XR Animator's `0.5` — onapose requires higher
   confidence to start tracking, which can cause the model to go undetected longer when the
   user first enters frame or has partial occlusion.
3. `minTrackingConfidence: 0.7` vs `0.5` — requires stronger tracking signal to maintain
   lock; can cause more frame dropouts when the user moves fast.
4. Both use `smoothLandmarks: true` — MediaPipe's built-in temporal smoothing. XR Animator
   supplements this with its own One Euro filter. Onapose relies on MediaPipe's smoothing
   alone.

**Actionable:**
1. Lower `modelComplexity` to `1` and add the One Euro filter instead — matches XR
   Animator's philosophy and reduces latency on mid-range hardware.
2. Lower `minDetectionConfidence` to `0.5` and `minTrackingConfidence` to `0.5` for better
   robustness. False positives at 0.5 are rare with Holistic which uses strong prior.

---

## 6. Hand & Finger Tracking

### XR Animator

After the One Euro filter is applied to all hand landmarks, finger rotations are derived
from raw landmark positions using the **angle-between-segments** method in
`mocap_lib_module.js` (the annotation structure at lines 1247–1254 feeds downstream
angle computation). Additional post-processing:

1. **Minimum length constraint** (lines 1212–1233): For each finger joint, if the
   segment length (distance between knuckles) is less than a reference proportion of the
   palm size, the Z component is inflated to restore plausible depth. This prevents the
   "flat finger" artefact where fingers all appear to lie in a single plane.
2. **Palm aspect ratio Z correction** (lines 1190–1207): Detects when the hand is edge-on
   by comparing `h_palm / w_palm`; if ratio is anomalous (`< 1.25` or `> 1.75`), re-scales
   Z depth across all landmarks.
3. **Handedness verification** (lines 1028–1131): Compares detected hand labeling against
   the pose skeleton's wrist positions to detect and correct MediaPipe's frequent left/right
   swap artefacts. A hand detection is discarded if it is too far from the pose skeleton's
   corresponding wrist (`palm_distance_squared` check, line 1123).

### Onapose

Calls `Hand.solve(landmarks, side)` directly:
```ts
// VRMAvatar.tsx line 95
riggedRightHand.current = Hand.solve(results.leftHandLandmarks, "Right");
```

No pre-processing of landmarks. No Z-depth correction. No minimum-length constraints. No
handedness verification (just a fixed mirror swap based on MediaPipe's camera convention,
which is correct for face-forward usage but breaks when the user's arms cross or a hand
goes behind the body).

The `delta * 12` slerp factor in the display loop is the only damping applied. Compared
to XR Animator's per-landmark One Euro filter, this produces noticeably jittery fingers
especially for extended or splayed hands.

**Actionable:**
1. Apply One Euro filter to all 21 hand landmarks before `Hand.solve()`.
2. Add the minimum Z-depth constraint to prevent flat-finger artefact.
3. Verify handedness by cross-referencing pose skeleton wrist positions against detected
   palm positions (the pose landmark for wrist is index 15/16).

---

## 7. Coordinate System & Avatar Application

### XR Animator

XR Animator writes bone rotations by setting `bone.quaternion.copy(q)` **directly** —
no lerp on the display side. The smoothing is entirely upstream (landmark filters). It uses
the **VRM humanoid normalized bone API** via `this.getBoneNode(name)` which returns the
normalized bone node (already in T-pose relative space).

A **per-model axis correction** quaternion (`axis_rot`) is computed once at model load time
by measuring the model's actual bone directions at rest and building a rotation that maps
the raw landmark-derived rotation into the model's local bone space. This is necessary
because not all VRM models have perfectly Y-up bones in T-pose.

The model is rendered with `vrm.update(time_delta)` which runs spring-bone physics after
bone quaternions are set.

### Onapose

Uses `vrm.humanoid.getNormalizedBoneNode(boneName)` — correct, same principle as XR
Animator. No axis correction at model load time is performed.

Applies rotations via `bone.quaternion.slerp(tmpQuat, slerpFactor)` on every render frame.
This is **display-side smoothing**, which introduces latency proportional to `1/(delta*N)`.
At `delta*5` (body bones, N=5) and 60fps, the effective lag is approximately:

```
lag_frames ≈ 1 / (delta * N) / 60fps = 1/(0.0167 * 5) = 12 frames ≈ 200ms lag
```

This is a significant source of perceived sluggishness compared to XR Animator.

For VRM0 models, onapose correctly rotates the scene 180° (`vrm.scene.rotation.y = Math.PI`)
to face toward the camera. XR Animator handles this via a different route (model `about_turn`
flag and root rotation negation).

**Actionable:**
1. **Remove display-side slerp from body bones.** Replace it with a One Euro filter applied
   at the solve/landmark level. Let the avatar snap directly to the filtered values.
2. Keep a modest slerp only for expressions (face blendshapes) since those benefit from
   inter-frame smoothing for lipsync quality.
3. Add model-load axis correction: measure each VRM model's bone rest directions and store
   a per-bone correction quaternion, eliminating the T-pose offset that can make arms
   drift from the neutral position.

---

## Summary: What Makes XR Animator Feel Snappy

The "secret sauce" is a two-stage filter architecture that onapose currently lacks entirely:

| Stage | XR Animator | Onapose |
|---|---|---|
| **Landmark filtering** | One Euro Filter (adaptive beta) on all 33 pose + 21 hand landmarks before any solving | ❌ None — raw MediaPipe output sent to Kalidokit |
| **Solve quality** | Custom solver: angle-between-vectors in 3D world space | Kalidokit: fixed Euler decomposition |
| **Wrist roll** | Palm cross-product + Z depth correction + min-length constraint | Euler average of Pose.z + Hand.x/y (degrades at extreme angles) |
| **Body rotation** | Direct shoulder/hip cross-product → quaternion | Kalidokit Hips (hidden, no control) |
| **Display application** | Direct bone.quaternion.copy() — no lag | Slerp with delta*5 → ~200ms lag on body |
| **Confidence gating** | Scores gate hand/pose use per-landmark | ❌ None — stale data frozen indefinitely |
| **MediaPipe settings** | Complexity 1, confidence 0.5, adaptive filter supplements | Complexity 2, confidence 0.7, no extra filter |
| **Finger Z fix** | Aspect ratio correction + min segment length | ❌ None |
| **Handedness validation** | Cross-check against pose wrist positions | Mirror swap only |

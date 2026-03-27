# Pose Estimation Research: Alternatives & Limitations

## The Wrist Rotation Problem

This is the most significant known limitation of the current pipeline and worth understanding deeply before trying to fix it.

### Why it happens

Forearm roll — pronation (palm down) and supination (palm up) — is a rotation **around the bone's own longitudinal axis**. From a single RGB camera, a forearm rotating around its own axis produces almost no change in silhouette. The elbow and wrist landmark positions barely move. There is no visual information in a 2D projection that reliably encodes this rotation.

MediaPipe's pose model outputs 33 body landmarks as 3D points. Those points describe joint *positions* in space, not joint *orientations*. Kalidokit infers bone rotations by computing angles between adjacent landmark positions — which works well for most joints, but completely fails for axial rotation because the axis of rotation is parallel to the vector between landmarks.

**This is not a MediaPipe bug. It is a fundamental geometric constraint that affects every single-camera landmark-based system without exception.** No amount of model improvement fixes it without either a depth sensor, multiple cameras, or a fundamentally different approach (mesh fitting).

### What Kalidokit currently does

Kalidokit uses the pose hand landmark's Z coordinate as a rough proxy for wrist roll. This gives a coarse approximation that works for extreme positions (fully pronated vs. fully supinated) but is unreliable for intermediate angles and breaks entirely when the arm is extended toward or away from the camera.

---

## Current Solution: MediaPipe Holistic (Legacy)

The project currently uses `@mediapipe/holistic` — Google's original combined pipeline that runs face, pose, and hand detection in a single pass.

### What it provides
- 468 face landmarks (2D normalized)
- 33 pose landmarks (2D normalized + 3D world-space, hip-relative in meters)
- 21 hand landmarks per hand (3D)
- Runs entirely in browser via WASM
- Single inference pass for all body parts

### Known limitations
- **Deprecated**: Google has officially deprecated `@mediapipe/holistic` in favor of the new Tasks API
- No forearm roll / wrist axial rotation
- Hand ROI detection degrades when hands are near the face or body (known issue, documented in academic literature)
- Leg landmark quality drops significantly when lower body is partially occluded or out of frame
- Z-depth estimates for pose are relative and not metrically accurate for limb lengths

---

## Upgrade Path: MediaPipe Tasks API (New)

Google replaced the legacy Holistic with the [Tasks Vision API](https://ai.google.dev/edge/mediapipe/solutions/vision/holistic_landmarker), specifically `HolisticLandmarker`.

### Improvements over legacy
- Actively maintained (legacy is in maintenance-only mode)
- Better hand ROI detection — uses additional keypoints and Z-dimension for region estimation, reducing downstream hand tracking errors
- Cleaner API surface
- Same WASM browser deployment model
- Better face landmark accuracy, especially around eyebrows and mouth corners
- Still runs in-browser, no server required

### What it does NOT fix
- Forearm roll — same underlying model architecture, same geometric constraint
- Leg depth accuracy
- Occlusion handling

### Migration effort
Moderate. The API shape is different from legacy Holistic but the landmark schema is the same. Kalidokit is compatible with both since it just consumes landmark arrays.

---

## The Palm Normal Vector Trick (Partial Wrist Roll Fix)

This is the best available approach for improving wrist roll estimation without adding hardware or a new model. It's pure geometry on top of existing MediaPipe hand landmarks.

### How it works

MediaPipe's hand model gives 21 3D landmarks per hand. The palm forms a plane in 3D space. You can compute the normal vector of that plane using a cross product:

```js
// Key landmarks:
// 0  = wrist
// 5  = index finger MCP (knuckle)
// 17 = pinky MCP (knuckle)

const wrist    = landmarks[0];
const indexMCP = landmarks[5];
const pinkyMCP = landmarks[17];

// Two vectors across the palm plane
const v1 = subtract(indexMCP, wrist);   // wrist → index knuckle
const v2 = subtract(pinkyMCP, wrist);   // wrist → pinky knuckle

// Normal to the palm plane
const palmNormal = normalize(cross(v1, v2));
```

The angle of `palmNormal` relative to the camera's up/forward axes gives you the palm's facing direction — which directly encodes forearm roll. When the palm faces up, the forearm is supinated. When it faces down, it's pronated.

### Accuracy
- Works well for most natural hand orientations
- Breaks when the hand is edge-on to the camera (the palm plane becomes degenerate)
- Gives roughly 70% coverage of real-world forearm roll scenarios
- No additional model, no latency cost — pure math

### Implementation note
This should be computed in the browser alongside the existing Kalidokit solving, then used to override or blend with Kalidokit's wrist Z rotation value before sending over WebSocket.

---

## Alternative Models Evaluated

### TensorFlow.js `@tensorflow-models/hand-pose-detection`

A TF.js wrapper around the same underlying MediaPipe hand model, but with a cleaner JavaScript API and better-documented 3D coordinate space.

| Property | Value |
|---|---|
| Browser deployable | Yes |
| Landmarks | 21 per hand, 3D |
| Wrist roll | No (same model) |
| Multi-hand | Yes |
| Actively maintained | Yes |

Useful as a drop-in replacement for the hand component if migrating away from legacy Holistic, but doesn't solve the core problem.

---

### WiLoR (2024)

[WiLoR](https://rolpotamias.github.io/WiLoR/) is a state-of-the-art hand reconstruction model from 2024 that fits a full **MANO hand mesh** to monocular RGB input. Instead of outputting keypoints, it outputs a complete 3D hand geometry including wrist orientation as a rotation matrix.

This **genuinely solves forearm roll** because it's fitting a volumetric model to the image — the model has learned what a hand looks like at every rotation angle and can disambiguate axial rotation from appearance alone.

| Property | Value |
|---|---|
| Browser deployable | No — PyTorch only |
| Output | Full MANO mesh + wrist rotation matrix |
| Wrist roll | Yes, solved |
| Real-time capable | Yes (on GPU) |
| Multi-hand | Yes |

**Current status**: Not usable in the browser. Could theoretically run in the Node.js backend processing a video stream from the browser, but this adds a full video streaming layer, GPU dependency on the server side, and significant latency. Not practical for the current architecture.

**Future potential**: If WiLoR or a similar model gets ONNX-exported and quantized for WASM/WebGPU, it could replace the hand component of MediaPipe entirely and solve the wrist roll problem in-browser. Worth watching.

---

### PAHMT — Spatial-Temporal Arm-Hand Transformer (2022)

Research model that estimates arm twist by exploiting the biomechanical correlation between arm pose and hand gesture. The core insight: when you see a hand in a specific orientation, the forearm must be in a specific rotation to produce that hand configuration. The model learns this mapping from mocap data (200K frames).

| Property | Value |
|---|---|
| Browser deployable | No — research code only |
| Wrist roll | Yes, inferred from arm-hand correlation |
| Real-time | Designed for it |
| Available | Academic paper + code, not packaged |

Not practical today but represents the right direction for a future browser-deployable solution.

---

### MoveNet (TensorFlow.js)

Google's ultra-fast pose model, available in browser via TF.js.

| Property | Value |
|---|---|
| Browser deployable | Yes |
| Landmarks | 17 body keypoints only |
| Face | No |
| Hands | No (wrist point only, no fingers) |
| Speed | Extremely fast (~30ms on CPU) |
| Wrist roll | No |

Not suitable as a replacement — it doesn't provide hands or face. Could theoretically be used as a faster body pose backbone while MediaPipe handles hands and face separately, but the integration complexity isn't worth it given the marginal speed gain.

---

### OpenPose

The academic benchmark for pose estimation.

| Property | Value |
|---|---|
| Browser deployable | No — requires GPU server |
| Accuracy | High |
| Speed | Slow without dedicated GPU |
| Wrist roll | No |

Not viable for this architecture. Mentioned for completeness.

---

## Comparison Summary

| Model | Browser | Full Body | Face | Hands | Wrist Roll | Status |
|---|---|---|---|---|---|---|
| MediaPipe Holistic (legacy) | ✅ | ✅ | ✅ | ✅ | ❌ | Deprecated |
| MediaPipe Tasks HolisticLandmarker | ✅ | ✅ | ✅ | ✅ | ❌ | Active ✅ |
| TF.js hand-pose-detection | ✅ | ❌ | ❌ | ✅ | ❌ | Active ✅ |
| MoveNet | ✅ | Partial | ❌ | ❌ | ❌ | Active ✅ |
| WiLoR | ❌ | ❌ | ❌ | ✅ | ✅ | Research |
| PAHMT | ❌ | Partial | ❌ | ✅ | ✅ | Research |
| OpenPose | ❌ | ✅ | ✅ | ✅ | ❌ | Unmaintained |
| Palm normal trick | ✅ | ❌ | ❌ | Partial | ~70% | DIY math |

---

## Recommended Action Plan

### Short term (now)
1. Implement the **palm normal vector calculation** on top of existing MediaPipe hand landmarks to improve wrist roll. Zero dependencies, pure math, immediate improvement.
2. Migrate from `@mediapipe/holistic` (deprecated) to the new **MediaPipe Tasks `HolisticLandmarker`** for better hand ROI accuracy and long-term support.

### Medium term
3. Evaluate whether running **WiLoR in the Node.js bridge** (processing a downsampled video stream from the browser) is worth the added complexity for the quality improvement in hand/wrist data.

### Long term
4. Monitor **WebGPU adoption** — once WebGPU is stable across browsers, running larger models like WiLoR in-browser becomes feasible. The wrist roll problem likely gets solved in-browser within 1-2 years as these models get ported.

### Hardware shortcut (if acceptable)
An **iPhone running ARKit** via a companion app (e.g. iFacialMocap, or a custom app) can stream full 6DOF wrist orientation over UDP/OSC because ARKit uses the device's IMU + depth sensor. This completely bypasses the single-camera geometric limitation and could feed into the same OSC pipeline as the browser system. Not a browser solution, but worth noting if wrist quality becomes a blocker.

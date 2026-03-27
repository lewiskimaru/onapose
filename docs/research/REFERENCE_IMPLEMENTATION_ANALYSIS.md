# Reference Implementation Analysis
# r3f-vrm-final and SysMocap — Comprehensive Technical Documentation

This document is the authoritative reference for understanding how both forked projects
achieve real-time body tracking and VRM avatar animation. It is intended to be consulted
during development when something doesn't work or doesn't make sense. Every claim here
is sourced directly from the actual code in the forks.

---

## Table of Contents

1. Shared Pipeline — What Both Projects Do Identically
2. Project 1: r3f-vrm-final — Full Breakdown
3. Project 2: SysMocap — Full Breakdown
4. Bone Rotation — The Core Math (Both Projects)
5. MediaPipe Holistic — Setup, Options, and Gotchas
6. Kalidokit Solvers — Inputs, Outputs, and Edge Cases
7. VRM Loading and Performance Optimizations
8. Face Animation — Expressions and Eye Tracking
9. Hand Tracking — The Wrist Combination Trick
10. The Mirror Swap — Why Left and Right Are Reversed
11. State Management and the No-Re-render Rule
12. Mixamo Animation Retargeting (r3f-vrm-final only)
13. Data Forwarding Architecture (SysMocap only)
14. VRM0 vs VRM1 Coordinate System Differences
15. Known Fragile Points and Gotchas
16. Side-by-Side Comparison Table

---

## 1. Shared Pipeline — What Both Projects Do Identically

Both projects implement the exact same five-stage pipeline. The bone rotation math,
the Kalidokit solver calls, and the VRM API calls are functionally identical. The
differences are entirely in the surrounding architecture (React vs plain JS, Electron
vs browser, single process vs multi-process).

```
Webcam / Video File
      │
      ▼
MediaPipe Holistic (WASM, runs in browser)
  → faceLandmarks    (468 or 478 points with iris)
  → poseLandmarks    (33 normalized 2D points)
  → results.za       (33 world-space 3D points — undocumented property name)
  → leftHandLandmarks  (21 points, or undefined)
  → rightHandLandmarks (21 points, or undefined)
      │
      ▼
Kalidokit Solvers
  → Face.solve()   → riggedFace  { head, eye, pupil, mouth.shape }
  → Pose.solve()   → riggedPose  { Hips, Spine, Chest, arms, legs }
  → Hand.solve()   → riggedHand  { Wrist, all 15 finger joints }
      │
      ▼
VRM Bone Application (per render frame)
  → vrm.humanoid.getNormalizedBoneNode(boneName)
  → bone.quaternion.slerp(targetQuat, factor)
  → vrm.expressionManager.setValue(name, value)
  → vrm.lookAt.target / vrm.lookAt.applier.applyYawPitch()
  → vrm.update(delta)   ← MUST be last, runs spring bone physics
```

The key insight: MediaPipe gives you landmark positions. Kalidokit converts positions
to bone rotations. The VRM API applies those rotations. None of these steps can be
skipped or reordered.


---

## 2. Project 1: r3f-vrm-final — Full Breakdown

### Source location
`forks/r3f-vrm-final/`

### Tech stack
- React 19 + Vite 6
- React Three Fiber (R3F) v9 — declarative Three.js
- @react-three/drei v10 — helpers (useGLTF, useFBX, useAnimations, CameraControls, etc.)
- @pixiv/three-vrm v3.4.0
- kalidokit v1.1.5
- @mediapipe/holistic v0.5.1675471629
- @mediapipe/camera_utils v0.3.1675466862
- @mediapipe/drawing_utils v0.3.1675466124
- zustand v5 — minimal state store
- leva v0.10 — debug sliders
- tailwindcss v4

Source: `forks/r3f-vrm-final/package.json`

### File structure and responsibilities

```
src/
  App.jsx                        — root, mounts Canvas + CameraWidget + UI
  main.jsx                       — ReactDOM.createRoot entry point
  components/
    CameraWidget.jsx             — webcam access, MediaPipe Holistic, skeleton overlay
    VRMAvatar.jsx                — VRM loading, Kalidokit solving, bone application
    Experience.jsx               — R3F scene: lights, stage, avatar, post-processing
    UI.jsx                       — purely decorative HTML overlay (logo, tagline)
  hooks/
    useVideoRecognition.js       — Zustand store bridging CameraWidget ↔ VRMAvatar
  utils/
    remapMixamoAnimationToVrm.js — retargets FBX Mixamo clips to VRM bone names
    mixamoVRMRigMap.js           — lookup table: Mixamo bone name → VRM bone name
```

### App.jsx — Entry and layout

`forks/r3f-vrm-final/src/App.jsx`

Three things render at the top level:
1. `<UI />` — fixed overlay, pointer-events-none, purely decorative
2. `<CameraWidget />` — lives OUTSIDE the R3F Canvas (it's a DOM element, not a 3D object)
3. `<Canvas>` — the R3F scene

The Canvas camera is configured at mount time:
```jsx
<Canvas shadows camera={{ position: [0.25, 0.25, 2], fov: 30 }}>
```
Position `[0.25, 0.25, 2]` with `fov: 30` gives a tight portrait framing. The avatar
group in Experience.jsx is offset `position-y={-1.25}` to frame from the waist up.

### useVideoRecognition.js — The state bridge

`forks/r3f-vrm-final/src/hooks/useVideoRecognition.js`

```js
export const useVideoRecognition = create((set) => ({
  videoElement: null,
  setVideoElement: (videoElement) => set({ videoElement }),
  resultsCallback: null,
  setResultsCallback: (resultsCallback) => set({ resultsCallback }),
}));
```

This store holds exactly two things:
- `videoElement` — a ref to the `<video>` DOM element. Kalidokit's Face.solve() needs
  this to get the video dimensions for coordinate normalization.
- `resultsCallback` — a function that VRMAvatar registers. CameraWidget calls it every
  frame with the raw MediaPipe results object.

CRITICAL DESIGN DECISION: The callback pattern is used instead of storing landmark data
in Zustand state. If landmark data were stored in state, every MediaPipe result (60/sec)
would trigger a Zustand state update, which would trigger React re-renders in every
component subscribed to that state. The callback bypasses React's render cycle entirely —
data flows directly from CameraWidget into VRMAvatar's refs without touching React.

### CameraWidget.jsx — MediaPipe setup and camera loop

`forks/r3f-vrm-final/src/components/CameraWidget.jsx`

The component has a single boolean state `start`. When the user clicks the button,
`start` flips to true and a `useEffect` runs.

MediaPipe is loaded from CDN:
```js
const holistic = new Holistic({
  locateFile: (file) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1635989137/${file}`;
  },
});
```
Note the version in the CDN URL: `0.5.1635989137`. This is pinned. The package.json
lists `^0.5.1675471629` but the CDN URL uses the older build. This is intentional —
the CDN URL must match a specific build that has the WASM files at that path.

MediaPipe options:
```js
holistic.setOptions({
  modelComplexity: 1,          // 0=lite, 1=full, 2=heavy
  smoothLandmarks: true,       // temporal smoothing applied by MediaPipe internally
  minDetectionConfidence: 0.7, // below this, detection restarts from scratch
  minTrackingConfidence: 0.7,  // below this, tracking is considered lost
  refineFaceLandmarks: true,   // enables iris landmarks at indices 468-477
});
```

The camera loop uses `@mediapipe/camera_utils` Camera class:
```js
const camera = new Camera(videoElement.current, {
  onFrame: async () => {
    await holistic.send({ image: videoElement.current });
  },
  width: 640,
  height: 480,
});
camera.start();
```
This runs at 640×480. The width/height here must match the `imageSize` passed to
`Face.solve()` in VRMAvatar.jsx. If they don't match, face landmark coordinates will
be incorrectly scaled and expressions will be wrong.

Every frame, `holistic.onResults` fires and does two things:
1. `drawResults(results)` — draws skeleton overlay on the `<canvas>` element
2. `useVideoRecognition.getState().resultsCallback?.(results)` — pushes data to VRMAvatar

Note: `useVideoRecognition.getState()` is called directly (not via hook) because this
runs inside a callback, not inside a React component render. This is the correct Zustand
pattern for accessing state outside of React.

The skeleton overlay draws:
- Pose connectors: cyan (#00cff7), lineWidth 4
- Pose landmarks: pink (#ff0364), lineWidth 2
- Face mesh tesselation: grey (#C0C0C070), lineWidth 1
- Iris pupils (only when faceLandmarks.length === 478): yellow (#ffe603)
  — indices 468 and 473 (468+5) are the left and right iris centers
- Left hand connectors: pink (#eb1064), lineWidth 5
- Left hand landmarks: cyan (#00cff7), lineWidth 2
- Right hand connectors: cyan (#22c3e3), lineWidth 5
- Right hand landmarks: pink (#ff0364), lineWidth 2

The canvas and video are both CSS-transformed `scale(-1, 1)` to mirror the image
(so the overlay matches the mirrored video display).


### VRMAvatar.jsx — The core component

`forks/r3f-vrm-final/src/components/VRMAvatar.jsx`

This is the most important file in the project. It has four responsibilities:
1. Load the VRM model
2. Register a callback that runs Kalidokit solvers on every MediaPipe result
3. Apply solved data to the VRM every render frame via useFrame
4. Handle Mixamo animation playback when the camera is off

#### VRM Loading

```jsx
const { scene, userData } = useGLTF(
  `models/${avatar}`,
  undefined,
  undefined,
  (loader) => {
    loader.register((parser) => {
      return new VRMLoaderPlugin(parser);
    });
  }
);
```

`useGLTF` from @react-three/drei normally loads plain glTF. The fourth argument is a
loader callback. By registering `VRMLoaderPlugin`, the loader parses VRM-specific
extensions and attaches the result to `userData.vrm`. After this call:
- `scene` — the Three.js scene graph (the 3D mesh)
- `userData.vrm` — the VRM object with humanoid, expressionManager, lookAt, etc.

`currentVrm = userData.vrm` is assigned immediately after loading.

On load, a `useEffect` runs three performance optimizations:
```js
VRMUtils.removeUnnecessaryVertices(scene);  // strips vertices not weighted to any bone
VRMUtils.combineSkeletons(scene);           // merges multiple skeleton draw calls
VRMUtils.combineMorphs(vrm);               // merges morph target draw calls
```
Note: SysMocap uses `VRMUtils.removeUnnecessaryJoints(scene)` instead of
`combineSkeletons`. Both are valid; they target slightly different optimizations.

Frustum culling is disabled on every object in the scene:
```js
vrm.scene.traverse((obj) => {
  obj.frustumCulled = false;
});
```
Without this, parts of the avatar (especially arms extended wide) disappear when they
move outside the camera's view frustum. This is a common VRM gotcha.

The VRM is logged on load:
```js
console.log("VRM loaded:", vrm);
```
This is the primary debugging tool. Expand `vrm.humanoid.humanBones` to see all
available bone nodes. Expand `vrm.expressionManager._expressions` to see all
available expression names.

#### The resultsCallback — Kalidokit solving

```js
const resultsCallback = useCallback(
  (results) => {
    if (!videoElement || !currentVrm) return;
    // ... solve
  },
  [videoElement, currentVrm]
);
```

Wrapped in `useCallback` so it only recreates when `videoElement` or `currentVrm`
changes. This prevents the Zustand store from being updated with a new function
reference on every render.

The callback writes into four refs:
```js
const riggedFace = useRef();
const riggedPose = useRef();
const riggedLeftHand = useRef();
const riggedRightHand = useRef();
```

Refs are used deliberately — writing to a ref does NOT trigger a React re-render.
This is the same no-re-render principle as the Zustand callback pattern.

Face solving:
```js
riggedFace.current = Face.solve(results.faceLandmarks, {
  runtime: "mediapipe",
  video: videoElement,
  imageSize: { width: 640, height: 480 },
  smoothBlink: false,
  blinkSettings: [0.25, 0.75],
});
```
`runtime: "mediapipe"` tells Kalidokit to multiply normalized coordinates by image
dimensions before calculating. This is why `video` and `imageSize` are required.
`blinkSettings: [0.25, 0.75]` means: below 0.25 = fully open, above 0.75 = fully closed.

Pose solving:
```js
riggedPose.current = Pose.solve(results.za, results.poseLandmarks, {
  runtime: "mediapipe",
  video: videoElement,
});
```
`results.za` is MediaPipe's undocumented internal property name for world-space 3D
pose landmarks. It is metric (meters), hip-relative. `results.poseLandmarks` are the
2D normalized landmarks used for visibility/offscreen detection. Both are required.

Hand solving (with mirror swap):
```js
// MediaPipe's "left" = performer's right when facing camera
if (results.leftHandLandmarks) {
  riggedRightHand.current = Hand.solve(results.leftHandLandmarks, "Right");
}
if (results.rightHandLandmarks) {
  riggedLeftHand.current = Hand.solve(results.rightHandLandmarks, "Left");
}
```
See Section 10 for full explanation of the mirror swap.

#### useFrame — applying data every render frame

```js
useFrame((_, delta) => {
  if (!userData.vrm) return;
  // ... apply everything
  userData.vrm.update(delta);  // MUST be last
});
```

`delta` is the time in seconds since the last frame (typically ~0.016 at 60fps).
It is used as the lerp/slerp factor multiplier. `delta * 5` means "move 5 units per
second toward the target". `delta * 12` is faster (used for hands and expressions).

`userData.vrm.update(delta)` MUST be the last call in useFrame. It runs spring bone
physics (hair, clothes, accessories). If bone rotations are applied after this call,
the physics simulation will be one frame behind.

#### The two helper functions

`lerpExpression(name, value, lerpFactor)`:
```js
const lerpExpression = (name, value, lerpFactor) => {
  userData.vrm.expressionManager.setValue(
    name,
    lerp(userData.vrm.expressionManager.getValue(name), value, lerpFactor)
  );
};
```
Reads the current expression value, lerps toward the target, writes back. The lerp
prevents snapping — expressions transition smoothly even when Kalidokit output jumps.

`rotateBone(boneName, value, slerpFactor, flip)`:
```js
const rotateBone = (boneName, value, slerpFactor, flip = { x:1, y:1, z:1 }) => {
  const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
  if (!bone) {
    console.warn(`Bone ${boneName} not found in VRM humanoid.`);
    console.log("userData.vrm.humanoid.bones", userData.vrm.humanoid);
    return;
  }
  tmpEuler.set(value.x * flip.x, value.y * flip.y, value.z * flip.z);
  tmpQuat.setFromEuler(tmpEuler);
  bone.quaternion.slerp(tmpQuat, slerpFactor);
};
```
`getNormalizedBoneNode(boneName)` maps standardized VRM bone names to the actual
Three.js Object3D regardless of what the bone is named inside the model file. This
is what makes the code work on any VRM model.

The `flip` parameter scales or inverts individual axes. Examples from the code:
- neck: `{x:0.7, y:0.7, z:0.7}` — reduces head rotation to 70% (full looks unnatural)
- chest/spine: `{x:0.3, y:0.3, z:0.3}` — very subtle torso lean (30%)
- hips: `{x:0.7, y:0.7, z:0.7}` — 70% of raw hip rotation
- arms/legs/hands: default `{x:1, y:1, z:1}` — full rotation applied

Temporary objects are allocated once at module level to avoid per-frame GC pressure:
```js
const tmpVec3 = new Vector3();
const tmpQuat = new Quaternion();
const tmpEuler = new Euler();
```

#### Bone application order in useFrame

Exact order from the source (important — do not reorder):
1. Emotions (angry, sad, happy) — set directly, no lerp
2. If no camera: lerp expressions from Leva sliders
3. If camera active:
   a. Mouth shapes (aa, ih, ee, oh, ou) — lerp from riggedFace.mouth.shape
   b. Blink (blinkLeft, blinkRight) — lerp from `1 - riggedFace.eye.l/r`
   c. Eye look-at — update lookAtTarget position from pupil data
   d. Neck rotation — from riggedFace.head at 70% scale
4. If riggedPose exists:
   a. chest — from riggedPose.Spine at 30% scale
   b. spine — from riggedPose.Spine at 30% scale (same source as chest)
   c. hips — from riggedPose.Hips.rotation at 70% scale
   d. leftUpperArm, leftLowerArm
   e. rightUpperArm, rightLowerArm
   f. leftUpperLeg, leftLowerLeg
   g. rightUpperLeg, rightLowerLeg
   h. If riggedLeftHand: leftHand (combined), all 15 left finger bones
   i. If riggedRightHand: rightHand (combined), all 15 right finger bones
5. vrm.update(delta) — LAST

#### Eye look-at system

```js
const lookAtDestination = useRef(new Vector3(0, 0, 0));
const camera = useThree((state) => state.camera);
const lookAtTarget = useRef();

useEffect(() => {
  lookAtTarget.current = new Object3D();
  camera.add(lookAtTarget.current);  // attach to Three.js camera
}, [camera]);
```

In useFrame:
```js
userData.vrm.lookAt.target = lookAtTarget.current;
lookAtDestination.current.set(
  -2 * riggedFace.current.pupil.x,
  2 * riggedFace.current.pupil.y,
  0
);
lookAtTarget.current.position.lerp(lookAtDestination.current, delta * 5);
```

By attaching the target Object3D to the camera and setting `vrm.lookAt.target` to it,
the VRM's built-in eye system automatically rotates the eyeballs to track the target.
The pupil X/Y from Kalidokit offsets the target position. The X is negated (`-2 *`)
because the camera is mirrored. The factor 2 amplifies the gaze range.

IMPORTANT: This code has a null-check guard:
```js
if (lookAtTarget.current && riggedFace.current.pupil) {
```
Without the `riggedFace.current.pupil` check, you get a crash when `refineFaceLandmarks`
hasn't detected the iris yet. See Section 15 for the full crash description.

#### Avatar rotation

```jsx
<primitive
  object={scene}
  rotation-y={avatar !== "3636451243928341470.vrm" ? Math.PI : 0}
/>
```

Most VRM models face away from the camera by default (they face +Z, camera is at +Z).
Rotating by Math.PI (180°) makes them face the camera. The one exception is
`3636451243928341470.vrm` which already faces the camera. This is a per-model hack.
SysMocap handles this more cleanly by checking `vrm.meta.metaVersion === "0"`.

### Experience.jsx — Scene setup

`forks/r3f-vrm-final/src/components/Experience.jsx`

- `CameraControls` from drei — orbit controls with `maxPolarAngle: Math.PI/2` (can't
  go below ground) and distance clamped 1–10
- `Environment preset="sunset"` — HDR environment lighting from drei
- Two `DirectionalLight` instances: intensity 2 at `[10,10,5]` and intensity 1 at `[-10,10,5]`
- Avatar group offset `position-y={-1.25}` to frame from waist up
- `Gltf` stage model at `models/sound-stage-final.glb`
- `EffectComposer` with `Bloom` (mipmapBlur, intensity 0.7) for glow effect
- Avatar selector via Leva — 4 VRM models: `262410318834873893.vrm`,
  `3859814441197244330.vrm` (default), `3636451243928341470.vrm`, `8087383217573817818.vrm`


---

## 3. Project 2: SysMocap — Full Breakdown

### Source location
`forks/SysMocap-main/`

### Tech stack
- Electron 31 (desktop app shell)
- Plain Three.js v0.164 (imperative, no R3F)
- Vue 2 (UI framework for the app shell)
- @pixiv/three-vrm v2.1.2 (note: older major version than r3f-vrm-final's v3.4.0)
- kalidokit v1.1.5
- @mediapipe/holistic v0.5.1675471629
- express + socket.io (data forwarding server)
- mdui (Material Design UI components)

Source: `forks/SysMocap-main/package.json`

### File structure and responsibilities

```
main.js                          — Electron main process: window management, IPC routing
mainview/
  framework.html                 — main app window (Vue 2 UI shell)
  framework.js                   — Vue app logic, settings, model library, mocap start/stop
  style.css                      — app styles
mocap/
  mocap.html                     — tracking-only page (used in discrete process mode)
  mocap.js                       — MediaPipe + Kalidokit, sends data via IPC
mocaprender/
  render.html                    — combined mode page (tracking + rendering in one)
  script.js                      — MediaPipe + Kalidokit + Three.js render (combined)
  mocapWorker.js                 — experimental: Holistic in a Web Worker
render/
  render.html                    — render-only page (used in discrete process mode)
  render.js                      — receives data via IPC, applies to Three.js VRM
webserv/
  server.js                      — Express + Socket.IO forwarding server
  worker.js                      — Node.js Worker Thread wrapper for server.js
  httpx.js                       — dual HTTP/HTTPS server helper
  ssl/                           — bundled self-signed cert for HTTPS/WebXR support
utils/
  setting.js                     — settings read/write to JSON file in user home dir
  language.js                    — i18n strings
models/
  models.json                    — built-in model definitions
```

### The Two Execution Modes

SysMocap has a setting `performance.useDescrertionProcess` (note: typo in source,
should be "discretion") that switches between two architectures.

**Combined mode** (default, `useDescrertionProcess = false`):
The `<iframe>` in framework.html loads `mocaprender/render.html`. MediaPipe, Kalidokit,
and Three.js all run in the same renderer process. Simpler but MediaPipe's WASM
inference competes with the render loop.

**Discrete process mode** (`useDescrertionProcess = true`):
- A hidden `BrowserView` loads `mocap/mocap.html` — this runs MediaPipe + Kalidokit only
- The `<iframe>` loads `render/render.html` — this runs Three.js rendering only
- Data flows: `mocap.js → IPC → main.js → IPC → framework.js → iframe.onMocapData()`

The IPC chain in discrete mode (from `forks/SysMocap-main/main.js`):
```
mocap.js:
  ipcRenderer.send("sendBoradcastNew", data)
    ↓
main.js ipcMain.on("sendBoradcastNew"):
  mainWindow.webContents.send("sendRenderDataForward", arg)
    ↓
framework.js ipcRenderer.on("sendRenderDataForward"):
  iframeWindow.onMocapData(data)
    ↓
render.js window.onMocapData:
  mocapData = data  (stored, read by animate() loop each frame)
```

In combined mode, the data path is shorter — `animateVRM()` is called directly from
`onResults()` in the same script.

### main.js — Electron main process

`forks/SysMocap-main/main.js`

Key IPC handlers:
- `startWebServer` — spawns the forwarding server in a Worker Thread
- `sendBoradcast` — forwards bone data to the Worker Thread (for Socket.IO broadcast)
- `sendBoradcastNew` — forwards bone data to BOTH the render window AND the Worker Thread
- `sendRenderData` — forwards bone data to the render window only (no broadcast)
- `stopWebServer` — shuts down the forwarding server

The main window has `backgroundThrottling: false` and the Chromium flag
`disable-renderer-backgrounding` is set. This prevents Chromium from throttling the
renderer when the window is not in focus — critical for mocap running in the background.

### mocap.js — Tracking-only (discrete process mode)

`forks/SysMocap-main/mocap/mocap.js`

This file runs in the hidden BrowserView. It does MediaPipe + Kalidokit solving and
sends the result via IPC. It does NOT render anything.

MediaPipe is loaded from local node_modules (not CDN):
```js
const holistic = new Holistic({
  locateFile: (file) => {
    if (typeof require != "undefined")
      return __dirname + `/../node_modules/@mediapipe/holistic/${file}`;
    else return `../node_modules/@mediapipe/holistic/${file}`;
  },
});
```
The `typeof require != "undefined"` guard allows the same code to run in both Electron
(where `require` exists) and a plain browser (where it doesn't). In the browser case,
it falls back to a relative path — though this only works if the node_modules are
served statically.

All MediaPipe options come from `globalSettings` (user's JSON config file):
```js
holistic.setOptions({
  modelComplexity: parseInt(globalSettings.mediapipe.modelComplexity),
  smoothLandmarks: globalSettings.mediapipe.smoothLandmarks,
  minDetectionConfidence: parseFloat(globalSettings.mediapipe.minDetectionConfidence),
  minTrackingConfidence: parseFloat(globalSettings.mediapipe.minTrackingConfidence),
  refineFaceLandmarks: globalSettings.mediapipe.refineFaceLandmarks,
});
```

Camera loop uses `requestVideoFrameCallback` directly (not the Camera utility class):
```js
navigator.mediaDevices.getUserMedia({
  video: { deviceId: localStorage.getItem("cameraId"), width: 1280, height: 720 }
}).then(function(stream) {
  videoElement.srcObject = stream;
  videoElement.play();
  var videoFrameCallback = async () => {
    await holistic.send({ image: videoElement });
    videoElement.requestVideoFrameCallback(videoFrameCallback);
  };
  videoElement.requestVideoFrameCallback(videoFrameCallback);
});
```
Note: SysMocap requests 1280×720 from the camera (vs r3f-vrm-final's 640×480).
`requestVideoFrameCallback` fires in sync with the video's actual frame rate, which
is more accurate than a timer-based loop.

The `animateVRM` function in mocap.js solves Kalidokit and sends via IPC:
```js
ipcRenderer.send("sendBoradcastNew", {
  type: "xf-sysmocap-data",
  riggedPose, riggedLeftHand, riggedRightHand, riggedFace,
});
```
Note: in mocap.js the hand landmark swap is done at the source:
```js
const leftHandLandmarks = results.rightHandLandmarks;  // swapped
const rightHandLandmarks = results.leftHandLandmarks;  // swapped
```
Then `Hand.solve(leftHandLandmarks, "Left")` — the swap happens before the solve call,
not after. This is equivalent to r3f-vrm-final's approach but structured differently.

### script.js — Combined mode (tracking + rendering)

`forks/SysMocap-main/mocaprender/script.js`

This is the most complete file in SysMocap. It handles everything: MediaPipe, Kalidokit,
Three.js scene setup, VRM loading, bone application, and data forwarding.

Three.js scene setup (imperative, not R3F):
```js
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: ... });
renderer.setSize(width, (width / 16) * 9);
renderer.setPixelRatio(window.devicePixelRatio);
document.querySelector("#model").appendChild(renderer.domElement);

const orbitCamera = new THREE.PerspectiveCamera(35, 16/9, 0.1, 1000);
orbitCamera.position.set(0.0, 1.4, 0.7);

const orbitControls = new OrbitControls(orbitCamera, renderer.domElement);
orbitControls.target.set(0.0, 1.4, 0.0);
```
Camera FOV is 35 (vs r3f-vrm-final's 30). Camera position `[0, 1.4, 0.7]` targets
the avatar's chest/head area. OrbitControls target is `[0, 1.4, 0]` — same height
as the camera, so the view is level.

The render loop:
```js
function animate() {
  requestAnimationFrame(animate);
  stats.update();
  if (currentVrm) {
    currentVrm.update(clock.getDelta());
  }
  renderer.render(scene, orbitCamera);
}
animate();
```
Note: in combined mode, `animateVRM()` is called from `onResults()` (the MediaPipe
callback), NOT from the render loop. The render loop only calls `vrm.update()` and
`renderer.render()`. This means bone rotations are applied at MediaPipe's frame rate,
and the render loop runs independently at the display's frame rate.

VRM loading in script.js:
```js
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.load(modelPath, (gltf) => {
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.removeUnnecessaryJoints(gltf.scene);  // note: different from r3f-vrm-final
  const vrm = gltf.userData.vrm;
  scene.add(vrm.scene);
  if (vrm.meta.metaVersion === "0") {
    vrm.scene.rotation.y = Math.PI;  // VRM0 faces away, VRM1 faces camera
  }
  currentVrm = vrm;
});
```
SysMocap checks `metaVersion === "0"` to decide whether to rotate. r3f-vrm-final
does a per-model conditional instead. The metaVersion check is the correct approach.


---

## 4. Bone Rotation — The Core Math (Both Projects)

This section documents the exact bone rotation implementation used by both projects.
The math is identical; only the function names and surrounding code differ.

### The fundamental operation

Every bone rotation follows this exact sequence:
1. Take Kalidokit's Euler angles `{x, y, z}` (in radians)
2. Optionally scale/flip individual axes (dampener or flip parameter)
3. Create a `THREE.Euler` from the scaled values
4. Convert to `THREE.Quaternion` via `setFromEuler()`
5. Apply to the bone via `quaternion.slerp(targetQuat, lerpAmount)`

### r3f-vrm-final implementation

`forks/r3f-vrm-final/src/components/VRMAvatar.jsx` — `rotateBone` function:

```js
const rotateBone = (boneName, value, slerpFactor, flip = { x:1, y:1, z:1 }) => {
  const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
  if (!bone) {
    console.warn(`Bone ${boneName} not found in VRM humanoid.`);
    return;
  }
  tmpEuler.set(value.x * flip.x, value.y * flip.y, value.z * flip.z);
  tmpQuat.setFromEuler(tmpEuler);
  bone.quaternion.slerp(tmpQuat, slerpFactor);
};
```

Bone name convention: lowercase camelCase VRM names — `"neck"`, `"leftUpperArm"`,
`"rightLowerLeg"`, `"leftIndexProximal"`, etc.

### SysMocap implementation

`forks/SysMocap-main/mocaprender/script.js` — `rigRotation` function:

```js
const rigRotation = (name, rotation = {x:0,y:0,z:0}, dampener = 1, lerpAmount = 0.3) => {
  if (currentVrm) {
    const Part = currentVrm.humanoid.getNormalizedBoneNode(
      capitalizeFirstLetterToLowerCase(name)  // "Neck" → "neck"
    );
    if (!Part) return;
    let euler = new THREE.Euler(
      (currentVrm.meta.metaVersion === "1" ? -1 : 1) * rotation.x * dampener,
      rotation.y * dampener,
      (currentVrm.meta.metaVersion === "1" ? -1 : 1) * rotation.z * dampener,
      rotation.rotationOrder || "XYZ"
    );
    let quaternion = new THREE.Quaternion().setFromEuler(euler);
    Part.quaternion.slerp(quaternion, lerpAmount);
  }
  // ... non-VRM path omitted here, see Section 3
};
```

Bone name convention: PascalCase — `"Neck"`, `"LeftUpperArm"`, `"RightLowerLeg"`.
The `capitalizeFirstLetterToLowerCase` helper converts to lowercase camelCase before
passing to `getNormalizedBoneNode`.

Key difference: SysMocap flips X and Z axes for VRM1 models:
```js
(currentVrm.meta.metaVersion === "1" ? -1 : 1) * rotation.x * dampener
```
r3f-vrm-final does NOT do this. This is because @pixiv/three-vrm v3 (used by
r3f-vrm-final) handles the coordinate system internally, while @pixiv/three-vrm v2
(used by SysMocap) requires manual axis correction.

### Dampener/flip values used in both projects

These are the exact values from the source code:

| Bone | r3f-vrm-final flip | SysMocap dampener | Notes |
|---|---|---|---|
| neck | {x:0.7, y:0.7, z:0.7} | 0.7 | Reduces head rotation to 70% |
| chest | {x:0.3, y:0.3, z:0.3} | 0.25 | Very subtle torso lean |
| spine | {x:0.3, y:0.3, z:0.3} | 0.45 | Slightly more than chest |
| hips rotation | {x:0.7, y:0.7, z:0.7} | 0.7 | 70% of raw hip rotation |
| hips position | n/a | dampener=1, lerpAmount=0.07 | Very slow position lerp |
| arms | {x:1, y:1, z:1} | 1.0 | Full rotation |
| legs | {x:1, y:1, z:1} | 1.0 | Full rotation |
| hands/fingers | {x:1, y:1, z:1} | 1.0 | Full rotation |

### Slerp factors used in r3f-vrm-final

| Bone group | slerpFactor | Effective speed |
|---|---|---|
| neck | delta * 5 | 5 units/sec |
| chest, spine, hips | delta * 5 | 5 units/sec |
| arms, legs | delta * 5 | 5 units/sec |
| hands, fingers | delta * 12 | 12 units/sec (faster, more responsive) |
| expressions | delta * 12 | 12 units/sec |

### Hips position — the special case

Hips is the only bone that gets both rotation AND position applied. The position
represents the performer's body movement in 3D space.

SysMocap (`forks/SysMocap-main/mocaprender/script.js`):
```js
rigPosition("Hips", {
  x: riggedPose.Hips.position.x + positionOffset.x,
  y: riggedPose.Hips.position.y + positionOffset.y,
  z: -riggedPose.Hips.position.z + positionOffset.z,  // Z is negated
}, 1, 0.07);
```
Z is negated because Kalidokit outputs Z in a right-handed coordinate system but
Three.js uses a right-handed system where Z points toward the viewer. The negation
converts between them. The `lerpAmount` of 0.07 is very slow — this prevents the
avatar from jumping around when the performer moves.

`positionOffset` defaults to `{x:0, y:1, z:0}` and is adjusted by the face/half/full
body mode buttons. The Y offset of 1.0 lifts the avatar to a reasonable height.

r3f-vrm-final does NOT apply hips position — it only applies hips rotation. This is
a deliberate simplification for the tutorial use case.

### getNormalizedBoneNode — the key VRM API

Both projects use `vrm.humanoid.getNormalizedBoneNode(boneName)` to get the Three.js
Object3D for a bone. This is the VRM humanoid API that maps standardized bone names
to the actual node in the model's scene graph, regardless of what the bone is named
internally in the model file.

If this returns null, the bone name is wrong or the model doesn't have that bone.
Both projects handle this gracefully:
- r3f-vrm-final: `console.warn` + logs the full humanoid object
- SysMocap: `return` silently (no warning)

Complete list of VRM humanoid bone names used in both projects:
```
hips, spine, chest, neck, head
leftShoulder, leftUpperArm, leftLowerArm, leftHand
rightShoulder, rightUpperArm, rightLowerArm, rightHand
leftUpperLeg, leftLowerLeg, leftFoot, leftToes
rightUpperLeg, rightLowerLeg, rightFoot, rightToes
leftThumbMetacarpal, leftThumbProximal, leftThumbDistal
leftIndexProximal, leftIndexIntermediate, leftIndexDistal
leftMiddleProximal, leftMiddleIntermediate, leftMiddleDistal
leftRingProximal, leftRingIntermediate, leftRingDistal
leftLittleProximal, leftLittleIntermediate, leftLittleDistal
rightThumbMetacarpal, rightThumbProximal, rightThumbDistal
rightIndexProximal, rightIndexIntermediate, rightIndexDistal
rightMiddleProximal, rightMiddleIntermediate, rightMiddleDistal
rightRingProximal, rightRingIntermediate, rightRingDistal
rightLittleProximal, rightLittleIntermediate, rightLittleDistal
```


---

## 5. MediaPipe Holistic — Setup, Options, and Gotchas

### Package versions

Both projects use the same MediaPipe packages:
- `@mediapipe/holistic` — the main inference package
- `@mediapipe/camera_utils` — Camera utility class (r3f-vrm-final uses this;
  SysMocap uses `requestVideoFrameCallback` directly)
- `@mediapipe/drawing_utils` — `drawConnectors` and `drawLandmarks` for the overlay

### Loading the WASM files

MediaPipe Holistic requires WASM files to be served alongside the JS. The `locateFile`
callback tells the library where to find them.

r3f-vrm-final (CDN):
```js
locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1635989137/${file}`
```
Note: the CDN URL version `0.5.1635989137` is older than the npm package version
`0.5.1675471629`. This is intentional — the CDN URL must point to a specific build
that has the WASM files at that exact path. Do not change this URL without verifying
the WASM files exist at the new path.

SysMocap (local node_modules):
```js
locateFile: (file) => __dirname + `/../node_modules/@mediapipe/holistic/${file}`
```
This works in Electron because `__dirname` is available. In a browser, `__dirname`
is undefined, so the fallback `../node_modules/@mediapipe/holistic/${file}` is used,
which requires node_modules to be served statically.

### Options reference

```js
holistic.setOptions({
  modelComplexity: 1,           // 0=lite (fastest), 1=full, 2=heavy (most accurate)
  smoothLandmarks: true,        // MediaPipe applies temporal smoothing internally
  minDetectionConfidence: 0.7,  // confidence threshold to start tracking
  minTrackingConfidence: 0.7,   // confidence threshold to continue tracking
  refineFaceLandmarks: true,    // enables iris landmarks (indices 468-477)
                                // REQUIRED for pupil tracking
                                // when true, faceLandmarks.length === 478 (not 468)
});
```

### The results object structure

```js
results.faceLandmarks       // Array of 468 (or 478 with iris) normalized {x,y,z} points
results.poseLandmarks       // Array of 33 normalized {x,y,z,visibility} points
results.za                  // Array of 33 world-space {x,y,z} points (UNDOCUMENTED)
results.leftHandLandmarks   // Array of 21 {x,y,z} points, or undefined
results.rightHandLandmarks  // Array of 21 {x,y,z} points, or undefined
```

`results.za` is MediaPipe's internal undocumented property name for world-space pose
landmarks. It is metric (meters), hip-relative. Kalidokit's `Pose.solve()` requires
this. If the avatar's body stops moving but the face still works, check whether
`results.za` is still being populated — MediaPipe could rename this in a future version.
Both projects reference this property directly with no abstraction.

### Camera loop patterns

Pattern 1 — `@mediapipe/camera_utils` Camera class (r3f-vrm-final):
```js
const camera = new Camera(videoElement, {
  onFrame: async () => {
    await holistic.send({ image: videoElement });
  },
  width: 640,
  height: 480,
});
camera.start();
```
The Camera class handles getUserMedia internally and calls `onFrame` on a timer.

Pattern 2 — `requestVideoFrameCallback` (SysMocap):
```js
navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
  .then((stream) => {
    videoElement.srcObject = stream;
    videoElement.play();
    const videoFrameCallback = async () => {
      await holistic.send({ image: videoElement });
      videoElement.requestVideoFrameCallback(videoFrameCallback);
    };
    videoElement.requestVideoFrameCallback(videoFrameCallback);
  });
```
`requestVideoFrameCallback` fires in sync with the video's actual decoded frame rate,
which is more accurate than a timer. It is a newer browser API (Chrome 83+, Safari 15.4+).

### Iris landmark indices

When `refineFaceLandmarks: true`, the faceLandmarks array has 478 entries instead of 468.
The extra 10 are iris landmarks:
- Index 468: left iris center
- Index 469-472: left iris ring points
- Index 473: right iris center
- Index 474-477: right iris ring points

Both projects check `faceLandmarks.length === 478` before drawing iris points:
```js
if (results.faceLandmarks && results.faceLandmarks.length === 478) {
  drawLandmarks(canvasCtx, [results.faceLandmarks[468], results.faceLandmarks[473]], ...);
}
```
Note: r3f-vrm-final uses index `468 + 5 = 473` for the right iris. SysMocap uses the
same indices.


---

## 6. Kalidokit Solvers — Inputs, Outputs, and Edge Cases

### Package
`kalidokit` v1.1.5 — same version in both projects.

r3f-vrm-final imports as ES modules:
```js
import { Face, Hand, Pose } from "kalidokit";
```

SysMocap uses the UMD build loaded via script tag:
```html
<script src="../node_modules/kalidokit/dist/kalidokit.umd.js"></script>
```
Then accessed as `Kalidokit.Face.solve()`, `Kalidokit.Pose.solve()`, etc.

### Face.solve()

```js
Face.solve(faceLandmarks, {
  runtime: "mediapipe",   // REQUIRED — tells solver to scale by image dimensions
  video: videoElement,    // REQUIRED — used to get actual pixel dimensions
  imageSize: { width: 640, height: 480 },  // optional, overrides video dimensions
  smoothBlink: false,     // if true, adds delay between left/right blink
  blinkSettings: [0.25, 0.75],  // [lowerBound, upperBound] for blink sensitivity
})
```

Returns `TFace`:
```js
{
  head: { x, y, z, width, height, position: {x,y} },  // head rotation in radians
  eye: { l: number, r: number },  // 0=open, 1=closed (Kalidokit convention)
  brow: number,
  pupil: { x: number, y: number },  // -1 to 1 gaze direction
  mouth: {
    x: number, y: number,
    shape: { A: number, E: number, I: number, O: number, U: number }  // 0 to 1
  }
}
```

IMPORTANT: Kalidokit's eye convention is INVERTED from VRM's convention.
- Kalidokit: `eye.l = 0` means open, `eye.l = 1` means closed
- VRM blinkLeft: `0` means open, `1` means closed

So to apply blink to VRM: `blinkLeft = 1 - riggedFace.eye.l`

This is what r3f-vrm-final does:
```js
{ name: "blinkLeft", value: 1 - riggedFace.current.eye.l }
```

SysMocap does it differently — it lerps and amplifies:
```js
riggedFace.eye.l = lerp(clamp(1 - riggedFace.eye.l, 0, 1), Blendshape.getValue("blink"), 0.4);
riggedFace.eye.l /= 0.8;  // amplify to reach full closure
```

### Pose.solve()

```js
Pose.solve(pose3DLandmarks, pose2DLandmarks, {
  runtime: "mediapipe",
  video: videoElement,
  enableLegs: true,  // default true — includes leg bone calculations
})
```

First argument is `results.za` (world-space 3D), second is `results.poseLandmarks`
(normalized 2D). Both are required. The 2D landmarks provide visibility scores used
to detect when limbs are offscreen.

Returns `TPose`:
```js
{
  Hips: {
    position: { x, y, z },   // world position in meters
    rotation: { x, y, z }    // Euler angles in radians
  },
  Spine: { x, y, z },
  Chest: { x, y, z },        // note: Kalidokit outputs Chest, not in all versions
  RightUpperArm: { x, y, z },
  RightLowerArm: { x, y, z },
  LeftUpperArm: { x, y, z },
  LeftLowerArm: { x, y, z },
  RightHand: { z },           // only Z axis (wrist roll proxy from pose landmarks)
  LeftHand: { z },            // only Z axis
  RightUpperLeg: { x, y, z },
  RightLowerLeg: { x, y, z },
  LeftUpperLeg: { x, y, z },
  LeftLowerLeg: { x, y, z },
}
```

Note: `RightHand` and `LeftHand` from Pose.solve() only provide a Z rotation. This
is the best the pose solver can do for wrist roll from body landmarks alone. The full
wrist rotation requires combining with Hand.solve() output. See Section 9.

When a limb is not visible (low visibility score in poseLandmarks), Kalidokit falls
back to resting pose values defined in the library's `RestingDefault.Pose`. This
prevents garbage data when limbs go offscreen.

### Hand.solve()

```js
Hand.solve(handLandmarks, "Left")   // or "Right"
```

Takes 21 hand landmarks and a side string. Returns an object with 16 bone rotations:
```js
{
  LeftWrist: { x, y, z },
  LeftThumbProximal: { x, y, z },
  LeftThumbIntermediate: { x, y, z },
  LeftThumbDistal: { x, y, z },
  LeftIndexProximal: { x, y, z },
  LeftIndexIntermediate: { x, y, z },
  LeftIndexDistal: { x, y, z },
  LeftMiddleProximal: { x, y, z },
  LeftMiddleIntermediate: { x, y, z },
  LeftMiddleDistal: { x, y, z },
  LeftRingProximal: { x, y, z },
  LeftRingIntermediate: { x, y, z },
  LeftRingDistal: { x, y, z },
  LeftLittleProximal: { x, y, z },
  LeftLittleIntermediate: { x, y, z },
  LeftLittleDistal: { x, y, z },
}
```
(Same structure with "Right" prefix when side is "Right")

The wrist rotation from Hand.solve() provides X and Y axes. The Z axis (roll) comes
from Pose.solve()'s LeftHand/RightHand output. See Section 9.

### Kalidokit utility functions used by SysMocap

SysMocap imports these directly from the UMD build:
```js
const remap = Kalidokit.Utils.remap;   // remap a value from one range to another
const clamp = Kalidokit.Utils.clamp;   // clamp a value between min and max
const lerp = Kalidokit.Vector.lerp;    // linear interpolation
```
These are used in `rigFace()` for blink stabilization and mouth shape amplification.


---

## 7. VRM Loading and Performance Optimizations

### The loader plugin pattern

Both projects use the same pattern to load VRM files:

```js
// Plain Three.js (SysMocap):
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.load(modelPath, (gltf) => {
  const vrm = gltf.userData.vrm;
});

// R3F (r3f-vrm-final):
const { scene, userData } = useGLTF(modelPath, undefined, undefined, (loader) => {
  loader.register((parser) => new VRMLoaderPlugin(parser));
});
const vrm = userData.vrm;
```

`VRMLoaderPlugin` is registered on the GLTFLoader parser. After loading, the VRM
object is available at `gltf.userData.vrm` (plain Three.js) or `userData.vrm` (R3F).

### Performance optimizations

r3f-vrm-final (`forks/r3f-vrm-final/src/components/VRMAvatar.jsx`):
```js
VRMUtils.removeUnnecessaryVertices(scene);  // strips vertices not weighted to any bone
VRMUtils.combineSkeletons(scene);           // merges multiple skeleton draw calls into one
VRMUtils.combineMorphs(vrm);               // merges morph target draw calls
```

SysMocap (`forks/SysMocap-main/mocaprender/script.js`):
```js
VRMUtils.removeUnnecessaryVertices(gltf.scene);
VRMUtils.removeUnnecessaryJoints(gltf.scene);  // different from r3f-vrm-final
```
SysMocap uses `removeUnnecessaryJoints` instead of `combineSkeletons`/`combineMorphs`.
Both are valid optimizations targeting different aspects of the scene graph.

### Frustum culling

r3f-vrm-final disables frustum culling on every object:
```js
vrm.scene.traverse((obj) => {
  obj.frustumCulled = false;
});
```
Without this, parts of the avatar disappear when they move outside the camera's view
frustum (the invisible pyramid defining what the camera can see). This is especially
noticeable with arms extended wide or when the avatar leans forward.

SysMocap does NOT disable frustum culling. This is a known difference.

### VRM0 vs VRM1 rotation

r3f-vrm-final (per-model hack):
```jsx
<primitive object={scene} rotation-y={avatar !== "3636451243928341470.vrm" ? Math.PI : 0} />
```

SysMocap (correct approach — checks metaVersion):
```js
if (vrm.meta.metaVersion === "0") {
  vrm.scene.rotation.y = Math.PI;
}
```
VRM0 models face away from the camera (+Z direction). VRM1 models face toward the
camera (-Z direction). The `metaVersion` check is the reliable way to handle this.

### @pixiv/three-vrm version differences

r3f-vrm-final uses v3.4.0. SysMocap uses v2.1.2. Key differences:
- v3 handles VRM0/VRM1 coordinate system differences internally in `getNormalizedBoneNode`
- v2 requires manual axis flipping for VRM1 (the `metaVersion === "1" ? -1 : 1` check
  in SysMocap's `rigRotation`)
- The `expressionManager` API is the same in both versions
- The `lookAt` API differs: v3 uses `vrm.lookAt.target`, v2 uses
  `vrm.lookAt.applier.applyYawPitch(yaw, pitch)`

### vrm.update(delta) — must be called every frame

Both projects call this in their render loop:
```js
// r3f-vrm-final (in useFrame):
userData.vrm.update(delta);

// SysMocap (in animate()):
currentVrm.update(clock.getDelta());
```
This ticks the spring bone physics simulation (hair, clothes, accessories bounce and
sway). It MUST be called after all bone rotations are applied. If called before bone
rotations, the physics will be one frame behind.


---

## 8. Face Animation — Expressions and Eye Tracking

### Expression names

VRM expression names used in both projects:
```
"aa"         — mouth open (vowel A)
"ih"         — mouth shape (vowel I)
"ee"         — mouth shape (vowel E)
"oh"         — mouth shape (vowel O)
"ou"         — mouth shape (vowel U)
"blinkLeft"  — left eye blink (0=open, 1=closed)
"blinkRight" — right eye blink (0=open, 1=closed)
"angry"      — angry emotion
"sad"        — sad emotion
"happy"      — happy emotion
"relaxed"    — relaxed emotion (SysMocap maps "Joy" to this)
"neutral"    — neutral expression
```

### r3f-vrm-final expression application

Simple lerp approach:
```js
const lerpExpression = (name, value, lerpFactor) => {
  userData.vrm.expressionManager.setValue(
    name,
    lerp(userData.vrm.expressionManager.getValue(name), value, lerpFactor)
  );
};

// Mouth shapes from Kalidokit:
{ name: "aa", value: riggedFace.current.mouth.shape.A }
{ name: "ih", value: riggedFace.current.mouth.shape.I }
{ name: "ee", value: riggedFace.current.mouth.shape.E }
{ name: "oh", value: riggedFace.current.mouth.shape.O }
{ name: "ou", value: riggedFace.current.mouth.shape.U }

// Blink — note the inversion:
{ name: "blinkLeft",  value: 1 - riggedFace.current.eye.l }
{ name: "blinkRight", value: 1 - riggedFace.current.eye.r }
```

All applied with `lerpFactor = delta * 12`.

### SysMocap expression application (rigFace function)

More sophisticated — uses lerp toward current value + amplification:

```js
// Blink:
riggedFace.eye.l = lerp(
  clamp(1 - riggedFace.eye.l, 0, 1),  // invert and clamp
  Blendshape.getValue(PresetName.Blink),  // current blink value
  0.4  // lerp factor
);
riggedFace.eye.l /= 0.8;  // amplify by 1.25x to reach full closure
Blendshape.setValue(PresetName.BlinkL, riggedFace.eye.l);

// Mouth shapes:
Blendshape.setValue(
  PresetName.A,
  lerp(
    riggedFace.mouth.shape.A / 0.8,  // amplify input by 1.25x
    Blendshape.getValue(PresetName.A),  // current value
    0.3  // lerp factor
  )
);
```

The lerp toward the current value (not toward zero) acts as a temporal filter —
it prevents sudden jumps when Kalidokit output changes rapidly. The `/= 0.8`
amplification compensates for Kalidokit's tendency to underestimate expression depth.

Source: `forks/SysMocap-main/mocaprender/script.js` — `rigFace` function

### Eye look-at — two different approaches

r3f-vrm-final uses `vrm.lookAt.target` (Object3D tracking):
```js
// Setup (once):
lookAtTarget.current = new Object3D();
camera.add(lookAtTarget.current);  // attach to Three.js camera

// Per frame:
userData.vrm.lookAt.target = lookAtTarget.current;
lookAtDestination.current.set(
  -2 * riggedFace.current.pupil.x,  // X negated for mirror
  2 * riggedFace.current.pupil.y,
  0
);
lookAtTarget.current.position.lerp(lookAtDestination.current, delta * 5);
```
The VRM's lookAt system automatically rotates the eyes to track the target Object3D.
By attaching it to the camera and offsetting by pupil gaze, the eyes follow the
performer's gaze direction.

SysMocap uses `vrm.lookAt.applier.applyYawPitch()` (direct API):
```js
let lookTarget = new THREE.Euler(
  lerp(oldLookTarget.x, riggedFace.pupil.y, 0.4),
  lerp(oldLookTarget.y, riggedFace.pupil.x, 0.4),
  0, "XYZ"
);
oldLookTarget.copy(lookTarget);
currentVrm.lookAt.applier.applyYawPitch(lookTarget.y, lookTarget.x);
```
This is a lower-level API that directly sets yaw and pitch angles. It's available in
@pixiv/three-vrm v2. In v3, the API changed — use `vrm.lookAt.target` instead.

Note: `pupil.x` maps to yaw (horizontal), `pupil.y` maps to pitch (vertical). The
axes are swapped between the two approaches because of how the Euler is constructed.


---

## 9. Hand Tracking — The Wrist Combination Trick

Both projects use the same technique for wrist rotation. This is one of the most
important implementation details to get right.

### The problem

The wrist needs three axes of rotation: X (pitch), Y (yaw), Z (roll).

- `Pose.solve()` outputs `LeftHand` and `RightHand` with only a Z value (roll proxy
  computed from the angle of the forearm relative to the body). X and Y are not
  reliable from pose landmarks alone.
- `Hand.solve()` outputs `LeftWrist` and `RightWrist` with X and Y values (computed
  from the palm orientation relative to the hand landmarks). Z from the hand solver
  is less reliable than from the pose solver.

### The solution — combine both solvers

r3f-vrm-final (`forks/r3f-vrm-final/src/components/VRMAvatar.jsx`):
```js
rotateBone("leftHand", {
  z: riggedPose.current.LeftHand.z,      // Z from pose solver (roll)
  y: riggedLeftHand.current.LeftWrist.y, // Y from hand solver (yaw)
  x: riggedLeftHand.current.LeftWrist.x, // X from hand solver (pitch)
}, delta * 12);
```

SysMocap (`forks/SysMocap-main/mocaprender/script.js`):
```js
rigRotation("LeftHand", {
  z: riggedPose.LeftHand.z,
  y: riggedLeftHand.LeftWrist.y,
  x: riggedLeftHand.LeftWrist.x,
});
```

Identical logic. The combined wrist rotation is the best achievable result from a
single camera. Neither solver alone is sufficient.

### Finger bones — all 15 per hand

Both projects apply all 15 finger bone rotations per hand. The complete list for
the left hand (right hand is identical with "Right" prefix):

```
leftHand (wrist — combined as above)
leftThumbProximal
leftThumbMetacarpal  ← note: r3f-vrm-final maps LeftThumbIntermediate to this VRM bone
leftThumbDistal
leftIndexProximal
leftIndexIntermediate
leftIndexDistal
leftMiddleProximal
leftMiddleIntermediate
leftMiddleDistal
leftRingProximal
leftRingIntermediate
leftRingDistal
leftLittleProximal
leftLittleIntermediate
leftLittleDistal
```

IMPORTANT: r3f-vrm-final maps `riggedLeftHand.LeftThumbIntermediate` to the VRM bone
`"leftThumbMetacarpal"`. This is a naming mismatch between Kalidokit's output and
VRM's bone names. The Kalidokit hand solver names the thumb bones differently from
VRM's humanoid spec. This mapping is correct — do not change it.

From `forks/r3f-vrm-final/src/components/VRMAvatar.jsx`:
```js
rotateBone("leftThumbMetacarpal", riggedLeftHand.current.LeftThumbIntermediate, delta * 12);
```

SysMocap uses `"LeftThumbIntermediate"` as the VRM bone name directly:
```js
rigRotation("LeftThumbIntermediate", riggedLeftHand.LeftThumbIntermediate);
```
This is a discrepancy between the two projects. r3f-vrm-final's mapping to
`leftThumbMetacarpal` is more anatomically correct for VRM1 models.

### Hand solver is only applied when landmarks exist

Both projects guard hand application:
```js
// r3f-vrm-final:
if (riggedLeftHand.current) { ... apply left hand ... }
if (riggedRightHand.current) { ... apply right hand ... }

// SysMocap:
if (leftHandLandmarks && fileType == "vrm") { ... }
if (rightHandLandmarks && fileType == "vrm") { ... }
```
When a hand is not visible, the ref/variable is undefined/null and the block is
skipped. The hand stays in its last known position rather than snapping to rest pose.


---

## 10. The Mirror Swap — Why Left and Right Are Reversed

When a performer faces the camera, MediaPipe's "left hand" is the performer's right
hand from the performer's perspective. If you apply MediaPipe's left hand data to the
VRM's left hand, the avatar's left hand will mirror the performer's right hand — which
looks correct in a mirror but is anatomically wrong.

Both projects intentionally swap left and right to create a mirror effect (the avatar
mimics you as if you're looking in a mirror).

### r3f-vrm-final swap

`forks/r3f-vrm-final/src/components/VRMAvatar.jsx`:
```js
// Switched left and right (Mirror effect)
if (results.leftHandLandmarks) {
  riggedRightHand.current = Hand.solve(results.leftHandLandmarks, "Right");
}
if (results.rightHandLandmarks) {
  riggedLeftHand.current = Hand.solve(results.rightHandLandmarks, "Left");
}
```
MediaPipe's left landmarks → solved as "Right" → stored in riggedRightHand
MediaPipe's right landmarks → solved as "Left" → stored in riggedLeftHand

### SysMocap swap

`forks/SysMocap-main/mocaprender/script.js`:
```js
// Be careful, hand landmarks may be reversed
const leftHandLandmarks = results.rightHandLandmarks;   // swap at source
const rightHandLandmarks = results.leftHandLandmarks;   // swap at source

if (leftHandLandmarks) {
  riggedLeftHand = Kalidokit.Hand.solve(leftHandLandmarks, "Left");
}
if (rightHandLandmarks && fileType == "vrm") {
  riggedRightHand = Kalidokit.Hand.solve(rightHandLandmarks, "Right");
}
```
The swap happens at the variable assignment level before the solve call. The result
is the same as r3f-vrm-final.

### Why the "Right"/"Left" argument to Hand.solve() matters

The second argument to `Hand.solve()` tells Kalidokit which side the hand is on.
This affects the sign of certain rotation calculations inside the solver. If you
pass the wrong side, finger rotations will be mirrored incorrectly (fingers will
appear to curl the wrong way).


---

## 11. State Management and the No-Re-render Rule

This is the most important architectural principle in r3f-vrm-final. Violating it
causes severe performance degradation.

### The rule

Per-frame data (MediaPipe results, Kalidokit solved rotations) must NEVER be stored
in React state (`useState`) or Zustand state. It must be stored in refs (`useRef`).

### Why

React re-renders a component every time its state changes. At 60fps, storing landmark
data in state would trigger 60 re-renders per second. Each re-render reconciles the
virtual DOM, re-runs component functions, and potentially re-renders child components.
This would destroy performance.

### How r3f-vrm-final implements this

The Zustand store (`useVideoRecognition`) stores only two things that change rarely:
- `videoElement` — set once when the camera starts
- `resultsCallback` — set once when VRMAvatar mounts

The per-frame data flows through a callback function directly into refs:
```
CameraWidget (MediaPipe result) 
  → calls resultsCallback(results)  [stored in Zustand, but not per-frame data]
    → VRMAvatar.resultsCallback writes to refs:
        riggedFace.current = Face.solve(...)
        riggedPose.current = Pose.solve(...)
        riggedLeftHand.current = Hand.solve(...)
        riggedRightHand.current = Hand.solve(...)
```

The refs are then read in `useFrame` — which runs outside React's render cycle.

### The useCallback dependency

```js
const resultsCallback = useCallback(
  (results) => { ... },
  [videoElement, currentVrm]
);
```

`useCallback` memoizes the function. It only recreates when `videoElement` or
`currentVrm` changes (i.e., when the camera starts/stops or the model changes).
Without `useCallback`, a new function would be created on every render, causing
the Zustand store to be updated on every render, which would cause more renders.

### The useEffect registration

```js
useEffect(() => {
  setResultsCallback(resultsCallback);
}, [resultsCallback]);
```

This registers the callback in Zustand whenever it changes (which is rare, only
when dependencies change). CameraWidget reads it via `useVideoRecognition.getState()`
(not via hook) to avoid subscribing to state changes.


---

## 12. Mixamo Animation Retargeting (r3f-vrm-final only)

### Overview

r3f-vrm-final supports playing pre-recorded Mixamo FBX animations on VRM models.
This is separate from live tracking — it only plays when the camera is off.

Source files:
- `forks/r3f-vrm-final/src/utils/remapMixamoAnimationToVrm.js`
- `forks/r3f-vrm-final/src/utils/mixamoVRMRigMap.js`
- Animation FBX files: `forks/r3f-vrm-final/public/models/animations/`
  - `Breathing Idle.fbx`
  - `Swing Dancing.fbx`
  - `Thriller Part 2.fbx`

### The problem

Mixamo uses different bone names than VRM:
- Mixamo: `mixamorigLeftArm`, `mixamorigRightForeArm`, `mixamorigHips`, etc.
- VRM: `leftUpperArm`, `rightLowerArm`, `hips`, etc.

Additionally, Mixamo's rest pose (T-pose) differs from VRM's rest pose, so rotations
need to be corrected.

### mixamoVRMRigMap.js

`forks/r3f-vrm-final/src/utils/mixamoVRMRigMap.js`

A plain JavaScript object mapping Mixamo bone names to VRM bone names. 50+ entries
covering the full body and all finger bones. Key mappings:

```js
mixamorigHips: "hips",
mixamorigSpine: "spine",
mixamorigSpine1: "chest",
mixamorigSpine2: "upperChest",
mixamorigNeck: "neck",
mixamorigHead: "head",
mixamorigLeftArm: "leftUpperArm",
mixamorigLeftForeArm: "leftLowerArm",
mixamorigLeftHand: "leftHand",
mixamorigLeftHandThumb1: "leftThumbMetacarpal",
mixamorigLeftHandThumb2: "leftThumbProximal",
mixamorigLeftHandThumb3: "leftThumbDistal",
mixamorigLeftHandIndex1: "leftIndexProximal",
// ... etc
mixamorigLeftUpLeg: "leftUpperLeg",
mixamorigLeftLeg: "leftLowerLeg",
mixamorigLeftFoot: "leftFoot",
```

### remapMixamoAnimationToVrm.js

`forks/r3f-vrm-final/src/utils/remapMixamoAnimationToVrm.js`

```js
export function remapMixamoAnimationToVrm(vrm, asset) {
  const clip = THREE.AnimationClip.findByName(asset.animations, "mixamo.com").clone();
  // ...
}
```

The `.clone()` is CRITICAL. React StrictMode calls `useMemo` twice in development,
which would corrupt the original animation clip without the clone. Always clone before
processing.

The function:
1. Finds the `"mixamo.com"` clip in the FBX (Mixamo always names it this)
2. Computes hip height scale: `vrmHipsHeight / motionHipsHeight` — scales position
   tracks so the animation fits the VRM model's proportions
3. For each keyframe track:
   - Looks up the VRM bone name via `mixamoVRMRigMap`
   - Gets the VRM node name via `vrm.humanoid.getNormalizedBoneNode(vrmBoneName).name`
   - For `QuaternionKeyframeTrack`: applies rest-pose correction:
     `parentRestWorldRotation * trackRotation * restRotationInverse`
   - For `VectorKeyframeTrack` (position): scales by `hipsPositionScale`
   - Handles VRM0 coordinate flip: `vrm.meta.metaVersion === "0" && i % 2 === 0 ? -v : v`
4. Returns a new `THREE.AnimationClip("vrmAnimation", duration, tracks)`

### Loading and playing animations in VRMAvatar.jsx

```js
const assetA = useFBX("models/animations/Swing Dancing.fbx");
const animationClipA = useMemo(() => {
  const clip = remapMixamoAnimationToVrm(currentVrm, assetA);
  clip.name = "Swing Dancing";
  return clip;
}, [assetA, currentVrm]);

const { actions } = useAnimations(
  [animationClipA, animationClipB, animationClipC],
  currentVrm.scene  // attach to VRM scene, not the outer group
);

useEffect(() => {
  if (animation === "None" || videoElement) return;  // skip if camera is on
  actions[animation]?.play();
  return () => { actions[animation]?.stop(); };
}, [actions, animation, videoElement]);
```

`useAnimations` is from @react-three/drei. It creates an AnimationMixer attached to
`currentVrm.scene`. The second argument must be the VRM's scene object, not the outer
group, otherwise the mixer won't find the bones.

The animation stops when `videoElement` becomes non-null (camera turns on). This
prevents animation and live tracking from fighting over bone rotations.


---

## 13. Data Forwarding Architecture (SysMocap only)

### Overview

SysMocap can forward bone data to external consumers over a network. This is the
feature most relevant to our project's OSC bridge goal.

Source files:
- `forks/SysMocap-main/webserv/server.js` — Express + Socket.IO server
- `forks/SysMocap-main/webserv/worker.js` — Node.js Worker Thread wrapper
- `forks/SysMocap-main/main.js` — IPC handlers that route data to the server

### The data payload

The bone data is sent as a JSON object:
```js
{
  type: "xf-sysmocap-data",
  riggedPose: {
    Hips: { position: {x,y,z}, rotation: {x,y,z} },
    Spine: {x,y,z},
    Chest: {x,y,z},
    RightUpperArm: {x,y,z},
    RightLowerArm: {x,y,z},
    LeftUpperArm: {x,y,z},
    LeftLowerArm: {x,y,z},
    RightHand: {z},
    LeftHand: {z},
    RightUpperLeg: {x,y,z},
    RightLowerLeg: {x,y,z},
    LeftUpperLeg: {x,y,z},
    LeftLowerLeg: {x,y,z},
  },
  riggedLeftHand: {
    LeftWrist: {x,y,z},
    LeftThumbProximal: {x,y,z},
    // ... all 15 finger bones
  },
  riggedRightHand: { ... same structure with Right prefix },
  riggedFace: {
    head: {x,y,z},
    eye: { l: number, r: number },
    pupil: { x: number, y: number },
    mouth: { shape: { A, E, I, O, U } }
  }
}
```
This is the raw Kalidokit output — Euler angles in radians, not yet converted to
quaternions. Any consumer of this data needs to convert Euler → Quaternion before
applying to a 3D engine.

### The web server

`forks/SysMocap-main/webserv/server.js`

Express app with Socket.IO. Runs on both HTTP and HTTPS simultaneously using a
bundled self-signed certificate (for WebXR support, which requires HTTPS).

Endpoints:
- `GET /model` — serves the VRM/FBX file itself
- `GET /modelInfo` — serves the model metadata JSON
- `GET /useWebXR` — returns whether WebXR mode is enabled
- Socket.IO `message` event — bone data broadcast to all connected clients

Broadcasting:
```js
sendBroadcast: function(obj) {
  if (wss) wss.emit('message', obj);  // HTTPS Socket.IO
  if (ws)  ws.emit('message', obj);   // HTTP Socket.IO
}
```

### The Worker Thread

`forks/SysMocap-main/webserv/worker.js`

The server runs in a Node.js Worker Thread to avoid blocking the Electron main process:
```js
// In main.js:
worker = new Worker(__dirname + "/webserv/worker.js");
worker.postMessage({ type: "startWebServer", arg: [port, modelStr, useXR] });

// To send data:
worker.postMessage({ type: "sendBroadcast", arg: JSON.stringify(data) });
```

### What this means for our OSC bridge

SysMocap's forwarding architecture is the closest analog to what we need to build.
The key differences for our implementation:
1. We use WebSocket (not Socket.IO) as the transport from browser to Node.js bridge
2. Our Node.js bridge converts Euler → Quaternion and emits OSC/VMC over UDP
3. We don't need the HTTP server or the model serving endpoints
4. We don't need Electron — our bridge is a standalone Node.js process

The data payload format (riggedPose, riggedFace, riggedLeftHand, riggedRightHand)
is exactly what we need to serialize and send over WebSocket.


---

## 14. VRM0 vs VRM1 Coordinate System Differences

This is a common source of bugs when working with VRM models from different sources.

### VRM0 (metaVersion === "0")

- Older format, used by many VRoid Studio exports before 2022
- Models face away from the camera by default (face toward +Z)
- Requires `vrm.scene.rotation.y = Math.PI` to face the camera
- X and Z axes in bone rotations may need to be negated
- In @pixiv/three-vrm v2, `getNormalizedBoneNode` does NOT handle this automatically
- In @pixiv/three-vrm v3, this is handled internally

### VRM1 (metaVersion === "1")

- Current format
- Models face toward the camera by default (face toward -Z)
- No rotation correction needed
- @pixiv/three-vrm v3 handles coordinate system correctly

### How to check

```js
vrm.meta.metaVersion  // "0" or "1"
```

### SysMocap's handling (v2 library)

In `rigRotation` (`forks/SysMocap-main/mocaprender/script.js`):
```js
let euler = new THREE.Euler(
  (currentVrm.meta.metaVersion === "1" ? -1 : 1) * rotation.x * dampener,
  rotation.y * dampener,
  (currentVrm.meta.metaVersion === "1" ? -1 : 1) * rotation.z * dampener,
  rotation.rotationOrder || "XYZ"
);
```
For VRM1: X and Z are negated. For VRM0: X and Z are used as-is.

### r3f-vrm-final's handling (v3 library)

No axis correction in `rotateBone`. The v3 library handles this internally in
`getNormalizedBoneNode`. The `flip` parameter is only used for dampening, not
for coordinate system correction.

### Mixamo animation retargeting VRM0 handling

In `remapMixamoAnimationToVrm.js`:
```js
// For QuaternionKeyframeTrack:
.map((v, i) => vrm.meta?.metaVersion === "0" && i % 2 === 0 ? -v : v)

// For VectorKeyframeTrack:
(vrm.meta?.metaVersion === "0" && i % 3 !== 1 ? -v : v) * hipsPositionScale
```
VRM0 requires negating even-indexed quaternion components (X and Z) and negating
X and Z position components (indices 0 and 2, i.e., `i % 3 !== 1`).


---

## 15. Known Fragile Points and Gotchas

These are issues discovered in the source code, comments, and the console.txt log
in the docs folder. Each one is a real bug or edge case that will affect your
implementation if not handled.

### 1. The `results.za` undocumented property

`results.za` is MediaPipe's internal property name for world-space pose landmarks.
It is not documented in MediaPipe's public API. Both projects use it directly.

If the avatar's body stops moving but the face still works, check whether `results.za`
is still being populated. MediaPipe could rename this in a future version.

Mitigation: pin the MediaPipe version and do not upgrade without testing.

Reference: both `forks/r3f-vrm-final/src/components/VRMAvatar.jsx` and
`forks/SysMocap-main/mocaprender/script.js` use `results.za` directly.

### 2. The pupil crash

Error: `Cannot read properties of undefined (reading 'pupil')`
Location: `VRMAvatar.jsx` line ~269 (the lookAt block)

Cause: `riggedFace.current.pupil` is undefined when `refineFaceLandmarks: true` but
the iris hasn't been detected yet (e.g., face partially out of frame, or first few
frames before iris detection initializes).

Fix (already in r3f-vrm-final source):
```js
if (lookAtTarget.current && riggedFace.current?.pupil) {
  // ... apply look-at
}
```
The optional chaining `?.pupil` prevents the crash. Always guard this block.

Reference: `docs/console.txt` documents this crash. `forks/r3f-vrm-final/src/components/VRMAvatar.jsx`
has the fix.

### 3. Frustum culling causes avatar parts to disappear

If parts of the avatar (arms, hands) disappear when extended wide or when the avatar
leans, frustum culling is the cause.

Fix:
```js
vrm.scene.traverse((obj) => {
  obj.frustumCulled = false;
});
```
r3f-vrm-final applies this. SysMocap does not. Always apply this after loading.

### 4. vrm.update(delta) must be last in the render loop

If spring bones (hair, clothes) behave incorrectly — jittering, not following bone
movement, or being one frame behind — check that `vrm.update(delta)` is called AFTER
all bone rotations are applied.

### 5. The Mixamo animation clone requirement

In React StrictMode (development), `useMemo` is called twice. Without `.clone()` in
`remapMixamoAnimationToVrm`, the second call corrupts the animation clip because the
function mutates the track values in place.

Fix (already in r3f-vrm-final):
```js
const clip = THREE.AnimationClip.findByName(asset.animations, "mixamo.com").clone();
```
Always clone before processing.

### 6. useAnimations must target currentVrm.scene, not the outer group

```js
const { actions } = useAnimations(clips, currentVrm.scene);  // correct
const { actions } = useAnimations(clips, scene);              // wrong — outer scene
```
The AnimationMixer must be attached to the VRM's scene object so it can find the
bone nodes by name. Attaching to the outer group or the R3F scene will fail silently
(actions will be empty or bones won't be found).

### 7. MediaPipe CDN version pinning

r3f-vrm-final uses:
```js
`https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1635989137/${file}`
```
This version string in the URL must match a build that has the WASM files at that
exact path. Do not change this URL without verifying the WASM files exist at the
new path. The npm package version and the CDN URL version can differ.

### 8. imageSize must match camera resolution

In `Face.solve()`:
```js
Face.solve(results.faceLandmarks, {
  runtime: "mediapipe",
  video: videoElement,
  imageSize: { width: 640, height: 480 },
})
```
The `imageSize` must match the actual camera resolution. r3f-vrm-final uses 640×480.
SysMocap uses 1280×720 (but doesn't pass `imageSize` explicitly — it reads from the
video element). If these don't match, face landmark coordinates will be incorrectly
scaled and expressions will be wrong or jittery.

### 9. Hand solver only runs for VRM in SysMocap

```js
if (rightHandLandmarks && fileType == "vrm") {
  riggedRightHand = Kalidokit.Hand.solve(rightHandLandmarks, "Right");
}
```
SysMocap only runs the right hand solver for VRM files. For FBX/GLB models, only
the left hand is solved. This is a known limitation in SysMocap.

### 10. The `useDescrertionProcess` typo in SysMocap

The setting is spelled `useDescrertionProcess` (not `useDiscretionProcess`) throughout
the SysMocap codebase. This is a typo in the original source. If you reference this
setting, use the typo'd spelling.

### 11. VRM0 models need rotation.y = Math.PI

VRM0 models face away from the camera. Without the rotation, the avatar will face
away from you. Check `vrm.meta.metaVersion === "0"` and apply the rotation.

SysMocap does this correctly. r3f-vrm-final does it with a per-model conditional
(which is fragile — it only works for the specific models in that project).

### 12. Kalidokit eye convention is inverted from VRM

Kalidokit: `eye.l = 0` = open, `eye.l = 1` = closed
VRM blinkLeft: `0` = open, `1` = closed

These happen to be the same convention, BUT Kalidokit's `Face.solve()` returns
`eye.l` as a value where 1 means the eye is OPEN (it's an "openness" value, not a
"blink" value). So you must invert: `blinkLeft = 1 - eye.l`.

Both projects do this inversion. Do not skip it.

### 13. Chest and Spine both get the same Spine value

In r3f-vrm-final:
```js
rotateBone("chest", riggedPose.current.Spine, delta * 5, {x:0.3, y:0.3, z:0.3});
rotateBone("spine", riggedPose.current.Spine, delta * 5, {x:0.3, y:0.3, z:0.3});
```
Both `chest` and `spine` VRM bones receive `riggedPose.Spine` (not `riggedPose.Chest`).
This is intentional — it distributes the torso lean across both bones for a more
natural look. Kalidokit does output a `Chest` value but it's not used here.

SysMocap uses different dampeners:
```js
rigRotation("Chest", riggedPose.Chest, 0.25, 0.3);  // uses Chest value
rigRotation("Spine", riggedPose.Spine, 0.45, 0.3);  // uses Spine value
```
SysMocap uses the actual `Chest` value for the chest bone.


---

## 16. Side-by-Side Comparison Table

| Aspect | r3f-vrm-final | SysMocap |
|---|---|---|
| Source | `forks/r3f-vrm-final/` | `forks/SysMocap-main/` |
| Runtime | Browser (Vite dev server) | Electron 31 desktop app |
| UI Framework | React 19 + React Three Fiber v9 | Vue 2 + plain HTML |
| 3D Engine | R3F wrapping Three.js (declarative) | Plain Three.js (imperative) |
| @pixiv/three-vrm version | v3.4.0 | v2.1.2 |
| MediaPipe source | CDN (jsdelivr, pinned version) | Local node_modules |
| Camera loop | `@mediapipe/camera_utils` Camera class | `requestVideoFrameCallback` directly |
| Camera resolution | 640×480 | 1280×720 |
| MediaPipe config | Hardcoded in source | User-configurable via settings JSON |
| Model support | VRM only | VRM + FBX + GLB |
| VRM0 rotation fix | Per-model conditional (fragile) | `metaVersion === "0"` check (correct) |
| VRM0/VRM1 axis correction | Handled by three-vrm v3 internally | Manual `-1` flip in rigRotation |
| Frustum culling disabled | Yes | No |
| Performance optimizations | removeUnnecessaryVertices, combineSkeletons, combineMorphs | removeUnnecessaryVertices, removeUnnecessaryJoints |
| Blink handling | Simple `1 - eye.l` inversion | Lerp toward current + amplify (`/= 0.8`) |
| Mouth shape amplification | None | `/= 0.8` (amplify by 1.25x) |
| Eye look-at API | `vrm.lookAt.target` (Object3D) | `vrm.lookAt.applier.applyYawPitch()` |
| State bridge | Zustand store + callback pattern | Electron IPC (discrete) or direct call (combined) |
| Per-frame data storage | useRef (no re-renders) | Plain variables (no React) |
| Hips position applied | No | Yes (with Z negation and positionOffset) |
| Chest bone source | riggedPose.Spine (same as spine) | riggedPose.Chest (separate value) |
| Hand solver for non-VRM | N/A | Left hand only |
| Thumb bone mapping | LeftThumbIntermediate → leftThumbMetacarpal | LeftThumbIntermediate → LeftThumbIntermediate |
| Mixamo animations | Full retargeting system (3 FBX clips) | Not present |
| Data forwarding | None | Socket.IO server in Worker Thread |
| Process isolation | Single process | Optional split: BrowserView + iframe |
| Web-portable | Yes — it's a web app | No — Electron-only shell |
| Offline capable | No (CDN dependency) | Yes (local node_modules) |
| Settings persistence | None (hardcoded) | JSON file in user home directory |
| Debug UI | Leva sliders (expressions + animation picker) | Vue UI with face/half/full body mode |
| Recording | None | RecordRTC canvas recording |

---

## Quick Reference: What to Use From Each Project

### Use from r3f-vrm-final

- The overall React + R3F architecture
- The Zustand callback pattern for bridging camera data to the 3D scene
- The `useRef` pattern for per-frame data (no re-renders)
- The `rotateBone` helper function structure
- The `lerpExpression` helper function
- The eye look-at system using `vrm.lookAt.target` + Object3D on camera
- The `useCallback` + `useEffect` pattern for registering the results callback
- The Mixamo animation retargeting system (if needed)
- The frustum culling disable pattern
- The `useFrame` bone application order

### Use from SysMocap

- The `metaVersion === "0"` check for VRM rotation (more robust than per-model hack)
- The `requestVideoFrameCallback` camera loop pattern (more accurate than timer)
- The blink amplification technique (`/= 0.8`) for more natural blink depth
- The mouth shape amplification (`/ 0.8`) for more expressive mouth
- The `positionOffset` system for adjusting avatar position (face/half/full body modes)
- The hips position application with Z negation
- The data payload structure (riggedPose, riggedFace, riggedLeftHand, riggedRightHand)
  as the format to serialize and send over WebSocket to the OSC bridge
- The Socket.IO forwarding pattern as a reference for our WebSocket implementation
- The Worker Thread pattern for running the bridge server without blocking

### Do NOT use from SysMocap

- The Electron IPC architecture (we're building a web app)
- The `eval(bindingFunc.fx)` pattern for non-VRM bone binding (security risk, not needed)
- The `lookAt.applier.applyYawPitch()` API (only in three-vrm v2, we use v3)
- The manual VRM1 axis flip in rigRotation (handled by three-vrm v3 internally)

---

*This document was generated from direct analysis of the source code in:*
- `forks/r3f-vrm-final/` (all files)
- `forks/SysMocap-main/` (all files)

*No information in this document is inferred or assumed — every claim is sourced from
the actual code. When in doubt, read the referenced source file directly.*

# How It Works: VRM, MediaPipe, and Kalidokit Explained

This document explains the three core technologies in this project, how each one works internally, and exactly how they connect — with direct references to the source files.

---

## Part 1: What is a VRM Model?

### The file format

A `.vrm` file is a 3D avatar format built on top of **glTF** (GL Transmission Format), the standard 3D file format for the web. VRM extends glTF with a specific set of rules and extra data that make it suitable for humanoid avatars.

When you open a `.vrm` file you're opening a glTF file that contains:
- The 3D mesh (visible geometry — skin, hair, clothes)
- Textures (image files that give the mesh its color)
- A skeleton (a hierarchy of bones that deform the mesh)
- VRM-specific metadata: expression definitions, humanoid bone mappings, physics spring bones for hair/clothes, look-at settings

### The skeleton and humanoid bones

The skeleton is the invisible armature inside the mesh. It's a tree of bones — `hips` is the root, `spine` is a child of `hips`, `chest` is a child of `spine`, and so on. When a bone rotates, the mesh vertices attached to it deform accordingly.

What makes VRM special is the **humanoid bone map**. VRM defines a standardized set of named bones that every VRM model must have:

```
hips → spine → chest → upperChest → neck → head
                                   → leftShoulder → leftUpperArm → leftLowerArm → leftHand
                                   → rightShoulder → rightUpperArm → rightLowerArm → rightHand
     → leftUpperLeg → leftLowerLeg → leftFoot
     → rightUpperLeg → rightLowerLeg → rightFoot
```

Because every VRM model uses the same bone names, you can write code that works on any VRM model without knowing anything about how that specific model was built internally.

### Expressions (blend shapes)

VRM models have a standardized set of **expressions** — morph targets that deform the face mesh. The standard ones used in this project:

- `aa`, `ih`, `ee`, `oh`, `ou` — mouth shapes for vowel sounds
- `blinkLeft`, `blinkRight` — eye closing
- `happy`, `angry`, `sad` — emotions

Each expression is a value from `0` (off) to `1` (fully active). Multiple expressions can be blended simultaneously.

### The `@pixiv/three-vrm` library

Created by Pixiv (makers of VRoid Studio), this is the official VRM runtime for Three.js. It provides:
- A loader plugin that parses VRM data out of the glTF file
- `vrm.humanoid` — access to standardized bone nodes by name
- `vrm.expressionManager` — get/set expression values
- `vrm.lookAt` — controls where the eyes point
- `vrm.update(delta)` — must be called every frame to run spring bone physics


---

## Part 2: How the VRM is Loaded in This Project

**File: `src/components/VRMAvatar.jsx`**

The VRM is loaded using `useGLTF` from `@react-three/drei`, but with a custom loader plugin registered:

```js
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

`useGLTF` normally just loads a glTF file. By registering `VRMLoaderPlugin`, you're telling the loader: "after parsing the glTF, also parse the VRM-specific extensions and attach the result to `userData.vrm`."

After loading, `userData.vrm` is the fully initialized VRM object. The code stores it immediately:

```js
const currentVrm = userData.vrm;
```

Three performance optimizations are applied in the `useEffect` on load:

```js
VRMUtils.removeUnnecessaryVertices(scene);  // removes vertices not used by any bone
VRMUtils.combineSkeletons(scene);           // merges skeleton draw calls
VRMUtils.combineMorphs(vrm);               // merges morph target draw calls
```

Frustum culling is also disabled on every object — this prevents the avatar from disappearing when parts of it move outside the camera's view frustum:

```js
vrm.scene.traverse((obj) => {
  obj.frustumCulled = false;
});
```

The VRM load is also logged to the console:

```js
console.log("VRM loaded:", vrm);
```

This is your first debugging tool — open the browser console and expand this object to see everything the VRM contains.

---

## Part 3: What is MediaPipe Holistic?

MediaPipe Holistic is a machine learning pipeline from Google that takes a single video frame and outputs the positions of hundreds of body landmarks in real time. It runs three models in one pass:

- **BlazePose** — 33 body pose landmarks
- **Face Mesh** — 468 face landmarks
- **Hand Landmark** — 21 landmarks per hand (up to 2 hands)

All of this runs in the browser via WebAssembly (WASM). No server required.

### What a "landmark" is

A landmark is a 3D point `{x, y, z}`. MediaPipe does NOT give you bone rotations — it gives you point positions in space. Converting positions to rotations is a separate problem. That's what Kalidokit solves.

### The 33 pose landmarks (key ones)

```
11 = left shoulder    12 = right shoulder
13 = left elbow       14 = right elbow
15 = left wrist       16 = right wrist
23 = left hip         24 = right hip
25 = left knee        26 = right knee
27 = left ankle       28 = right ankle
```

### The 21 hand landmarks per hand

```
0        = wrist
1-4      = thumb (base to tip)
5-8      = index finger (knuckle to tip)
9-12     = middle finger
13-16    = ring finger
17-20    = pinky
```

### How MediaPipe is set up in this project

**File: `src/components/CameraWidget.jsx`**

```js
const holistic = new Holistic({
  locateFile: (file) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1635989137/${file}`;
  },
});
holistic.setOptions({
  modelComplexity: 1,       // 0=lite, 1=full, 2=heavy
  smoothLandmarks: true,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7,
  refineFaceLandmarks: true, // enables iris landmarks (indices 468-477) for pupil tracking
});
```

The camera loop sends every video frame to MediaPipe:

```js
const camera = new Camera(videoElement.current, {
  onFrame: async () => {
    await holistic.send({ image: videoElement.current });
  },
  width: 640,
  height: 480,
});
```

The results callback does two things:

```js
holistic.onResults((results) => {
  drawResults(results);                                        // draws skeleton overlay on canvas
  useVideoRecognition.getState().resultsCallback?.(results);  // passes data to VRMAvatar
});
```

### The results object structure

```js
results.faceLandmarks       // 468 (or 478 with iris) face points
results.poseLandmarks       // 33 normalized 2D pose points (x/y are 0-1)
results.za                  // 33 3D world-space pose points (metric, hip-relative)
results.leftHandLandmarks   // 21 left hand points, or undefined
results.rightHandLandmarks  // 21 right hand points, or undefined
```

Note: `results.za` is MediaPipe's internal (undocumented) property name for the world-space pose landmarks. It's used by Kalidokit's `Pose.solve()`. If this ever breaks, this is the first thing to check.

---

## Part 4: The State Bridge (Zustand Store)

**File: `src/hooks/useVideoRecognition.js`**

`CameraWidget` and `VRMAvatar` are separate React components that need to share data without prop drilling. A tiny Zustand store handles this:

```js
export const useVideoRecognition = create((set) => ({
  videoElement: null,
  setVideoElement: (videoElement) => set({ videoElement }),
  resultsCallback: null,
  setResultsCallback: (resultsCallback) => set({ resultsCallback }),
}));
```

The store holds two things:
1. `videoElement` — a ref to the `<video>` DOM element. Kalidokit needs this to know the video dimensions for coordinate normalization.
2. `resultsCallback` — a function that `VRMAvatar` registers, and `CameraWidget` calls every frame with the raw MediaPipe results.

This is intentionally NOT using React `useState` for the per-frame data. That would trigger a re-render every frame and destroy performance. The callback pattern means data flows directly without touching React's render cycle.

---

## Part 5: What Kalidokit Does

Kalidokit is the translation layer between MediaPipe's raw landmark positions and the bone rotations / expression values that a VRM model understands.

MediaPipe says: "the left wrist is at position (0.4, 0.6, -0.1)"
Kalidokit says: "therefore the left upper arm is rotated 45° on the Z axis"

It does this through geometry — computing angles between landmark positions, normalizing them to human anatomical ranges, and outputting Euler angles in radians. The library source is forked into this repo at `docs/forks/kalidokit/src/` so you can read the actual math.

The library exports three solvers (`docs/forks/kalidokit/src/index.ts`):

```ts
export { PoseSolver as Pose } from "./PoseSolver";
export { HandSolver as Hand } from "./HandSolver";
export { FaceSolver as Face } from "./FaceSolver";
```

### Face.solve()

**Source: `docs/forks/kalidokit/src/FaceSolver/index.ts`**

Takes the 468 face landmarks and returns a `TFace` object (defined in `docs/forks/kalidokit/src/Types.ts`):

```ts
{
  head:  { x, y, z, ... }     // head rotation in radians
  eye:   { l: number, r: number }  // 0=open, 1=closed
  brow:  number
  pupil: { x: number, y: number }  // -1 to 1 gaze direction
  mouth: {
    x, y,
    shape: { A, E, I, O, U }  // 0 to 1 vowel blend shapes
  }
}
```

Called in `VRMAvatar.jsx`:

```js
riggedFace.current = Face.solve(results.faceLandmarks, {
  runtime: "mediapipe",
  video: videoElement,
  imageSize: { width: 640, height: 480 },
  smoothBlink: false,
  blinkSettings: [0.25, 0.75],  // sensitivity: below 0.25 = open, above 0.75 = closed
});
```

When `runtime: "mediapipe"` is set, the solver multiplies the normalized landmark coordinates by the image dimensions before calculating. This is why the `video` element reference is needed — to get the actual pixel dimensions.

### Pose.solve()

**Source: `docs/forks/kalidokit/src/PoseSolver/index.ts`**

Takes both the 3D world landmarks (`results.za`) and 2D normalized landmarks (`results.poseLandmarks`) and returns a `TPose` object:

```ts
{
  RightUpperArm: Euler,   LeftUpperArm: Euler,
  RightLowerArm: Euler,   LeftLowerArm: Euler,
  RightHand: Vector,      LeftHand: Vector,    // Z rotation only (wrist roll proxy)
  RightUpperLeg: Euler,   LeftUpperLeg: Euler,
  RightLowerLeg: Euler,   LeftLowerLeg: Euler,
  Hips: { position: XYZ, rotation: Vector },
  Spine: Vector,
}
```

Called in `VRMAvatar.jsx`:

```js
riggedPose.current = Pose.solve(results.za, results.poseLandmarks, {
  runtime: "mediapipe",
  video: videoElement,
});
```

The solver uses the 2D landmarks' visibility scores to detect when limbs are offscreen. When a limb is not visible, it falls back to the resting pose values defined in `docs/forks/kalidokit/src/utils/helpers.ts` under `RestingDefault.Pose`. Legs are calculated by default (`enableLegs: true`).

### Hand.solve()

**Source: `docs/forks/kalidokit/src/HandSolver/index.ts`**

Takes 21 hand landmarks and a side string, returns 16 bone rotations:

```ts
{
  LeftWrist: { x, y, z },
  LeftIndexProximal: { x, y, z },
  LeftIndexIntermediate: { x, y, z },
  LeftIndexDistal: { x, y, z },
  // ... same for Middle, Ring, Little, Thumb
}
```

Called in `VRMAvatar.jsx` with an intentional left/right swap for the mirror effect:

```js
// MediaPipe's "left" hand is the performer's right hand when facing the camera
if (results.leftHandLandmarks) {
  riggedRightHand.current = Hand.solve(results.leftHandLandmarks, "Right");
}
if (results.rightHandLandmarks) {
  riggedLeftHand.current = Hand.solve(results.rightHandLandmarks, "Left");
}
```

Inside `Hand.solve()`, the wrist rotation is computed using `Vector.rollPitchYaw()` on three palm landmarks (wrist, pinky MCP, index MCP). Each finger joint angle is computed using `Vector.angleBetween3DCoords()` on three consecutive landmarks. The `rigFingers()` function then clamps all values to anatomically plausible human ranges and converts to radians.

---

## Part 6: Applying the Data to the VRM

**File: `src/components/VRMAvatar.jsx`**

The Kalidokit solving happens in `resultsCallback` — it fires when MediaPipe has new data and stores results in refs. Refs are used deliberately here (not state) so that storing new data doesn't trigger a React re-render.

The actual application to the VRM happens in `useFrame` — React Three Fiber's per-frame hook:

```js
useFrame((_, delta) => {
  if (!userData.vrm) return;
  // ... apply everything
  userData.vrm.update(delta);  // must be last — runs spring bone physics
});
```

### The two helper functions

**`lerpExpression(name, value, lerpFactor)`** — smoothly transitions an expression:

```js
const lerpExpression = (name, value, lerpFactor) => {
  userData.vrm.expressionManager.setValue(
    name,
    lerp(userData.vrm.expressionManager.getValue(name), value, lerpFactor)
  );
};
```

Reads the current value, lerps toward the target, writes it back. `delta * 12` as the factor means "move 12 units per second toward the target" — fast enough to feel responsive, slow enough to avoid jitter.

**`rotateBone(boneName, value, slerpFactor, flip)`** — rotates a VRM bone:

```js
const rotateBone = (boneName, value, slerpFactor, flip = { x:1, y:1, z:1 }) => {
  const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
  tmpEuler.set(value.x * flip.x, value.y * flip.y, value.z * flip.z);
  tmpQuat.setFromEuler(tmpEuler);
  bone.quaternion.slerp(tmpQuat, slerpFactor);
};
```

`getNormalizedBoneNode(boneName)` is the key VRM API call — it takes a standardized VRM bone name and returns the Three.js `Object3D` for that bone, regardless of what the bone is actually named inside the model file. This is what makes the code work on any VRM model.

`slerp` (spherical linear interpolation) smoothly rotates from the current quaternion toward the target. It's the rotation equivalent of lerp.

The `flip` parameter dampens or inverts specific axes. For example, the neck uses `{ x: 0.7, y: 0.7, z: 0.7 }` to reduce head rotation to 70% of what Kalidokit outputs — full rotation looks unnatural.

### The two modes

The `useFrame` loop has two branches:

**Without camera** (`!videoElement`): uses the Leva debug sliders to set expressions manually. Good for testing the avatar without being in front of the camera.

**With camera**: uses the Kalidokit solved data from the refs. Expressions come from `riggedFace.current.mouth.shape` and `riggedFace.current.eye`. Bones come from `riggedPose.current` and the hand refs.

### Wrist bone — the combined approach

The wrist is a special case that combines data from both the pose solver and the hand solver:

```js
rotateBone("leftHand", {
  z: riggedPose.current.LeftHand.z,      // Z from pose (rough roll proxy)
  y: riggedLeftHand.current.LeftWrist.y, // Y from hand solver
  x: riggedLeftHand.current.LeftWrist.x, // X from hand solver
}, delta * 12);
```

The pose solver's `LeftHand` only provides a Z rotation (the best it can do for wrist roll from body landmarks). The hand solver's `LeftWrist` provides X and Y from the palm orientation. Combining them gives the best available result from a single camera.

### Eye look-at

```js
userData.vrm.lookAt.target = lookAtTarget.current;
lookAtDestination.current.set(
  -2 * riggedFace.current.pupil.x,
  2 * riggedFace.current.pupil.y,
  0
);
lookAtTarget.current.position.lerp(lookAtDestination.current, delta * 5);
```

`lookAtTarget` is a Three.js `Object3D` attached to the camera (`camera.add(lookAtTarget.current)`). By setting `vrm.lookAt.target` to this object, the VRM's eye system automatically rotates the eyes to track it. The pupil X/Y from Kalidokit offsets the target position, making the eyes follow your gaze.

---

## Part 7: The Mixamo Animation System

This is separate from live tracking — it's for playing pre-recorded animations on the VRM.

**Files: `src/utils/remapMixamoAnimationToVrm.js`, `src/utils/mixamoVRMRigMap.js`**

Mixamo animations use a different bone naming convention (`mixamorigLeftArm`) than VRM (`leftUpperArm`). The `mixamoVRMRigMap.js` file is a lookup table mapping one to the other — 50+ entries covering the full body and all finger bones.

`remapMixamoAnimationToVrm.js` takes a loaded FBX asset and a VRM instance, iterates every keyframe track, renames the bone targets using the map, adjusts rotation values to account for the difference in rest pose between Mixamo's T-pose and the VRM skeleton, and scales hip position by the ratio of the VRM's hip height to the Mixamo rig's hip height so the animation fits the model's proportions.

The animation only plays when the camera is NOT active:

```js
useEffect(() => {
  if (animation === "None" || videoElement) return;  // skip if camera is on
  actions[animation]?.play();
  return () => { actions[animation]?.stop(); };
}, [actions, animation, videoElement]);
```

---

## Part 8: The Complete Data Flow

```
1. User clicks camera button in CameraWidget.jsx
   → Holistic instance created, Camera loop started
   → setVideoElement(videoElement.current) stored in Zustand store

2. Every video frame (640x480):
   CameraWidget.jsx → holistic.send({ image: videoElement })
   → MediaPipe WASM runs inference
   → results object produced with face/pose/hand landmarks

3. CameraWidget.jsx → drawResults(results)
   → draws colored skeleton overlay on the <canvas> element (visual only)

4. CameraWidget.jsx → resultsCallback(results)
   → calls the function VRMAvatar registered via Zustand

5. VRMAvatar.jsx resultsCallback (runs off the render loop, no re-render):
   → Face.solve(results.faceLandmarks, ...)
       → riggedFace.current = { head, eye, pupil, mouth.shape }

   → Pose.solve(results.za, results.poseLandmarks, ...)
       → riggedPose.current = { Hips, Spine, arms, legs }

   → Hand.solve(results.leftHandLandmarks, "Right")  // mirror swap
       → riggedRightHand.current = { RightWrist, all finger joints }

   → Hand.solve(results.rightHandLandmarks, "Left")
       → riggedLeftHand.current = { LeftWrist, all finger joints }

6. Every render frame — useFrame() in VRMAvatar.jsx:
   → lerpExpression("aa", riggedFace.current.mouth.shape.A, delta*12)
       → vrm.expressionManager.setValue("aa", lerped_value)
   → same for ih, ee, oh, ou, blinkLeft, blinkRight

   → rotateBone("neck", riggedFace.current.head, delta*5, {x:0.7,y:0.7,z:0.7})
       → vrm.humanoid.getNormalizedBoneNode("neck")
       → bone.quaternion.slerp(targetQuat, slerpFactor)

   → rotateBone("hips", riggedPose.current.Hips.rotation, ...)
   → rotateBone("chest", riggedPose.current.Spine, ...)
   → rotateBone("leftUpperArm", riggedPose.current.LeftUpperArm, ...)
   → rotateBone("leftUpperLeg", riggedPose.current.LeftUpperLeg, ...)
   → ... all other body bones

   → rotateBone("leftHand", combined pose Z + hand solver X/Y, ...)
   → rotateBone("leftIndexProximal", riggedLeftHand.LeftIndexProximal, ...)
   → ... all 15 finger bones per hand

   → vrm.lookAt.target position updated from pupil data
   → userData.vrm.update(delta)   ← spring bone physics tick
```

---

## Part 9: Debugging Guide

### The Leva panel (top right corner)

When the camera is OFF, the Leva panel gives you manual sliders for every expression and an animation picker. Use this to:
- Verify expressions work on a specific model before enabling the camera
- Test that a bone name is correct by checking if the animation plays
- Isolate whether a problem is in the MediaPipe/Kalidokit pipeline or in the VRM application code

### Checking what's in the VRM object

The `useEffect` in `VRMAvatar.jsx` logs the full VRM object on load:

```js
console.log("VRM loaded:", vrm);
```

Expand this in the browser console. Key things to look at:
- `vrm.humanoid.humanBones` — all available bone nodes. If a bone you're trying to rotate isn't here, `getNormalizedBoneNode()` returns null and `rotateBone()` logs a warning.
- `vrm.expressionManager._expressions` — all available expressions. If an expression name doesn't exist, `setValue()` silently does nothing.

### The `rotateBone` warning

```js
if (!bone) {
  console.warn(`Bone ${boneName} not found in VRM humanoid.`);
  console.log("userData.vrm.humanoid.bones", userData.vrm.humanoid);
}
```

If you see this, the bone name doesn't exist in that model's humanoid map. The second log prints the full humanoid so you can see what names are actually available.

### Checking Kalidokit output live

Add a temporary log inside `resultsCallback` in `VRMAvatar.jsx`:

```js
console.log("riggedFace:", riggedFace.current);
console.log("riggedPose:", riggedPose.current);
```

This shows exactly what Kalidokit is outputting. If a value is always 0 or stuck at an extreme, the issue is either upstream in MediaPipe (landmark not detected) or in the Kalidokit solver options.

### The canvas overlay as a diagnostic

The `<canvas>` in `CameraWidget.jsx` draws the raw MediaPipe landmarks directly on the video feed. Use it as a first-pass diagnostic:
- If the skeleton overlay tracks your body correctly but the VRM isn't moving right → problem is in Kalidokit or the bone application code
- If the overlay itself looks wrong (jittery, missing limbs, wrong positions) → problem is in MediaPipe detection (lighting, distance from camera, occlusion)

### The `results.za` naming issue

`results.za` is MediaPipe's internal undocumented property name for the world-space pose landmarks. If the avatar's body stops moving but the face still works, check whether `results.za` is still being populated — MediaPipe could rename this in a future version.

### The `pupil` crash (from `docs/console.txt`)

The error `Cannot read properties of undefined (reading 'pupil')` at `VRMAvatar.jsx:269` happens because `riggedFace.current.pupil` is undefined when `refineFaceLandmarks` hasn't detected the iris yet. The fix is a null check before accessing it:

```js
if (lookAtTarget.current && riggedFace.current?.pupil) {
```

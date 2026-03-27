# Browser-Based Full Body Mocap → OSC Streaming System

## What We're Building

A real-time, webcam-driven full body motion capture system that runs entirely in the browser, animates a VRM avatar as a live visual debugger, and streams the computed bone rotation data to a lightweight Node.js backend that rebroadcasts it over OSC/UDP — making it consumable by any OSC-compatible application, including Unreal Engine, Blender, TouchDesigner, and others.

The end goal is a **Mac-native, zero-install mocap pipeline** that replaces tools like XR Animator, MediaPipe4U, and VSeeFace — all of which either don't run on macOS, require Windows, or require complex workarounds to function on Apple Silicon.

---

## Why We're Building This

### The Mac Problem

The existing mocap-to-Unreal tooling ecosystem is almost entirely Windows-only:

- **MediaPipe4U** (Unreal plugin): explicitly supports Windows x64 and Android only. Mac is not supported and not planned.
- **XR Animator**: Windows desktop app. Does not run natively on macOS.
- **VSeeFace**: Windows app. Running it on Mac requires Whisky (a Wine wrapper), which is a fragile hack, not a solution.
- **Motion LIVE / Reallusion tools**: Mac excluded because the underlying mocap device SDKs (Xsens, Rokoko, etc.) don't provide Mac-compatible libraries.

The browser has none of these constraints. Chrome and Safari run identically on Apple Silicon. MediaPipe's JavaScript SDK (`@mediapipe/holistic`) works perfectly in the browser on Mac. This is the only path that is genuinely cross-platform without compromise.

### Why a Web App and Not an Electron App

The obvious alternative is Electron — it's what SysMocap uses, and it solves the UDP/OSC problem by giving you Node.js access inside a Chromium shell. However, Electron introduces significant tradeoffs:

- **Distribution complexity**: requires packaging, signing, notarization on macOS (Apple Silicon Gatekeeper), DMG builds, etc.
- **Update friction**: users need to download and install new versions.
- **Overkill for this use case**: we don't need filesystem access, native menus, or OS-level integrations. We need a camera, WebGL, and a network connection.
- **SysMocap's own source confirms the pattern**: it uses `ipcRenderer` to bridge between its renderer and a local HTTP/WebSocket server in the main process. We can replicate that bridge externally with a standalone Node.js process — which is simpler, more transparent, and easier to maintain.

The web app handles everything that needs to happen in the browser (camera access, MediaPipe inference, Kalidokit solving, Three.js rendering). The Node.js bridge is a separate, minimal process that handles the one thing browsers can't do: send UDP packets. This separation of concerns is cleaner than bundling everything into Electron.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        BROWSER                              │
│                                                             │
│  Webcam                                                     │
│    │                                                        │
│    ▼                                                        │
│  MediaPipe Holistic                                         │
│  (@mediapipe/holistic)                                      │
│  · Face landmarks (468 points)                              │
│  · Pose landmarks (33 points, full body)                    │
│  · Left hand landmarks (21 points)                          │
│  · Right hand landmarks (21 points)                         │
│    │                                                        │
│    ▼                                                        │
│  Kalidokit Solvers                                          │
│  · Face.solve()  → head rotation, eye blink, pupil,        │
│                    mouth shapes (A/I/E/O/U)                 │
│  · Pose.solve()  → hips, spine, chest, arms, legs          │
│  · Hand.solve()  → all 15 finger bone rotations per hand   │
│    │                                                        │
│    ├──────────────────────────────────────────────────┐     │
│    │                                                  │     │
│    ▼                                                  ▼     │
│  VRM Avatar (Three.js / R3F)              WebSocket Client  │
│  · Live bone rotation applied             · Sends JSON      │
│  · Expression blendshapes                  bone data to    │
│  · Eye look-at target                      Node bridge     │
│  · Acts as visual debugger                               │  │
│    (if it looks right here,               every frame      │
│     the data is correct)                                    │
└─────────────────────────────────────────────────────────────┘
                                │
                                │ WebSocket (JSON)
                                │ ws://localhost:8080
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                    NODE.JS BRIDGE                           │
│                                                             │
│  WebSocket Server                                           │
│    · Receives bone JSON from browser                        │
│    · Parses riggedPose, riggedFace,                         │
│      riggedLeftHand, riggedRightHand                        │
│    │                                                        │
│    ▼                                                        │
│  Euler → Quaternion conversion                              │
│  (Three.js / gl-matrix)                                     │
│    │                                                        │
│    ▼                                                        │
│  OSC/VMC Packet Builder (osc.js)                            │
│    · /VMC/Ext/Bone/Pos per bone                             │
│    · /VMC/Ext/Blend/Val per blendshape                      │
│    · /VMC/Ext/Root/Pos for hips position                    │
│    │                                                        │
│    ▼                                                        │
│  UDP Socket → port 39539 (VMC default)                      │
└─────────────────────────────────────────────────────────────┘
                                │
                                │ OSC over UDP
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
         Unreal Engine     Blender          TouchDesigner
         (VRM4U +          (VMC4B           (OSC In CHOP)
          Epic OSC          addon)
          plugin)
```

---

## Data Pipeline Detail

### Stage 1 — Landmark Detection (MediaPipe Holistic)

MediaPipe Holistic runs inference on each video frame and outputs raw landmark arrays:

- `faceLandmarks` — 468 2D normalized points describing the face mesh
- `za` (world pose) — 33 3D landmarks in metric space (hip-relative, in meters)
- `poseLandmarks` — 33 2D normalized landmarks for visibility/offscreen detection
- `leftHandLandmarks` / `rightHandLandmarks` — 21 3D points per hand

This all runs in the browser via WASM. No server round-trip. Latency is purely local inference time.

### Stage 2 — Bone Rotation Solving (Kalidokit)

Kalidokit converts the raw landmark arrays into human-readable bone rotations (Euler angles) and blendshape values:

| Solver | Input | Output |
|---|---|---|
| `Face.solve()` | faceLandmarks + video element | head XYZ, eye L/R, pupil XY, mouth A/I/E/O/U |
| `Pose.solve()` | za + poseLandmarks | hips pos+rot, spine, chest, arms, legs (enableLegs: true) |
| `Hand.solve()` | handLandmarks + side | all 15 finger joints per hand (proximal/intermediate/distal) |

Kalidokit also handles offscreen detection — if a limb isn't visible, it falls back to a resting pose value rather than outputting garbage data.

### Stage 3 — VRM Animation (Browser, Visual Debugger)

The computed rotations are applied to a VRM avatar in real-time using `@pixiv/three-vrm` inside a React Three Fiber scene. This serves as the **primary debugging interface** — if the avatar moves correctly and naturally, the data pipeline is working. If something looks wrong (a bone flipping, an expression not triggering), you can diagnose it visually before it ever reaches Unreal.

This is the key advantage over a headless pipeline: you get immediate visual feedback on data quality without needing to open Unreal at all.

### Stage 4 — WebSocket Transmission

Every frame, the solved data is serialized to JSON and sent over a WebSocket connection to the Node.js bridge:

```json
{
  "riggedPose": {
    "Hips": { "position": { "x": 0.0, "y": 0.95, "z": 0.1 }, "rotation": { "x": 0.02, "y": 0.0, "z": -0.01 } },
    "Spine": { "x": 0.05, "y": 0.0, "z": 0.0 },
    "LeftUpperArm": { "x": -0.3, "y": 0.1, "z": 1.1 },
    "LeftUpperLeg": { "x": 0.1, "y": 0.0, "z": 0.05 },
    ...
  },
  "riggedFace": {
    "head": { "x": 0.1, "y": -0.05, "z": 0.02 },
    "eye": { "l": 0.9, "r": 0.88 },
    "pupil": { "x": 0.1, "y": -0.05 },
    "mouth": { "shape": { "A": 0.0, "I": 0.0, "E": 0.0, "O": 0.3, "U": 0.0 } }
  },
  "riggedLeftHand": { "LeftWrist": {...}, "LeftIndexProximal": {...}, ... },
  "riggedRightHand": { "RightWrist": {...}, "RightIndexProximal": {...}, ... }
}
```

No data is lost in this step. Euler angles are just floating point numbers. JSON serialization is lossless for the precision we need.

### Stage 5 — OSC/VMC Broadcasting (Node.js Bridge)

The bridge receives the JSON, converts Euler angles to quaternions (lossless mathematical transformation), and emits VMC-spec OSC messages over UDP:

```
/VMC/Ext/Root/Pos  "Hips"  px py pz  qx qy qz qw
/VMC/Ext/Bone/Pos  "Spine"  px py pz  qx qy qz qw
/VMC/Ext/Bone/Pos  "LeftUpperArm"  px py pz  qx qy qz qw
/VMC/Ext/Bone/Pos  "LeftUpperLeg"  px py pz  qx qy qz qw
...
/VMC/Ext/Blend/Val  "blinkLeft"  0.85
/VMC/Ext/Blend/Val  "aa"  0.3
```

VMC protocol is OSC over UDP, standardized for VRM avatar bone streaming. It is supported natively by:
- **Unreal Engine** via VRM4U plugin + Epic's built-in OSC plugin (no extra cost)
- **Blender** via VMC4B addon
- **TouchDesigner** via OSC In CHOP
- Any custom application using any OSC library

---

## Bones Tracked

### Body (via Pose.solve)
`Hips` (position + rotation), `Spine`, `Chest`, `Neck`, `LeftUpperArm`, `LeftLowerArm`, `RightUpperArm`, `RightLowerArm`, `LeftUpperLeg`, `LeftLowerLeg`, `RightUpperLeg`, `RightLowerLeg`

### Hands (via Hand.solve — 15 bones per hand)
Per hand: `Wrist`, `[Index/Middle/Ring/Little/Thumb][Proximal/Intermediate/Distal]`

### Face (via Face.solve)
`Neck` rotation (head pose), eye blink L/R, pupil gaze XY, mouth blendshapes A/I/E/O/U

---

## Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| UI Framework | React + Vite | Fast dev iteration, no build complexity |
| 3D Rendering | React Three Fiber + Three.js | Declarative Three.js, good ecosystem |
| VRM Loading | @pixiv/three-vrm | Official VRM runtime for Three.js, by VRoid Studio creators |
| Pose Detection | @mediapipe/holistic | Full body (face + pose + hands) in one pass, runs in browser WASM |
| Bone Solving | kalidokit | Converts MediaPipe landmarks to usable bone rotations, handles edge cases |
| State Management | Zustand | Minimal, no boilerplate, good for sharing webcam state across components |
| Debug UI | Leva | Quick sliders for manual expression/animation control during development |
| Animations | Mixamo FBX → VRM remapped | Idle/dance animations for testing avatar without live tracking |
| Bridge Runtime | Node.js | UDP socket access, runs alongside the browser dev server |
| OSC Library | osc.js | Handles OSC packet encoding and UDP dispatch |
| Protocol | VMC (OSC/UDP) | Standard for VRM avatar bone streaming, supported by Unreal/Blender/TD |

---

## Why VMC Over Raw OSC

VMC (Virtual Motion Capture Protocol) is a standardized schema built on top of OSC, specifically designed for VRM avatar bone data. Using raw OSC would mean defining our own message schema and writing custom receivers in every target application. VMC gives us:

- A defined address pattern (`/VMC/Ext/Bone/Pos`, `/VMC/Ext/Blend/Val`, etc.)
- Quaternion-based bone representation (standard for 3D engines)
- Existing receivers in Unreal (VRM4U), Blender (VMC4B), and others
- Interoperability with the broader VTuber tooling ecosystem (VSeeFace, TDPT, MocapForAll all speak VMC)

---

## Receiver Setup (Unreal Engine)

1. Enable the **OSC plugin** in Unreal (built-in, no cost)
2. Install **VRM4U** plugin
3. Open the VMC protocol map from VRM4U's `Latest` folder
4. Place `VRoidSimple` skeletal mesh and `BP_VMCReceiver` in the scene
5. Set the receiver port to `39539` (VMC default)
6. Assign `ABP_VroidVMC_Bone` animation blueprint to the mesh
7. Run the Node.js bridge and start the browser app

The avatar in Unreal will mirror the performer in real-time.

---

## Current Status

- [x] VRM avatar loading and rendering in browser
- [x] MediaPipe Holistic integration (face + pose + hands)
- [x] Kalidokit bone solving (face, pose, hands)
- [x] Upper body animation (arms, hands, face, expressions)
- [x] Leg animation added (LeftUpperLeg, LeftLowerLeg, RightUpperLeg, RightLowerLeg)
- [x] Mixamo animation playback with VRM remapping
- [ ] WebSocket transmission of bone data from browser
- [ ] Node.js OSC bridge (WebSocket in → VMC/OSC UDP out)
- [ ] Unreal Engine receiver setup and testing
- [ ] Latency profiling and frame-rate optimization

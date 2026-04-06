# XR Animator → Onapose: VMC/OSC Gap Analysis

**Goal:** Make onapose's OSC output a drop-in replacement for XR Animator in existing
Unreal Engine / VRM4U setups, so users need zero reconfiguration on the UE side.

**Sources examined:**
- `forks/SystemAnimatorOnline/MMD.js/MMD_SA.js` — XR Animator VMC sender (lines 9734–9920)
- `forks/SystemAnimatorOnline/js/SA_system_emulation.min.js` — VMC receiver + class definition
- `forks/SystemAnimatorOnline/images/XR Animator/animate_customized.js` — default port config
- `bridge/src/osc/vmc-builder.ts` — onapose OSC builder
- `bridge/src/osc/osc.service.ts` — onapose UDP transport
- `bridge/src/math/euler-to-quat.ts` — onapose coordinate conversion

---

## 1. OSC Address Patterns

XR Animator emits the following addresses every frame:

| Address | Purpose | OSC type string |
|---|---|---|
| `/VMC/Ext/Root/Pos` | Root character world position + rotation | `sfffffff` |
| `/VMC/Ext/Bone/Pos` | All 52 humanoid bones (sent as OSC Bundle) | `sfffffff` |
| `/VMC/Ext/Blend/Val` | Per-expression weight (sent as OSC Bundle) | `sf` |
| `/VMC/Ext/Blend/Apply` | Commit the blend batch (no args) | — |
| `/VMC/Ext/OK` | Device-available heartbeat | `i` (int, value = 1) |
| `/VMC/Ext/Cam` | Camera pose + FOV (only when enabled) | `sffffffff` |
| `/VMC/Ext/Tra/Pos` | XR prop trackers (XR Animator extension) | `sfffffff` |

Onapose currently sends only: `/VMC/Ext/Root/Pos`, `/VMC/Ext/Bone/Pos`, `/VMC/Ext/Blend/Val`.
`/VMC/Ext/Blend/Apply` and `/VMC/Ext/OK` are absent.

---

## 2. Bone / Joint Naming Convention

XR Animator iterates `VRMSchema.HumanoidBoneName` — **52 Unity HumanBodyBones in PascalCase**,
which is the VRM0 naming convention that VRM4U parses.

```
Hips · Spine · Chest · UpperChest · Neck · Head · Jaw · LeftEye · RightEye
LeftShoulder  · LeftUpperArm  · LeftLowerArm  · LeftHand
RightShoulder · RightUpperArm · RightLowerArm · RightHand
LeftUpperLeg  · LeftLowerLeg  · LeftFoot  · LeftToes
RightUpperLeg · RightLowerLeg · RightFoot · RightToes
LeftThumbProximal · LeftThumbIntermediate · LeftThumbDistal
LeftIndexProximal · LeftIndexIntermediate · LeftIndexDistal
LeftMiddleProximal · LeftMiddleIntermediate · LeftMiddleDistal
LeftRingProximal   · LeftRingIntermediate  · LeftRingDistal
LeftLittleProximal · LeftLittleIntermediate · LeftLittleDistal
(same 15 for Right hand)
```

The first OSC argument (`s`) in each `/VMC/Ext/Bone/Pos` packet is this PascalCase key.

---

## 3. Data Format — Rotations & Coordinate System

**XR Animator always sends quaternions.** It applies an explicit Three.js (right-handed, Y-up)
→ Unity (left-handed, Y-up) coordinate conversion before every send:

```js
// Per-bone (from MMD_SA.js line 9807–9811):
bone_msgs.push([
  boneName,
  b_pos.x, b_pos.y, -b_pos.z,           // negate Z position
  -b_rot.x, -b_rot.y, b_rot.z, b_rot.w  // negate qX and qY
]);

// Root (line 9754–9757):
const pos_msgs = [
  'root',
  pos.x, pos.y, -pos.z,
  -model_rot.x, -model_rot.y, model_rot.z, model_rot.w
];
```

Onapose's `vmc-builder.ts` converts Euler → quaternion correctly but does **not** apply
the handedness flip. Root position Z is negated, but the quaternion components are not.
Bone position Z and quaternion components are not converted at all.

---

## 4. Transport Layer

| Property | XR Animator | Onapose |
|---|---|---|
| Protocol | UDP (`osc-js` DatagramPlugin, Electron/Node) | UDP (`osc` npm, NestJS) ✅ |
| Default send port | **39539** (VMC standard) | **39539** ✅ |
| Default host | `localhost` | `127.0.0.1` ✅ |
| Warudo extra port | Also opens port `19190` for camera/tracker | N/A |
| Message grouping | OSC Bundle for bones + blend shapes | Individual UDP packet per message |

Individual messages vs Bundles is not a breaking difference — VRM4U handles both.
The transport itself is already correct in onapose.

---

## 5. VMC Protocol Compliance (XR Animator)

XR Animator is **strictly spec-compliant**:

- ✅ `/VMC/Ext/OK` sent every frame (device-available signal VRM4U requires)
- ✅ `/VMC/Ext/Blend/Apply` sent after all blend values (batch-commit, required by spec)
- ✅ `"root"` used as the name string in `/VMC/Ext/Root/Pos` (spec-defined)
- ✅ All 52 HumanBodyBones iterated and sent every frame
- ✅ Three.js → Unity coordinate conversion applied to every bone and to root
- ✅ Multiple app-mode targets: Warudo, VNyan, VNyan(+Z), VSeeFace, Others

---

## 6. Gap Analysis — What Breaks Drop-In Compatibility

### 🔴 Gap 1 — Wrong name in `/VMC/Ext/Root/Pos`

| | XR Animator | Onapose |
|---|---|---|
| Name argument | `"root"` | `"Hips"` ❌ |

VRM4U identifies the character root by matching this string to `"root"`. Sending `"Hips"`
causes VRM4U to ignore the root position packet; the character never moves in world space.

**Fix:** Change the root name string in `vmc-builder.ts` from `"Hips"` to `"root"`.

---

### 🔴 Gap 2 — No quaternion axis flip applied (all bones + root)

The Three.js → Unity handedness conversion requires negating `qX` and `qY` on every bone,
and negating `position.z`. XR Animator does this on every packet. Onapose does not.

Result: every rotation in UE will be reflected across two axes — visibly corrupted pose.

**Fix in `vmc-builder.ts`:**
```
// Correct per-bone args:
pos.x,  pos.y,  -pos.z,
-q.x,  -q.y,   q.z,  q.w

// Correct root args:
pos.x,  pos.y,  -pos.z,
-q.x,  -q.y,   q.z,  q.w
```

---

### 🔴 Gap 3 — Missing `/VMC/Ext/OK`

VRM4U polls for `/VMC/Ext/OK` to confirm a VMC sender is active. Without it, VRM4U
stays in "disconnected" state and silently ignores all incoming pose data.

**Fix:** Append one message per frame — address `/VMC/Ext/OK`, single int arg `1`.

---

### 🔴 Gap 4 — Missing `/VMC/Ext/Blend/Apply`

The VMC spec requires this zero-argument message after the last `/VMC/Ext/Blend/Val`
packet to commit the expression batch. Without it, blend shapes may never visually update.

**Fix:** Push one `/VMC/Ext/Blend/Apply` message (no args) at the end of the blend block.

---

### 🟠 Gap 5 — Blend shape names use VRM1 convention instead of VRM0

VRM4U with VRM0 models uses VRM0 preset names. XR Animator users have their blend shape
bindings configured for these names.

| Shape | XR Animator (VRM0) | Onapose | VRM4U expects |
|---|---|---|---|
| Mouth A | `A` | `aa` ❌ | `A` |
| Mouth I | `I` | `ih` ❌ | `I` |
| Mouth U | `U` | `ou` ❌ | `U` |
| Mouth E | `E` | `ee` ❌ | `E` |
| Mouth O | `O` | `oh` ❌ | `O` |
| Blink L | `Blink_L` | `blinkLeft` ❌ | `Blink_L` |
| Blink R | `Blink_R` | `blinkRight` ❌ | `Blink_R` |

**Fix:** Rename constants in `vmc-builder.ts` to VRM0 preset names.

---

### 🟠 Gap 6 — Wrist bone named `LeftWrist` / `RightWrist` instead of `LeftHand` / `RightHand`

Kalidokit's `Hand.solve()` returns keys named `LeftWrist` / `RightWrist`. VMC convention
(and all VRM4U bindings) uses `LeftHand` / `RightHand`. Onapose passes Kalidokit's raw
keys directly — the wrist packets land with an unrecognized name and VRM4U ignores them.

**Fix:** In the finger-bone loop, remap `LeftWrist` → `LeftHand` and `RightWrist` → `RightHand`.

---

### 🟡 Gap 7 — Missing bones (should send identity when no data available)

XR Animator sends all 52 bones every frame. When a bone has no motion, it sends the
bind-pose rotation (effectively identity quaternion). Onapose omits many bones entirely:

**Completely absent from onapose output:**

| Missing bone | Impact in UE |
|---|---|
| `Head` | Face rotation goes to `Neck` only; head stuck at bind pose |
| `LeftShoulder`, `RightShoulder` | Shoulder compensation missing; arms look detached |
| `LeftHand`, `RightHand` | Wrist rotation not applied (see Gap 6) |
| `LeftFoot`, `RightFoot` | Ankles frozen at bind pose |
| `LeftToes`, `RightToes` | Toes frozen |
| `UpperChest` | Upper spine compensation missing |
| `LeftEye`, `RightEye`, `Jaw` | Eye gaze and jaw frozen |

Omitting a bone is not a crash — VRM4U just leaves it at bind pose. But it means legs,
feet, and eye gaze will not animate at all.

**Fix:** Emit `(0, 0, 0, 1)` identity quaternion packets for bones with no MediaPipe data,
at minimum for `Head`, `LeftHand`, `RightHand`, `LeftShoulder`, `RightShoulder`.

---

## 7. Summary

| # | Gap | Severity | Breaks VRM4U? | Fix file |
|---|---|---|---|---|
| 1 | Root name `"Hips"` → `"root"` | 🔴 Critical | Yes — root packet ignored | `vmc-builder.ts` |
| 2 | No quaternion axis flip (`-qX`, `-qY`, `-posZ`) | 🔴 Critical | Yes — all rotations wrong | `vmc-builder.ts` |
| 3 | Missing `/VMC/Ext/OK` | 🔴 Critical | Yes — device not recognized | `vmc-builder.ts` |
| 4 | Missing `/VMC/Ext/Blend/Apply` | 🔴 Critical | Yes — expressions never apply | `vmc-builder.ts` |
| 5 | VRM1 blend names instead of VRM0 | 🟠 High | Expressions silent in VRM0 setup | `vmc-builder.ts` |
| 6 | `LeftWrist` / `RightWrist` instead of `LeftHand` / `RightHand` | 🟠 High | Wrist bone ignored | `vmc-builder.ts` |
| 7 | Missing bones (Head, Shoulders, Feet, etc.) | 🟡 Medium | Lower body / eye gaze frozen | `vmc-builder.ts` |

All seven gaps are isolated to **`bridge/src/osc/vmc-builder.ts`**. The transport layer
(UDP, port 39539, `osc` library) is already correct and requires no changes.

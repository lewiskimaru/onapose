# OnaPose UI Design Specification

## Overview

The OnaPose interface is modeled after the macOS desktop metaphor — a persistent
menu bar at the top, a dock at the bottom, and a full-screen 3D scene acting as
the wallpaper. All panels float above the scene and can be collapsed into the dock.
The 3D avatar is always visible and never obscured by the shell chrome.

---

## Layout Layers (bottom to top)

```
z-index 0   — 3D scene (R3F Canvas, full viewport, always visible)
z-index 10  — Dock (bottom bar)
z-index 20  — Floating panels (camera, settings, docs)
z-index 30  — Menu bar (top bar)
z-index 40  — Modal overlays (about dialog, etc.)
```

---

## 1. Menu Bar

Position: fixed, top: 0, full width, height: 28px (matches macOS thin bar).
Background: rgba(0, 0, 0, 0.55) with backdrop-filter: blur(20px) saturate(180%).
Border-bottom: 1px solid rgba(255,255,255,0.08).

### Left section (left to right)

| Element        | Detail                                                        |
|----------------|---------------------------------------------------------------|
| Logo           | logo.png, 16x16, vertically centered, 12px left margin       |
| App name       | "OnaPose", 13px, font-weight 600, white, 6px gap after logo  |
| About          | text button, 13px, white/70%, opens About modal              |
| GitHub         | text button, 13px, white/70%, opens github.com/... in tab    |
| Docs           | text button, 13px, white/70%, toggles Docs panel             |
| Settings       | text button, 13px, white/70%, toggles Settings panel         |

### Right section (right to left)

| Element              | Detail                                                              |
|----------------------|---------------------------------------------------------------------|
| Fullscreen button    | Icon button, toggles document.fullscreenElement                    |
| WebSocket indicator  | Small circle, 8px diameter                                         |
|                      | Green (#34c759) = connected to bridge                              |
|                      | Yellow (#ff9f0a) = connecting / reconnecting                       |
|                      | Red (#ff3b30) = disconnected                                       |
|                      | Tooltip on hover: "Bridge: connected" / "Bridge: disconnected"     |

### Spacing

All menu bar items use 8px horizontal padding. The left and right sections are
flex rows with a spacer between them. No dividers between items.

---

## 2. 3D Scene (Wallpaper)

The R3F Canvas fills the full viewport and sits behind all UI chrome.
The avatar is always visible — no panel or overlay should cover the center
of the viewport where the avatar stands.

### Environment

Use `<Environment preset="night" />` from @react-three/drei as the base.
This provides the `dikhololo_night_1k.hdr` HDRI — a dark outdoor night sky
with subtle ambient light that complements dark VRM models without washing them out.

Lighting additions on top of the HDRI:
- One `<pointLight>` at position [0, 2, 2], intensity 1.5, color #6699ff (cool blue rim)
- One `<pointLight>` at position [-2, 1, -1], intensity 0.8, color #ff6644 (warm fill)
- `<ambientLight>` intensity 0.2 (prevents pure black shadows)

This gives the avatar a cinematic two-point lighting setup against the night sky.

### Background

`<color attach="background" args={["#0a0a0f"]} />` — near-black with a slight
blue tint. The HDRI provides reflections on the avatar without being used as the
visible background.

### Optional GLB stage asset

If a physical stage is desired, a dark sci-fi or abstract platform can be placed
under the avatar. Recommended free sources:

- Sketchfab (CC Attribution license, export as GLB):
  https://sketchfab.com/3d-models/sci-fi-room-or-industrial-space-775ab5d65ef64690a521e8138584a37f
  https://sketchfab.com/3d-models/futuristic-room-a60be41028b049b6a488f5c6effcb6f8

- The existing `sound-stage-final.glb` from r3f-vrm-final can be reused if
  relit with the dark environment (it is a neutral grey stage that takes on
  the color of the lighting).

Place the stage at `position={[0, -1.25, -1]}` to sit below the avatar group.

---

## 3. Dock

Position: fixed, bottom: 0, horizontally centered, height: 64px.
Background: rgba(255,255,255,0.08) with backdrop-filter: blur(24px).
Border-top: 1px solid rgba(255,255,255,0.1).
Border-radius: 16px 16px 0 0 on the visible portion, or a floating pill style
(border-radius: 16px, bottom: 8px, not full-width) — macOS Sonoma style.

### Dock items (default state)

Each item is a 48x48 icon button with a label below on hover.

| Item             | Icon                  | Action                                      |
|------------------|-----------------------|---------------------------------------------|
| Camera           | video camera icon     | Toggle camera panel open/collapsed          |
| Settings         | gear icon             | Toggle settings panel open/collapsed        |
| Docs             | book icon             | Toggle docs panel open/collapsed            |

### Collapsed panels

When a panel is minimized, a thumbnail or icon appears in the dock with a small
dot indicator below it (macOS open-app dot). Clicking restores the panel to its
last position and size.

### Dock magnification

On hover, dock items scale up from 48px to 64px with a smooth spring animation
(same as macOS). Adjacent items scale to 56px. Use framer-motion or CSS transform.

---

## 4. Floating Panels

All panels share the same base style:

```
background:      rgba(28, 28, 30, 0.72)
backdrop-filter: blur(40px) saturate(180%)
border:          1px solid rgba(255, 255, 255, 0.12)
border-radius:   12px
box-shadow:      0 8px 32px rgba(0, 0, 0, 0.6)
```

This is the "liquid glass" effect — a frosted dark glass that lets the 3D scene
bleed through while remaining readable.

Each panel has a title bar (32px, drag handle) with:
- Panel title (13px, white/80%)
- Close button (X, top right, collapses to dock)
- Minimize button (–, top right, collapses to dock)

Panels are draggable by their title bar. They remember their last position.

### 4a. Camera Panel

Default position: bottom-right, above the dock.
Default size: 320x240px (matches the camera feed aspect ratio).
Content: the webcam canvas overlay + video feed.
Loading state: the sliding progress bar overlay (already implemented).

### 4b. Settings Panel

Default position: center-right.
Default size: 320px wide, auto height.

Sections:
- Avatar — dropdown to select the active VRM model (replaces Leva avatar picker)
- Tracking — model complexity slider (0/1/2), smoothing toggle, confidence sliders
- Bridge — WebSocket URL input, OSC target host/port inputs, connection status
- Display — environment preset selector, lighting intensity sliders

This panel replaces the Leva debug panel entirely. Leva is removed from the
production UI.

### 4c. Docs Panel

Default position: center of viewport.
Default size: 640x480px, resizable.
Content: rendered markdown from the docs/ folder, navigable with a sidebar.
The liquid glass effect is especially prominent here — the panel is intentionally
semi-transparent so the avatar is visible through it.

---

## 5. About Modal

Triggered by the About button in the menu bar.
Centered overlay, 400x300px, same liquid glass style as panels.
Content: logo, app name, version, short description, links to GitHub and docs.
Closes on Escape or clicking outside.

---

## 6. PiP Mode (deferred)

Picture-in-picture mode will allow the camera feed to float as a small overlay
in a corner of the screen, similar to FaceTime PiP on macOS. The camera panel
collapses to a 160x120px floating thumbnail that can be dragged anywhere.
This feature is documented here but not yet implemented.

---

## 7. Typography and Color

| Token              | Value                          |
|--------------------|--------------------------------|
| Font family        | -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif |
| Base font size     | 13px                           |
| Menu bar text      | rgba(255,255,255,0.85)         |
| Panel title        | rgba(255,255,255,0.80)         |
| Body text          | rgba(255,255,255,0.65)         |
| Accent blue        | #0a84ff (macOS system blue)    |
| Connected green    | #34c759                        |
| Warning yellow     | #ff9f0a                        |
| Error red          | #ff3b30                        |
| Background base    | #0a0a0f                        |
| Glass surface      | rgba(28, 28, 30, 0.72)         |
| Glass border       | rgba(255, 255, 255, 0.12)      |

---

## 8. Implementation Notes

- The menu bar and dock are plain HTML/CSS positioned over the Canvas. They are
  NOT inside the R3F Canvas — they are DOM elements with pointer-events enabled.

- The Canvas must have `style={{ position: "fixed", inset: 0, zIndex: 0 }}` so
  it sits behind all DOM chrome.

- Leva is removed entirely from the production build. The Settings panel
  replicates all Leva controls as proper React components.

- Framer Motion is the recommended library for dock magnification, panel
  open/close animations, and the liquid glass panel drag behavior.

- The WebSocket status indicator reads from the `useWebSocket` hook's connection
  state, which needs to expose a `status` value ("connected" | "connecting" | "disconnected").

- The docs panel renders markdown. Use `react-markdown` with `remark-gfm`.

---

## 9. File Structure (new files to create)

```
client/src/
  shell/
    MenuBar.tsx          — top bar component
    Dock.tsx             — bottom dock with magnification
    DockItem.tsx         — individual dock icon
  panels/
    CameraPanel.tsx      — wraps CameraWidget in a draggable panel
    SettingsPanel.tsx    — avatar, tracking, bridge, display settings
    DocsPanel.tsx        — markdown docs viewer
    AboutModal.tsx       — about overlay
  hooks/
    usePanelState.ts     — open/closed/minimized state for each panel
    useFullscreen.ts     — fullscreen toggle logic
```

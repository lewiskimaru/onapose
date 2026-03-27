# Onapose

Browser-based full body motion capture with OSC/VMC output.
Runs entirely on macOS without Electron or Windows-only dependencies.

## Architecture

- client  — Vite + React + React Three Fiber. Runs MediaPipe Holistic in the browser,
            solves bone rotations with Kalidokit, renders a VRM avatar as a live debugger,
            and streams solved data to the bridge over WebSocket.

- bridge  — NestJS WebSocket gateway. Receives MocapFrame JSON from the client,
            converts Euler angles to quaternions, and emits VMC-spec OSC packets
            over UDP to any compatible receiver (Unreal Engine, Blender, TouchDesigner).

- shared  — TypeScript types shared between client and bridge (MocapFrame, RiggedPose, etc.)

## Requirements

- Node.js 20+
- npm 10+

## Setup

    cp .env.example .env
    npm install

## Development

    npm run dev

Starts both the client (http://localhost:5173) and the bridge (ws://localhost:8080)
with a single command. Logs are prefixed by process name.

## OSC Output

The bridge sends VMC-protocol OSC messages over UDP to the host and port configured
in .env (default: 127.0.0.1:39539).

Compatible receivers:
- Unreal Engine: VRM4U plugin + OSC plugin, port 39539
- Blender: VMC4B addon
- TouchDesigner: OSC In CHOP

## Environment Variables

| Variable          | Default         | Description                        |
|-------------------|-----------------|------------------------------------|
| BRIDGE_WS_PORT    | 8080            | WebSocket port for the bridge      |
| OSC_TARGET_HOST   | 127.0.0.1       | OSC receiver host                  |
| OSC_TARGET_PORT   | 39539           | OSC receiver port (VMC default)    |
| VITE_WS_URL       | http://localhost:8080 | Bridge URL used by the client |

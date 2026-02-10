# Engine Architecture Overview

The Entropy Engine is built on a high-performance Rust core, designed for modern graphics APIs and flexible addon integration.

## Core Components

- **Renderer State**: Manages the WebGPU device, queue, and surface. It handles the main render loop and resource allocation.
- **Pipeline System**: A flexible system for defining render and compute pipelines. It handles shader compilation and bind group management.
- **Project System**: Manages project state, saving and loading of addon data and scene configurations.
- **Addon Engine**: A Deno-powered environment that executes JavaScript/TypeScript addons and provides the `Entropy` API hooks.

## The G-Buffer Pipeline

Entropy primarily uses a **Deferred Rendering** architecture.

1. **Geometry Pass**: Models and terrains are rendered into a "G-Buffer" containing:
   - World Position
   - Normals
   - Albedo (Base Color)
   - PBR Material Data (Metallic, Roughness, AO)
2. **Lighting Pass**: A full-screen pass samples the G-Buffer and calculates final lighting based on the sun and point lights.
3. **Composite Pass**: Final post-processing, UI rendering, and screen-space effects.

## Coordinate System

- **Right-Handed**: Y is Up, X is Right, Z is Towards the Viewer (standard for many modern engines).
- **Units**: Generally 1 unit = 1 meter.

## Communication (JS <-> Rust)

The `Entropy` API in JavaScript communicates with the Rust core via a high-efficiency bridge. Calls like `Model.createProcedural` are serialized and sent to the core to be processed in the next frame's preparation phase.

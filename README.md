# Entropy Engine

![Entropy Chat UI](public/image-3.png "Entropy Chat UI")

![Entropy Engine / Chat Value](public/image.png "Entropy Engine / Chat Value")

Vibe your startup with Entropy Engine

- Shift from grunt work to creative leadership
- Command and coordinate your business through a centralized, agentic chat
- Built for the modern LLM-powered era with a semantic-first architecture

What’s included

- 3 starter experiences:
    - Game engine
    - Video editor
    - Writing experience
- Pre-built functionality with no plugins required
- Native integration across tools for a unified workflow

Why it matters

- Replace fragmented tools with a single intelligent system
- Instant cost savings upon adoption
- Continued efficiency gains as your business grows
- Compounding ROI through automation, reuse, and semantic coherence

## Run

Many controls exist in the level editor, while others have not been added, so you may wish to update the saved state json file directly and place files in the project folder directly.

Example Saved State JSON file to get you started:
<a href="./example_project.json" target="_blank">example_project.json</a>

Generate a Landscape Heightmap via CLI:
- `cargo run --bin heightmap --release`

Note: For now, if you're just getting started, you can go ahead and use the heightmap.png for the soilmap and rockmap as well. Then for the PBR textures, just fetch them from somewhere like Poly Haven.

Level Editor: 
- `cargo run --bin editor --release`

Example Game:
- `cargo run --bin game --release` (needs your game files to run)

### Development Notes

- Export animations in your GLB files with semantic labels (like LowerArm.r for the bone armature, or Walking for an animation name) as this will hook up automatically
- JavaScript scripting is in active development to make extending the engine easier and less involved (see `/scripts`)

## Features

### Current Features:

- GLB (gltf) Import
- GLB (gltf) animations
- Physics with Rapier
- Interactive, windy, procedural grass blades
- Deferred rendering / lighting
- PBR Materials
- Shadow Mapping
- Procedural trees (somewhat)
- Procedural houses (for prototyping)
- Water Planes
- Quadtree landscapes with texture maps
- Skybox Pipeline
- Point lighting
- Basic game behaviors (melee, chase, inventory, quests, etc)
- Sprinting/Stamina
- Magic particle effects (ex. fire from heavens, snow, etc)
- Dialogue (integrates with UI and scripting)
- JavaScript Scripting (replaced previous Rhai scripting to allow for TS and NPM modules in a JS bundle and more powerful add-ons)
- Aiming (with crosshair ui), ammo, and reloading
- Professional transform gizmo (as well as egui inputs)
- Rendered images and videos
- Rendered text with fonts
- In-Game UI Pipeline
- Procedural scattering of models
- Heightmap creation CLI (specify features and flat areas too)
- Mini-Map
- Screen capture
- Vector animations
- Video export
- Do level design via LLM powered chat
- NPC Swarm Systems
- Enemy looting
- Procedural recoil for ranged weapons
- Ranged weapon types (manual, semi-automatic, automatic)
- Wry webview embed for advanced rich text editing
- and more!

### TBD Features:

- Volumetric Fog
- Dynamic clouds
- Parallax Mapping
- Tessellation
- Displacement Mapping
- God rays
- Reflections
- Air based particle effects (ex. dust, smoke, rain)
- Fire (light procedural grass on fire, it burns for 15 seconds)
- River water (via maps) (currently only have ocean water)
- Maps for procedural grass or any scattered model (determine where it exists, variations)
- Vehicles (cars, planes, helicopters, motorcycles, tanks, mechs)
- Destruction
- Dynamic clothe (not out-of-the-box with Rapier?)
- Multiplayer helpers
- Landscape Simple Chunking (for practical use instead of quadtree) `HashMap<(x, y), Chunk>` for fast radius checks
- Animation blending and responsiveness
- Virtualized geometry
- Texture creation (using noise and colors) and texture colorization
- Audio

### TBD Game Mechanics:

- Score / Experience Points + Levels
- Interactive Objects (physics-based)
- Attachments
- Skill Points
- Skill trees
- GTA-style Phone Calls
- Eating
- Inspecting
- Opening (cupboard, chest, etc)
- “Mini Games”
- Sneaking
- Climbing
- Wall-running
- Combo systems
- Dodge/roll
- Crafting
- Currency systems
- Trading/Bartering
- Reputation systems
- Improve existing mechanics

### TBD Procedural Models:

- More foliage types
- More tree types
- Rock types

### Maybe:

- Procedural models for characters and more objects
- Animation creation for Models (FK + IK)

### Other Needs:

- Documentation (including on publishing and distribution)
- Game Saves for players (currently restart from beginning each time) and player death loop
- Configurable Controller Input -> Action Mapping (currently has default key mapping)

### Ecosystem Plans:

- Instant shareable live link of any game (via WASM) (with expiration and analytics)
- Live collaboration
- Crash telemetry?
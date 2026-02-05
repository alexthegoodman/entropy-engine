# Game Creation Workflow

Some of these need to be completed as addons, others as engine-side features.

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
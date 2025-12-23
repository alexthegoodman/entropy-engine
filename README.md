# Entropy Engine

Create beautiful games easily.

Entropy Engine is all about energizing Rust + wgpu-based game development by providing you with out-of-the-box systems and mechanics which can be easily forked and extended. It is both an engine and a level editor. Entropy Engine is focused on open-world (or smaller) game types at this time, but better support for something like RTS could come in the future.

Powering <a href="https://github.com/alexthegoodman/entropy-tauri" target="_blank">Entropy Chat</a>, inspired by MCP, built for creatives.

The purpose of Entropy Chat is simple. Real designers shouldn't have to make a dozen clicks for a single preview change. They should be creative, rather than technical. Check it out if you have a chance.

## Run

My current recommendation is to fork this engine and customize it for each game that you do. 
Some controls exist in the level editor, while others have not been added, so you may wish to update the saved state json file directly and place files in the project folder directly.

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
- Rhai scripting is in active development to make extending the engine easier and less involved (see `/scripts`)

## Features

### Current Features:

- GLB (gltf) Import
- GLB (gltf) animations
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
- Basic game behaviors (melee, chase, inventory, etc)
- Professional transform gizmo (as well as egui inputs)
- Rendered images and videos
- Rendered text with fonts
- In-Game UI Pipeline
- Heightmap creation CLI (specify features and flat areas too)
- Screen capture
- Vector animations
- Video export
- and more!

### TBD Features:

#### Priority

- More game logic and mechanics
- Modernize in-game UI choices
- Mini-Map
- Volumetric Fog
- Dynamic clouds

#### Secondary

- Parallax Mapping
- Tessellation
- Displacement Mapping
- God rays
- Reflections
- Air based particle effects (ex. dust, smoke, rain)
- Fire (light procedural grass on fire, it burns for 15 seconds)
- River water (currently only have ocean water)
- Maps for procedural grass (determine where it exists, variations)
- Vehicles (cars, planes, helicopters, motorcycles, tanks, mechs)
- Destruction
- Dynamic clothe (not out-of-the-box with Rapier?)
- Multiplayer helpers
- Procedural scattering of models
- Landscape Simple Chunking (for practical use instead of quadtree) `HashMap<(x, y), Chunk>` for fast radius checks
- Animation blending and responsiveness

### TBD Game Mechanics:

#### Priority

- Score / Experience Points + Levels
- Quests (and logs/tracking)

#### Secondary

- Interactive Objects (physics-based)
- Attachments
- Skill Points
- Skill trees
- Dialogue (integrates with UI)
- Status Bars (ex. Health, Sim’s)
- GTA-style Phone Calls
- Eating
- Inspecting
- Opening (cupboard, chest, etc)
- Aiming and reloading
- “Mini Games”
- Sneaking
- Climbing
- Sprinting/Stamina
- Wall-running
- Combo systems
- Dodge/roll
- Crafting
- Currency systems
- Trading/Bartering
- Reputation systems
- Improve existing mechanics
- Lua based scripting system (for those who dont want to fork the engine or are using Entropy Chat)

### TBD Procedural Models:

- Human
- Monster
- Animal
- TVs / Monitors
- Coffee maker
- Desk
- Bed
- Chair
- Couch
- Car
- Stairs
- Rocks

### Maybe:

- Procedural models for characters and more objects
- Animation creation for Models (FK + IK)
- Texture creation (using noise and colors) and texture colorization

### Other Needs:

- Documentation (including on publishing and distribution)
- Game Saves for players (currently restart from beginning each time)
- Configurable Controller Input -> Action Mapping (currently has default key mapping)
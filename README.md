# Entropy Engine

Create beautiful games easily.

Powering <a href="https://github.com/alexthegoodman/entropy-tauri" target="_blank">Entropy Chat</a>, inspired by MCP, built for creatives.

Real designers should use chat in a precise and granular way, so they don't have to make a dozen clicks for a single preview change. They can be creative, rather than technical.

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
- Basic game behaviors (melee, chase, etc)
- Rendered images and videos
- Rendered text with fonts
- Screen capture
- Vector animations
- Video export
- and more!

### TBD Features:

#### Priority

- More game logic and mechanics (ex. inventory, as defined below)
- Modernize in-game UI choices
- Mini-Map
- Volumetric Fog
- Dynamic clouds
- Game Saves for players
- Configurable Controller Input -> Action Mapping (currently has default key mapping)

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
- Enhanced native editor experience with stellar transform gizmo (for now using egui inputs)
- Dynamic clothe (not out-of-the-box with Rapier?)
- Multiplayer helpers
- Procedural scattering of models
- Landscape Simple Chunking (for practical use instead of quadtree) `HashMap<(x, y), Chunk>` for fast radius checks
- Animation blending and responsiveness

### TBD Game Mechanics:

#### Priority

- Inventory (weapon, item, armor)
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

- Heightmap creation with erosion noise (also specify x,z and height of mountain or start and end points and depth for canyon)
- Procedural models for characters and objects
- Animation creation for Models (FK + IK)
- Texture creation (using noise and colors)

### Other Needs:

- Documentation (including on publishing and distribution)

## Run

My current recommendation is to fork this engine and customize it for each game that you do. 
Some controls exist in the level editor, while others have not been added, so you may wish to update the saved state json file directly and place files in the project folder directly.

Example Game:
- `cargo run --bin game --release` (need the game files to run)

Level Editor: 
- `cargo run --bin editor --release`
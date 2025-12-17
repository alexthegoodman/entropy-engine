# Entropy Engine

Is it a game engine? A video engine? Entropy can do many things.

Powering a unified OS inspired by MCP.

### Current Features:

- Quadtree landscapes with texture maps
- Point lighting
- Game behaviors
- Kinematic animations
- Rendered images and videos
- Rendered text with fonts
- Screen capture
- Vector animations
- Video export
- GLB Import
- Interactive, windy, procedural grass blades
- Deferred rendering / lighting
- PBR Materials
- Shadow Mapping
- Procedural trees (somewhat)
- and more!

### TBD Features:

- Game Saves for players
- Skybox Pipeline
- Parallax Mapping
- Tessellation
- Displacement Mapping
- God rays
- Reflections
- Dynamic clouds
- Volumetric Fog
- Air based particle effects (ex. dust, smoke, rain)
- Fire (light procedural grass on fire, it burns for 15 seconds)
- Water (initialy just rivers and streams, later submersion) (may require bouyancy forces)
- Maps for procedural grass (determine where it exists, variations)
- Vehicles (cars, planes, helicopters, motorcycles, tanks, mechs)
- Destruction
- More game logic and mechanics (ex. inventory)
- Mini-Map
- Modernize in-game UI choices
- Enhanced editor experience with stellar transform gizmo (for now using egui inputs)
- Dynamic clothe (not out-of-the-box with Rapier?)
- Multiplayer helpers
- Procedural scattering of models
- Heightmap creation with erosion noise (also specify x,z and height of mountain or start and end points and depth for canyon)
- Procedural models for characters and objects
- Animation creation for Models (FK + IK)
- Texture creation (using noise and colors)
- Landscape Simple Chunking (for casual use instead of quadtree)

### TBD Procedural Models:

- Human
- Monster
- Animal
- House
- TVs / Monitors
- Coffee maker
- Desk
- Bed
- Chair
- Couch
- Car
- Stairs
- Rocks

### TBD Game Mechanics:

- Interactive Objects
- Attachments
- Score / Experience Points
- Skill Points
- Skill trees
- Dialogue
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
- Inventory (weapon, item, armor)
- Currency systems
- Trading/Bartering
- Quests (and logs/tracking)
- Reputation systems

### Other Needs:

- Documentation (including on publishing and distribution)

## Run

My current recommendation is to fork this engine and customize it for each game that you do. 
Some controls exist in the level editor, while others have not been added, so you may wish to update the saved state json file directly and place files in the project folder directly.

Example Game:
- `cargo run --bin game --release` (need the game files to run)

Level Editor: 
- `cargo run --bin editor --release`
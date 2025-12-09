# Entropy Engine

Is it a game engine? A video engine? Entropy can do many things.

Powering a unified OS inspired by MCP.

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
- and more!

TBD:

- Parallax Mapping
- Tessellation
- Displacement Mapping
- God rays
- Reflections
- Dynamic clouds
- Volumetric Fog
- Air based particle effects (ex. dust, smoke)
- Fire (light procedural grass on fire, it burns for 15 seconds)
- Water (initialy just rivers and streams, later submersion) (may require bouyancy forces)
- Maps for procedural grass (determine where it exists, variations)
- Vehicles (cars, planes, helicopters, motorcycles, tanks, mechs)
- Destruction
- More game logic and mechanics (ex. inventory)
- Mini-Map
- Modernize in-game UI choices
- Enhanced editor experience with stellar transform gizmo
- Dynamic clothe (not out-of-the-box with Rapier?)
- Multiplayer helpers
- Procedural scattering of models
- PBR Materials

## Run

My current recommendation is to fork this engine and customize it for each game that you do. 
Some controls exist in the level editor, while others have not been added, so you may wish to update the saved state json file directly and place files in the project folder directly.

Example Game:
- `cargo run --bin game --release` (need the game files to run)

Level Editor: 
- `cargo run --bin entropy-engine --release`
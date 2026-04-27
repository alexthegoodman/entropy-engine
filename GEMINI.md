# Entropy Engine

Entropy Engine is now a game dev framework with no editor, as it is going code-only. The basic premise to create native games using TypeScript or JavaScript via a Deno layer.
We want to provide helpful capabilities and primitives so that things are easier than your typical framework. This mostly done by creating a great addon API.

Here's some info on the current architecture:

All the code is in /src/ and /scripts/addons/studio-bundle/src/.

With the addon studio bundle there is:

- Enviornment (Sun and Sky)
- Beautiful FFT Water
- JS-generated Terrain (flexnoise for smaller)
- Rust-generated Terrain (megaworlds for bigger)
- Hair Particles (grass)
- Light Management (light hive)
- Procedural PBR Texture Generator (designer)
- Basic water plane
- Fog (volumetric fx)
- Model Import (+ Player and NPC creation) (model viewer)
- A couple rivers attempts (neither good yet)
- Game Composer (mix objects from other addons, start a Yumon training session, etc)

Game Addons (like fps_rpg in the studio-bundle) should handle game behaviors and game ui using native primitives via deno layer.

Within /src/, there are several directories:

/art_assets/ handles GLB import and the wgpu Model creation as well as ScatteredModel (which distributes instances of a Model)
/core/ handles all kinds of things from shaders to camera to Editor and RendererState, it also has the important pipeline.rs which contains the actual frame render function(s)
/heightfield_landscapes/ contains two landscape implementations (a quadtree version and a normal version). We are currently using the normal version in Landscape.rs
/helpers/ will include data regarding the saved state (saved_data.rs)
/procedural_grass/ is a powerful interactive hair particle system featuring grass with wind and its own render pipeline and shader
/procedural_models/ contains models like House which have dynamic numbers of rooms, roof type, etc
/procedural_trees/ is the tree pipeline and shader designed to give realistic looking tree variations
/renderer_images/ is just for rendering raw images in the scene (uncommon in games)
/renderer_text/ is used for rendering raw text in the scene (uncommon in games, although maybe for UI if UI is integrated)
/shape_primitives/ offers a number of simple shapes (Cube, polygon, etc) to render in the scene
/model_components/ has components that are associated with models such as PlayerCharacter, NPC, and Collectables (however, most game logic should be JS / addon-side)
/deno/ contains the addon engine for both game logic and rendering logic in JS scripts
/yumon/ contains the system.rs Rust Burn LSTM model which implements behavior cloning concepts for creating NPC behaviors

startup.rs has the winit code
handlers.rs has a number of event handlers (like click and key handlers)
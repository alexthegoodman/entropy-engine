# Entropy Engine (Open World Studio, Sophia, and Stunts)

This project is a native editor, chat, and engine for videos, games and other creative projects, with plans for a future add-on marketplace for new, high-performance app experiences.

Ultimately, this engine is similar to MCP but without the hassle of MCP setup processes. The central advantage is the easily-used agentic system based on LLMs and add-on interop, while each app / add-on may have its own benefits and its own workspace.

Here's some info on the current architecture:

All the code is in /src/ and /scripts/addons/studio-bundle/src/.

With the studio bundle there is
- DAW Synth
- Enviornment (Sun and Sky)
- Beautiful FFT Water
- JS-generated Terrain (flexnoise)
- Hair Particles (grass)
- Light Management
- Rust-generated Terrain (megaworlds)
- Procedural PBR Texture Generator (designer)
- Based Water Plane

Within /src/, there are several directories:

/art_assets/ handles GLB import and the wgpu Model creation as well as ScatteredModel (which distributes instances of a Model)
/core/ handles all kinds of things from shaders to camera to Editor and RendererState, it also has the important pipeline.rs which contains the actual frame render function(s)
/core/ also contains the egui_sidebar.rs which describes most of egui ui for the Chat as well as Properties, Projects, and Components
/game_behaviors/ is for in-game AI and mechanics
/game_ui/ holds the UI pipeline's frontend implementations
/heightfield_landscapes/ contains two landscape implementations (a quadtree version and a normal version). We are currently using the normal version in Landscape.rs
/helpers/ will include data regarding the saved state (saved_data.rs)
/physics/ offers a simple custom physics implementation, but it is not used here. Instead, we use Rapier.
/procedural_grass/ is a powerful interactive hair particle system featuring grass with wind and its own render pipeline and shader
/water_plane/ has the water shader and pipeline creation
/procedural_models/ contains models like House which have dynamic numbers of rooms, roof type, etc
/procedural_trees/ is the tree pipeline and shader designed to give realistic looking tree variations
/renderer_images/ is just for rendering raw images in the scene (uncommon in games)
/renderer_text/ is used for rendering raw text in the scene (uncommon in games, although maybe for UI if UI is integrated)
/renderer_videos/ is used for rendering raw videos in the scene
/shape_primitives/ offers a number of simple shapes to render in the scene
/model_components/ has components that are associated with models such as PlayerCharacter, NPC, and Collectables
/vector_animations/ helps with 2D motion path animations
/video_export/ leverages Media Foundation to power mp4 video export on Windows
/deno/ contains the script_engine for things like game scripts, and this folder also contains the addon_engine for full addon capabilities

startup.rs has the winit code
handlers.rs has a number of event handlers (like click and key handlers)

## Focus

We are focused on the addons now, and just leveraging the underlying Rust capabilities to power the addon experience.

Future addons may include:

- Machine Learning Node Graph Editor
- Color Corrector
- FK / IK Animation
- Mesh Sculpting
- Mesh Modelling
- Media Player
- Forum Portal
- File Browser
- Dot Particles
- Behavior Tree Node Graph Editor
- UI Designer (for in-game UIs)
- DAW Mastering
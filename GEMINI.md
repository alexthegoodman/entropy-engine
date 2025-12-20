# Entropy Engine

entropy-engine is essentially a mixture of midpoint-engine (game engine) and stunts-engine (video engine) in a unified codebase. It has landscapes, video, text, images, 3d models, lighting, and more.

Ultimately, this engine will power separate editor's used for different purposes, and will even power a chat UI which enables the user to do things via chat similar to MCP but without the hassle of MCP setup processes.

Here's some info on the architecture:

All the code is in /src/.

Within /src/, there are several directories:

/art_assets/ handles GLB import and the wgpu Model creation
/core/ handles all kinds of things from shaders to camera to Editor and RendererState, it also has the important pipeline.rs which contains the actual frame render function(s)
/game_behaviors/ is for in-game AI and mechanics
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

startup.rs has the winit code
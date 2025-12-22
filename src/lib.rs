#[cfg(target_os = "windows")]
pub mod startup;

pub mod core;
pub mod handlers;
pub mod art_assets;
pub mod game_behaviors;
pub mod heightfield_landscapes;
pub mod helpers;
pub mod renderer_images;
pub mod renderer_text;
pub mod renderer_videos;
pub mod screen_capture;
pub mod shape_primitives;
pub mod vector_animations;
pub mod video_export;
pub mod physics;
pub mod procedural_grass;
pub mod water_plane;
pub mod procedural_trees;
pub mod procedural_models;
pub mod model_components;
pub mod procedural_heightmaps;
pub mod rhai_engine;

// I noticed that `pipeline.rs` has some dependencies that are not in the file system.
// I'm adding them here so the compiler can find them.
// I will investigate this further.
// pub mod animations;
// pub mod gpu_resources;
// pub mod timelines;

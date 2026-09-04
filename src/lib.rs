#![allow(warnings)]

#[cfg(target_os = "windows")]
pub mod startup;

pub mod entropy_gui;

// COMPAT ALIASES — entropy_gui is our own in-house immediate-mode GUI kit that replaces
// egui/egui-wgpu/egui-winit/egui_dock. These aliases exist so the many existing call sites
// (written against those crates) keep compiling with minimal changes; see
// src/entropy_gui/mod.rs for the real implementation. Not a permanent identity — new code
// should prefer `entropy_gui::` directly.
pub use entropy_gui as egui;
pub use entropy_gui::backend::wgpu_renderer as egui_wgpu;
pub use entropy_gui::backend::winit_input as egui_winit;
pub use entropy_gui::dock as egui_dock;

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
pub mod procedural_particles;
pub mod model_components;
pub mod procedural_heightmaps;
pub mod game_ui;
pub mod deno;
pub mod audio;
pub mod alpha;
pub mod yumon;

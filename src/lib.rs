#![allow(warnings)]

#[cfg(not(target_arch = "wasm32"))]
pub mod startup;

#[cfg(not(target_arch = "wasm32"))]
pub mod app;
#[cfg(not(target_arch = "wasm32"))]
pub use app::EntropyApp;

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
#[cfg(target_os = "windows")]
pub mod media_player;
#[cfg(not(target_arch = "wasm32"))]
pub mod stylus;
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
pub mod mcp;
pub mod audio;
pub mod guitar;
pub mod guitar_live;
pub mod alpha;
pub mod yumon;
pub mod ml_graph;
pub mod ml_architecture;

/// Every example `src/bin/example.rs` can dispatch, in the order its usage message lists them.
/// This lives in the library rather than in that binary because `op_launch_example` validates
/// against it: it is the whole fence between an addon naming an app to start and an addon naming
/// an arbitrary program, so both sides have to read the same list.
#[cfg(not(target_arch = "wasm32"))]
pub const LAUNCHABLE_EXAMPLES: &[&str] = &[
    "app-launcher",
    "canvas-surface-demo",
    "cc-manager",
    "daw",
    "doc-editor-demo",
    "fft-river",
    "fft-water",
    "game2d",
    "html-ui-demo",
    "keyframe-tracks-demo",
    "level-editor-2d",
    "light-hive",
    "mcp-tools-demo",
    "media-player",
    "ml-graph-demo",
    "node-graph",
    "sheet",
    "stylus-drawing",
    "theme-gallery",
    "video-export-demo",
];

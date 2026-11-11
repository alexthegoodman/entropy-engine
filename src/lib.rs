#![allow(warnings)]
// Burn's Wgpu backend (src/prediction) needs a deeper trait-solver limit than the default 128.
#![recursion_limit = "256"]

#[cfg(not(target_arch = "wasm32"))]
pub mod startup;

#[cfg(not(target_arch = "wasm32"))]
pub mod app;
#[cfg(not(target_arch = "wasm32"))]
pub use app::EntropyApp;

// The portable script runtime: Rhai addons on winit + wgpu, natively and in the browser. On
// wasm32 it is the whole library - Deno (V8), the desktop audio stack, P2P, VST3 and the rest of
// Studio cannot run in a browser, so they are compiled for native targets only.
pub mod script;

#[cfg(not(target_arch = "wasm32"))]
pub mod entropy_gui;

// COMPAT ALIASES — entropy_gui is our own in-house immediate-mode GUI kit that replaces
// egui/egui-wgpu/egui-winit/egui_dock. These aliases exist so the many existing call sites
// (written against those crates) keep compiling with minimal changes; see
// src/entropy_gui/mod.rs for the real implementation. Not a permanent identity — new code
// should prefer `entropy_gui::` directly.
#[cfg(not(target_arch = "wasm32"))]
pub use entropy_gui as egui;
#[cfg(not(target_arch = "wasm32"))]
pub use entropy_gui::backend::wgpu_renderer as egui_wgpu;
#[cfg(not(target_arch = "wasm32"))]
pub use entropy_gui::backend::winit_input as egui_winit;
#[cfg(not(target_arch = "wasm32"))]
pub use entropy_gui::dock as egui_dock;

#[cfg(not(target_arch = "wasm32"))]
pub mod core;
#[cfg(not(target_arch = "wasm32"))]
pub mod handlers;
#[cfg(not(target_arch = "wasm32"))]
pub mod art_assets;
#[cfg(not(target_arch = "wasm32"))]
pub mod game_behaviors;
#[cfg(not(target_arch = "wasm32"))]
pub mod heightfield_landscapes;
#[cfg(not(target_arch = "wasm32"))]
pub mod helpers;
#[cfg(not(target_arch = "wasm32"))]
pub mod renderer_images;
#[cfg(not(target_arch = "wasm32"))]
pub mod renderer_text;
#[cfg(not(target_arch = "wasm32"))]
pub mod renderer_videos;
#[cfg(target_os = "windows")]
pub mod media_player;
// Same `MediaPlayer` API as the Media Foundation one above, backed by OpenH264 + symphonia.
#[cfg(not(any(target_os = "windows", target_arch = "wasm32")))]
#[path = "media_player/openh264.rs"]
pub mod media_player;
#[cfg(not(any(target_os = "windows", target_arch = "wasm32")))]
pub mod openh264_codec;
#[cfg(not(target_arch = "wasm32"))]
pub mod stylus;
#[cfg(not(target_arch = "wasm32"))]
pub mod screen_capture;
#[cfg(not(target_arch = "wasm32"))]
pub mod shape_primitives;
#[cfg(not(target_arch = "wasm32"))]
pub mod vector_animations;
#[cfg(not(target_arch = "wasm32"))]
pub mod video_export;
#[cfg(not(target_arch = "wasm32"))]
pub mod music_video;
#[cfg(not(target_arch = "wasm32"))]
pub mod physics;
#[cfg(not(target_arch = "wasm32"))]
pub mod procedural_grass;
#[cfg(not(target_arch = "wasm32"))]
pub mod water_plane;
#[cfg(not(target_arch = "wasm32"))]
pub mod procedural_trees;
#[cfg(not(target_arch = "wasm32"))]
pub mod procedural_models;
#[cfg(not(target_arch = "wasm32"))]
pub mod procedural_particles;
#[cfg(not(target_arch = "wasm32"))]
pub mod model_components;
#[cfg(not(target_arch = "wasm32"))]
pub mod procedural_heightmaps;
#[cfg(not(target_arch = "wasm32"))]
pub mod game_ui;
#[cfg(not(target_arch = "wasm32"))]
pub mod deno;
#[cfg(not(target_arch = "wasm32"))]
pub mod mcp;
#[cfg(not(target_arch = "wasm32"))]
pub mod p2p;
#[cfg(not(target_arch = "wasm32"))]
pub mod audio;
#[cfg(not(target_arch = "wasm32"))]
pub mod guitar;
#[cfg(not(target_arch = "wasm32"))]
pub mod guitar_live;
#[cfg(not(target_arch = "wasm32"))]
pub mod alpha;
#[cfg(not(target_arch = "wasm32"))]
pub mod yumon;
#[cfg(not(target_arch = "wasm32"))]
pub mod ml_graph;
#[cfg(not(target_arch = "wasm32"))]
pub mod ml_architecture;
#[cfg(not(target_arch = "wasm32"))]
pub mod prediction;

// Burn's seeded CPU backend uses shared RNG state. Tests that seed and train models must hold
// this lock through completion so parallel unit tests cannot change one another's initialization.
// This is a rare exception where a Mutex is allowed in this codebase
#[cfg(test)]
pub(crate) static ML_TEST_RNG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Every example `src/bin/example.rs` can dispatch, in the order its usage message lists them.
/// This lives in the library rather than in that binary because `op_launch_example` validates
/// against it: it is the whole fence between an addon naming an app to start and an addon naming
/// an arbitrary program, so both sides have to read the same list.
#[cfg(not(target_arch = "wasm32"))]
pub const LAUNCHABLE_EXAMPLES: &[&str] = &[
    "abyss",
    "allegiance",
    "app-launcher",
    "canvas-surface-demo",
    "cc-manager",
    "p2p-forum",
    "creative-suite",
    "daw",
    "doc-editor-demo",
    "fft-river",
    "fft-water",
    "game-detailer",
    "game-planner",
    "game2d",
    "guitar-tabs",
    "html-ui-demo",
    "keyframe-tracks-demo",
    "level-editor-2d",
    "light-hive",
    "mcp-tools-demo",
    "media-player",
    "mesha",
    "ml-graph-demo",
    "nebula-kingdom",
    "node-graph",
    "quadplanet",
    "sheet",
    "special-bundle",
    "stylus-drawing",
    "terminal",
    "theme-gallery",
    "video-export-demo",
];

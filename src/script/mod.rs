//! The portable script runtime: an Entropy app scripted in [Rhai](https://rhai.rs), on winit +
//! wgpu, that runs the same natively and in a browser (WebAssembly + WebGPU).
//!
//! Studio's addon engine (`crate::deno`) embeds V8 through Deno, which cannot be compiled to
//! WebAssembly. This runtime is the other host: scripts are Rhai, interpreted by Rust itself, so
//! a page runs nothing but the engine's own WASM - no JavaScript is ever evaluated from a script.
//! A Rhai script can only call the functions registered in [`host`]; it has no DOM, no network
//! and no `eval` into the page.
//!
//! The API mirrors the TypeScript `Entropy` object for the parts a game needs: custom WGSL
//! pipelines, GPU buffers, cached meshes drawn instanced, the camera, a retained 2D UI of rects
//! and text, input (keys, mouse, gamepad), synthesized notes, and a per-app document store. See
//! `docs/RHAI_SCRIPTING.md` for the script-side reference.
//!
//! - [`state`]: what scripts change (pending GPU commands, camera, UI, input), shared by the host
//!   and the app.
//! - [`gpu`] / [`ui`]: drawing it.
//! - [`host`]: the Rhai engine, the `Entropy` API and the lifecycle callbacks.
//! - [`rmath`]: fast native helpers scripts lean on (vectors, seeded RNG, instance packing).
//! - [`app`]: the window, the frame loop and [`ScriptApp`], the entry point.

pub mod app;
pub mod apps;
pub mod audio;
pub mod fonts;
pub mod gpu;
pub mod host;
pub mod jsrt;
pub mod rmath;
pub mod state;
pub mod store;
pub mod ui;
#[cfg(target_arch = "wasm32")]
pub mod web;

pub use app::{ScriptApp, ScriptSources};

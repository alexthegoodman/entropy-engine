// Music videos for songs made in the DAW: a collection of audio-reactive visualizer styles, a live
// preview widget, and an MP4 export (H.264 video + AAC audio) that runs on a background thread.
//
// - `settings`: `VisualizerSettings`, everything the user customizes (style, size, fps, colours,
//   sensitivity, text, background image). Shared verbatim by the preview and the export.
// - `features`: `FeatureTracker` reduces audio to what the visuals react to (bands, waveform,
//   level, beat), with time-constant smoothing so 60 Hz preview and 30 fps export move alike.
// - `raster`: a small anti-aliased CPU rasterizer with bloom and text.
// - `scenes`: `Visualizer`, which draws each style from `AudioFeatures` into RGBA8 frames.
// - `export`: `MusicVideoJob`, WAV + settings -> MP4 on its own thread, with progress and cancel.
//
// The preview widget (`Widget.musicVisualizer`, drawn in `deno::addon_engine`) and the export use
// the same `Visualizer`, so what the preview shows is what the file will contain, just smaller.
// Unlike `video_export::exporter` (which captures the live 3D scene at window size, one frame per
// real frame), nothing here needs the GPU, so exports run at any resolution while the app works.
pub mod features;
pub mod raster;
pub mod scenes;
pub mod settings;
#[cfg(not(target_arch = "wasm32"))]
pub mod export;

pub use features::{AudioFeatures, FeatureTracker};
pub use scenes::Visualizer;
pub use settings::{VisualStyle, VisualizerSettings};

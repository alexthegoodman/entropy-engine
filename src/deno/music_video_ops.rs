//! Music-video ops on `Entropy.Video` (`musicVideoStyles`, `exportMusicVideo`, `pollMusicVideo`,
//! ...) and the `Widget.musicVisualizer` live preview. See `crate::music_video` for the renderer
//! and the export job.
//!
//! The export takes a WAV the addon has already bounced (the DAW uses `Audio.renderPatternToWav`
//! with `{ tempFile: true }`) and runs on its own thread; the addon polls for progress from its
//! update loop. The preview draws the same `Visualizer` from the live audio engine's analysis tap
//! (`"master"` or a track id), on the CPU at the widget's size, into a texture the GUI shows.

use std::path::PathBuf;
use std::time::Instant;

use deno_core::{op2, OpState};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::audio::analysis::ENGINE_SAMPLE_RATE;
use crate::deno::addon_ops::{AddonContext, UiWidget};
use crate::egui;
use crate::egui_wgpu;
use crate::music_video::export::{MusicVideoJob, MusicVideoRequest, MusicVideoStatus};
use crate::music_video::features::FEATURE_FFT;
use crate::music_video::{FeatureTracker, VisualStyle, Visualizer, VisualizerSettings};

type Json = serde_json::Value;

#[derive(Serialize)]
pub struct StyleInfo {
    id: &'static str,
    label: &'static str,
}

/// Every visualizer style, in menu order.
#[op2]
#[serde]
pub fn op_music_video_styles() -> Vec<StyleInfo> {
    VisualStyle::ALL.iter().map(|s| StyleInfo { id: s.id(), label: s.label() }).collect()
}

/// The default `VisualizerSettings`, so an addon can start from (and reset to) the engine's own.
#[op2]
#[serde]
pub fn op_music_video_defaults() -> VisualizerSettings {
    VisualizerSettings::default()
}

/// A save dialog for the MP4. `null` when cancelled. `ENTROPY_MUSIC_VIDEO_OUTPUT` answers it
/// instead, so the live test (tests/daw_visualizer_live.rs) can export without a person clicking.
#[op2]
#[string]
pub fn op_music_video_choose_path(#[string] suggested_name: String) -> Option<String> {
    if let Ok(path) = std::env::var("ENTROPY_MUSIC_VIDEO_OUTPUT") {
        return Some(path);
    }
    rfd::FileDialog::new()
        .add_filter("MP4 Video", &["mp4"])
        .set_file_name(&suggested_name)
        .save_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// An open dialog for a background picture. `null` when cancelled.
#[op2]
#[string]
pub fn op_music_video_choose_image() -> Option<String> {
    rfd::FileDialog::new()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp", "bmp"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MusicVideoStartConfig {
    pub wav_path: String,
    pub output_path: String,
    #[serde(default)]
    pub settings: VisualizerSettings,
    /// Delete `wav_path` when the export ends (it was a temporary bounce).
    #[serde(default)]
    pub delete_wav: bool,
}

/// Starts an export on a background thread. `{ ok, error? }`; only one runs at a time.
#[op2]
#[serde]
pub fn op_music_video_start(state: &mut OpState, #[serde] config: MusicVideoStartConfig) -> Json {
    let Some(ctx) = state.try_borrow_mut::<AddonContext>() else {
        return json!({ "ok": false, "error": "Context not available" });
    };
    let refuse = |error: &str| {
        // A temporary bounce handed over for an export that never starts is still ours to clean up.
        if config.delete_wav {
            let _ = std::fs::remove_file(&config.wav_path);
        }
        json!({ "ok": false, "error": error })
    };
    if ctx.music_video_job.as_ref().is_some_and(|job| !job.is_done()) {
        return refuse("A music video is already exporting");
    }
    if config.output_path.trim().is_empty() {
        return refuse("No output path");
    }
    ctx.music_video_job = Some(MusicVideoJob::start(MusicVideoRequest {
        wav_path: PathBuf::from(config.wav_path),
        output_path: PathBuf::from(config.output_path),
        settings: config.settings,
        delete_wav: config.delete_wav,
    }));
    json!({ "ok": true })
}

/// Progress of the running export, or its final state exactly once (`done: true`), then `null`.
#[op2]
#[serde]
pub fn op_music_video_poll(state: &mut OpState) -> Option<MusicVideoStatus> {
    let ctx = state.try_borrow_mut::<AddonContext>()?;
    let status = ctx.music_video_job.as_ref()?.status();
    if status.done {
        ctx.music_video_job = None;
    }
    Some(status)
}

/// Stops the running export at its next frame; the partial file is removed.
#[op2(fast)]
pub fn op_music_video_cancel(state: &mut OpState) {
    if let Some(job) = state.try_borrow::<AddonContext>().and_then(|ctx| ctx.music_video_job.as_ref()) {
        job.cancel();
    }
}

/// `Widget.musicVisualizer`.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MusicVisualizerConfig {
    /// `"master"` (default) or a track id.
    pub source: String,
    #[serde(default)]
    pub settings: VisualizerSettings,
    /// Preview width in points; omit to fill the row. The height follows the video's aspect.
    pub width: Option<f32>,
    /// Caps the height (the width shrinks to keep the aspect). Default 360.
    pub max_height: Option<f32>,
}

#[op2]
pub fn op_ui_widget_music_visualizer(
    state: &mut OpState,
    #[string] window_id: String,
    #[serde] config: MusicVisualizerConfig,
    #[string] id: String,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::MusicVisualizer { id, config });
    }
}

/// What one preview widget keeps between frames.
pub struct MusicPreview {
    /// The settings it was built for, at preview size: a change rebuilds the visualizer.
    settings: VisualizerSettings,
    visualizer: Visualizer,
    tracker: FeatureTracker,
    texture: wgpu::Texture,
    texture_id: egui::TextureId,
    last_frame: Instant,
}

/// Draws the preview for `UiWidget::MusicVisualizer` (called from `AddonEngine::render_widgets`).
pub fn draw_preview(ui: &mut egui::Ui, id: &str, config: &MusicVisualizerConfig, context: &mut AddonContext, renderer: &mut egui_wgpu::Renderer) {
    let settings = config.settings.sanitized();
    let aspect = settings.height as f32 / settings.width as f32;
    let max_h = config.max_height.unwrap_or(360.0).max(32.0);
    let mut w = config.width.unwrap_or_else(|| ui.available_width()).clamp(64.0, 1280.0);
    let mut h = w * aspect;
    if h > max_h {
        h = max_h;
        w = h / aspect;
    }
    let (rect, _response) = ui.allocate_exact_size(egui::vec2(w, h), egui::Sense::hover());
    let Some(gpu) = context.gpu_resources.clone() else {
        ui.painter().rect_filled(rect, 4.0, egui::Color32::from_rgb(10, 12, 18));
        return;
    };
    // Rendered at the displayed size, snapped to 16-pixel steps so dragging a window edge doesn't
    // reallocate the texture every frame (the GUI scales the last few pixels).
    let snap = |v: f32| ((v / 16.0).round() * 16.0).max(64.0) as u32;
    let preview_settings = settings.at_size(snap(w), snap(h));
    let (pw, ph) = (preview_settings.width, preview_settings.height);

    let rebuild = context.music_previews.get(id).map_or(true, |p| p.settings != preview_settings);
    if rebuild {
        let old = context.music_previews.remove(id);
        // Same size: keep the texture. Otherwise make one to match and forget the old one.
        let (texture, texture_id, tracker) = match old {
            Some(old) if (old.settings.width, old.settings.height) == (pw, ph) => (old.texture, old.texture_id, Some(old.tracker)),
            old => {
                let tracker = old.map(|old| {
                    renderer.free_texture(old.texture_id);
                    old.tracker
                });
                let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("Music Visualizer Preview"),
                    size: wgpu::Extent3d { width: pw, height: ph, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                });
                let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                let texture_id = renderer.register_native_texture(&gpu.device, &view, wgpu::FilterMode::Linear);
                (texture, texture_id, tracker)
            }
        };
        // The tracker carries over a restyle, so levels don't snap to zero mid-song.
        let tracker = tracker.unwrap_or_else(|| FeatureTracker::new(ENGINE_SAMPLE_RATE as f32));
        context.music_previews.insert(
            id.to_string(),
            MusicPreview { visualizer: Visualizer::new(&preview_settings), settings: preview_settings, tracker, texture, texture_id, last_frame: Instant::now() },
        );
    }
    let preview = context.music_previews.get_mut(id).expect("inserted above");
    let dt = preview.last_frame.elapsed().as_secs_f32();
    preview.last_frame = Instant::now();
    let source = if config.source.is_empty() { "master" } else { config.source.as_str() };
    let snapshot = context.audio_engine.snapshot(source, FEATURE_FFT);
    let (left, right) = snapshot.as_ref().map_or((&[][..], &[][..]), |s| (&s.left[..], &s.right[..]));
    let features = preview.tracker.update(left, right, dt, &preview.settings);
    let rgba = preview.visualizer.render(features, dt, None);
    gpu.queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture: &preview.texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        rgba,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(pw * 4), rows_per_image: Some(ph) },
        wgpu::Extent3d { width: pw, height: ph, depth_or_array_layers: 1 },
    );
    ui.painter().image(preview.texture_id, rect, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), egui::Color32::WHITE);
}

// Drives an already-initialized, already-running `EntropyPipeline` through N offscreen frames
// and muxes them to an MP4 via `encode::VideoEncoder`. This replaced an earlier design here that
// re-initialized a whole second headless `EntropyPipeline` from a project id and called into
// `render_frame` (the pre-`render_addon_frame` legacy render path, see render_frame.rs's own
// "legacy code kept for reference only" note) - that path never actually rendered an addon's
// live scene, just a blank/legacy one. See the 2026-09-11 video export post's decision log for
// why capturing the live pipeline in place, rather than reconstructing one, won out.
use std::time::Instant;

use nalgebra::Point3;

use crate::core::pipeline::EntropyPipeline;
use crate::video_export::encode::VideoEncoder;
use crate::video_export::frame_buffer::FrameCaptureBuffer;

#[derive(Debug, Clone)]
pub struct VideoExportRequest {
    pub output_path: String,
    pub fps: u32,
    pub duration_ms: u32,
}

#[derive(Debug, Clone)]
pub struct VideoExportResult {
    pub output_path: String,
    pub frame_count: u32,
    pub elapsed_ms: u64,
}

/// Renders `request.duration_ms` of the addon's current scene offscreen at `request.fps` and
/// writes it to `request.output_path` as H.264/MP4. Runs synchronously on the calling thread -
/// the window stops updating for the export's duration, and so does the addon's own JS
/// `onUpdatePlus` loop (Deno ops never run mid-export, since this whole loop is plain Rust
/// driven from `EntropyPipeline::render_display_frame`, not from a JS tick) - see the demo
/// addon's camera orbit, which the exporter drives itself frame-by-frame for exactly this
/// reason rather than relying on the live per-tick callback.
///
/// The capture buffer is sized to the pipeline's *current* color/depth targets rather than an
/// arbitrary requested resolution: wgpu requires every attachment in a render pass to share one
/// size, and `pipeline.depth_view` is allocated once at window size - passing a differently
/// sized color target here would panic on the first frame. Exporting at an independent
/// resolution needs its own depth buffer sized to match, which is future work.
pub fn run_export(
    pipeline: &mut EntropyPipeline,
    request: &VideoExportRequest,
) -> Result<VideoExportResult, String> {
    let started = Instant::now();

    let gpu_resources = pipeline
        .gpu_resources
        .as_ref()
        .ok_or_else(|| "Couldn't get GPU resources".to_string())?
        .clone();

    // `pipeline.depth_view` (allocated once, at whatever size `EntropyApp::with_window_size`
    // passed into `initialize`, and resized in lockstep with the window - see the resize handler
    // around pipeline.rs:1880) is what every attachment here has to match. `pipeline.texture` is
    // a *different*, fixed-size texture (a leftover default project canvas, 1200x768, unrelated
    // to the window) - using it here was the first attempt, and wgpu's validation layer caught
    // the size mismatch immediately (panicked instead of silently corrupting frames) the first
    // time this ran. `camera.viewport.window_size` is kept in sync with the depth buffer's real
    // size instead, both at init and after resize, so it's the correct source of truth.
    let (render_width, render_height) = {
        let editor = pipeline.export_editor.as_ref().ok_or_else(|| "Couldn't get editor".to_string())?;
        let camera = editor.camera.as_ref().ok_or_else(|| "Couldn't get camera".to_string())?;
        (camera.viewport.window_size.width, camera.viewport.window_size.height)
    };

    let capture = FrameCaptureBuffer::new(&gpu_resources.device, render_width, render_height);
    let capture_view = capture.create_view();

    let mut video_encoder = VideoEncoder::new(&request.output_path, render_width, render_height, request.fps)
        .map_err(|e| format!("Couldn't open video encoder: {e:?}"))?;

    let total_frames = ((request.duration_ms as f64 / 1000.0) * request.fps as f64).ceil() as u32;
    let orbit_radius = 6.0_f32;

    for frame_index in 0..total_frames {
        let t = frame_index as f64 / request.fps as f64;

        {
            let editor = pipeline.export_editor.as_mut().ok_or_else(|| "Couldn't get editor".to_string())?;
            let camera = editor.camera.as_mut().ok_or_else(|| "Couldn't get camera".to_string())?;

            let angle = t as f32 * 0.5;
            camera.position = Point3::new(angle.cos() * orbit_radius, 3.0, angle.sin() * orbit_radius);
            camera.direction = (Point3::new(0.0, 0.0, 0.0) - camera.position).normalize();
            camera.update();

            let camera_binding = editor.camera_binding.as_mut().ok_or_else(|| "Couldn't get camera binding".to_string())?;
            camera_binding.update_3d(&gpu_resources.queue, camera);
        }

        pipeline.render_addon_frame(Some(&capture_view), t, None);

        let mut readback_encoder = gpu_resources.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Video Export Readback Encoder"),
        });
        capture.copy_to_staging(&mut readback_encoder);
        gpu_resources.queue.submit(Some(readback_encoder.finish()));

        let frame_bytes = pollster::block_on(capture.get_frame_data(&gpu_resources.device));

        video_encoder
            .write_frame(&frame_bytes)
            .map_err(|e| format!("Couldn't write frame {frame_index}: {e:?}"))?;
    }

    drop(video_encoder); // Finalize()/MFShutdown() run in VideoEncoder::drop

    Ok(VideoExportResult {
        output_path: request.output_path.clone(),
        frame_count: total_frames,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

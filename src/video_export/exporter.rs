// Drives an already-initialized, already-running `EntropyPipeline` through N offscreen frames
// and muxes them to an MP4 via `encode::VideoEncoder`. This replaced an earlier design here that
// re-initialized a whole second headless `EntropyPipeline` from a project id and called into
// `render_frame` (the pre-`render_addon_frame` legacy render path, see render_frame.rs's own
// "legacy code kept for reference only" note) - that path never actually rendered an addon's
// live scene, just a blank/legacy one. See the 2026-09-11 video export post's decision log for
// why capturing the live pipeline in place, rather than reconstructing one, won out.
//
// The first version of this file rendered and encoded every requested frame in one call,
// blocking `EntropyPipeline::render_display_frame` - and so the window and the addon's own JS
// `onUpdatePlus` - for the export's full duration. That's wrong for anything but a very short
// clip: a real export needs the app to stay responsive. This version instead exposes
// `start_export`/`step_export`, driving exactly one captured frame per real call to
// `render_display_frame` - see that function for how the state machine is threaded through.
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

/// Lives on `EntropyPipeline` (`pipeline.video_export`) across many `render_display_frame`
/// calls - one real frame advances this by exactly one captured frame. `encoder` is `Option`
/// only so `step_export` can `.take()` it to finalize (`VideoEncoder::drop` runs
/// `Finalize()`/`MFShutdown()`) without fighting the borrow checker over a partially-moved
/// struct.
pub struct VideoExportState {
    request: VideoExportRequest,
    capture: FrameCaptureBuffer,
    capture_view: wgpu::TextureView,
    encoder: Option<VideoEncoder>,
    frame_index: u32,
    total_frames: u32,
    started: Instant,
}

/// Sets up capture buffer + encoder for `request` against the pipeline's current scene. Doesn't
/// render anything yet - the first frame comes from the first `step_export` call.
///
/// The capture buffer is sized to the pipeline's *current* window size rather than an arbitrary
/// requested resolution: wgpu requires every attachment in a render pass to share one size, and
/// `pipeline.depth_view` is allocated once at window size - passing a differently sized color
/// target here would panic on the first frame. `pipeline.texture` looked like the obvious size
/// to match and isn't - it's a fixed 1200x768 leftover default project canvas, unrelated to the
/// window - which is how this was first written and how it panicked, immediately and loudly, the
/// first time it ran. `camera.viewport.window_size` is kept in sync with the depth buffer's real
/// size instead, both at init and after resize, so it's the correct source of truth. Exporting at
/// an independent resolution needs its own depth buffer sized to match, which is future work.
pub fn start_export(pipeline: &mut EntropyPipeline, request: VideoExportRequest) -> Result<VideoExportState, String> {
    let gpu_resources = pipeline
        .gpu_resources
        .as_ref()
        .ok_or_else(|| "Couldn't get GPU resources".to_string())?
        .clone();

    let (render_width, render_height) = {
        let editor = pipeline.export_editor.as_ref().ok_or_else(|| "Couldn't get editor".to_string())?;
        let camera = editor.camera.as_ref().ok_or_else(|| "Couldn't get camera".to_string())?;
        (camera.viewport.window_size.width, camera.viewport.window_size.height)
    };

    let capture = FrameCaptureBuffer::new(&gpu_resources.device, render_width, render_height);
    let capture_view = capture.create_view();

    let encoder = VideoEncoder::new(&request.output_path, render_width, render_height, request.fps)
        .map_err(|e| format!("Couldn't open video encoder: {e:?}"))?;

    let total_frames = ((request.duration_ms as f64 / 1000.0) * request.fps as f64).ceil() as u32;

    Ok(VideoExportState {
        request,
        capture,
        capture_view,
        encoder: Some(encoder),
        frame_index: 0,
        total_frames,
        started: Instant::now(),
    })
}

/// Renders, reads back, and encodes exactly one frame - one real call per one output frame, not
/// a loop. The camera orbit is computed here directly from `state.frame_index`/`fps` rather than
/// left to the addon's live per-tick callback: unlike the old blocking version, JS *does* still
/// tick once per real frame during an export now, but tying capture timing to however fast real
/// frames happen to arrive would make the output's frame pacing depend on this machine's frame
/// rate instead of the requested `fps` - the demo addon's own `onUpdatePlus` orbit formula is
/// kept in sync with this one for when nothing is exporting (see the addon source).
///
/// Returns `Some(result)` once `total_frames` have been written - the encoder is finalized as
/// part of that same call. The caller drops `state` when it sees `Some`.
pub fn step_export(pipeline: &mut EntropyPipeline, state: &mut VideoExportState) -> Result<Option<VideoExportResult>, String> {
    let gpu_resources = pipeline
        .gpu_resources
        .as_ref()
        .ok_or_else(|| "Couldn't get GPU resources".to_string())?
        .clone();

    let t = state.frame_index as f64 / state.request.fps as f64;
    let orbit_radius = 6.0_f32;

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

    pipeline.render_addon_frame(Some(&state.capture_view), t, None);

    let mut readback_encoder = gpu_resources.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Video Export Readback Encoder"),
    });
    state.capture.copy_to_staging(&mut readback_encoder);
    gpu_resources.queue.submit(Some(readback_encoder.finish()));

    let frame_bytes = pollster::block_on(state.capture.get_frame_data(&gpu_resources.device));

    state
        .encoder
        .as_mut()
        .expect("step_export called again after finishing")
        .write_frame(&frame_bytes)
        .map_err(|e| format!("Couldn't write frame {}: {e:?}", state.frame_index))?;

    state.frame_index += 1;

    if state.frame_index >= state.total_frames {
        drop(state.encoder.take()); // Finalize()/MFShutdown() run in VideoEncoder::drop
        Ok(Some(VideoExportResult {
            output_path: state.request.output_path.clone(),
            frame_count: state.total_frames,
            elapsed_ms: state.started.elapsed().as_millis() as u64,
        }))
    } else {
        Ok(None)
    }
}

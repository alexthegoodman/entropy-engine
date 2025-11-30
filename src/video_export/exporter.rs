use std::sync::Arc;

use tokio::sync::mpsc::{UnboundedSender};

use super::{encode::VideoEncoder, frame_buffer::FrameCaptureBuffer, pipeline::ExportPipeline};
use crate::{vector_animations::animations::Sequence, core::editor::WindowSize, helpers::timelines::SavedTimelineStateConfig};

// Progress message sent from export thread to UI
#[derive(Debug, Clone)]
pub enum ExportProgress {
    Progress(f32),
    Complete(String),
    Error(String),
}

pub struct Exporter {
    pub video_encoder: VideoEncoder,
}

impl Exporter {
    pub fn new(output_path: &str) -> Self {
        println!("Preparing video encoder...");
        let video_encoder = VideoEncoder::new(output_path).expect("Couldn't get video encoder");
        Exporter { video_encoder }
    }

    pub async fn run(
        &mut self,
        window_size: WindowSize,
        sequences: Vec<Sequence>,
        saved_timeline_state_config: SavedTimelineStateConfig,
        video_width: u32,
        video_height: u32,
        total_duration_s: f64,
        progress_tx: UnboundedSender<ExportProgress>,
        project_id: String,
    ) -> Result<Arc<u32>, String> {
        println!("Preparing wgpu pipeline...");
        let mut wgpu_pipeline = ExportPipeline::new();
        wgpu_pipeline
            .initialize(
                None,
                window_size,
                sequences,
                saved_timeline_state_config,
                video_width,
                video_height,
                project_id,
            )
            .await;

        println!("Preparing frame buffer...");
        let frame_buffer = FrameCaptureBuffer::new(
            &wgpu_pipeline
                .gpu_resources
                .as_ref()
                .expect("Couldn't get gpu resources")
                .device,
            video_width,
            video_height,
        );
        wgpu_pipeline.frame_buffer = Some(frame_buffer);

        // Calculate total frames based on sequence duration
        const FPS: f64 = 60.0;
        // let total_duration = sequences.iter()
        //     .map(|seq| seq.duration)
        //     .sum::<f64>();
        let total_frames = (total_duration_s * FPS).ceil() as u32;

        println!(
            "total_frames {:?}, total_duration_s: {:?}",
            total_frames, total_duration_s
        );

        // Frame loop
        for frame_index in 0..total_frames {
            // Calculate current time position
            let current_time = frame_index as f64 / FPS;

            // Render frame
            wgpu_pipeline.render_frame(None, current_time);

            // Get frame buffer and extract data
            let frame_buffer = wgpu_pipeline
                .frame_buffer
                .as_ref()
                .expect("Couldn't get frame buffer");

            let frame_bytes = frame_buffer
                .get_frame_data(
                    &wgpu_pipeline
                        .gpu_resources
                        .as_ref()
                        .expect("Couldn't get gpu resources")
                        .device,
                )
                .await;

            // Write frame to video
            self.video_encoder
                .write_frame(&frame_bytes)
                .expect("Couldn't write frame");

            // Send progress updates every 60 frames
            if frame_index % 60 == 0 {
                let progress = (frame_index as f32 / total_frames as f32) * 100.0;
                println!("export progress {:?}", progress);
                progress_tx.send(ExportProgress::Progress(progress)).ok();
            }
        }

        println!("Export finished!");

        Ok(Arc::new(total_frames))
    }
}

// RGBA8 frames -> H.264 (OpenH264) -> MP4 (`mp4` crate). The non-Windows counterpart of the Media
// Foundation sink writer in `video_export/encode.rs`, with the same shape: `new` with the output
// size and frame rate, `write_frame` per tightly-packed RGBA8 frame, finalized on drop.
use std::fs::File;
use std::io::BufWriter;

use bytes::Bytes;
use mp4::{AvcConfig, MediaConfig, Mp4Config, Mp4Sample, Mp4Writer, TrackConfig, TrackType};
use openh264::encoder::{
    BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, RateControlMode,
};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::{OpenH264API, Timestamp};

const NAL_SPS: u8 = 7;
const NAL_PPS: u8 = 8;
const NAL_AUD: u8 = 9;

pub struct Mp4VideoEncoder {
    output_path: String,
    encoder: Encoder,
    /// Created on the first encoded frame: the MP4 track's `avcC` needs the SPS/PPS, which only
    /// exist once OpenH264 has produced its first IDR.
    writer: Option<Mp4Writer<BufWriter<File>>>,
    file: Option<File>,
    /// Frame size handed to OpenH264. 4:2:0 needs even dimensions, so an odd source size drops
    /// its last column/row.
    width: u32,
    height: u32,
    source_width: u32,
    fps: u32,
    frame_count: u64,
    yuv: YUVBuffer,
    cropped: Vec<u8>,
    sample: Vec<u8>,
    finished: bool,
}

impl Mp4VideoEncoder {
    /// Same bitrate rule of thumb as the Media Foundation encoder (`w * h * fps / 8` bits/s) and a
    /// keyframe every two seconds so the result stays seekable.
    pub fn new(output_path: &str, width: u32, height: u32, fps: u32) -> Result<Self, String> {
        let fps = fps.max(1);
        let (even_width, even_height) = (width & !1, height & !1);
        if even_width == 0 || even_height == 0 {
            return Err(format!("Can't encode a {width}x{height} video"));
        }
        let bit_rate = (even_width as u64 * even_height as u64 * fps as u64 / 8).clamp(250_000, u32::MAX as u64) as u32;

        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(bit_rate))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            .rate_control_mode(RateControlMode::Bitrate)
            // Every rendered frame must land in the file; a skipped frame would shorten the video.
            .skip_frames(false)
            .intra_frame_period(IntraFramePeriod::from_num_frames(fps * 2));
        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
            .map_err(|e| format!("Couldn't create OpenH264 encoder: {e}"))?;

        // Create the file now so a bad path fails at `start_export`, like the MF sink writer does.
        let file = File::create(output_path).map_err(|e| format!("Couldn't create {output_path}: {e}"))?;

        Ok(Self {
            output_path: output_path.to_string(),
            encoder,
            writer: None,
            file: Some(file),
            width: even_width,
            height: even_height,
            source_width: width,
            fps,
            frame_count: 0,
            yuv: YUVBuffer::new(even_width as usize, even_height as usize),
            cropped: Vec::new(),
            sample: Vec::new(),
            finished: false,
        })
    }

    /// `frame_data` is tightly-packed RGBA8 at the size passed to `new`; alpha is ignored.
    pub fn write_frame(&mut self, frame_data: &[u8]) -> Result<(), String> {
        let (w, h) = (self.width as usize, self.height as usize);
        let source_stride = self.source_width as usize * 4;
        if frame_data.len() < source_stride * h {
            return Err(format!("Frame is {} bytes, expected at least {}", frame_data.len(), source_stride * h));
        }
        let rgba: &[u8] = if self.source_width == self.width {
            &frame_data[..w * h * 4]
        } else {
            self.cropped.clear();
            for row in frame_data.chunks_exact(source_stride).take(h) {
                self.cropped.extend_from_slice(&row[..w * 4]);
            }
            &self.cropped
        };
        self.yuv.read_rgba8(RgbaSliceU8::new(rgba, (w, h)));

        let timestamp_ms = self.frame_count * 1000 / self.fps as u64;
        let bitstream = self
            .encoder
            .encode_at(&self.yuv, Timestamp::from_millis(timestamp_ms))
            .map_err(|e| format!("H.264 encode failed on frame {}: {e}", self.frame_count))?;

        let is_sync = matches!(bitstream.frame_type(), FrameType::IDR | FrameType::I);
        let mut sps = None;
        let mut pps = None;
        self.sample.clear();
        for layer_index in 0..bitstream.num_layers() {
            let Some(layer) = bitstream.layer(layer_index) else { continue };
            for nal_index in 0..layer.nal_count() {
                let Some(nal) = layer.nal_unit(nal_index).map(strip_start_code) else { continue };
                let Some(&header) = nal.first() else { continue };
                match header & 0x1f {
                    // Parameter sets go in the `avcC` box (the `avc1` sample entry requires that),
                    // not in-band.
                    NAL_SPS => sps = Some(nal.to_vec()),
                    NAL_PPS => pps = Some(nal.to_vec()),
                    NAL_AUD => {}
                    _ => {
                        self.sample.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                        self.sample.extend_from_slice(nal);
                    }
                }
            }
        }

        if self.writer.is_none() {
            let (Some(sps), Some(pps)) = (sps, pps) else {
                return Err("OpenH264's first frame had no SPS/PPS".to_string());
            };
            self.writer = Some(self.start_writer(sps, pps)?);
        }

        // Timescale is `fps * 1000` ticks/s, so every frame lasts exactly 1000 ticks.
        let sample = Mp4Sample {
            start_time: self.frame_count * 1000,
            duration: 1000,
            rendering_offset: 0,
            is_sync,
            bytes: Bytes::copy_from_slice(&self.sample),
        };
        self.writer
            .as_mut()
            .expect("writer started above")
            .write_sample(1, &sample)
            .map_err(|e| format!("Couldn't write frame {} to {}: {e}", self.frame_count, self.output_path))?;

        self.frame_count += 1;
        Ok(())
    }

    fn start_writer(&mut self, sps: Vec<u8>, pps: Vec<u8>) -> Result<Mp4Writer<BufWriter<File>>, String> {
        let file = self.file.take().ok_or("output file already consumed")?;
        let config = Mp4Config {
            major_brand: str::parse("isom").expect("valid fourcc"),
            minor_version: 512,
            compatible_brands: ["isom", "iso2", "avc1", "mp41"]
                .iter()
                .map(|brand| str::parse(brand).expect("valid fourcc"))
                .collect(),
            timescale: 1000,
        };
        let mut writer = Mp4Writer::write_start(BufWriter::new(file), &config)
            .map_err(|e| format!("Couldn't start MP4 {}: {e}", self.output_path))?;
        writer
            .add_track(&TrackConfig {
                track_type: TrackType::Video,
                timescale: self.fps * 1000,
                language: "und".to_string(),
                media_conf: MediaConfig::AvcConfig(AvcConfig {
                    width: self.width as u16,
                    height: self.height as u16,
                    seq_param_set: sps,
                    pic_param_set: pps,
                }),
            })
            .map_err(|e| format!("Couldn't add video track to {}: {e}", self.output_path))?;
        Ok(writer)
    }

    /// Writes the MP4 index (`moov`). Called by `Drop` if not called explicitly.
    pub fn finish(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        let Some(mut writer) = self.writer.take() else {
            return Err(format!("No frames were written to {}", self.output_path));
        };
        writer.write_end().map_err(|e| format!("Couldn't finalize {}: {e}", self.output_path))?;
        use std::io::Write;
        writer
            .into_writer()
            .flush()
            .map_err(|e| format!("Couldn't flush {}: {e}", self.output_path))
    }
}

impl Drop for Mp4VideoEncoder {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            println!("[video_export] {error}");
        }
    }
}

fn strip_start_code(nal: &[u8]) -> &[u8] {
    let zeros = nal.iter().take_while(|&&b| b == 0).count();
    if zeros >= 2 && nal.get(zeros) == Some(&1) { &nal[zeros + 1..] } else { nal }
}

// MP4 (H.264) -> RGBA8 frames, via the `mp4` crate demuxer and the OpenH264 decoder. Mirrors what
// the Media Foundation source reader gives the Windows code: sequential `next_frame` reads in
// presentation order, each with its timestamp, plus a keyframe-accurate `seek`.
use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use mp4::{MediaType, Mp4Reader, TrackType};
use openh264::decoder::{DecodeOptions, DecodedYUV, Decoder, DecoderConfig, Flush};
use openh264::formats::YUVSource;
use openh264::OpenH264API;

const START_CODE: [u8; 4] = [0, 0, 0, 1];

#[derive(Debug, Clone, Copy)]
pub struct VideoInfo {
    pub duration_ms: i64,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
}

pub struct Mp4VideoDecoder {
    reader: Mp4Reader<BufReader<File>>,
    track_id: u32,
    timescale: u32,
    /// Presentation time of every sample (index = sample id - 1), in track timescale ticks,
    /// already shifted so the first displayed frame is at 0 (see `open`).
    sample_pts: Vec<i64>,
    /// 1-based sample ids that start a GOP (IDR). Empty means every sample is a sync sample.
    sync_samples: Vec<u32>,
    /// Byte width of each NAL length prefix in the samples (`avcC` lengthSizeMinusOne + 1).
    nal_length_size: usize,
    /// Every SPS/PPS from `avcC`, Annex B framed; fed ahead of each keyframe so decoding can
    /// (re)start at any sync sample.
    parameter_sets: Vec<u8>,
    decoder: Decoder,
    next_sample: u32,
    /// Timestamps of samples fed to the decoder whose pictures haven't come out yet. OpenH264
    /// emits pictures in display order, so the earliest pending timestamp belongs to whichever
    /// picture comes out next - this is what keeps B-frame streams correctly timed.
    pending_pts: BinaryHeap<Reverse<i64>>,
    /// After a seek, pictures ending before this tick are decoded (they're reference frames for
    /// what follows) but not returned.
    discard_before: Option<i64>,
    /// How many more pictures `discard_before` may still drop; `None` = unlimited (seeking).
    skip_budget: Option<u32>,
    flushed: bool,
    /// Pictures drained from the decoder at end of stream, waiting to be handed out.
    drained: VecDeque<(i64, Vec<u8>)>,
    annex_b: Vec<u8>,
    info: VideoInfo,
}

impl Mp4VideoDecoder {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        let file = File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let reader = Mp4Reader::read_header(BufReader::new(file), size)
            .map_err(|e| format!("Couldn't read MP4 container {}: {e}", path.display()))?;

        let track = reader
            .tracks()
            .values()
            .filter(|t| matches!(t.track_type(), Ok(TrackType::Video)))
            .min_by_key(|t| t.track_id())
            .ok_or_else(|| format!("{} has no video track", path.display()))?;

        match track.media_type() {
            Ok(MediaType::H264) => {}
            Ok(other) => {
                return Err(format!(
                    "{}: video codec {other} isn't supported (only H.264 is, via OpenH264)",
                    path.display()
                ))
            }
            Err(e) => return Err(format!("{}: unsupported video track: {e}", path.display())),
        }

        let track_id = track.track_id();
        let timescale = track.timescale().max(1);
        let stbl = &track.trak.mdia.minf.stbl;
        let avc1 = stbl.stsd.avc1.as_ref().ok_or_else(|| format!("{}: missing avc1 sample entry", path.display()))?;

        let mut parameter_sets = Vec::new();
        for nal in avc1.avcc.sequence_parameter_sets.iter().chain(avc1.avcc.picture_parameter_sets.iter()) {
            parameter_sets.extend_from_slice(&START_CODE);
            parameter_sets.extend_from_slice(&nal.bytes);
        }
        let nal_length_size = (avc1.avcc.length_size_minus_one & 0x3) as usize + 1;

        // Presentation times: decode times from stts plus composition offsets from ctts. Streams
        // with B-frames usually start with a positive composition offset (the reorder delay,
        // which an edit list would normally cancel out); normalize so the first frame is at 0.
        let sample_count = track.sample_count() as usize;
        let mut sample_pts = Vec::with_capacity(sample_count);
        let mut dts: i64 = 0;
        for entry in &stbl.stts.entries {
            for _ in 0..entry.sample_count {
                sample_pts.push(dts);
                dts += entry.sample_delta as i64;
            }
        }
        sample_pts.resize(sample_count, dts);
        if let Some(ctts) = &stbl.ctts {
            let mut index = 0usize;
            'entries: for entry in &ctts.entries {
                for _ in 0..entry.sample_count {
                    let Some(pts) = sample_pts.get_mut(index) else { break 'entries };
                    *pts += entry.sample_offset as i64;
                    index += 1;
                }
            }
        }
        let origin = sample_pts.iter().copied().min().unwrap_or(0);
        for pts in &mut sample_pts {
            *pts -= origin;
        }

        let sync_samples = stbl.stss.as_ref().map(|stss| stss.entries.clone()).unwrap_or_default();

        let track_duration = track.trak.mdia.mdhd.duration as i64;
        let duration_ticks = if track_duration > 0 { track_duration } else { dts };
        let duration_ms = duration_ticks * 1000 / timescale as i64;
        let frame_rate = if duration_ticks > 0 && sample_count > 0 {
            sample_count as f64 * timescale as f64 / duration_ticks as f64
        } else {
            30.0
        };

        let info = VideoInfo {
            duration_ms,
            width: avc1.width as u32,
            height: avc1.height as u32,
            frame_rate,
        };
        if info.width == 0 || info.height == 0 {
            return Err(format!("{}: video track reports a zero frame size", path.display()));
        }

        Ok(Self {
            reader,
            track_id,
            timescale,
            sample_pts,
            sync_samples,
            nal_length_size,
            parameter_sets,
            decoder: new_decoder()?,
            next_sample: 1,
            pending_pts: BinaryHeap::new(),
            discard_before: None,
            skip_budget: None,
            flushed: false,
            drained: VecDeque::new(),
            annex_b: Vec::new(),
            info,
        })
    }

    pub fn info(&self) -> VideoInfo {
        self.info
    }

    /// Decodes the next picture in presentation order into `rgba` (resized to `width * height *
    /// 4`), returning its presentation time in milliseconds, or `None` at end of stream.
    pub fn next_frame(&mut self, rgba: &mut Vec<u8>) -> Result<Option<f64>, String> {
        loop {
            if let Some((pts, picture)) = self.drained.pop_front() {
                *rgba = picture;
                return Ok(Some(self.ticks_to_ms(pts)));
            }

            if self.next_sample as usize > self.sample_pts.len() {
                // Out of samples: drain whatever the decoder is still holding for reordering.
                if self.flushed {
                    return Ok(None);
                }
                self.flushed = true;
                let (width, height) = (self.info.width, self.info.height);
                let frames = self.decoder.flush_remaining().map_err(|e| format!("H.264 flush failed: {e}"))?;
                for yuv in frames {
                    let Some(Reverse(pts)) = self.pending_pts.pop() else { break };
                    if self.discard_before.map_or(true, |min| pts >= min) {
                        let mut picture = Vec::new();
                        write_rgba(&yuv, width, height, &mut picture);
                        self.drained.push_back((pts, picture));
                    }
                }
                self.pending_pts.clear();
                continue;
            }

            let sample_id = self.next_sample;
            self.next_sample += 1;
            let sample = self
                .reader
                .read_sample(self.track_id, sample_id)
                .map_err(|e| format!("Couldn't read video sample {sample_id}: {e}"))?;
            let Some(sample) = sample else { continue };

            self.annex_b.clear();
            if sample.is_sync {
                self.annex_b.extend_from_slice(&self.parameter_sets);
            }
            avcc_to_annex_b(&sample.bytes, self.nal_length_size, &mut self.annex_b);
            self.pending_pts.push(Reverse(self.sample_pts[sample_id as usize - 1]));

            let decoded = match self
                .decoder
                .decode_with_options(&self.annex_b, DecodeOptions::new().flush_after_decode(Flush::NoFlush))
            {
                Ok(decoded) => decoded,
                // A damaged sample shouldn't end playback; OpenH264 conceals and carries on with
                // the next one.
                Err(e) => {
                    tracing::debug!("[openh264] decode error on sample {sample_id}: {e}");
                    None
                }
            };
            if let Some(yuv) = decoded {
                let Some(Reverse(pts)) = self.pending_pts.pop() else { continue };
                if self.discard_before.is_some_and(|min| pts < min) {
                    match &mut self.skip_budget {
                        None => continue,
                        Some(budget) if *budget > 0 => {
                            *budget -= 1;
                            continue;
                        }
                        Some(_) => {} // out of budget: show this one after all
                    }
                }
                self.discard_before = None;
                self.skip_budget = None;
                write_rgba(&yuv, self.info.width, self.info.height, rgba);
                return Ok(Some(self.ticks_to_ms(pts)));
            }
        }
    }

    /// Like `next_frame`, for a player that has fallen behind: pictures whose presentation time is
    /// before `min_ms` are still decoded (later frames reference them) but never converted to
    /// RGBA or returned, so catching up only pays for the one picture actually shown. At most
    /// `max_skipped` pictures are dropped per call, so a long hitch can't stall the caller.
    pub fn next_frame_catching_up(&mut self, min_ms: f64, max_skipped: u32, rgba: &mut Vec<u8>) -> Result<Option<f64>, String> {
        let min_ticks = (min_ms * self.timescale as f64 / 1000.0).floor() as i64;
        // A pending seek must reach its target however far it is from the keyframe, so it keeps
        // its unlimited budget; only plain catch-up is bounded.
        let seeking = self.discard_before.is_some() && self.skip_budget.is_none();
        if self.discard_before.map_or(true, |current| current < min_ticks) {
            self.discard_before = Some(min_ticks);
            if !seeking {
                self.skip_budget = Some(max_skipped);
            }
        }
        let result = self.next_frame(rgba);
        self.discard_before = None;
        self.skip_budget = None;
        result
    }

    /// Repositions to `ms`: restarts decoding at the last keyframe at or before it, then the next
    /// `next_frame` skips ahead to the picture showing at `ms`.
    pub fn seek(&mut self, ms: i64) -> Result<(), String> {
        let target = ms.max(0) * self.timescale as i64 / 1000;
        let mut start = 1u32;
        if self.sync_samples.is_empty() {
            // All-intra stream: start at the last sample shown at or before the target.
            for (index, &pts) in self.sample_pts.iter().enumerate() {
                if pts <= target {
                    start = start.max(index as u32 + 1);
                }
            }
        } else {
            for &sync in &self.sync_samples {
                match self.sample_pts.get(sync as usize - 1) {
                    Some(&pts) if pts <= target => start = start.max(sync),
                    _ => {}
                }
            }
        }

        self.decoder = new_decoder()?;
        self.skip_budget = None;
        self.pending_pts.clear();
        self.flushed = false;
        self.drained.clear();
        self.next_sample = start;
        let frame_ticks = (self.timescale as f64 / self.info.frame_rate.max(1.0)).round() as i64;
        // Keep the picture that's on screen at `target`: the one whose display interval covers it.
        self.discard_before = Some(target - frame_ticks.max(1) + 1);
        Ok(())
    }

    fn ticks_to_ms(&self, ticks: i64) -> f64 {
        ticks as f64 * 1000.0 / self.timescale as f64
    }
}

fn new_decoder() -> Result<Decoder, String> {
    // NoFlush: pictures come out once the decoder's reorder window allows, i.e. in display order
    // even for B-frame (Main/High profile) streams. The per-call default would force a picture
    // out after every packet, which returns B-frame streams in decode order.
    Decoder::with_api_config(OpenH264API::from_source(), DecoderConfig::new().flush_after_decode(Flush::NoFlush))
        .map_err(|e| format!("Couldn't create OpenH264 decoder: {e}"))
}

/// MP4 stores NAL units length-prefixed (AVCC); OpenH264 wants start-code framing (Annex B).
fn avcc_to_annex_b(mut data: &[u8], length_size: usize, out: &mut Vec<u8>) {
    while data.len() >= length_size {
        let len = data[..length_size].iter().fold(0usize, |acc, &b| (acc << 8) | b as usize);
        data = &data[length_size..];
        let len = len.min(data.len());
        out.extend_from_slice(&START_CODE);
        out.extend_from_slice(&data[..len]);
        data = &data[len..];
    }
}

/// Converts a decoded picture to tightly-packed RGBA8 at exactly `width` x `height` (the size the
/// container advertised, which callers size their textures to). Pictures are normally exactly
/// that size; if the stream disagrees, the overlap is copied and the rest left black.
fn write_rgba(yuv: &DecodedYUV<'_>, width: u32, height: u32, rgba: &mut Vec<u8>) {
    let (w, h) = (width as usize, height as usize);
    rgba.resize(w * h * 4, 0);
    let (dw, dh) = yuv.dimensions();
    if (dw, dh) == (w, h) {
        yuv.write_rgba8(rgba);
        return;
    }
    let mut full = vec![0u8; dw * dh * 4];
    yuv.write_rgba8(&mut full);
    rgba.fill(0);
    let copy = w.min(dw) * 4;
    for (y, row) in rgba.chunks_exact_mut(w * 4).enumerate() {
        if y < dh {
            row[..copy].copy_from_slice(&full[y * dw * 4..y * dw * 4 + copy]);
        }
        for px in row.chunks_exact_mut(4) {
            px[3] = 255;
        }
    }
}

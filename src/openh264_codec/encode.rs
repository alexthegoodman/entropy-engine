// RGBA8 frames -> H.264 (OpenH264) -> MP4 (`mp4` crate). The non-Windows counterpart of the Media
// Foundation sink writer in `video_export/encode.rs`, with the same shape: `new` with the output
// size and frame rate, `write_frame` per tightly-packed RGBA8 frame, finalized on drop.
//
// `with_audio` adds an AAC-LC track (fdk-aac) fed through `write_audio`, for the music-video
// export (`crate::music_video`); `new` stays video-only, as the scene exporter wants.
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufWriter;

use bytes::Bytes;
use fdk_aac::enc::{AudioObjectType as FdkObjectType, BitRate as FdkBitRate, ChannelMode, Encoder as AacEncoder, EncoderParams, Transport};
use mp4::{AacConfig, AudioObjectType, AvcConfig, ChannelConfig, MediaConfig, Mp4Config, Mp4Sample, Mp4Writer, SampleFreqIndex, TrackConfig, TrackType};
use openh264::encoder::{
    BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, RateControlMode,
};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::{OpenH264API, Timestamp};

const NAL_SPS: u8 = 7;
const NAL_PPS: u8 = 8;
const NAL_AUD: u8 = 9;
const VIDEO_TRACK: u32 = 1;
const AUDIO_TRACK: u32 = 2;

/// The audio track `Mp4VideoEncoder::with_audio` adds.
#[derive(Clone, Copy, Debug)]
pub struct AacAudioConfig {
    pub sample_rate: u32,
    /// 1 or 2.
    pub channels: u16,
}

/// AAC-LC via fdk-aac, raw access units (no ADTS headers: the MP4 `esds` box carries the config).
struct AacTrack {
    encoder: AacEncoder,
    sample_rate: u32,
    channels: u16,
    bit_rate: u32,
    /// Samples per channel per access unit (1024 for AAC-LC).
    frame_len: u32,
    /// Priming samples the encoder puts before the audio (see `audio_delay_samples`).
    delay: u32,
    /// Interleaved PCM not yet handed to the encoder (always less than one access unit).
    pcm: Vec<i16>,
    out: Vec<u8>,
    /// Encoded access units waiting for the MP4 writer, which only exists after the first video
    /// frame (its `avcC` needs OpenH264's SPS/PPS).
    queued: VecDeque<Vec<u8>>,
    units_encoded: u64,
    units_written: u64,
    samples_in: u64,
}

impl AacTrack {
    fn new(config: AacAudioConfig) -> Result<Self, String> {
        let channels = config.channels.clamp(1, 2);
        if freq_index(config.sample_rate).is_none() {
            return Err(format!("AAC can't encode {} Hz audio", config.sample_rate));
        }
        let bit_rate = if channels == 2 { 192_000 } else { 128_000 };
        let encoder = AacEncoder::new(EncoderParams {
            bit_rate: FdkBitRate::Cbr(bit_rate),
            sample_rate: config.sample_rate,
            transport: Transport::Raw,
            channels: if channels == 2 { ChannelMode::Stereo } else { ChannelMode::Mono },
            audio_object_type: FdkObjectType::Mpeg4LowComplexity,
        })
        .map_err(|e| format!("Couldn't create AAC encoder: {e}"))?;
        let info = encoder.info().map_err(|e| format!("Couldn't query AAC encoder: {e}"))?;
        Ok(Self {
            encoder,
            sample_rate: config.sample_rate,
            channels,
            bit_rate,
            frame_len: info.frameLength.max(1),
            delay: info.nDelay,
            pcm: Vec::new(),
            out: vec![0; (info.maxOutBufBytes as usize).max(8192)],
            queued: VecDeque::new(),
            units_encoded: 0,
            units_written: 0,
            samples_in: 0,
        })
    }

    fn track_config(&self) -> TrackConfig {
        TrackConfig {
            track_type: TrackType::Audio,
            timescale: self.sample_rate,
            language: "und".to_string(),
            media_conf: MediaConfig::AacConfig(AacConfig {
                bitrate: self.bit_rate,
                profile: AudioObjectType::AacLowComplexity,
                freq_index: freq_index(self.sample_rate).expect("checked in new"),
                chan_conf: if self.channels == 2 { ChannelConfig::Stereo } else { ChannelConfig::Mono },
            }),
        }
    }

    /// Queues interleaved samples and encodes every whole access unit they complete.
    fn push(&mut self, interleaved: &[f32]) -> Result<(), String> {
        self.samples_in += (interleaved.len() / self.channels as usize) as u64;
        self.pcm.extend(interleaved.iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0).round() as i16));
        let unit = self.frame_len as usize * self.channels as usize;
        let whole = self.pcm.len() / unit * unit;
        if whole > 0 {
            let pcm = std::mem::take(&mut self.pcm);
            self.encode(&pcm[..whole])?;
            self.pcm = pcm[whole..].to_vec();
        }
        Ok(())
    }

    fn encode(&mut self, mut input: &[i16]) -> Result<(), String> {
        while !input.is_empty() {
            let result = self.encoder.encode(input, &mut self.out).map_err(|e| format!("AAC encode failed: {e}"))?;
            if result.output_size > 0 {
                self.queued.push_back(self.out[..result.output_size].to_vec());
                self.units_encoded += 1;
            }
            if result.input_consumed == 0 && result.output_size == 0 {
                break;
            }
            input = &input[result.input_consumed.min(input.len())..];
        }
        Ok(())
    }

    /// Pads with silence until every real sample (plus the encoder's priming delay) has come out
    /// the other end. fdk-aac's own end-of-stream flush isn't reachable through the crate.
    fn flush(&mut self) -> Result<(), String> {
        let needed = (self.samples_in + self.delay as u64).div_ceil(self.frame_len as u64);
        let unit = self.frame_len as usize * self.channels as usize;
        if !self.pcm.is_empty() {
            let mut pad = std::mem::take(&mut self.pcm);
            pad.resize(unit, 0);
            self.encode(&pad)?;
        }
        let silence = vec![0i16; unit];
        let mut guard = 0;
        while self.units_encoded < needed && guard < 64 {
            self.encode(&silence)?;
            guard += 1;
        }
        Ok(())
    }
}

fn freq_index(sample_rate: u32) -> Option<SampleFreqIndex> {
    (0u8..=0xc).filter_map(|i| SampleFreqIndex::try_from(i).ok()).find(|f| f.freq() == sample_rate)
}

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
    audio: Option<AacTrack>,
    finished: bool,
}

impl Mp4VideoEncoder {
    /// Same bitrate rule of thumb as the Media Foundation encoder (`w * h * fps / 8` bits/s) and a
    /// keyframe every two seconds so the result stays seekable.
    pub fn new(output_path: &str, width: u32, height: u32, fps: u32) -> Result<Self, String> {
        Self::with_audio(output_path, width, height, fps, None)
    }

    /// Like `new`, plus an AAC track fed by `write_audio` when `audio` is set.
    pub fn with_audio(output_path: &str, width: u32, height: u32, fps: u32, audio: Option<AacAudioConfig>) -> Result<Self, String> {
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
        let audio = audio.map(AacTrack::new).transpose()?;

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
            audio,
            finished: false,
        })
    }

    /// Samples of silence the AAC encoder puts before the first real sample. Players that ignore
    /// edit lists (and this muxer writes none) play the audio that much late, so the music-video
    /// export shifts its visuals by the same amount instead. 0 without an audio track.
    pub fn audio_delay_samples(&self) -> u32 {
        self.audio.as_ref().map_or(0, |a| a.delay)
    }

    /// Interleaved f32 samples at the `AacAudioConfig` rate and channel count. Call it as the
    /// video goes (it interleaves better) or all at once; either way it's finalized by `finish`.
    pub fn write_audio(&mut self, interleaved: &[f32]) -> Result<(), String> {
        let Some(audio) = self.audio.as_mut() else {
            return Err("This encoder was created without an audio track".to_string());
        };
        audio.push(interleaved)?;
        self.drain_audio()
    }

    /// Writes queued AAC access units once the MP4 writer exists.
    fn drain_audio(&mut self) -> Result<(), String> {
        let (Some(writer), Some(audio)) = (self.writer.as_mut(), self.audio.as_mut()) else {
            return Ok(());
        };
        while let Some(unit) = audio.queued.pop_front() {
            let sample = Mp4Sample {
                start_time: audio.units_written * audio.frame_len as u64,
                duration: audio.frame_len,
                rendering_offset: 0,
                is_sync: true,
                bytes: Bytes::from(unit),
            };
            writer
                .write_sample(AUDIO_TRACK, &sample)
                .map_err(|e| format!("Couldn't write audio to {}: {e}", self.output_path))?;
            audio.units_written += 1;
        }
        Ok(())
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
            .write_sample(VIDEO_TRACK, &sample)
            .map_err(|e| format!("Couldn't write frame {} to {}: {e}", self.frame_count, self.output_path))?;

        self.frame_count += 1;
        self.drain_audio()
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
        if let Some(audio) = &self.audio {
            writer
                .add_track(&audio.track_config())
                .map_err(|e| format!("Couldn't add audio track to {}: {e}", self.output_path))?;
        }
        Ok(writer)
    }

    /// Writes the MP4 index (`moov`). Called by `Drop` if not called explicitly.
    pub fn finish(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        if self.writer.is_some() {
            if let Some(audio) = self.audio.as_mut() {
                audio.flush()?;
            }
            self.drain_audio()?;
        }
        let Some(mut writer) = self.writer.take() else {
            return Err(format!("No frames were written to {}", self.output_path));
        };
        writer.write_end().map_err(|e| format!("Couldn't finalize {}: {e}", self.output_path))?;
        use std::io::Write;
        writer
            .into_writer()
            .flush()
            .map_err(|e| format!("Couldn't flush {}: {e}", self.output_path))?;
        if self.audio.is_some() {
            fix_sl_config(&self.output_path)?;
        }
        Ok(())
    }
}

impl Drop for Mp4VideoEncoder {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            println!("[video_export] {error}");
        }
    }
}

/// The `mp4` crate writes the AAC `esds` box's SLConfigDescriptor with `predefined = 0` and no
/// custom fields (and a zero length), which ISO 14496-14 forbids (MP4 files use 2). ffmpeg shrugs
/// that off; symphonia (the engine's own Linux audio decoder) and stricter players refuse the
/// track. The descriptor is the last three bytes of the box, so this finds `esds` in the `moov` at
/// the end of the file and patches it in place.
fn fix_sl_config(path: &str) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let err = |e: std::io::Error| format!("Couldn't patch {path}: {e}");
    let mut file = std::fs::OpenOptions::new().read(true).write(true).open(path).map_err(err)?;
    let len = file.metadata().map_err(err)?.len();
    // Walk the top-level boxes to the `moov`.
    let mut pos = 0u64;
    let (moov_start, moov_len) = loop {
        if pos + 8 > len {
            return Err(format!("{path} has no moov box"));
        }
        let mut header = [0u8; 16];
        file.seek(SeekFrom::Start(pos)).map_err(err)?;
        file.read_exact(&mut header[..8]).map_err(err)?;
        let mut size = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        let mut header_len = 8;
        if size == 1 {
            file.read_exact(&mut header[8..16]).map_err(err)?;
            size = u64::from_be_bytes(header[8..16].try_into().unwrap());
            header_len = 16;
        } else if size == 0 {
            size = len - pos;
        }
        if &header[4..8] == b"moov" {
            break (pos, size);
        }
        if size < header_len {
            return Err(format!("{path} has a malformed box at {pos}"));
        }
        pos += size;
    };
    let mut moov = vec![0u8; moov_len as usize];
    file.seek(SeekFrom::Start(moov_start)).map_err(err)?;
    file.read_exact(&mut moov).map_err(err)?;
    let mut search = 4;
    while let Some(found) = moov[search..].windows(4).position(|w| w == b"esds") {
        let at = search + found;
        let size = u32::from_be_bytes(moov[at - 4..at].try_into().unwrap()) as usize;
        let end = at - 4 + size;
        // Written as `06 00 00` (a zero length, then the byte it should have covered); patch it
        // to `06 01 02`. `06 01 00` (a crate that gets the length right) needs only the value.
        if end <= moov.len() && size >= 11 && moov[end - 3] == 0x06 && moov[end - 2] <= 0x01 && moov[end - 1] == 0x00 {
            file.seek(SeekFrom::Start(moov_start + end as u64 - 2)).map_err(err)?;
            file.write_all(&[0x01, 0x02]).map_err(err)?;
        }
        search = at + 4;
    }
    file.flush().map_err(err)
}

fn strip_start_code(nal: &[u8]) -> &[u8] {
    let zeros = nal.iter().take_while(|&&b| b == 0).count();
    if zeros >= 2 && nal.get(zeros) == Some(&1) { &nal[zeros + 1..] } else { nal }
}

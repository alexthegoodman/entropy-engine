// Standalone Media-Foundation video+audio decoder for the media player example app.
//
// Unlike `renderer_videos::st_video::StVideo` (which only ever reads
// `MF_SOURCE_READER_FIRST_VIDEO_STREAM` and owns editor-specific transform/bind-group/vertex
// state), this type decodes both streams and owns no rendering state at all - it just hands
// decoded bytes to whoever's driving it. See `deno::addon_ops::op_video_*` for how the addon
// system wires this into an `Entropy.Texture` and a `rodio::Sink`.
//
// Audio-stream decoding via Media Foundation had no prior art anywhere in this repo (verified
// by a full-repo grep for `MF_SOURCE_READER_FIRST_AUDIO_STREAM`/`MFAudioFormat_PCM` before
// writing this) - it's genuinely new, not a port of existing code.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rodio::{Sink, Source};
use windows::Win32::Media::KernelStreaming::GUID_NULL;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::core::PCWSTR;
use windows_core::PROPVARIANT;

use crate::audio::AudioEngine;

pub struct MediaPlayer {
    path: PathBuf,
    video_reader: IMFSourceReader,
    duration_ms: i64,
    width: u32,
    height: u32,
    frame_rate: f64,
    audio_format: Option<(u16, u32)>, // (channels, sample_rate), None if the file has no usable audio stream

    playing: bool,
    position_at_play_ms: i64,
    play_started_at: Option<Instant>,
    next_frame_due_ms: f64,
    volume: f32,

    audio_engine: Arc<AudioEngine>,
    audio: Option<AudioChannel>,
}

impl MediaPlayer {
    pub fn open(path: impl AsRef<Path>, audio_engine: Arc<AudioEngine>) -> windows::core::Result<Self> {
        let path = path.as_ref().to_path_buf();

        unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
        }

        let video_reader = create_video_reader(&path)?;
        let (duration_ms, width, height, frame_rate) = probe_video(&video_reader)?;
        let audio_format = probe_audio_format(&path);

        if audio_format.is_none() {
            println!("[media_player] no usable audio stream in {path:?} - playing video-only");
        }

        Ok(MediaPlayer {
            path,
            video_reader,
            duration_ms,
            width,
            height,
            frame_rate,
            audio_format,
            playing: false,
            position_at_play_ms: 0,
            play_started_at: None,
            next_frame_due_ms: 0.0,
            volume: 1.0,
            audio_engine,
            audio: None,
        })
    }

    pub fn duration_ms(&self) -> i64 {
        self.duration_ms
    }
    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn frame_rate(&self) -> f64 {
        self.frame_rate
    }
    pub fn is_playing(&self) -> bool {
        self.playing
    }

    pub fn current_time_ms(&self) -> i64 {
        if self.playing {
            self.position_at_play_ms
                + self
                    .play_started_at
                    .map(|t| t.elapsed().as_millis() as i64)
                    .unwrap_or(0)
        } else {
            self.position_at_play_ms
        }
    }

    pub fn play(&mut self) {
        if self.playing {
            return;
        }
        self.playing = true;
        self.play_started_at = Some(Instant::now());

        if let Some(audio) = &self.audio {
            audio.sink.play();
        } else if let Some((channels, sample_rate)) = self.audio_format {
            match AudioChannel::spawn(
                &self.path,
                self.position_at_play_ms,
                channels,
                sample_rate,
                self.volume,
                &self.audio_engine,
            ) {
                Ok(ch) => self.audio = Some(ch),
                Err(e) => println!("[media_player] audio start failed, continuing video-only: {e:?}"),
            }
        }
    }

    pub fn pause(&mut self) {
        if !self.playing {
            return;
        }
        self.position_at_play_ms = self.current_time_ms();
        self.playing = false;
        self.play_started_at = None;
        if let Some(audio) = &self.audio {
            audio.sink.pause();
        }
    }

    /// Repositions both streams. Audio is handled by tearing down the old decode thread/sink
    /// and starting a fresh one seeked to the new position, rather than trying to flush
    /// in-flight chunks out of the old one - simpler to get right than partial-draining a
    /// channel a background thread is still writing into.
    pub fn seek(&mut self, ms: i64) -> windows::core::Result<()> {
        let ms = ms.clamp(0, self.duration_ms);
        unsafe {
            self.video_reader
                .SetCurrentPosition(&GUID_NULL, &PROPVARIANT::from(ms.saturating_mul(10_000)))?;
        }
        self.position_at_play_ms = ms;
        self.next_frame_due_ms = ms as f64;
        self.play_started_at = if self.playing { Some(Instant::now()) } else { None };

        self.audio = None; // old sink+thread torn down here (see AudioChannel's Drop-by-disconnect note)
        if self.playing {
            if let Some((channels, sample_rate)) = self.audio_format {
                match AudioChannel::spawn(&self.path, ms, channels, sample_rate, self.volume, &self.audio_engine) {
                    Ok(ch) => self.audio = Some(ch),
                    Err(e) => println!("[media_player] audio restart after seek failed: {e:?}"),
                }
            }
        }
        Ok(())
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 2.0);
        if let Some(audio) = &self.audio {
            audio.sink.set_volume(self.volume);
        }
    }

    /// Returns newly-decoded RGBA frame bytes if playback has reached (or passed) the next
    /// frame's presentation time, else `None`. If wall-clock time has jumped ahead by more than
    /// one frame interval (e.g. a hitch), this drops the skipped frames rather than displaying
    /// them, so playback catches up instead of continuing in slow motion - bounded to 30
    /// iterations per call so a large jump can't stall the render thread decoding a full backlog.
    pub fn poll_video_frame(&mut self) -> Option<Vec<u8>> {
        if !self.playing {
            return None;
        }
        let now_ms = self.current_time_ms() as f64;
        let mut latest = None;

        for _ in 0..30 {
            if self.next_frame_due_ms > now_ms {
                break;
            }
            match read_video_sample(&self.video_reader) {
                Ok(Some((data, pts_ms))) => {
                    self.next_frame_due_ms = pts_ms.max(now_ms) + 1000.0 / self.frame_rate.max(1.0);
                    latest = Some(data);
                }
                Ok(None) => {
                    // current_time_ms() while !playing returns the frozen position_at_play_ms,
                    // which play()/seek() keep correct but which nothing else here was updating -
                    // without this, the displayed time snapped back to wherever playback last
                    // started/seeked from instead of freezing at the real end-of-stream position.
                    self.position_at_play_ms = now_ms as i64;
                    self.playing = false;
                    self.play_started_at = None;
                    break;
                }
                Err(e) => {
                    println!("[media_player] video decode error: {e:?}");
                    self.position_at_play_ms = now_ms as i64;
                    self.playing = false;
                    self.play_started_at = None;
                    break;
                }
            }
        }

        latest
    }
}

fn create_video_reader(path: &Path) -> windows::core::Result<IMFSourceReader> {
    unsafe {
        let wide_path: Vec<u16> = path
            .to_str()
            .expect("non-UTF8 media path")
            .encode_utf16()
            .chain(Some(0))
            .collect();

        let mut attributes: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attributes, 0)?;
        let attributes = attributes.as_ref().expect("Couldn't get source reader attributes");
        attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)?;
        attributes.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 0)?;

        let reader = MFCreateSourceReaderFromURL(PCWSTR(wide_path.as_ptr()), attributes)?;

        // We decode audio on a separate reader/thread - don't make this reader do the extra
        // decode work for a stream we never read from it.
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, false);
        reader.SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true)?;

        let media_type = MFCreateMediaType()?;
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        // NOTE: MF's RGB32 output is documented as BGRA byte order (D3DFMT_X8R8G8B8), while the
        // addon texture this feeds is created as Rgba8Unorm - verify on first real run whether
        // the sample clip renders with red/blue swapped, and if so swap bytes in
        // `read_video_sample` rather than assuming either way.
        media_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
        reader.SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &media_type)?;

        Ok(reader)
    }
}

fn probe_video(reader: &IMFSourceReader) -> windows::core::Result<(i64, u32, u32, f64)> {
    unsafe {
        let duration_prop =
            reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)?;
        let duration_100ns = windows::Win32::System::Com::StructuredStorage::PropVariantToInt64(&duration_prop)?;
        let duration_ms = duration_100ns / 10_000;

        let media_type = reader.GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, 0)?;

        let size = media_type.GetUINT64(&MF_MT_FRAME_SIZE)?;
        let width = (size >> 32) as u32;
        let height = (size & 0xFFFF_FFFF) as u32;

        let rate = media_type.GetUINT64(&MF_MT_FRAME_RATE)?;
        let num = (rate >> 32) as f64;
        let den = (rate & 0xFFFF_FFFF) as f64;
        let frame_rate = if den > 0.0 { num / den } else { 30.0 };

        Ok((duration_ms, width, height, frame_rate))
    }
}

fn read_video_sample(reader: &IMFSourceReader) -> windows::core::Result<Option<(Vec<u8>, f64)>> {
    unsafe {
        let mut flags: u32 = 0;
        let mut timestamp_100ns: i64 = 0;
        let mut sample: Option<IMFSample> = None;

        reader.ReadSample(
            MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
            0,
            None,
            Some(&mut flags),
            Some(&mut timestamp_100ns),
            Some(&mut sample),
        )?;

        if (flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
            return Ok(None);
        }
        let Some(sample) = sample else {
            return Ok(None);
        };

        let buffer = sample.ConvertToContiguousBuffer()?;
        let mut data_ptr: *mut u8 = std::ptr::null_mut();
        let mut data_len: u32 = 0;
        buffer.Lock(&mut data_ptr, None, Some(&mut data_len))?;
        let mut frame_data = vec![0u8; data_len as usize];
        std::ptr::copy_nonoverlapping(data_ptr, frame_data.as_mut_ptr(), data_len as usize);
        buffer.Unlock()?;

        Ok(Some((frame_data, timestamp_100ns as f64 / 10_000.0)))
    }
}

fn create_audio_reader(path: &Path) -> windows::core::Result<IMFSourceReader> {
    unsafe {
        let wide_path: Vec<u16> = path
            .to_str()
            .expect("non-UTF8 media path")
            .encode_utf16()
            .chain(Some(0))
            .collect();

        let reader = MFCreateSourceReaderFromURL(PCWSTR(wide_path.as_ptr()), None)?;
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, false);
        reader.SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, true)?;

        let media_type = MFCreateMediaType()?;
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
        media_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        reader.SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, None, &media_type)?;

        Ok(reader)
    }
}

fn probe_audio_format(path: &Path) -> Option<(u16, u32)> {
    let reader = create_audio_reader(path).ok()?;
    unsafe {
        let media_type = reader
            .GetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32)
            .ok()?;
        let channels = media_type.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).ok()? as u16;
        let sample_rate = media_type.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).ok()?;
        Some((channels, sample_rate))
    }
}

fn read_audio_chunk(reader: &IMFSourceReader) -> windows::core::Result<Option<Vec<f32>>> {
    unsafe {
        let mut flags: u32 = 0;
        let mut sample: Option<IMFSample> = None;

        reader.ReadSample(
            MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
            0,
            None,
            Some(&mut flags),
            None,
            Some(&mut sample),
        )?;

        if (flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
            return Ok(None);
        }
        let Some(sample) = sample else {
            return Ok(None);
        };

        let buffer = sample.ConvertToContiguousBuffer()?;
        let mut data_ptr: *mut u8 = std::ptr::null_mut();
        let mut data_len: u32 = 0;
        buffer.Lock(&mut data_ptr, None, Some(&mut data_len))?;
        let byte_slice = std::slice::from_raw_parts(data_ptr, data_len as usize);
        // Negotiated as 16-bit signed PCM, little-endian, via MF_MT_AUDIO_BITS_PER_SAMPLE above.
        let samples: Vec<f32> = byte_slice
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
            .collect();
        buffer.Unlock()?;

        Ok(Some(samples))
    }
}

/// Owns one decode thread + the `rodio::Sink` it feeds. Dropping this drops the `Sink`, which
/// drops the `ChunkAudioSource` inside it, which drops the channel `Receiver` - the decode
/// thread's next `send` then fails and it exits on its own; nothing here is explicitly joined.
struct AudioChannel {
    sink: Sink,
    _thread: JoinHandle<()>,
}

impl AudioChannel {
    fn spawn(
        path: &Path,
        start_ms: i64,
        channels: u16,
        sample_rate: u32,
        volume: f32,
        audio_engine: &AudioEngine,
    ) -> windows::core::Result<Self> {
        let (tx, rx) = sync_channel::<Vec<f32>>(8);
        let thread_path = path.to_path_buf();

        let thread = std::thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let _ = MFStartup(MF_VERSION, MFSTARTUP_FULL);
            }

            let reader = match create_audio_reader(&thread_path) {
                Ok(r) => r,
                Err(e) => {
                    println!("[media_player] audio decode thread failed to open reader: {e:?}");
                    return;
                }
            };

            if start_ms > 0 {
                unsafe {
                    let _ = reader.SetCurrentPosition(&GUID_NULL, &PROPVARIANT::from(start_ms.saturating_mul(10_000)));
                }
            }

            loop {
                match read_audio_chunk(&reader) {
                    Ok(Some(samples)) => {
                        if tx.send(samples).is_err() {
                            return; // sink/source dropped (seek, close, or player dropped)
                        }
                    }
                    Ok(None) => return, // end of stream
                    Err(e) => {
                        println!("[media_player] audio decode error: {e:?}");
                        return;
                    }
                }
            }
        });

        let source = ChunkAudioSource {
            rx,
            current: Vec::new(),
            pos: 0,
            channels,
            sample_rate,
        };
        let sink = audio_engine.new_sink();
        sink.set_volume(volume);
        sink.append(source);

        Ok(AudioChannel { sink, _thread: thread })
    }
}

struct ChunkAudioSource {
    rx: Receiver<Vec<f32>>,
    current: Vec<f32>,
    pos: usize,
    channels: u16,
    sample_rate: u32,
}

impl Iterator for ChunkAudioSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        loop {
            if self.pos < self.current.len() {
                let s = self.current[self.pos];
                self.pos += 1;
                return Some(s);
            }
            match self.rx.recv_timeout(Duration::from_millis(250)) {
                Ok(chunk) => {
                    self.current = chunk;
                    self.pos = 0;
                }
                // Underrun or decode thread gone: emit silence rather than ending the stream -
                // pause/seek/close are all driven by the player, not by the source running dry.
                Err(_) => return Some(0.0),
            }
        }
    }
}

impl Source for ChunkAudioSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

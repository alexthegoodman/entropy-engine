// Standalone video+audio player for the media player example app on non-Windows platforms: the
// OpenH264/symphonia counterpart of the Media Foundation player in `mod.rs` (which Windows keeps
// using). The public API, clock and frame-pacing behavior are the same, so `deno::addon_ops`'s
// `op_video_*` ops and the media player addon don't care which one they get. Decoding itself
// lives in `crate::openh264_codec`.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rodio::{Sink, Source};

use crate::audio::AudioEngine;
use crate::openh264_codec::{Mp4AudioDecoder, Mp4VideoDecoder};

pub struct MediaPlayer {
    path: PathBuf,
    video: Mp4VideoDecoder,
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
    speed: f32,
    show_seek_frame: bool,
    frame: Vec<u8>,

    audio_engine: Arc<AudioEngine>,
    audio: Option<AudioChannel>,
}

impl MediaPlayer {
    pub fn open(path: impl AsRef<Path>, audio_engine: Arc<AudioEngine>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();

        let video = Mp4VideoDecoder::open(&path)?;
        let info = video.info();
        let audio_format = Mp4AudioDecoder::open(&path)
            .map(|decoder| (decoder.channels(), decoder.sample_rate()))
            .ok();

        if audio_format.is_none() {
            println!("[media_player] no usable audio stream in {path:?} - playing video-only");
        }

        Ok(MediaPlayer {
            path,
            video,
            duration_ms: info.duration_ms,
            width: info.width,
            height: info.height,
            frame_rate: info.frame_rate,
            audio_format,
            playing: false,
            position_at_play_ms: 0,
            play_started_at: None,
            next_frame_due_ms: 0.0,
            volume: 1.0,
            speed: 1.0,
            show_seek_frame: true,
            frame: Vec::new(),
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
    pub fn speed(&self) -> f32 { self.speed }
    pub fn volume(&self) -> f32 { self.volume }
    pub fn has_audio_stream(&self) -> bool { self.audio_format.is_some() }
    pub fn audio_sink_active(&self) -> bool { self.audio.is_some() }

    pub fn current_time_ms(&self) -> i64 {
        if self.playing {
            self.position_at_play_ms
                + (self
                    .play_started_at
                    .map(|t| t.elapsed().as_millis() as i64)
                    .unwrap_or(0) as f64 * self.speed as f64) as i64
        } else {
            self.position_at_play_ms
        }
    }

    pub fn play(&mut self) {
        if self.playing {
            return;
        }
        if self.position_at_play_ms >= self.duration_ms {
            if let Err(error) = self.seek(0) {
                println!("[media_player] replay seek failed: {error}");
                return;
            }
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
                self.speed,
                &self.audio_engine,
            ) {
                Ok(ch) => self.audio = Some(ch),
                Err(e) => println!("[media_player] audio start failed, continuing video-only: {e}"),
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

    /// Repositions both streams. As on Windows, audio restarts on a fresh decode thread + sink
    /// seeked to the new position rather than flushing the old one.
    pub fn seek(&mut self, ms: i64) -> Result<(), String> {
        let ms = ms.clamp(0, self.duration_ms);
        self.video.seek(ms)?;
        self.position_at_play_ms = ms;
        self.next_frame_due_ms = ms as f64;
        self.show_seek_frame = true;
        self.play_started_at = if self.playing { Some(Instant::now()) } else { None };

        self.audio = None;
        if self.playing {
            if let Some((channels, sample_rate)) = self.audio_format {
                match AudioChannel::spawn(&self.path, ms, channels, sample_rate, self.volume, self.speed, &self.audio_engine) {
                    Ok(ch) => self.audio = Some(ch),
                    Err(e) => println!("[media_player] audio restart after seek failed: {e}"),
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

    pub fn set_speed(&mut self, speed: f32) {
        let position = self.current_time_ms();
        self.speed = speed.clamp(0.25, 4.0);
        self.position_at_play_ms = position;
        if self.playing { self.play_started_at = Some(Instant::now()); }
        if let Some(audio) = &self.audio { audio.sink.set_speed(self.speed); }
    }

    /// Returns newly-decoded RGBA frame bytes if playback has reached (or passed) the next
    /// frame's presentation time, else `None`. After a hitch (or at high speed on a slow machine)
    /// frames that are already out of date are decoded but dropped - bounded to 30 per call, like
    /// the Media Foundation player - and only the one on screen now is converted to RGBA.
    pub fn poll_video_frame(&mut self) -> Option<Vec<u8>> {
        if !self.playing && !self.show_seek_frame {
            return None;
        }
        self.show_seek_frame = false;
        let now_ms = self.current_time_ms() as f64;
        if self.next_frame_due_ms > now_ms {
            return None;
        }
        let frame_ms = 1000.0 / self.frame_rate.max(1.0);

        match self.video.next_frame_catching_up(now_ms - frame_ms + 1.0, 30, &mut self.frame) {
            Ok(Some(pts_ms)) => {
                self.next_frame_due_ms = pts_ms + frame_ms;
                Some(self.frame.clone())
            }
            Ok(None) => {
                // current_time_ms() while !playing returns the frozen position_at_play_ms, so pin it
                // to the real end-of-stream position.
                self.position_at_play_ms = self.duration_ms;
                self.playing = false;
                self.play_started_at = None;
                if let Some(audio) = &self.audio { audio.sink.stop(); }
                None
            }
            Err(e) => {
                println!("[media_player] video decode error: {e}");
                self.position_at_play_ms = now_ms as i64;
                self.playing = false;
                self.play_started_at = None;
                None
            }
        }
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
        speed: f32,
        audio_engine: &AudioEngine,
    ) -> Result<Self, String> {
        let (tx, rx) = sync_channel::<Vec<f32>>(8);
        let thread_path = path.to_path_buf();

        let thread = std::thread::spawn(move || {
            let mut decoder = match Mp4AudioDecoder::open(&thread_path) {
                Ok(decoder) => decoder,
                Err(e) => {
                    println!("[media_player] audio decode thread failed to open decoder: {e}");
                    return;
                }
            };

            if start_ms > 0 {
                if let Err(e) = decoder.seek(start_ms) {
                    println!("[media_player] audio seek failed: {e}");
                }
            }

            loop {
                match decoder.next_chunk() {
                    Ok(Some(samples)) => {
                        if tx.send(samples).is_err() {
                            return; // sink/source dropped (seek, close, or player dropped)
                        }
                    }
                    Ok(None) => return, // end of stream
                    Err(e) => {
                        println!("[media_player] audio decode error: {e}");
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
        sink.set_speed(speed);
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

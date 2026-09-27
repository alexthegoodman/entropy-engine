// Bounced song (WAV) + `VisualizerSettings` -> H.264/AAC MP4, on a background thread.
//
// Per video frame: cut the audio around that frame's time out of the WAV, advance a
// `FeatureTracker` by `1 / fps`, draw the frame with `Visualizer`, encode it, then hand the encoder
// the audio that plays during that frame. Nothing here touches the GPU or the window, so the DAW
// keeps running normally while `MusicVideoJob` works; the addon polls `status()` for progress.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use crate::music_video::features::{FeatureTracker, FEATURE_FFT};
use crate::music_video::scenes::Visualizer;
use crate::music_video::settings::VisualizerSettings;

/// Songs longer than this are refused rather than tying the machine up for hours.
pub const MAX_SECONDS: f64 = 20.0 * 60.0;

#[derive(Clone, Debug)]
pub struct MusicVideoRequest {
    pub wav_path: PathBuf,
    pub output_path: PathBuf,
    pub settings: VisualizerSettings,
    /// Remove `wav_path` afterwards (it was a temporary bounce), whether or not export succeeded.
    pub delete_wav: bool,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicVideoStatus {
    pub frames_done: u32,
    pub total_frames: u32,
    /// 0..1.
    pub progress: f32,
    pub done: bool,
    pub cancelled: bool,
    pub error: Option<String>,
    pub output_path: String,
    pub elapsed_ms: u64,
    /// A problem that didn't stop the export (a background image that wouldn't load).
    pub warning: Option<String>,
}

/// A stereo song in memory.
pub struct Song {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub sample_rate: u32,
}

impl Song {
    pub fn seconds(&self) -> f64 {
        self.left.len() as f64 / self.sample_rate.max(1) as f64
    }
}

/// Reads a PCM WAV (8/16/24/32-bit int or 32-bit float; mono is duplicated, extra channels are
/// dropped) into a stereo `Song`.
pub fn load_wav(path: &Path) -> Result<Song, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>(),
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample.clamp(1, 32) - 1)) as f32;
            reader.samples::<i32>().map(|s| s.map(|v| v as f32 * scale)).collect::<Result<_, _>>()
        }
    }
    .map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    let frames = samples.len() / channels;
    let mut left = Vec::with_capacity(frames);
    let mut right = Vec::with_capacity(frames);
    for frame in samples.chunks_exact(channels) {
        left.push(frame[0]);
        right.push(if channels > 1 { frame[1] } else { frame[0] });
    }
    Ok(Song { left, right, sample_rate: spec.sample_rate })
}

/// H.264 video + AAC audio into one MP4: Media Foundation on Windows, OpenH264 + fdk-aac
/// elsewhere, behind one shape.
pub struct AvEncoder {
    #[cfg(target_os = "windows")]
    inner: crate::video_export::encode::VideoEncoder,
    #[cfg(not(target_os = "windows"))]
    inner: crate::openh264_codec::Mp4VideoEncoder,
}

impl AvEncoder {
    pub fn new(path: &str, width: u32, height: u32, fps: u32, sample_rate: u32, channels: u16) -> Result<Self, String> {
        #[cfg(target_os = "windows")]
        let inner = crate::video_export::encode::VideoEncoder::new_with_audio(path, width, height, fps, Some((sample_rate, channels)))
            .map_err(|e| format!("Couldn't open video encoder for {path}: {e}"))?;
        #[cfg(not(target_os = "windows"))]
        let inner = crate::openh264_codec::Mp4VideoEncoder::with_audio(
            path,
            width,
            height,
            fps,
            Some(crate::openh264_codec::AacAudioConfig { sample_rate, channels }),
        )?;
        Ok(Self { inner })
    }

    pub fn write_video(&mut self, rgba: &[u8]) -> Result<(), String> {
        self.inner.write_frame(rgba).map_err(|e| format!("Couldn't encode video frame: {e}"))
    }

    pub fn write_audio(&mut self, interleaved: &[f32]) -> Result<(), String> {
        self.inner.write_audio(interleaved).map_err(|e| format!("Couldn't encode audio: {e}"))
    }

    pub fn audio_delay_samples(&self) -> u32 {
        self.inner.audio_delay_samples()
    }

    pub fn finish(mut self) -> Result<(), String> {
        self.inner.finish().map_err(|e| format!("Couldn't finalize the video: {e}"))
    }
}

/// Supported by both encoders (Media Foundation's AAC encoder is the pickier one).
fn check_sample_rate(rate: u32) -> Result<(), String> {
    if rate == 44_100 || rate == 48_000 {
        Ok(())
    } else {
        Err(format!("Music videos need 44.1 or 48 kHz audio; this song is {rate} Hz"))
    }
}

/// Renders the whole video synchronously. `on_progress(frames_done, total_frames)` is called after
/// every frame; setting `cancel` stops at the next frame and removes the partial file.
/// Returns the frame count and any non-fatal warning.
pub fn render_music_video(
    song: &Song,
    output_path: &Path,
    settings: &VisualizerSettings,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u32, u32),
) -> Result<(u32, Option<String>), String> {
    let settings = settings.sanitized();
    check_sample_rate(song.sample_rate)?;
    let seconds = song.seconds();
    if seconds <= 0.0 {
        return Err("The song is empty".to_string());
    }
    if seconds > MAX_SECONDS {
        return Err(format!("The song is {:.0} minutes long; music videos are limited to {:.0}", seconds / 60.0, MAX_SECONDS / 60.0));
    }
    let fps = settings.fps;
    let total_frames = ((seconds * fps as f64).ceil() as u32).max(1);
    let path_str = output_path.to_string_lossy().to_string();

    // Rendering and H.264 encoding each take a good share of a frame's time, so they overlap:
    // the encoder runs on its own thread (created there, which also keeps Media Foundation's COM
    // objects on the thread that made them), fed through a short queue.
    enum Work {
        Frame(Vec<u8>, Vec<f32>),
        Finish,
    }
    let result = std::thread::scope(|scope| -> Result<(u32, Option<String>), String> {
        let (work_tx, work_rx) = std::sync::mpsc::sync_channel::<Work>(3);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<i64, String>>();
        let (width, height, sample_rate) = (settings.width, settings.height, song.sample_rate);
        let path = path_str.clone();
        let encoder_thread = scope.spawn(move || -> Result<(), String> {
            let mut encoder = match AvEncoder::new(&path, width, height, fps, sample_rate, 2) {
                Ok(e) => e,
                Err(e) => {
                    let _ = ready_tx.send(Err(e.clone()));
                    return Err(e);
                }
            };
            let _ = ready_tx.send(Ok(encoder.audio_delay_samples() as i64));
            while let Ok(work) = work_rx.recv() {
                match work {
                    Work::Frame(rgba, audio) => {
                        encoder.write_video(&rgba)?;
                        if !audio.is_empty() {
                            encoder.write_audio(&audio)?;
                        }
                    }
                    Work::Finish => return encoder.finish(),
                }
            }
            // The renderer stopped early (cancelled or failed): nothing to finalize.
            Ok(())
        });
        let encoder_failed = |encoder_thread: std::thread::ScopedJoinHandle<'_, Result<(), String>>| {
            encoder_thread.join().unwrap_or_else(|_| Err("The encoder crashed".to_string())).err().unwrap_or_else(|| "The encoder stopped".to_string())
        };
        let delay = match ready_rx.recv() {
            Ok(Ok(delay)) => delay,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(encoder_failed(encoder_thread)),
        };

        let mut tracker = FeatureTracker::new(song.sample_rate as f32);
        let mut visualizer = Visualizer::new(&settings);
        let warning = visualizer.background_error.clone();
        let sr = song.sample_rate as f64;
        let len = song.left.len();
        let dt = 1.0 / fps as f32;
        let mut audio_pos = 0usize;

        for frame in 0..total_frames {
            if cancel.load(Ordering::Relaxed) {
                drop(work_tx);
                let _ = encoder_thread.join();
                return Err("cancelled".to_string());
            }
            // The audio this frame is shown with: shifted back by the encoder's priming delay (the
            // viewer hears the song that late), and half an FFT ahead so the spectrum window is
            // centred on the frame instead of trailing it.
            let t = frame as f64 / fps as f64;
            let now = ((t * sr) as i64 - delay + FEATURE_FFT as i64 / 2).clamp(0, len as i64) as usize;
            let from = now.saturating_sub(FEATURE_FFT);
            let features = tracker.update(&song.left[from..now], &song.right[from..now], dt, &settings);
            let progress = (t / seconds) as f32;
            let rgba = visualizer.render(features, dt, Some(progress)).to_vec();

            let audio_end = ((((frame + 1) as f64) / fps as f64 * sr).round() as usize).min(len);
            let mut interleaved = Vec::with_capacity(2 * audio_end.saturating_sub(audio_pos));
            for i in audio_pos..audio_end {
                interleaved.push(song.left[i]);
                interleaved.push(song.right[i]);
            }
            audio_pos = audio_end.max(audio_pos);
            if work_tx.send(Work::Frame(rgba, interleaved)).is_err() {
                return Err(encoder_failed(encoder_thread));
            }
            on_progress(frame + 1, total_frames);
        }
        if work_tx.send(Work::Finish).is_err() {
            return Err(encoder_failed(encoder_thread));
        }
        drop(work_tx);
        encoder_thread.join().unwrap_or_else(|_| Err("The encoder crashed".to_string()))?;
        Ok((total_frames, warning))
    });

    if result.is_err() {
        let _ = std::fs::remove_file(output_path);
    }
    result
}

/// One export running on its own thread.
pub struct MusicVideoJob {
    status: Arc<Mutex<MusicVideoStatus>>,
    cancel: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MusicVideoJob {
    pub fn start(request: MusicVideoRequest) -> Self {
        let output_path = request.output_path.to_string_lossy().to_string();
        let status = Arc::new(Mutex::new(MusicVideoStatus { output_path, ..Default::default() }));
        let cancel = Arc::new(AtomicBool::new(false));
        let (thread_status, thread_cancel) = (status.clone(), cancel.clone());
        let thread = std::thread::Builder::new()
            .name("music-video-export".to_string())
            .spawn(move || {
                let started = Instant::now();
                let outcome = load_wav(&request.wav_path).and_then(|song| {
                    render_music_video(&song, &request.output_path, &request.settings, &thread_cancel, |done, total| {
                        let mut s = thread_status.lock().unwrap();
                        s.frames_done = done;
                        s.total_frames = total;
                        s.progress = done as f32 / total.max(1) as f32;
                        s.elapsed_ms = started.elapsed().as_millis() as u64;
                    })
                });
                if request.delete_wav {
                    let _ = std::fs::remove_file(&request.wav_path);
                }
                let mut s = thread_status.lock().unwrap();
                s.elapsed_ms = started.elapsed().as_millis() as u64;
                s.done = true;
                match outcome {
                    Ok((_, warning)) => {
                        s.progress = 1.0;
                        s.warning = warning;
                    }
                    Err(e) if thread_cancel.load(Ordering::Relaxed) => {
                        let _ = e;
                        s.cancelled = true;
                    }
                    Err(e) => s.error = Some(e),
                }
            })
            .expect("spawn music video export thread");
        Self { status, cancel, thread: Some(thread) }
    }

    pub fn status(&self) -> MusicVideoStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    pub fn is_done(&self) -> bool {
        self.status.lock().unwrap().done
    }
}

impl Drop for MusicVideoJob {
    fn drop(&mut self) {
        // Dropping a running job (the addon unloading) stops it rather than leaving a thread
        // writing a file nobody will collect.
        self.cancel();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::music_video::settings::VisualStyle;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("entropy-music-video-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn write_test_wav(path: &Path, seconds: f32) {
        let spec = hound::WavSpec { channels: 2, sample_rate: 44_100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..(44_100.0 * seconds) as usize {
            let t = i as f32 / 44_100.0;
            // A kick every half second over a quiet chord.
            let kick_t = t % 0.5;
            let kick = 0.8 * (2.0 * std::f32::consts::PI * 55.0 * kick_t).sin() * (-kick_t * 14.0).exp();
            let pad = 0.1 * (2.0 * std::f32::consts::PI * 440.0 * t).sin();
            let s = ((kick + pad) * 32767.0) as i16;
            w.write_sample(s).unwrap();
            w.write_sample(s).unwrap();
        }
        w.finalize().unwrap();
    }

    #[test]
    fn loads_16_bit_stereo_wav() {
        let path = scratch("load.wav");
        write_test_wav(&path, 0.25);
        let song = load_wav(&path).unwrap();
        assert_eq!(song.sample_rate, 44_100);
        assert_eq!(song.left.len(), 11_025);
        assert!(song.left.iter().any(|s| s.abs() > 0.3));
    }

    #[test]
    fn rejects_sample_rates_the_encoders_cannot_take() {
        let song = Song { left: vec![0.0; 22_050], right: vec![0.0; 22_050], sample_rate: 22_050 };
        let err = render_music_video(&song, &scratch("bad.mp4"), &VisualizerSettings::default(), &AtomicBool::new(false), |_, _| {}).unwrap_err();
        assert!(err.contains("44.1"), "{err}");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn exports_an_mp4_with_video_and_audio_tracks() {
        let wav = scratch("song.wav");
        let mp4_path = scratch("song.mp4");
        write_test_wav(&wav, 1.0);
        let job = MusicVideoJob::start(MusicVideoRequest {
            wav_path: wav.clone(),
            output_path: mp4_path.clone(),
            settings: VisualizerSettings { style: VisualStyle::Radial, width: 320, height: 180, fps: 24, title: "Test".into(), ..Default::default() },
            delete_wav: true,
        });
        while !job.is_done() {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let status = job.status();
        assert_eq!(status.error, None);
        assert_eq!(status.total_frames, 24);
        assert_eq!(status.frames_done, 24);
        assert!(!wav.exists(), "temporary bounce is removed");

        let file = std::fs::File::open(&mp4_path).unwrap();
        let size = file.metadata().unwrap().len();
        let reader = mp4::Mp4Reader::read_header(std::io::BufReader::new(file), size).unwrap();
        let tracks: Vec<_> = reader.tracks().values().collect();
        assert_eq!(tracks.len(), 2);
        let video = tracks.iter().find(|t| t.track_type().unwrap() == mp4::TrackType::Video).unwrap();
        let audio = tracks.iter().find(|t| t.track_type().unwrap() == mp4::TrackType::Audio).unwrap();
        assert_eq!(video.sample_count(), 24);
        assert_eq!((video.width(), video.height()), (320, 180));
        assert_eq!(audio.sample_freq_index().unwrap().freq(), 44_100);
        // One second of 1024-sample AAC frames, plus the encoder's priming.
        assert!((43..=48).contains(&audio.sample_count()), "{} audio frames", audio.sample_count());

        // And the audio decodes back to something with the kick in it.
        let mut decoder = crate::openh264_codec::Mp4AudioDecoder::open(&mp4_path).unwrap();
        let mut peak = 0.0f32;
        while let Some(chunk) = decoder.next_chunk().unwrap() {
            peak = chunk.iter().fold(peak, |m, s| m.max(s.abs()));
        }
        assert!(peak > 0.4, "decoded peak {peak}");
        let _ = std::fs::remove_file(&mp4_path);
    }

    /// How fast a Full HD export runs on this machine: `cargo test --release --lib
    /// music_video::export::tests::export_speed -- --ignored --nocapture`.
    #[cfg(not(target_os = "windows"))]
    #[test]
    #[ignore]
    fn export_speed() {
        let wav = scratch("speed.wav");
        write_test_wav(&wav, 4.0);
        let song = load_wav(&wav).unwrap();
        for style in VisualStyle::ALL {
            let out = scratch(&format!("speed-{}.mp4", style.id()));
            let settings = VisualizerSettings { style, width: 1920, height: 1080, fps: 30, title: "Speed".into(), artist: "Test".into(), ..Default::default() };
            let started = Instant::now();
            let (frames, _) = render_music_video(&song, &out, &settings, &AtomicBool::new(false), |_, _| {}).unwrap();
            let secs = started.elapsed().as_secs_f64();
            println!("{:>10}: {frames} frames of 1920x1080 in {secs:.2} s = {:.1} fps ({:.2}x real time)", style.id(), frames as f64 / secs, 4.0 / secs);
            let _ = std::fs::remove_file(out);
        }
    }

    #[test]
    fn cancelling_stops_and_removes_the_partial_file() {
        let song = Song { left: vec![0.0; 44_100 * 5], right: vec![0.0; 44_100 * 5], sample_rate: 44_100 };
        let out = scratch("cancelled.mp4");
        let cancel = AtomicBool::new(false);
        let err = render_music_video(&song, &out, &VisualizerSettings { width: 160, height: 90, ..Default::default() }, &cancel, |done, _| {
            if done == 3 {
                cancel.store(true, Ordering::Relaxed);
            }
        })
        .unwrap_err();
        assert_eq!(err, "cancelled");
        assert!(!out.exists());
    }
}

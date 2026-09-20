//! Sample playback for the DAW's drum racks: decode an audio file once, keep it in memory at the
//! engine's rate, and play it as a rodio `Source` on a track bus like any other voice.
//!
//! Three deliberate limits, all visible to the caller rather than hidden:
//!
//! - A file is decoded to at most `MAX_SAMPLE_SECONDS`. The Music folder holds albums as well as
//!   drum hits, and decoding a whole song to f32 stereo costs about 60 MB. The decode stops early
//!   (an mp3 is not read to the end), and `DecodedSample::truncated` says so. A rack pad can still
//!   use the first twelve seconds of a song by trimming.
//! - Everything is resampled to `ENGINE_SAMPLE_RATE` with linear interpolation. That is adequate
//!   for drum hits; a 48 kHz source loses a little top end and is not low-passed first.
//! - Listing folders is read-only and limited to allowed roots (the user's Music folder, plus any
//!   folder chosen through a native dialog), and only audio files can be decoded. An addon can ask
//!   what audio is there; it cannot read arbitrary files or walk the whole disk.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use rodio::{Decoder, Source};
use serde::{Deserialize, Serialize};

use super::analysis::ENGINE_SAMPLE_RATE;

/// Longest stretch of one file that is decoded, in seconds of the source.
pub const MAX_SAMPLE_SECONDS: f64 = 12.0;

/// Decoded audio kept in memory before the least recently used entries are dropped.
const CACHE_BUDGET_BYTES: usize = 384 * 1024 * 1024;

/// What the rodio features this crate enables (`flac`, `mp3`, `mp4`, `vorbis`, `wav`) can decode.
pub const AUDIO_EXTENSIONS: &[&str] = &["wav", "flac", "mp3", "ogg", "m4a"];

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.iter().any(|a| a.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

// --- Decoded audio ------------------------------------------------------------------------------

pub struct DecodedSample {
    /// Stereo frames at `ENGINE_SAMPLE_RATE`. A mono file has the same value in both channels.
    pub frames: Vec<[f32; 2]>,
    /// Length of the whole file, when the decoder knows it. `None` for a truncated file whose
    /// container does not say.
    pub full_seconds: Option<f64>,
    /// The file was longer than `MAX_SAMPLE_SECONDS` and only the start was decoded.
    pub truncated: bool,
    pub source_rate: u32,
    pub source_channels: u16,
}

impl std::fmt::Debug for DecodedSample {
    // A summary: printing every frame of a sample into a failed assertion helps nobody.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DecodedSample {{ {} frames, truncated: {}, {} Hz, {} ch }}", self.frames.len(), self.truncated, self.source_rate, self.source_channels)
    }
}

impl DecodedSample {
    pub fn seconds(&self) -> f64 {
        self.frames.len() as f64 / ENGINE_SAMPLE_RATE as f64
    }

    /// Largest absolute value in either channel.
    pub fn peak(&self) -> f32 {
        self.frames.iter().fold(0.0f32, |m, f| m.max(f[0].abs()).max(f[1].abs()))
    }

    /// `bins` peak values, 0..1, scaled so the loudest bin is 1: the shape of the sample, for a
    /// thumbnail. Quiet samples still fill the picture; `peak()` says how loud one really is.
    pub fn waveform(&self, bins: usize) -> Vec<f32> {
        let bins = bins.max(1);
        let n = self.frames.len();
        let mut out = vec![0.0f32; bins];
        if n == 0 {
            return out;
        }
        for (b, slot) in out.iter_mut().enumerate() {
            let a = b * n / bins;
            let z = ((b + 1) * n / bins).max(a + 1).min(n);
            *slot = self.frames[a..z].iter().fold(0.0f32, |m, f| m.max(f[0].abs()).max(f[1].abs()));
        }
        let top = out.iter().cloned().fold(0.0f32, f32::max);
        if top > 0.0 {
            out.iter_mut().for_each(|v| *v /= top);
        }
        out
    }
}

/// Decodes up to `max_seconds` of `path` to stereo at the engine rate.
pub fn decode_file(path: &Path, max_seconds: f64) -> Result<DecodedSample, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    if !is_audio_file(path) {
        return Err(format!("{name} is not a supported audio file ({})", AUDIO_EXTENSIONS.join(", ")));
    }
    let file = File::open(path).map_err(|e| format!("could not open {name}: {e}"))?;
    let mut decoder = Decoder::try_from(file).map_err(|e| format!("could not decode {name}: {e}"))?;

    let channels = decoder.channels().max(1) as usize;
    let rate = decoder.sample_rate().max(1);
    let total = decoder.total_duration().map(|d| d.as_secs_f64());
    let max_frames = (max_seconds.max(0.01) * rate as f64).ceil() as usize;

    let mut src: Vec<[f32; 2]> = Vec::with_capacity(max_frames.min(rate as usize * 2));
    let mut frame = [0.0f32; 2];
    let mut c = 0usize;
    while src.len() < max_frames {
        let Some(s) = decoder.next() else { break };
        if channels == 1 {
            src.push([s, s]);
            continue;
        }
        if c < 2 {
            frame[c] = s;
        }
        c += 1;
        if c == channels {
            src.push(frame);
            c = 0;
        }
    }
    let truncated = src.len() >= max_frames && decoder.next().is_some();
    if src.is_empty() {
        return Err(format!("{name} decoded to no audio"));
    }

    let frames = resample(src, rate, ENGINE_SAMPLE_RATE);
    let decoded_seconds = frames.len() as f64 / ENGINE_SAMPLE_RATE as f64;
    Ok(DecodedSample {
        full_seconds: if truncated { total } else { Some(decoded_seconds) },
        truncated,
        frames,
        source_rate: rate,
        source_channels: channels as u16,
    })
}

/// Linear-interpolation resample of stereo frames from `from` Hz to `to` Hz.
pub fn resample(src: Vec<[f32; 2]>, from: u32, to: u32) -> Vec<[f32; 2]> {
    if from == to || src.len() < 2 {
        return src;
    }
    let ratio = from as f64 / to as f64;
    let n = (src.len() as f64 / ratio).floor() as usize;
    let last = src.len() - 1;
    (0..n)
        .map(|i| {
            let p = i as f64 * ratio;
            let i0 = (p as usize).min(last);
            let f = (p - i0 as f64) as f32;
            let (a, b) = (src[i0], src[(i0 + 1).min(last)]);
            [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
        })
        .collect()
}

// --- Cache --------------------------------------------------------------------------------------

struct CacheEntry {
    modified: Option<SystemTime>,
    len: u64,
    sample: Arc<DecodedSample>,
    last_used: u64,
}

#[derive(Default)]
struct SampleCache {
    entries: HashMap<String, CacheEntry>,
    tick: u64,
    bytes: usize,
}

fn cache() -> &'static Mutex<SampleCache> {
    static CACHE: OnceLock<Mutex<SampleCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(SampleCache::default()))
}

fn sample_bytes(s: &DecodedSample) -> usize {
    s.frames.len() * std::mem::size_of::<[f32; 2]>()
}

/// The decoded sample for `path`, from memory when the file has not changed since it was read.
/// A miss decodes on the calling thread (a few milliseconds for a drum hit, longer for a
/// twelve-second slice of an mp3), so callers load a pad's sample when it is assigned, not when it
/// first plays.
pub fn load(path: &str) -> Result<Arc<DecodedSample>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("could not read {path}: {e}"))?;
    let (modified, len) = (meta.modified().ok(), meta.len());

    {
        let mut c = cache().lock().unwrap();
        c.tick += 1;
        let tick = c.tick;
        if let Some(entry) = c.entries.get_mut(path) {
            if entry.modified == modified && entry.len == len {
                entry.last_used = tick;
                return Ok(entry.sample.clone());
            }
        }
    }

    let decoded = Arc::new(decode_file(Path::new(path), MAX_SAMPLE_SECONDS)?);

    let mut c = cache().lock().unwrap();
    c.tick += 1;
    let tick = c.tick;
    if let Some(old) = c.entries.remove(path) {
        c.bytes -= sample_bytes(&old.sample);
    }
    c.bytes += sample_bytes(&decoded);
    c.entries.insert(path.to_string(), CacheEntry { modified, len, sample: decoded.clone(), last_used: tick });
    while c.bytes > CACHE_BUDGET_BYTES && c.entries.len() > 1 {
        let Some(oldest) = c.entries.iter().filter(|(k, _)| k.as_str() != path).min_by_key(|(_, e)| e.last_used).map(|(k, _)| k.clone()) else { break };
        if let Some(e) = c.entries.remove(&oldest) {
            c.bytes -= sample_bytes(&e.sample);
        }
    }
    Ok(decoded)
}

/// (entries, bytes) currently held, for tests and diagnostics.
pub fn cache_stats() -> (usize, usize) {
    let c = cache().lock().unwrap();
    (c.entries.len(), c.bytes)
}

// --- The voice ----------------------------------------------------------------------------------

/// How one pad hit plays. `start`/`end` are fractions of the decoded sample, so a trim survives
/// the file being re-decoded at a different length.
#[derive(Clone, Copy, Debug)]
pub struct SampleParams {
    pub gain: f32,
    /// Playback-rate pitch shift: it changes the length too, as on a hardware sampler.
    pub semitones: f32,
    pub start: f32,
    pub end: f32,
    /// `Some(seconds)` plays that long and then fades out (a gate); `None` plays to the end of the
    /// trimmed region, which is what a drum one-shot wants.
    pub hold: Option<f32>,
}

impl Default for SampleParams {
    fn default() -> Self {
        SampleParams { gain: 1.0, semitones: 0.0, start: 0.0, end: 1.0, hold: None }
    }
}

const FADE_IN_FRAMES: f64 = 24.0;
const FADE_OUT_FRAMES: f64 = 176.0;
const RELEASE_FRAMES: u64 = 320;

/// One playing hit. Finite: it ends when the trimmed region is used up, the hold time passes, or
/// `cancel` is set, and every way of ending fades out over a few milliseconds instead of cutting.
pub struct SampleVoice {
    sample: Arc<DecodedSample>,
    pos: f64,
    end: f64,
    rate: f64,
    gain: f32,
    fade_in: bool,
    out_frames: u64,
    hold_frames: Option<u64>,
    release_start: Option<u64>,
    cancel: Option<Arc<AtomicBool>>,
    cur: [f32; 2],
    phase: u8,
    done: bool,
}

impl SampleVoice {
    pub fn new(sample: Arc<DecodedSample>, params: SampleParams, cancel: Option<Arc<AtomicBool>>) -> Self {
        let len = sample.frames.len() as f64;
        let start = params.start.clamp(0.0, 1.0) as f64 * len;
        let end = (params.end.clamp(0.0, 1.0) as f64 * len).min(len);
        let rate = 2.0f64.powf(params.semitones.clamp(-24.0, 24.0) as f64 / 12.0);
        SampleVoice {
            pos: start,
            end,
            rate,
            gain: params.gain.max(0.0),
            fade_in: start > 0.5,
            out_frames: 0,
            hold_frames: params.hold.map(|h| (h.max(0.0) as f64 * ENGINE_SAMPLE_RATE as f64) as u64),
            release_start: None,
            cancel,
            cur: [0.0; 2],
            phase: 0,
            done: end - start < 1.0,
            sample,
        }
    }

    fn next_frame(&mut self) -> Option<[f32; 2]> {
        if self.done {
            return None;
        }
        if self.release_start.is_none() {
            let cancelled = self.cancel.as_ref().map_or(false, |c| c.load(Ordering::Relaxed));
            let held = self.hold_frames.map_or(false, |h| self.out_frames >= h);
            if cancelled || held {
                self.release_start = Some(self.out_frames);
            }
        }
        let remaining = (self.end - self.pos) / self.rate;
        if remaining <= 0.0 {
            self.done = true;
            return None;
        }

        let mut env = self.gain;
        if self.fade_in && (self.out_frames as f64) < FADE_IN_FRAMES {
            env *= self.out_frames as f32 / FADE_IN_FRAMES as f32;
        }
        if remaining < FADE_OUT_FRAMES {
            env *= (remaining / FADE_OUT_FRAMES) as f32;
        }
        if let Some(rs) = self.release_start {
            let t = self.out_frames - rs;
            if t >= RELEASE_FRAMES {
                self.done = true;
                return None;
            }
            env *= 1.0 - t as f32 / RELEASE_FRAMES as f32;
        }

        let frames = &self.sample.frames;
        let i0 = (self.pos as usize).min(frames.len() - 1);
        let f = (self.pos - i0 as f64) as f32;
        let (a, b) = (frames[i0], frames[(i0 + 1).min(frames.len() - 1)]);
        let out = [(a[0] + (b[0] - a[0]) * f) * env, (a[1] + (b[1] - a[1]) * f) * env];

        self.pos += self.rate;
        self.out_frames += 1;
        Some(out)
    }
}

impl Iterator for SampleVoice {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.phase == 0 {
            self.cur = self.next_frame()?;
        }
        let s = self.cur[self.phase as usize];
        self.phase = (self.phase + 1) % 2;
        Some(s)
    }
}

impl Source for SampleVoice {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        2
    }
    fn sample_rate(&self) -> u32 {
        ENGINE_SAMPLE_RATE
    }
    fn total_duration(&self) -> Option<std::time::Duration> {
        None
    }
}

/// One scheduled sample hit in an offline render (`render_events_to_wav`).
#[derive(Clone, Debug)]
pub struct SampleEvent {
    pub start_time: f64,
    pub path: String,
    pub params: SampleParams,
}

// --- Folders ------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Audio files directly inside (folders only).
    pub audio_count: u32,
    /// Sub-folders directly inside (folders only).
    pub dir_count: u32,
}

fn roots() -> &'static Mutex<Vec<PathBuf>> {
    static ROOTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
    ROOTS.get_or_init(|| Mutex::new(Vec::new()))
}

/// The user's Music folder, where the OS keeps it. `ENTROPY_MUSIC_DIR` overrides it: the live
/// tests point the browser at a folder of generated samples with known frequencies instead of
/// whatever a machine happens to have.
pub fn music_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("ENTROPY_MUSIC_DIR") {
        return Some(PathBuf::from(dir));
    }
    directories::UserDirs::new().and_then(|u| u.audio_dir().map(|p| p.to_path_buf()))
}

/// Allows `list_dir` under `root`. Called for the Music folder and for a folder the user picked in
/// a native dialog; never for a path an addon merely names.
pub fn allow_root(root: &Path) -> Result<(), String> {
    let canon = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let mut r = roots().lock().unwrap();
    if !r.contains(&canon) {
        r.push(canon);
    }
    Ok(())
}

pub fn is_allowed(path: &Path) -> bool {
    let Ok(canon) = std::fs::canonicalize(path) else { return false };
    roots().lock().unwrap().iter().any(|root| canon.starts_with(root))
}

/// Folders first, then audio files, each sorted case-insensitively. Hidden entries and files that
/// are not audio are left out. `path` must lie inside an allowed root.
pub fn list_dir(path: &Path) -> Result<Vec<DirEntryInfo>, String> {
    if !is_allowed(path) {
        return Err(format!("{} is outside the folders the sample browser may read", path.display()));
    }
    let read = std::fs::read_dir(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let p = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            let (mut audio_count, mut dir_count) = (0u32, 0u32);
            if let Ok(inner) = std::fs::read_dir(&p) {
                for e in inner.flatten() {
                    let n = e.file_name();
                    if n.to_string_lossy().starts_with('.') {
                        continue;
                    }
                    match e.metadata() {
                        Ok(m) if m.is_dir() => dir_count += 1,
                        Ok(_) if is_audio_file(&e.path()) => audio_count += 1,
                        _ => {}
                    }
                }
            }
            dirs.push(DirEntryInfo { name, path: p.to_string_lossy().into_owned(), is_dir: true, size: 0, audio_count, dir_count });
        } else if is_audio_file(&p) {
            files.push(DirEntryInfo { name, path: p.to_string_lossy().into_owned(), is_dir: false, size: meta.len(), audio_count: 0, dir_count: 0 });
        }
    }
    let by_name = |a: &DirEntryInfo, b: &DirEntryInfo| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    dirs.extend(files);
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("entropy-samples-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A sine at `hz`, `amp` of full scale, as a 16-bit WAV with `channels` identical channels.
    fn write_sine(path: &Path, rate: u32, channels: u16, seconds: f64, hz: f64, amp: f64) {
        let spec = hound::WavSpec { channels, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..(seconds * rate as f64) as usize {
            let v = (amp * (2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64).sin() * i16::MAX as f64) as i16;
            for _ in 0..channels {
                w.write_sample(v).unwrap();
            }
        }
        w.finalize().unwrap();
    }

    fn voice_of(path: &Path, params: SampleParams) -> Vec<f32> {
        let s = Arc::new(decode_file(path, MAX_SAMPLE_SECONDS).unwrap());
        SampleVoice::new(s, params, None).collect()
    }

    #[test]
    fn a_mono_file_at_another_rate_arrives_stereo_at_the_engine_rate() {
        let dir = scratch("mono");
        let f = dir.join("tone.wav");
        write_sine(&f, 22_050, 1, 0.5, 440.0, 0.5);
        let s = decode_file(&f, MAX_SAMPLE_SECONDS).unwrap();
        assert_eq!((s.source_rate, s.source_channels), (22_050, 1));
        assert!((s.seconds() - 0.5).abs() < 0.002, "{}", s.seconds());
        assert!(s.frames.iter().all(|f| f[0] == f[1]), "mono must be duplicated into both channels");
        assert!((s.peak() - 0.5).abs() < 0.02, "peak {}", s.peak());
        assert!(!s.truncated);
    }

    #[test]
    fn a_long_file_is_cut_at_the_cap_and_says_so() {
        let dir = scratch("long");
        let f = dir.join("long.wav");
        write_sine(&f, 44_100, 2, 3.0, 220.0, 0.3);
        let s = decode_file(&f, 1.0).unwrap();
        assert!(s.truncated);
        assert!((s.seconds() - 1.0).abs() < 0.001, "{}", s.seconds());
        assert!((s.full_seconds.unwrap() - 3.0).abs() < 0.01, "{:?}", s.full_seconds);
    }

    #[test]
    fn only_audio_files_decode() {
        let dir = scratch("kind");
        let f = dir.join("notes.txt");
        std::fs::write(&f, "not audio").unwrap();
        assert!(decode_file(&f, 1.0).unwrap_err().contains("not a supported audio file"));
        let bad = dir.join("broken.wav");
        std::fs::write(&bad, "RIFFnope").unwrap();
        assert!(decode_file(&bad, 1.0).is_err());
    }

    #[test]
    fn waveform_is_normalised_to_its_loudest_bin() {
        let dir = scratch("wave");
        let f = dir.join("quiet.wav");
        write_sine(&f, 44_100, 1, 0.5, 100.0, 0.05);
        let s = decode_file(&f, 1.0).unwrap();
        let w = s.waveform(64);
        assert_eq!(w.len(), 64);
        assert!((w.iter().cloned().fold(0.0, f32::max) - 1.0).abs() < 1e-6);
        assert!(s.peak() < 0.06, "a quiet sample stays quiet: {}", s.peak());
    }

    #[test]
    fn pitching_up_an_octave_halves_the_length_and_gain_scales() {
        let dir = scratch("pitch");
        let f = dir.join("tone.wav");
        write_sine(&f, 44_100, 1, 1.0, 200.0, 0.4);
        let plain = voice_of(&f, SampleParams::default());
        let octave = voice_of(&f, SampleParams { semitones: 12.0, ..Default::default() });
        let quiet = voice_of(&f, SampleParams { gain: 0.5, ..Default::default() });
        assert!((plain.len() as f64 / 2.0 - 44_100.0).abs() < 4.0, "{}", plain.len());
        assert!((octave.len() as f64 / plain.len() as f64 - 0.5).abs() < 0.01, "{} vs {}", octave.len(), plain.len());
        let peak = |v: &[f32]| v.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((peak(&quiet) / peak(&plain) - 0.5).abs() < 0.01);
    }

    #[test]
    fn a_trim_plays_only_the_chosen_slice() {
        let dir = scratch("trim");
        let f = dir.join("tone.wav");
        write_sine(&f, 44_100, 1, 1.0, 200.0, 0.4);
        let slice = voice_of(&f, SampleParams { start: 0.25, end: 0.75, ..Default::default() });
        assert!((slice.len() as f64 / 2.0 - 22_050.0).abs() < 4.0, "{}", slice.len());
        assert!(slice[0].abs() < 0.05, "a trimmed start fades in instead of clicking: {}", slice[0]);
        let empty = voice_of(&f, SampleParams { start: 0.5, end: 0.5, ..Default::default() });
        assert!(empty.is_empty());
    }

    #[test]
    fn a_hold_gates_the_sample_and_a_cancel_stops_it_within_milliseconds() {
        let dir = scratch("gate");
        let f = dir.join("tone.wav");
        write_sine(&f, 44_100, 1, 2.0, 200.0, 0.4);
        let held = voice_of(&f, SampleParams { hold: Some(0.1), ..Default::default() });
        let frames = held.len() / 2;
        assert!((frames as f64 - (4_410.0 + RELEASE_FRAMES as f64)).abs() < 4.0, "{frames}");
        assert!(held[held.len() - 2].abs() < 0.01, "the gate must fade out");

        let cancel = Arc::new(AtomicBool::new(false));
        let s = Arc::new(decode_file(&f, MAX_SAMPLE_SECONDS).unwrap());
        let mut v = SampleVoice::new(s, SampleParams::default(), Some(cancel.clone()));
        for _ in 0..2000 {
            v.next();
        }
        cancel.store(true, Ordering::Relaxed);
        let rest = v.count();
        assert!(rest / 2 <= RELEASE_FRAMES as usize + 1, "{} frames after cancel", rest / 2);
    }

    #[test]
    fn a_second_load_is_the_same_memory_and_an_edit_reloads() {
        let dir = scratch("cache");
        let f = dir.join("tone.wav");
        write_sine(&f, 44_100, 1, 0.2, 300.0, 0.4);
        let key = f.to_string_lossy().into_owned();
        let a = load(&key).unwrap();
        let b = load(&key).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "a repeat load must not decode again");
        write_sine(&f, 44_100, 1, 0.4, 300.0, 0.4);
        let c = load(&key).unwrap();
        assert!(!Arc::ptr_eq(&a, &c) && c.frames.len() > a.frames.len(), "a changed file must be decoded again");
    }

    #[test]
    fn listing_is_limited_to_allowed_roots_and_shows_only_audio() {
        let dir = scratch("list");
        std::fs::create_dir_all(dir.join("Kicks")).unwrap();
        std::fs::create_dir_all(dir.join("808s")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        write_sine(&dir.join("Kicks").join("k1.wav"), 44_100, 1, 0.1, 60.0, 0.5);
        write_sine(&dir.join("Kicks").join("k2.WAV"), 44_100, 1, 0.1, 60.0, 0.5);
        std::fs::write(dir.join("Kicks").join("readme.txt"), "x").unwrap();
        write_sine(&dir.join("snare.wav"), 44_100, 1, 0.1, 200.0, 0.5);
        std::fs::write(dir.join("cover.jpg"), "x").unwrap();

        let outside = scratch("outside");
        assert!(list_dir(&dir).unwrap_err().contains("outside"), "nothing is readable before a root is allowed");

        allow_root(&dir).unwrap();
        let names: Vec<(String, bool)> = list_dir(&dir).unwrap().into_iter().map(|e| (e.name, e.is_dir)).collect();
        assert_eq!(names, vec![("808s".into(), true), ("Kicks".into(), true), ("snare.wav".into(), false)]);
        let kicks = list_dir(&dir).unwrap().into_iter().find(|e| e.name == "Kicks").unwrap();
        assert_eq!((kicks.audio_count, kicks.dir_count), (2, 0), "a folder row says how many samples are inside");
        assert_eq!(list_dir(&dir.join("Kicks")).unwrap().len(), 2, "sub-folders of an allowed root are allowed");

        assert!(list_dir(&outside).is_err(), "a sibling folder is not covered");
        let escape = dir.join("Kicks").join("..").join("..").join(outside.file_name().unwrap());
        assert!(list_dir(&escape).is_err(), "a .. escape is resolved before it is checked");
    }
}

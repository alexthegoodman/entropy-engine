//! Engine tier for drum-rack samples: `tests/features/sample_rack.feature` runs against the real
//! `AudioEngine` and the real output device. Generated WAV files of known frequency and level are
//! played through the same track buses the DAW uses, and the analysis taps the analyzer widgets read
//! say what came out. No window, no addon; nothing here judges how anything sounds.
//!
//! Fixtures are written to `test-artifacts/sample-rack/` so a failing run can be opened and listened
//! to by a person.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::analysis::to_db;
use entropy_engine::audio::samples::{self, SampleEvent, SampleParams};
use entropy_engine::audio::{render_events_to_wav, AudioEngine, MASTER_SOURCE};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const RATE: u32 = 44_100;

#[derive(cucumber::World)]
struct RackWorld {
    engine: Option<Arc<AudioEngine>>,
    dir: PathBuf,
    /// Result of the last `I try to play`.
    last_error: Option<String>,
    loaded: Option<Arc<samples::DecodedSample>>,
    rendered: Option<PathBuf>,
}

impl Default for RackWorld {
    fn default() -> Self {
        let dir = std::env::current_dir().unwrap().join("test-artifacts").join("sample-rack");
        std::fs::create_dir_all(&dir).unwrap();
        Self { engine: None, dir, last_error: None, loaded: None, rendered: None }
    }
}

impl std::fmt::Debug for RackWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RackWorld")
    }
}

impl RackWorld {
    fn engine(&self) -> &Arc<AudioEngine> {
        self.engine.as_ref().expect("the real audio engine step comes first")
    }
    fn path(&self, name: &str) -> String {
        self.dir.join(name).to_string_lossy().into_owned()
    }
}

fn source(name: &str) -> &str {
    if name == "master" { MASTER_SOURCE } else { name }
}

fn write_wav(path: &str, rate: u32, parts: &[(f64, u64)], amp: f64) {
    let spec = hound::WavSpec { channels: 1, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    let mut n = 0usize;
    for &(hz, ms) in parts {
        for _ in 0..(rate as u64 * ms / 1000) {
            let v = amp * (2.0 * std::f64::consts::PI * hz * n as f64 / rate as f64).sin();
            w.write_sample((v * i16::MAX as f64) as i16).unwrap();
            n += 1;
        }
    }
    w.finalize().unwrap();
}

// --- Setup -----------------------------------------------------------------------------------------

#[given("the real audio engine")]
fn real_engine(world: &mut RackWorld) {
    world.engine = Some(Arc::new(AudioEngine::new()));
}

#[given(expr = "a track {string} at full gain")]
#[when(expr = "a track {string} at full gain")]
fn track(world: &mut RackWorld, id: String) {
    world.engine().ensure_track_bus(&id, 1.0, false, false, &[]);
}

#[given(expr = "a generated sample {string} that is a {int} Hz sine of {int} ms")]
fn sine(world: &mut RackWorld, name: String, hz: u32, ms: u64) {
    write_wav(&world.path(&name), RATE, &[(hz as f64, ms)], 0.5);
}

#[given(expr = "a generated sample {string} that is {int} Hz for {int} ms and then {int} Hz for {int} ms")]
fn two_part(world: &mut RackWorld, name: String, a: u32, a_ms: u64, b: u32, b_ms: u64) {
    write_wav(&world.path(&name), RATE, &[(a as f64, a_ms), (b as f64, b_ms)], 0.5);
}

#[given(expr = "a generated {int} Hz mono sample {string} at {int} Hz sample rate of {int} ms")]
fn odd_rate(world: &mut RackWorld, hz: u32, name: String, rate: u32, ms: u64) {
    write_wav(&world.path(&name), rate, &[(hz as f64, ms)], 0.5);
}

#[given(expr = "a file {string} that is not audio")]
fn not_audio(world: &mut RackWorld, name: String) {
    std::fs::write(world.path(&name), "RIFF but not really").unwrap();
}

// --- Playing ---------------------------------------------------------------------------------------

fn play(world: &mut RackWorld, name: &str, track: &str, params: SampleParams) {
    let path = world.path(name);
    world.engine().play_sample_on_track(track, &path, params).unwrap_or_else(|e| panic!("{name} on {track}: {e}"));
}

#[when(expr = "I play {string} on {string}")]
fn play_plain(world: &mut RackWorld, name: String, track: String) {
    play(world, &name, &track, SampleParams::default());
}

#[when(expr = "I play {string} on {string} at gain {float}")]
fn play_gain(world: &mut RackWorld, name: String, track: String, gain: f32) {
    play(world, &name, &track, SampleParams { gain, ..Default::default() });
}

#[when(expr = "I play {string} on {string} pitched {int} semitones")]
fn play_pitched(world: &mut RackWorld, name: String, track: String, semitones: i32) {
    play(world, &name, &track, SampleParams { semitones: semitones as f32, ..Default::default() });
}

#[when(expr = "I play {string} on {string} from {float} to {float}")]
fn play_trim(world: &mut RackWorld, name: String, track: String, start: f32, end: f32) {
    play(world, &name, &track, SampleParams { start, end, ..Default::default() });
}

#[when(expr = "I play {string} on {string} gated to {int} ms")]
fn play_gated(world: &mut RackWorld, name: String, track: String, ms: u32) {
    play(world, &name, &track, SampleParams { hold: Some(ms as f32 / 1000.0), ..Default::default() });
}

#[when(expr = "I try to play {string} on {string}")]
fn try_play(world: &mut RackWorld, name: String, track: String) {
    let path = world.path(&name);
    world.last_error = world.engine().play_sample_on_track(&track, &path, SampleParams::default()).err();
}

#[then(expr = "it fails saying {string}")]
fn fails(world: &mut RackWorld, text: String) {
    let e = world.last_error.clone().expect("the play succeeded, expected an error");
    assert!(e.contains(&text), "the error was {e:?}, expected it to contain {text:?}");
}

#[when(expr = "I audition {string}")]
fn audition(world: &mut RackWorld, name: String) {
    let path = world.path(&name);
    world.engine().preview_sample(&path, SampleParams::default()).unwrap();
}

#[when("I stop the audition")]
fn stop_audition(world: &mut RackWorld) {
    world.engine().stop_preview();
}

#[when(expr = "I let the audio run for {int} ms")]
fn run_audio(_world: &mut RackWorld, ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

#[when(expr = "I mute {string}")]
fn mute(world: &mut RackWorld, id: String) {
    world.engine().ensure_track_bus(&id, 1.0, true, false, &[]);
}

#[when(expr = "I remove the track {string}")]
fn remove(world: &mut RackWorld, id: String) {
    world.engine().remove_track_bus(&id);
}

// --- What the taps heard ---------------------------------------------------------------------------

#[then(expr = "the {string} spectrum peaks within {int} Hz of {int} Hz")]
fn peaks_at(world: &mut RackWorld, name: String, tolerance: u32, hz: u32) {
    let spec = world.engine().spectrum(source(&name), 4096).unwrap_or_else(|| panic!("no source {name:?}"));
    println!("    {name}: peak {:.1} Hz at {:.2} dBFS", spec.peak_hz, spec.peak_db);
    assert!((spec.peak_hz - hz as f32).abs() <= tolerance as f32, "{name} peaks at {} Hz, expected {hz} +/- {tolerance}", spec.peak_hz);
}

#[then(expr = "the {string} spectrum peak reads {float} dBFS within {float} dB")]
fn peak_level(world: &mut RackWorld, name: String, db: f32, tolerance: f32) {
    let spec = world.engine().spectrum(source(&name), 4096).unwrap();
    println!("    {name}: peak {:.2} dBFS", spec.peak_db);
    assert!((spec.peak_db - db).abs() <= tolerance, "{name} peak reads {:.2} dBFS, expected {db} +/- {tolerance}", spec.peak_db);
}

#[then(expr = "the {string} spectrum has energy at {int} Hz and at {int} Hz")]
fn energy_at_two(world: &mut RackWorld, name: String, a: u32, b: u32) {
    let spec = world.engine().spectrum(source(&name), 4096).unwrap();
    let at = |hz: u32| {
        let k = (hz as f32 / spec.bin_hz()).round() as usize;
        spec.bins_db[k.saturating_sub(1)..=(k + 1).min(spec.bins_db.len() - 1)].iter().cloned().fold(f32::MIN, f32::max)
    };
    let floor = spec.bins_db[spec.bins_db.len() / 2];
    println!("    {name}: {a} Hz {:.1} dBFS, {b} Hz {:.1} dBFS, mid-spectrum floor {floor:.1} dBFS", at(a), at(b));
    assert!(at(a) > -30.0 && at(b) > -30.0 && at(a) > floor + 30.0 && at(b) > floor + 30.0, "both tones must stand well above the floor");
}

#[then(expr = "the {string} spectrum has no energy at {int} Hz")]
fn no_energy(world: &mut RackWorld, name: String, hz: u32) {
    let spec = world.engine().spectrum(source(&name), 4096).unwrap();
    let k = (hz as f32 / spec.bin_hz()).round() as usize;
    let level = spec.bins_db[k.saturating_sub(1)..=(k + 1).min(spec.bins_db.len() - 1)].iter().cloned().fold(f32::MIN, f32::max);
    println!("    {name}: {hz} Hz reads {level:.1} dBFS against a peak of {:.1}", spec.peak_db);
    assert!(level < spec.peak_db - 40.0, "{name} still has {level:.1} dBFS at {hz} Hz");
}

fn tap_peak_db(world: &RackWorld, name: &str) -> f32 {
    let snap = world.engine().snapshot(source(name), 1024).unwrap();
    to_db(snap.left.iter().chain(snap.right.iter()).fold(0.0f32, |m, v| m.max(v.abs())))
}

#[then(expr = "the {string} tap is silent")]
fn silent(world: &mut RackWorld, name: String) {
    let db = tap_peak_db(world, &name);
    assert!(db < -80.0, "{name} still carries {db:.1} dBFS");
}

#[then(expr = "the {string} tap is not silent")]
fn not_silent(world: &mut RackWorld, name: String) {
    let db = tap_peak_db(world, &name);
    assert!(db > -40.0, "{name} carries only {db:.1} dBFS");
}

// --- Loading ---------------------------------------------------------------------------------------

#[when(expr = "I load {string}")]
fn load(world: &mut RackWorld, name: String) {
    world.loaded = Some(samples::load(&world.path(&name)).unwrap());
}

#[then(expr = "the sample is truncated at {int} seconds of a {int} second file")]
fn truncated(world: &mut RackWorld, cap: f64, full: f64) {
    let s = world.loaded.as_ref().unwrap();
    assert!(s.truncated, "{s:?}");
    assert!((s.seconds() - cap).abs() < 0.01, "{}", s.seconds());
    assert!((s.full_seconds.unwrap() - full).abs() < 0.05, "{:?}", s.full_seconds);
}

#[then(expr = "the sample was {int} Hz mono")]
fn was(world: &mut RackWorld, rate: u32) {
    let s = world.loaded.as_ref().unwrap();
    assert_eq!((s.source_rate, s.source_channels), (rate, 1));
}

#[then(expr = "the sample is {float} seconds long within {float}")]
fn seconds_long(world: &mut RackWorld, secs: f64, tol: f64) {
    let s = world.loaded.as_ref().unwrap();
    assert!((s.seconds() - secs).abs() <= tol, "{}", s.seconds());
}

#[then(expr = "its {int}-bin waveform has a loudest bin of 1")]
fn waveform(world: &mut RackWorld, bins: usize) {
    let w = world.loaded.as_ref().unwrap().waveform(bins);
    assert_eq!(w.len(), bins);
    assert!((w.iter().cloned().fold(0.0, f32::max) - 1.0).abs() < 1e-6);
}

#[then(expr = "its peak is {float} within {float}")]
fn peak_is(world: &mut RackWorld, peak: f32, tol: f32) {
    let p = world.loaded.as_ref().unwrap().peak();
    assert!((p - peak).abs() <= tol, "{p}");
}

// --- Offline export --------------------------------------------------------------------------------

fn render(world: &mut RackWorld, hits: &[(&str, f64)]) {
    let events: Vec<SampleEvent> = hits
        .iter()
        .map(|(name, t)| SampleEvent { start_time: *t, path: world.path(name), params: SampleParams::default() })
        .collect();
    let out = world.dir.join("rendered.wav");
    render_events_to_wav(&[], &events, RATE, &out).unwrap();
    world.rendered = Some(out);
}

#[when(expr = "I render {string} at {float} seconds to a WAV")]
fn render_one(world: &mut RackWorld, name: String, t: f64) {
    render(world, &[(&name, t)]);
}

#[when(expr = "I render {string} at {float} seconds and {string} at {float} seconds to a WAV")]
fn render_two(world: &mut RackWorld, a: String, ta: f64, b: String, tb: f64) {
    render(world, &[(&a, ta), (&b, tb)]);
}

fn rendered(world: &RackWorld) -> Vec<f32> {
    let mut r = hound::WavReader::open(world.rendered.as_ref().expect("a render step comes first")).unwrap();
    assert_eq!((r.spec().channels, r.spec().sample_rate), (2, RATE));
    r.samples::<i16>().map(|s| s.unwrap() as f32 / i16::MAX as f32).collect()
}

#[then(expr = "the rendered WAV is {float} seconds long within {float}")]
fn rendered_length(world: &mut RackWorld, secs: f64, tol: f64) {
    let frames = rendered(world).len() / 2;
    let got = frames as f64 / RATE as f64;
    assert!((got - secs).abs() <= tol, "{got}");
}

#[then(expr = "the rendered WAV is silent before {float} seconds")]
fn rendered_silent_before(world: &mut RackWorld, secs: f64) {
    let v = rendered(world);
    let n = (secs * RATE as f64) as usize * 2;
    let peak = v[..n.min(v.len())].iter().fold(0.0f32, |m, s| m.max(s.abs()));
    assert!(peak < 0.001, "{peak} before {secs} s");
}

#[then(expr = "the rendered WAV is audible after {float} seconds")]
fn rendered_audible_after(world: &mut RackWorld, secs: f64) {
    let v = rendered(world);
    let n = (secs * RATE as f64) as usize * 2;
    let peak = v[n.min(v.len())..].iter().fold(0.0f32, |m, s| m.max(s.abs()));
    assert!(peak > 0.1, "{peak} after {secs} s");
}

#[then(expr = "the rendered WAV's loudest sample is {float} within {float}")]
fn rendered_peak(world: &mut RackWorld, peak: f32, tol: f32) {
    let p = rendered(world).iter().fold(0.0f32, |m, s| m.max(s.abs()));
    assert!((p - peak).abs() <= tol, "{p}");
}

fn main() {
    futures::executor::block_on(
        RackWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/sample_rack.feature"),
    );
}

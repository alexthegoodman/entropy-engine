//! Engine tier for the audio analysis taps: `tests/features/audio_analysis.feature` runs against
//! the real `AudioEngine` and the real output device, playing notes through the same per-track
//! buses the DAW uses and reading the taps the analyzer widgets read. No window, no widgets; what
//! is asserted is that the numbers a widget would draw are the numbers the audio actually has.
//!
//! Needs an audio output device, like `vst3_live`. Nothing here judges how anything sounds.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::analysis::to_db;
use entropy_engine::audio::{AudioEngine, NoteParams, MASTER_SOURCE};
use std::sync::Arc;
use std::time::Duration;

#[derive(Default, cucumber::World)]
struct EngineWorld {
    engine: Option<Arc<AudioEngine>>,
    /// Muted flag per track, since `ensure_track_bus` takes the full state each call.
    muted: std::collections::HashMap<String, bool>,
}

impl std::fmt::Debug for EngineWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "EngineWorld")
    }
}

impl EngineWorld {
    fn engine(&self) -> &Arc<AudioEngine> {
        self.engine.as_ref().expect("the real audio engine step comes first")
    }
}

fn source(name: &str) -> &str {
    if name == "master" { MASTER_SOURCE } else { name }
}

#[given("the real audio engine")]
fn real_engine(world: &mut EngineWorld) {
    world.engine = Some(Arc::new(AudioEngine::new()));
}

#[given(expr = "a track {string} at full gain")]
fn track(world: &mut EngineWorld, id: String) {
    world.engine().ensure_track_bus(&id, 1.0, false, false, &[]);
    world.muted.insert(id, false);
}

fn sine(engine: &AudioEngine, track: &str, hz: f64, ms: u64) {
    engine.play_note_on_track(
        track,
        "sine",
        NoteParams { freq: hz, duration: ms as f64 / 1000.0, cutoff: 20000.0, gain: 0.5, attack: 0.001, decay: 0.001, sustain: 1.0, release: 0.001, ..Default::default() },
    );
}

#[when(expr = "I play a {int} Hz sine on {string} for {int} ms")]
fn play_sine(world: &mut EngineWorld, hz: u32, track: String, ms: u32) {
    sine(world.engine(), &track, hz as f64, ms as u64);
}

#[when(expr = "I play a {int} ms full-scale kick on {string}")]
fn play_kick(world: &mut EngineWorld, ms: u32, track: String) {
    // A 100 Hz sine at gain 2.0 through a centred pan peaks at 1.41: a hit well above full scale
    // on the meter, which is what a peak meter must catch even though it is over in 60 ms.
    world.engine().play_note_on_track(
        &track,
        "sine",
        NoteParams { freq: 100.0, duration: ms as f64 / 1000.0, cutoff: 20000.0, gain: 2.0, attack: 0.001, decay: 0.001, sustain: 1.0, release: 0.001, ..Default::default() },
    );
}

#[when(expr = "I let the audio run for {int} ms")]
fn run_audio(_world: &mut EngineWorld, ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

#[when(expr = "I mute {string}")]
fn mute(world: &mut EngineWorld, id: String) {
    world.engine().ensure_track_bus(&id, 1.0, true, false, &[]);
    world.muted.insert(id, true);
}

#[when(expr = "I remove the track {string}")]
fn remove(world: &mut EngineWorld, id: String) {
    world.engine().remove_track_bus(&id);
}

#[then(expr = "the {string} spectrum peaks within {int} Hz of {int} Hz")]
fn peaks_at(world: &mut EngineWorld, name: String, tolerance: u32, hz: u32) {
    let spec = world.engine().spectrum(source(&name), 4096).unwrap_or_else(|| panic!("no source {name:?}"));
    println!("    {name}: peak {:.1} Hz at {:.2} dBFS, centroid {:.0} Hz", spec.peak_hz, spec.peak_db, spec.centroid_hz);
    assert!((spec.peak_hz - hz as f32).abs() <= tolerance as f32, "{name} peaks at {} Hz, expected {hz} +/- {tolerance}", spec.peak_hz);
}

#[then(expr = "the {string} spectrum peak reads {float} dBFS within {float} dB")]
fn peak_level(world: &mut EngineWorld, name: String, db: f32, tolerance: f32) {
    let spec = world.engine().spectrum(source(&name), 4096).unwrap();
    assert!((spec.peak_db - db).abs() <= tolerance, "{name} peak reads {:.2} dBFS, expected {db} +/- {tolerance}", spec.peak_db);
}

#[then(expr = "the {string} spectrum has energy at {int} Hz and at {int} Hz")]
fn energy_at_two(world: &mut EngineWorld, name: String, a: u32, b: u32) {
    let spec = world.engine().spectrum(source(&name), 4096).unwrap();
    let at = |hz: u32| {
        let k = (hz as f32 / spec.bin_hz()).round() as usize;
        spec.bins_db[k.saturating_sub(1)..=(k + 1).min(spec.bins_db.len() - 1)].iter().cloned().fold(f32::MIN, f32::max)
    };
    let floor = spec.bins_db[spec.bins_db.len() / 2];
    println!("    {name}: {a} Hz {:.1} dBFS, {b} Hz {:.1} dBFS, mid-spectrum floor {floor:.1} dBFS", at(a), at(b));
    assert!(at(a) > -30.0 && at(b) > -30.0 && at(a) > floor + 40.0 && at(b) > floor + 40.0, "both tones must stand well above the floor");
}

#[then(expr = "the {string} tap is silent")]
fn silent(world: &mut EngineWorld, name: String) {
    let snap = world.engine().snapshot(source(&name), 1024).unwrap();
    let peak = snap.left.iter().chain(snap.right.iter()).fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(to_db(peak) < -80.0, "{name} still carries {:.1} dBFS", to_db(peak));
}

#[then(expr = "{string} is no longer a source")]
fn gone(world: &mut EngineWorld, name: String) {
    assert!(world.engine().tap(&name).is_none());
    assert!(!world.engine().track_ids().contains(&name));
}

#[when(expr = "a meter reads {string} for the first time")]
fn first_read(world: &mut EngineWorld, name: String) {
    world.engine().levels(&name, "meter");
}

#[when(expr = "meter {string} and meter {string} both read {string} for the first time")]
fn both_first_read(world: &mut EngineWorld, a: String, b: String, name: String) {
    world.engine().levels(&name, &a);
    world.engine().levels(&name, &b);
}

#[then(expr = "a fixed 20 ms trailing window on {string} has missed it")]
fn trailing_misses(world: &mut EngineWorld, name: String) {
    let snap = world.engine().snapshot(&name, 882).unwrap();
    let peak = snap.left.iter().chain(snap.right.iter()).fold(0.0f32, |m, v| m.max(v.abs()));
    println!("    the trailing 20 ms window reads {:.1} dBFS", to_db(peak));
    assert!(to_db(peak) < -40.0, "the trailing window sees {:.1} dBFS, so this scenario proves nothing", to_db(peak));
}

#[then(expr = "the meter's next read of {string} shows a peak above {int} dBFS")]
fn meter_sees_it(world: &mut EngineWorld, name: String, floor: i32) {
    let l = world.engine().levels(&name, "meter").unwrap();
    println!("    since-last-read peak {:.1} dBFS over {} frames", to_db(l.peak[0].max(l.peak[1])), l.frames);
    assert!(to_db(l.peak[0].max(l.peak[1])) > floor as f32, "{:?}", l);
}

#[then(expr = "meter {string} reads a peak above {int} dBFS on {string}")]
fn named_meter(world: &mut EngineWorld, meter: String, floor: i32, name: String) {
    let l = world.engine().levels(&name, &meter).unwrap();
    assert!(to_db(l.peak[0].max(l.peak[1])) > floor as f32, "meter {meter}: {:?}", l);
}

fn main() {
    futures::executor::block_on(
        EngineWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/audio_analysis.feature"),
    );
}

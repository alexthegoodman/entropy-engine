//! Offline WAV export for VST3-hosted tracks: `tests/features/vst3_offline_render.feature`.
//!
//! Drives `entropy_engine::audio::render_events_full_to_wav` exactly as the DAW's "Export to WAV"
//! button does, with real installed plugins (Vital, Massive) rendered through their own fresh,
//! temporary instances (`vst3::render_offline_track`) - no audio device, no mixer, no live registry.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::vst3::{self, OfflineNoteEvent, Vst3RenderTrack};
use std::path::PathBuf;

const SR: f32 = 44_100.0;

#[derive(Default, cucumber::World)]
struct Vst3RenderWorld {
    tracks: Vec<Vst3RenderTrack>,
    bounced: Option<Vec<i16>>,
    warnings: Vec<String>,
    seconds: f64,
}

impl std::fmt::Debug for Vst3RenderWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Vst3RenderWorld({} tracks)", self.tracks.len())
    }
}

#[given(expr = "a VST3 render track for the plugin {string}")]
fn add_track(world: &mut Vst3RenderWorld, name: String) {
    let path = vst3::find_plugin_path(&name).unwrap_or_else(|| panic!("{name}.vst3 is not installed"));
    world.tracks.push(Vst3RenderTrack { plugin_path: path, state: None, notes: Vec::new() });
}

#[given(expr = "a VST3 render track for the missing plugin {string}")]
fn add_missing_track(world: &mut Vst3RenderWorld, name: String) {
    world.tracks.push(Vst3RenderTrack { plugin_path: PathBuf::from(name), state: None, notes: Vec::new() });
}

#[given(expr = "its note at {float} seconds plays MIDI note {int} for {float} seconds")]
fn add_note(world: &mut Vst3RenderWorld, start: f64, note: u8, duration: f64) {
    world.tracks.last_mut().expect("no track to add a note to").notes.push(OfflineNoteEvent {
        start_time: start,
        duration,
        channel: 0,
        note,
        velocity: 100,
    });
}

#[when("I bounce the VST3 tracks to a WAV file")]
fn bounce(world: &mut Vst3RenderWorld) {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("vst3-offline-render");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bounce.wav");
    let (seconds, warnings) = entropy_engine::audio::render_events_full_to_wav(&[], &[], &[], &world.tracks, 44_100, &path)
        .expect("the bounce is written");
    println!("    rendered {seconds:.2}s, warnings: {warnings:?}");
    world.seconds = seconds;
    world.warnings = warnings;
    let mut reader = hound::WavReader::open(&path).expect("the WAV can be read back");
    world.bounced = Some(reader.samples::<i16>().map(|s| s.unwrap()).collect());
}

fn wav_slice(world: &Vst3RenderWorld, from: f32, to: f32) -> Vec<f32> {
    let w = world.bounced.as_ref().expect("no WAV was bounced");
    let (a, b) = (((from * SR) as usize) * 2, (((to * SR) as usize) * 2).min(w.len()));
    w[a..b].iter().map(|s| *s as f32 / 32768.0).collect()
}

fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

#[then(expr = "the WAV is silent before {float} seconds")]
fn wav_silent_before(world: &mut Vst3RenderWorld, t: f32) {
    let p = peak(&wav_slice(world, 0.0, t - 0.01));
    assert!(p < 1.0e-4, "there is sound before {t}s: peak {p}");
}

#[then(expr = "the WAV is audible from {float} seconds")]
fn wav_audible(world: &mut Vst3RenderWorld, t: f32) {
    let p = peak(&wav_slice(world, t + 0.02, t + 0.3));
    assert!(p > 0.01, "the note at {t}s is silent: peak {p}");
}

#[then(expr = "the WAV is silent between {float} and {float} seconds")]
fn wav_silent_between(world: &mut Vst3RenderWorld, from: f32, to: f32) {
    let p = peak(&wav_slice(world, from, to));
    assert!(p < 1.0e-4, "there is sound between {from}s and {to}s: peak {p}");
}

#[then(expr = "the render lasts between {float} and {float} seconds")]
fn lasts_between(world: &mut Vst3RenderWorld, min: f64, max: f64) {
    assert!(world.seconds >= min && world.seconds <= max, "{:.2}s is not within [{min}, {max}]", world.seconds);
}

#[then("the export has no vst3 warnings")]
fn no_warnings(world: &mut Vst3RenderWorld) {
    assert!(world.warnings.is_empty(), "unexpected warnings: {:?}", world.warnings);
}

#[then(expr = "the export has {int} vst3 warning")]
fn warning_count(world: &mut Vst3RenderWorld, n: usize) {
    assert_eq!(world.warnings.len(), n, "warnings: {:?}", world.warnings);
}

#[then(expr = "a vst3 warning mentions {string}")]
fn warning_mentions(world: &mut Vst3RenderWorld, needle: String) {
    assert!(world.warnings.iter().any(|w| w.contains(&needle)), "no warning mentions {needle:?}: {:?}", world.warnings);
}

fn main() {
    futures::executor::block_on(
        Vst3RenderWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/vst3_offline_render.feature"),
    );
}

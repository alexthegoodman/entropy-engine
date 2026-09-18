//! Headless VST3 hosting BDD: drives the real installed plugins through `Vst3Source` exactly the way
//! the audio thread does (`Iterator::next`), with no audio device and no window. The live tier that
//! opens editors and screenshots them is `tests/features/vst3_live.feature`, driven by the DAW example.
//!
//! Plugins are created and used on this one thread - see the module doc of `audio::vst3` for why
//! that is a requirement, not a convenience - so the cucumber run is a plain `block_on` with one
//! scenario at a time.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::vst3::{self, Vst3Instrument, Vst3PluginEntry, Vst3Source, BLOCK_FRAMES, SAMPLE_RATE};
use std::collections::HashMap;
use std::time::Instant;

#[derive(Default, cucumber::World)]
struct VstWorld {
    scan: Option<Vec<Vst3PluginEntry>>,
    instrument: Option<Vst3Instrument>,
    source: Option<Vst3Source>,
    plugin_name: String,
    rendered: Vec<f32>,
    render_wall_seconds: f64,
    remembered: HashMap<String, f32>,
    saved_state: Option<Vec<u8>>,
    unload_clean: Option<bool>,
}

impl std::fmt::Debug for VstWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "VstWorld({})", self.plugin_name)
    }
}

impl VstWorld {
    fn instrument(&self) -> &Vst3Instrument {
        self.instrument.as_ref().expect("a plugin must be loaded first")
    }

    fn load(&mut self, name: &str, state: Option<&[u8]>) {
        if let Some(old) = self.instrument.take() {
            self.source = None; // release the source's plugin reference before unloading
            assert!(old.unload());
        }
        let path = vst3::find_plugin_path(name).unwrap_or_else(|| panic!("{name}.vst3 is not installed"));
        let (instrument, source) = vst3::load_instrument(&path, state).unwrap_or_else(|e| panic!("{name}: {e}"));
        self.instrument = Some(instrument);
        self.source = Some(source);
        self.plugin_name = name.to_string();
    }

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }

    /// Peak of the interleaved stereo slice covering [from_s, to_s) seconds.
    fn peak_between(&self, from_s: f64, to_s: f64) -> f32 {
        let frames = |s: f64| ((s * SAMPLE_RATE as f64) as usize * 2).min(self.rendered.len());
        Self::peak(&self.rendered[frames(from_s)..frames(to_s)])
    }

    fn seconds_rendered(&self) -> f64 {
        self.rendered.len() as f64 / 2.0 / SAMPLE_RATE as f64
    }
}

#[when("I scan the VST3 folders")]
fn scan(world: &mut VstWorld) {
    let (entries, skipped) = vst3::scan_plugins(&vst3::default_scan_dirs());
    assert!(skipped.is_empty(), "plugins that failed to read: {skipped:?}");
    world.scan = Some(entries);
}

#[then(expr = "the scan lists {string} as an instrument")]
fn scan_lists_instrument(world: &mut VstWorld, name: String) {
    let entry = world.scan.as_ref().unwrap().iter().find(|e| e.name == name).unwrap_or_else(|| panic!("{name} not found"));
    assert!(entry.is_instrument, "{name} category was {}", entry.category);
    assert!(entry.has_midi_input, "{name} should accept MIDI");
}

#[then(expr = "the scan lists {string} as an effect with MIDI output")]
fn scan_lists_effect(world: &mut VstWorld, name: String) {
    let entry = world.scan.as_ref().unwrap().iter().find(|e| e.name == name).unwrap_or_else(|| panic!("{name} not found"));
    assert!(!entry.is_instrument, "{name} category was {}", entry.category);
    assert!(entry.has_midi_output);
}

#[given(expr = "I load the VST3 plugin {string}")]
fn load_plugin(world: &mut VstWorld, name: String) {
    world.load(&name, None);
}

#[when(expr = "I play MIDI note {int} at velocity {int} for {float} seconds")]
fn play_note(world: &mut VstWorld, note: u8, velocity: u8, seconds: f64) {
    world.instrument().note_on(0, note, velocity, seconds);
}

#[when(expr = "I render {float} seconds of audio")]
fn render(world: &mut VstWorld, seconds: f64) {
    let frames = (seconds * SAMPLE_RATE as f64) as usize;
    let source = world.source.as_mut().unwrap();
    let started = Instant::now();
    world.rendered = source.by_ref().take(frames * 2).collect();
    world.render_wall_seconds = started.elapsed().as_secs_f64();
    assert_eq!(world.rendered.len(), frames * 2);
}

#[when(expr = "I remember the peak as {string}")]
fn remember_peak(world: &mut VstWorld, key: String) {
    let peak = VstWorld::peak(&world.rendered);
    world.remembered.insert(key, peak);
}

#[then(expr = "the audio peak is above {float}")]
fn peak_above(world: &mut VstWorld, floor: f32) {
    let peak = VstWorld::peak(&world.rendered);
    println!("    {} peak = {peak:.4}", world.plugin_name);
    assert!(peak > floor, "{} peak {peak} not above {floor}", world.plugin_name);
}

#[then(expr = "the peak of the last {float} seconds is below the peak of the first {float} seconds")]
fn tail_quieter(world: &mut VstWorld, last: f64, first: f64) {
    let total = world.seconds_rendered();
    let tail = world.peak_between(total - last, total);
    let head = world.peak_between(0.0, first);
    println!("    {} head = {head:.4}, tail = {tail:.4}", world.plugin_name);
    assert!(tail < head, "tail {tail} should be below head {head}");
}

#[then(expr = "the peak is below {float} times the remembered peak {string}")]
fn peak_below_factor(world: &mut VstWorld, factor: f32, key: String) {
    let remembered = world.remembered[&key];
    let peak = VstWorld::peak(&world.rendered);
    println!("    {} remembered = {remembered:.4}, now = {peak:.4}", world.plugin_name);
    assert!(remembered > 0.02, "the remembered render was silent");
    assert!(peak < remembered * factor, "peak {peak} not below {factor} x {remembered}");
}

/// Exact (case-insensitive) name match first, since `find_parameters` is a substring search and
/// Vital has several parameters whose name merely contains "volume".
fn parameter_id(world: &VstWorld, name: &str) -> u32 {
    let found = world.instrument().find_parameters(name, 200);
    found
        .iter()
        .find(|p| p.name.eq_ignore_ascii_case(name))
        .or(found.first())
        .unwrap_or_else(|| panic!("no parameter matching {name:?}"))
        .id
}

#[when(expr = "I set the parameter {string} to {float}")]
fn set_parameter(world: &mut VstWorld, name: String, value: f64) {
    let id = parameter_id(world, &name);
    world.instrument().set_parameter(id, value).unwrap();
}

#[then(expr = "the parameter {string} reads {float}")]
fn parameter_reads(world: &mut VstWorld, name: String, expected: f64) {
    let id = parameter_id(world, &name);
    let actual = world.instrument().get_parameter(id).unwrap();
    assert!((actual - expected).abs() < 0.02, "{name} reads {actual}, expected {expected}");
}

#[when("I save the plugin state")]
fn save_state(world: &mut VstWorld) {
    world.saved_state = Some(world.instrument().save_state().expect("save_state"));
}

#[when("I load the plugin again from that state")]
fn reload_from_state(world: &mut VstWorld) {
    let state = world.saved_state.clone().expect("save the state first");
    let name = world.plugin_name.clone();
    world.load(&name, Some(&state));
}

#[then("the saved state is not empty")]
fn state_not_empty(world: &mut VstWorld) {
    let len = world.saved_state.as_ref().map(|s| s.len()).unwrap_or(0);
    println!("    {} state = {len} bytes", world.plugin_name);
    assert!(len > 0);
}

#[then("the plugin has an editor")]
fn has_editor(world: &mut VstWorld) {
    assert!(world.instrument().has_editor());
}

#[when("I unload the plugin while another thread pulls audio")]
fn unload_under_load(world: &mut VstWorld) {
    let mut source = world.source.take().unwrap();
    // Stands in for the audio thread: pulls until the source ends, then drops it (which is what
    // rodio's mixer does with a finished source).
    let audio_thread = std::thread::spawn(move || {
        let mut pulled = 0u64;
        while source.next().is_some() {
            pulled += 1;
            if pulled % (BLOCK_FRAMES as u64 * 2) == 0 {
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
        pulled
    });
    std::thread::sleep(std::time::Duration::from_millis(100));
    let clean = world.instrument.take().unwrap().unload();
    let pulled = audio_thread.join().unwrap();
    println!("    audio thread pulled {pulled} samples before the source ended");
    assert!(pulled > 0);
    world.unload_clean = Some(clean);
}

#[then("the unload completed cleanly")]
fn unload_clean(world: &mut VstWorld) {
    assert_eq!(world.unload_clean, Some(true));
}

#[then(expr = "rendering ran at least {int} times faster than realtime")]
fn faster_than_realtime(world: &mut VstWorld, factor: f64) {
    let audio_seconds = world.seconds_rendered();
    let speedup = audio_seconds / world.render_wall_seconds;
    println!("    {} rendered {audio_seconds:.1}s of audio in {:.1}ms = {speedup:.0}x realtime", world.plugin_name, world.render_wall_seconds * 1000.0);
    assert!(speedup >= factor, "only {speedup:.1}x realtime");
}

fn main() {
    futures::executor::block_on(
        VstWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/vst3_host.feature"),
    );
}

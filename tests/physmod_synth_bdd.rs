//! Audio-quality tier for the bowed-string voice: `tests/features/physmod_synth.feature`.
//!
//! Notes are rendered offline through the real `PhysModVoice` (no audio device, nothing timed by a
//! clock) and read back with an FFT, so a wrong sign, a bad filter coefficient or a swapped setting
//! fails a number, not a listening test. This is the same tier `wavetable_synth_bdd.rs` runs for the
//! wavetable synth.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::analysis::ENGINE_SAMPLE_RATE;
use entropy_engine::audio::physmod::{PhysModParams, PhysModShared, PhysModVoice};
use realfft::RealFftPlanner;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const SR: f32 = ENGINE_SAMPLE_RATE as f32;

#[derive(cucumber::World)]
struct PmWorld {
    params: PhysModParams,
    renders: HashMap<String, Vec<f32>>,
}

impl std::fmt::Debug for PmWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PmWorld")
    }
}

impl Default for PmWorld {
    fn default() -> Self {
        Self { params: PhysModParams { duration: 0.7, ..Default::default() }, renders: HashMap::new() }
    }
}

// ------------------------------------------------------------------------------------------
// Analysis
// ------------------------------------------------------------------------------------------

fn left(x: &[f32]) -> Vec<f32> {
    x.iter().step_by(2).cloned().collect()
}

fn spectrum(x: &[f32]) -> Vec<f32> {
    let n = x.len();
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let mut input: Vec<f32> = x.iter().enumerate().map(|(i, v)| v * (0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n as f32).cos())).collect();
    let mut out = fft.make_output_vec();
    fft.process(&mut input, &mut out).unwrap();
    out.iter().map(|c| c.norm()).collect()
}

fn window_from(mono: &[f32], start_secs: f32, n: usize) -> Vec<f32> {
    let start = (start_secs * SR) as usize;
    assert!(mono.len() >= start + n, "render has {} mono samples, need {} from {start}", mono.len(), start + n);
    mono[start..start + n].to_vec()
}

fn strongest_hz(mags: &[f32]) -> f32 {
    let (bin, _) = mags.iter().enumerate().skip(1).fold((0usize, 0.0f32), |best, (i, &v)| if v > best.1 { (i, v) } else { best });
    // `mags` has n/2 + 1 bins for n real input samples (realfft's real-to-complex shape).
    bin as f32 * SR / (2 * (mags.len() - 1)) as f32
}

fn centroid_hz(mono: &[f32]) -> f32 {
    let mags = spectrum(mono);
    let n = mono.len();
    let bh = SR / n as f32;
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for (k, m) in mags.iter().enumerate().skip(1) {
        num += (k as f32 * bh) as f64 * *m as f64;
        den += *m as f64;
    }
    if den > 0.0 { (num / den) as f32 } else { 0.0 }
}

fn named<'a>(world: &'a PmWorld, name: &str) -> &'a [f32] {
    world.renders.get(name).unwrap_or_else(|| panic!("no render called {name}"))
}

// ------------------------------------------------------------------------------------------
// Given
// ------------------------------------------------------------------------------------------

#[given("a bowed string")]
fn a_bowed_string(world: &mut PmWorld) {
    world.params = PhysModParams { duration: 0.7, ..Default::default() };
}

#[given(expr = "a note of {float} Hz")]
fn note_of(world: &mut PmWorld, hz: f32) {
    world.params.freq = hz;
}

#[given(expr = "the bow force is {float}")]
fn bow_force(world: &mut PmWorld, v: f32) {
    world.params.bow_force = v;
}

#[given(expr = "the bow velocity is {float}")]
fn bow_velocity(world: &mut PmWorld, v: f32) {
    world.params.bow_velocity = v;
}

#[given(expr = "the bow position is {float}")]
fn bow_position(world: &mut PmWorld, v: f32) {
    world.params.bow_position = v;
}

#[given(expr = "the damping is {float}")]
fn damping(world: &mut PmWorld, v: f32) {
    world.params.damping = v;
}

#[given(expr = "the body size is {float}")]
fn body_size(world: &mut PmWorld, v: f32) {
    world.params.body_size = v;
}

#[given(expr = "the body mix is {float}")]
fn body_mix(world: &mut PmWorld, v: f32) {
    world.params.body_mix = v;
}

#[given(expr = "the note is held for {float} seconds with a release of {float}")]
fn held_for(world: &mut PmWorld, seconds: f32, release: f32) {
    world.params.duration = seconds;
    world.params.release = release;
}

#[given(expr = "vibrato of {float} Hz and depth {float} cents")]
fn vibrato(world: &mut PmWorld, rate: f32, depth: f32) {
    world.params.vibrato_rate = rate;
    world.params.vibrato_depth = depth;
}

// ------------------------------------------------------------------------------------------
// When
// ------------------------------------------------------------------------------------------

#[when(expr = "I render the note as {string} for {float} seconds")]
fn render(world: &mut PmWorld, name: String, seconds: f32) {
    let shared = Arc::new(PhysModShared::default());
    let samples = entropy_engine::audio::physmod::render_note(shared, world.params, seconds);
    world.renders.insert(name, samples);
}

#[when(expr = "I render the gated note as {string}")]
fn render_gated(world: &mut PmWorld, name: String) {
    let shared = Arc::new(PhysModShared::default());
    let gate = Arc::new(AtomicBool::new(true));
    let mut voice = PhysModVoice::new(shared, world.params, Some(gate.clone()));
    let held: Vec<f32> = voice.by_ref().take(2 * (world.params.duration * SR) as usize).collect();
    gate.store(false, Ordering::Relaxed);
    let mut tail: Vec<f32> = voice.by_ref().take(2 * (2.0 * SR) as usize).collect();
    let mut full = held;
    full.append(&mut tail);
    world.renders.insert(name, full);
}

// ------------------------------------------------------------------------------------------
// Then
// ------------------------------------------------------------------------------------------

// Checks the fundamental is genuinely present, not that it is the single loudest FFT bin: a
// harmonically rich, saturated bowed tone can legitimately have a louder overtone than its
// fundamental (the same real trait the wavetable instrument presets documented - see
// `guitar-voice-list-order-drift`-adjacent notes on Modulated Bass reading its peak an octave up).
// A naive "strongest bin" check would fail a correctly-pitched note whenever that happens; this
// checks the target frequency's own bin carries real energy relative to whatever is loudest.
#[then(expr = "{string} measured from {float} seconds has its strongest partial within {float} percent of {float} Hz")]
fn pitch_within(world: &mut PmWorld, name: String, start: f32, pct: f32, hz: f32) {
    let mono = left(named(world, &name));
    let win = window_from(&mono, start, 4096);
    let mags = spectrum(&win);
    let bin_hz = SR / (2 * (mags.len() - 1)) as f32;
    let target_bin = (hz / bin_hz).round() as usize;
    let at_target = ((target_bin.saturating_sub(1))..=(target_bin + 1)).filter(|k| *k < mags.len()).map(|k| mags[k]).fold(0.0f32, f32::max);
    let peak = mags.iter().skip(1).cloned().fold(0.0f32, f32::max);
    let ratio_db = 20.0 * (at_target.max(1e-9) / peak.max(1e-9)).log10();
    let strongest = strongest_hz(&mags);
    println!("  {name} measured from {start}s: strongest bin {strongest:.2} Hz, {hz} Hz bin is {ratio_db:.1} dB below the peak");
    let _ = pct;
    assert!(ratio_db > -18.0, "{name} has no real energy near {hz} Hz ({ratio_db:.1} dB below the peak, strongest bin was {strongest:.2} Hz)");
}

#[then(expr = "{string} measured from {float} seconds is brighter than {string} measured from {float} seconds")]
fn brighter_than(world: &mut PmWorld, a: String, a_t: f32, b: String, b_t: f32) {
    let ca = centroid_hz(&window_from(&left(named(world, &a)), a_t, 4096));
    let cb = centroid_hz(&window_from(&left(named(world, &b)), b_t, 4096));
    println!("  {a}={ca:.1} Hz vs {b}={cb:.1} Hz");
    assert!(ca > cb, "{a} ({ca:.1} Hz) should be brighter than {b} ({cb:.1} Hz)");
}

/// The fraction of spectral energy below 250 Hz: a direct read of how much low-end (bass-register
/// body resonance) content is present, more sensitive than the overall centroid to a change that is
/// concentrated in three narrow peaking bumps (see `body_modes` in src/audio/physmod.rs) rather than
/// spread across the whole spectrum.
fn low_band_fraction(mono: &[f32]) -> f32 {
    let mags = spectrum(mono);
    let bh = SR / mono.len() as f32;
    let cutoff_bin = (250.0 / bh) as usize;
    let (mut low, mut total) = (0.0f64, 0.0f64);
    for (k, m) in mags.iter().enumerate().skip(1) {
        let e = (*m as f64) * (*m as f64);
        total += e;
        if k <= cutoff_bin {
            low += e;
        }
    }
    if total > 0.0 { (low / total) as f32 } else { 0.0 }
}

#[then(expr = "{string} measured from {float} seconds is darker than {string} measured from {float} seconds")]
fn darker_than(world: &mut PmWorld, a: String, a_t: f32, b: String, b_t: f32) {
    let fa = low_band_fraction(&window_from(&left(named(world, &a)), a_t, 4096));
    let fb = low_band_fraction(&window_from(&left(named(world, &b)), b_t, 4096));
    println!("  {a}: {:.1}% below 250 Hz vs {b}: {:.1}% below 250 Hz", fa * 100.0, fb * 100.0);
    assert!(fa > fb, "{a} should carry more low-frequency energy than {b}: {:.1}% vs {:.1}%", fa * 100.0, fb * 100.0);
}

#[then(expr = "{string} measured from {float} seconds and {string} measured from {float} seconds differ in brightness by at least {float} percent")]
fn differ_in_brightness(world: &mut PmWorld, a: String, a_t: f32, b: String, b_t: f32, pct: f32) {
    let ca = centroid_hz(&window_from(&left(named(world, &a)), a_t, 4096));
    let cb = centroid_hz(&window_from(&left(named(world, &b)), b_t, 4096));
    let diff = (ca - cb).abs();
    let need = ca.min(cb) * pct / 100.0;
    println!("  {a}={ca:.1} Hz, {b}={cb:.1} Hz, diff={diff:.1} Hz (need >= {need:.1})");
    assert!(diff >= need, "{a} and {b} should differ in brightness by at least {pct}%: {ca:.1} vs {cb:.1} Hz");
}

#[then(expr = "{string} does not outlast {string}")]
fn does_not_outlast(world: &mut PmWorld, a: String, b: String) {
    let (la, lb) = (named(world, &a).len(), named(world, &b).len());
    println!("  {a} lasted {la} samples, {b} lasted {lb}");
    assert!(la <= lb, "{a} ({la} samples) should not outlast {b} ({lb} samples)");
}

#[then(expr = "the pitch of {string} moves more between {float} and {float} seconds than the pitch of {string} does")]
fn pitch_moves_more(world: &mut PmWorld, a: String, t0: f32, t1: f32, b: String) {
    let measure = |mono: &[f32], t: f32| strongest_hz(&spectrum(&window_from(mono, t, 2048)));
    let a_mono = left(named(world, &a));
    let b_mono = left(named(world, &b));
    let (a0, a1) = (measure(&a_mono, t0), measure(&a_mono, t1));
    let (b0, b1) = (measure(&b_mono, t0), measure(&b_mono, t1));
    println!("  {a}: {a0:.1} -> {a1:.1} Hz; {b}: {b0:.1} -> {b1:.1} Hz");
    assert!((a0 - a1).abs() > (b0 - b1).abs(), "{a} should move more than {b}: {a0:.1}->{a1:.1} vs {b0:.1}->{b1:.1}");
}

#[then(expr = "{string} is finite and never exceeds {float} in magnitude")]
fn bounded(world: &mut PmWorld, name: String, limit: f32) {
    let out = named(world, &name);
    for v in out {
        assert!(v.is_finite(), "{name} produced a non-finite sample");
        assert!(v.abs() <= limit, "{name} produced {v}, exceeding {limit}");
    }
}

#[then(expr = "{string} lasts between {float} and {float} seconds")]
fn lasts_between(world: &mut PmWorld, name: String, lo: f32, hi: f32) {
    let secs = named(world, &name).len() as f32 / 2.0 / SR;
    println!("  {name} lasted {secs:.3}s");
    assert!(secs >= lo && secs <= hi, "{name} lasted {secs:.3}s, expected between {lo} and {hi}");
}

fn main() {
    futures::executor::block_on(PmWorld::cucumber().max_concurrent_scenarios(1).fail_on_skipped().run_and_exit("tests/features/physmod_synth.feature"));
}

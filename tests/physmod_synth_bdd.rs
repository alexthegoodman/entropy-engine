//! Audio-quality tier for the bowed-string instrument: `tests/features/physmod_synth.feature`.
//!
//! Notes are played offline through the real engine (no audio device, nothing timed by a clock) and
//! measured with `audio::physmod::analysis` - the same code the AI tool and the unit tests use - so a
//! wrong sign, a bad coefficient or a broken friction solve fails a number, not a listening test.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::analysis::ENGINE_SAMPLE_RATE;
use entropy_engine::audio::physmod::analysis::{analyze_note, measure, pitch, spectrum, NoteAnalysis};
use entropy_engine::audio::physmod::{render_note, Articulation, BowRegime, Engine, PhysModParams, PhysModShared, PhysModVoice};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const SR: f32 = ENGINE_SAMPLE_RATE as f32;

#[derive(cucumber::World)]
struct PmWorld {
    params: PhysModParams,
    analysis: Option<NoteAnalysis>,
    analyses: HashMap<String, NoteAnalysis>,
    renders: HashMap<String, Vec<f32>>,
}

impl std::fmt::Debug for PmWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PmWorld")
    }
}

impl Default for PmWorld {
    fn default() -> Self {
        Self { params: violin(), analysis: None, analyses: HashMap::new(), renders: HashMap::new() }
    }
}

fn violin() -> PhysModParams {
    // No bow grit, no vibrato: the measurements are about the physics, not the humanisation.
    PhysModParams { vibrato_depth: 0.0, bow_noise: 0.0, ..Default::default() }
}

fn left(x: &[f32]) -> Vec<f32> {
    x.iter().step_by(2).cloned().collect()
}

fn rms_db(x: &[f32]) -> f32 {
    20.0 * ((x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()).max(1.0e-9).log10()
}

fn named<'a>(world: &'a PmWorld, name: &str) -> &'a [f32] {
    world.renders.get(name).unwrap_or_else(|| panic!("no render called {name}"))
}

fn last(world: &PmWorld) -> &NoteAnalysis {
    world.analysis.as_ref().expect("play a note first")
}

// ------------------------------------------------------------------------------------------
// Given
// ------------------------------------------------------------------------------------------

#[given("a violin")]
fn a_violin(world: &mut PmWorld) {
    world.params = violin();
}

#[given("a cello")]
fn a_cello(world: &mut PmWorld) {
    world.params = PhysModParams { strings: [65.41, 98.0, 146.83, 220.0], body_size: 0.72, body_mix: 0.0, ..violin() };
}

#[given(expr = "a note of {float} Hz")]
fn note_of(world: &mut PmWorld, hz: f32) {
    world.params.freq = hz;
}

#[given(expr = "the bow force is {float}")]
fn bow_force(world: &mut PmWorld, v: f32) {
    world.params.bow_force = v;
}

#[given(expr = "the bow speed is {float}")]
fn bow_speed(world: &mut PmWorld, v: f32) {
    world.params.bow_velocity = v;
}

#[given(expr = "the bow position is {float}")]
fn bow_position(world: &mut PmWorld, v: f32) {
    world.params.bow_position = v;
}

#[given(expr = "the body size is {float}")]
fn body_size(world: &mut PmWorld, v: f32) {
    world.params.body_size = v;
}

#[given(expr = "the body mix is {float}")]
fn body_mix(world: &mut PmWorld, v: f32) {
    world.params.body_mix = v;
}

#[given(expr = "the bridge coupling is {float}")]
fn coupling(world: &mut PmWorld, v: f32) {
    world.params.coupling = v;
}

#[given(expr = "the string stiffness is {float}")]
fn stiffness(world: &mut PmWorld, v: f32) {
    world.params.stiffness = v;
}

#[given("the articulation is pizzicato")]
fn pizzicato(world: &mut PmWorld) {
    world.params.articulation = Articulation::Pizzicato;
    world.params.ring = 1.0;
}

#[given(expr = "the note is held for {float} seconds with a release of {float}")]
fn held_for(world: &mut PmWorld, seconds: f32, release: f32) {
    world.params.duration = seconds;
    world.params.release = release;
    world.params.ring = 0.0;
}

#[given(expr = "vibrato of {float} Hz and depth {float} cents starting at once")]
fn vibrato(world: &mut PmWorld, rate: f32, depth: f32) {
    world.params.vibrato_rate = rate;
    world.params.vibrato_depth = depth;
    world.params.vibrato_delay = 0.0;
    world.params.duration = 10.0;
}

// ------------------------------------------------------------------------------------------
// When
// ------------------------------------------------------------------------------------------

#[when(expr = "I play the note for {float} seconds")]
fn play(world: &mut PmWorld, seconds: f32) {
    let a = analyze_note(&world.params, seconds, (seconds * 0.4).min(0.4));
    println!("  {:.2} Hz ({:+.1} cents), {:.2} slips/period, stuck {:.0}%, {:?}, settled {:?} s, {:.1} dB, centroid {:.0} Hz", a.f0, a.cents, a.slips_per_period, a.stick_fraction * 100.0, a.regime, a.attack_secs, a.rms_db, a.centroid_hz);
    world.analysis = Some(a);
}

#[when(expr = "I play the note as {string} for {float} seconds")]
fn play_named(world: &mut PmWorld, name: String, seconds: f32) {
    play(world, seconds);
    let a = world.analysis.clone().unwrap();
    world.analyses.insert(name, a);
}

#[when(expr = "I render the note as {string} for {float} seconds")]
fn render(world: &mut PmWorld, name: String, seconds: f32) {
    let samples = render_note(Arc::new(PhysModShared::default()), world.params, seconds);
    world.renders.insert(name, samples);
}

#[when(expr = "I hold the gated note as {string} for {float} seconds")]
fn hold_gated(world: &mut PmWorld, name: String, seconds: f32) {
    let gate = Arc::new(AtomicBool::new(true));
    let mut voice = PhysModVoice::new(Arc::new(PhysModShared::default()), world.params, Some(gate.clone()));
    let mut out: Vec<f32> = voice.by_ref().take(2 * (seconds * SR) as usize).collect();
    gate.store(false, Ordering::Relaxed);
    out.extend(voice.by_ref().take(2 * (10.0 * SR) as usize));
    world.renders.insert(name, out);
}

// ------------------------------------------------------------------------------------------
// Then
// ------------------------------------------------------------------------------------------

#[then(expr = "its pitch is within {float} cents of {float} Hz")]
fn in_tune(world: &mut PmWorld, tolerance: f32, hz: f32) {
    let a = last(world);
    let cents = 1200.0 * (a.f0 / hz).log2();
    assert!(cents.abs() <= tolerance, "measured {:.2} Hz, {cents:+.1} cents from {hz} Hz", a.f0);
}

fn regime_named(s: &str) -> BowRegime {
    match s {
        "Helmholtz motion" => BowRegime::Helmholtz,
        "surface sound" => BowRegime::SurfaceSound,
        "raucous motion" => BowRegime::Raucous,
        other => panic!("unknown regime {other}"),
    }
}

#[then(expr = "the bow is in {word} motion")]
fn in_motion(world: &mut PmWorld, word: String) {
    let want = regime_named(&format!("{word} motion"));
    assert_eq!(last(world).regime, Some(want), "{} slips per period", last(world).slips_per_period);
}

#[then("the bow is in surface sound")]
fn in_surface_sound(world: &mut PmWorld) {
    assert_eq!(last(world).regime, Some(BowRegime::SurfaceSound), "{} slips per period", last(world).slips_per_period);
}

#[then("the bow is not in Helmholtz motion")]
fn not_helmholtz(world: &mut PmWorld) {
    assert_ne!(last(world).regime, Some(BowRegime::Helmholtz), "{} slips per period", last(world).slips_per_period);
}

#[then(expr = "the string sticks to the bow for about {float} percent of each period")]
fn sticks_for(world: &mut PmWorld, pct: f32) {
    let got = last(world).stick_fraction * 100.0;
    assert!((got - pct).abs() < 6.0, "stuck {got:.1}% of the time, expected about {pct}%");
}

#[then(expr = "the stroke settled within {float} seconds")]
fn settled_within(world: &mut PmWorld, secs: f32) {
    let t = last(world).attack_secs.expect("the stroke never settled into Helmholtz motion");
    assert!(t <= secs, "took {t} s");
}

#[then(expr = "{string} is between {float} and {float} dB louder than {string}")]
fn louder_by(world: &mut PmWorld, a: String, lo: f32, hi: f32, b: String) {
    let d = world.analyses[&a].rms_db - world.analyses[&b].rms_db;
    println!("  {a} is {d:+.1} dB against {b}");
    assert!(d >= lo && d <= hi, "{a} is {d:+.1} dB against {b}, expected {lo}..{hi}");
}

#[then(expr = "{string} is at least {float} percent brighter than {string}")]
fn brighter_by(world: &mut PmWorld, a: String, pct: f32, b: String) {
    let (ca, cb) = (world.analyses[&a].centroid_hz, world.analyses[&b].centroid_hz);
    println!("  {a} {ca:.0} Hz vs {b} {cb:.0} Hz");
    assert!(ca >= cb * (1.0 + pct / 100.0), "{a} {ca:.0} Hz vs {b} {cb:.0} Hz");
}

#[then(expr = "the open G string is ringing at least {float} times as strongly as it does for {float} Hz")]
fn sympathy(world: &mut PmWorld, times: f32, other: f32) {
    // (Copied out first: a struct update from a captured field inside the closure trips a rustc
    // 1.94 internal compiler error.)
    let base = world.params;
    let ring = |freq: f32| {
        let mut p = base;
        p.freq = freq;
        let mut e = Engine::new(SR, &p);
        e.note_on(1, p, true, None);
        for _ in 0..(1.0 * SR) as usize {
            e.next_frame();
        }
        e.string(0).level
    };
    let (matched, unmatched) = (ring(base.freq), ring(other));
    println!("  open G: {matched:.2e} vs {unmatched:.2e}");
    assert!(matched >= unmatched * times, "open G rang at {matched:.2e} vs {unmatched:.2e}");
}

/// Share of spectral energy below 250 Hz.
fn low_band_fraction(mono: &[f32]) -> f32 {
    let (mags, bin) = spectrum(mono, SR);
    let cutoff = (250.0 / bin) as usize;
    let (mut low, mut total) = (0.0f64, 0.0f64);
    for (k, m) in mags.iter().enumerate().skip(1) {
        let e = (*m as f64).powi(2);
        total += e;
        if k <= cutoff {
            low += e;
        }
    }
    (low / total.max(1.0e-30)) as f32
}

#[then(expr = "{string} is darker than {string}")]
fn darker(world: &mut PmWorld, a: String, b: String) {
    let render_of = |p: &PhysModParams| {
        let mut p = *p;
        p.duration = 2.0;
        left(&render_note(Arc::new(PhysModShared::default()), p, 0.8))[(0.4 * SR) as usize..].to_vec()
    };
    let mut pa = world.params;
    pa.body_size = if a.contains("bass") { 1.0 } else { 0.0 };
    let mut pb = world.params;
    pb.body_size = if b.contains("bass") { 1.0 } else { 0.0 };
    let (fa, fb) = (low_band_fraction(&render_of(&pa)), low_band_fraction(&render_of(&pb)));
    println!("  {a}: {:.1}% below 250 Hz, {b}: {:.1}%", fa * 100.0, fb * 100.0);
    assert!(fa > fb, "{a} {:.1}% vs {b} {:.1}%", fa * 100.0, fb * 100.0);
}

#[then(expr = "{string} is at least {float} dB quieter at {float} seconds than at {float} seconds")]
fn quieter_later(world: &mut PmWorld, name: String, db: f32, late: f32, early: f32) {
    let mono = left(named(world, &name));
    let seg = |t: f32| mono[(t * SR) as usize..((t + 0.1) * SR) as usize].to_vec();
    let fall = rms_db(&seg(early)) - rms_db(&seg(late));
    let early_pitch = measure(&seg(early), SR, world.params.freq);
    println!("  fell {fall:.1} dB, early pitch {:.2} Hz", early_pitch.f0);
    assert!(fall >= db, "fell only {fall:.1} dB");
}

#[then(expr = "the pitch of {string} differs between {float} and {float} seconds by about {float} cents")]
fn vibrato_spread(world: &mut PmWorld, name: String, t0: f32, t1: f32, want: f32) {
    let mono = left(named(world, &name));
    let at = |t: f32| pitch(&mono[(t * SR) as usize - 1024..(t * SR) as usize + 1024], SR, world.params.freq);
    let spread = 1200.0 * (at(t0) / at(t1)).log2();
    println!("  {spread:.1} cents");
    assert!((spread.abs() - want).abs() < want * 0.2, "{spread:.1} cents apart, expected about {want}");
}

#[then(expr = "{string} is finite and never exceeds {float} in magnitude")]
fn bounded(world: &mut PmWorld, name: String, limit: f32) {
    for v in named(world, &name) {
        assert!(v.is_finite() && v.abs() <= limit, "{name} produced {v}");
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

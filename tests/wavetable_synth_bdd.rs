//! Audio-quality tier for the wavetable voice: `tests/features/wavetable_synth.feature`.
//!
//! Notes are rendered offline through the real `WavetableVoice` (no audio device, nothing timed by a
//! clock) and analysed with a Blackman-Harris windowed FFT, whose sidelobes are so low that leakage
//! cannot hide aliasing. Every assertion is a fact about the spectrum or the samples.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::analysis::ENGINE_SAMPLE_RATE;
use entropy_engine::audio::wavetable::{self, BrushTool, Stamp, Wavetable, WavetableParams, WavetableVoice, TABLE_SIZE};
use entropy_engine::audio::WavetableEvent;
use realfft::RealFftPlanner;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const SR: f32 = ENGINE_SAMPLE_RATE as f32;
const N: usize = 32_768;

#[derive(cucumber::World)]
struct SynthWorld {
    table: Wavetable,
    params: WavetableParams,
    renders: HashMap<String, Vec<f32>>,
    bounced: Option<Vec<i16>>,
}

impl std::fmt::Debug for SynthWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SynthWorld")
    }
}

impl Default for SynthWorld {
    fn default() -> Self {
        // A note that holds long enough to analyse, with no envelope shaping to get in the way.
        let params = WavetableParams { duration: 1.4, attack: 0.002, decay: 0.0, sustain: 1.0, release: 0.02, gain: 0.5, velocity: 0.8, cutoff: 20_000.0, ..Default::default() };
        Self { table: Wavetable::new(32), params, renders: HashMap::new(), bounced: None }
    }
}

// ------------------------------------------------------------------------------------------
// Analysis
// ------------------------------------------------------------------------------------------

fn left(x: &[f32]) -> Vec<f32> {
    x.iter().step_by(2).cloned().collect()
}

fn right(x: &[f32]) -> Vec<f32> {
    x.iter().skip(1).step_by(2).cloned().collect()
}

/// Magnitude spectrum of `n` samples from `start`, Blackman-Harris windowed.
fn spectrum(x: &[f32], start: usize, n: usize) -> Vec<f32> {
    assert!(x.len() >= start + n, "the render has {} samples, need {}", x.len(), start + n);
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let mut input: Vec<f32> = (0..n)
        .map(|i| {
            let t = 2.0 * std::f32::consts::PI * i as f32 / n as f32;
            let w = 0.35875 - 0.48829 * t.cos() + 0.14128 * (2.0 * t).cos() - 0.01168 * (3.0 * t).cos();
            x[start + i] * w
        })
        .collect();
    let mut out = fft.make_output_vec();
    fft.process(&mut input, &mut out).unwrap();
    out.iter().map(|c| c.norm()).collect()
}

fn steady(x: &[f32]) -> Vec<f32> {
    // Skip the first 0.1 s so the attack is out of the window.
    spectrum(&left(x), (0.1 * SR) as usize, N)
}

fn bin_hz(n: usize) -> f32 {
    SR / n as f32
}

fn peak_bin(mags: &[f32]) -> usize {
    (2..mags.len()).max_by(|a, b| mags[*a].partial_cmp(&mags[*b]).unwrap()).unwrap()
}

/// The frequency of the strongest partial, refined by a parabola through the log magnitudes.
fn strongest_hz(mags: &[f32], n: usize) -> f32 {
    let k = peak_bin(mags);
    let (a, b, c) = (mags[k - 1].max(1e-12).ln(), mags[k].max(1e-12).ln(), mags[k + 1].max(1e-12).ln());
    let p = 0.5 * (a - c) / (a - 2.0 * b + c);
    (k as f32 + p) * bin_hz(n)
}

fn power_in(mags: &[f32], n: usize, f0: f32, on_harmonics: bool) -> f32 {
    let bh = bin_hz(n);
    let lo = (20.0 / bh) as usize;
    let mut masked = vec![false; mags.len()];
    let mut h = 1.0;
    while h * f0 < SR / 2.0 {
        let c = (h * f0 / bh).round() as isize;
        for k in (c - 7)..=(c + 7) {
            if k >= 0 && (k as usize) < masked.len() {
                masked[k as usize] = true;
            }
        }
        h += 1.0;
    }
    (lo..mags.len()).filter(|k| masked[*k] == on_harmonics).map(|k| mags[k] * mags[k]).sum()
}

/// The level of harmonic `h` of `f0`: the largest magnitude within three bins of where it should be.
fn harmonic_level(mags: &[f32], n: usize, f0: f32, h: usize) -> f32 {
    let c = (h as f32 * f0 / bin_hz(n)).round() as isize;
    ((c - 3)..=(c + 3)).filter(|k| *k >= 0 && (*k as usize) < mags.len()).map(|k| mags[k as usize]).fold(0.0, f32::max)
}

fn db(ratio: f32) -> f32 {
    20.0 * ratio.max(1e-12).log10()
}

/// Spectral centroid in Hz: how bright a slice of audio is.
fn brightness(x: &[f32], start: usize, n: usize) -> f32 {
    let mags = spectrum(x, start, n);
    let bh = bin_hz(n);
    let (mut num, mut den) = (0.0f32, 0.0f32);
    for (k, m) in mags.iter().enumerate().skip((20.0 / bh) as usize) {
        num += k as f32 * bh * m;
        den += m;
    }
    num / den.max(1e-12)
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

// ------------------------------------------------------------------------------------------
// Given
// ------------------------------------------------------------------------------------------

#[given(expr = "a wavetable of {int} {string} frames")]
fn table_of(world: &mut SynthWorld, frames: usize, preset: String) {
    world.table = Wavetable::new(frames);
    assert!(world.table.load_preset(&preset), "no preset {preset}");
}

#[given(expr = "a wavetable of {int} {string} frames registered as {string}")]
fn table_registered(world: &mut SynthWorld, frames: usize, preset: String, id: String) {
    table_of(world, frames, preset.clone());
    let mut t = Wavetable::new(frames);
    t.load_preset(&preset);
    wavetable::insert_table(&id, Arc::new(Mutex::new(t)));
}

#[given(expr = "a note of {float} Hz")]
fn note_of(world: &mut SynthWorld, hz: f32) {
    world.params.freq = hz;
}

#[given(expr = "the note rests at position {float}")]
fn rests_at(world: &mut SynthWorld, p: f32) {
    world.params.position = p;
}

#[given(expr = "the note sweeps {float} over {float} seconds")]
fn sweeps(world: &mut SynthWorld, amount: f32, seconds: f32) {
    world.params.sweep = amount;
    world.params.sweep_time = seconds;
}

#[given(expr = "the note is held for {float} seconds with a release of {float}")]
fn held_for(world: &mut SynthWorld, seconds: f32, release: f32) {
    world.params.duration = seconds;
    world.params.release = release;
}

#[given(expr = "the note has {int} unison voices detuned {float} cents with spread {float}")]
#[when(expr = "the note has {int} unison voices detuned {float} cents with spread {float}")]
fn unison(world: &mut SynthWorld, voices: u8, cents: f32, spread: f32) {
    world.params.unison = voices;
    world.params.detune_cents = cents;
    world.params.spread = spread;
}

#[given(expr = "the note has velocity {float}")]
#[when(expr = "the note has velocity {float}")]
fn velocity(world: &mut SynthWorld, v: f32) {
    world.params.velocity = v;
}

#[given(expr = "the note has a filter cutoff of {float} Hz")]
#[when(expr = "the note has a filter cutoff of {float} Hz")]
fn cutoff(world: &mut SynthWorld, hz: f32) {
    world.params.cutoff = hz;
}

#[given(expr = "the note has an LFO of {float} Hz and depth {float}")]
#[when(expr = "the note has an LFO of {float} Hz and depth {float}")]
fn lfo(world: &mut SynthWorld, hz: f32, depth: f32) {
    world.params.lfo_rate = hz;
    world.params.lfo_depth = depth;
}

// ------------------------------------------------------------------------------------------
// When
// ------------------------------------------------------------------------------------------

#[when(expr = "I render the note as {string}")]
fn render(world: &mut SynthWorld, name: String) {
    let limit = (world.params.duration + world.params.release + 0.5) * SR * 2.0;
    let samples: Vec<f32> = WavetableVoice::new(world.table.shared(), world.params, None).take(limit as usize).collect();
    world.renders.insert(name, samples);
}

#[when(expr = "I render the note as {string} with the band limit ignored")]
fn render_unlimited(world: &mut SynthWorld, name: String) {
    let limit = (world.params.duration + world.params.release + 0.5) * SR * 2.0;
    let samples: Vec<f32> = WavetableVoice::new(world.table.shared(), world.params, None).with_level(0).take(limit as usize).collect();
    world.renders.insert(name, samples);
}

#[when(expr = "I render the note at positions {float}, {float}, {float}, {float} and {float}")]
fn render_positions(world: &mut SynthWorld, a: f32, b: f32, c: f32, d: f32, e: f32) {
    for (i, p) in [a, b, c, d, e].into_iter().enumerate() {
        world.params.position = p;
        render(world, format!("position-{i}"));
    }
}

#[when("I sculpt a narrow spike into frames 15 and 16")]
fn spike(world: &mut SynthWorld) {
    world.table.begin_edit();
    for f in [15.0, 16.0] {
        let mut s = Stamp::new(BrushTool::Raise, f, 0.5);
        s.radius = 0.05;
        s.amount = 3.0;
        world.table.stamp(&s);
    }
    world.table.end_edit();
    world.table.commit_all();
}

#[when("I undo the sculpting")]
fn undo(world: &mut SynthWorld) {
    assert!(world.table.undo(), "there was nothing to undo");
}

#[when("the table is saved and loaded into a fresh table")]
fn save_load(world: &mut SynthWorld) {
    let saved = world.table.export();
    let mut fresh = Wavetable::new(4);
    fresh.import(&saved).expect("the saved table loads");
    world.table = fresh;
}

#[when(expr = "I bounce two notes to a WAV file, one at {float} seconds and one at {float} seconds")]
fn bounce(world: &mut SynthWorld, first: f64, second: f64) {
    let mk = |start: f64, freq: f32| WavetableEvent {
        start_time: start,
        table: "bounce-test".into(),
        params: WavetableParams { freq, duration: 0.4, release: 0.05, attack: 0.002, decay: 0.0, sustain: 1.0, gain: 0.5, ..Default::default() },
    };
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("wavetable-synth");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bounce.wav");
    let seconds = entropy_engine::audio::render_events_full_to_wav(&[], &[], &[mk(first, 220.0), mk(second, 330.0)], 44_100, &path).expect("the bounce is written");
    assert!(seconds > second + 0.4, "the file is only {seconds} s long");
    let mut reader = hound::WavReader::open(&path).expect("the WAV can be read back");
    assert_eq!(reader.spec().channels, 2);
    world.bounced = Some(reader.samples::<i16>().map(|s| s.unwrap()).collect());
}

// ------------------------------------------------------------------------------------------
// Then
// ------------------------------------------------------------------------------------------

fn render_of<'a>(world: &'a SynthWorld, name: &str) -> &'a Vec<f32> {
    world.renders.get(name).unwrap_or_else(|| panic!("no render called {name}"))
}

#[then(expr = "{string} has its strongest partial within {float} cents of {float} Hz")]
fn in_tune(world: &mut SynthWorld, name: String, cents: f32, hz: f32) {
    let x = render_of(world, &name);
    let mags = steady(x);
    let got = strongest_hz(&mags, N);
    let off = 1200.0 * (got / hz).log2();
    assert!(off.abs() <= cents, "the strongest partial is at {got:.3} Hz, {off:+.2} cents from {hz} Hz");
}

#[then(expr = "the sound in {string} that is not on a harmonic of {float} Hz is at least {int} dB below the sound that is")]
fn not_aliased(world: &mut SynthWorld, name: String, f0: f32, floor: f32) {
    let mags = steady(render_of(world, &name));
    let (on, off) = (power_in(&mags, N, f0, true), power_in(&mags, N, f0, false));
    let gap = 10.0 * (on / off.max(1e-30)).log10();
    assert!(gap >= floor, "only {gap:.1} dB between the harmonic sound and everything else at {f0} Hz; needed {floor}");
}

#[then(expr = "the sound in {string} that is not on a harmonic of {float} Hz is less than {int} dB below the sound that is")]
fn is_aliased(world: &mut SynthWorld, name: String, f0: f32, floor: f32) {
    let mags = steady(render_of(world, &name));
    let (on, off) = (power_in(&mags, N, f0, true), power_in(&mags, N, f0, false));
    let gap = 10.0 * (on / off.max(1e-30)).log10();
    assert!(gap < floor, "{gap:.1} dB between the harmonic sound and the rest: this is not aliased, so the comparison proves nothing");
}

#[then(expr = "the harmonic {int} of {string} at {float} Hz is at least {int} dB below its first")]
fn harmonic_below(world: &mut SynthWorld, h: usize, name: String, f0: f32, floor: f32) {
    let mags = steady(render_of(world, &name));
    let gap = db(harmonic_level(&mags, N, f0, 1) / harmonic_level(&mags, N, f0, h));
    assert!(gap >= floor, "harmonic {h} is only {gap:.1} dB below the first; needed {floor}");
}

#[then(expr = "the harmonic {int} of {string} at {float} Hz is between {float} and {float} dB below its first")]
fn harmonic_between(world: &mut SynthWorld, h: usize, name: String, f0: f32, lo: f32, hi: f32) {
    let mags = steady(render_of(world, &name));
    let gap = db(harmonic_level(&mags, N, f0, 1) / harmonic_level(&mags, N, f0, h));
    assert!((lo..=hi).contains(&gap), "harmonic {h} is {gap:.2} dB below the first, expected {lo} to {hi}");
}

#[then("each render is brighter than the one before")]
fn each_brighter(world: &mut SynthWorld) {
    let lights: Vec<f32> = (0..5).map(|i| brightness(&left(render_of(world, &format!("position-{i}"))), (0.1 * SR) as usize, N)).collect();
    println!("  brightness by position: {lights:.0?}");
    for w in lights.windows(2) {
        assert!(w[1] > w[0] * 1.05, "brightness does not rise across the table: {lights:?}");
    }
}

#[then(expr = "the first {float} seconds of {string} are brighter than the last {float} seconds")]
fn first_brighter_than_last(world: &mut SynthWorld, first: f32, name: String, last: f32) {
    let x = left(render_of(world, &name));
    // The early window sits inside `first` seconds (just after the 2 ms attack); the late one ends
    // well inside the last `last` seconds, clear of the release.
    assert!(2048.0 / SR <= first, "the early window does not fit in {first} s");
    let early = brightness(&x, (0.005 * SR) as usize, 2048);
    let late_start = x.len() - (last * SR) as usize - (0.1 * SR) as usize;
    let late = brightness(&x, late_start, 4096);
    println!("  early {early:.0} Hz, late {late:.0} Hz");
    assert!(early > late * 1.3, "the note does not settle: {early:.0} Hz early, {late:.0} Hz late");
}

fn brightness_spread(x: &[f32]) -> f32 {
    let x = left(x);
    let step = (0.1 * SR) as usize;
    let vals: Vec<f32> = (0..10).map(|i| brightness(&x, (0.05 * SR) as usize + i * step, 4096)).collect();
    let mean = vals.iter().sum::<f32>() / vals.len() as f32;
    (vals.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / vals.len() as f32).sqrt()
}

#[then(expr = "the brightness of {string} varies at least {int} times more than that of {string}")]
fn varies_more(world: &mut SynthWorld, moving: String, times: f32, still: String) {
    let (m, s) = (brightness_spread(render_of(world, &moving)), brightness_spread(render_of(world, &still)));
    println!("  brightness spread: moving {m:.1} Hz, still {s:.1} Hz");
    assert!(m > times * s.max(5.0), "moving {m:.1} Hz against still {s:.1} Hz");
}

/// Width in bins of the strongest partial at one tenth of its height.
fn partial_width(mags: &[f32]) -> usize {
    let k = peak_bin(mags);
    let floor = mags[k] * 0.1;
    let (mut lo, mut hi) = (k, k);
    while lo > 1 && mags[lo - 1] > floor {
        lo -= 1;
    }
    while hi + 1 < mags.len() && mags[hi + 1] > floor {
        hi += 1;
    }
    hi - lo + 1
}

#[then(expr = "the strongest partial of {string} is wider than that of {string}")]
fn wider(world: &mut SynthWorld, a: String, b: String) {
    let (wa, wb) = (partial_width(&steady(render_of(world, &a))), partial_width(&steady(render_of(world, &b))));
    println!("  partial width: {a} {wa} bins, {b} {wb} bins");
    assert!(wa > wb * 2, "{a} is {wa} bins wide, {b} is {wb}");
}

#[then(expr = "the two channels of {string} are identical")]
fn identical(world: &mut SynthWorld, name: String) {
    let x = render_of(world, &name);
    let (l, r) = (left(x), right(x));
    let worst = l.iter().zip(&r).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
    assert!(worst < 1.0e-4, "the channels differ by up to {worst}");
}

#[then(expr = "the two channels of {string} are not")]
fn not_identical(world: &mut SynthWorld, name: String) {
    let x = render_of(world, &name);
    let (l, r) = (left(x), right(x));
    let worst = l.iter().zip(&r).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
    assert!(worst > 0.01, "the channels are the same to within {worst}: the spread does nothing");
}

#[then(expr = "{string} is louder than {string} by between {int} and {int} dB")]
fn louder_by(world: &mut SynthWorld, a: String, b: String, lo: f32, hi: f32) {
    let gap = db(rms(&left(render_of(world, &a))[4000..20000]) / rms(&left(render_of(world, &b))[4000..20000]));
    assert!((lo..=hi).contains(&gap), "{a} is {gap:.2} dB louder than {b}, expected {lo} to {hi}");
}

fn energy_above(x: &[f32], hz: f32) -> f32 {
    let mags = steady(x);
    (((hz / bin_hz(N)) as usize)..mags.len()).map(|k| mags[k] * mags[k]).sum()
}

#[then(expr = "{string} has at least {int} dB less energy above {float} Hz than {string}")]
fn less_energy(world: &mut SynthWorld, quiet: String, db_less: f32, hz: f32, loud: String) {
    let gap = 10.0 * (energy_above(render_of(world, &loud), hz) / energy_above(render_of(world, &quiet), hz).max(1e-30)).log10();
    assert!(gap >= db_less, "only {gap:.1} dB less energy above {hz} Hz; needed {db_less}");
}

#[then(expr = "{string} lasts between {float} and {float} seconds")]
fn lasts(world: &mut SynthWorld, name: String, lo: f32, hi: f32) {
    let secs = render_of(world, &name).len() as f32 / 2.0 / SR;
    assert!((lo..=hi).contains(&secs), "the note lasts {secs:.3} s, expected {lo} to {hi}");
}

#[then(expr = "{string} is silent at its last sample")]
fn silent_at_end(world: &mut SynthWorld, name: String) {
    let x = render_of(world, &name);
    assert!(x[x.len() - 2].abs() < 1.0e-3 && x[x.len() - 1].abs() < 1.0e-3, "the note ends at {}, {}", x[x.len() - 2], x[x.len() - 1]);
}

#[then(expr = "{string} is brighter than {string}")]
fn brighter(world: &mut SynthWorld, a: String, b: String) {
    let start = (0.1 * SR) as usize;
    let (ba, bb) = (brightness(&left(render_of(world, &a)), start, N), brightness(&left(render_of(world, &b)), start, N));
    println!("  {a} {ba:.0} Hz, {b} {bb:.0} Hz");
    assert!(ba > bb * 1.5, "{a} is {ba:.0} Hz bright, {b} is {bb:.0}");
}

#[then(expr = "{string} is sample for sample the same as {string}")]
fn same(world: &mut SynthWorld, a: String, b: String) {
    assert!(render_of(world, &a) == render_of(world, &b), "the renders differ");
}

#[then(expr = "{string} is within {int} dB of {string} sample for sample")]
fn within_db(world: &mut SynthWorld, a: String, floor: f32, b: String) {
    let (x, y) = (render_of(world, &a), render_of(world, &b));
    let err: Vec<f32> = x.iter().zip(y).map(|(p, q)| p - q).collect();
    let gap = db(rms(y) / rms(&err));
    assert!(gap >= floor, "the two renders differ by only {gap:.1} dB below the signal; needed {floor}");
}

// ------------------------------------------------------------------------------------------
// The bounce
// ------------------------------------------------------------------------------------------

fn wav_slice(world: &SynthWorld, from: f32, to: f32) -> Vec<f32> {
    let w = world.bounced.as_ref().expect("no WAV was bounced");
    let (a, b) = (((from * SR) as usize) * 2, (((to * SR) as usize) * 2).min(w.len()));
    w[a..b].iter().map(|s| *s as f32 / 32768.0).collect()
}

#[then(expr = "the WAV is silent before {float} seconds")]
fn wav_silent_before(world: &mut SynthWorld, t: f32) {
    let peak = wav_slice(world, 0.0, t - 0.01).iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(peak < 1.0e-4, "there is sound before the first note: peak {peak}");
}

#[then(expr = "the WAV is audible from {float} seconds")]
fn wav_audible(world: &mut SynthWorld, t: f32) {
    let peak = wav_slice(world, t + 0.05, t + 0.3).iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(peak > 0.05, "the note at {t} s is silent: peak {peak}");
}

#[then("the WAV is silent between the two notes")]
fn wav_silent_between(world: &mut SynthWorld) {
    let peak = wav_slice(world, 1.0, 1.2).iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(peak < 1.0e-4, "there is sound between the notes: peak {peak}");
}

#[then(expr = "the first note in the WAV is at {float} Hz and the second at {float} Hz")]
fn wav_pitches(world: &mut SynthWorld, first: f32, second: f32) {
    for (t, hz) in [(0.55f32, first), (1.3, second)] {
        let seg = wav_slice(world, t, t + 0.35);
        let mono = left(&seg);
        let n = 8192;
        let mags = spectrum(&mono, 0, n);
        let got = strongest_hz(&mags, n);
        assert!((got - hz).abs() < 3.0, "the note at {t} s is at {got:.1} Hz, expected {hz}");
    }
    let _ = TABLE_SIZE;
}

fn main() {
    futures::executor::block_on(SynthWorld::cucumber().max_concurrent_scenarios(1).fail_on_skipped().run_and_exit("tests/features/wavetable_synth.feature"));
}

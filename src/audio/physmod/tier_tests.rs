//! The strings' quality tiers, measured (see `crate::audio::quality`, `body` and
//! `docs/PHYS_MOD_FIDELITY.md`, Part A1): each tier against `Render` playing the same phrase - how
//! far its spectrum moves, whether it plays in tune, and what it costs. Run with
//! `cargo test --release --lib physmod::tier_tests`.

use super::analysis::{pitch, spectrum};
use super::engine::*;
use super::*;
use crate::audio::quality::Quality;
use std::time::Instant;

const SR: f32 = ENGINE_SAMPLE_RATE as f32;

/// Energy per third-octave band from 100 Hz to 16 kHz, dB.
fn bands(x: &[f32]) -> Vec<f32> {
    let (m, bin) = spectrum(x, SR);
    let mut out = Vec::new();
    let mut f = 100.0f32;
    while f < 16_000.0 {
        let (a, b) = ((f / bin) as usize, ((f * 1.26) / bin) as usize);
        out.push(10.0 * m[a..b.min(m.len())].iter().map(|v| v * v).sum::<f32>().max(1e-30).log10());
        f *= 1.26;
    }
    out
}

/// How far the third-octave bands (those within 60 dB of the loudest) move from `a` to `b`: the
/// mean and the largest change, dB.
fn band_change(a: &[f32], b: &[f32]) -> (f32, f32) {
    let (a, b) = (bands(a), bands(b));
    let top = a.iter().copied().fold(f32::MIN, f32::max);
    let d: Vec<f32> = a.iter().zip(b.iter()).filter(|(x, _)| **x > top - 60.0).map(|(x, y)| (x - y).abs()).collect();
    (d.iter().sum::<f32>() / d.len() as f32, d.iter().copied().fold(0.0, f32::max))
}

fn left(x: &[f32]) -> Vec<f32> {
    x.iter().step_by(2).copied().collect()
}

struct Instrument {
    name: &'static str,
    strings: [f32; 4],
    sympathetic: [f32; 6],
    body_size: f32,
}

const VIOLIN: Instrument = Instrument { name: "violin", strings: VIOLIN_TUNING, sympathetic: [0.0; 6], body_size: 0.0 };
const CELLO: Instrument = Instrument { name: "cello", strings: [65.41, 98.0, 146.83, 220.0], sympathetic: [0.0; 6], body_size: 0.72 };
const BASS: Instrument = Instrument { name: "bass", strings: [41.2, 55.0, 73.42, 98.0], sympathetic: [0.0; 6], body_size: 1.0 };
/// A viola d'amore: seven sympathetic strings' worth (six here) under the bowed ones.
const AMORE: Instrument = Instrument { name: "viola d'amore", strings: [146.83, 220.0, 293.66, 440.0], sympathetic: [146.83, 220.0, 293.66, 369.99, 440.0, 587.33], body_size: 0.13 };

fn base(i: &Instrument, quality: Quality) -> PhysModParams {
    PhysModParams { strings: i.strings, sympathetic: i.sympathetic, body_size: i.body_size, quality, ..Default::default() }
}

/// Eight overlapping notes up the instrument (the cost benchmark's phrase), with vibrato, and a
/// second of ring after: the render and the seconds of CPU it took.
fn phrase(i: &Instrument, quality: Quality, velocity: f32) -> (Vec<f32>, f32) {
    let b = base(i, quality);
    let notes: Vec<PerformedNote> = (0..8)
        .map(|k| {
            let freq = i.strings[0] * 2f32.powf((k * 2) as f32 / 12.0);
            PerformedNote { start: k as f64 * 0.5, params: PhysModParams { freq, duration: 0.55, velocity, ..b } }
        })
        .collect();
    let t = Instant::now();
    let out = render_performance(&notes, 1.0);
    (left(&out), t.elapsed().as_secs_f32())
}

struct Comparison {
    /// Against `Render`, dB.
    mean_db: f32,
    worst_db: f32,
    /// `Render` against itself played 1% louder: how far the bands move anyway (a bowed string is
    /// a nonlinear oscillator, and a phrase's bands move with it). No tier is held closer than this.
    floor_mean_db: f32,
    /// This tier's cost over `Render`'s.
    cost: f32,
    /// Seconds of CPU per second of audio at this tier.
    core: f32,
}

fn best(i: &Instrument, q: Quality) -> (Vec<f32>, f32) {
    // The quickest of three renders: one timing is at the mercy of whatever else the machine does.
    (0..3).map(|_| phrase(i, q, 0.8)).min_by(|a, b| a.1.total_cmp(&b.1)).unwrap()
}

fn compare(i: &Instrument, q: Quality) -> Comparison {
    let (full, full_cpu) = best(i, Quality::Render);
    let (tier, tier_cpu) = best(i, q);
    let (louder, _) = phrase(i, Quality::Render, 0.8 * 1.01);
    let (mean_db, worst_db) = band_change(&full, &tier);
    let (floor_mean_db, _) = band_change(&full, &louder);
    Comparison { mean_db, worst_db, floor_mean_db, cost: tier_cpu / full_cpu.max(1e-9), core: tier_cpu / (tier.len() as f32 / SR) }
}

/// Every instrument's numbers, for choosing the tiers' settings.
#[test]
#[ignore]
fn tier_report() {
    println!("\n| Instrument | Tier | Mean band change vs Render (dB) | Largest (dB) | 1% louder: mean (dB) | Cost vs Render | One core (%) |");
    println!("|---|---|---|---|---|---|---|");
    for i in [&VIOLIN, &CELLO, &BASS, &AMORE] {
        for q in Quality::ALL {
            let c = compare(i, q);
            println!("| {} | {} | {:.2} | {:.2} | {:.2} | {:.0}% | {:.1} |", i.name, q.name(), c.mean_db, c.worst_db, c.floor_mean_db, c.cost * 100.0, c.core * 100.0);
        }
    }
}

/// How much vibrato makes a held note's upper harmonics swell and fade as they sweep across the
/// body's resonances: for harmonics 3 to 12, the spread (dB, 90th over 10th percentile) of each
/// one's level over a second and a half of vibrato, averaged.
fn vibrato_shimmer(freq: f32, quality: Quality) -> f32 {
    let p = PhysModParams { freq, duration: 3.0, vibrato_depth: 20.0, vibrato_delay: 0.0, bow_noise: 0.0, quality, ..Default::default() };
    let x = left(&render_note(std::sync::Arc::new(PhysModShared::default()), p, 2.5));
    let seg = &x[(1.0 * SR) as usize..(2.5 * SR) as usize];
    let (frame, hop) = (2048usize, 256usize);
    let mut spreads = Vec::new();
    for h in 3..=12 {
        let center = freq * h as f32;
        if center > 12_000.0 {
            break;
        }
        let mut levels = Vec::new();
        let mut i = 0;
        while i + frame <= seg.len() {
            let (m, bin) = spectrum(&seg[i..i + frame], SR);
            let (a, b) = ((center * 0.97 / bin) as usize, (center * 1.03 / bin) as usize + 1);
            let peak = m[a..b.min(m.len())].iter().copied().fold(0.0f32, f32::max);
            levels.push(20.0 * peak.max(1e-12).log10());
            i += hop;
        }
        levels.sort_by(|a, b| a.total_cmp(b));
        let n = levels.len();
        spreads.push(levels[n * 9 / 10] - levels[n / 10]);
    }
    spreads.iter().sum::<f32>() / spreads.len() as f32
}

const STOPPED_NOTES: [f32; 5] = [220.0, 261.63, 349.23, 523.25, 698.46];

#[test]
fn live_and_draft_share_a_body_and_render_describes_it_more_finely() {
    let spec = PhysModParams::default().body_spec();
    let sr_os = SR * OVERSAMPLE as f32;
    let (draft, live, render) = (body::Body::new(spec, sr_os, SR, Quality::Draft), body::Body::new(spec, sr_os, SR, Quality::Live), body::Body::new(spec, sr_os, SR, Quality::Render));
    assert_eq!(live.radiating_count(), body::RADIATING_MODES);
    assert_eq!(draft.radiating_count(), body::RADIATING_MODES);
    assert_eq!(render.radiating_count(), body::RENDER_RADIATING_MODES);
    for i in 0..body::RADIATING_MODES {
        assert_eq!(draft.radiating_mode(i), live.radiating_mode(i), "Draft's field is Live's");
        // Render keeps every one of Live's modes where it was.
        assert_eq!(render.radiating_mode(i).0, live.radiating_mode(i).0);
    }
    // Above 3 kHz, Render's modes are a few tens of Hz apart and overlap (half-power bandwidth over
    // spacing above 1), where Live's are hundreds apart and isolated.
    let overlap = |b: &body::Body| {
        let mut f: Vec<(f32, f32)> = (0..b.radiating_count()).map(|i| b.radiating_mode(i)).filter(|m| m.0 > 3000.0 && m.0 < 8000.0).map(|m| (m.0, m.1)).collect();
        f.sort_by(|a, b| a.0.total_cmp(&b.0));
        let spacing = (f.last().unwrap().0 - f[0].0) / (f.len() - 1) as f32;
        let bandwidth = f.iter().map(|m| m.0 / m.1).sum::<f32>() / f.len() as f32;
        (spacing, bandwidth / spacing)
    };
    let ((live_spacing, live_overlap), (render_spacing, render_overlap)) = (overlap(&live), overlap(&render));
    println!("above 3 kHz: live {live_spacing:.0} Hz apart (overlap {live_overlap:.2}), render {render_spacing:.0} Hz apart (overlap {render_overlap:.2})");
    assert!(render_spacing < 50.0 && render_overlap > 1.0, "render: {render_spacing:.0} Hz apart, overlap {render_overlap:.2}");
    assert!(live_overlap < 0.5);
}

#[test]
fn every_tier_keeps_the_instruments_colour() {
    // The same phrase at each tier against Render: the third-octave bands of the whole phrase.
    for i in [&VIOLIN, &CELLO, &BASS, &AMORE] {
        let full = phrase(i, Quality::Render, 0.8).0;
        for q in [Quality::Draft, Quality::Live] {
            let (mean, worst) = band_change(&full, &phrase(i, q, 0.8).0);
            assert!(mean < 1.0 && worst < 3.5, "{} at {}: bands move {mean:.2} dB on average, {worst:.2} at most", i.name, q.name());
        }
    }
}

#[test]
fn every_tier_plays_in_tune() {
    for &f in &[196.0f32, 349.23, 659.25, 987.77] {
        let cents: Vec<f32> = Quality::ALL.iter().map(|&quality| analysis::analyze_note(&PhysModParams { freq: f, vibrato_depth: 0.0, quality, ..Default::default() }, 0.8, 0.3).cents).collect();
        for (q, c) in Quality::ALL.iter().zip(&cents) {
            assert!((c - cents[2]).abs() < 3.0, "{f} Hz at {}: {c:+.1} cents, Render {:+.1}", q.name(), cents[2]);
        }
    }
}

#[test]
fn render_vibrato_sweeps_the_harmonics_across_more_of_the_body() {
    // The dense field's detail is what vibrato plays across: the upper harmonics swell and fade
    // more as they sweep through it (the shimmer of a vibrato note). Measured 1.1-2.2 dB more on
    // stopped notes up to ~700 Hz; above that the harmonics measured run past the field.
    let mean = |q: Quality| STOPPED_NOTES.iter().map(|&f| vibrato_shimmer(f, q)).sum::<f32>() / STOPPED_NOTES.len() as f32;
    let (live, render) = (mean(Quality::Live), mean(Quality::Render));
    assert!(render > live + 0.8, "vibrato moves the upper harmonics {render:.2} dB at Render, {live:.2} at Live");
}

#[test]
fn draft_leaves_sympathetic_ringing_out() {
    // A note on the D string; the open G string is left alone and only rings in sympathy.
    let ring_of_open_g = |quality: Quality| {
        let p = PhysModParams { freq: 293.66 * 1.5, duration: 1.0, quality, ..Default::default() };
        let mut e = Engine::new(SR, &p);
        e.note_on(1, p, false, None);
        for _ in 0..(0.8 * SR) as usize {
            e.next_frame();
        }
        e.string(0).level
    };
    assert!(ring_of_open_g(Quality::Live) > 1.0e-4, "Live: the open G rings in sympathy");
    assert_eq!(ring_of_open_g(Quality::Draft), 0.0, "Draft: an unplayed string is not computed");
    let amore = base(&AMORE, Quality::Draft);
    assert_eq!(Engine::new(SR, &amore).string_count(), (4, 0), "no sympathetic strings in Draft");
    assert_eq!(Engine::new(SR, &base(&AMORE, Quality::Live)).string_count(), (4, 6));
}

#[test]
fn a_rung_down_string_is_far_below_a_played_one() {
    // What `DRAFT_REST_LEVEL` means: a mezzo note's string level against the level below which
    // Draft stops computing an unplayed string.
    let p = PhysModParams { freq: 440.0, duration: 1.0, ..Default::default() };
    let mut e = Engine::new(SR, &p);
    let s = e.note_on(1, p, false, None);
    for _ in 0..(0.5 * SR) as usize {
        e.next_frame();
    }
    let below = 20.0 * (e.string(s).level / 2.0e-5).log10();
    println!("the rest level is {below:.0} dB below a mezzo note");
    assert!(below > 70.0, "the rest level is only {below:.0} dB below a mezzo note");
}

#[test]
fn a_new_tier_is_a_new_instrument() {
    let live = PhysModParams::default();
    let draft = PhysModParams { quality: Quality::Draft, ..live };
    assert!(Engine::new(SR, &live).same_strings(&live));
    assert!(!Engine::new(SR, &live).same_strings(&draft));
    let handle = InstrumentHandle::new(&live);
    assert!(handle.same_tuning(&live) && !handle.same_tuning(&draft));
}

#[test]
fn draft_costs_well_under_render() {
    let draft = best(&VIOLIN, Quality::Draft).1;
    let render = best(&VIOLIN, Quality::Render).1;
    assert!(draft < 0.75 * render, "Draft takes {:.0}% of Render's time", 100.0 * draft / render);
}

/// Every instrument's numbers, for the tables in `docs/PHYS_MOD_FIDELITY.md`.
#[test]
#[ignore]
fn shimmer_report() {
    for f in STOPPED_NOTES {
        let (l, r) = (vibrato_shimmer(f, Quality::Live), vibrato_shimmer(f, Quality::Render));
        println!("{f} Hz: live {l:.2} dB, render {r:.2} dB");
    }
}

#[test]
fn reshaping_a_render_body_is_quick_enough_for_the_audio_thread() {
    // A body setting changed between notes reshapes the body on the audio thread; Render's also
    // rescales its dense field to match Live's (`body::MatchGrid`).
    let spec = PhysModParams::default().body_spec();
    let mut b = body::Body::new(spec, SR * OVERSAMPLE as f32, SR, Quality::Render);
    let t = Instant::now();
    for k in 0..10 {
        b.configure(body::BodySpec { brightness: 0.1 * k as f32, ..spec });
    }
    let ms = t.elapsed().as_secs_f32() * 100.0;
    println!("a Render body reshapes in {ms:.2} ms");
    // Well under an audio block in a release build (a debug build is several times slower).
    assert!(ms < if cfg!(debug_assertions) { 40.0 } else { 3.0 }, "reshaping took {ms:.2} ms");
}

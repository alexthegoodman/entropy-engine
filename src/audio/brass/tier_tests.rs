//! Brass quality tiers, measured (see `engine::oversample`, `crate::audio::quality` and
//! `docs/PHYS_MOD_FIDELITY.md`, Part A1): each tier against `Render` playing the same phrase and
//! notes - how far the spectrum moves, whether it plays in tune, and what it costs. Run with
//! `cargo test --release --lib brass::tier_tests`.

use super::analysis::analyze_note;
use super::engine::*;
use super::*;
use crate::audio::physmod::analysis::spectrum;
use crate::audio::quality::Quality;
use std::time::Instant;

const SR: f32 = ENGINE_SAMPLE_RATE as f32;

/// Energy per third-octave band from 50 Hz to 16 kHz, dB.
fn bands(x: &[f32]) -> Vec<f32> {
    let (m, bin) = spectrum(x, SR);
    let mut out = Vec::new();
    let mut f = 50.0f32;
    while f < 16_000.0 {
        let (a, b) = ((f / bin) as usize, ((f * 1.26) / bin) as usize);
        out.push(10.0 * m[a..b.min(m.len())].iter().map(|v| v * v).sum::<f32>().max(1e-30).log10());
        f *= 1.26;
    }
    out
}

/// How far the third-octave bands within 60 dB of the loudest move from `a` to `b`: mean and
/// largest, dB.
fn band_change(a: &[f32], b: &[f32]) -> (f32, f32) {
    let (a, b) = (bands(a), bands(b));
    let top = a.iter().copied().fold(f32::MIN, f32::max);
    let d: Vec<f32> = a.iter().zip(b.iter()).filter(|(x, _)| **x > top - 60.0).map(|(x, y)| (x - y).abs()).collect();
    (d.iter().sum::<f32>() / d.len() as f32, d.iter().copied().fold(0.0, f32::max))
}

/// The instruments, each with the bottom of the phrase it plays.
const PLAYERS: [(BrassInstrument, f32); 4] = [(BrassInstrument::TenorTrombone, 116.54), (BrassInstrument::Trumpet, 233.08), (BrassInstrument::Horn, 174.61), (BrassInstrument::Tuba, 58.27)];

/// Eight notes up the instrument, tongued, at `breath`: the render (mono) and the seconds of CPU
/// it took (the cost benchmark's phrase).
fn phrase(instrument: BrassInstrument, low: f32, quality: Quality, breath: f32) -> (Vec<f32>, f32) {
    let base = BrassParams { instrument, quality, breath, ..Default::default() };
    let notes: Vec<(f64, BrassParams)> = (0..8).map(|i| (i as f64 * 0.5, BrassParams { freq: low * 2f32.powf((i * 2) as f32 / 12.0), duration: 0.45, ..base })).collect();
    let t = Instant::now();
    let out = render_performance(&notes, 1.0);
    (out.iter().step_by(2).copied().collect(), t.elapsed().as_secs_f32())
}

fn best(instrument: BrassInstrument, low: f32, q: Quality, breath: f32) -> (Vec<f32>, f32) {
    (0..3).map(|_| phrase(instrument, low, q, breath)).min_by(|a, b| a.1.total_cmp(&b.1)).unwrap()
}

/// Every instrument's numbers, for choosing the tiers' settings.
#[test]
#[ignore]
fn tier_report() {
    println!("\n| Instrument | Breath | Tier | Mean band change vs Render (dB) | Largest (dB) | 2% more breath: mean (dB) | Cost vs Render | One core (%) |");
    println!("|---|---|---|---|---|---|---|---|");
    for (instrument, low) in PLAYERS {
        for breath in [0.5f32, 0.8] {
            let (full, full_cpu) = best(instrument, low, Quality::Render, breath);
            let (more, _) = phrase(instrument, low, Quality::Render, breath * 1.02);
            let (floor, _) = band_change(&full, &more);
            for q in Quality::ALL {
                let (x, cpu) = best(instrument, low, q, breath);
                let (mean, worst) = band_change(&full, &x);
                println!("| {} | {breath} | {} | {mean:.2} | {worst:.2} | {floor:.2} | {:.0}% | {:.1} |", instrument.name(), q.name(), cpu / full_cpu * 100.0, cpu / (x.len() as f32 / SR) * 100.0);
            }
        }
    }
}

/// Energy between the harmonics of a steady note, relative to the whole, dB: aliased shock-front
/// harmonics fold back between the real ones.
fn inharmonic_db(p: BrassParams) -> f32 {
    let (x, _) = render_note(&BrassParams { duration: 2.0, breath_noise: 0.0, ..p }, SR, 2.0);
    let seg = &x[(1.0 * SR) as usize..(2.0 * SR) as usize];
    let f0 = crate::audio::physmod::analysis::pitch(seg, SR, p.freq);
    let (m, bin) = spectrum(seg, SR);
    let (mut harm, mut other) = (0.0f64, 0.0f64);
    for (i, v) in m.iter().enumerate() {
        let f = i as f32 * bin;
        if f < 50.0 {
            continue;
        }
        let k = (f / f0).round().max(1.0);
        let e = (*v as f64).powi(2);
        if (f - k * f0).abs() < 0.08 * f0 {
            harm += e;
        } else {
            other += e;
        }
    }
    10.0 * (other / (harm + other)).log10() as f32
}

#[test]
#[ignore]
fn alias_report() {
    for (instrument, low) in PLAYERS {
        for breath in [0.5f32, 0.8, 0.95] {
            let freq = low * 2.0;
            let c: Vec<String> = Quality::ALL.iter().map(|&quality| format!("{} {:.1}", quality.name(), inharmonic_db(BrassParams { instrument, freq, breath, quality, ..Default::default() }))).collect();
            println!("{} {freq:.1} breath {breath}: {}", instrument.name(), c.join(" | "));
        }
    }
}

#[test]
fn each_tier_runs_the_air_column_at_its_own_rate() {
    assert_eq!(oversample(Quality::Draft), 1);
    assert_eq!(oversample(Quality::Live), OVERSAMPLE);
    assert_eq!(oversample(Quality::Render), MAX_OVERSAMPLE);
    for q in Quality::ALL {
        let e = Engine::new(SR, &BrassParams { quality: q, ..Default::default() });
        assert_eq!(e.quality(), q);
        assert_eq!(e.bore().sample_rate(), SR * oversample(q) as f32);
    }
    let live = BrassParams::default();
    let handle = BrassHandle::new(&live);
    assert!(handle.same_instrument(&live) && !handle.same_instrument(&BrassParams { quality: Quality::Draft, ..live }), "a new tier is a new player");
}

#[test]
fn every_tier_plays_in_tune() {
    let notes = [(BrassInstrument::TenorTrombone, 116.54), (BrassInstrument::TenorTrombone, 233.08), (BrassInstrument::Trumpet, 466.16), (BrassInstrument::Horn, 523.25), (BrassInstrument::Tuba, 58.27)];
    for (instrument, freq) in notes {
        for quality in Quality::ALL {
            let a = analyze_note(&BrassParams { instrument, freq, quality, ..Default::default() }, 1.0, 0.4);
            assert!(a.cents.abs() < 3.0, "{} {freq} Hz at {}: {:+.1} cents", instrument.name(), quality.name(), a.cents);
        }
    }
}

#[test]
fn every_tier_keeps_the_tone() {
    // The phrase at mezzo and forte, against Render. Live runs the model as it always has, at half
    // Render's rate; Draft at a quarter of it, darker above ~10 kHz (the last octave below its own
    // Nyquist) and with more aliasing between the harmonics, but the same below.
    for (instrument, low) in PLAYERS {
        for breath in [0.5f32, 0.8] {
            let full = phrase(instrument, low, Quality::Render, breath).0;
            let (live, _) = band_change(&full, &phrase(instrument, low, Quality::Live, breath).0);
            let (draft, _) = band_change(&full, &phrase(instrument, low, Quality::Draft, breath).0);
            assert!(live < 1.0, "{} at breath {breath}: Live's bands move {live:.2} dB on average", instrument.name());
            assert!(draft < 2.5, "{} at breath {breath}: Draft's bands move {draft:.2} dB on average", instrument.name());
        }
    }
}

#[test]
fn render_folds_less_back_between_the_harmonics() {
    // At four times the engine rate the lips' and the wavefront's upper harmonics are carried to
    // 88 kHz before they are filtered away, instead of folding back from 44 kHz between the real
    // ones (measured 4-9 dB less at every dynamic).
    for (instrument, low) in [PLAYERS[0], PLAYERS[1], PLAYERS[3]] {
        let p = BrassParams { instrument, freq: low * 2.0, breath: 0.8, ..Default::default() };
        let (live, render) = (inharmonic_db(p), inharmonic_db(BrassParams { quality: Quality::Render, ..p }));
        assert!(render < live - 3.0, "{}: {render:.1} dB between the harmonics at Render, {live:.1} at Live", instrument.name());
    }
}

#[test]
fn draft_costs_well_under_live() {
    let (instrument, low) = PLAYERS[0];
    let draft = best(instrument, low, Quality::Draft, 0.5).1;
    let live = best(instrument, low, Quality::Live, 0.5).1;
    assert!(draft < 0.7 * live, "Draft takes {:.0}% of Live's time", 100.0 * draft / live);
}

#[test]
fn a_skilled_player_speaks_as_quickly_at_every_tier() {
    // The guided attack pulls the lips as hard per second at every rate.
    for (instrument, low) in PLAYERS {
        let at = |quality| analyze_note(&BrassParams { instrument, freq: low * 2.0, quality, ..Default::default() }, 0.6, 0.2).attack_secs.unwrap();
        let (live, draft, render) = (at(Quality::Live), at(Quality::Draft), at(Quality::Render));
        for (q, t) in [("draft", draft), ("render", render)] {
            assert!((t - live).abs() <= 0.011, "{}: speaks in {:.0} ms at {q}, {:.0} ms at live", instrument.name(), t * 1e3, live * 1e3);
        }
    }
}

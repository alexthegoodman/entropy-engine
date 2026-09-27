//! What each modelled instrument costs: how long it takes to build (cold, then again once its
//! caches are warm) and how much of one core it takes to play, as a Markdown table. The table in
//! `docs/PHYS_MOD_FIDELITY.md` ("Measured costs") is this test's output; a change that makes an
//! instrument dearer updates it.
//!
//! A kit renders on the calling thread plus the workers `Kit::new` starts, so its figure is wall
//! time over audio time - what the audio thread waits for - not the sum over threads.
//!
//! Ignored by default (it takes a while and the numbers depend on the machine). Run with
//! `cargo test --release --test phys_mod_cost -- --ignored --nocapture`.

use entropy_engine::audio::quality::Quality;
use entropy_engine::audio::{brass, matter, physmod};
use std::time::Instant;

const SR: f32 = 44_100.0;

struct Row {
    name: String,
    build_cold_ms: f64,
    build_warm_ms: f64,
    core_pct: f64,
}

/// Seconds of CPU per second of audio for `render`, as a percentage of one core.
fn core_pct(render: impl FnOnce() -> Vec<f32>) -> f64 {
    let t = Instant::now();
    let out = render();
    let cpu = t.elapsed().as_secs_f64();
    let audio = out.len() as f64 / 2.0 / SR as f64;
    assert!(audio > 0.0, "nothing was rendered");
    100.0 * cpu / audio
}

fn ms(f: impl FnOnce()) -> f64 {
    let t = Instant::now();
    f();
    t.elapsed().as_secs_f64() * 1e3
}

fn string_instrument(name: &str, strings: [f32; 4], body_size: f32, quality: Quality) -> Row {
    let base = physmod::PhysModParams { strings, body_size, quality, ..Default::default() };
    let build_cold_ms = ms(|| drop(physmod::Engine::new(SR, &base)));
    let build_warm_ms = ms(|| drop(physmod::Engine::new(SR, &base)));
    // Eight overlapping notes up the instrument, two seconds of ring after.
    let notes: Vec<physmod::PerformedNote> = (0..8)
        .map(|i| {
            let freq = strings[0] * 2f32.powf((i * 2) as f32 / 12.0);
            physmod::PerformedNote { start: i as f64 * 0.5, params: physmod::PhysModParams { freq, duration: 0.55, ..base } }
        })
        .collect();
    let core_pct = core_pct(|| physmod::render_performance(&notes, 2.0));
    Row { name: tiered(name, quality), build_cold_ms, build_warm_ms, core_pct }
}

/// "Strings: violin" at `Live`, "Strings (draft): violin" otherwise.
fn tiered(name: &str, quality: Quality) -> String {
    match (quality, name.split_once(": ")) {
        (Quality::Live, _) | (_, None) => name.into(),
        (q, Some((family, what))) => format!("{family} ({}): {what}", q.name()),
    }
}

fn brass_instrument(instrument: brass::BrassInstrument, low: f32, quality: Quality) -> Row {
    let base = brass::BrassParams { instrument, quality, ..Default::default() };
    let build_cold_ms = ms(|| drop(brass::Engine::new(SR, &base)));
    let build_warm_ms = ms(|| drop(brass::Engine::new(SR, &base)));
    let notes: Vec<(f64, brass::BrassParams)> = (0..8).map(|i| (i as f64 * 0.5, brass::BrassParams { freq: low * 2f32.powf((i * 2) as f32 / 12.0), duration: 0.45, ..base })).collect();
    let core_pct = core_pct(|| brass::render_performance(&notes, 1.0));
    Row { name: tiered(&format!("Brass: {}", instrument.name()), quality), build_cold_ms, build_warm_ms, core_pct }
}

fn kit(name: &str, spec: matter::KitSpec, hits: &[(f64, matter::KitHit)]) -> Row {
    let build_cold_ms = ms(|| drop(matter::Kit::new(spec, SR)));
    let build_warm_ms = ms(|| drop(matter::Kit::new(spec, SR)));
    let core_pct = core_pct(|| matter::render_performance(spec, [1.0; matter::kit::PIECES], hits, 3.0));
    Row { name: name.into(), build_cold_ms, build_warm_ms, core_pct }
}

#[test]
#[ignore]
fn instrument_costs() {
    use matter::{KitHit, Piece};
    let mut rows = Vec::new();
    for quality in Quality::ALL {
        rows.push(string_instrument("Strings: violin", [196.0, 293.66, 440.0, 659.25], 0.0, quality));
        rows.push(string_instrument("Strings: cello", [65.41, 98.0, 146.83, 220.0], 0.72, quality));
        rows.push(string_instrument("Strings: bass", [41.2, 55.0, 73.42, 98.0], 1.0, quality));
    }
    for quality in Quality::ALL {
        for (i, low) in [(brass::BrassInstrument::TenorTrombone, 116.54), (brass::BrassInstrument::Trumpet, 233.08), (brass::BrassInstrument::Horn, 174.61), (brass::BrassInstrument::Tuba, 58.27)] {
            rows.push(brass_instrument(i, low, quality));
        }
    }
    // A bar of groove at 120 bpm, twice: kick, snare, toms and the crash on the one.
    let mut groove = Vec::new();
    for bar in 0..2 {
        let t0 = bar as f64 * 2.0;
        groove.push((t0, KitHit::at(Piece::Crash, 6.0, 0.9)));
        for beat in 0..4 {
            let t = t0 + beat as f64 * 0.5;
            groove.push((t, KitHit::at(if beat % 2 == 0 { Piece::Kick } else { Piece::Snare }, 5.0, 0.3)));
        }
        groove.push((t0 + 1.75, KitHit::at(Piece::RackTom, 5.0, 0.3)));
        groove.push((t0 + 1.875, KitHit::at(Piece::FloorTom, 5.0, 0.3)));
    }
    let draft = matter::KitSpec { quality: Quality::Draft, ..Default::default() };
    rows.push(kit("Kit: groove with crash", matter::KitSpec::default(), &groove));
    rows.push(kit("Kit (draft): groove with crash", draft, &groove));
    rows.push(kit("Kit: one hard crash", matter::KitSpec::default(), &[(0.0, KitHit::at(Piece::Crash, 12.0, 0.95))]));
    rows.push(kit("Kit (draft): one hard crash", draft, &[(0.0, KitHit::at(Piece::Crash, 12.0, 0.95))]));
    rows.push(kit("Kit: one snare hit", matter::KitSpec::default(), &[(0.0, KitHit::at(Piece::Snare, 5.0, 0.3))]));

    println!();
    println!("| Instrument | Build, cold (ms) | Build, warm (ms) | One core, playing (%) |");
    println!("|---|---|---|---|");
    for r in &rows {
        println!("| {} | {:.0} | {:.0} | {:.1} |", r.name, r.build_cold_ms, r.build_warm_ms, r.core_pct);
    }
}

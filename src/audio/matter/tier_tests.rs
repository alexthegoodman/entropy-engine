//! The quality tiers, measured (see `crate::audio::quality` and `docs/PHYS_MOD_FIDELITY.md`, Part
//! A1): each piece at `Draft` against the same piece as modelled at `Render`, struck the same way -
//! how far its spectrum moves and how much cheaper it is. Run with
//! `cargo test --release --lib matter::tier_tests`.

use super::kit::*;
use super::*;
use crate::audio::quality::Quality;
use std::time::Instant;

const SR: f32 = 44_100.0;

/// Energy per third-octave band from 100 Hz to 16 kHz, dB.
fn bands(x: &[f32]) -> Vec<f32> {
    let (m, bin) = crate::audio::physmod::analysis::spectrum(x, SR);
    let mut out = Vec::new();
    let mut f = 100.0f32;
    while f < 16_000.0 {
        let (a, b) = ((f / bin) as usize, ((f * 1.26) / bin) as usize);
        out.push(10.0 * m[a..b.min(m.len())].iter().map(|v| v * v).sum::<f32>().max(1e-30).log10());
        f *= 1.26;
    }
    out
}

/// A piece struck where it is usually played, at `quality`: its first `seconds` and the seconds of
/// CPU the rendering took (the build is not counted).
fn strike(piece: Piece, speed: f32, quality: Quality, seconds: f32) -> (Vec<f32>, f32) {
    let spec = KitSpec { quality, ..KitSpec::default() };
    let mut body = Body::build(&spec, piece, SR);
    body.strike(KitHit::at(piece, speed, if piece.is_cymbal() { 0.9 } else { 0.3 }).strike);
    let t = Instant::now();
    let x: Vec<f32> = (0..(seconds * SR) as usize).map(|_| body.next_sample()).collect();
    (x, t.elapsed().as_secs_f32())
}

/// How far a struck piece's third-octave bands (those within 60 dB of the loudest) move from
/// `a` to `b`: the mean and the largest change, dB.
fn band_change(a: &[f32], b: &[f32]) -> (f32, f32) {
    let (a, b) = (bands(a), bands(b));
    let top = a.iter().copied().fold(f32::MIN, f32::max);
    let d: Vec<f32> = a.iter().zip(b.iter()).filter(|(x, _)| **x > top - 60.0).map(|(x, y)| (x - y).abs()).collect();
    (d.iter().sum::<f32>() / d.len() as f32, d.iter().copied().fold(0.0, f32::max))
}

struct Comparison {
    /// Draft against Render, dB.
    mean_db: f32,
    worst_db: f32,
    /// Render against itself struck 1% harder: how far the bands move anyway, since the snare's
    /// buzz and a cymbal's wash are chaotic. No tier can be held closer than this.
    floor_mean_db: f32,
    floor_worst_db: f32,
    /// Draft's cost as a fraction of Render's.
    cost: f32,
}

fn compare(piece: Piece) -> Comparison {
    let (speed, seconds) = if piece.is_cymbal() { (8.0, 2.0) } else { (5.0, 1.0) };
    // The quickest of three renders each: a single timing of a cheap drum is at the mercy of
    // whatever else the machine is doing.
    let best = |q: Quality| (0..3).map(|_| strike(piece, speed, q, seconds)).min_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
    let (full, full_cpu) = best(Quality::Render);
    let (draft, draft_cpu) = best(Quality::Draft);
    let (harder, _) = strike(piece, speed * 1.01, Quality::Render, seconds);
    let (mean_db, worst_db) = band_change(&full, &draft);
    let (floor_mean_db, floor_worst_db) = band_change(&full, &harder);
    Comparison { mean_db, worst_db, floor_mean_db, floor_worst_db, cost: draft_cpu / full_cpu.max(1e-9) }
}

#[test]
fn live_is_render_until_render_outgrows_real_time() {
    for piece in Piece::ALL {
        let live = KitSpec { quality: Quality::Live, ..KitSpec::default() };
        let render = KitSpec { quality: Quality::Render, ..KitSpec::default() };
        assert_eq!(live.drum(piece), render.drum(piece));
        assert_eq!(live.cymbal(piece).map(|c| (c.options, c.every)), render.cymbal(piece).map(|c| (c.options, c.every)));
    }
    assert!(!KitSpec { quality: Quality::Draft, ..KitSpec::default() }.same_build(&KitSpec::default()), "a new tier is a new kit");
}

#[test]
fn drums_are_the_same_at_every_tier() {
    let (full, draft) = (KitSpec { quality: Quality::Render, ..KitSpec::default() }, KitSpec { quality: Quality::Draft, ..KitSpec::default() });
    for piece in [Piece::Kick, Piece::Snare, Piece::RackTom, Piece::FloorTom] {
        assert_eq!(full.drum(piece), draft.drum(piece), "{piece:?}");
    }
}

#[test]
fn draft_cymbals_keep_their_wash_for_half_the_cost_or_less() {
    for piece in [Piece::Crash, Piece::Ride, Piece::Splash] {
        let c = compare(piece);
        // Within twice what striking it 1% harder does, plus 1.5 dB for a stroke that is nearly
        // linear (a ride at this speed barely moves when struck harder, but draft still changes it).
        assert!(c.mean_db < 2.0 * c.floor_mean_db + 1.5, "{piece:?}: bands move {:.2} dB on average (1% harder: {:.2})", c.mean_db, c.floor_mean_db);
        assert!(c.cost < 0.5, "{piece:?}: draft costs {:.0}% of the full cymbal", c.cost * 100.0);
    }
}

/// Every piece's numbers, for choosing the tiers' settings.
#[test]
#[ignore]
fn tier_report() {
    println!("\n| Piece | Draft: mean band change (dB) | Largest (dB) | 1% harder: mean (dB) | Largest (dB) | Draft cost / full |");
    println!("|---|---|---|---|---|---|");
    for piece in Piece::ALL {
        let c = compare(piece);
        println!("| {piece:?} | {:.2} | {:.2} | {:.2} | {:.2} | {:.0}% |", c.mean_db, c.worst_db, c.floor_mean_db, c.floor_worst_db, c.cost * 100.0);
    }
}

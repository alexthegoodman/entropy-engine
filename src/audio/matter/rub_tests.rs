//! Friction (Phase 3), measured: stick-slip and sliding, roughness, brushes on a snare, a finger or a
//! rubber ball on glass. Every claim is rendered offline and measured, as for the drums and cymbals.
//! Run with `cargo test --release --lib matter`.

use super::drum::*;
use super::rub::*;
use super::sheet::*;
use super::tests::{above, centroid, db, rms, secs};
use super::*;
use super::cymbal::{Cymbal, CymbalSpec};

const SR: f32 = 44_100.0;

/// Renders `stroke` on `sheet`, recording the rub's report every sample.
fn on_sheet(spec: SheetSpec, stroke: Stroke, tail: f32) -> (Vec<f32>, Vec<RubReport>) {
    let mut s = Sheet::new(spec, stroke.tool, SR);
    s.rub(stroke);
    let n = ((stroke.duration + tail) * SR) as usize;
    let mut out = Vec::with_capacity(n);
    let mut reps = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(s.next_sample());
        reps.push(s.rub_report());
    }
    (out, reps)
}

fn on_drum(spec: DrumSpec, stroke: Stroke, tail: f32, rough: Option<friction::Roughness>) -> (Vec<f32>, Vec<RubReport>) {
    let mut d = Drum::new(spec, SR);
    d.enable_rubbing(stroke.tool);
    if let Some(r) = rough {
        d.rubbing_mut().unwrap().set_roughness(r);
    }
    d.rub(stroke);
    let n = ((stroke.duration + tail) * SR) as usize;
    let mut out = Vec::with_capacity(n);
    let mut reps = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(d.next_sample());
        reps.push(d.rub_report());
    }
    (out, reps)
}

/// A stroke round a sheet, 8 cm out, as long as it needs to be.
fn line(tool: ToolSpec, speed: f32, pressure: f32, duration: f32) -> Stroke {
    Stroke { tool, path: Path::Circle { centre: [0.0, 0.0], radius: 0.08 }, speed, pressure, duration, ease: 0.02 }
}

/// Spectral flatness of `seg` between 200 Hz and 8 kHz, dB (0 for white noise, very negative for a
/// few lines).
fn flatness(seg: &[f32]) -> f32 {
    let (m, bin) = crate::audio::physmod::analysis::spectrum(seg, SR);
    let (lo, hi) = ((200.0 / bin) as usize, ((8000.0 / bin) as usize).min(m.len()));
    let p: Vec<f64> = m[lo..hi].iter().map(|v| (*v as f64).powi(2).max(1.0e-40)).collect();
    let geo = (p.iter().map(|v| v.ln()).sum::<f64>() / p.len() as f64).exp();
    let arith = p.iter().sum::<f64>() / p.len() as f64;
    (10.0 * (geo / arith).log10()) as f32
}

/// Stick fraction and releases per second between `a` and `b` seconds.
fn grip(reps: &[RubReport], a: f32, b: f32) -> (f32, f32) {
    let (ra, rb) = (&reps[(a * SR) as usize], &reps[(b * SR) as usize]);
    let stuck = (rb.stuck - ra.stuck) as f32;
    let sliding = (rb.sliding - ra.sliding) as f32;
    (stuck / (stuck + sliding).max(1.0), (rb.releases - ra.releases) as f32 / (b - a))
}

/// The strongest spectral line of `seg` between 100 Hz and 8 kHz, and how far it stands over the
/// spectrum's median, dB.
fn tonality(seg: &[f32]) -> (f32, f32) {
    let (m, bin) = crate::audio::physmod::analysis::spectrum(seg, SR);
    let lo = (100.0 / bin) as usize;
    let hi = ((8000.0 / bin) as usize).min(m.len() - 1);
    let (mut k, mut best) = (lo, 0.0f32);
    for (i, v) in m.iter().enumerate().take(hi).skip(lo) {
        if *v > best {
            best = *v;
            k = i;
        }
    }
    let mut sorted: Vec<f32> = m[lo..hi].to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = sorted[sorted.len() / 2];
    (k as f32 * bin, db(best / median.max(1.0e-20)))
}

#[test]
#[ignore]
fn rub_report() {
    println!("rubber on a glass pane: speed, pressure -> stick fraction, releases/s, level, centroid, peak Hz, tonality");
    for pressure in [0.5f32, 2.0, 5.0] {
        for speed in [0.02f32, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0] {
            let dur = (0.2 / speed).clamp(0.4, 1.0);
            let (x, reps) = on_sheet(SheetSpec::glass_pane(), line(ToolSpec::rubber(), speed, pressure, dur), 0.1);
            let (f, rel) = grip(&reps, 0.15, dur - 0.05);
            let seg = secs(&x, 0.15, dur - 0.05);
            let fr: Vec<f32> = reps[(0.15 * SR) as usize..((dur - 0.05) * SR) as usize].iter().map(|r| r.friction).collect();
            let (pk, _) = tonality(&fr);
            println!("  {speed:5.2} m/s {pressure:3.1} N: stick {f:.2} rel {rel:7.0}/s level {:6.1} dB centroid {:6.0} flat {:5.1} dB; friction's line {pk:5.0} Hz, its flatness {:5.1} dB", db(rms(seg)), centroid(seg), flatness(seg), flatness(&fr));
        }
    }
    println!("brush on the snare (all round), sweep at 0.8 N: speed -> level, centroid, >3k, landings, stick");
    let snare = DrumSpec::snare(220.0).all_round();
    for speed in [0.15f32, 0.3, 0.6, 1.2] {
        let t0 = std::time::Instant::now();
        let (x, reps) = on_drum(snare, Stroke::sweep(snare.batter.radius, speed, 0.8, 0.5), 0.2, None);
        let el = t0.elapsed().as_secs_f32() / 0.7;
        let seg = secs(&x, 0.1, 0.45);
        let r = reps[(0.45 * SR) as usize];
        println!("  {speed:4.2} m/s: level {:6.1} dB centroid {:6.0} >3k {:5.1} dB landings {} stick {:.2} ({:.0}% of real time)", db(rms(seg)), centroid(seg), above(seg, 3000.0), r.landings, r.stick_fraction(), el * 100.0);
    }
    for (name, rough) in [("clear", friction::Roughness::CLEAR_HEAD), ("coated", friction::Roughness::COATED_HEAD), ("coated x3", friction::Roughness::COATED_HEAD.scaled(3.0))] {
        let (x, _) = on_drum(snare, Stroke::sweep(snare.batter.radius, 0.6, 0.8, 0.5), 0.2, Some(rough));
        let seg = secs(&x, 0.1, 0.45);
        println!("  {name}: level {:6.1} dB centroid {:6.0} >3k {:5.1}", db(rms(seg)), centroid(seg), above(seg, 3000.0));
    }
    for (tips, all) in [(4usize, true), (6, true), (8, true), (8, false)] {
        let spec = if all { snare } else { DrumSpec { partners: true, ..DrumSpec::snare(220.0) } };
        let tool = ToolSpec { tips, ..ToolSpec::brush() };
        let mut d = Drum::new(spec, SR);
        d.enable_rubbing(tool);
        d.rubbing_mut().unwrap().set_two_way(100_000);
        d.rub(Stroke::sweep(snare.batter.radius, 0.6, 0.8, 0.5).with_tool(tool));
        let t0 = std::time::Instant::now();
        let x: Vec<f32> = (0..(0.7 * SR) as usize).map(|_| d.next_sample()).collect();
        let el = t0.elapsed().as_secs_f32() / 0.7;
        let seg = secs(&x, 0.1, 0.45);
        println!("  {tips} tips, modes {}: level {:6.1} dB centroid {:6.0} >3k {:5.1} landings {} ({:.0}% of real time)", d.head_body(0).unwrap().len(), db(rms(seg)), centroid(seg), above(seg, 3000.0), d.rub_report().landings, el * 100.0);
    }
    for two_way in [32usize, 128, 100_000] {
        let mut d = Drum::new(snare, SR);
        d.enable_rubbing(ToolSpec::brush());
        d.rubbing_mut().unwrap().set_two_way(two_way);
        d.rub(Stroke::sweep(snare.batter.radius, 0.6, 0.8, 0.5));
        let t0 = std::time::Instant::now();
        let x: Vec<f32> = (0..(0.7 * SR) as usize).map(|_| d.next_sample()).collect();
        let el = t0.elapsed().as_secs_f32() / 0.7;
        let seg = secs(&x, 0.1, 0.45);
        println!("  two-way {two_way}: level {:6.1} dB centroid {:6.0} >3k {:5.1} landings {} ({:.0}% of real time)", db(rms(seg)), centroid(seg), above(seg, 3000.0), d.rub_report().landings, el * 100.0);
    }
    {
        let mut d = Drum::new(snare, SR);
        d.strike(Strike { velocity: 3.0, position: 0.3, angle: 0.0, striker: StrikerSpec::stick() });
        let t0 = std::time::Instant::now();
        for _ in 0..(0.7 * SR) as usize {
            d.next_sample();
        }
        println!("  the same snare struck: {:.0}% of real time; modes {} (batter)", t0.elapsed().as_secs_f32() / 0.7 * 100.0, d.head_body(0).unwrap().len());
    }
    println!("brush swirl on the snare at 0.8 N: speed -> level, above 1k, above 3k, centroid, stick, releases, landings");
    for speed in [0.1f32, 0.3, 0.6, 0.9, 1.5] {
        let (x, reps) = on_drum(snare, Stroke::swirl(snare.batter.radius, speed, 0.8, 1.0), 0.1, None);
        let seg = secs(&x, 0.3, 0.95);
        let (st, rel) = grip(&reps, 0.3, 0.95);
        println!("  {speed:4.2} m/s: level {:6.1} above1k {:6.1} above3k {:6.1} centroid {:5.0} stick {st:.2} rel {rel:5.0}/s landings {}", db(rms(seg)), level_above(seg, 1000.0), level_above(seg, 3000.0), centroid(seg), reps[(0.95 * SR) as usize].landings);
    }
    let (x, _) = on_drum(snare.snares_off(), Stroke::sweep(snare.batter.radius, 0.6, 0.8, 0.5), 0.2, None);
    let seg = secs(&x, 0.1, 0.45);
    println!("  snares off: level {:6.1} dB centroid {:6.0} >3k {:5.1}", db(rms(seg)), centroid(seg), above(seg, 3000.0));
}

// ------------------------------------------------------------------------------------------
// Stick-slip and sliding (a rubber ball on a glass pane)
// ------------------------------------------------------------------------------------------

/// A steady stretch of a rubber-on-glass stroke: (stick fraction, releases/s, sound's flatness,
/// friction force's strongest line in Hz, releases per second).
fn rubber_on_glass(speed: f32, pressure: f32) -> (f32, f32, f32, f32) {
    let dur = (0.2 / speed).clamp(0.4, 0.8);
    let (x, reps) = on_sheet(SheetSpec::glass_pane(), line(ToolSpec::rubber(), speed, pressure, dur), 0.1);
    assert!(x.iter().all(|v| v.is_finite()));
    let (a, b) = (0.15, dur - 0.05);
    let (stick, releases) = grip(&reps, a, b);
    let fr: Vec<f32> = reps[(a * SR) as usize..(b * SR) as usize].iter().map(|r| r.friction).collect();
    (stick, releases, flatness(secs(&x, a, b)), tonality(&fr).0)
}

#[test]
fn slow_and_heavy_sticks_and_slips_fast_and_light_slides() {
    // Slow and heavy: stick-slip, a squeak - the friction force a sawtooth at the release rate, the
    // sound a set of lines.
    let (stick, rate, flat, line) = rubber_on_glass(0.05, 2.0);
    assert!(stick > 0.3 && rate > 100.0, "stick {stick} releases {rate}/s");
    assert!((line / rate - 1.0).abs() < 0.05 || (line / (2.0 * rate) - 1.0).abs() < 0.05, "friction's line {line} Hz vs {rate} releases/s");
    assert!(flat < -30.0, "a squeak is lines: flatness {flat} dB");
    // Fast: steady sliding, no releases, and the sound is the roughness passing: noise-like.
    let (stick_fast, rate_fast, flat_fast, _) = rubber_on_glass(2.0, 2.0);
    assert!(stick_fast < 0.02 && rate_fast < 5.0, "stick {stick_fast} releases {rate_fast}/s");
    assert!(flat_fast > flat + 15.0 && flat_fast > -20.0, "sliding flatness {flat_fast} vs squeak {flat}");
    // At the same moderate speed, pressure decides: light slides, heavy sticks and slips.
    let (_, light, _, _) = rubber_on_glass(0.2, 0.5);
    let (_, heavy, _, _) = rubber_on_glass(0.2, 5.0);
    assert!(light < 5.0 && heavy > 100.0, "0.5 N: {light}/s, 5 N: {heavy}/s");
}

#[test]
fn a_squeak_is_pitched_by_the_tools_shear_resonance() {
    // The tip can't release faster than its shear spring can reload it: the release rate climbs with
    // the speed toward the rubber's own shear resonance, sqrt(k / m) / 2 pi, and never passes it.
    let t = ToolSpec::rubber();
    let f0 = (t.shear / t.mass).sqrt() / std::f32::consts::TAU;
    let rates: Vec<f32> = [0.02f32, 0.1, 0.5].iter().map(|&v| rubber_on_glass(v, 5.0).1).collect();
    assert!(rates[0] < rates[1] && rates[1] < rates[2], "{rates:?}");
    assert!(rates[2] > 0.85 * f0 && rates[2] < 1.02 * f0, "{rates:?} vs {f0} Hz");
}

#[test]
fn friction_never_holds_more_than_static_friction_allows() {
    let mut s = Sheet::new(SheetSpec::glass_pane(), ToolSpec::rubber(), SR);
    s.rub(line(ToolSpec::rubber(), 0.1, 3.0, 0.4));
    let mu_s = s.rubbing().friction().curve.mu_s;
    for _ in 0..(0.5 * SR) as usize {
        s.next_sample();
        let r = s.rub_report();
        assert!(r.friction.abs() <= mu_s * r.normal * 1.0001 + 1.0e-6, "{} vs {} x {}", r.friction, mu_s, r.normal);
    }
}

#[test]
fn a_stroke_ends_when_the_tool_is_lifted_and_the_sheet_rings_on() {
    let (x, reps) = on_sheet(SheetSpec::glass_pane(), line(ToolSpec::rubber(), 0.1, 3.0, 0.3), 0.5);
    let end = reps.iter().rposition(|r| r.active).unwrap() as f32 / SR;
    assert!(end > 0.3 && end < 0.36, "lifted clear at {end} s");
    assert!(reps.last().unwrap().normal == 0.0);
    // Still ringing after, and decaying.
    let (after, later) = (rms(secs(&x, 0.36, 0.4)), rms(secs(&x, 0.7, 0.8)));
    assert!(after > 0.0 && later < after, "{after} {later}");
}

#[test]
fn a_wet_finger_on_glass_squeaks_where_a_dry_one_barely_does() {
    // The wet finger's friction falls much further from static to sliding (0.9 to 0.35): the
    // negative slope that drives stick-slip is much steeper.
    let run = |tool: ToolSpec| {
        let (_, reps) = on_sheet(SheetSpec::glass_pane(), line(tool, 0.1, 2.0, 0.6), 0.1);
        grip(&reps, 0.15, 0.55)
    };
    let (wet_stick, wet) = run(ToolSpec::wet_finger());
    let (_, dry) = run(ToolSpec::finger());
    assert!(wet > 30.0 && wet > 3.0 * dry.max(1.0), "wet {wet}/s (stuck {wet_stick}) vs dry {dry}/s");
}

// ------------------------------------------------------------------------------------------
// Roughness and brushes (a brush on a snare)
// ------------------------------------------------------------------------------------------

fn brush_sweep(spec: DrumSpec, rough: Option<friction::Roughness>, speed: f32) -> (Vec<f32>, RubReport) {
    let (x, reps) = on_drum(spec, Stroke::sweep(spec.batter.radius, speed, 0.8, 0.5), 0.2, rough);
    (x, reps[(0.45 * SR) as usize])
}

/// Level of `seg` above `f` Hz, dB.
fn level_above(seg: &[f32], f: f32) -> f32 {
    db(rms(seg)) + 0.5 * above(seg, f)
}

#[test]
fn a_rougher_surface_is_brighter_and_louder() {
    let snare = DrumSpec::snare(220.0).all_round();
    let mut last: Option<(f32, f32)> = None;
    for rough in [friction::Roughness::CLEAR_HEAD, friction::Roughness::COATED_HEAD, friction::Roughness::COATED_HEAD.scaled(3.0)] {
        let (x, _) = brush_sweep(snare, Some(rough), 0.6);
        let seg = secs(&x, 0.1, 0.45);
        let (c, l) = (centroid(seg), level_above(seg, 1000.0));
        if let Some((c0, l0)) = last {
            assert!(c > c0 * 1.02 && l > l0 + 2.0, "rms {} m: centroid {c} vs {c0}, level above 1 kHz {l} vs {l0}", rough.rms);
        }
        last = Some((c, l));
    }
}

#[test]
fn a_brush_sweep_is_mostly_the_coating_under_the_wires() {
    // On a clear head the same sweep is a dull push; the coating's grit is the sound of a brush.
    let snare = DrumSpec::snare(220.0).all_round();
    let (clear, _) = brush_sweep(snare, Some(friction::Roughness::CLEAR_HEAD), 0.6);
    let (coated, r) = brush_sweep(snare, None, 0.6);
    let (a, b) = (secs(&clear, 0.1, 0.45), secs(&coated, 0.1, 0.45));
    assert!(above(b, 3000.0) > above(a, 3000.0) + 15.0, "{} vs {}", above(b, 3000.0), above(a, 3000.0));
    // The wires catch on the grit and are let go, over and over.
    assert!(r.releases > 100 && r.stick_fraction() > 0.05 && r.stick_fraction() < 0.95, "{r:?}");
}

#[test]
fn a_brush_swirl_is_a_continuous_wash_that_follows_the_stroke_speed() {
    let snare = DrumSpec::snare(220.0).all_round();
    let mut d = Drum::new(snare, SR);
    d.enable_rubbing(ToolSpec::brush());
    // Circles at 0.3 m/s for a second, then carrying on round at 1.5 m/s.
    let a = snare.batter.radius;
    d.rub(Stroke::swirl(a, 0.3, 0.8, 1.0));
    let mut x: Vec<f32> = (0..SR as usize).map(|_| d.next_sample()).collect();
    d.rub(Stroke::swirl(a, 1.5, 0.8, 1.0));
    x.extend((0..(1.4 * SR) as usize).map(|_| d.next_sample()));
    // Continuous: no 10 ms stretch while the brush moves drops far below the rest.
    let env = |a: f32, b: f32| -> Vec<f32> { secs(&x, a, b).chunks((0.01 * SR) as usize).map(rms).collect() };
    for (lo, hi) in [(0.15, 0.95), (1.15, 1.95)] {
        let e = env(lo, hi);
        let mut s = e.clone();
        s.sort_by(|p, q| p.partial_cmp(q).unwrap());
        let median = s[s.len() / 2];
        assert!(e.iter().all(|v| *v > median * 0.2), "a gap in the wash between {lo} and {hi} s");
    }
    // Follows the speed: faster is louder above 1 kHz.
    let (slow, fast) = (secs(&x, 0.2, 0.9), secs(&x, 1.2, 1.9));
    assert!(level_above(fast, 1000.0) > level_above(slow, 1000.0) + 4.0, "{} vs {}", level_above(fast, 1000.0), level_above(slow, 1000.0));
    // And stops when the brush is lifted: 300 ms after, it is far quieter.
    let tail = rms(secs(&x, 2.3, 2.4));
    assert!(db(tail) < db(rms(fast)) - 20.0, "{} vs {}", db(tail), db(rms(fast)));
}

#[test]
fn brushing_with_the_snares_on_buzzes_the_wires() {
    let snare = DrumSpec::snare(220.0).all_round();
    let mut d = Drum::new(snare, SR);
    d.rub(Stroke::sweep(snare.batter.radius, 0.8, 1.5, 0.5));
    for _ in 0..(0.6 * SR) as usize {
        d.next_sample();
    }
    assert!(d.wire_landings() > 0, "no snare buzz under the brush");
}

#[test]
fn every_rub_stays_finite() {
    // Hard and fast: a rod scraped heavily along a snare, a stick tip along a cymbal, sandpaper-grade
    // roughness under a brush.
    let snare = DrumSpec::snare(220.0).all_round();
    let (x, _) = on_drum(snare, Stroke::sweep(snare.batter.radius, 3.0, 20.0, 0.3).with_tool(ToolSpec::rod()), 0.2, None);
    assert!(x.iter().all(|v| v.is_finite()) && rms(&x) > 0.0);
    let (y, _) = on_drum(snare, Stroke::swirl(snare.batter.radius, 2.0, 5.0, 0.3), 0.2, Some(friction::Roughness::SANDPAPER));
    assert!(y.iter().all(|v| v.is_finite()) && rms(&y) > 0.0);
    let mut c = Cymbal::new(CymbalSpec::ride(), SR);
    c.rub(Stroke { tool: ToolSpec::stick_tip(), path: Path::Line { from: [0.05, 0.0], to: [0.24, 0.0] }, speed: 1.0, pressure: 5.0, duration: 0.3, ease: 0.02 });
    let z: Vec<f32> = (0..(0.5 * SR) as usize).map(|_| c.next_sample()).collect();
    assert!(z.iter().all(|v| v.is_finite()) && rms(&z) > 0.0);
}

#[test]
fn a_held_tool_follows_the_hand() {
    // Live: the view sends the hand's position a few dozen times a second; the tool follows smoothly.
    let snare = DrumSpec::snare(220.0).all_round();
    let mut d = Drum::new(snare, SR);
    d.enable_rubbing(ToolSpec::brush());
    let mut speeds = Vec::new();
    for step in 0..40 {
        let x = -0.08 + 0.004 * step as f32;
        d.hold(x, 0.0, 1.0);
        for _ in 0..(SR / 50.0) as usize {
            d.next_sample();
            speeds.push(d.rub_report().speed);
        }
    }
    let r = d.rub_report();
    assert!(r.active && r.touching > 0 && (r.x - 0.076).abs() < 0.01, "{r:?}");
    // 4 mm every 20 ms is 0.2 m/s, reached smoothly.
    let late = &speeds[speeds.len() / 2..];
    assert!(late.iter().all(|v| (*v - 0.2).abs() < 0.05), "{:?}", &late[..10]);
    d.hold(0.0, 0.0, 0.0);
    for _ in 0..(0.2 * SR) as usize {
        d.next_sample();
    }
    assert!(!d.rub_report().active, "lifted");
}

#[test]
#[ignore]
fn rub_listening_examples() {
    let dir = std::path::Path::new("test-artifacts/matter");
    std::fs::create_dir_all(dir).unwrap();
    let write = |name: &str, x: &[f32]| {
        let spec = hound::WavSpec { channels: 1, sample_rate: SR as u32, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(dir.join(name), spec).unwrap();
        let peak = x.iter().fold(1.0e-9f32, |m, v| m.max(v.abs()));
        for v in x {
            w.write_sample((v / peak * 0.8 * 32767.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    };
    // Jazz brushes: a swirl on every beat with a sweep across on 2 and 4, at 120 bpm.
    let snare = DrumSpec::snare(240.0).all_round();
    let a = snare.batter.radius;
    let mut d = Drum::new(snare, SR);
    let mut x = Vec::new();
    for bar in 0..4 {
        for beat in 0..4 {
            if beat % 2 == 1 {
                d.rub(Stroke::sweep(a, 0.9, 1.2, 0.18));
            } else {
                d.rub(Stroke::swirl(a, 0.5 + 0.1 * bar as f32, 0.7, 0.45));
            }
            x.extend((0..(0.5 * SR) as usize).map(|_| d.next_sample()));
        }
    }
    x.extend((0..(0.5 * SR) as usize).map(|_| d.next_sample()));
    write("brush_groove.wav", &x);
    // One slow swirl speeding up.
    let mut d = Drum::new(snare, SR);
    let mut y = Vec::new();
    for i in 0..8 {
        d.rub(Stroke::swirl(a, 0.2 + 0.15 * i as f32, 0.8, 0.5));
        y.extend((0..(0.5 * SR) as usize).map(|_| d.next_sample()));
    }
    write("brush_swirl_accelerating.wav", &y);
    // The same sweep on a clear head, a coated one and a rough one.
    for (name, r) in [("clear", friction::Roughness::CLEAR_HEAD), ("coated", friction::Roughness::COATED_HEAD), ("rough", friction::Roughness::COATED_HEAD.scaled(3.0))] {
        let (x, _) = on_drum(snare, Stroke::sweep(a, 0.7, 0.8, 0.6), 0.4, Some(r));
        write(&format!("brush_sweep_{name}.wav"), &x);
    }
    // Rubber on glass: slow and heavy (a squeak), faster, then fast and light (sliding).
    let mut z = Vec::new();
    for (v, p) in [(0.05f32, 3.0f32), (0.2, 3.0), (0.6, 3.0), (2.0, 1.0)] {
        z.extend(render_sheet_stroke(&SheetSpec::glass_pane(), line(ToolSpec::rubber(), v, p, 0.8), SR, 0.3));
    }
    write("rubber_on_glass.wav", &z);
    // A wet finger round a pane, and a rod scraped along a steel sheet and along a ride.
    write("wet_finger_on_glass.wav", &render_sheet_stroke(&SheetSpec::glass_pane(), line(ToolSpec::wet_finger(), 0.12, 2.5, 2.0), SR, 0.8));
    write("rod_on_steel.wav", &render_sheet_stroke(&SheetSpec::steel_sheet(), Stroke { tool: ToolSpec::rod(), path: Path::Line { from: [-0.15, 0.02], to: [0.15, 0.02] }, speed: 0.4, pressure: 4.0, duration: 0.7, ease: 0.03 }, SR, 1.0));
    let mut c = Cymbal::new(CymbalSpec::ride(), SR);
    c.rub(Stroke { tool: ToolSpec::rod(), path: Path::Line { from: [0.06, 0.0], to: [0.24, 0.0] }, speed: 0.3, pressure: 3.0, duration: 0.6, ease: 0.03 });
    write("rod_on_ride.wav", &(0..(3.0 * SR) as usize).map(|_| c.next_sample()).collect::<Vec<_>>());
}

#[test]
#[ignore]
fn rub_cost() {
    let snare = DrumSpec::snare(220.0).all_round();
    let mut d = Drum::new(snare, SR);
    d.enable_rubbing(ToolSpec::brush());
    d.rub(Stroke::swirl(snare.batter.radius, 0.6, 0.8, 3.0));
    let t0 = std::time::Instant::now();
    for _ in 0..(3.0 * SR) as usize {
        d.next_sample();
    }
    println!("brush swirl on the snare: {:.0}% of a core", t0.elapsed().as_secs_f32() / 3.0 * 100.0);
    let mut d = Drum::new(snare, SR);
    d.strike(Strike { velocity: 3.0, position: 0.3, angle: 0.0, striker: StrikerSpec::stick() });
    let t0 = std::time::Instant::now();
    for _ in 0..(3.0 * SR) as usize {
        d.next_sample();
    }
    println!("the same snare struck: {:.0}%", t0.elapsed().as_secs_f32() / 3.0 * 100.0);
    let mut s = Sheet::new(SheetSpec::glass_pane(), ToolSpec::rubber(), SR);
    s.rub(line(ToolSpec::rubber(), 0.1, 3.0, 3.0));
    let t0 = std::time::Instant::now();
    for _ in 0..(3.0 * SR) as usize {
        s.next_sample();
    }
    println!("rubber on the glass pane: {:.0}% ({} modes)", t0.elapsed().as_secs_f32() / 3.0 * 100.0, s.body().len());
}

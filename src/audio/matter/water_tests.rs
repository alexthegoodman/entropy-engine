//! Water, measured: every claim of Phase 6 rendered offline and measured - bubble pitches and
//! glides, the air column of a filling bottle, a glass's tuning, breaking and bubble counts, the
//! spectra of rain on different bodies. Run with `cargo test --release --lib matter::water`.

use super::bubble::*;
use super::drop::*;
use super::rain::*;
use super::tests::{centroid, db, peak, rms};
use super::vessel::*;
use super::water::*;
use super::waves::*;
use std::time::Instant;

const SR: f32 = 44_100.0;

fn mono(x: &[f32]) -> Vec<f32> {
    x.chunks(2).map(|c| 0.5 * (c[0] + c[1])).collect()
}

fn seg(x: &[f32], a: f32, b: f32) -> &[f32] {
    &x[((a * SR) as usize).min(x.len())..((b * SR) as usize).min(x.len())]
}

/// The strongest frequency in successive windows of `win` s from `a` to `b`: (time, Hz, rms).
fn track(x: &[f32], a: f32, b: f32, win: f32, lo: f32, hi: f32) -> Vec<(f32, f32, f32)> {
    let mut out = Vec::new();
    let mut t = a;
    while t + win <= b {
        let s = seg(x, t, t + win);
        let (f, _) = peak(s, lo, hi);
        out.push((t, f, rms(s)));
        t += win * 0.5;
    }
    out
}

#[test]
#[ignore]
fn water_report() {
    // A tap's drip.
    let drop = Drop::from_tap(2.0e-3, 0.07);
    println!("drip: r {:.2} mm, v {:.2} m/s, We {:.0}, Fr {:.0}, {:?}, crater {:.1} mm", drop.radius * 1e3, drop.speed, drop.weber(), drop.froude(), drop.regime(), drop.crater_depth() * 1e3);
    let x = mono(&render_drips(&[(0.0, drop, 0.0)], SR, 0.3));
    for (t, f, r) in track(&x, 0.0, 0.06, 0.004, 500.0, 12_000.0) {
        println!("  {:5.1} ms  {:6.0} Hz  {:6.1} dB Pa", t * 1e3, f, db(r));
    }
    // Rain on a lake.
    for rate in [2.0f32, 10.0, 40.0] {
        let t0 = Instant::now();
        let x = mono(&render_rain(RainTarget::Lake, rate, 6.0, SR, 3.0));
        let cost = t0.elapsed().as_secs_f32() / 3.0;
        let (f, _) = peak(seg(&x, 1.0, 3.0), 2000.0, 20_000.0);
        println!("lake {rate} mm/h: peak {f:.0} Hz, centroid {:.0} Hz, {:.1} dB Pa, cost {:.0}%", centroid(seg(&x, 1.0, 3.0)), db(rms(seg(&x, 1.0, 3.0))), cost * 100.0);
    }
    for target in [RainTarget::Window, RainTarget::Roof, RainTarget::Tent, RainTarget::Cymbal, RainTarget::Drum] {
        let t0 = Instant::now();
        let mut r = Rain::new(target, 10.0, 1.5, 3, SR);
        let build = t0.elapsed().as_secs_f32();
        let t1 = Instant::now();
        let x: Vec<f32> = (0..(3.0 * SR) as usize).map(|_| r.next_frame()[0]).collect();
        let cost = t1.elapsed().as_secs_f32() / 3.0;
        println!("{:7}: build {:.2} s, cost {:.0}%, {:.1} dB Pa, centroid {:.0} Hz, drops {:.0}/s (sim {})", target.name(), build, cost * 100.0, db(rms(seg(&x, 1.0, 3.0))), centroid(seg(&x, 1.0, 3.0)), r.report.landed / 3.0, r.report.simulated);
    }
    // Pouring into a bottle.
    let b = VesselSpec::bottle();
    let pour = Pour::new(1.0e-4, 0.45, 6.0);
    let t0 = Instant::now();
    let (x, end) = render_pour(b, 0.0, pour, SR, 0.5);
    println!("bottle: end level {:.3} m, cost {:.0}%", end, t0.elapsed().as_secs_f32() / 6.5 * 100.0);
    let x = mono(&x);
    for k in 0..12 {
        let t = 0.25 + k as f32 * 0.5;
        let level = pour.flow * t / b.area_at(0.0);
        let mut m = [AirMode::default(); 2];
        air_modes(&b, level, 20_000.0, &mut m);
        let (f, _) = peak(seg(&x, t - 0.2, t + 0.2), 60.0, 2000.0);
        println!("  t {t:.2} s level {level:.3}: air {:.0} Hz, heard {:.0} Hz, {:.1} dB", m[0].freq, f, db(rms(seg(&x, t - 0.2, t + 0.2))));
    }
    // A glass.
    let (g, l) = GlassSpec::tuned(440.0);
    println!("glass for A4: radius {:.1} mm, level {:.1} of {:.1} mm, range {:?}", g.vessel.radius * 1e3, l * 1e3, g.vessel.height * 1e3, g.range());
    let x = mono(&render_glasses(&[(0.0, 440.0, 1.0)], spoon(), SR, 2.0));
    let (f, _) = peak(seg(&x, 0.1, 1.0), 200.0, 2000.0);
    println!("  heard {f:.1} Hz, peak {:.1} dB Pa", db(x.iter().fold(0.0f32, |m, v| m.max(v.abs()))));
    // Moving water.
    for (name, spec, secs) in [("tub", WavesSpec::tub(), 6.0f32), ("brook 0.3", WavesSpec::brook(0.3), 6.0), ("brook 0.8", WavesSpec::brook(0.8), 6.0), ("surf", WavesSpec::surf(1.0, 8.0), 40.0)] {
        let t0 = Instant::now();
        let mut w = Waves::new(spec, SR);
        let mut x = Vec::with_capacity((secs * SR) as usize);
        let mut bores = 0u32;
        let mut diss = 0.0f32;
        for i in 0..(secs * SR) as usize {
            x.push(w.next_frame()[0]);
            if i % 4410 == 0 {
                bores = bores.max(w.report.bores);
                diss = diss.max(w.report.dissipation);
            }
        }
        let cost = t0.elapsed().as_secs_f32() / secs;
        let tail = seg(&x, secs * 0.5, secs);
        println!("{name}: cost {:.0}%, bores {bores}, dissipation {diss:.3} W, entrained {:.0}/s (sim {}), breakers {}, steepest {:.2}, {:.1} dB Pa, centroid {:.0} Hz", cost * 100.0, w.report.entrained / secs as f64, w.report.simulated, w.report.breakers, w.report.steepest, db(rms(tail)), centroid(tail));
        if name == "surf" {
            for k in 0..20 {
                let t = 20.0 + k as f32;
                print!("{:.0} ", db(rms(seg(&x, t, t + 1.0))));
            }
            println!();
        }
    }
}


/// Energy in third-octave bands from 100 Hz to 12.5 kHz, dB.
fn thirds(x: &[f32]) -> Vec<f32> {
    bands(x, 21)
}

/// Energy in `n` third-octave bands from 100 Hz up, dB.
fn bands(x: &[f32], n: usize) -> Vec<f32> {
    let (m, bin) = crate::audio::physmod::analysis::spectrum(x, SR);
    (0..n)
        .map(|b| {
            let fc = 100.0 * 2.0f32.powf(b as f32 / 3.0);
            let (lo, hi) = (fc * 2.0f32.powf(-1.0 / 6.0), fc * 2.0f32.powf(1.0 / 6.0));
            let e: f32 = m.iter().enumerate().filter(|(k, _)| (*k as f32 * bin) >= lo && (*k as f32 * bin) < hi).map(|(_, v)| v * v).sum();
            10.0 * e.max(1.0e-30).log10()
        })
        .collect()
}

fn correlation(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f32;
    let (ma, mb) = (a.iter().sum::<f32>() / n, b.iter().sum::<f32>() / n);
    let (mut ab, mut aa, mut bb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        ab += (x - ma) * (y - mb);
        aa += (x - ma) * (x - ma);
        bb += (y - mb) * (y - mb);
    }
    ab / (aa * bb).sqrt().max(1.0e-20)
}

#[test]
fn a_bubble_rings_at_its_minnaert_frequency_and_decays_at_its_rate() {
    let (r, depth) = (1.0e-3, 0.05);
    let mut pond = Pond::new(0.2, 0.4, SR);
    assert!(pond.release(r, depth, 0.0));
    let x: Vec<f32> = (0..(0.1 * SR) as usize).map(|_| pond.next_frame()[0]).collect();
    let m = bubble_mode(r, depth);
    let want = m.freq * surface_factor(r, depth);
    let (f, _) = peak(seg(&x, 0.0, 0.03), 1000.0, 8000.0);
    assert!((f / want - 1.0).abs() < 0.01, "{f} vs {want}");
    // Amplitude decay between two windows 15 ms apart (it rises 2 cm in that time: still deep).
    let (a, b) = (rms(seg(&x, 0.005, 0.01)), rms(seg(&x, 0.02, 0.025)));
    let sigma = (a / b).ln() / 0.015;
    let want = m.sigma_at(r, depth);
    assert!((sigma / want - 1.0).abs() < 0.15, "decay {sigma} vs {want}");
}

#[test]
fn a_drip_plinks_and_glides_up_as_its_bubble_rises() {
    let drop = Drop::from_tap(2.0e-3, 0.07);
    assert_eq!(drop.regime(), Entrainment::Regular);
    let mut pond = Pond::new(0.1, 0.4, SR);
    let born = pond.drip(drop, 0.0).expect("a regular drip entrains a bubble");
    // A tuned drip is born at its note.
    let mut tuned = Pond::new(0.1, 0.4, SR);
    let f = tuned.drip(Drop::ringing_at(880.0), 0.0).unwrap();
    assert!((f / 880.0 - 1.0).abs() < 2.0e-3, "{f}");
    let x: Vec<f32> = (0..(0.05 * SR) as usize).map(|_| pond.next_frame()[0]).collect();
    let (early, _) = peak(seg(&x, 0.0, 0.004), 1000.0, 10_000.0);
    let (late, _) = peak(seg(&x, 0.012, 0.016), 1000.0, 10_000.0);
    assert!((early / born - 1.0).abs() < 0.04, "{early} vs born {born}");
    assert!(late > early * 1.15, "no glide: {early} -> {late}");
    // A plink of a few hundredths of a pascal at 40 cm.
    let p = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(p > 0.005 && p < 0.2, "{p}");
}

#[test]
fn drops_outside_the_bands_make_no_sound_on_water() {
    // A drip let go a centimetre up, and a medium raindrop: no bubble, and the impact itself is
    // not a source in the air.
    for drop in [Drop::from_tap(2.0e-3, 0.01), Drop::raindrop(1.6e-3)] {
        assert_eq!(drop.regime(), Entrainment::None);
        let x = render_drips(&[(0.0, drop, 0.0)], SR, 0.1);
        assert!(x.iter().all(|v| *v == 0.0));
    }
}

#[test]
fn rain_on_a_lake_whispers_at_14_khz_when_light_and_roars_lower_when_heavy() {
    // The loudest third-octave band (100 Hz to 16 kHz) over five seconds.
    let loudest = |rate: f32| {
        let x = mono(&render_rain(RainTarget::Lake, rate, 6.0, SR, 6.0));
        let b = bands(seg(&x, 1.0, 6.0), 23);
        let k = (0..b.len()).max_by(|&i, &j| b[i].total_cmp(&b[j])).unwrap();
        (100.0 * 2.0f32.powf(k as f32 / 3.0), db(rms(seg(&x, 1.0, 6.0))))
    };
    let (fl, ll) = loudest(2.0);
    assert!((12_000.0..=17_000.0).contains(&fl), "light rain is loudest at {fl}");
    let (fh, lh) = loudest(40.0);
    assert!(fh < 8000.0, "heavy rain is loudest at {fh}");
    assert!(lh > ll + 10.0, "{ll} -> {lh}");
}

#[test]
fn a_filling_bottle_rises_in_pitch_with_its_air_column() {
    let b = VesselSpec::bottle();
    let pour = Pour::new(1.0e-4, 0.45, 5.0);
    let (x, end) = render_pour(b, 0.0, pour, SR, 0.2);
    let x = mono(&x);
    assert!((end - pour.flow * pour.duration / b.area_at(0.0)).abs() < 1.0e-3);
    let mut heard = Vec::new();
    for k in 0..5 {
        let t = 0.5 + k as f32;
        let level = pour.flow * t / b.area_at(0.0);
        let mut m = [AirMode::default(); 1];
        air_modes(&b, level, 20_000.0, &mut m);
        let (f, _) = peak(seg(&x, t - 0.25, t + 0.25), 60.0, 2000.0);
        assert!((f / m[0].freq - 1.0).abs() < 0.03, "t {t}: heard {f}, column {}", m[0].freq);
        heard.push(f);
    }
    assert!(heard.windows(2).all(|w| w[1] > w[0]), "{heard:?}");
    assert!(heard[4] > heard[0] * 1.3, "{heard:?}");
}

#[test]
fn a_glass_is_tuned_by_its_water() {
    let pitch_of = |pitch: f32| {
        let x = mono(&render_glasses(&[(0.0, pitch, 0.5)], soft_mallet(), SR, 1.0));
        peak(seg(&x, 0.05, 1.0), 100.0, 4000.0).0
    };
    for p in [330.0f32, 440.0, 660.0] {
        let f = pitch_of(p);
        assert!(super::tests::cents(f, p).abs() < 10.0, "{p}: {f}");
    }
    // The same glass empty and full: the water pulls it down by sqrt(1 + C).
    let g = GlassSpec { vessel: VesselSpec::tumbler() };
    let ring = |level: f32| {
        let mut v = Vessel::new(g.vessel, level, 0.5, SR);
        v.strike(0.5, soft_mallet());
        let x: Vec<f32> = (0..(0.5 * SR) as usize).map(|_| v.next_frame()[0]).collect();
        peak(seg(&x, 0.02, 0.5), 100.0, 4000.0).0
    };
    let (empty, full) = (ring(0.0), ring(g.vessel.height));
    let want = (1.0 + g.loading(2)).sqrt();
    assert!(((empty / full) / want - 1.0).abs() < 0.01, "{empty} / {full} vs {want}");
}

#[test]
fn rain_on_each_body_has_that_body_s_spectrum() {
    use super::drum::{Drum, DrumSpec, Strike, StrikerSpec};
    use super::rub::ToolSpec;
    use super::sheet::Sheet;
    // A light tap on each body, and rain on it: the rain's third-octave spectrum is its own body's.
    let tap = StrikerSpec { mass: 0.002, tip: super::contact::Tip::Solid { radius: 0.002, material: super::contact::Material::PLASTIC }, restitution: 0.5 };
    let mut pane = Sheet::new(window(), ToolSpec::finger(), SR);
    pane.strike(Strike { velocity: 1.0, position: 0.5, angle: 0.3, striker: tap });
    let pane_tap: Vec<f32> = (0..(0.5 * SR) as usize).map(|_| pane.next_sample()).collect();
    let mut fly = Drum::new(DrumSpec::tent(), SR);
    fly.strike(Strike { velocity: 1.0, position: 0.5, angle: 0.3, striker: tap });
    let fly_tap: Vec<f32> = (0..(0.5 * SR) as usize).map(|_| fly.next_sample()).collect();
    let on_pane = mono(&render_rain(RainTarget::Window, 10.0, 1.5, SR, 2.0));
    let on_fly = mono(&render_rain(RainTarget::Tent, 10.0, 1.5, SR, 2.0));
    let (tp, tf) = (thirds(&pane_tap), thirds(&fly_tap));
    let (rp, rf) = (thirds(seg(&on_pane, 0.5, 2.0)), thirds(seg(&on_fly, 0.5, 2.0)));
    let (pp, pf, fp, ff) = (correlation(&rp, &tp), correlation(&rp, &tf), correlation(&rf, &tp), correlation(&rf, &tf));
    assert!(pp > pf + 0.2, "rain on the pane: like the pane {pp}, like the fly {pf}");
    assert!(ff > fp + 0.2, "rain on the fly: like the fly {ff}, like the pane {fp}");
}

#[test]
fn still_water_is_silent_and_a_shaken_tub_breaks() {
    let mut still = WavesSpec::tub();
    still.motion = super::waves::Motion::Still;
    let x = render_waves(still, SR, 1.0);
    assert!(x.iter().all(|v| *v == 0.0));
    let mut w = Waves::new(WavesSpec::tub(), SR);
    let x: Vec<f32> = (0..(4.0 * SR) as usize).map(|_| w.next_frame()[0]).collect();
    assert!(w.report.breakers > 0 && w.report.simulated > 100, "{:?}", w.report);
    assert!(rms(seg(&x, 2.0, 4.0)) > 1.0e-3);
}

#[test]
fn a_faster_brook_dissipates_more_and_is_louder() {
    let run = |speed: f32| {
        let mut w = Waves::new(WavesSpec::brook(speed), SR);
        let mut d = 0.0f32;
        let x: Vec<f32> = (0..(4.0 * SR) as usize)
            .map(|i| {
                if i > (2.0 * SR) as usize {
                    d += w.report.dissipation;
                }
                w.next_frame()[0]
            })
            .collect();
        (d, db(rms(seg(&x, 2.0, 4.0))))
    };
    let (slow, fast) = (run(0.3), run(0.8));
    assert!(fast.0 > slow.0 * 1.8, "dissipation {} -> {}", slow.0, fast.0);
    assert!(fast.1 > slow.1 + 1.5, "level {} -> {}", slow.1, fast.1);
}

#[test]
fn surf_breaks_once_a_wave_period_and_swells_as_it_runs_in() {
    let period = 8.0;
    let mut w = Waves::new(WavesSpec::surf(1.0, period), SR);
    let hop = (SR / 4.0) as usize;
    let (mut env, mut acc) = (Vec::new(), 0.0f64);
    let (mut last, mut onsets) = (0u64, Vec::new());
    for i in 0..(56.0 * SR) as usize {
        let v = w.next_frame()[0] as f64;
        acc += v * v;
        if (i + 1) % hop == 0 {
            env.push(10.0 * (acc / hop as f64).max(1.0e-20).log10() as f32);
            acc = 0.0;
        }
        // A new crest breaking: the first breaker after two quiet seconds.
        if w.report.breakers > last {
            let t = i as f32 / SR;
            if onsets.last().is_none_or(|&p: &f32| t - p > 2.0) {
                onsets.push(t);
            }
            last = w.report.breakers;
        }
    }
    // Once the sea has settled (its first waves are eased in and set up the beach's flow).
    let onsets: Vec<f32> = onsets.into_iter().filter(|&t| t > 28.0).collect();
    let gaps: Vec<f32> = onsets.windows(2).map(|p| p[1] - p[0]).collect();
    assert!(gaps.len() >= 3, "{onsets:?}");
    assert!(gaps.iter().all(|g| (g - period).abs() < 1.0), "breaking at {onsets:?}");
    // After each crest breaks, the roar grows as the broken wave runs up toward the listener.
    let at = |t: f32| env[((t * 4.0) as usize).min(env.len() - 1)];
    let mean = |a: f32, b: f32| (0..((b - a) * 4.0) as usize).map(|k| at(a + k as f32 / 4.0)).sum::<f32>() / ((b - a) * 4.0);
    let (t0, t1) = (onsets[onsets.len() - 2], onsets[onsets.len() - 1]);
    assert!(mean(t1 - 2.5, t1) > mean(t0 + 0.5, t0 + 3.0) + 1.0, "no swell between {t0} and {t1}");
}

/// Renders water for ears to `test-artifacts/matter/water_*.wav` (stereo, each normalized).
#[test]
#[ignore]
fn water_listening_examples() {
    let dir = std::path::Path::new("test-artifacts/matter");
    std::fs::create_dir_all(dir).unwrap();
    let write = |name: &str, x: &[f32]| {
        let spec = hound::WavSpec { channels: 2, sample_rate: SR as u32, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(dir.join(name), spec).unwrap();
        let peak = x.iter().fold(1.0e-9f32, |m, v| m.max(v.abs()));
        for v in x {
            w.write_sample((v / peak * 0.8 * 32767.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    };
    // A dripping tap, then drips tuned to a pentatonic phrase (each drop the one whose bubble rings
    // at the note), spread left to right.
    let tap = Drop::from_tap(2.0e-3, 0.07);
    let mut drips: Vec<(f32, Drop, f32)> = (0..8).map(|i| (i as f32 * 0.45 + 0.03 * (i % 3) as f32, tap, 0.0)).collect();
    for (k, semis) in [0, 2, 4, 7, 9, 12, 9, 7, 4, 2, 0].iter().enumerate() {
        let f = 1046.5 * 2.0f32.powf(*semis as f32 / 12.0);
        drips.push((4.0 + k as f32 * 0.3, Drop::ringing_at(f), -0.6 + 0.12 * k as f32));
    }
    write("water_drips.wav", &render_drips(&drips, SR, 1.0));
    // A glass harp: a melody on glasses tuned by their water, soft mallets, then a spoon.
    let melody = [440.0f32, 493.9, 554.4, 659.3, 587.3, 554.4, 493.9, 440.0];
    let mut notes: Vec<(f32, f32, f32)> = melody.iter().enumerate().map(|(i, &p)| (i as f32 * 0.5, p, 0.6)).collect();
    notes.push((4.5, 440.0, 0.6));
    notes.push((4.5, 554.4, 0.6));
    notes.push((4.5, 659.3, 0.6));
    write("water_glass_harp.wav", &render_glasses(&notes, soft_mallet(), SR, 3.0));
    write("water_glass_spoon.wav", &render_glasses(&[(0.0, 659.3, 0.4), (0.4, 659.3, 1.0), (1.2, 440.0, 0.7)], spoon(), SR, 2.0));
    // Filling a bottle, then a tall vase.
    write("water_fill_bottle.wav", &render_pour(VesselSpec::bottle(), 0.0, Pour::new(1.0e-4, 0.45, 8.0), SR, 0.5).0);
    write("water_fill_vase.wav", &render_pour(VesselSpec::vase(), 0.0, Pour::new(1.2e-4, 0.5, 11.0), SR, 0.5).0);
    // Moving water.
    write("water_tub_slosh.wav", &render_waves(WavesSpec::tub(), SR, 8.0));
    write("water_brook_slow.wav", &render_waves(WavesSpec::brook(0.3), SR, 10.0));
    write("water_brook_fast.wav", &render_waves(WavesSpec::brook(0.8), SR, 10.0));
    write("water_surf.wav", &render_waves(WavesSpec::surf(1.0, 8.0), SR, 50.0)[(20.0 * SR) as usize * 2..]);
    // Rain on things.
    for target in RainTarget::ALL {
        for (label, rate) in [("light", 2.0f32), ("heavy", 30.0)] {
            write(&format!("water_rain_{}_{label}.wav", target.name()), &render_rain(target, rate, if target == RainTarget::Lake { 6.0 } else { 1.5 }, SR, 8.0));
        }
    }
}

#[test]
#[ignore]
fn water_mix_report() {
    use super::water_voice::*;
    let spec = WaterSpec::default();
    let unity = [1.0; SOURCES];
    let actions = [
        ("drip 1k", WaterAction::Drip { pitch: 1000.0, x: 0.0 }, 1.0),
        ("drip 3k", WaterAction::Drip { pitch: 3000.0, x: 0.0 }, 1.0),
        ("glass mallet", WaterAction::Glass { pitch: 523.0, speed: 0.5, spoon: false }, 2.0),
        ("glass spoon", WaterAction::Glass { pitch: 523.0, speed: 0.3, spoon: true }, 2.0),
        ("fill 220", WaterAction::Fill { pitch: 220.0, duration: 2.0 }, 2.0),
        ("fill 660", WaterAction::Fill { pitch: 660.0, duration: 2.0 }, 2.0),
        ("rain 8", WaterAction::Rain { rate: 8.0, duration: 3.0 }, 3.0),
        ("brook .5", WaterAction::Brook { speed: 0.5, duration: 3.0 }, 3.0),
        ("surf 1", WaterAction::Surf { height: 1.0, duration: 10.0 }, 10.0),
        ("slosh 1", WaterAction::Slosh { strength: 1.0, duration: 4.0 }, 4.0),
    ];
    for (name, a, secs) in actions {
        let t0 = Instant::now();
        let x = render_water_performance(spec, unity, &[(0.0, a.command(&spec))], 1.0);
        let m = mono(&x);
        let s = seg(&m, 0.0, secs);
        println!("{name:14} peak {:6.1} dBFS rms {:6.1} dBFS ({:.1} s rendered in {:.2} s)", db(s.iter().fold(0.0f32, |p, v| p.max(v.abs()))), db(rms(s)), m.len() as f32 / SR, t0.elapsed().as_secs_f32());
    }
    for target in RainTarget::ALL {
        let spec = WaterSpec { rain: target, ..spec };
        let x = mono(&render_water_performance(spec, unity, &[(0.0, WaterAction::Rain { rate: 8.0, duration: 3.0 }.command(&spec))], 0.5));
        println!("rain on {:7} rms {:6.1} dBFS", target.name(), db(rms(seg(&x, 0.5, 3.0))));
    }
}

#[test]
fn a_water_track_plays_its_notes_at_their_pitches_and_lets_them_go() {
    use super::water_voice::*;
    let spec = WaterSpec::default();
    let play = |notes: &[(f64, WaterAction)], tail: f32| {
        let cmds: Vec<(f64, WaterCommand)> = notes.iter().map(|(t, a)| (*t, a.command(&spec))).collect();
        mono(&render_water_performance(spec, DEFAULT_MIX, &cmds, tail))
    };
    // A glass, a drip and a fill each sound their note.
    let glass = play(&[(0.0, WaterAction::Glass { pitch: 587.33, speed: 0.5, spoon: false })], 1.0);
    assert!(super::tests::cents(peak(seg(&glass, 0.05, 1.0), 200.0, 3000.0).0, 587.33).abs() < 10.0);
    let drip = play(&[(0.0, WaterAction::Drip { pitch: 1318.5, x: 0.0 })], 0.2);
    assert!(super::tests::cents(peak(seg(&drip, 0.0, 0.004), 500.0, 5000.0).0, 1318.5).abs() < 60.0);
    let fill = play(&[(0.0, WaterAction::Fill { pitch: 330.0, duration: 2.0 })], 0.3);
    // As the pour ends (the bubbles it made ring on in the column tuned where it stopped).
    assert!(super::tests::cents(peak(seg(&fill, 1.9, 2.2), 150.0, 800.0).0, 330.0).abs() < 40.0);
    assert!(peak(seg(&fill, 0.1, 0.4), 150.0, 800.0).0 < 330.0 * 0.8);
    // Rain stops when its note ends: the drops ring out and the track falls silent.
    let rain = play(&[(0.0, WaterAction::Rain { rate: 10.0, duration: 1.0 })], 3.0);
    assert!(rms(seg(&rain, 0.3, 1.0)) > 1.0e-3);
    assert!(rms(seg(&rain, 1.6, 2.0)) < rms(seg(&rain, 0.3, 1.0)) * 0.01, "the rain didn't stop");
    // The brook fades in for its note and away after it.
    let brook = play(&[(0.0, WaterAction::Brook { speed: 0.5, duration: 1.0 })], 3.0);
    assert!(rms(seg(&brook, 0.5, 1.0)) > 1.0e-3);
    assert!(brook.len() < (4.5 * SR) as usize, "the brook kept playing: {} s", brook.len() as f32 / SR);
}

#[test]
#[ignore]
fn water_cost() {
    use super::water_voice::*;
    // Everything at once on one track: a drip every 100 ms, a glass every 250 ms, a fill, rain on
    // each surface, the brook, the surf and the tub.
    for target in RainTarget::ALL {
        let spec = WaterSpec { rain: target, ..WaterSpec::default() };
        let mut w = Water::new(spec, SR);
        let actions = [WaterAction::Fill { pitch: 330.0, duration: 4.0 }, WaterAction::Rain { rate: 20.0, duration: 4.0 }, WaterAction::Brook { speed: 0.6, duration: 4.0 }, WaterAction::Surf { height: 1.0, duration: 4.0 }, WaterAction::Slosh { strength: 1.0, duration: 4.0 }];
        for a in actions {
            w.command(a.command(&spec));
        }
        let drips: Vec<WaterCommand> = (0..40).map(|k| WaterAction::Drip { pitch: 600.0 + 50.0 * k as f32, x: 0.0 }.command(&spec)).collect();
        let glasses: Vec<WaterCommand> = (0..16).map(|k| WaterAction::Glass { pitch: 400.0 + 40.0 * k as f32, speed: 0.4, spoon: false }.command(&spec)).collect();
        let t0 = Instant::now();
        for i in 0..(4.0 * SR) as usize {
            if i % 4410 == 0 {
                w.command(drips[i / 4410 % 40]);
            }
            if i % 11025 == 0 {
                w.command(glasses[i / 11025 % 16]);
            }
            w.next_frame();
        }
        println!("rain on {:7}: everything at once {:.0}% of a core", target.name(), t0.elapsed().as_secs_f32() / 4.0 * 100.0);
    }
}


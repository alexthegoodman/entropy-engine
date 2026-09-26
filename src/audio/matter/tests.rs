//! Physics-level tests: every claim the drums make is rendered offline and measured - mode
//! frequencies from spectral peaks, decay times, contact times, pitch glides, levels - the way the
//! strings and brass were developed. Run with `cargo test --release --lib matter`.

use super::drum::*;
use super::membrane::*;
use super::modal::*;
use super::*;
use super::bessel;
use crate::audio::physmod::analysis::spectrum;

const SR: f32 = 44_100.0;

pub(super) fn cents(a: f32, b: f32) -> f32 {
    1200.0 * (a / b).log2()
}

pub(super) fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

pub(super) fn db(x: f32) -> f32 {
    20.0 * x.max(1.0e-12).log10()
}

/// The strongest spectral peak of `seg` between `lo` and `hi` Hz: (frequency, magnitude), with
/// parabolic refinement.
pub(super) fn peak(seg: &[f32], lo: f32, hi: f32) -> (f32, f32) {
    let (m, bin) = spectrum(seg, SR);
    let a = ((lo / bin) as usize).max(1);
    let b = ((hi / bin) as usize).min(m.len() - 2);
    let mut k = a;
    for i in a..=b {
        if m[i] > m[k] {
            k = i;
        }
    }
    let (y0, y1, y2) = (m[k - 1], m[k], m[k + 1]);
    let den = y0 - 2.0 * y1 + y2;
    let d = if den.abs() > 1.0e-12 { 0.5 * (y0 - y2) / den } else { 0.0 };
    ((k as f32 + d) * bin, y1)
}

/// Spectral centroid of `seg` (Hz).
pub(super) fn centroid(seg: &[f32]) -> f32 {
    let (m, bin) = spectrum(seg, SR);
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for (k, v) in m.iter().enumerate().skip(1) {
        num += k as f64 * bin as f64 * *v as f64;
        den += *v as f64;
    }
    (num / den.max(1.0e-20)) as f32
}

/// Share of the energy of `seg` above `f` Hz, dB.
pub(super) fn above(seg: &[f32], f: f32) -> f32 {
    let (m, bin) = spectrum(seg, SR);
    let tot: f32 = m.iter().map(|v| v * v).sum();
    let hi: f32 = m.iter().enumerate().filter(|(k, _)| *k as f32 * bin > f).map(|(_, v)| v * v).sum();
    10.0 * (hi / tot.max(1.0e-30)).max(1.0e-30).log10()
}

fn above_1k(seg: &[f32]) -> f32 {
    above(seg, 1000.0)
}

pub(super) fn secs(x: &[f32], a: f32, b: f32) -> &[f32] {
    &x[(a * SR) as usize..((b * SR) as usize).min(x.len())]
}

fn hit(spec: &DrumSpec, velocity: f32, position: f32) -> Vec<f32> {
    render_hit(spec, Strike { velocity, position, angle: 0.0, striker: spec.striker }, SR, 2.0)
}


/// The frequency of the head mode `(m, n)` as built (air loading included), Hz.
fn mode_freq(spec: &DrumSpec, m: u32, n: u32) -> f32 {
    Membrane::new(spec.batter, spec.max_modes, 20_000.0, true).modes.iter().find(|x| x.m == m && x.n == n).unwrap().freq
}

/// Magnitude of the peak within 3% of `f` in `seg`.
fn level_at(seg: &[f32], f: f32) -> f32 {
    peak(seg, f * 0.97, f * 1.03).1
}

// ---------------------------------------------------------------- the modal body

#[test]
fn a_struck_mode_rings_at_its_frequency_and_decays_at_its_rate() {
    let spec = ModeSpec { freq: 440.0, sigma: 3.0, mass: 0.1, radiation: 1.0 };
    let mut b = ModalBody::new(&[spec], SR);
    b.add_modal_force(0, 100.0);
    let x: Vec<f32> = (0..SR as usize * 2).map(|_| { b.step(); b.q(0) }).collect();
    let (f, _) = peak(secs(&x, 0.0, 1.0), 400.0, 480.0);
    assert!(cents(f, spec.freq * (1.0 - (3.0 / (std::f32::consts::TAU * 440.0)).powi(2)).sqrt()).abs() < 1.0, "{f}");
    let sigma = (rms(secs(&x, 0.2, 0.4)) / rms(secs(&x, 1.2, 1.4))).ln() / 1.0;
    assert!((sigma / 3.0 - 1.0).abs() < 0.02, "decay rate {sigma}");
}

#[test]
fn a_low_mode_keeps_its_tuning_in_single_precision() {
    // The rotated complex state stays in tune where a two-pole recurrence in f32 would drift by
    // several cents: a 30 Hz mode at 44.1 kHz.
    let spec = ModeSpec { freq: 30.0, sigma: 0.5, mass: 0.1, radiation: 1.0 };
    let mut b = ModalBody::new(&[spec], SR);
    b.add_modal_force(0, 1.0);
    let x: Vec<f32> = (0..SR as usize * 4).map(|_| { b.step(); b.q(0) }).collect();
    let (f, _) = peak(&x, 25.0, 35.0);
    assert!(cents(f, 30.0).abs() < 0.5, "{f}");
}

#[test]
fn scaling_a_ringing_body_keeps_it_continuous_and_retunes_it() {
    let spec = ModeSpec { freq: 200.0, sigma: 0.0, mass: 0.1, radiation: 1.0 };
    let mut b = ModalBody::new(&[spec], SR);
    b.add_modal_force(0, 50.0);
    for _ in 0..1000 {
        b.step();
    }
    let (q0, v0) = (b.q(0), b.q_dot(0));
    b.set_scale(1.5);
    assert!((b.q(0) - q0).abs() < 1.0e-9 && (b.q_dot(0) - v0).abs() < 1.0e-6 * v0.abs().max(1.0e-3), "state jumped");
    let x: Vec<f32> = (0..SR as usize).map(|_| { b.step(); b.q(0) }).collect();
    let (f, _) = peak(&x, 250.0, 350.0);
    assert!(cents(f, 300.0).abs() < 1.0, "{f}");
}

// ---------------------------------------------------------------- the membrane

#[test]
fn a_membrane_in_vacuum_rings_at_the_bessel_zeros() {
    let head = HeadSpec { loss: 0.5, loss_hf: 0.0, ..HeadSpec::single_ply(0.2) };
    let mem = Membrane::new(head, 40, 5000.0, false);
    let mut body = ModalBody::new(&mem.mode_specs(), SR);
    let mut at = vec![0.0; mem.modes.len()];
    let mut watch = vec![0.0; mem.modes.len()];
    mem.shape_at(0.6, 0.0, &mut at);
    mem.shape_at(0.45, 0.3, &mut watch);
    body.add_force(&at, 10.0);
    let x: Vec<f32> = (0..SR as usize * 2).map(|_| { body.step(); body.displacement(&watch) }).collect();
    let f01 = mem.modes[0].freq;
    let (m01, _) = peak(&x, f01 * 0.95, f01 * 1.05);
    for (m, n, j) in [(1, 1, 3.831_706), (2, 1, 5.135_622), (0, 2, 5.520_078), (3, 1, 6.380_162)] {
        let want = m01 * j / 2.404_826;
        let (f, _) = peak(&x, want * 0.98, want * 1.02);
        assert!(cents(f, want).abs() < 3.0, "({m},{n}) at {f:.2} Hz, Bessel says {want:.2}");
    }
}

#[test]
fn a_centre_strike_leaves_the_asymmetric_modes_silent() {
    let spec = DrumSpec::timpani(130.81);
    let f11 = mode_freq(&spec, 1, 1);
    let f01 = mode_freq(&spec, 0, 1);
    let centre = hit(&spec, 2.0, 0.0);
    let edge = hit(&spec, 2.0, 0.75);
    let (c, e) = (secs(&centre, 0.05, 1.05), secs(&edge, 0.05, 1.05));
    let rel_c = db(level_at(c, f11) / level_at(c, f01));
    let rel_e = db(level_at(e, f11) / level_at(e, f01));
    assert!(rel_e - rel_c > 30.0, "(1,1) relative to (0,1): centre {rel_c:.1} dB, off-centre {rel_e:.1} dB");
}

#[test]
fn air_loading_is_largest_for_the_lowest_modes_and_tends_to_rho_over_k() {
    // High modes: the evanescent near field carries a mass rho / k_s per unit area, pi / j in these
    // units. Low modes carry far more, because their spectra sit at small wavenumbers.
    for (m, n) in [(0u32, 12usize), (3, 10), (8, 7)] {
        let j = bessel::jn_zeros(m, n)[n - 1];
        let (mass, _) = radiation(m, j, 0.0);
        let asym = std::f64::consts::PI / j;
        assert!((mass / asym - 1.0).abs() < 0.1, "({m},{n}) j {j:.1}: {mass:.4} vs {asym:.4}");
    }
    let j01 = bessel::jn_zeros(0, 1)[0];
    let (m01, _) = radiation(0, j01, 0.0);
    assert!(m01 > 1.5 * std::f64::consts::PI / j01, "(0,1): {m01}");
}

#[test]
fn radiation_of_a_volume_changing_mode_matches_the_monopole_law_at_low_frequency() {
    // A small baffled source radiates rho c k^2 V^2 / (2 pi) (per unit velocity squared, halved).
    let j = bessel::jn_zeros(0, 1)[0];
    let u = 0.05;
    let (_, r) = radiation(0, j, u);
    // Volume of the normalized (0,1) shape, per a^2: 2 pi N J_1(j) / j with N = 1 / J_1(j).
    let v = 2.0 * std::f64::consts::PI / j;
    let monopole = u * v * v / (2.0 * std::f64::consts::PI);
    assert!((r / monopole - 1.0).abs() < 0.01, "{r} vs {monopole}");
}

// ---------------------------------------------------------------- timpani

#[test]
fn the_timpani_plays_its_note_on_the_one_one_mode() {
    let spec = DrumSpec::timpani(130.81);
    let x = hit(&spec, 2.0, 0.75);
    let (f, _) = peak(secs(&x, 0.5, 1.5), 60.0, 600.0);
    assert!(cents(f, 130.81).abs() < 5.0, "sounding {f:.2} Hz");
}

#[test]
fn air_loading_pulls_the_timpani_toward_a_harmonic_series() {
    // Vacuum ratios of the (m,1) family are 1.34, 1.67, 1.98; a good timpani sounds near 1.5, 2, 2.5
    // (Rossing measures 1.50, 1.97, 2.44). The computed air loading alone gets there - measured from
    // the rendered sound.
    let spec = DrumSpec::timpani(130.81);
    let x = hit(&spec, 2.0, 0.75);
    let seg = secs(&x, 0.2, 1.8);
    let (f11, _) = peak(seg, 120.0, 140.0);
    let vacuum = [1.340, 1.665, 1.980];
    for (i, (m, want)) in [(2u32, 1.5f32), (3, 2.0), (4, 2.5)].into_iter().enumerate() {
        let guess = mode_freq(&spec, m, 1);
        let (f, _) = peak(seg, guess * 0.97, guess * 1.03);
        let ratio = f / f11;
        assert!((ratio / want - 1.0).abs() < 0.06, "({m},1)/(1,1) = {ratio:.3}, want about {want}");
        assert!((ratio - want).abs() * 3.0 < (vacuum[i] - want).abs(), "({m},1): {ratio:.3} not much closer than vacuum {}", vacuum[i]);
    }
}

#[test]
fn the_timpani_thud_dies_before_its_note() {
    // The (0,1) mode sweeps volume and radiates as a monopole, so radiation damps it fast; the
    // (1,1) mode barely radiates and sings on.
    let spec = DrumSpec::timpani(130.81);
    let x = hit(&spec, 2.0, 0.75);
    let (f01, f11) = (mode_freq(&spec, 0, 1), mode_freq(&spec, 1, 1));
    let early = secs(&x, 0.0, 0.25);
    let late = secs(&x, 0.75, 1.0);
    let drop01 = db(level_at(early, f01) / level_at(late, f01));
    let drop11 = db(level_at(early, f11) / level_at(late, f11));
    assert!(drop01 > drop11 + 10.0, "(0,1) fell {drop01:.1} dB, (1,1) {drop11:.1} dB");
}

#[test]
fn a_harder_mallet_is_brighter() {
    let soft = DrumSpec::timpani(130.81);
    let hard = DrumSpec { striker: StrikerSpec::hard_mallet(), ..soft };
    let (xs, xh) = (hit(&soft, 2.0, 0.75), hit(&hard, 2.0, 0.75));
    let (cs, ch) = (centroid(secs(&xs, 0.0, 0.15)), centroid(secs(&xh, 0.0, 0.15)));
    assert!(ch > cs * 1.15, "hard {ch:.0} Hz vs soft {cs:.0} Hz");
    let (hs, hh) = (above_1k(secs(&xs, 0.0, 0.15)), above_1k(secs(&xh, 0.0, 0.15)));
    assert!(hh > hs + 3.0, "above 1 kHz: hard {hh:.1} dB, soft {hs:.1} dB");
}

#[test]
fn felt_brightens_as_it_is_played_harder() {
    let spec = DrumSpec::timpani(130.81);
    let quiet = hit(&spec, 0.4, 0.75);
    let loud = hit(&spec, 4.0, 0.75);
    let (cq, cl) = (centroid(secs(&quiet, 0.0, 0.15)), centroid(secs(&loud, 0.0, 0.15)));
    assert!(cl > cq * 1.15, "loud {cl:.0} Hz vs quiet {cq:.0} Hz");
    assert!(db(rms(&loud) / rms(&quiet)) > 15.0);
}

// ---------------------------------------------------------------- toms and kick

/// How far (cents) the batter head's (1,1) mode sounds above its settled pitch just after a hit at
/// `velocity`, watched on the head itself with a (virtual) laser vibrometer, on the drum with its
/// resonant head taken off and its bottom open (a concert tom): on the full drum the air ties the
/// two heads' (1,1) modes into a pair, and the early and late windows can catch different members.
fn glide(spec: &DrumSpec, velocity: f32) -> f32 {
    let spec = &DrumSpec { reso: None, volume: 0.0, ..*spec };
    let f = mode_freq(spec, 1, 1);
    let mut d = Drum::new(*spec, SR);
    d.strike(Strike { velocity, position: 0.5, angle: 0.0, striker: spec.striker });
    let mem = d.head(0).unwrap();
    let mut watch = vec![0.0; mem.modes.len()];
    mem.shape_at(0.5, 0.0, &mut watch);
    let x: Vec<f32> = (0..(1.6 * SR) as usize).map(|_| { d.next_sample(); d.head_body(0).unwrap().displacement(&watch) }).collect();
    let (early, _) = peak(secs(&x, 0.005, 0.085), f * 0.97, f * 1.3);
    let (late, _) = peak(secs(&x, 0.8, 1.6), f * 0.97, f * 1.03);
    cents(early, late)
}

#[test]
fn a_hard_hit_glides_down_to_its_pitch_and_a_soft_one_does_not() {
    let tom = DrumSpec::floor_tom(82.0);
    let hard = glide(&tom, 6.0);
    let soft = glide(&tom, 0.5);
    assert!(hard > 20.0, "hard hit glides {hard:.1} cents");
    assert!(soft.abs() < 4.0, "soft hit glides {soft:.1} cents");
}

#[test]
fn a_slacker_head_glides_further() {
    let slack = glide(&DrumSpec::floor_tom(65.0), 5.0);
    let tight = glide(&DrumSpec::floor_tom(110.0), 5.0);
    assert!(slack > tight * 1.5, "slack {slack:.1} cents, tight {tight:.1}");
}

#[test]
fn a_tom_follows_its_tuning() {
    let lo = DrumSpec::rack_tom(120.0);
    let hi = DrumSpec::rack_tom(160.0);
    let f = |s: &DrumSpec| {
        let g = mode_freq(s, 1, 1);
        peak(secs(&hit(s, 1.0, 0.5), 0.3, 1.0), g * 0.95, g * 1.05).0
    };
    let ratio = f(&hi) / f(&lo);
    // The air inside loads the (1,1) mode through its own (1,1) mode (~660 Hz in this shell), more so
    // the closer the head's mode comes to it: the higher tuning lands a little flat of the ratio.
    assert!(cents(ratio, 160.0 / 120.0).abs() < 25.0, "ratio {ratio:.3}");
}

#[test]
fn a_stick_bounces_off_a_tom_after_a_few_milliseconds() {
    let spec = DrumSpec::rack_tom(140.0);
    let mut d = Drum::new(spec, SR);
    d.strike(Strike { velocity: 4.0, position: 0.4, angle: 0.0, striker: spec.striker });
    let mut touching = 0;
    for _ in 0..(0.05 * SR) as usize {
        d.next_sample();
        if d.last_force > 0.0 {
            touching += 1;
        }
    }
    let t = touching as f32 / SR;
    assert!(t > 0.001 && t < 0.008, "in contact {:.2} ms", t * 1000.0);
    assert!(!d.striking(), "the stick should have left the head");
}

#[test]
fn the_kick_pillow_shortens_the_boom() {
    let damped = DrumSpec::kick(55.0);
    let open = DrumSpec { batter: HeadSpec { loss: 3.0, loss_hf: 5.0, ..damped.batter }, ..damped };
    let fall = |s: &DrumSpec| {
        let x = hit(s, 3.0, 0.2);
        db(rms(secs(&x, 0.0, 0.1)) / rms(secs(&x, 0.4, 0.6)))
    };
    let (d, o) = (fall(&damped), fall(&open));
    assert!(d > o + 6.0, "pillow {d:.1} dB fall, open {o:.1} dB");
}

#[test]
fn a_plastic_beater_is_brighter_than_felt() {
    let felt = DrumSpec::kick(55.0);
    let plastic = DrumSpec { striker: StrikerSpec::plastic_beater(), ..felt };
    // Both are dominated by the slack head (the beater rides it for ~19 ms); what the tip changes is
    // the sharp start of the force, which is the top of the spectrum.
    let hf = above(secs(&hit(&felt, 3.0, 0.2), 0.0, 0.15), 4000.0);
    let hp = above(secs(&hit(&plastic, 3.0, 0.2), 0.0, 0.15), 4000.0);
    assert!(hp > hf + 6.0, "above 4 kHz: plastic {hp:.1} dB, felt {hf:.1} dB");
}

#[test]
fn the_shell_air_couples_the_heads() {
    // Hitting the batter sets the resonant head moving through the enclosed air alone.
    let spec = DrumSpec::floor_tom(82.0);
    let mut d = Drum::new(spec, SR);
    d.strike(Strike { velocity: 3.0, position: 0.3, angle: 0.0, striker: spec.striker });
    for _ in 0..(0.1 * SR) as usize {
        d.next_sample();
    }
    let reso = d.head_body(1).unwrap().energy();
    assert!(reso > 0.01 * d.head_body(0).unwrap().energy(), "resonant head energy {reso:e}");
    let sealed = DrumSpec { volume: 0.0, ..spec };
    let mut d = Drum::new(sealed, SR);
    d.strike(Strike { velocity: 3.0, position: 0.3, angle: 0.0, striker: spec.striker });
    for _ in 0..(0.1 * SR) as usize {
        d.next_sample();
    }
    assert_eq!(d.head_body(1).unwrap().energy(), 0.0);
}

#[test]
fn every_drum_is_bounded_and_falls_silent() {
    for spec in [DrumSpec::kick(40.0), DrumSpec::snare(180.0), DrumSpec::floor_tom(60.0), DrumSpec::rack_tom(200.0), DrumSpec::timpani(90.0)] {
        let x = render_hit(&spec, Strike { velocity: 25.0, position: 0.9, angle: 0.0, striker: StrikerSpec::stick() }, SR, 6.0);
        // 90 km/h at the rim: loud (a few hundred pascals at 1 m) but finite and settling.
        assert!(x.iter().all(|v| v.is_finite() && v.abs() < 100.0), "{:?} blew up", spec.kind);
        assert!(rms(secs(&x, 5.5, 6.0)) < 1.0e-3, "{:?} still ringing", spec.kind);
    }
}

#[test]
fn later_hits_land_on_a_ringing_head() {
    // Two hits a beat apart on one drum: the second adds to what is still ringing rather than
    // restarting it, and a hit on a moving head is still a contact, not a reset.
    let spec = DrumSpec::rack_tom(140.0);
    let s = |v| Strike { velocity: v, position: 0.4, angle: 0.0, striker: spec.striker };
    let two = render_hits(&spec, &[(0.0, s(3.0)), (0.25, s(3.0))], SR, 1.0);
    let one = render_hits(&spec, &[(0.0, s(3.0))], SR, 1.25);
    let (a, b) = (rms(secs(&two, 0.3, 0.6)), rms(secs(&one, 0.3, 0.6)));
    assert!(a > b * 1.2, "{a} vs {b}");
    assert!(two.iter().all(|v| v.is_finite()));
}

// ---------------------------------------------------------------- the high band

#[test]
fn the_high_band_carries_a_sticks_crack_without_changing_the_hit() {
    // The sampled modes above the complete band put the top of the spectrum back (a stick on a tom
    // has real energy above 4 kHz), and since they only listen to the contact, the contact itself -
    // the force pulse the stick and the head make - is the same with or without them.
    let with = DrumSpec::rack_tom(140.0);
    let without = DrumSpec { high_band: 0.0, ..with };
    let run = |spec: &DrumSpec| {
        let mut d = Drum::new(*spec, SR);
        d.strike(Strike { velocity: 4.0, position: 0.4, angle: 0.0, striker: spec.striker });
        let mut force = Vec::new();
        let x: Vec<f32> = (0..(0.2 * SR) as usize).map(|_| { let y = d.next_sample(); force.push(d.last_force); y }).collect();
        (x, force)
    };
    let (xw, fw) = run(&with);
    let (xo, fo) = run(&without);
    let (hw, ho) = (above(&xw, 4000.0), above(&xo, 4000.0));
    assert!(hw > ho + 10.0, "above 4 kHz: {hw:.1} dB with the high band, {ho:.1} dB without");
    // The one way the high band reaches back: its motion stretches the head too, raising the tension
    // a little during the contact.
    let (pw, po) = (fw.iter().fold(0.0f32, |m, v| m.max(*v)), fo.iter().fold(0.0f32, |m, v| m.max(*v)));
    let (tw, to) = (fw.iter().filter(|v| **v > 0.0).count() as f32, fo.iter().filter(|v| **v > 0.0).count() as f32);
    assert!((pw / po - 1.0).abs() < 0.03 && (tw / to - 1.0).abs() < 0.03, "peak {pw} vs {po} N, contact {tw} vs {to} samples");
}

#[test]
fn a_membranes_high_band_falls_away_smoothly() {
    // No band of the spectrum stands out: each octave from 2 to 16 kHz of a felt kick hit carries
    // less than the one below it (the sampled modes are spread evenly, their shapes and radiation
    // are the band's averages, and retuning during the glide is continuous).
    let x = hit(&DrumSpec::kick(55.0), 3.0, 0.2);
    let (m, bin) = spectrum(secs(&x, 0.0, 0.15), SR);
    let band = |lo: f32, hi: f32| -> f32 { m.iter().enumerate().filter(|(k, _)| { let f = *k as f32 * bin; f >= lo && f < hi }).map(|(_, v)| v * v).sum() };
    let octaves: Vec<f32> = [1000.0f32, 2000.0, 4000.0, 8000.0].iter().map(|&f| db(band(f, 2.0 * f).sqrt())).collect();
    for w in octaves.windows(2) {
        assert!(w[1] < w[0], "octave levels {octaves:?}");
    }
}

// ---------------------------------------------------------------- the air inside

#[test]
fn the_air_inside_ties_the_heads_asymmetric_modes() {
    // A uniform pressure can only move a head's volume-changing modes. The cavity's transverse modes
    // carry the batter's (1,1) motion to the resonant head's: with them the snare side's m = 1 modes
    // move, as they do in a real snare; with only the uniform mode (no depth given) they can't.
    let energy_m1 = |spec: DrumSpec| {
        let mut d = Drum::new(spec, SR);
        d.strike(Strike { velocity: 2.0, position: 0.5, angle: 0.0, striker: spec.striker });
        for _ in 0..(0.05 * SR) as usize {
            d.next_sample();
        }
        let (head, body) = (d.head(1).unwrap(), d.head_body(1).unwrap());
        let e = |pick: &dyn Fn(u32) -> bool| head.modes.iter().enumerate().filter(|(_, m)| pick(m.m) && m.count == 1.0).map(|(k, m)| 0.5 * m.spec.mass * (2.0 * std::f32::consts::PI * m.freq).powi(2) * body.mean_square(k)).sum::<f32>();
        e(&|m| m == 1) / e(&|_| true).max(1.0e-30)
    };
    let snare = DrumSpec::snare(220.0).snares_off();
    let with = energy_m1(snare);
    let without = energy_m1(DrumSpec { depth: 0.0, ..snare });
    assert!(with > 0.03 && without == 0.0, "share of the snare side's energy in m = 1: {with:.3} with the cavity's modes, {without:.3} without");
}

// ---------------------------------------------------------------- the snare

/// Strikes `spec` at `velocity` and listens for a second: (sound, landings, the last time any wire
/// group was off the head).
fn snare_hit(spec: &DrumSpec, velocity: f32) -> (Vec<f32>, u32, f32) {
    let mut d = Drum::new(*spec, SR);
    d.strike(Strike { velocity, position: 0.4, angle: 0.0, striker: spec.striker });
    let mut last = 0.0;
    let x = (0..SR as usize)
        .map(|i| {
            let y = d.next_sample();
            if d.wires_lifted() > 0 {
                last = i as f32 / SR;
            }
            y
        })
        .collect();
    (x, d.wire_landings(), last)
}

fn with_preload(preload: f32) -> DrumSpec {
    let mut s = DrumSpec::snare(220.0);
    s.snares.as_mut().unwrap().preload = preload;
    s
}

#[test]
fn snare_wires_rattle_by_lifting_off_and_landing() {
    // Nothing plays a noise burst: each wire group is thrown off the head and lands again, many times.
    let (_, landings, last) = snare_hit(&DrumSpec::snare(220.0), 2.0);
    assert!(landings > 50, "{landings} landings");
    assert!(last > 0.02, "the wires stop leaving the head after {last:.3} s");
    let (_, none, _) = snare_hit(&DrumSpec::snare(220.0).snares_off(), 2.0);
    assert_eq!(none, 0);
}

#[test]
fn snares_on_add_the_top_end_that_snares_off_lacks() {
    let (on, _, _) = snare_hit(&DrumSpec::snare(220.0), 2.0);
    let (off, _, _) = snare_hit(&DrumSpec::snare(220.0).snares_off(), 2.0);
    let level = |x: &[f32]| {
        let (m, bin) = spectrum(secs(x, 0.0, 0.05), SR);
        db(m.iter().enumerate().filter(|(k, _)| *k as f32 * bin > 3000.0).map(|(_, v)| v * v).sum::<f32>().sqrt())
    };
    let (a, b) = (level(&on), level(&off));
    assert!(a > b + 4.0, "above 3 kHz in the first 50 ms: {a:.1} dB on, {b:.1} dB off");
}

#[test]
fn a_harder_hit_rattles_more_and_longer() {
    let (_, soft, soft_last) = snare_hit(&DrumSpec::snare(220.0), 0.8);
    let (_, hard, hard_last) = snare_hit(&DrumSpec::snare(220.0), 4.0);
    assert!(hard > soft && hard_last > soft_last * 1.3, "soft: {soft} landings until {soft_last:.3} s; hard: {hard} until {hard_last:.3} s");
}

#[test]
fn looser_snares_buzz_longer() {
    let (_, loose, loose_last) = snare_hit(&with_preload(0.05), 2.0);
    let (_, tight, tight_last) = snare_hit(&with_preload(1.2), 2.0);
    assert!(loose > tight && loose_last > tight_last * 1.5, "loose: {loose} landings until {loose_last:.3} s; tight: {tight} until {tight_last:.3} s");
}

/// One second of each drum ringing after a hit, timed on this thread (release builds): the cost
/// against the budget in `docs/PHYS_MOD_SOUNDS.md`.
#[test]
#[ignore]
fn cost() {
    for (name, spec) in [("snare", DrumSpec::snare(220.0)), ("kick", DrumSpec::kick(55.0)), ("floor tom", DrumSpec::floor_tom(82.0)), ("rack tom", DrumSpec::rack_tom(140.0)), ("timpani", DrumSpec::timpani(130.81))] {
        let mut d = Drum::new(spec, SR);
        d.strike(Strike { velocity: 3.0, position: 0.4, angle: 0.0, striker: spec.striker });
        let t = std::time::Instant::now();
        let mut acc = 0.0;
        for _ in 0..SR as usize {
            acc += d.next_sample();
        }
        let modes: usize = (0..2).filter_map(|i| d.head(i)).map(|h| h.modes.len()).sum();
        println!("{name}: {modes} modes, {:.1}% of a core ({acc:.1e})", t.elapsed().as_secs_f32() * 100.0);
    }
}

/// Renders hits and phrases to `test-artifacts/matter/` for ears.
#[test]
#[ignore]
fn listening_examples() {
    let dir = std::path::Path::new("test-artifacts/matter");
    std::fs::create_dir_all(dir).unwrap();
    let write = |name: &str, x: &[f32]| {
        let spec = hound::WavSpec { channels: 1, sample_rate: SR as u32, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(dir.join(name), spec).unwrap();
        let peak = x.iter().fold(1.0e-6f32, |m, v| m.max(v.abs()));
        for v in x {
            w.write_sample((v / peak * 0.8 * 32767.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    };
    let at = |spec: &DrumSpec, v: f32, pos: f32| Strike { velocity: v, position: pos, angle: 0.0, striker: spec.striker };
    // Kick: four on the floor, soft to hard.
    let kick = DrumSpec::kick(55.0);
    let hits: Vec<(f32, Strike)> = [1.0f32, 2.0, 3.5, 5.0].iter().enumerate().map(|(i, &v)| (i as f32 * 0.5, at(&kick, v, 0.2))).collect();
    write("kick.wav", &render_hits(&kick, &hits, SR, 1.0));
    // Toms: a fill down the kit, then one floor-tom hit soft and hard (the glide).
    let (rack, floor) = (DrumSpec::rack_tom(150.0), DrumSpec::floor_tom(85.0));
    let mut fill = render_hits(&rack, &[(0.0, at(&rack, 3.0, 0.4)), (0.15, at(&rack, 3.0, 0.4))], SR, 1.5);
    let low = render_hits(&floor, &[(0.3, at(&floor, 3.5, 0.4)), (0.45, at(&floor, 4.0, 0.4)), (1.2, at(&floor, 0.7, 0.4)), (2.2, at(&floor, 7.0, 0.4))], SR, 1.8);
    fill.resize(low.len(), 0.0);
    write("tom_fill.wav", &fill.iter().zip(low.iter()).map(|(a, b)| a + b).collect::<Vec<_>>());
    // Timpani: a phrase on C and G (two drums), then a roll with a crescendo, then a centre stroke.
    let (c, g) = (DrumSpec::timpani(130.81), DrumSpec::timpani(98.0));
    let a = render_hits(&c, &[(0.0, at(&c, 2.0, 0.75)), (1.0, at(&c, 2.0, 0.75))], SR, 3.0);
    let b = render_hits(&g, &[(0.5, at(&g, 2.5, 0.75)), (1.5, at(&g, 3.0, 0.75))], SR, 2.5);
    write("timpani_phrase.wav", &a.iter().zip(b.iter().chain(std::iter::repeat(&0.0))).map(|(x, y)| x + y).collect::<Vec<_>>());
    let roll: Vec<(f32, Strike)> = (0..40).map(|i| (i as f32 * 0.06, at(&g, 0.4 + 2.6 * i as f32 / 40.0, 0.72 + 0.04 * (i % 2) as f32))).collect();
    write("timpani_roll.wav", &render_hits(&g, &roll, SR, 2.5));
    // Snare: a backbeat, ghost notes, a roll, then the same hit with the snares off, loose and tight.
    let snare = DrumSpec::snare(220.0);
    let mut groove: Vec<(f32, Strike)> = Vec::new();
    for bar in 0..2 {
        let t0 = bar as f32 * 2.0;
        groove.push((t0 + 0.5, at(&snare, 4.0, 0.35)));
        groove.push((t0 + 1.5, at(&snare, 4.5, 0.35)));
        for g in [0.875f32, 1.125, 1.875] {
            groove.push((t0 + g, at(&snare, 0.6, 0.55)));
        }
    }
    for i in 0..24 {
        groove.push((4.2 + i as f32 * 0.045, at(&snare, 0.8 + 2.4 * i as f32 / 24.0, 0.4 + 0.05 * (i % 2) as f32)));
    }
    write("snare_groove.wav", &render_hits(&snare, &groove, SR, 1.0));
    let mut settings = Vec::new();
    for spec in [snare.snares_off(), with_preload(0.05), snare, with_preload(1.2)] {
        settings.extend(render_hits(&spec, &[(0.0, at(&spec, 3.0, 0.4))], SR, 0.9));
    }
    write("snare_off_loose_normal_tight.wav", &settings);
    write("timpani_centre_vs_edge.wav", &render_hits(&c, &[(0.0, at(&c, 2.0, 0.0)), (1.5, at(&c, 2.0, 0.75))], SR, 2.5));
}

#[test]
#[ignore]
fn report() {
    let t = DrumSpec::timpani(130.81);
    let mem = Membrane::new(t.batter, 40, 5000.0, true);
    println!("timpani tension {:.0} N/m", t.batter.tension);
    for md in mem.modes.iter().take(14) {
        println!("({},{}) vac {:.1} loaded {:.1} air {:.4} kg R {:.3} t60 {:.2}s", md.m, md.n, md.vacuum_freq, md.freq, md.air_mass, md.resistance, md.spec.t60());
    }
    for (name, spec, v) in [("kick", DrumSpec::kick(55.0), 3.0), ("floor", DrumSpec::floor_tom(82.0), 4.0), ("rack", DrumSpec::rack_tom(140.0), 4.0), ("timp", t, 2.0)] {
        let x = hit(&spec, v, if spec.kind == DrumKind::Timpani { 0.75 } else { 0.3 });
        let peak_abs = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        println!("{name}: T {:.0} N/m, peak {:.1} dBFS, glide hard {:.1} soft {:.1} cents", spec.batter.tension, db(peak_abs), glide(&spec, 6.0), glide(&spec, 0.5));
    }
}

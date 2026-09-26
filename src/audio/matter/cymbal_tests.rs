//! Plates and cymbals, measured. Run with `cargo test --release --lib matter`.

use super::cymbal::*;
use super::plate::*;
use super::*;

const SR: f32 = 44_100.0;

/// The crash's plate: build time, sizes, and its lowest modes.
#[test]
#[ignore]
fn plate_report() {
    let spec = CymbalSpec::crash();
    let t = std::time::Instant::now();
    let p = Plate::new(spec.plate, spec.options);
    println!("built in {:.2}s: {} modes, {} nonlinear, {} coupled; h {:.3} mm, R {:.2} m, coincidence {:.0} Hz, dome {:.0} Hz", t.elapsed().as_secs_f32(), p.modes.len(), p.nonlinear, p.coupled, spec.plate.thickness * 1e3, spec.plate.dome_radius, spec.plate.coincidence(), spec.plate.dome_omega2().sqrt() / std::f64::consts::TAU);
    println!("couplings {} of {}, in-plane {}", p.couplings.quad.iter().map(|q| q.len()).sum::<usize>(), p.couplings.full, p.couplings.c.len());
    for md in p.modes.iter().take(40) {
        println!("m {} {:?} flat {:.1} f {:.1} R {:.2e} t60 {:.2} rad {:.2e}", md.m, md.kind, md.flat_freq, md.freq, md.resistance, md.spec.t60(), md.spec.radiation);
    }
}

fn at(spec: &CymbalSpec, velocity: f32, position: f32) -> Strike {
    Strike { velocity, position, angle: 0.0, striker: spec.striker }
}

/// An undamped crash body with no radiation, started from a displacement in its lowest modes.
fn undamped(spec: &CymbalSpec, amp: f32) -> (Plate, ModalBody, super::vonkarman::VonKarman) {
    let mut p = spec.plate;
    p.loss = 0.0;
    p.loss_hf = 0.0;
    let plate = Plate::new(p, spec.options);
    let mut specs = plate.mode_specs();
    specs.iter_mut().for_each(|s| s.sigma = 0.0);
    let mut body = ModalBody::new(&specs, SR);
    let vk = super::vonkarman::VonKarman::new(&plate.couplings, &body, p.mass(), spec.every);
    // Knock the lowest few nonlinear modes.
    for k in 0..6 {
        body.add_modal_force(k, amp * p.mass() as f32 * SR * (k as f32 + 1.0).recip());
    }
    body.step();
    (plate, body, vk)
}

/// Energy per third-octave band, dB.
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

/// One second of each cymbal ringing after a hard hit, timed on this thread (release builds).
#[test]
#[ignore]
fn cymbal_cost() {
    for (name, spec) in [("crash", CymbalSpec::crash()), ("ride", CymbalSpec::ride()), ("splash", CymbalSpec::splash())] {
        let mut c = Cymbal::new(spec, SR);
        c.strike(at(&spec, 5.0, 0.9));
        let t = std::time::Instant::now();
        let mut acc = 0.0;
        for _ in 0..SR as usize {
            acc += c.next_sample();
        }
        let vk = c.von_karman().map(|v| (v.len(), v.couplings())).unwrap_or((0, 0));
        println!("{name}: {} modes, {} nonlinear, {} coupling coefficients, {:.1}% of a core ({acc:.1e})", c.body().len(), vk.0, vk.1, t.elapsed().as_secs_f32() * 100.0);
    }
}

/// How the sound of a hard crash changes with the rate the nonlinear force is evaluated at (against
/// every sample).
#[test]
#[ignore]
fn rate_report() {
    let base = CymbalSpec::crash();
    let r = |every| { let s = CymbalSpec { every, ..base }; render_cymbal(&s, &[(0.0, at(&s, 5.0, 0.9))], SR, 0.6) };
    let reference = bands(&r(1)[(0.05 * SR) as usize..]);
    for every in [1u32, 2, 3, 4, 6] {
        let t = std::time::Instant::now();
        let x = r(every);
        let el = t.elapsed().as_secs_f32() / 0.6;
        let b = bands(&x[(0.05 * SR) as usize..]);
        let err: Vec<f32> = reference.iter().zip(&b).map(|(a, b)| (a - b).abs()).collect();
        println!("every {every}: cost {:.0}%, band error max {:.1} dB mean {:.2} dB", el * 100.0, err.iter().fold(0.0f32, |m, v| m.max(*v)), err.iter().sum::<f32>() / err.len() as f32);
    }
}

/// Convergence in the number of in-plane functions (against 2.5x the highest bending wavenumber).
#[test]
#[ignore]
fn inplane_report() {
    let base = CymbalSpec::crash();
    let r = |inplane| { let s = CymbalSpec { options: PlateOptions { inplane, ..base.options }, ..base }; render_cymbal(&s, &[(0.0, at(&s, 5.0, 0.9))], SR, 0.6) };
    let reference = bands(&r(2.5)[(0.05 * SR) as usize..]);
    for inplane in [0.8f32, 1.0, 1.2, 1.5, 2.0, 2.5] {
        let s = CymbalSpec { options: PlateOptions { inplane, ..base.options }, ..base };
        let p = Plate::new(s.plate, s.options);
        let t = std::time::Instant::now();
        let x = r(inplane);
        let el = t.elapsed().as_secs_f32() / 0.6;
        let b = bands(&x[(0.05 * SR) as usize..]);
        let err: Vec<f32> = reference.iter().zip(&b).map(|(a, b)| (a - b).abs()).collect();
        let f: Vec<String> = p.modes.iter().take(12).map(|m| format!("{:.0}", m.freq)).collect();
        println!("inplane {inplane}: {} functions, cost {:.0}%, band error max {:.1} dB mean {:.2} dB; freqs {:?}", p.couplings.c.len(), el * 100.0, err.iter().fold(0.0f32, |m, v| m.max(*v)), err.iter().sum::<f32>() / err.len() as f32, f);
    }
}

/// Energy in each mode of a body, J, with its frequency.
pub(super) fn modal_energies(b: &ModalBody) -> Vec<(f32, f32)> {
    (0..b.len()).map(|k| { let s = b.specs()[k]; let w = std::f32::consts::TAU * s.freq; let v = b.q_dot(k); (s.freq, 0.5 * s.mass * (v * v + w * w * b.q(k) * b.q(k))) }).collect()
}

/// Where a crash's energy is, by band, over its first second: hard, soft, and hard without the
/// stretching.
#[test]
#[ignore]
fn cascade_report() {
    for (name, spec, v) in [("crash", CymbalSpec::crash(), 5.0f32), ("crash", CymbalSpec::crash(), 0.3), ("crash lin", CymbalSpec::crash().linear(), 5.0)] {
        let mut c = Cymbal::new(spec, SR);
        c.strike(at(&spec, v, 0.9));
        let edges = [0.0f32, 300.0, 700.0, 1200.0, 2000.0, 3000.0, 5000.0, 20000.0];
        for i in 0..(SR as usize) {
            c.next_sample();
            if [10usize, 100, 441, 1323, 2205, 4410, 8820, 22050, 44099].contains(&i) {
                let e = modal_energies(c.body());
                let tot: f32 = e.iter().map(|x| x.1).sum();
                let cen = e.iter().map(|x| x.0 * x.1).sum::<f32>() / tot;
                let sh: Vec<String> = edges.windows(2).map(|w| format!("{:.1}", 100.0 * e.iter().filter(|x| x.0 >= w[0] && x.0 < w[1]).map(|x| x.1).sum::<f32>() / tot)).collect();
                println!("{name} v{v} t {:.3}: E {:.2e} centroid {:.0} Hz, % per band {:?}", i as f32 / SR, tot, cen, sh);
            }
        }
    }
}

/// Contact time (s), impulse (N s) and the force's energy below 8 kHz (N^2 s, from its spectrum) of
/// one strike at `sr`.
fn contact(spec: &CymbalSpec, v: f32, pos: f32, sr: f32) -> (f32, f32, f32) {
    let mut c = Cymbal::new(*spec, sr);
    c.strike(at(spec, v, pos));
    let mut f = Vec::new();
    for _ in 0..(0.02 * sr) as usize {
        c.next_sample();
        f.push(c.last_force);
    }
    let n = f.iter().filter(|&&x| x > 0.0).count();
    let (m, bin) = crate::audio::physmod::analysis::spectrum(&f, sr);
    // The window and zero padding scale the spectrum alike at both rates, up to the rate itself.
    let low: f32 = m.iter().enumerate().filter(|(k, _)| (*k as f32) * bin < 8000.0).map(|(_, v)| v * v).sum::<f32>() / (sr * sr);
    (n as f32 / sr, f.iter().sum::<f32>() / sr, low)
}

// ---------------------------------------------------------------- the plate

/// `lambda^2` of the free plate's first modes (nu = 0.33), from the frequency equation solved to
/// full precision: (m, lambda^2). Leissa's table (from Itao & Crandall) gives 5.253, 9.084, 12.23,
/// 20.52, 21.6.
const FREE: [(u32, usize, f64, f64); 5] = [(2, 0, 5.2620, 5.253), (0, 0, 9.0689, 9.084), (3, 0, 12.2439, 12.23), (1, 0, 20.5127, 20.52), (4, 0, 21.5272, 21.6)];

#[test]
fn a_free_plate_rings_at_the_tabulated_frequencies() {
    for (m, n, exact, leissa) in FREE {
        let got = free_modes(m, 0.33, 6.0)[n].lambda.powi(2);
        assert!((got / exact - 1.0).abs() < 2.0e-4, "m {m}: {got} vs {exact}");
        assert!((got / leissa - 1.0).abs() < 5.0e-3, "m {m}: {got} vs Leissa {leissa}");
    }
}

#[test]
fn the_in_plane_functions_are_the_clamped_plate_modes() {
    // Leissa, clamped circular plate: 10.2158, 21.260, 34.877, 39.771.
    for (m, n, want) in [(0u32, 0usize, 10.2158f64), (1, 0, 21.260), (2, 0, 34.877), (0, 1, 39.771)] {
        let got = airy_modes(m, 8.0)[n].lambda.powi(2);
        assert!((got / want - 1.0).abs() < 2.0e-4, "({m},{n}): {got} vs {want}");
    }
}

#[test]
fn the_hankel_transform_matches_quadrature() {
    // The closed form (Lommel) against direct quadrature, for a J + I shape and a few wavenumbers,
    // including the removable singularity at x = lambda.
    let r = free_modes(3, 0.34, 12.0)[1];
    let g = Grid::new(64);
    for x in [0.5, 3.0, r.lambda, 9.0] {
        let direct: f64 = g.r.iter().zip(&g.w).map(|(&s, &w)| r.eval(s)[0] * super::bessel::jn(3, x * s) * s * w).sum();
        assert!((r.hankel(x) - direct).abs() < 1.0e-6 * direct.abs().max(1.0e-3), "x {x}: {} vs {direct}", r.hankel(x));
    }
}

#[test]
fn the_coupling_integrals_are_symmetric() {
    // integral Phi_s L(Phi_r, Psi_k) = integral Psi_k L(Phi_r, Phi_s) holds only when Psi and its
    // slope vanish at the free edge and L is right: a check of both.
    let g = Grid::new(48);
    let tab = |r: Radial| Tab::new(&[(r, 1.0)], &g);
    let phi = |m| tab(free_modes(m, 0.34, 10.0)[0]);
    let psi = |m, n| tab(airy_modes(m, 14.0)[n]);
    for (a, b, k, n) in [(2u32, 3u32, 5u32, 0usize), (2, 2, 0, 1), (3, 5, 2, 0), (0, 4, 4, 1), (1, 3, 2, 1)] {
        let (fa, fb, pk) = (phi(a), phi(b), psi(k, n));
        let one = project(&fa, &fb, &pk, &g);
        let two = project(&pk, &fb, &fa, &g);
        assert!(one.abs() > 1.0e-3, "({a},{b},{k}) vanishes: {one}");
        assert!((one / two - 1.0).abs() < 1.0e-4, "({a},{b},{k}): {one} vs {two}");
    }
}

#[test]
fn the_stretching_force_is_the_gradient_of_its_energy() {
    let spec = CymbalSpec::crash();
    let plate = Plate::new(spec.plate, spec.options);
    let body = ModalBody::new(&plate.mode_specs(), SR);
    let mut vk = super::vonkarman::VonKarman::new(&plate.couplings, &body, spec.plate.mass(), 2);
    let n = vk.len();
    let mut rng = crate::audio::physmod::dsp::Noise(7);
    let q: Vec<f32> = (0..n).map(|k| 1.0e-3 * rng.bipolar() / (1.0 + k as f32 * 0.1)).collect();
    let (_, grad) = vk.gradient_at(&q);
    for k in [0usize, 3, 9, 20, n - 1] {
        let d = 2.0e-3 * q[k].abs().max(1.0e-5);
        let (mut up, mut dn) = (q.clone(), q.clone());
        up[k] += d;
        dn[k] -= d;
        let fd = (vk.gradient_at(&up).0 - vk.gradient_at(&dn).0) / (2.0 * d as f64);
        assert!((fd - grad[k] as f64).abs() < 0.02 * (grad[k] as f64).abs() + 1.0e-6 * grad.iter().fold(0.0f32, |m, v| m.max(v.abs())) as f64, "mode {k}: {fd} vs {}", grad[k]);
    }
}

#[test]
fn a_flat_plate_is_a_plate_and_the_dome_lifts_only_the_stretching_modes() {
    let crash = CymbalSpec::crash();
    let flat = Plate::new(PlateSpec { dome_radius: 0.0, ..crash.plate }, crash.options);
    for md in &flat.modes[..flat.nonlinear] {
        assert!((md.freq / md.flat_freq - 1.0).abs() < 1.0e-4, "flat plate mode moved: {} vs {}", md.freq, md.flat_freq);
    }
    let dome = Plate::new(crash.plate, crash.options);
    let ring = (crash.plate.dome_omega2().sqrt() / std::f64::consts::TAU) as f32;
    let find = |p: &Plate, m: u32, lo: f32| p.modes[..p.nonlinear].iter().filter(|x| x.m == m).map(|x| x.freq).filter(|&f| f > lo).fold(f32::MAX, f32::min);
    // The lowest axisymmetric mode (the plate's volume changing) must stretch the dome: it rises from
    // 38 Hz to the ring frequency.
    let f01 = find(&dome, 0, 0.0);
    assert!(find(&flat, 0, 0.0) < 50.0 && f01 > 0.95 * ring, "(0,1): {f01} Hz, ring {ring} Hz");
    // The modes with nodal diameters only bend without stretching: within 10%.
    for m in 2..8 {
        let (a, b) = (find(&flat, m, 0.0), find(&dome, m, 0.0));
        assert!((b / a - 1.0) < 0.1 && b >= a, "({m},0): {a} -> {b}");
    }
    // Short waves follow the spherical shell's dispersion, omega^2 = omega_flat^2 + E / (rho R^2),
    // which the modes above the nonlinear set use: the highest modes with nodal circles agree.
    for md in dome.modes[..dome.nonlinear].iter().filter(|x| x.flat_freq > 1500.0 && x.m < 10) {
        let want = (md.flat_freq.powi(2) + ring * ring).sqrt();
        assert!((md.freq / want - 1.0).abs() < 0.01, "m {}: {} vs {want}", md.m, md.freq);
    }
}

// ---------------------------------------------------------------- the nonlinearity

#[test]
fn the_scheme_conserves_energy_when_nothing_is_lost() {
    // No damping, no striker: the modes' energy plus the scheme's stretching energy stays put, at an
    // amplitude where the stretching is doing a lot (U swings by a few per mille of E at 0.1).
    let spec = CymbalSpec::crash();
    let (_, mut body, mut vk) = undamped(&spec, 0.1);
    vk.tick(&mut body, true);
    body.step();
    let e0 = body.energy() as f64 + vk.energy();
    let (mut worst, mut track, mut swing) = (0.0f64, 0.0f64, 0.0f64);
    for i in 0..(SR as usize) {
        vk.tick(&mut body, false);
        body.step();
        if i % 441 == 0 {
            let e = body.energy() as f64 + vk.energy();
            worst = worst.max((e / e0 - 1.0).abs());
            let u = vk.stretching(&body);
            track = track.max((vk.energy() - u).abs() / e0);
            swing = swing.max(u.abs() / e0);
        }
    }
    assert!(swing > 1.0e-3, "the stretching barely acts: {swing}");
    assert!(worst < 5.0e-3, "energy drifted by {worst}");
    // The auxiliary variable follows the true stretching energy.
    assert!(track < 0.3 * swing, "psi tracks U to {track} of E (U swings {swing})");
}


/// The share of a cymbal's vibrational energy, `t` seconds after one stroke, that sits in different
/// third-octave bands (by mode frequency) with and without the stretching: 0 for none moved. Taken
/// from the modes' own energies rather than the sound, whose closely spaced modes beat, so a tiny
/// shift of phase would swing a band by a decibel either way.
fn energy_moved(spec: &CymbalSpec, v: f32, t: f32) -> f32 {
    let bands = |s: &CymbalSpec| {
        let mut c = Cymbal::new(*s, SR);
        c.strike(at(s, v, 0.9));
        let mut b = vec![0.0f32; 40];
        // Averaged over the second half of the span: near-resonant modes trade energy back and forth
        // slowly, and one instant would catch the trade half done.
        let n = (t * SR) as usize;
        for i in 0..n {
            c.next_sample();
            if i >= n / 2 && i % 441 == 0 {
                for (f, e) in modal_energies(c.body()) {
                    b[((f.max(20.0) / 20.0).log2() * 3.0) as usize] += e;
                }
            }
        }
        b
    };
    let (x, y) = (bands(spec), bands(&spec.linear()));
    x.iter().zip(&y).map(|(p, q)| (p - q).abs()).sum::<f32>() / x.iter().zip(&y).map(|(p, q)| p + q).sum::<f32>()
}

#[test]
fn a_soft_stroke_is_nearly_linear_and_a_hard_one_is_not() {
    let spec = CymbalSpec::crash();
    let (soft, medium, hard) = (energy_moved(&spec, 0.01, 0.5), energy_moved(&spec, 1.0, 0.5), energy_moved(&spec, 5.0, 0.5));
    assert!(soft < 0.015, "a very soft stroke moves {soft} of its energy");
    assert!(medium > 0.1, "a medium stroke moves only {medium} of its energy");
    assert!(hard > 0.2 && hard > medium, "a hard stroke moves {hard} of its energy (medium {medium})");
}

/// Energy-weighted mean frequency of the nonlinear set's modes, sampled at `times` (s).
fn climb(spec: &CymbalSpec, v: f32, times: &[f32]) -> Vec<f32> {
    let mut c = Cymbal::new(*spec, SR);
    c.strike(at(spec, v, 0.9));
    let n = c.plate().nonlinear;
    let mut out = Vec::new();
    for i in 0..=(times.last().unwrap() * SR) as usize {
        c.next_sample();
        if times.iter().any(|&t| (t * SR) as usize == i) {
            let e = modal_energies(c.body());
            let tot: f32 = e[..n].iter().map(|x| x.1).sum();
            out.push(e[..n].iter().map(|x| x.0 * x.1).sum::<f32>() / tot);
        }
    }
    out
}

#[test]
fn a_hard_crash_moves_its_energy_up_and_then_it_falls() {
    let times = [0.003f32, 0.03, 0.06, 0.1, 0.5, 1.0];
    let hard = climb(&CymbalSpec::crash(), 5.0, &times);
    let lin = climb(&CymbalSpec::crash().linear(), 5.0, &times);
    let top = hard[1..4].iter().fold(0.0f32, |m, v| m.max(*v));
    // Energy climbs through the modes over tens of milliseconds...
    assert!(top > 1.1 * hard[0], "no climb: {hard:?}");
    // ...then falls as the high modes lose it faster than the low ones.
    assert!(hard[5] < 0.8 * top, "no fall: {hard:?}");
    // A linear plate only falls.
    assert!(lin.windows(2).all(|w| w[1] < w[0] * 1.02), "linear rose: {lin:?}");
    assert!(hard[3] > 1.15 * lin[3], "at 100 ms: {} vs linear {}", hard[3], lin[3]);
}

#[test]
fn a_thicker_ride_stays_nearer_linear_than_a_crash() {
    // The same stick at the same speed on the bow: the ride's 1.4 mm bend less for their thickness
    // than the crash's millimetre.
    let with = |s: CymbalSpec| CymbalSpec { striker: StrikerSpec::stick(), ..s };
    let (crash, ride) = (energy_moved(&with(CymbalSpec::crash()), 3.0, 0.3), energy_moved(&with(CymbalSpec::ride()), 3.0, 0.3));
    assert!(ride < 0.6 * crash, "ride moves {ride} of its energy, crash {crash}");
}

// ---------------------------------------------------------------- strikes

#[test]
fn a_stick_on_bronze_is_resolved_at_the_audio_rate() {
    // Wood on bronze peaks for tens of microseconds, which a 44.1 kHz step sees averaged: what must
    // agree with a 4x finer step is what reaches the ear - how long, how much momentum, and the
    // force's spectrum below 8 kHz.
    for spec in [CymbalSpec::crash(), CymbalSpec::ride(), CymbalSpec { striker: StrikerSpec::yarn_mallet(), ..CymbalSpec::ride() }] {
        for v in [1.0f32, 5.0] {
            let (a, b) = (contact(&spec, v, 0.6, 44_100.0), contact(&spec, v, 0.6, 176_400.0));
            assert!((a.0 / b.0 - 1.0).abs() < 0.08, "{:?} v {v}: contact {} vs {}", spec.kind, a.0, b.0);
            assert!((a.1 / b.1 - 1.0).abs() < 0.02, "{:?} v {v}: impulse {} vs {}", spec.kind, a.1, b.1);
            assert!((10.0 * (a.2 / b.2).log10()).abs() < 1.0, "{:?} v {v}: force below 8 kHz {} vs {}", spec.kind, a.2, b.2);
        }
    }
}

#[test]
fn a_yarn_mallet_is_darker_and_longer_than_a_stick() {
    let ride = CymbalSpec::ride();
    let yarn = CymbalSpec { striker: StrikerSpec::yarn_mallet(), ..ride };
    let (s, y) = (contact(&ride, 2.0, 0.6, SR), contact(&yarn, 2.0, 0.6, SR));
    assert!(y.0 > 2.0 * s.0, "contact: yarn {} s, stick {} s", y.0, s.0);
    let run = |sp: &CymbalSpec| render_cymbal(sp, &[(0.0, at(sp, 2.0, 0.6))], SR, 0.3);
    let (xs, xy) = (run(&ride), run(&yarn));
    let (cs, cy) = (super::tests::centroid(&xs[..(0.1 * SR) as usize]), super::tests::centroid(&xy[..(0.1 * SR) as usize]));
    assert!(cy < 0.8 * cs, "centroid: yarn {cy} Hz, stick {cs} Hz");
}

#[test]
fn every_cymbal_is_bounded_and_decays() {
    for spec in [CymbalSpec::crash(), CymbalSpec::ride(), CymbalSpec::splash()] {
        let x = render_cymbal(&spec, &[(0.0, at(&spec, 25.0, 0.98)), (0.05, at(&spec, 25.0, 0.5))], SR, 2.0);
        assert!(x.iter().all(|v| v.is_finite()), "{:?} not finite", spec.kind);
        let r = |a: f32, b: f32| super::tests::rms(&x[(a * SR) as usize..(b * SR) as usize]);
        assert!(r(1.9, 2.0) < 0.3 * r(0.1, 0.2), "{:?} does not decay: {} -> {}", spec.kind, r(0.1, 0.2), r(1.9, 2.0));
    }
}

/// Renders strokes and phrases to `test-artifacts/matter/` for ears.
#[test]
#[ignore]
fn cymbal_listening_examples() {
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
    // A crash soft, medium and hard, each on its own (normalized separately), then the hard one with
    // the stretching switched off.
    let crash = CymbalSpec::crash();
    let mut seq = Vec::new();
    for (s, v) in [(crash, 0.3f32), (crash, 1.5), (crash, 6.0), (crash.linear(), 6.0)] {
        let x = render_cymbal(&s, &[(0.0, at(&s, v, 0.95))], SR, 3.0);
        let peak = x.iter().fold(1.0e-6f32, |m, v| m.max(v.abs()));
        seq.extend(x.iter().map(|v| v / peak));
    }
    write("crash_soft_medium_hard_linear.wav", &seq);
    // A ride pattern on the bow, eighths with the accents on the beat.
    let ride = CymbalSpec::ride();
    let hits: Vec<(f32, Strike)> = (0..16).map(|i| (i as f32 * 0.25, at(&ride, if i % 2 == 0 { 2.5 } else { 1.2 }, 0.6))).collect();
    write("ride_pattern.wav", &render_cymbal(&ride, &hits, SR, 2.5));
    // A splash.
    let splash = CymbalSpec::splash();
    write("splash.wav", &render_cymbal(&splash, &[(0.0, at(&splash, 4.0, 0.9))], SR, 2.0));
    // A yarn-mallet roll on a crash, swelling from nothing.
    let swell = CymbalSpec { striker: StrikerSpec::yarn_mallet(), ..crash };
    let roll: Vec<(f32, Strike)> = (0..60).map(|i| (i as f32 * 0.05, Strike { velocity: 0.1 + 3.0 * (i as f32 / 60.0).powi(2), position: 0.85, angle: if i % 2 == 0 { 0.0 } else { std::f32::consts::PI }, striker: StrikerSpec::yarn_mallet() })).collect();
    write("crash_mallet_swell.wav", &render_cymbal(&swell, &roll, SR, 3.0));
}

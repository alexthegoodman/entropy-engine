//! Physics-level tests: every claim the brass model makes is rendered offline and measured - pitch
//! in cents, which partial sounds, levels, spectra, wavefront steepness - the way the model was
//! developed (see `docs/PHYS_MOD_BRASS.md`). Run with `cargo test --release --lib brass`.

use super::airbore::AirBore;
use super::bore::BoreProfile;
use super::engine::{self, *};
use super::impedance::Reference;
use super::lips::{LipSpec, Lips};
use super::*;
use std::sync::Arc;
use crate::audio::physmod::analysis::{pitch, spectrum};

const SR: f32 = 44_100.0;

fn note(freq: f32) -> BrassParams {
    BrassParams { freq, breath_noise: 0.0, ..Default::default() }
}

fn cents(a: f32, b: f32) -> f32 {
    1200.0 * (a / b).log2()
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

/// Holds a note for `secs` and returns the audio and a report from just before the end.
fn hold(p: BrassParams, secs: f32) -> (Vec<f32>, BrassReport) {
    render_note(&BrassParams { duration: secs, ..p }, SR, secs)
}

/// The settled second half of a held note.
fn settled(x: &[f32]) -> &[f32] {
    &x[x.len() / 2..]
}

fn centroid(seg: &[f32]) -> f32 {
    let (m, bin) = spectrum(seg, SR);
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for (k, v) in m.iter().enumerate().skip(1) {
        num += k as f64 * bin as f64 * *v as f64;
        den += *v as f64;
    }
    (num / den.max(1.0e-20)) as f32
}

/// Level of harmonic `k` of `f0` relative to the strongest of the first 12, dB.
fn harmonic_db(seg: &[f32], f0: f32, k: usize) -> f32 {
    let (m, bin) = spectrum(seg, SR);
    let at = |h: usize| {
        let c = (f0 * h as f32 / bin).round() as usize;
        m[c.saturating_sub(3)..(c + 4).min(m.len())].iter().fold(0.0f32, |a, b| a.max(*b))
    };
    let top = (1..=12).map(at).fold(1.0e-12f32, f32::max);
    20.0 * (at(k) / top).max(1.0e-9).log10()
}

// ---------------------------------------------------------------- the bore

#[test]
fn the_trombone_resonances_form_a_harmonic_ladder_above_a_low_first_one() {
    // What every good trombone shares: peaks 2-10 close to a harmonic series (the flare and the
    // mouthpiece pull an odd-harmonic cylinder into line), and the first well below it - which is
    // why the pedal note is special.
    let b = BoreProfile::tenor_trombone();
    let peaks = Reference::new(&b, 20.0, 700.0, 0.5).peaks(0.0);
    let f1 = b.nominal_fundamental;
    for n in 2..=10 {
        let c = cents(peaks[n - 1].freq, f1 * n as f32);
        assert!(c.abs() < 30.0, "peak {n} at {:.1} Hz is {c:+.0} cents off the B♭ series", peaks[n - 1].freq);
    }
    let ratio = peaks[0].freq / f1;
    assert!(ratio < 0.75, "the first resonance should sit far below the fundamental, got {ratio:.2}");
}

#[test]
fn the_slide_lowers_the_whole_ladder() {
    // Seventh position adds enough tube to lower the resonances by about six semitones. The low
    // ones move further (the second by about seven): they depend more on the mouthpiece and bell,
    // which the slide doesn't lengthen - one reason the low seventh-position notes are hard to
    // play in tune.
    let b = BoreProfile::tenor_trombone();
    let r = Reference::new(&b, 20.0, 700.0, 0.5);
    let (closed, open) = (r.peaks(0.0), r.peaks(b.slide_max));
    for n in 3..=10 {
        let semis = -cents(open[n - 1].freq, closed[n - 1].freq) / 100.0;
        assert!((5.4..6.4).contains(&semis), "peak {n} moved {semis:.2} semitones");
    }
    let second = -cents(open[1].freq, closed[1].freq) / 100.0;
    assert!(second > 6.4, "the second resonance should move further: {second:.2} semitones");
}

#[test]
fn the_runtime_air_column_resonates_where_the_reference_says() {
    // Tap the waveguide with a puff of flow at the lips and find the peaks of the pressure it
    // answers with: the air column's input impedance, measured.
    let b = BoreProfile::tenor_trombone();
    let reference = Reference::new(&b, 20.0, 700.0, 0.5).peaks(0.0);
    let sr = SR * 2.0;
    let mut bore = AirBore::new(&b, sr);
    bore.nonlinearity = 0.0;
    bore.set_tuning(reference[3].freq);
    let n = 1 << 18;
    let mut p = vec![0.0f32; n];
    for (i, slot) in p.iter_mut().enumerate() {
        let u = if i == 0 { 1.0e-6 } else { 0.0 };
        let inc = bore.incoming();
        *slot = 2.0 * inc + bore.z_in() * u;
        bore.step(inc + bore.z_in() * u);
    }
    let mut planner = realfft::RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let mut spec = fft.make_output_vec();
    fft.process(&mut p, &mut spec).unwrap();
    let bin = sr / n as f32;
    let m: Vec<f32> = spec.iter().map(|c| c.norm().ln()).collect();
    let mut found = Vec::new();
    for i in (25.0 / bin) as usize..(700.0 / bin) as usize {
        if m[i] > m[i - 1] && m[i] >= m[i + 1] {
            let d = 0.5 * (m[i - 1] - m[i + 1]) / (m[i - 1] - 2.0 * m[i] + m[i + 1]);
            found.push((i as f32 + d) * bin);
        }
    }
    for n in 2..=8 {
        let c = cents(found[n - 1], reference[n - 1].freq);
        assert!(c.abs() < 12.0, "peak {n}: waveguide {:.2} Hz, reference {:.2} Hz ({c:+.1} cents)", found[n - 1], reference[n - 1].freq);
    }
}

// ---------------------------------------------------------------- the lips

/// Mouth pressure at which lips set for partial `n` (by the player's own laws) start to sound.
fn threshold(n: usize) -> f32 {
    let b = BoreProfile::tenor_trombone();
    let peak = Reference::new(&b, 20.0, 700.0, 0.5).peaks(0.0)[n - 1].freq;
    let mut pm = 150.0f32;
    while pm < 20000.0 {
        let sr = SR * 2.0;
        let mut bore = AirBore::new(&b, sr);
        bore.set_tuning(peak);
        let mut lips = Lips::new(LipSpec { mu: lip_mass(peak), ..LipSpec::trombone() });
        lips.freq = lip_center(peak, pm);
        let len = (0.4 * sr) as usize;
        let mut mp = Vec::with_capacity(len);
        for i in 0..len {
            let ramp = (i as f32 / (0.005 * sr)).min(1.0);
            let inc = bore.incoming();
            let inj = lips.tick(pm * ramp, inc, bore.z_in(), 1.0 / sr, ramp);
            bore.step(inj);
            mp.push(lips.pressure);
        }
        let seg = &mp[len * 3 / 4..];
        let mean = seg.iter().sum::<f32>() / seg.len() as f32;
        let ac: Vec<f32> = seg.iter().map(|x| x - mean).collect();
        // Sounding, and on the partial the lips were set for (about +50..+120 cents above it).
        if rms(&ac) > 0.1 * pm && cents(pitch(&ac, sr, peak * 1.05), peak * 1.05).abs() < 80.0 {
            return pm;
        }
        pm *= 1.25;
    }
    f32::INFINITY
}

#[test]
fn there_is_a_threshold_of_breath_and_the_top_of_the_range_needs_more() {
    // Below a certain mouth pressure the lips don't oscillate at all; above it the note sounds.
    // Through the middle of the range the threshold is a few hundred pascals (the player's lip mass
    // law keeps the lips' stiffness about constant, so it hardly changes); at the top, where the
    // resonances weaken, it climbs.
    for n in [2, 4, 8] {
        let t = threshold(n);
        assert!(t > 150.0 && t < 600.0, "partial {n} started at {t:.0} Pa");
    }
    let (mid, top) = (threshold(4), threshold(12));
    assert!(top > 2.0 * mid, "partial 12 should need clearly more breath than partial 4: {top:.0} vs {mid:.0} Pa");
}

// ---------------------------------------------------------------- the player

#[test]
fn notes_are_in_tune_across_the_trombone_at_every_dynamic() {
    let notes = [116.54f32, 146.83, 174.61, 196.0, 233.08, 261.63, 293.66, 349.23, 392.0, 466.16, 523.25];
    for &(breath, tol) in &[(0.15f32, 6.0f32), (0.5, 6.0), (0.9, 16.0)] {
        for &f in &notes {
            let (x, r) = hold(BrassParams { breath, ..note(f) }, 0.8);
            let f0 = pitch(settled(&x), SR, f);
            let c = cents(f0, f);
            assert!(c.abs() < tol, "{f} Hz at breath {breath}: {f0:.2} Hz ({c:+.1} cents), partial {} position {:.2}", r.partial, r.position);
        }
    }
}

#[test]
fn the_player_chooses_the_positions_a_trombonist_would() {
    // (frequency, partial, lowest and highest acceptable position). Positions are numbered in
    // semitones down from first, as trombonists count them.
    let cases = [(116.54f32, 2, 1.0f32, 1.6f32), (174.61, 3, 1.0, 1.6), (233.08, 4, 1.0, 1.6), (293.66, 5, 1.0, 1.6), (349.23, 6, 1.0, 1.6), (196.0, 4, 3.5, 4.5), (130.81, 3, 5.5, 6.5), (164.81, 3, 1.6, 2.5)];
    for &(f, partial, lo, hi) in &cases {
        let (_, r) = hold(note(f), 0.5);
        assert_eq!(r.partial, partial, "{f} Hz");
        assert!((lo..=hi).contains(&r.position), "{f} Hz on partial {partial} was played in position {:.2}", r.position);
    }
}

/// Seconds for a held note to reach `frac` of its settled level.
fn time_to(x: &[f32], frac: f32) -> f32 {
    let full = rms(settled(x));
    let block = (0.005 * SR) as usize;
    x.chunks(block).position(|c| rms(c) > frac * full).expect("the note should speak") as f32 * 0.005
}

#[test]
fn a_skilled_player_speaks_at_once_and_an_unskilled_one_blooms() {
    // A clean "ta" from a player who hears the note first: the lips start buzzing at its pitch and
    // the note is at full level within a few round trips of the 2.8 m tube (~16 ms each). Left to
    // start from rest at their own resonance, the lips take several times longer while the air
    // column pulls them round to the note.
    for &f in &[116.54f32, 174.61, 233.08, 349.23, 466.16] {
        let (x, _) = hold(note(f), 0.6);
        let (t50, t90) = (time_to(&x, 0.5), time_to(&x, 0.9));
        assert!(t50 < 0.04 && t90 < 0.08, "{f} Hz took {t50:.3} s to half level, {t90:.3} s to 90%");
    }
    let (skilled, _) = hold(note(233.08), 0.6);
    // (A take whose miss lands inside the slot, so it doesn't crack: only the start differs.)
    let (unskilled, _) = hold(BrassParams { attack_skill: 0.0, ..note(233.08) }, 0.6);
    let (a, b) = (time_to(&skilled, 0.5), time_to(&unskilled, 0.5));
    assert!(b > 2.5 * a, "unskilled start {b:.3} s vs skilled {a:.3} s");
}

#[test]
fn loose_lips_fall_to_the_partial_below_and_pinched_lips_pop_up() {
    let f = 233.08;
    let (x, _) = hold(BrassParams { lip_tension: -0.6, ..note(f) }, 0.6);
    let low = pitch(settled(&x), SR, 175.0);
    assert!((cents(low, 175.0)).abs() < 100.0, "loose lips on B♭3 should drop to the F below, got {low:.1} Hz");
    let (x, _) = hold(BrassParams { lip_tension: 1.0, ..note(f) }, 0.6);
    let high = pitch(settled(&x), SR, 292.0);
    assert!((cents(high, 292.0)).abs() < 100.0, "pinched lips on B♭3 should pop up to the D above, got {high:.1} Hz");
}

#[test]
fn an_unskilled_attack_cracks_high_notes_and_a_skilled_one_does_not() {
    // With attack skill 1 the lips are set in the slot. At 0 the setting misses by up to ~12%: the
    // note starts well off pitch - and on the high partials, where slots are narrow, some takes
    // start pulled toward the neighbouring partial (a cracked entrance) before the player finds
    // the note.
    for &f in &[466.16f32, 587.33] {
        let mut worst = 0.0f32;
        for take in 0..3 {
            for &(skill, cracked) in &[(1.0f32, false), (0.0, true)] {
                let p = BrassParams { attack_skill: skill, ..note(f) };
                let mut e = Engine::new(SR, &p);
                // Earlier takes move the player's (deterministic) randomness on.
                for _ in 0..take {
                    e.note_on(9, p, false, None);
                    for _ in 0..30000 {
                        e.next_frame();
                    }
                }
                e.note_on(1, p, true, None);
                let x: Vec<f32> = (0..(0.1 * SR) as usize).map(|_| e.next_frame()[0]).collect();
                let early = pitch(&x[(0.03 * SR) as usize..], SR, f);
                let c = cents(early, f).abs();
                if cracked {
                    assert!(c > 60.0, "{f} Hz take {take}: an unskilled attack started only {c:.0} cents off");
                    worst = worst.max(c);
                } else {
                    assert!(c < 20.0, "{f} Hz take {take}: a skilled attack started {c:.0} cents off");
                }
            }
        }
        assert!(worst > 80.0, "{f} Hz: no unskilled take strayed far (worst {worst:.0} cents)");
    }
}

#[test]
fn a_glissando_passes_through_the_pitches_between() {
    // B♭3 to G3 on one partial with no tongue: the slide's travel is heard.
    let first = BrassParams { duration: 0.5, ..note(233.08) };
    let second = BrassParams { duration: 0.7, articulation: Articulation::Glissando, slide_time: 0.3, ..note(196.0) };
    let x = render_phrase(&[PerformedNote { start: 0.0, params: first }, PerformedNote { start: 0.45, params: second }], SR, 0.1);
    let at = |t: f32| pitch(&x[(t * SR) as usize..((t + 0.03) * SR) as usize], SR, 215.0);
    let (a, mid, b) = (at(0.35), at(0.5), at(1.05));
    assert!(cents(a, 233.08).abs() < 15.0 && cents(b, 196.0).abs() < 15.0, "{a} -> {b}");
    assert!(mid < a * 0.985 && mid > b * 1.015, "halfway through the glide the pitch should be between: {a:.1}, {mid:.1}, {b:.1}");
}

// ---------------------------------------------------------------- dynamics and brassiness

#[test]
fn louder_is_brighter_and_past_mezzo_the_bore_makes_it_brassy() {
    // More breath gives a louder, brighter note. Most of the brightness at the top comes from the
    // bore, not the lips: with the air's nonlinearity switched off the same breath is far duller.
    // That is the steepening wavefront - brassiness.
    let f = 233.08;
    let (mf, _) = hold(BrassParams { breath: 0.5, ..note(f) }, 0.8);
    let (ff, _) = hold(BrassParams { breath: 0.9, ..note(f) }, 0.8);
    let (ff_linear, _) = hold(BrassParams { breath: 0.9, brassiness: 0.0, ..note(f) }, 0.8);
    let (mf, ff, ff_linear) = (settled(&mf), settled(&ff), settled(&ff_linear));
    assert!(20.0 * (rms(ff) / rms(mf)).log10() > 12.0, "ff should be much louder than mf");
    let (c_mf, c_ff, c_lin) = (centroid(mf), centroid(ff), centroid(ff_linear));
    assert!(c_ff > 2.0 * c_mf, "ff centroid {c_ff:.0} Hz vs mf {c_mf:.0} Hz");
    assert!(c_ff > 1.5 * c_lin, "brassiness: centroid {c_ff:.0} Hz with it, {c_lin:.0} Hz without");
    let (h_brassy, h_linear) = (harmonic_db(ff, f, 10), harmonic_db(ff_linear, f, 10));
    assert!(h_brassy - h_linear > 15.0, "the 10th harmonic at ff: {h_brassy:.1} dB brassy vs {h_linear:.1} dB linear");
}

#[test]
fn the_wavefront_steepens_as_the_breath_rises() {
    let steep = |breath: f32| hold(BrassParams { breath, ..note(233.08) }, 0.6).1.wave_steepness;
    let (mf, ff) = (steep(0.5), steep(0.9));
    assert!(ff > 8.0 * mf, "wavefront slope at the bell: mf {mf:.3e} Pa/s, ff {ff:.3e} Pa/s");
}

#[test]
fn slide_vibrato_moves_the_pitch_by_the_depth_asked() {
    let p = BrassParams { vibrato_depth: 25.0, vibrato_rate: 5.0, vibrato_delay: 0.0, ..note(233.08) };
    let (x, _) = hold(p, 1.2);
    let win = (0.02 * SR) as usize;
    let track: Vec<f32> = x[(0.5 * SR) as usize..].chunks(win).filter(|c| c.len() == win).map(|c| cents(pitch(c, SR, 233.08), 233.08)).collect();
    let (lo, hi) = track.iter().fold((f32::MAX, f32::MIN), |(a, b), v| (a.min(*v), b.max(*v)));
    assert!(hi - lo > 25.0 && hi - lo < 80.0, "vibrato swing {lo:+.1}..{hi:+.1} cents");
}

// ---------------------------------------------------------------- safety

#[test]
fn impossible_settings_stay_bounded() {
    for &(breath, brassiness, tension) in &[(1.0f32, 4.0f32, 1.0f32), (1.0, 4.0, -1.0), (1.0, 0.0, 0.0), (0.0, 2.0, 0.0)] {
        let p = BrassParams { breath, velocity: 1.0, brassiness, lip_tension: tension, aperture: 1.0, breath_noise: 1.0, ..note(116.54) };
        let (x, _) = hold(p, 0.6);
        assert!(x.iter().all(|v| v.is_finite() && v.abs() <= 4.0), "breath {breath}, brassiness {brassiness}, tension {tension}");
    }
}

#[test]
fn a_released_note_falls_silent() {
    let (x, _) = render_note(&BrassParams { duration: 0.3, ..note(233.08) }, SR, 0.8);
    let tail = &x[(0.6 * SR) as usize..];
    assert!(rms(tail) < 1.0e-3 * rms(&x[(0.1 * SR) as usize..(0.3 * SR) as usize]), "the tail should die away");
}

// ---------------------------------------------------------------- listening

/// Renders a few phrases to `test-artifacts/brass/` for listening (the tests above are the
/// claims; these are for ears). `cargo test --release --lib brass::tests::listening -- --ignored`
#[test]
#[ignore]
fn listening_examples() {
    let dir = std::path::Path::new("test-artifacts/brass");
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
    let at = |start: f32, dur: f32, freq: f32, p: BrassParams| PerformedNote { start, params: BrassParams { freq, duration: dur, ..p } };
    let base = BrassParams::default();
    // A B♭ major scale, mezzo, tongued.
    let scale = [116.54f32, 130.81, 146.83, 155.56, 174.61, 196.0, 220.0, 233.08];
    let notes: Vec<PerformedNote> = scale.iter().enumerate().map(|(i, &f)| at(i as f32 * 0.45, 0.4, f, base)).collect();
    write("scale_mf.wav", &render_phrase(&notes, SR, 0.4));
    // The same note from pp to fff: brassiness arriving.
    let swell: Vec<PerformedNote> = [0.1f32, 0.3, 0.5, 0.7, 0.85, 1.0].iter().enumerate().map(|(i, &b)| at(i as f32 * 0.9, 0.8, 233.08, BrassParams { breath: b, ..base })).collect();
    write("dynamics_pp_to_fff.wav", &render_phrase(&swell, SR, 0.4));
    // A fanfare figure, loud.
    let loud = BrassParams { breath: 0.85, vibrato_depth: 0.0, ..base };
    let fanfare = [(0.0, 0.18, 174.61f32), (0.2, 0.18, 174.61), (0.4, 0.18, 174.61), (0.6, 0.9, 233.08), (1.6, 0.25, 174.61), (1.9, 1.2, 349.23)];
    let notes: Vec<PerformedNote> = fanfare.iter().map(|&(t, d, f)| at(t, d, f, loud)).collect();
    write("fanfare_ff.wav", &render_phrase(&notes, SR, 0.5));
    // A glissando up a fourth and back (B♭2 slide: F2 to B♭2 on one partial).
    let g = BrassParams { articulation: Articulation::Glissando, slide_time: 0.6, breath: 0.7, ..base };
    let notes = [at(0.0, 0.8, 116.54, BrassParams { breath: 0.7, ..base }), at(0.7, 1.4, 87.31, g), at(2.0, 1.2, 116.54, g)];
    write("glissando.wav", &render_phrase(&notes, SR, 0.4));
    // A long note with slide vibrato.
    write("vibrato.wav", &render_note(&BrassParams { vibrato_depth: 18.0, vibrato_delay: 0.4, breath: 0.6, duration: 2.5, ..note(349.23) }, SR, 3.0).0);
}

// ---------------------------------------------------------------- the live runtime

/// Pulls `secs` of interleaved stereo from a source, returning the left channel.
fn pull(src: &mut impl Iterator<Item = f32>, secs: f32) -> Vec<f32> {
    let n = (secs * SR) as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let l = src.next().unwrap_or(0.0);
        let _ = src.next();
        out.push(l);
    }
    out
}

#[test]
fn a_live_player_slurs_between_notes_and_publishes_what_the_view_draws() {
    let shared = Arc::new(BrassShared::default());
    let base = note(233.08);
    let (mut voice, handle) = BrassInstrumentVoice::new(shared.clone(), &base);
    handle.send(BrassCommand::NoteOn { id: 1, params: base, gated: true, live: None }).ok().unwrap();
    let a = pull(&mut voice, 0.5);
    let s = shared.state();
    assert!(s.playing && s.partial == 4, "{s:?}");
    assert!((cents(pitch(settled(&a), SR, 233.08), 233.08)).abs() < 6.0);
    // The pressure along the bore, one period of the mouthpiece and the lips, and the ladder.
    let bore_peak = (0..BORE_POINTS).map(|i| shared.bore_pressure(i).abs()).fold(0.0f32, f32::max);
    assert!(bore_peak > 100.0, "the bore's pressure profile should be published ({bore_peak} Pa)");
    let (lo, hi) = (0..TRACE_POINTS).map(|i| shared.trace(i).0).fold((f32::MAX, f32::MIN), |(a, b), v| (a.min(v), b.max(v)));
    assert!(hi - lo > 500.0, "a period of mouthpiece pressure should be published ({lo}..{hi})");
    assert!((0..TRACE_POINTS).any(|i| shared.trace(i).1 > 1.0e-4), "the lips' opening should be published");
    let (r2, r4) = (shared.resonance(2).0, shared.resonance(4).0);
    assert!((r4 / r2 - 2.0).abs() < 0.05, "the ladder: resonance 4 at {r4} Hz, 2 at {r2} Hz");
    // A second note while the first is held: slurred on the same player, no gap.
    handle.send(BrassCommand::NoteOn { id: 2, params: BrassParams { articulation: Articulation::Legato, ..note(174.61) }, gated: true, live: None }).ok().unwrap();
    handle.send(BrassCommand::NoteOff { id: 1 }).ok().unwrap();
    let b = pull(&mut voice, 0.6);
    assert!((cents(pitch(settled(&b), SR, 174.61), 174.61)).abs() < 8.0);
    let gap = b.chunks((0.01 * SR) as usize).take(20).map(rms).fold(f32::MAX, f32::min);
    assert!(gap > 0.1 * rms(settled(&a)), "a slur shouldn't stop the sound (quietest 10 ms: {gap})");
    assert_eq!(shared.state().partial, 3);
    handle.send(BrassCommand::NoteOff { id: 2 }).ok().unwrap();
    let _ = pull(&mut voice, 0.5);
    assert!(!shared.state().playing);
}

#[test]
fn live_breath_and_bend_steer_a_held_note() {
    let shared = Arc::new(BrassShared::default());
    let p = BrassParams { breath: 0.3, ..note(233.08) };
    let live = Arc::new(BrassLive::from_params(&p));
    let mut voice = BrassVoice::new(shared.clone(), p, Some(Arc::new(std::sync::atomic::AtomicBool::new(true)))).with_live(live.clone());
    let soft = pull(&mut voice, 0.6);
    let pm_soft = shared.state().mouth_pressure;
    live.set("breath", 0.85);
    let loud = pull(&mut voice, 0.6);
    let pm_loud = shared.state().mouth_pressure;
    assert!(pm_loud > 3.0 * pm_soft, "mouth pressure {pm_soft:.0} -> {pm_loud:.0} Pa");
    assert!(rms(settled(&loud)) > 3.0 * rms(settled(&soft)));
    assert!(centroid(settled(&loud)) > 1.5 * centroid(settled(&soft)));
    // A bend of +150 cents moves the slide in, and the ear follows the bent pitch.
    let before = shared.state().extension;
    live.set("bend", -150.0);
    let bent = pull(&mut voice, 0.6);
    let f = pitch(settled(&bent), SR, 233.08);
    assert!((cents(f, 233.08) + 150.0).abs() < 10.0, "bent down 150 cents: {:+.1}", cents(f, 233.08));
    assert!(shared.state().extension > before + 0.1, "the slide should have moved out");
}


// ---------------------------------------------------------------- the family

/// Cents between reference peak `n` of `b` and the `n`th harmonic of its nominal fundamental.
fn peak_cents(b: &BoreProfile, hi: usize) -> Vec<f32> {
    let f1 = b.nominal_fundamental;
    let peaks = Reference::new(b, 0.4 * f1, f1 * (hi as f32 + 1.5), (f1 / 100.0).min(0.5)).peaks(0.0);
    (1..=hi).map(|n| cents(peaks[n - 1].freq, f1 * n as f32)).collect()
}

#[test]
fn trumpet_horn_and_tuba_bores_line_up_like_real_ones() {
    let t = peak_cents(&BoreProfile::trumpet(), 10);
    assert!(t[1..].iter().all(|c| c.abs() < 25.0), "trumpet peaks 2-10: {t:?}");
    let h = peak_cents(&BoreProfile::horn(), 12);
    assert!(h[1..].iter().all(|c| c.abs() < 12.0), "horn (B♭ side) peaks 2-12: {h:?}");
    // A tuba is conical: even its first resonance is close to the series (playable), unlike a
    // trombone's or a trumpet's.
    let u = peak_cents(&BoreProfile::tuba(), 8);
    assert!(u[1..].iter().all(|c| c.abs() < 12.0) && u[0].abs() < 30.0, "tuba peaks 1-8: {u:?}");
    assert!(t[0] < -300.0, "a trumpet's first resonance is far below the series: {}", t[0]);
}

#[test]
fn valve_combinations_add_their_tubes_and_come_out_sharp() {
    let open = 1.4f32;
    let combos = engine::valve_combos(BrassInstrument::Trumpet.mechanism(), open);
    let tube = |mask: u32| combos.iter().find(|c| c.0 == mask).unwrap().1;
    assert_eq!(combos.len(), 8);
    // 1 + 3 is five semitones' worth of valves, but each tube was cut for the open horn, so the
    // combination is short of the 5-semitone tube: sharp, as real valves are.
    let five = open * (2f32.powf(5.0 / 12.0) - 1.0);
    let both = tube(0b101);
    assert!((both - (tube(0b001) + tube(0b100))).abs() < 1.0e-6);
    let sharp = 1200.0 * ((open + five) / (open + both)).log2();
    assert!((15.0..40.0).contains(&sharp), "1+3 is {sharp:.1} cents sharp");
    // A double horn has the F side: another fourth of tube, with its own longer valves.
    let horn = engine::valve_combos(BrassInstrument::Horn.mechanism(), 2.8);
    assert_eq!(horn.len(), 16);
    let f = horn.iter().find(|c| c.0 == F_SIDE).unwrap().1;
    assert!((1200.0 * ((2.8 + f) / 2.8).log2() - 500.0).abs() < 1.0);
}

#[test]
fn the_family_plays_its_range_in_tune_with_standard_fingerings() {
    let cases: [(BrassInstrument, &[(f32, usize, u32)]); 3] = [
        // (note, partial, valves): B♭4 open 4th partial, F4 open 3rd, C4 1+3 on the 3rd, B♭3 open 2nd.
        (BrassInstrument::Trumpet, &[(466.16, 4, 0), (349.23, 3, 0), (261.63, 3, 0b101), (233.08, 2, 0)]),
        // B♭ side above, F side below: A4 on B♭ with 2, F3 on the F side open (4th partial).
        (BrassInstrument::Horn, &[(440.0, 8, 0b010), (174.61, 4, F_SIDE)]),
        // B♭1 open 2nd, F2 open 3rd, B♭2 open 4th.
        (BrassInstrument::Tuba, &[(58.27, 2, 0), (87.31, 3, 0), (116.54, 4, 0)]),
    ];
    for (instrument, notes) in cases {
        let e = Engine::new(SR, &BrassParams { instrument, ..Default::default() });
        for &(f, partial, valves) in notes {
            let p = BrassParams { instrument, ..note(f) };
            let fing = e.choose_fingering(f, p.mouth_pressure());
            assert_eq!((fing.partial, fing.valves), (partial, valves), "{instrument:?} {f} Hz");
        }
    }
    let ranges: [(BrassInstrument, &[f32]); 3] = [
        (BrassInstrument::Trumpet, &[164.81, 207.65, 293.66, 392.0, 523.25, 659.26, 830.61]),
        (BrassInstrument::Horn, &[110.0, 155.56, 220.0, 311.13, 440.0, 554.37, 698.46]),
        (BrassInstrument::Tuba, &[41.2, 51.91, 73.42, 103.83, 146.83, 207.65]),
    ];
    for (instrument, notes) in ranges {
        for &f in notes {
            let (x, r) = hold(BrassParams { instrument, ..note(f) }, 0.8);
            let c = cents(pitch(settled(&x), SR, f), f);
            let tol = if instrument == BrassInstrument::Tuba && f < 60.0 { 20.0 } else { 8.0 };
            assert!(c.abs() < tol, "{instrument:?} {f} Hz: {c:+.1} cents (partial {})", r.partial);
        }
    }
}

#[test]
fn stopping_the_horn_puts_a_resonance_a_semitone_above_each_upper_one() {
    // The horn player's hand closing the bell's throat: every upper resonance (partials 9-16) gets
    // a stopped neighbour about a semitone above it - why a stopped note, lipped the same, comes out
    // a semitone high. Measured on the reference, the hand being part of the bore.
    let base = BrassInstrument::Horn.profile();
    let f1 = base.nominal_fundamental;
    let bore = |hand: f32| base.obstructed(engine::obstruction(Mute::Open, hand, base.mouth_radius()));
    let open = Reference::new(&bore(0.35), 20.0, f1 * 18.0, 0.5).peaks(0.0);
    let stopped = Reference::new(&bore(1.0), 20.0, f1 * 18.0, 0.5).peaks(0.0);
    for n in 9..=16 {
        let f = open[n - 1].freq;
        let above = stopped.iter().map(|p| p.freq).filter(|&x| x > f * 1.001).fold(f32::MAX, f32::min);
        let c = cents(above, f);
        assert!((80.0..170.0).contains(&c), "open resonance {n} at {f:.1} Hz: stopped neighbour {c:+.0} cents above");
    }
}

#[test]
fn a_stopped_horn_is_played_in_tune_and_sounds_brassier() {
    // The player knows the stopped horn (its own resonances) and plays it in tune; the tone gets the
    // metallic edge stopped horn is known for, and quieter.
    let f = 440.0;
    let (open, _) = hold(BrassParams { instrument: BrassInstrument::Horn, breath: 0.6, ..note(f) }, 0.8);
    let (stopped, _) = hold(BrassParams { instrument: BrassInstrument::Horn, breath: 0.6, hand: Some(1.0), ..note(f) }, 0.8);
    let (open, stopped) = (settled(&open), settled(&stopped));
    assert!(cents(pitch(stopped, SR, f), f).abs() < 10.0);
    assert!(centroid(stopped) > 1.3 * centroid(open), "stopped {:.0} Hz vs open {:.0} Hz", centroid(stopped), centroid(open));
    assert!(20.0 * (rms(stopped) / rms(open)).log10() < -6.0);
}

#[test]
fn mutes_quieten_and_colour_the_note_and_it_stays_in_tune() {
    let play = |mute: Mute| {
        let (x, _) = hold(BrassParams { mute, ..note(233.08) }, 0.8);
        let seg = settled(&x).to_vec();
        (cents(pitch(&seg, SR, 233.08), 233.08), 20.0 * rms(&seg).log10(), centroid(&seg))
    };
    let (c0, db0, br0) = play(Mute::Open);
    let (cs, dbs, brs) = play(Mute::Straight);
    let (cc, dbc, brc) = play(Mute::Cup);
    let (ch, dbh, brh) = play(Mute::Harmon);
    for c in [c0, cs, cc, ch] {
        assert!(c.abs() < 8.0, "a muted trombone should still be played in tune ({c:+.1})");
    }
    assert!(dbs < db0 - 5.0 && brs > br0, "straight: quieter and thinner ({dbs:.1} vs {db0:.1} dB, {brs:.0} vs {br0:.0} Hz)");
    assert!(dbc < db0 - 5.0 && brc < br0, "cup: quieter and darker ({dbc:.1} dB, {brc:.0} Hz)");
    assert!(dbh < db0 - 12.0 && brh > brs, "harmon: much quieter, and the buzziest ({dbh:.1} dB, {brh:.0} Hz)");
}

#[test]
fn a_bell_pointed_at_the_listener_is_brighter_than_one_pointed_away() {
    let play = |facing: f32| {
        let (x, _) = hold(BrassParams { bell_facing: Some(facing), breath: 0.7, ..note(233.08) }, 0.8);
        let seg = settled(&x).to_vec();
        (rms(&seg), centroid(&seg))
    };
    let (away_level, away) = play(0.0);
    let (side_level, side) = play(0.5);
    let (toward_level, toward) = play(1.0);
    assert!(away < side && side < toward, "centroid away {away:.0} / sideways {side:.0} / toward {toward:.0} Hz");
    assert!(toward > 1.8 * away);
    assert!(toward_level > side_level && side_level > away_level);
}

#[test]
fn valves_slur_without_the_tongue() {
    // A trumpet slurring B♭4 to C5 (open to 1+3... on another partial): no gap in the sound.
    let first = BrassParams { instrument: BrassInstrument::Trumpet, duration: 0.5, ..note(466.16) };
    let second = BrassParams { instrument: BrassInstrument::Trumpet, duration: 0.5, articulation: Articulation::Legato, ..note(415.3) };
    let x = render_phrase(&[PerformedNote { start: 0.0, params: first }, PerformedNote { start: 0.45, params: second }], SR, 0.1);
    let steady = rms(&x[(0.3 * SR) as usize..(0.44 * SR) as usize]);
    let quietest = x[(0.44 * SR) as usize..(0.6 * SR) as usize].chunks((0.005 * SR) as usize).map(rms).fold(f32::MAX, f32::min);
    assert!(quietest > 0.2 * steady, "the slur dipped to {quietest} from {steady}");
    assert!(cents(pitch(&x[(0.7 * SR) as usize..(0.9 * SR) as usize], SR, 415.3), 415.3).abs() < 10.0);
}

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
fn a_silent_player_sleeps_and_wakes_on_the_next_note() {
    let shared = Arc::new(BrassShared::default());
    let p = BrassParams { duration: 0.2, ..note(233.08) };
    let (mut voice, handle) = BrassInstrumentVoice::new(shared, &p);
    assert!(handle.is_ready());
    handle.send(BrassCommand::NoteOn { id: 1, params: p, gated: false, live: None }).ok().unwrap();
    let _ = pull(&mut voice, 1.5);
    let t = std::time::Instant::now();
    let rest = pull(&mut voice, 10.0);
    let cost = t.elapsed().as_secs_f32() / 10.0;
    assert!(rest.iter().all(|v| *v == 0.0), "asleep is silent");
    assert!(cost < 0.01, "asleep should cost well under 1% of a core, took {:.2}%", cost * 100.0);
    assert!(handle.is_alive(), "a rest does not lose the player");
    handle.send(BrassCommand::NoteOn { id: 2, params: p, gated: false, live: None }).ok().unwrap();
    assert!(rms(&pull(&mut voice, 0.15)) > 0.0, "the next note wakes it");
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

// ---------------------------------------------------------------- reports (ignored)
//
// These print the numbers, and write the pictures, that the Indie Machine brass post quotes. They
// assert almost nothing. Run one with
//   cargo test --release --lib brass::tests::brass_bore_report -- --ignored --nocapture
// (names: brass_bore_report, brass_lips_report, brass_player_report, brass_brassiness_report,
// brass_family_report, brass_cost_report). Pictures land in `test-artifacts/brass-report/`.

fn profile() -> &'static str {
    if cfg!(debug_assertions) { "debug" } else { "release" }
}

fn art_dir() -> std::path::PathBuf {
    let d = std::env::current_dir().unwrap().join("test-artifacts").join("brass-report");
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn midi_hz(m: i32) -> f32 {
    440.0 * 2f32.powf((m as f32 - 69.0) / 12.0)
}

fn note_name(m: i32) -> String {
    const N: [&str; 12] = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
    format!("{}{}", N[(m.rem_euclid(12)) as usize], m / 12 - 1)
}

fn svg_start(w: f32, h: f32) -> String {
    format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" font-family=\"sans-serif\"><rect width=\"100%\" height=\"100%\" fill=\"#f7f6f2\"/>")
}

fn svg_save(mut svg: String, name: &str) {
    svg.push_str("</svg>");
    let path = art_dir().join(name);
    std::fs::write(&path, svg).unwrap();
    println!("wrote {}", path.display());
}

fn svg_text(svg: &mut String, x: f32, y: f32, size: f32, anchor: &str, fill: &str, bold: bool, s: &str) {
    svg.push_str(&format!("<text x=\"{x:.1}\" y=\"{y:.1}\" font-size=\"{size}\" fill=\"{fill}\" text-anchor=\"{anchor}\"{}>{s}</text>", if bold { " font-weight=\"bold\"" } else { "" }));
}

/// A rectangular plot area with a data-to-pixel mapping.
struct Axes {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    xr: (f32, f32),
    yr: (f32, f32),
}

impl Axes {
    fn px(&self, v: f32) -> f32 {
        self.x + (v - self.xr.0) / (self.xr.1 - self.xr.0) * self.w
    }
    fn py(&self, v: f32) -> f32 {
        self.y + self.h - (v - self.yr.0) / (self.yr.1 - self.yr.0) * self.h
    }
    fn frame(&self, svg: &mut String, title: &str, xlabel: &str, ylabel: &str, xt: &[(f32, String)], yt: &[(f32, String)]) {
        svg.push_str(&format!("<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#ffffff\" stroke=\"#c9c4b8\"/>", self.x, self.y, self.w, self.h));
        for (v, l) in xt {
            let x = self.px(*v);
            svg.push_str(&format!("<line x1=\"{x:.1}\" y1=\"{}\" x2=\"{x:.1}\" y2=\"{}\" stroke=\"#ece8de\"/>", self.y, self.y + self.h));
            svg_text(svg, x, self.y + self.h + 13.0, 10.0, "middle", "#55524a", false, l);
        }
        for (v, l) in yt {
            let y = self.py(*v);
            svg.push_str(&format!("<line x1=\"{}\" y1=\"{y:.1}\" x2=\"{}\" y2=\"{y:.1}\" stroke=\"#ece8de\"/>", self.x, self.x + self.w));
            svg_text(svg, self.x - 4.0, y + 3.0, 10.0, "end", "#55524a", false, l);
        }
        svg_text(svg, self.x, self.y - 8.0, 13.0, "start", "#2a2925", true, title);
        svg_text(svg, self.x + self.w * 0.5, self.y + self.h + 28.0, 11.0, "middle", "#55524a", false, xlabel);
        svg.push_str(&format!("<text transform=\"translate({},{}) rotate(-90)\" font-size=\"11\" fill=\"#55524a\" text-anchor=\"middle\">{ylabel}</text>", self.x - 40.0, self.y + self.h * 0.5));
    }
    fn line(&self, svg: &mut String, pts: &[(f32, f32)], color: &str, width: f32, dash: &str) {
        let p: Vec<String> = pts.iter().map(|&(x, y)| format!("{:.1},{:.1}", self.px(x).clamp(self.x, self.x + self.w), self.py(y).clamp(self.y, self.y + self.h))).collect();
        svg.push_str(&format!("<polyline points=\"{}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"{width}\" stroke-dasharray=\"{dash}\"/>", p.join(" ")));
    }
    fn vline(&self, svg: &mut String, x: f32, color: &str, dash: &str) {
        let x = self.px(x);
        if x >= self.x && x <= self.x + self.w {
            svg.push_str(&format!("<line x1=\"{x:.1}\" y1=\"{}\" x2=\"{x:.1}\" y2=\"{}\" stroke=\"{color}\" stroke-dasharray=\"{dash}\"/>", self.y, self.y + self.h));
        }
    }
    fn hline(&self, svg: &mut String, y: f32, color: &str, dash: &str) {
        let y = self.py(y);
        if y >= self.y && y <= self.y + self.h {
            svg.push_str(&format!("<line x1=\"{}\" y1=\"{y:.1}\" x2=\"{}\" y2=\"{y:.1}\" stroke=\"{color}\" stroke-dasharray=\"{dash}\"/>", self.x, self.x + self.w));
        }
    }
    fn dot(&self, svg: &mut String, x: f32, y: f32, r: f32, color: &str) {
        let (px, py) = (self.px(x), self.py(y));
        if px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h {
            svg.push_str(&format!("<circle cx=\"{px:.1}\" cy=\"{py:.1}\" r=\"{r}\" fill=\"{color}\"/>"));
        }
    }
}

fn ticks(from: f32, to: f32, step: f32, fmt: impl Fn(f32) -> String) -> Vec<(f32, String)> {
    let mut v = Vec::new();
    let mut t = from;
    while t <= to + 1.0e-4 {
        v.push((t, fmt(t)));
        t += step;
    }
    v
}

const BLUE: &str = "#1f5f8b";
const RED: &str = "#b5462d";
const BROWN: &str = "#7a4b1e";
const GREEN: &str = "#3f7d4a";
const GREY: &str = "#8a867a";

const FAMILY: [(&str, BrassInstrument); 4] = [("Tenor trombone", BrassInstrument::TenorTrombone), ("B-flat trumpet", BrassInstrument::Trumpet), ("Double horn (B-flat side)", BrassInstrument::Horn), ("F tuba", BrassInstrument::Tuba)];

/// Peaks of a magnitude spectrum between `lo` and `hi` Hz, refined by a parabola on the log: (Hz, magnitude).
fn spectrum_peaks(mags: &[f32], bin: f32, lo: f32, hi: f32) -> Vec<(f32, f32)> {
    let m: Vec<f32> = mags.iter().map(|v| v.max(1.0e-30).ln()).collect();
    let mut out = Vec::new();
    for i in (lo / bin).max(1.0) as usize..((hi / bin) as usize).min(m.len() - 2) {
        if m[i] > m[i - 1] && m[i] >= m[i + 1] {
            let d = 0.5 * (m[i - 1] - m[i + 1]) / (m[i - 1] - 2.0 * m[i] + m[i + 1]);
            out.push(((i as f32 + d) * bin, mags[i]));
        }
    }
    out
}

/// The runtime air column's input impedance, measured by a puff of flow at the lips: |Z| in Pa s/m^3.
fn waveguide_impedance(b: &BoreProfile, tune: f32) -> (Vec<f32>, f32) {
    let sr = SR * 2.0;
    let mut bore = AirBore::new(b, sr);
    bore.nonlinearity = 0.0;
    bore.set_tuning(tune);
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
    (spec.iter().map(|c| c.norm() / 1.0e-6).collect(), sr / n as f32)
}

#[test]
#[ignore]
fn brass_bore_report() {
    println!("profile: {}", profile());
    // The four bores, drawn to one length scale: radius against distance from the lips.
    let mut svg = svg_start(960.0, 4.0 * 150.0 + 40.0);
    for (k, (name, inst)) in FAMILY.iter().enumerate() {
        let b = inst.profile();
        let total = b.total_length(0.0);
        println!("{name}: front {:.3} m, cylinder {:.3} m, bell {:.3} m, total {:.3} m; slide or valves add up to {:.2} m; cylinder radius {:.2} mm, mouth diameter {:.0} mm, nominal fundamental {:.2} Hz", b.front_length(), b.cylinder_length, b.bell_length(), total, b.slide_max, b.cylinder_radius * 1000.0, b.mouth_radius() * 2000.0, b.nominal_fundamental);
        let ax = Axes { x: 50.0, y: 30.0 + k as f32 * 150.0, w: 880.0, h: 110.0, xr: (0.0, 5.8), yr: (-0.24, 0.24) };
        ax.frame(&mut svg, &format!("{name}: {:.2} m of air column, mouth {:.0} mm across", total, b.mouth_radius() * 2000.0), if k == 3 { "distance from the lips, metres (same scale in every panel)" } else { "" }, "radius, m", &ticks(0.0, 5.5, 0.5, |v| format!("{v}")), &[(-0.2, "-0.2".into()), (0.0, "0".into()), (0.2, "0.2".into())]);
        let runs = [(0.0, b.front_length(), RED), (b.front_length(), b.front_length() + b.cylinder_length, BLUE), (b.front_length() + b.cylinder_length, total, BROWN)];
        for (x0, x1, c) in runs {
            let n = 200;
            let top: Vec<(f32, f32)> = (0..=n).map(|i| { let x = x0 + (x1 - x0) * i as f32 / n as f32; (x, b.open_radius_at(x, 0.0)) }).collect();
            let bot: Vec<(f32, f32)> = top.iter().map(|&(x, r)| (x, -r)).collect();
            ax.line(&mut svg, &top, c, 1.8, "");
            ax.line(&mut svg, &bot, c, 1.8, "");
        }
    }
    svg_text(&mut svg, 50.0, 4.0 * 150.0 + 34.0, 11.0, "start", "#55524a", false, "red: mouthpiece and leadpipe (front). blue: the cylinder (slide or valve tubing). brown: bell taper and flare. Slide closed, no valves down.");
    svg_save(svg, "bores.svg");

    // The reference machinery on the one case with a closed form.
    let cyl = BoreProfile { front: vec![], cylinder_radius: 0.01, cylinder_length: 1.0, bell: vec![], slide_max: 0.0, nominal_fundamental: 0.0, obstruction: None };
    let peaks = Reference::new(&cyl, 20.0, 800.0, 0.25).peaks(0.0);
    let leff = 1.0 + super::impedance::END_CORRECTION * 0.01;
    for (n, p) in peaks.iter().take(4).enumerate() {
        let mut expect = (2 * n + 1) as f64 * super::impedance::C / (4.0 * leff);
        for _ in 0..3 {
            let v = std::f64::consts::TAU * expect / super::impedance::propagation(expect, 0.01).im;
            expect = (2 * n + 1) as f64 * v / (4.0 * leff);
        }
        println!("quarter-wave cylinder (1 m, 10 mm radius) peak {}: {:.2} Hz, closed form {:.2} Hz ({:+.2} cents)", n + 1, p.freq, expect, 1200.0 * (p.freq as f64 / expect).log2());
    }

    // Resonances against the harmonic series.
    for (name, inst, hi) in [(FAMILY[0].0, FAMILY[0].1, 10usize), (FAMILY[1].0, FAMILY[1].1, 10), (FAMILY[2].0, FAMILY[2].1, 12), (FAMILY[3].0, FAMILY[3].1, 8)] {
        let b = inst.profile();
        let f1 = b.nominal_fundamental;
        let peaks = Reference::new(&b, 0.4 * f1, f1 * (hi as f32 + 1.5), (f1 / 100.0).min(0.5)).peaks(0.0);
        let row: Vec<String> = (1..=hi).map(|n| format!("{n}: {:.1} Hz {:+.0}c", peaks[n - 1].freq, cents(peaks[n - 1].freq, f1 * n as f32))).collect();
        println!("{name} (series on {f1:.2} Hz), resonances against n x fundamental: {}  |  first resonance is {:.2} of the fundamental", row.join(", "), peaks[0].freq / f1);
    }

    // The slide.
    let b = BoreProfile::tenor_trombone();
    let r = Reference::new(&b, 20.0, 700.0, 0.5);
    let (closed, open) = (r.peaks(0.0), r.peaks(b.slide_max));
    let row: Vec<String> = (2..=10).map(|n| format!("{n}: {:.2}", -cents(open[n - 1].freq, closed[n - 1].freq) / 100.0)).collect();
    println!("trombone, seventh position lowers resonance n by (semitones): {}", row.join(", "));

    // The runtime waveguide against the reference, at two tunings.
    let ref_mag = r.magnitude(0.0);
    let reference = r.peaks(0.0);
    for (label, tune_partial) in [("tuned for partial 4", 3usize), ("tuned for partial 8", 7)] {
        let (wg, bin) = waveguide_impedance(&b, reference[tune_partial].freq);
        let found = spectrum_peaks(&wg, bin, 25.0, 700.0);
        let row: Vec<String> = (1..=12).filter(|&n| n <= found.len().min(reference.len())).map(|n| format!("{n}: {:+.1}c / {:+.1} dB", cents(found[n - 1].0, reference[n - 1].freq), 20.0 * (found[n - 1].1 / reference[n - 1].magnitude).log10())).collect();
        println!("runtime waveguide vs reference, {label} (peak n: cents / height ratio): {}", row.join(", "));
        if tune_partial == 3 {
            let low: Vec<String> = [20.0f32, 25.0, 30.0, 40.0].iter().map(|&f| {
                let i = ((f - 20.0) / 0.5) as usize;
                let w = wg[(f / bin) as usize];
                format!("{f} Hz: reference {:.2e}, waveguide {:.2e} (x{:.1})", ref_mag[i], w, w / ref_mag[i])
            }).collect();
            println!("low-frequency |Z| (Pa s/m^3): {}", low.join(" | "));
            let lowref = Reference::new(&b, 1.0, 30.0, 0.5);
            let lm = lowref.magnitude(0.0);
            let row: Vec<String> = [1.0f32, 2.0, 5.0, 10.0, 15.0].iter().map(|&f| {
                let i = ((f - 1.0) / 0.5) as usize;
                let w = wg[(f / bin).round() as usize];
                format!("{f} Hz: reference {:.2e}, waveguide {:.2e} (x{:.2})", lm[i], w, w / lm[i])
            }).collect();
            println!("very low |Z| (Pa s/m^3): {}", row.join(" | "));
            // The picture.
            let mut svg = svg_start(960.0, 360.0);
            let ax = Axes { x: 60.0, y: 40.0, w: 880.0, h: 250.0, xr: (20.0, 700.0), yr: (-22.0, 46.0) };
            ax.frame(&mut svg, "Tenor trombone, first position: input impedance at the lips", "frequency, Hz", "|Z| in dB re 1e6 Pa s/m^3", &ticks(100.0, 700.0, 100.0, |v| format!("{v}")), &ticks(-20.0, 40.0, 10.0, |v| format!("{v}")));
            for n in 1..=12 {
                ax.vline(&mut svg, b.nominal_fundamental * n as f32, "#d9d3c4", "3 3");
            }
            let refl: Vec<(f32, f32)> = r.freqs.iter().zip(ref_mag.iter()).map(|(&f, &m)| (f, 20.0 * (m / 1.0e6).log10())).collect();
            let wgl: Vec<(f32, f32)> = (0..wg.len()).map(|i| (i as f32 * bin, 20.0 * (wg[i] / 1.0e6).max(1.0e-9).log10())).filter(|p| p.0 >= 20.0 && p.0 <= 700.0).step_by(2).collect();
            ax.line(&mut svg, &wgl, RED, 1.2, "");
            ax.line(&mut svg, &refl, BLUE, 1.8, "");
            svg_text(&mut svg, 70.0, 316.0, 11.0, "start", BLUE, false, "blue: transfer-matrix reference (build time)");
            svg_text(&mut svg, 70.0, 332.0, 11.0, "start", RED, false, "red: the runtime waveguide, measured by a puff of flow at the lips");
            svg_text(&mut svg, 70.0, 348.0, 11.0, "start", GREY, false, "grey dashes: n x 58.27 Hz, the harmonic series of the nominal fundamental. Peak 1 sits well below its dash; 2 and up sit on theirs.");
            svg_save(svg, "impedance-trombone.svg");
        }
    }
}

// ----------------------------------------------------------------- lips

/// Runs the lips against a fixed air column from rest for `secs` and returns the AC part of the last
/// quarter of the mouthpiece pressure.
fn lip_trial(bore: &mut AirBore, mass: f32, pm: f32, lip_freq: f32, secs: f32) -> Vec<f32> {
    let sr = SR * 2.0;
    bore.clear();
    let mut lips = Lips::new(LipSpec { mu: mass, ..LipSpec::trombone() });
    lips.freq = lip_freq;
    let len = (secs * sr) as usize;
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
    seg.iter().map(|x| x - mean).collect()
}

/// Which resonance a sounding pitch belongs to (1-based), or 0 for silence, or 99 for none of them.
/// The one-mass lip sounds sharp of its resonance, so each is taken to be a few per cent higher.
fn classify(ac: &[f32], pm: f32, res: &[f32], expected: f32) -> (usize, f32) {
    if rms(ac) < 0.05 * pm {
        return (0, 0.0);
    }
    let f = pitch(ac, SR * 2.0, expected);
    let (k, c) = res.iter().enumerate().map(|(i, &r)| (i, cents(f, r * 1.03).abs())).fold((0, f32::MAX), |a, b| if b.1 < a.1 { b } else { a });
    if c < 130.0 { (k + 1, f) } else { (99, f) }
}

#[test]
#[ignore]
fn brass_lips_report() {
    println!("profile: {}", profile());
    let b = BoreProfile::tenor_trombone();
    let res: Vec<f32> = Reference::new(&b, 20.0, 800.0, 0.5).peaks(0.0).iter().map(|p| p.freq).collect();
    println!("trombone resonances used (first position): {}", res.iter().take(12).map(|f| format!("{f:.1}")).collect::<Vec<_>>().join(", "));
    let sr = SR * 2.0;

    // The threshold of breath, per partial.
    let row: Vec<String> = (2..=12).map(|n| format!("{n}: {:.0} Pa", threshold(n))).collect();
    println!("breath threshold by partial (lips set by the player's own laws): {}", row.join(", "));

    // How far above its resonance each note sounds.
    for &pm in &[1000.0f32, 3000.0, 8000.0] {
        let mut row = Vec::new();
        for n in 2..=10usize {
            let mut bore = AirBore::new(&b, sr);
            bore.set_tuning(res[n - 1]);
            let ac = lip_trial(&mut bore, lip_mass(res[n - 1]), pm, lip_center(res[n - 1], pm), 0.4);
            let (k, f) = classify(&ac, pm, &res, res[n - 1] * 1.03);
            row.push(if k == n { format!("{n}: {:+.0}c", cents(f, res[n - 1])) } else { format!("{n}: lands on {}", if k == 0 { "nothing".to_string() } else if k == 99 { "no resonance".to_string() } else { format!("partial {k}") }) });
        }
        println!("sounding pitch above the resonance, lips at lip_center, {pm:.0} Pa: {}", row.join(", "));
    }

    // The slot map for partial 4: which resonance the lips lock onto for each lip frequency and breath.
    let n = 4usize;
    let peak = res[n - 1];
    let mut bore = AirBore::new(&b, sr);
    bore.set_tuning(peak);
    let ratios: Vec<f32> = (0..=42).map(|i| 0.66 + 0.01 * i as f32).collect();
    let pressures: Vec<f32> = (0..14).map(|i| 500.0 * (16000.0f32 / 500.0).powf(i as f32 / 13.0)).collect();
    let mut svg = svg_start(960.0, 486.0);
    let ax = Axes { x: 70.0, y: 40.0, w: 640.0, h: 380.0, xr: (0.655, 1.095), yr: (0.0, 14.0) };
    ax.frame(&mut svg, "Partial 4 of the trombone: what the lips lock onto", "lip frequency / resonance 4", "breath, Pa", &ticks(0.7, 1.05, 0.05, |v| format!("{v:.2}")), &[]);
    let mut slot: Vec<(f32, Option<(f32, f32)>)> = Vec::new();
    for (j, &pm) in pressures.iter().enumerate() {
        let mut best_run: Option<(usize, usize)> = None;
        let mut run_start: Option<usize> = None;
        for (i, &r) in ratios.iter().enumerate() {
            let ac = lip_trial(&mut bore, lip_mass(peak), pm, r * peak, 0.4);
            let (k, _) = classify(&ac, pm, &res, res[3] * 1.05);
            let colour = match k { 0 => "#efece4", 99 => "#4a463c", k if k == n => RED, k if k + 1 == n => BLUE, k if k == n + 1 => GREEN, _ => GREY };
            let (x0, x1) = (ax.px(r - 0.005), ax.px(r + 0.005));
            let (y0, y1) = (ax.py(j as f32 + 1.0), ax.py(j as f32));
            svg.push_str(&format!("<rect x=\"{x0:.1}\" y=\"{y0:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"{colour}\"/>", x1 - x0, y1 - y0));
            if k == n {
                let s = *run_start.get_or_insert(i);
                if best_run.map_or(true, |b| i - s >= b.1 - b.0) { best_run = Some((s, i)); }
            } else {
                run_start = None;
            }
        }
        slot.push((pm, best_run.map(|(a, b)| (ratios[a], ratios[b]))));
        if j % 2 == 0 {
            svg_text(&mut svg, ax.x - 4.0, ax.py(j as f32 + 0.5) + 3.0, 10.0, "end", "#55524a", false, &format!("{pm:.0}"));
        }
    }
    let law: Vec<(f32, f32)> = (0..=60).map(|i| { let pm = 500.0 * (16000.0f32 / 500.0).powf(i as f32 / 60.0); (0.85 * (pm / 700.0).powf(-0.073), 13.0 * (pm / 500.0).ln() / (16000.0f32 / 500.0).ln() + 0.5) }).collect();
    ax.line(&mut svg, &law, "#000000", 2.0, "6 4");
    for (c, l, y) in [(RED, "locks on partial 4", 60.0), (BLUE, "locks on partial 3", 80.0), (GREEN, "locks on partial 5", 100.0), ("#4a463c", "sounds, but on no resonance", 120.0), ("#efece4", "silent", 140.0)] {
        svg.push_str(&format!("<rect x=\"730\" y=\"{y}\" width=\"14\" height=\"14\" fill=\"{c}\" stroke=\"#c9c4b8\"/>"));
        svg_text(&mut svg, 750.0, y + 11.0, 11.0, "start", "#2a2925", false, l);
    }
    svg_text(&mut svg, 730.0, 180.0, 11.0, "start", "#2a2925", false, "black dashes: the player's law,");
    svg_text(&mut svg, 730.0, 194.0, 11.0, "start", "#2a2925", false, "0.85 (p / 700 Pa)^-0.073");
    svg_text(&mut svg, 70.0, 476.0, 11.0, "start", "#55524a", false, "each cell: 0.4 s from rest, lips of the mass set for this partial, first-position slide; breath ramps up over 5 ms");
    svg_save(svg, "slot-map.svg");
    println!("partial 4 slot (longest run of lip ratios that lock on partial 4), by breath, against the law 0.85 (p/700)^-0.073:");
    for (pm, s) in &slot {
        let law = 0.85 * (pm / 700.0).powf(-0.073);
        match s {
            Some((lo, hi)) => println!("  {pm:>6.0} Pa: {lo:.2} to {hi:.2} (centre {:.3}, width {:.2}); law {law:.3}", 0.5 * (lo + hi), hi - lo),
            None => println!("  {pm:>6.0} Pa: no lock; law {law:.3}"),
        }
    }
    // The same for other partials at three breaths.
    for &pm in &[1000.0f32, 3000.0, 8000.0] {
        let mut row = Vec::new();
        for n in [3usize, 6, 8, 10] {
            let peak = res[n - 1];
            let mut bore = AirBore::new(&b, sr);
            bore.set_tuning(peak);
            let hits: Vec<f32> = (0..=40).map(|i| 0.66 + 0.01 * i as f32).filter(|&r| classify(&lip_trial(&mut bore, lip_mass(peak), pm, r * peak, 0.4), pm, &res, res[n - 1] * 1.03).0 == n).collect();
            row.push(match (hits.first(), hits.last()) {
                (Some(lo), Some(hi)) => format!("{n}: {lo:.2}-{hi:.2} (centre {:.3})", 0.5 * (lo + hi)),
                _ => format!("{n}: none"),
            });
        }
        println!("lock range by partial, {pm:.0} Pa, law {:.3}: {}", 0.85 * (pm / 700.0).powf(-0.073), row.join(", "));
    }

    // Hysteresis: sweep the lips up and then back down at a fixed breath, no reset in between.
    let pm = 3000.0f32;
    let mass = lip_mass(res[3]);
    let mut bore = AirBore::new(&b, sr);
    bore.set_tuning(res[3]);
    let mut lips = Lips::new(LipSpec { mu: mass, ..LipSpec::trombone() });
    let (f_lo, f_hi, secs) = (125.0f32, 320.0f32, 8.0f32);
    let win = (0.04 * sr) as usize;
    let mut up = Vec::new();
    let mut down = Vec::new();
    let mut t = 0usize;
    let total = (2.0 * secs * sr) as usize;
    let mut buf = Vec::with_capacity(win);
    while t < total {
        let phase = t as f32 / (secs * sr);
        let lf = if phase < 1.0 { f_lo + (f_hi - f_lo) * phase } else { f_hi - (f_hi - f_lo) * (phase - 1.0) };
        lips.freq = lf;
        let ramp = (t as f32 / (0.005 * sr)).min(1.0);
        let inc = bore.incoming();
        let inj = lips.tick(pm * ramp, inc, bore.z_in(), 1.0 / sr, ramp);
        bore.step(inj);
        buf.push(lips.pressure);
        t += 1;
        if buf.len() == win {
            let mean = buf.iter().sum::<f32>() / win as f32;
            let ac: Vec<f32> = buf.iter().map(|x| x - mean).collect();
            let (k, f) = classify(&ac, pm, &res, res[3] * 1.05);
            if k != 0 && k != 99 {
                let entry = (lf, f, k);
                if phase < 1.0 { up.push(entry) } else { down.push(entry) }
            }
            buf.clear();
        }
    }
    let edges = |v: &[(f32, f32, usize)]| -> Vec<String> { v.windows(2).filter(|w| w[0].2 != w[1].2).map(|w| format!("{}->{} at lip {:.1} Hz", w[0].2, w[1].2, 0.5 * (w[0].0 + w[1].0))).collect() };
    println!("hysteresis sweep at {pm:.0} Pa, lip mass {mass:.2} kg/m2, {secs} s per direction, {f_lo}-{f_hi} Hz");
    println!("  up:   {}", edges(&up).join("; "));
    println!("  down: {}", edges(&down).join("; "));
    let mut svg = svg_start(960.0, 430.0);
    let ax = Axes { x: 70.0, y: 40.0, w: 750.0, h: 330.0, xr: (f_lo, f_hi), yr: (100.0, 420.0) };
    ax.frame(&mut svg, "Lip frequency swept up, then back down, at 3 kPa: the sounding pitch", "lip resonance, Hz", "sounding pitch, Hz", &ticks(150.0, 300.0, 50.0, |v| format!("{v}")), &ticks(100.0, 400.0, 50.0, |v| format!("{v}")));
    for (n, &r) in res.iter().enumerate().take(7).skip(1) {
        ax.hline(&mut svg, r, "#d9d3c4", "3 3");
        svg_text(&mut svg, ax.x + ax.w + 6.0, ax.py(r) + 3.0, 10.0, "start", GREY, false, &format!("resonance {} ({r:.0} Hz)", n + 1));
    }
    for &(lf, f, _) in &up { ax.dot(&mut svg, lf, f, 3.0, RED); }
    for &(lf, f, _) in &down { ax.dot(&mut svg, lf, f, 3.0, BLUE); }
    svg_text(&mut svg, 70.0, 396.0, 11.0, "start", RED, false, "red: lips swept up");
    svg_text(&mut svg, 70.0, 412.0, 11.0, "start", BLUE, false, "blue: swept back down (state carried over, 40 ms windows)");
    svg_save(svg, "hysteresis.svg");
}

// ----------------------------------------------------------------- the player

#[test]
#[ignore]
fn brass_player_report() {
    println!("profile: {}", profile());
    println!("-- trombone, B-flat2 to C5, held 0.8 s, pitch over the second half");
    for &breath in &[0.15f32, 0.5, 0.9] {
        let mut row = Vec::new();
        for &f in &[116.54f32, 146.83, 174.61, 196.0, 233.08, 261.63, 293.66, 349.23, 392.0, 466.16, 523.25] {
            let (x, r) = hold(BrassParams { breath, ..note(f) }, 0.8);
            row.push(format!("{f:.0}Hz p{} pos{:.1} {:+.1}c", r.partial, r.position, cents(pitch(settled(&x), SR, f), f)));
        }
        println!("breath {breath}: {}", row.join(" | "));
    }
    println!("-- attack: seconds to half and 90% of the settled level, skill 1 against skill 0");
    for &f in &[116.54f32, 174.61, 233.08, 349.23, 466.16] {
        let (a, _) = hold(note(f), 0.6);
        let (b, _) = hold(BrassParams { attack_skill: 0.0, ..note(f) }, 0.6);
        println!("{f:.2} Hz: skilled {:.3} / {:.3} s, unskilled {:.3} / {:.3} s", time_to(&a, 0.5), time_to(&a, 0.9), time_to(&b, 0.5), time_to(&b, 0.9));
    }
    let (skilled, _) = hold(note(233.08), 0.6);
    let (unskilled, _) = hold(BrassParams { attack_skill: 0.0, ..note(233.08) }, 0.6);
    let (mid, _) = hold(BrassParams { attack_skill: 0.5, ..note(233.08) }, 0.6);
    let mut svg = svg_start(960.0, 340.0);
    let ax = Axes { x: 60.0, y: 40.0, w: 860.0, h: 240.0, xr: (0.0, 300.0), yr: (0.0, 1.1) };
    ax.frame(&mut svg, "B-flat3 on the trombone: level in the first 300 ms, as a fraction of the settled level", "milliseconds from note-on", "rms / settled rms", &ticks(0.0, 300.0, 50.0, |v| format!("{v}")), &ticks(0.0, 1.0, 0.25, |v| format!("{v}")));
    let env = |x: &[f32]| -> Vec<(f32, f32)> {
        // Blocks of exactly one period of the note, so the rms doesn't beat against the pitch.
        let full = rms(settled(x));
        let block = (SR / 233.08).round() as usize;
        x.chunks(block).take(70).enumerate().map(|(i, c)| (i as f32 * block as f32 / SR * 1000.0, rms(c) / full)).collect()
    };
    ax.hline(&mut svg, 0.5, "#d9d3c4", "3 3");
    ax.hline(&mut svg, 0.9, "#d9d3c4", "3 3");
    ax.line(&mut svg, &env(&unskilled), RED, 2.0, "");
    ax.line(&mut svg, &env(&mid), BROWN, 2.0, "");
    ax.line(&mut svg, &env(&skilled), BLUE, 2.0, "");
    svg_text(&mut svg, 70.0, 322.0, 11.0, "start", BLUE, false, &format!("attack_skill 1: half level {:.0} ms, 90% {:.0} ms", time_to(&skilled, 0.5) * 1000.0, time_to(&skilled, 0.9) * 1000.0));
    svg_text(&mut svg, 400.0, 322.0, 11.0, "start", BROWN, false, &format!("0.5: {:.0} ms, {:.0} ms", time_to(&mid, 0.5) * 1000.0, time_to(&mid, 0.9) * 1000.0));
    svg_text(&mut svg, 600.0, 322.0, 11.0, "start", RED, false, &format!("0: {:.0} ms, {:.0} ms", time_to(&unskilled, 0.5) * 1000.0, time_to(&unskilled, 0.9) * 1000.0));
    svg_save(svg, "attack.svg");
    println!("-- cracks: pitch heard 30-100 ms in, cents from the note meant, three takes each");
    for &f in &[349.23f32, 466.16, 587.33] {
        for &skill in &[1.0f32, 0.5, 0.0] {
            let mut row = Vec::new();
            for take in 0..3 {
                let p = BrassParams { attack_skill: skill, ..note(f) };
                let mut e = Engine::new(SR, &p);
                for _ in 0..take {
                    e.note_on(9, p, false, None);
                    for _ in 0..30000 { e.next_frame(); }
                }
                e.note_on(1, p, true, None);
                let x: Vec<f32> = (0..(0.1 * SR) as usize).map(|_| e.next_frame()[0]).collect();
                row.push(format!("{:+.0}", cents(pitch(&x[(0.03 * SR) as usize..], SR, f), f)));
            }
            println!("{f:.2} Hz skill {skill}: {}", row.join(", "));
        }
    }
    println!("-- lip tension on B-flat3 (233.08 Hz), sounding pitch in the settled half");
    let row: Vec<String> = (-5..=5).map(|i| {
        let t = i as f32 * 0.2;
        let (x, _) = hold(BrassParams { lip_tension: t, ..note(233.08) }, 0.6);
        format!("{t:+.1}: {:.0} Hz", pitch(settled(&x), SR, 233.0))
    }).collect();
    println!("{}", row.join(" | "));
    let first = BrassParams { duration: 0.5, ..note(233.08) };
    let second = BrassParams { duration: 0.7, articulation: Articulation::Glissando, slide_time: 0.3, ..note(196.0) };
    let x = render_phrase(&[PerformedNote { start: 0.0, params: first }, PerformedNote { start: 0.45, params: second }], SR, 0.1);
    let track: Vec<String> = (0..14).map(|i| { let t = 0.3 + i as f32 * 0.06; format!("{t:.2}s {:.1}", pitch(&x[(t * SR) as usize..((t + 0.03) * SR) as usize], SR, 215.0)) }).collect();
    println!("glissando B-flat3 to G3, pitch (Hz) every 60 ms: {}", track.join(" | "));
}

// ----------------------------------------------------------------- brassiness

/// Share of the spectral energy below `fmax` that sits farther than a quarter of `f0` from any harmonic.
fn inharmonic_share(seg: &[f32], sr: f32, f0: f32, fmax: f32) -> f32 {
    let (m, bin) = spectrum(seg, sr);
    let (mut bad, mut all) = (0.0f64, 0.0f64);
    for (k, v) in m.iter().enumerate().skip(1) {
        let f = k as f32 * bin;
        if f > fmax { break; }
        let e = (*v as f64).powi(2);
        all += e;
        let h = (f / f0).round().max(1.0);
        if (f - h * f0).abs() > 0.25 * f0 { bad += e; }
    }
    (bad / all.max(1.0e-30)) as f32
}

fn wave_panel(svg: &mut String, x: f32, y: f32, w: f32, h: f32, ys: &[f32], color: &str, label: &str, unit: &str) {
    let peak = ys.iter().fold(1.0e-12f32, |m, v| m.max(v.abs()));
    let ax = Axes { x, y, w, h, xr: (0.0, (ys.len() - 1) as f32), yr: (-peak * 1.05, peak * 1.05) };
    ax.frame(svg, label, "", "", &[], &[]);
    ax.hline(svg, 0.0, "#c9c4b8", "2 3");
    let pts: Vec<(f32, f32)> = ys.iter().enumerate().map(|(i, &v)| (i as f32, v)).collect();
    ax.line(svg, &pts, color, 1.6, "");
    svg_text(svg, x + w, y - 8.0, 11.0, "end", "#55524a", false, &if peak > 50.0 { format!("peak {peak:.0} {unit}") } else { format!("peak {peak:.3} {unit}") });
}

#[test]
#[ignore]
fn brass_brassiness_report() {
    println!("profile: {}", profile());
    let f = 233.08f32;
    println!("-- trombone B-flat3, breath sweep, second half of a 0.8 s note: with the air's nonlinearity (1.0) and without (0.0)");
    println!("breath  mouth Pa | level dB  centroid Hz  wave slope Pa/s | level dB  centroid Hz  wave slope Pa/s");
    for i in 1..=10 {
        let breath = i as f32 * 0.1;
        let mut cells = Vec::new();
        let mut pm = 0.0;
        for &b in &[1.0f32, 0.0] {
            let (x, r) = hold(BrassParams { breath, brassiness: b, ..note(f) }, 0.8);
            let s = settled(&x);
            pm = r.mouth_pressure;
            cells.push(format!("{:>8.1}  {:>10.0}  {:>13.3e}", 20.0 * rms(s).log10(), centroid(s), r.wave_steepness));
        }
        println!("{breath:>5.1}  {pm:>8.0} | {} | {}", cells[0], cells[1]);
    }
    let (mf, mf_r) = hold(BrassParams { breath: 0.5, ..note(f) }, 0.8);
    let (ff, ff_r) = hold(BrassParams { breath: 0.9, ..note(f) }, 0.8);
    let (lin, lin_r) = hold(BrassParams { breath: 0.9, brassiness: 0.0, ..note(f) }, 0.8);
    let (mf_s, ff_s, lin_s) = (settled(&mf), settled(&ff), settled(&lin));
    println!("ff over mf: {:.1} dB louder, centroid {:.0} Hz vs {:.0} Hz ({:.2}x); ff linear centroid {:.0} Hz, so nonlinearity brings {:.2}x", 20.0 * (rms(ff_s) / rms(mf_s)).log10(), centroid(ff_s), centroid(mf_s), centroid(ff_s) / centroid(mf_s), centroid(lin_s), centroid(ff_s) / centroid(lin_s));
    println!("tenth harmonic re strongest: mf {:.1} dB, ff {:.1} dB, ff linear {:.1} dB", harmonic_db(mf_s, f, 10), harmonic_db(ff_s, f, 10), harmonic_db(lin_s, f, 10));
    println!("wave slope at the bell: mf {:.3e}, ff {:.3e}, ff linear {:.3e} Pa/s; ff/mf {:.1}x; ff/linear {:.1}x", mf_r.wave_steepness, ff_r.wave_steepness, lin_r.wave_steepness, ff_r.wave_steepness / mf_r.wave_steepness, ff_r.wave_steepness / lin_r.wave_steepness);
    let harm = |seg: &[f32], k: usize| -> f32 {
        let (m, b) = spectrum(seg, SR);
        let c = (f * k as f32 / b).round() as usize;
        m[c.saturating_sub(3)..(c + 4).min(m.len())].iter().fold(0.0f32, |a, v| a.max(*v))
    };
    let top = (1..=24).map(|k| harm(ff_s, k)).fold(1.0e-12f32, f32::max);
    let curve = |seg: &[f32]| -> Vec<(f32, f32)> { (1..=24).map(|k| (k as f32, 20.0 * (harm(seg, k) / top).max(1.0e-6).log10())).collect() };
    let mut svg = svg_start(960.0, 380.0);
    let ax = Axes { x: 60.0, y: 40.0, w: 860.0, h: 290.0, xr: (1.0, 24.0), yr: (-100.0, 5.0) };
    ax.frame(&mut svg, "Trombone B-flat3: level of each harmonic, re the loudest harmonic of the ff note", "harmonic number", "dB", &ticks(2.0, 24.0, 2.0, |v| format!("{v}")), &ticks(-100.0, 0.0, 20.0, |v| format!("{v}")));
    for (seg, c) in [(lin_s, GREY), (mf_s, BLUE), (ff_s, RED)] {
        let pts = curve(seg);
        ax.line(&mut svg, &pts, c, 2.0, "");
        for (x, y) in pts { ax.dot(&mut svg, x, y, 2.6, c); }
    }
    svg_text(&mut svg, 70.0, 356.0, 11.0, "start", BLUE, false, "blue: mezzo (breath 0.5)");
    svg_text(&mut svg, 300.0, 356.0, 11.0, "start", RED, false, "red: fortissimo (breath 0.9)");
    svg_text(&mut svg, 560.0, 356.0, 11.0, "start", GREY, false, "grey: the same ff breath with the air's nonlinearity off (brassiness 0)");
    svg_save(svg, "brassiness-spectra.svg");
    let n = (3.0 * SR / f) as usize;
    let mut svg = svg_start(960.0, 3.0 * 150.0 + 30.0);
    for (i, (seg, c, l)) in [(mf_s, BLUE, "mezzo, radiated sound, three periods"), (ff_s, RED, "fortissimo, radiated sound"), (lin_s, GREY, "fortissimo, air's nonlinearity off")].into_iter().enumerate() {
        wave_panel(&mut svg, 60.0, 40.0 + i as f32 * 150.0, 860.0, 110.0, &seg[seg.len() / 2..seg.len() / 2 + n], c, l, "full scale");
    }
    svg_save(svg, "brassiness-waveforms.svg");
    let mut svg = svg_start(960.0, 3.0 * 150.0 + 30.0);
    for (i, (breath, nl, c, l)) in [(0.5f32, 1.0f32, BLUE, "mezzo"), (0.9, 1.0, RED, "fortissimo"), (0.9, 0.0, GREY, "ff, nonlinearity off")].into_iter().enumerate() {
        let p = BrassParams { breath, brassiness: nl, ..note(f) };
        let mut e = Engine::new(SR, &p);
        e.note_on(1, p, true, None);
        for _ in 0..(0.6 * SR) as usize { e.next_frame(); }
        let (mut pr, mut op) = ([0.0f32; 128], [0.0f32; 128]);
        assert!(e.traces(&mut pr, &mut op));
        wave_panel(&mut svg, 60.0, 40.0 + i as f32 * 150.0, 415.0, 110.0, &pr, c, &format!("{l}: mouthpiece pressure"), "Pa");
        let mean = op.iter().sum::<f32>() / 128.0;
        let op: Vec<f32> = op.iter().map(|v| (v - mean) * 1000.0).collect();
        wave_panel(&mut svg, 505.0, 40.0 + i as f32 * 150.0, 415.0, 110.0, &op, c, "lip opening (mean removed)", "mm");
    }
    svg_save(svg, "lips-mouthpiece.svg");

    println!("-- brassiness by instrument (breath 0.9): with vs without the nonlinearity");
    for (name, inst, hz) in [("trombone", BrassInstrument::TenorTrombone, 233.08f32), ("trumpet", BrassInstrument::Trumpet, 466.16), ("horn", BrassInstrument::Horn, 349.23), ("tuba", BrassInstrument::Tuba, 116.54)] {
        let (a, ra) = hold(BrassParams { instrument: inst, breath: 0.9, ..note(hz) }, 0.8);
        let (b, rb) = hold(BrassParams { instrument: inst, breath: 0.9, brassiness: 0.0, ..note(hz) }, 0.8);
        let (a, b) = (settled(&a), settled(&b));
        println!("{name} {hz} Hz: centroid {:.0} Hz vs {:.0} Hz ({:.2}x); tenth harmonic {:+.1} dB vs {:+.1} dB; wave slope {:.2e} vs {:.2e} Pa/s ({:.1}x); level {:.1} vs {:.1} dB; cylinder {:.2} m of {:.2} m", centroid(a), centroid(b), centroid(a) / centroid(b), harmonic_db(a, hz, 10), harmonic_db(b, hz, 10), ra.wave_steepness, rb.wave_steepness, ra.wave_steepness / rb.wave_steepness, 20.0 * rms(a).log10(), 20.0 * rms(b).log10(), inst.profile().cylinder_length, inst.profile().total_length(0.0));
    }

    println!("-- inharmonic share of the spectrum below 20 kHz (energy farther than a quarter of f0 from a harmonic)");
    for &(label, breath, nl) in &[("ff", 0.9f32, 1.0f32), ("ff, nonlinearity off", 0.9, 0.0), ("mf", 0.5, 1.0)] {
        let mut row = Vec::new();
        for &sr in &[44_100.0f32, 88_200.0] {
            let p = BrassParams { breath, brassiness: nl, duration: 1.2, ..note(f) };
            let (x, _) = render_note(&p, sr, 1.2);
            let seg = &x[(0.7 * sr) as usize..];
            let f0 = pitch(seg, sr, f);
            row.push(format!("{:.0} kHz engine rate: {:.2e}", sr / 1000.0, inharmonic_share(seg, sr, f0, 20000.0)));
        }
        println!("{label}: {}", row.join(" | "));
    }
}

// ----------------------------------------------------------------- the family

#[test]
#[ignore]
fn brass_family_report() {
    println!("profile: {}", profile());
    let ranges: [(BrassInstrument, i32, i32); 4] = [(BrassInstrument::TenorTrombone, 40, 77), (BrassInstrument::Trumpet, 52, 84), (BrassInstrument::Horn, 41, 77), (BrassInstrument::Tuba, 28, 60)];
    let mut svg = svg_start(960.0, 2.0 * 190.0 + 60.0);
    for (k, &(inst, lo, hi)) in ranges.iter().enumerate() {
        let ax = Axes { x: 60.0 + (k % 2) as f32 * 470.0, y: 40.0 + (k / 2) as f32 * 190.0, w: 400.0, h: 130.0, xr: (lo as f32 - 1.0, hi as f32 + 1.0), yr: (-40.0, 40.0) };
        ax.frame(&mut svg, &format!("{}: cents from the note asked", FAMILY[k].0), "", "cents", &ticks((lo / 12 * 12 + 12) as f32, hi as f32, 12.0, |v| note_name(v as i32)), &[(-30.0, "-30".into()), (-15.0, "-15".into()), (0.0, "0".into()), (15.0, "15".into()), (30.0, "30".into())]);
        ax.hline(&mut svg, 6.0, "#d9d3c4", "3 3");
        ax.hline(&mut svg, -6.0, "#d9d3c4", "3 3");
        for &(breath, c) in &[(0.15f32, BLUE), (0.5, GREEN), (0.9, RED)] {
            let mut rows = Vec::new();
            let mut misses = Vec::new();
            for m in lo..=hi {
                let f = midi_hz(m);
                let secs = if f < 70.0 { 1.4 } else if f < 130.0 { 1.0 } else { 0.8 };
                let (x, r) = hold(BrassParams { instrument: inst, breath, ..note(f) }, secs);
                let s = settled(&x);
                let c_off = cents(pitch(s, SR, f), f);
                let quiet = rms(s) < 1.0e-3;
                ax.dot(&mut svg, m as f32, c_off.clamp(-39.0, 39.0), 2.6, c);
                rows.push((m, c_off, r.partial, r.valves, r.position, quiet));
                if c_off.abs() > 15.0 || quiet { misses.push(format!("{} {:+.0}c (partial {}{})", note_name(m), c_off, r.partial, if quiet { ", silent" } else { "" })); }
            }
            let within = |t: f32| rows.iter().filter(|r| r.1.abs() < t && !r.5).count();
            println!("{:<26} breath {breath}: {} notes {}-{}; within 6 cents {}, within 15 {}; worst {:+.0}; outside 15: {}", FAMILY[k].0, rows.len(), note_name(lo), note_name(hi), within(6.0), within(15.0), rows.iter().map(|r| r.1).fold(0.0f32, |a, b| if b.abs() > a.abs() { b } else { a }), if misses.is_empty() { "none".to_string() } else { misses.join(", ") });
            if breath == 0.5 {
                let row: Vec<String> = rows.iter().map(|r| if matches!(inst, BrassInstrument::TenorTrombone) { format!("{} p{} pos{:.1} {:+.0}", note_name(r.0), r.2, r.4, r.1) } else { format!("{} p{} v{:03b}{} {:+.0}", note_name(r.0), r.2, r.3 & 7, if r.3 & F_SIDE != 0 { "F" } else { "" }, r.1) }).collect();
                println!("    mf rows: {}", row.join(" | "));
            }
        }
    }
    svg_text(&mut svg, 60.0, 2.0 * 190.0 + 46.0, 11.0, "start", "#55524a", false, "one dot per chromatic note held 0.8 s or more; blue breath 0.15, green 0.5, red 0.9; dashed lines at +-6 cents");
    svg_save(svg, "tuning.svg");

    println!("-- speaking time of the lowest notes (seconds to 90% of the settled level, breath 0.5)");
    for &(inst, lo, _) in &ranges {
        let row: Vec<String> = (lo..lo + 4).map(|m| { let a = super::analysis::analyze_note(&BrassParams { instrument: inst, ..note(midi_hz(m)) }, 1.6, 0.5); format!("{} {}", note_name(m), a.attack_secs.map_or("never".to_string(), |s| format!("{s:.3}"))) }).collect();
        println!("{}: {}", inst.name(), row.join(", "));
    }

    let open = 1.4f32;
    let combos = engine::valve_combos(BrassInstrument::Trumpet.mechanism(), open);
    let semis = [2.0f32, 1.0, 3.0];
    let row: Vec<String> = combos.iter().filter(|c| c.0 != 0).map(|&(mask, tube)| {
        let s: f32 = (0..3).filter(|k| mask & (1 << k) != 0).map(|k| semis[k]).sum();
        let ideal = open * (2f32.powf(s / 12.0) - 1.0);
        format!("valves {:03b} ({s} semitones): {:.1} cents sharp", mask, 1200.0 * ((open + ideal) / (open + tube)).log2())
    }).collect();
    println!("trumpet valve combinations against the ideal tube: {}", row.join(" | "));

    let base = BrassInstrument::Horn.profile();
    let f1 = base.nominal_fundamental;
    let bore = |hand: f32| base.obstructed(engine::obstruction(Mute::Open, hand, base.mouth_radius()));
    let open_p = Reference::new(&bore(0.35), 20.0, f1 * 18.0, 0.5).peaks(0.0);
    let stopped_p = Reference::new(&bore(1.0), 20.0, f1 * 18.0, 0.5).peaks(0.0);
    let row: Vec<String> = (9..=16).map(|n| {
        let fo = open_p[n - 1].freq;
        let above = stopped_p.iter().map(|p| p.freq).filter(|&x| x > fo * 1.001).fold(f32::MAX, f32::min);
        format!("{n}: {:+.0}c", cents(above, fo))
    }).collect();
    println!("horn stopped: nearest stopped resonance above each open one: {}", row.join(", "));
    let mut svg = svg_start(960.0, 330.0);
    let ax = Axes { x: 60.0, y: 40.0, w: 860.0, h: 220.0, xr: (300.0, 1100.0), yr: (-6.0, 46.0) };
    ax.frame(&mut svg, "Horn (B-flat side): input impedance with the hand out and stopped", "frequency, Hz", "|Z| in dB re 1e6 Pa s/m^3", &ticks(400.0, 1000.0, 100.0, |v| format!("{v}")), &ticks(0.0, 40.0, 10.0, |v| format!("{v}")));
    for (hand, c) in [(0.35f32, BLUE), (1.0, RED)] {
        let r = Reference::new(&bore(hand), 300.0, 1100.0, 0.5);
        let pts: Vec<(f32, f32)> = r.freqs.iter().zip(r.magnitude(0.0)).map(|(&f, m)| (f, 20.0 * (m / 1.0e6).log10())).collect();
        ax.line(&mut svg, &pts, c, 1.6, "");
    }
    svg_text(&mut svg, 70.0, 286.0, 11.0, "start", BLUE, false, "blue: the horn player's usual hand (0.35)");
    svg_text(&mut svg, 70.0, 302.0, 11.0, "start", RED, false, "red: hand fully in the bell (1.0). Each resonance gets a neighbour a little above it.");
    svg_save(svg, "horn-stopped.svg");

    println!("-- horn A4 (440 Hz), breath 0.6: the hand");
    let (o, _) = hold(BrassParams { instrument: BrassInstrument::Horn, breath: 0.6, hand: Some(0.0), ..note(440.0) }, 0.8);
    let o = settled(&o).to_vec();
    for &h in &[0.0f32, 0.35, 0.7, 1.0] {
        let (x, r) = hold(BrassParams { instrument: BrassInstrument::Horn, breath: 0.6, hand: Some(h), ..note(440.0) }, 0.8);
        let s = settled(&x);
        println!("hand {h}: {:+.1} cents, partial {}, {:+.1} dB against hand 0, centroid {:.0} Hz ({:.2}x hand 0)", cents(pitch(s, SR, 440.0), 440.0), r.partial, 20.0 * (rms(s) / rms(&o)).log10(), centroid(s), centroid(s) / centroid(&o));
    }
    for (name, inst, hz) in [("trombone B-flat3", BrassInstrument::TenorTrombone, 233.08f32), ("trumpet B-flat4", BrassInstrument::Trumpet, 466.16)] {
        let base = hold(BrassParams { instrument: inst, ..note(hz) }, 0.8).0;
        let base = settled(&base).to_vec();
        for m in [Mute::Open, Mute::Straight, Mute::Cup, Mute::Harmon] {
            let (x, _) = hold(BrassParams { instrument: inst, mute: m, ..note(hz) }, 0.8);
            let s = settled(&x);
            println!("{name}, {:>8} mute: {:+5.1} cents, {:+5.1} dB against open, centroid {:5.0} Hz ({:.2}x open)", m.name(), cents(pitch(s, SR, hz), hz), 20.0 * (rms(s) / rms(&base)).log10(), centroid(s), centroid(s) / centroid(&base));
        }
    }
    println!("-- bell facing, trombone B-flat3, breath 0.7");
    let mut ref_level = 0.0;
    for &fc in &[0.0f32, 0.25, 0.5, 0.75, 1.0] {
        let (x, _) = hold(BrassParams { bell_facing: Some(fc), breath: 0.7, ..note(233.08) }, 0.8);
        let s = settled(&x);
        if fc == 0.0 { ref_level = rms(s); }
        println!("facing {fc}: centroid {:.0} Hz, {:+.1} dB against facing 0", centroid(s), 20.0 * (rms(s) / ref_level).log10());
    }
    println!("-- level across the trombone at the same breath (0.5), dB re full scale, rms of the settled half");
    let row: Vec<String> = (46..=70).step_by(2).map(|m| { let (x, _) = hold(note(midi_hz(m)), 0.8); format!("{} {:.1}", note_name(m), 20.0 * rms(settled(&x)).log10()) }).collect();
    println!("{}", row.join(" | "));
}

// ----------------------------------------------------------------- cost

#[test]
#[ignore]
fn brass_cost_report() {
    println!("profile: {}", profile());
    for (name, inst, hz) in [("trombone", BrassInstrument::TenorTrombone, 233.08f32), ("trumpet", BrassInstrument::Trumpet, 466.16), ("horn", BrassInstrument::Horn, 349.23), ("tuba", BrassInstrument::Tuba, 116.54)] {
        for &breath in &[0.5f32, 0.9] {
            let p = BrassParams { instrument: inst, breath, ..note(hz) };
            let secs = 10.0f32;
            let mut runs = Vec::new();
            for _ in 0..3 {
                let mut e = Engine::new(SR, &p);
                e.note_on(1, p, true, None);
                for _ in 0..(0.5 * SR) as usize { e.next_frame(); }
                let n = (secs * SR) as usize;
                let t = std::time::Instant::now();
                let mut acc = 0.0f32;
                for _ in 0..n {
                    let [l, r] = e.next_frame();
                    acc += l + r;
                }
                std::hint::black_box(acc);
                runs.push(t.elapsed().as_secs_f32() / secs * 100.0);
            }
            runs.sort_by(|a, b| a.total_cmp(b));
            println!("{name:<9} {hz:>7.2} Hz breath {breath}: {:.1}% / {:.1}% / {:.1}% of one core (min / median / max of 3, 10 s of audio each)", runs[0], runs[1], runs[2]);
        }
    }
}

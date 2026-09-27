//! Physics-level tests: every claim the model makes is rendered offline and measured. None of these
//! listen - they check pitch in cents, stick/slip statistics, levels and spectra, which is how the
//! model was developed and tuned in the first place (see `docs/PHYS_MOD_SYNTH.md`).

use super::analysis::{analyze_note, measure, pitch};
use super::engine::*;
use super::*;

const SR: f32 = ENGINE_SAMPLE_RATE as f32;

fn plain(freq: f32) -> PhysModParams {
    PhysModParams { freq, vibrato_depth: 0.0, bow_noise: 0.0, ..Default::default() }
}

fn left(x: &[f32]) -> Vec<f32> {
    x.iter().step_by(2).copied().collect()
}

fn rms_db(x: &[f32]) -> f32 {
    20.0 * ((x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()).max(1.0e-9).log10()
}

// ---------------------------------------------------------------- pitch

#[test]
fn bowed_notes_are_in_tune_across_the_violin() {
    // Open strings, stopped notes and high positions, measured once the stroke has settled.
    for &f in &[196.0f32, 220.0, 293.66, 349.23, 440.0, 523.25, 659.25, 880.0, 1318.5] {
        let a = analyze_note(&plain(f), 0.7, 0.25);
        assert!(a.cents.abs() < 6.0, "{f} Hz came out {:.2} Hz ({:+.1} cents)", a.f0, a.cents);
    }
}

#[test]
fn cello_and_bass_registers_are_in_tune() {
    let cello = [65.41, 98.0, 146.83, 220.0];
    for &f in &[65.41f32, 110.0, 196.0] {
        let p = PhysModParams { strings: cello, body_size: 0.72, ..plain(f) };
        let a = analyze_note(&p, 0.9, 0.3);
        assert!(a.cents.abs() < 8.0, "cello {f} Hz came out {:.2} Hz ({:+.1} cents)", a.f0, a.cents);
    }
    let bass = [41.2, 55.0, 73.42, 98.0];
    let p = PhysModParams { strings: [bass[0], bass[1], bass[2], bass[3]], body_size: 1.0, ..plain(49.0) };
    // The bottom of the bass speaks slowly (as on a real bass): measured once it has.
    let a = analyze_note(&p, 1.8, 0.5);
    assert!(a.cents.abs() < 10.0, "bass 49 Hz came out {:.2} Hz ({:+.1} cents)", a.f0, a.cents);
}

#[test]
fn a_new_note_is_not_pulled_out_of_tune_by_the_last_ones_pitch() {
    // The opening of a sample song's cello part: détaché notes, several starting while the bow is
    // still lifting from the one before on the same string. The player's ear once took the previous
    // note's period for the new one's and "corrected" the E (164.81 Hz, after an F on the same
    // string) ~45 cents flat.
    let base = PhysModParams {
        strings: [65.41, 98.0, 146.83, 220.0], body_size: 0.72, bow_force: 0.5, bow_velocity: 0.66, bow_position: 0.1,
        attack_skill: 1.0, vibrato_depth: 6.0, ..Default::default()
    };
    let part: [(f64, f32, f32, f32); 5] = [(0.0, 146.83, 0.403, 0.6), (0.489, 110.0, 0.403, 0.5), (0.978, 146.83, 0.248, 0.5), (1.304, 174.61, 0.403, 0.6), (1.793, 164.81, 0.403, 0.5)];
    let notes: Vec<PerformedNote> = part.iter().map(|&(start, freq, duration, velocity)| PerformedNote { start, params: PhysModParams { freq, duration, velocity, ..base } }).collect();
    let out = left(&render_performance(&notes, 0.1));
    for &(start, freq, duration, _) in &part {
        let (a, b) = (start as f32 + 0.25 * duration, start as f32 + duration);
        let f = pitch(&out[(a * SR) as usize..(b * SR) as usize], SR, freq);
        let cents = 1200.0 * (f / freq).log2();
        println!("{freq} Hz: {cents:+.1} cents");
        assert!(cents.abs() < 12.0, "the note {freq} Hz at {start} s came out {f:.2} Hz ({cents:+.1} cents)");
    }
}

#[test]
fn the_force_control_spans_each_strings_playable_window() {
    // The whole violin keeps the full two-decade control; lower, heavier strings (whose window is
    // narrower) get a proportionally narrower one, so the same setting is the same place in it.
    let v = bow_speed(0.5);
    let span = |open: f32, size: f32, f: f32| force_span(v, string_impedance(open, size, 0.5), f);
    for &f in &[196.0f32, 293.66, 440.0, 1318.5] {
        assert_eq!(span(196.0, 0.0, f), 1.0, "violin {f} Hz");
    }
    let (cello_c, bass_a, bass_e) = (span(65.41, 0.72, 65.41), span(55.0, 1.0, 55.0), span(41.2, 1.0, 41.2));
    assert!(cello_c < 0.7 && bass_a < cello_c && bass_e < bass_a && bass_e > 0.1, "cello C {cello_c:.2}, bass A {bass_a:.2}, bass E {bass_e:.2}");
    // And the knob round-trips through it.
    let c = 1.3;
    assert!((bow_knob_spanned(bow_newtons_spanned(0.7, c, 0.4), c, 0.4) - 0.7).abs() < 1.0e-4);
}

#[test]
fn a_firm_bow_speaks_on_the_cello_and_bass_as_on_the_violin() {
    // 0.35 and 0.66 on the force control: a light and a firm stroke (the sample songs' cellos and
    // basses are bowed at 0.55-0.7). With one fixed scale for every string, 0.66 was above the
    // whole playable window of the low strings and they never settled into Helmholtz motion.
    let cello = [65.41, 98.0, 146.83, 220.0];
    let bass = [41.2, 55.0, 73.42, 98.0];
    for &force in &[0.35f32, 0.66] {
        for (name, strings, size, f) in [("violin", VIOLIN_TUNING, 0.0, 196.0), ("cello", cello, 0.72, 65.41), ("cello", cello, 0.72, 87.31), ("bass", bass, 1.0, 55.0), ("bass", bass, 1.0, 73.42)] {
            let p = PhysModParams { strings, body_size: size, bow_force: force, ..plain(f) };
            let (secs, win) = timing(f);
            assert!(clean_helmholtz(&p, secs, win), "{name} {f} Hz at force {force} did not settle");
        }
    }
}

// ---------------------------------------------------------------- Helmholtz motion

#[test]
fn a_normal_stroke_settles_into_helmholtz_motion() {
    // One stick-slip release per period, and the string stuck to the bow for about 1 - beta of it:
    // the two textbook signatures of Helmholtz motion.
    for &(f, beta) in &[(293.66f32, 0.1f32), (440.0, 0.12), (659.25, 0.15)] {
        let p = PhysModParams { bow_position: beta, ..plain(f) };
        let a = analyze_note(&p, 0.8, 0.3);
        assert!((a.slips_per_period - 1.0).abs() < 0.08, "{f} Hz: {} slips per period", a.slips_per_period);
        assert!((a.stick_fraction - (1.0 - beta)).abs() < 0.07, "{f} Hz: stuck {} of the time, expected about {}", a.stick_fraction, 1.0 - beta);
        assert_eq!(a.regime, Some(BowRegime::Helmholtz));
        let attack = a.attack_secs.expect("the stroke should settle");
        assert!(attack < 0.2, "{f} Hz took {attack} s to settle");
    }
}

#[test]
fn too_little_force_near_the_bridge_gives_surface_sound_and_enough_force_cures_it() {
    // Schelleng's lower limit: bowing close to the bridge needs more force; below it the string
    // slips more than once per period (the airy "surface sound").
    let light = PhysModParams { bow_position: 0.05, bow_force: 0.15, ..plain(293.66) };
    let a = analyze_note(&light, 0.8, 0.3);
    assert!(a.slips_per_period > 1.5, "light force near the bridge should multiple-slip, got {}", a.slips_per_period);
    assert_eq!(a.regime, Some(BowRegime::SurfaceSound));
    let firm = PhysModParams { bow_force: 0.75, ..light };
    let b = analyze_note(&firm, 0.8, 0.3);
    assert!((b.slips_per_period - 1.0).abs() < 0.08, "a firm bow should restore Helmholtz motion, got {}", b.slips_per_period);
}

#[test]
fn the_minimum_bow_force_rises_steeply_as_the_bow_nears_the_bridge() {
    // Schelleng: F_min ~ 1/beta^2. Find the smallest force knob giving Helmholtz motion at two bow
    // positions and check the ratio of forces is well beyond 1/beta alone.
    let min_knob = |beta: f32| {
        (0..20)
            .map(|i| i as f32 * 0.05)
            .find(|&k| {
                let p = PhysModParams { bow_position: beta, bow_force: k, attack_skill: 1.0, ..plain(293.66) };
                let a = analyze_note(&p, 0.7, 0.25);
                (a.slips_per_period - 1.0).abs() < 0.08
            })
            .unwrap_or(1.0)
    };
    let (near, far) = (min_knob(0.05), min_knob(0.13));
    let center = force_center(bow_speed(0.5) * 0.86, string_impedance(293.66, 0.0, 0.5), 293.66);
    let (f_near, f_far) = (bow_newtons(near, center), bow_newtons(far, center));
    // beta ratio 2.6: 1/beta predicts x2.6, 1/beta^2 predicts x6.8.
    assert!(f_near / f_far > 3.5, "F_min near the bridge {f_near:.3} N vs further away {f_far:.3} N");
}

#[test]
fn too_much_force_turns_the_tone_raucous() {
    let p = PhysModParams { bow_position: 0.13, bow_force: 1.0, bow_velocity: 0.3, ..plain(293.66) };
    let a = analyze_note(&p, 0.8, 0.3);
    assert_ne!(a.regime, Some(BowRegime::Helmholtz), "a crushing bow should not give clean Helmholtz motion ({} slips/period)", a.slips_per_period);
}

// ---------------------------------------------------------------- what the controls do

#[test]
fn a_faster_bow_is_louder() {
    // Helmholtz amplitude is proportional to bow speed (at a force inside the window): a bow twice as
    // fast should be close to 6 dB louder.
    let slow = PhysModParams { bow_velocity: 0.35, ..plain(440.0) };
    let fast = PhysModParams { bow_velocity: 0.35 + (2.0f32).ln() / 25f32.ln(), bow_force: 0.5 + 0.5 * (2.0f32).log10(), ..plain(440.0) };
    assert!((bow_speed(fast.bow_velocity) / bow_speed(slow.bow_velocity) - 2.0).abs() < 1.0e-3);
    let (a, b) = (analyze_note(&slow, 0.8, 0.3), analyze_note(&fast, 0.8, 0.3));
    let gain = b.rms_db - a.rms_db;
    assert!((gain - 6.0).abs() < 2.5, "doubling bow speed changed the level by {gain:.1} dB");
}

#[test]
fn bowing_nearer_the_bridge_is_brighter() {
    let base = PhysModParams { body_mix: 0.0, ..plain(293.66) };
    let tasto = analyze_note(&PhysModParams { bow_position: 0.2, bow_force: 0.35, ..base }, 0.8, 0.3);
    let ponticello = analyze_note(&PhysModParams { bow_position: 0.05, bow_force: 0.8, ..base }, 0.8, 0.3);
    assert!(ponticello.centroid_hz > tasto.centroid_hz * 1.15, "ponticello {:.0} Hz vs tasto {:.0} Hz", ponticello.centroid_hz, tasto.centroid_hz);
}

#[test]
fn more_bow_force_brightens_the_tone() {
    let base = PhysModParams { body_mix: 0.0, bow_position: 0.1, ..plain(440.0) };
    let soft = analyze_note(&PhysModParams { bow_force: 0.35, ..base }, 0.8, 0.3);
    let hard = analyze_note(&PhysModParams { bow_force: 0.7, ..base }, 0.8, 0.3);
    assert!(hard.centroid_hz > soft.centroid_hz * 1.03, "{:.0} Hz then {:.0} Hz", soft.centroid_hz, hard.centroid_hz);
}

#[test]
fn vibrato_moves_the_pitch_by_its_depth() {
    // 1 Hz, 50 cents: pitch measured at a crest and a trough of the vibrato cycle (after its onset
    // delay and fade-in) should differ by about twice the depth.
    let p = PhysModParams { freq: 330.0, vibrato_rate: 1.0, vibrato_depth: 50.0, vibrato_delay: 0.0, duration: 3.0, ..plain(330.0) };
    let out = left(&render_note(Arc::new(PhysModShared::default()), p, 2.0));
    let win = 2048;
    // The control clock starts at note-on; sin peaks at t = 0.25 + k and troughs at 0.75 + k.
    let at = |t: f32| pitch(&out[(t * SR) as usize - win / 2..(t * SR) as usize + win / 2], SR, 330.0);
    let (hi, lo) = (at(1.25), at(1.75));
    let spread = 1200.0 * (hi / lo).log2();
    assert!((spread - 100.0).abs() < 20.0, "crest {hi:.2} Hz, trough {lo:.2} Hz: {spread:.1} cents apart");
}

#[test]
fn open_strings_have_no_vibrato() {
    // Nothing to roll a finger on: the open A played with vibrato still holds a steady pitch.
    let p = PhysModParams { vibrato_rate: 1.0, vibrato_depth: 50.0, vibrato_delay: 0.0, duration: 3.0, ..plain(440.0) };
    let out = left(&render_note(Arc::new(PhysModShared::default()), p, 2.0));
    let at = |t: f32| pitch(&out[(t * SR) as usize - 1024..(t * SR) as usize + 1024], SR, 440.0);
    let spread = 1200.0 * (at(1.25) / at(1.75)).log2();
    assert!(spread.abs() < 4.0, "open string drifted {spread:.1} cents");
}

// ---------------------------------------------------------------- articulations

#[test]
fn pizzicato_plucks_in_tune_and_decays() {
    let p = PhysModParams { articulation: Articulation::Pizzicato, ring: 1.0, duration: 2.0, ..plain(392.0) };
    let out = left(&render_note(Arc::new(PhysModShared::default()), p, 1.2));
    let early = &out[(0.03 * SR) as usize..(0.13 * SR) as usize];
    let late = &out[(0.9 * SR) as usize..(1.0 * SR) as usize];
    let a = measure(early, SR, 392.0);
    assert!(a.cents.abs() < 8.0, "pizzicato pitch {:.2} Hz", a.f0);
    let decay = rms_db(early) - rms_db(late);
    assert!(decay > 10.0, "a pluck should die away, fell only {decay:.1} dB");
}

#[test]
fn col_legno_is_a_brighter_shorter_strike_than_pizzicato() {
    let pizz = PhysModParams { articulation: Articulation::Pizzicato, duration: 1.0, ..plain(392.0) };
    let wood = PhysModParams { articulation: Articulation::ColLegno, ..pizz };
    let a = left(&render_note(Arc::new(PhysModShared::default()), pizz, 0.3));
    let b = left(&render_note(Arc::new(PhysModShared::default()), wood, 0.3));
    let seg = |x: &[f32]| x[(0.01 * SR) as usize..(0.09 * SR) as usize].to_vec();
    let (ma, mb) = (measure(&seg(&a), SR, 392.0), measure(&seg(&b), SR, 392.0));
    assert!(mb.centroid_hz > ma.centroid_hz, "col legno {:.0} Hz vs pizzicato {:.0} Hz", mb.centroid_hz, ma.centroid_hz);
}

// ---------------------------------------------------------------- the instrument as a whole

#[test]
fn notes_go_to_the_string_a_player_would_use() {
    let e = Engine::new(SR, &PhysModParams::default());
    assert_eq!(e.choose_string(196.0), 0, "open G on the G string");
    assert_eq!(e.choose_string(250.0), 0);
    assert_eq!(e.choose_string(293.66), 1, "open D on the D string");
    assert_eq!(e.choose_string(500.0), 2);
    assert_eq!(e.choose_string(1500.0), 3);
    assert_eq!(e.choose_string(100.0), 0, "below the range: the lowest string");
}

#[test]
fn a_second_note_while_the_first_is_held_is_a_double_stop_on_the_next_string_down() {
    let mut e = Engine::new(SR, &plain(440.0));
    let a = e.note_on(1, plain(659.25), true, None);
    let b = e.note_on(2, plain(700.0), true, None);
    assert_eq!(a, 3);
    assert_eq!(b, 2, "the E string is busy, so the A string (which can reach 700 Hz) takes it");
    let mut out = Vec::new();
    for _ in 0..(0.8 * SR) as usize {
        out.push(e.next_frame()[0]);
    }
    let seg = &out[(0.5 * SR) as usize..];
    let (mags, bin) = super::analysis::spectrum(seg, SR);
    let at = |f: f32| mags[((f / bin) as usize).saturating_sub(2)..(f / bin) as usize + 3].iter().fold(0.0f32, |m, v| m.max(*v));
    let floor = at(680.0);
    assert!(at(659.25) > floor * 5.0 && at(700.0) > floor * 5.0, "both notes of the double stop should sound");
}

#[test]
fn a_slur_moves_the_finger_without_stopping_the_bow() {
    let mut e = Engine::new(SR, &plain(440.0));
    let first = PhysModParams { slide: 0.03, ..plain(523.25) };
    let s1 = e.note_on(1, first, true, None);
    let mut out = Vec::new();
    for _ in 0..(0.5 * SR) as usize {
        out.push(e.next_frame()[0]);
    }
    // Overlapping note on the same string: legato.
    let s2 = e.note_on(2, PhysModParams { slide: 0.03, ..plain(587.33) }, true, None);
    e.note_off(1);
    assert_eq!(s1, s2, "a slur stays on the string");
    let mut min_env = f32::MAX;
    for i in 0..(0.5 * SR) as usize {
        let v = e.next_frame()[0];
        out.push(v);
        // The bow never stops during a slur, so the sound never drops out.
        if i % 441 == 440 {
            let w = &out[out.len() - 441..];
            min_env = min_env.min(rms_db(w));
        }
    }
    let steady = rms_db(&out[(0.3 * SR) as usize..(0.5 * SR) as usize]);
    assert!(min_env > steady - 12.0, "the slur dipped to {min_env:.1} dB against a steady {steady:.1} dB");
    let after = measure(&out[(0.8 * SR) as usize..], SR, 587.33);
    assert!(after.cents.abs() < 8.0, "the slurred note should arrive at 587 Hz, got {:.2}", after.f0);
    assert!(e.string(s2).stopped());
}

#[test]
fn an_open_string_rings_in_sympathy_with_a_note_it_shares_a_harmonic_with() {
    // G4 (392 Hz) bowed on the D string: the open G string's second harmonic is 392 Hz, so energy
    // crosses the bridge and sets it ringing. F#4 (370 Hz) shares nothing with it.
    let ring_of = |freq: f32| {
        let mut e = Engine::new(SR, &plain(freq));
        let s = e.note_on(1, plain(freq), true, None);
        assert_eq!(s, 1);
        for _ in 0..(1.0 * SR) as usize {
            e.next_frame();
        }
        e.string(0).level
    };
    let (match_, mismatch) = (ring_of(392.0), ring_of(370.0));
    assert!(match_ > mismatch * 4.0, "open G rang at {match_:.2e} for G4 and {mismatch:.2e} for F#4");
}

#[test]
fn coupling_controls_how_much_the_strings_hear_each_other() {
    let ring_with = |coupling: f32| {
        let p = PhysModParams { coupling, ..plain(392.0) };
        let mut e = Engine::new(SR, &p);
        e.note_on(1, p, true, None);
        for _ in 0..(1.0 * SR) as usize {
            e.next_frame();
        }
        e.string(0).level
    };
    let (none, normal, strong) = (ring_with(0.0), ring_with(0.35), ring_with(0.9));
    assert!(none < normal * 0.1, "no coupling: {none:.2e} vs normal {normal:.2e}");
    assert!(strong > normal * 1.5, "strong coupling: {strong:.2e} vs normal {normal:.2e}");
}

#[test]
fn sympathetic_strings_ring_along_when_tuned_to_the_note() {
    let symp = [440.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    let p = PhysModParams { sympathetic: symp, ..plain(440.0) };
    let mut e = Engine::new(SR, &p);
    assert_eq!(e.string_count(), (4, 1));
    e.note_on(1, p, true, None);
    for _ in 0..(1.0 * SR) as usize {
        e.next_frame();
    }
    let tuned = e.string(4).level;
    let p2 = PhysModParams { sympathetic: [415.3, 0.0, 0.0, 0.0, 0.0, 0.0], ..p };
    let mut e2 = Engine::new(SR, &p2);
    e2.note_on(1, p2, true, None);
    for _ in 0..(1.0 * SR) as usize {
        e2.next_frame();
    }
    let detuned = e2.string(4).level;
    assert!(tuned > detuned * 4.0, "tuned sympathetic string {tuned:.2e}, a semitone off {detuned:.2e}");
}

#[test]
fn a_bigger_body_moves_its_resonances_down() {
    let violin = Engine::new(SR, &PhysModParams::default());
    let cello = Engine::new(SR, &PhysModParams { body_size: 0.72, ..Default::default() });
    let (fv, _) = violin.body_modes();
    let (fc, _) = cello.body_modes();
    // The A0 air mode: ~275 Hz on a violin, ~100 Hz on a cello.
    assert!((240.0..310.0).contains(&fv[0]), "violin A0 at {}", fv[0]);
    assert!((85.0..120.0).contains(&fc[0]), "cello A0 at {}", fc[0]);
}

#[test]
fn the_body_colours_the_sound() {
    let bare = analyze_note(&PhysModParams { body_mix: 0.0, ..plain(440.0) }, 0.7, 0.3);
    let bodied = analyze_note(&PhysModParams { body_mix: 1.0, ..plain(440.0) }, 0.7, 0.3);
    let diff: f32 = bare.harmonics_db.iter().zip(bodied.harmonics_db.iter()).map(|(a, b)| (a - b).abs()).sum::<f32>() / HARMONICS_F;
    assert!(diff > 3.0, "the body should reshape the harmonic balance (mean change {diff:.1} dB)");
    assert!((bodied.rms_db - bare.rms_db).abs() < 8.0, "but not change the level much: {:.1} vs {:.1} dB", bodied.rms_db, bare.rms_db);
}

const HARMONICS_F: f32 = super::analysis::HARMONICS as f32;

#[test]
fn stiffer_strings_stretch_their_partials_sharp() {
    let partial_ratio = |stiffness: f32| {
        let p = PhysModParams { articulation: Articulation::Pizzicato, stiffness, body_mix: 0.0, ring: 1.0, duration: 2.0, ..plain(220.0) };
        let out = left(&render_note(Arc::new(PhysModShared::default()), p, 0.6));
        let seg = &out[(0.05 * SR) as usize..(0.55 * SR) as usize];
        let (mags, bin) = super::analysis::spectrum(seg, SR);
        let peak_near = |f: f32| {
            let (lo, hi) = (((f * 0.97) / bin) as usize, ((f * 1.08) / bin) as usize);
            let k = (lo..hi).max_by(|&a, &b| mags[a].total_cmp(&mags[b])).unwrap();
            k as f32 * bin
        };
        let f1 = peak_near(220.0);
        peak_near(220.0 * 8.0) / (8.0 * f1)
    };
    let (flexible, stiff) = (partial_ratio(0.0), partial_ratio(0.8));
    assert!((flexible - 1.0).abs() < 0.006, "a flexible string's 8th partial should be harmonic, ratio {flexible}");
    assert!(stiff > flexible + 0.01, "a stiff string's 8th partial should be sharp: {stiff} vs {flexible}");
}

// ---------------------------------------------------------------- robustness

#[test]
fn output_stays_bounded_across_the_laboratory() {
    // Extreme and impossible instruments included: tiny and giant bodies, crushing force, heavy and
    // weightless strings, maximal coupling and stiffness.
    for &body_size in &[-1.0f32, 0.0, 1.0, 2.5] {
        for &force in &[0.0f32, 0.5, 1.0] {
            for &(speed, pos) in &[(0.0f32, 0.02f32), (1.0, 0.5), (0.5, 0.12)] {
                for &(mass, coupling, stiffness) in &[(0.0f32, 1.0f32, 1.0f32), (1.0, 0.0, 0.0), (0.5, 1.0, 0.5)] {
                    let p = PhysModParams {
                        freq: 110.0 * 4f32.powf(-body_size * 0.5).max(0.3) * 2.0,
                        bow_force: force,
                        bow_velocity: speed,
                        bow_position: pos,
                        string_mass: mass,
                        coupling,
                        stiffness,
                        body_size,
                        velocity: 1.0,
                        duration: 0.25,
                        ..Default::default()
                    };
                    let out = render_note(Arc::new(PhysModShared::default()), p, 0.35);
                    for v in &out {
                        assert!(v.is_finite() && v.abs() <= 4.0, "{v} at size {body_size} force {force} speed {speed} pos {pos} mass {mass} coupling {coupling}");
                    }
                }
            }
        }
    }
}

#[test]
fn a_timed_note_ends_by_itself_and_a_gated_note_waits_for_its_gate() {
    let p = PhysModParams { duration: 0.2, release: 0.05, ring: 0.0, ..plain(330.0) };
    let timed = render_note(Arc::new(PhysModShared::default()), p, 10.0);
    let secs = timed.len() as f32 / 2.0 / SR;
    assert!((0.2..1.5).contains(&secs), "a 0.2 s note with a dry release should be over well within a second and a half, took {secs}");

    let gate = Arc::new(AtomicBool::new(true));
    let mut voice = PhysModVoice::new(Arc::new(PhysModShared::default()), p, Some(gate.clone()));
    let held: Vec<f32> = voice.by_ref().take(2 * 44_100).collect();
    assert_eq!(held.len(), 2 * 44_100, "a held gate must keep the note alive");
    gate.store(false, Ordering::Relaxed);
    let tail = voice.count() as f32 / 2.0 / SR;
    assert!(tail < 1.5, "the note should end soon after the gate drops ({tail} s)");
}

#[test]
fn ring_lets_a_released_note_sustain() {
    let tail_level = |ring: f32| {
        let p = PhysModParams { duration: 0.4, release: 0.05, ring, ..plain(523.25) };
        let out = left(&render_note(Arc::new(PhysModShared::default()), p, 1.0));
        rms_db(&out[(0.7 * SR) as usize..(0.8 * SR).min(out.len() as f32) as usize])
    };
    let (dry, ringing) = (tail_level(0.0), tail_level(1.0));
    assert!(ringing > dry + 15.0, "ring 1 tail {ringing:.1} dB vs ring 0 {dry:.1} dB");
}

#[test]
fn live_bow_control_reaches_an_already_playing_note() {
    let p = PhysModParams { bow_force: 0.35, body_mix: 0.0, ..plain(440.0) };
    let live = Arc::new(PhysModLive::from_params(&p));
    let gate = Arc::new(AtomicBool::new(true));
    let mut voice = PhysModVoice::new(Arc::new(PhysModShared::default()), p, Some(gate)).with_live_bow(live.clone());
    let _ = voice.by_ref().take(2 * (0.4 * SR) as usize).count();
    let before = left(&voice.by_ref().take(2 * 8192).collect::<Vec<_>>());
    live.bow_velocity.store(0.85f32.to_bits(), Ordering::Relaxed);
    live.bow_force.store(0.75f32.to_bits(), Ordering::Relaxed);
    let _ = voice.by_ref().take(2 * (0.3 * SR) as usize).count();
    let after = left(&voice.by_ref().take(2 * 8192).collect::<Vec<_>>());
    assert!(rms_db(&after) > rms_db(&before) + 4.0, "a faster, firmer bow should be louder: {:.1} then {:.1} dB", rms_db(&before), rms_db(&after));
}

#[test]
fn the_shared_state_describes_every_string_while_a_note_sounds() {
    let shared = Arc::new(PhysModShared::default());
    assert_eq!(shared.active_voices(), 0);
    assert!(shared.activity().is_none());
    let mut voice = PhysModVoice::new(shared.clone(), PhysModParams { duration: 1.0, ..plain(523.25) }, None);
    assert_eq!(shared.active_voices(), 1);
    let _ = voice.by_ref().take(2 * (0.5 * SR) as usize).count();
    assert!(shared.activity().is_some());
    assert_eq!(shared.string_count(), 4);
    assert_eq!(shared.active_string(), Some(2), "C5 goes on the A string");
    let a = shared.string_info(2);
    assert!(a.playing && a.bowed && !a.sympathetic);
    // Within the player's intonation correction of the written pitch.
    assert!((a.freq / 523.25 - 1.0).abs() < 0.01, "finger stopping {} Hz", a.freq);
    assert!((a.finger - (1.0 - 440.0 / 523.25)).abs() < 0.02, "finger at {}", a.finger);
    assert_eq!(a.regime(), BowRegime::Helmholtz);
    assert!(a.force_min < a.bow_force && a.bow_force < a.force_max, "the bow force {} should be inside the window {}..{}", a.bow_force, a.force_min, a.force_max);
    let shape: Vec<f32> = (0..SHAPE_POINTS).map(|k| shared.string_shape_at(2, k)).collect();
    assert!(shape[0].abs() < 1.0e-6 && shape[SHAPE_POINTS - 1].abs() < 1.0e-6, "the string is pinned at both ends");
    assert!(shape.iter().any(|v| v.abs() > 1.0e-6), "and moving in between");
    let (f0, _) = shared.body_mode(0);
    assert!(f0 > 200.0);
    drop(voice);
    assert_eq!(shared.active_voices(), 0);
}

#[test]
fn a_live_instrument_plays_queued_notes_and_shuts_down_when_idle() {
    let shared = Arc::new(PhysModShared::default());
    let p = PhysModParams { duration: 0.2, release: 0.05, ring: 0.0, ..plain(440.0) };
    let (mut voice, handle) = PhysModInstrumentVoice::new(shared.clone(), &p);
    assert!(handle.same_tuning(&p));
    assert!(!handle.same_tuning(&PhysModParams { strings: [65.41, 98.0, 146.83, 220.0], ..p }));
    handle.send(InstrumentCommand::NoteOn { id: 7, params: p, gated: false, live: None }).ok().unwrap();
    let first: Vec<f32> = voice.by_ref().take(2 * (0.15 * SR) as usize).collect();
    assert!(rms_db(&left(&first)) > -40.0, "the queued note should sound");
    let total = voice.by_ref().count() as f32 / 2.0 / SR;
    assert!(total < INSTRUMENT_IDLE_SECS + 2.0, "an idle instrument should stop itself, ran {total} s more");
    assert!(!handle.is_alive());
    assert!(handle.send(InstrumentCommand::NoteOff { id: 7 }).is_err(), "a stopped instrument hands commands back");
}

#[test]
fn a_rendered_performance_slurs_overlapping_notes_on_one_instrument() {
    let a = PerformedNote { start: 0.0, params: PhysModParams { duration: 0.6, ..plain(523.25) } };
    let b = PerformedNote { start: 0.5, params: PhysModParams { duration: 0.5, ..plain(587.33) } };
    let out = left(&render_performance(&[a, b], 1.0));
    assert!(out.len() as f32 > 1.0 * SR);
    let late = measure(&out[(0.8 * SR) as usize..(0.95 * SR) as usize], SR, 587.33);
    assert!(late.cents.abs() < 10.0, "the second note should be sounding: {:.2} Hz", late.f0);
    // No gap between the two notes.
    let seam = rms_db(&out[(0.5 * SR) as usize..(0.6 * SR) as usize]);
    let steady = rms_db(&out[(0.3 * SR) as usize..(0.45 * SR) as usize]);
    assert!(seam > steady - 10.0, "seam {seam:.1} dB vs {steady:.1} dB");
}

// ---------------------------------------------------------------- reports (ignored)
//
// These print the numbers, and write the pictures, that the Indie Machine strings post quotes. They
// assert almost nothing. Run one with
//   cargo test --release --lib physmod::tests::strings_tuning_report -- --ignored --nocapture
// (names: strings_tuning_report, strings_waveforms_report, strings_schelleng_report,
// strings_schelleng_no_player_report, strings_schelleng_uncoupled_report, strings_behaviour_report,
// strings_cost_report). Pictures land in `test-artifacts/physmod-strings/`.

fn profile() -> &'static str {
    if cfg!(debug_assertions) { "debug" } else { "release" }
}

fn art_dir() -> std::path::PathBuf {
    let d = std::env::current_dir().unwrap().join("test-artifacts").join("physmod-strings");
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn cello() -> PhysModParams {
    PhysModParams { strings: [65.41, 98.0, 146.83, 220.0], body_size: 0.72, ..plain(220.0) }
}

fn bass() -> PhysModParams {
    PhysModParams { strings: [41.2, 55.0, 73.42, 98.0], body_size: 1.0, ..plain(98.0) }
}

/// (seconds rendered, seconds analysed) that give a note of this pitch time to settle.
fn timing(freq: f32) -> (f32, f32) {
    if freq < 100.0 {
        (1.8, 0.5)
    } else if freq < 150.0 {
        (1.0, 0.3)
    } else {
        (0.7, 0.25)
    }
}

#[test]
#[ignore]
fn strings_tuning_report() {
    println!("profile: {}", profile());
    let row = |name: &str, p: &PhysModParams| {
        let (secs, win) = timing(p.freq);
        let a = analyze_note(p, secs, win);
        let attack = a.attack_secs.map_or("never".to_string(), |s| format!("{s:.3} s"));
        println!("{name:<7} {:>8.2} Hz  measured {:>8.2} Hz  {:+6.1} cents  slips/period {:.2}  stuck {:.2}  settled {attack}  {:?}", p.freq, a.f0, a.cents, a.slips_per_period, a.stick_fraction, a.regime.unwrap());
    };
    for &f in &[196.0f32, 261.63, 293.66, 349.23, 440.0, 523.25, 659.25, 880.0, 1174.66, 1318.5, 1567.98] {
        row("violin", &plain(f));
    }
    for &f in &[65.41f32, 98.0, 110.0, 146.83, 196.0, 220.0, 329.63] {
        row("cello", &PhysModParams { freq: f, ..cello() });
    }
    for &f in &[41.2f32, 49.0, 55.0, 73.42, 98.0, 146.83] {
        row("bass", &PhysModParams { freq: f, ..bass() });
    }
    println!("-- stiffness: partial 8 against 8 x the fundamental, pizzicato A3");
    for &st in &[0.0f32, 0.1, 0.4, 0.8, 1.0] {
        let p = PhysModParams { articulation: Articulation::Pizzicato, stiffness: st, body_mix: 0.0, ring: 1.0, duration: 2.0, ..plain(220.0) };
        let out = left(&render_note(Arc::new(PhysModShared::default()), p, 0.6));
        let seg = &out[(0.05 * SR) as usize..(0.55 * SR) as usize];
        let (mags, bin) = super::analysis::spectrum(seg, SR);
        let peak_near = |f: f32| {
            let (lo, hi) = (((f * 0.97) / bin) as usize, ((f * 1.08) / bin) as usize);
            (lo..hi).max_by(|&a, &b| mags[a].total_cmp(&mags[b])).unwrap() as f32 * bin
        };
        let f1 = peak_near(220.0);
        let ratio = peak_near(220.0 * 8.0) / (8.0 * f1);
        let b = super::string::inharmonicity(st);
        let ideal = (1.0 + 64.0 * b).sqrt() / (1.0 + b).sqrt();
        println!("stiffness {st:.1}: B = {b:.2e}, partial 8 / (8 x f1) = {ratio:.4} (theory {ideal:.4})");
    }
}

/// Draws one polyline into an SVG panel: y scaled symmetrically about zero.
fn panel(svg: &mut String, x: f32, y: f32, w: f32, h: f32, ys: &[f32], stroke: &str, label: &str, unit: &str, reference: Option<f32>) {
    let peak = ys.iter().fold(1.0e-9f32, |m, v| m.max(v.abs())).max(reference.map_or(0.0, f32::abs));
    let sy = |v: f32| y + h * 0.5 - v / peak * h * 0.46;
    svg.push_str(&format!("<rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" fill=\"#ffffff\" stroke=\"#c9c4b8\"/>"));
    svg.push_str(&format!("<line x1=\"{x}\" y1=\"{0}\" x2=\"{1}\" y2=\"{0}\" stroke=\"#c9c4b8\" stroke-dasharray=\"2 3\"/>", y + h * 0.5, x + w));
    if let Some(r) = reference {
        svg.push_str(&format!("<line x1=\"{x}\" y1=\"{0}\" x2=\"{1}\" y2=\"{0}\" stroke=\"#b5462d\" stroke-width=\"2\" stroke-dasharray=\"5 4\"/>", sy(r), x + w));
    }
    let pts: Vec<String> = ys.iter().enumerate().map(|(i, v)| format!("{:.1},{:.1}", x + w * i as f32 / (ys.len() - 1) as f32, sy(*v))).collect();
    svg.push_str(&format!("<polyline points=\"{}\" fill=\"none\" stroke=\"{stroke}\" stroke-width=\"1.6\"/>", pts.join(" ")));
    svg.push_str(&format!("<text x=\"{x}\" y=\"{}\" font-size=\"11\" fill=\"#55524a\">{label}</text>", y - 5.0));
    svg.push_str(&format!("<text x=\"{}\" y=\"{}\" font-size=\"11\" fill=\"#55524a\" text-anchor=\"end\">peak {peak:.3} {unit}</text>", x + w, y - 5.0));
}

#[test]
#[ignore]
fn strings_waveforms_report() {
    println!("profile: {}", profile());
    let cases: [(&str, f32, f32, f32); 3] = [("Helmholtz motion", 0.13, 0.5, 0.5), ("Surface sound (too little force)", 0.05, 0.15, 0.5), ("Raucous (too much force)", 0.13, 1.0, 0.3)];
    let mut svg = String::new();
    let (w, row_h, gap) = (430.0f32, 120.0f32, 58.0f32);
    let total_h = 3.0 * (row_h + gap) + 8.0;
    svg.push_str(&format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {total_h}\" font-family=\"sans-serif\">", 2.0 * w + 50.0));
    svg.push_str("<rect width=\"100%\" height=\"100%\" fill=\"#f7f6f2\"/>");
    for (i, &(name, beta, force, speed)) in cases.iter().enumerate() {
        let p = PhysModParams { bow_position: beta, bow_force: force, bow_velocity: speed, ..plain(293.66) };
        let a = analyze_note(&p, 0.8, 0.3);
        let mut e = Engine::new(SR, &p);
        let s = e.note_on(1, p, true, None);
        for _ in 0..(0.6 * SR) as usize {
            e.next_frame();
        }
        let n = (4.0 * SR / p.freq) as usize;
        let (mut v, mut f) = (Vec::with_capacity(n), Vec::with_capacity(n));
        for _ in 0..n {
            e.next_frame();
            v.push(e.string(s).last_v);
            f.push(e.string(s).last_force);
        }
        let v_bow = bow_speed(speed) * (0.3 + 0.7 * p.velocity);
        println!("{name}: bow position {beta}, force knob {force}, speed knob {speed} ({v_bow:.3} m/s): slips/period {:.2}, stuck {:.2}, regime {:?}", a.slips_per_period, a.stick_fraction, a.regime.unwrap());
        let y0 = 48.0 + i as f32 * (row_h + gap);
        svg.push_str(&format!("<text x=\"20\" y=\"{}\" font-size=\"13\" font-weight=\"bold\" fill=\"#2a2925\">{name} - {:.2} slips per period, stuck {:.0}% of the time</text>", y0 - 26.0, a.slips_per_period, a.stick_fraction * 100.0));
        panel(&mut svg, 20.0, y0, w, row_h, &v, "#1f5f8b", "string velocity at the bow (dashed red: bow speed)", "m/s", Some(v_bow));
        panel(&mut svg, 30.0 + w, y0, w, row_h, &f, "#7a4b1e", "force on the bridge", "N", None);
    }
    svg.push_str(&format!("<text x=\"20\" y=\"{}\" font-size=\"11\" fill=\"#55524a\">D4 (293.66 Hz), four periods (13.6 ms) each, taken 0.6 s into a held note</text>", total_h - 6.0));
    svg.push_str("</svg>");
    let path = art_dir().join("bow-regimes.svg");
    std::fs::write(&path, svg).unwrap();
    println!("wrote {}", path.display());
}

struct Edges {
    knob_lo: Option<f32>,
    knob_hi: Option<f32>,
    center: f32,
    fit: (f32, f32),
    holes: bool,
}

/// One note held for `secs`: is it clean Helmholtz motion over the last `win` seconds? One release per
/// period (within 8%) that also arrives regularly - the string's own running confidence, which is the
/// measure the player's ear waits for before it corrects a pitch - so a raucous note that happens to
/// average one release per period does not count.
fn clean_helmholtz(p: &PhysModParams, secs: f32, win: f32) -> bool {
    let p = PhysModParams { duration: secs + 1.0, ..*p };
    let mut e = Engine::new(SR, &p);
    let s = e.note_on(1, p, false, None);
    let n = (secs * SR) as usize;
    let w0 = n.saturating_sub((win * SR) as usize);
    let mut reports = [StringReport::default(); MAX_ALL_STRINGS];
    for i in 0..n {
        if i == w0 {
            e.report(&mut reports);
        }
        e.next_frame();
    }
    e.report(&mut reports);
    (reports[s].slips_per_period - 1.0).abs() < 0.08 && e.string(s).helmholtz_confidence > 0.95
}

fn window_edges(base: &PhysModParams, beta: f32) -> Edges {
    let p0 = PhysModParams { bow_position: beta, ..*base };
    let e = Engine::new(SR, &p0);
    let s = e.choose_string(p0.freq);
    let (open, z) = (e.string(s).spec.open_freq, e.string(s).spec.impedance);
    let v = bow_speed(p0.bow_velocity) * (0.3 + 0.7 * p0.velocity);
    let z_nominal = string_impedance(open, p0.body_size, 0.5);
    let center = force_center(v, z_nominal, p0.freq);
    // `PhysModParams::friction` is private to the engine: rosin 0.5 is mu_s 0.8, mu_d 0.3, v0 0.11.
    let curve = super::friction::FrictionCurve { mu_s: 0.8, mu_d: 0.3, v0: 0.11 };
    let fit = schelleng_window(v, beta, z, &curve, p0.freq);
    let (secs, win) = timing(p0.freq);
    const STEPS: usize = 40;
    let good: Vec<bool> = (0..=STEPS).map(|i| clean_helmholtz(&PhysModParams { bow_force: i as f32 / STEPS as f32, ..p0 }, secs, win)).collect();
    // The window is the longest unbroken run of clean knob settings; anything clean outside it is
    // counted, not used.
    let (mut best, mut cur_start, mut runs) = ((0usize, 0usize), None::<usize>, 0usize);
    for i in 0..=STEPS + 1 {
        let g = i <= STEPS && good[i];
        match (g, cur_start) {
            (true, None) => cur_start = Some(i),
            (false, Some(st)) => {
                runs += 1;
                if i - st > best.1 - best.0 {
                    best = (st, i);
                }
                cur_start = None;
            }
            _ => {}
        }
    }
    let (first, last) = (best.0, best.1.saturating_sub(1));
    let have = best.1 > best.0;
    let lo = if have && first > 0 { Some((first as f32 - 0.5) / STEPS as f32) } else { None };
    let hi = if have && last < STEPS { Some((last as f32 + 0.5) / STEPS as f32) } else { None };
    Edges { knob_lo: lo, knob_hi: hi, center, fit, holes: runs > 1 }
}

/// Least-squares slope of ln(force) against ln(beta): (slope, intercept, sxx).
fn ln_fit(pts: &[(f32, f32)]) -> Option<(f32, f32, f32)> {
    if pts.len() < 3 {
        return None;
    }
    let n = pts.len() as f32;
    let (mx, my) = (pts.iter().map(|p| p.0.ln()).sum::<f32>() / n, pts.iter().map(|p| p.1.ln()).sum::<f32>() / n);
    let sxx: f32 = pts.iter().map(|p| (p.0.ln() - mx).powi(2)).sum();
    let sxy: f32 = pts.iter().map(|p| (p.0.ln() - mx) * (p.1.ln() - my)).sum();
    Some((sxy / sxx, my - sxy / sxx * mx, sxx))
}

struct SweepNote {
    name: &'static str,
    freq: f32,
    speed: f32,
    z: f32,
    pts: Vec<(f32, Option<f32>, Option<f32>)>,
}

fn schelleng_sweep(label: &str, notes: &[(&'static str, PhysModParams)]) -> Vec<SweepNote> {
    const BETAS: [f32; 6] = [0.04, 0.06, 0.09, 0.13, 0.2, 0.3];
    println!("profile: {}  |  {label}", profile());
    println!("{:<10} {:>8} {:>6} {:>10} {:>10} {:>10} {:>10}", "note", "Hz", "beta", "F_min N", "F_max N", "fit min", "fit max");
    let (mut min_num, mut min_den, mut max_num, mut max_den) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    let (mut min_ratios, mut max_ratios) = (Vec::new(), Vec::new());
    let (mut censored_lo, mut censored_hi, mut holes, mut edges) = (0, 0, 0, 0);
    let mut records = Vec::new();
    for (name, base) in notes {
        let (mut lo_pts, mut hi_pts) = (Vec::new(), Vec::new());
        let e0 = Engine::new(SR, base);
        let z0 = e0.string(e0.choose_string(base.freq)).spec.impedance;
        let mut rec = SweepNote { name, freq: base.freq, speed: bow_speed(base.bow_velocity) * (0.3 + 0.7 * base.velocity), z: z0, pts: Vec::new() };
        for &beta in &BETAS {
            let ed = window_edges(base, beta);
            let lo = ed.knob_lo.map(|k| bow_newtons(k, ed.center));
            let hi = ed.knob_hi.map(|k| bow_newtons(k, ed.center));
            println!(
                "{name:<10} {:>8.2} {beta:>6.2} {:>10} {:>10} {:>10.4} {:>10.4}{}",
                base.freq,
                lo.map_or("-".to_string(), |v| format!("{v:.4}")),
                hi.map_or("-".to_string(), |v| format!("{v:.4}")),
                ed.fit.0,
                ed.fit.1,
                if ed.holes { "  (2+ clean runs)" } else { "" }
            );
            if ed.holes {
                holes += 1;
            }
            rec.pts.push((beta, lo, hi));
            match lo {
                Some(v) => {
                    lo_pts.push((beta, v));
                    min_ratios.push(v / ed.fit.0);
                    edges += 1;
                }
                None => censored_lo += 1,
            }
            match hi {
                Some(v) => {
                    hi_pts.push((beta, v));
                    max_ratios.push(v / ed.fit.1);
                    edges += 1;
                }
                None => censored_hi += 1,
            }
        }
        if let Some((s, _, sxx)) = ln_fit(&lo_pts) {
            min_num += s * sxx;
            min_den += sxx;
            println!("{name:<10} {:>8.2} F_min slope {s:+.2} over {} betas", base.freq, lo_pts.len());
        }
        if let Some((s, _, sxx)) = ln_fit(&hi_pts) {
            max_num += s * sxx;
            max_den += sxx;
            println!("{name:<10} {:>8.2} F_max slope {s:+.2} over {} betas", base.freq, hi_pts.len());
        }
        records.push(rec);
    }
    let geo = |v: &[f32]| (v.iter().map(|x| x.ln()).sum::<f32>() / v.len().max(1) as f32).exp();
    let (mn, mx) = (min_ratios.iter().cloned().fold(f32::MAX, f32::min), min_ratios.iter().cloned().fold(0.0, f32::max));
    let (mn2, mx2) = (max_ratios.iter().cloned().fold(f32::MAX, f32::min), max_ratios.iter().cloned().fold(0.0, f32::max));
    println!("pooled slope of F_min against beta: {:+.2}  (Schelleng -2)", min_num / min_den);
    println!("pooled slope of F_max against beta: {:+.2}  (Schelleng -1)", max_num / max_den);
    println!("measured / fitted F_min: geometric mean {:.2}, range {mn:.2} to {mx:.2}", geo(&min_ratios));
    println!("measured / fitted F_max: geometric mean {:.2}, range {mn2:.2} to {mx2:.2}", geo(&max_ratios));
    println!("edges found {edges}, edges outside the force knob's range {censored_lo} low / {censored_hi} high, sweeps with more than one separate clean run {holes}");
    records
}

/// Window edges against bow position on log-log axes, for one note per panel, with the engine's
/// fitted laws (solid) and lines of Schelleng's slopes (-2 and -1, dashed) through the fit at 0.13.
fn plot_window(records: &[&SweepNote], path: &std::path::Path) {
    let curve = super::friction::FrictionCurve { mu_s: 0.8, mu_d: 0.3, v0: 0.11 };
    let (pw, ph, m) = (400.0f32, 300.0f32, 50.0f32);
    let mut svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\" font-family=\"sans-serif\">", records.len() as f32 * (pw + m) + m, ph + 2.0 * m + 20.0);
    svg.push_str("<rect width=\"100%\" height=\"100%\" fill=\"#f7f6f2\"/>");
    let (bx0, bx1, fy0, fy1) = (0.03f32.ln(), 0.35f32.ln(), 0.003f32.ln(), 6.0f32.ln());
    for (k, r) in records.iter().enumerate() {
        let x0 = m + k as f32 * (pw + m);
        let y0 = m;
        let px = |b: f32| x0 + (b.ln() - bx0) / (bx1 - bx0) * pw;
        let py = |f: f32| y0 + ph - (f.max(1.0e-9).ln() - fy0) / (fy1 - fy0) * ph;
        svg.push_str(&format!("<rect x=\"{x0}\" y=\"{y0}\" width=\"{pw}\" height=\"{ph}\" fill=\"#ffffff\" stroke=\"#c9c4b8\"/>"));
        svg.push_str(&format!("<text x=\"{x0}\" y=\"{}\" font-size=\"13\" font-weight=\"bold\" fill=\"#2a2925\">{} {:.1} Hz, bow speed {:.3} m/s</text>", y0 - 14.0, r.name, r.freq, r.speed));
        for &f in &[0.01f32, 0.1, 1.0] {
            svg.push_str(&format!("<line x1=\"{x0}\" y1=\"{0}\" x2=\"{1}\" y2=\"{0}\" stroke=\"#e6e2d8\"/><text x=\"{2}\" y=\"{3}\" font-size=\"10\" fill=\"#55524a\" text-anchor=\"end\">{f} N</text>", py(f), x0 + pw, x0 - 4.0, py(f) + 3.0));
        }
        for &b in &[0.05f32, 0.1, 0.2, 0.3] {
            svg.push_str(&format!("<line x1=\"{0}\" y1=\"{y0}\" x2=\"{0}\" y2=\"{1}\" stroke=\"#e6e2d8\"/><text x=\"{0}\" y=\"{2}\" font-size=\"10\" fill=\"#55524a\" text-anchor=\"middle\">{b}</text>", px(b), y0 + ph, y0 + ph + 14.0));
        }
        svg.push_str(&format!("<text x=\"{}\" y=\"{}\" font-size=\"11\" fill=\"#55524a\" text-anchor=\"middle\">bow position beta (fraction of the string from the bridge)</text>", x0 + pw * 0.5, y0 + ph + 32.0));
        let betas: Vec<f32> = (0..=60).map(|i| (0.03f32.ln() + (0.35f32.ln() - 0.03f32.ln()) * i as f32 / 60.0).exp()).collect();
        let line = |f: &dyn Fn(f32) -> f32, color: &str, dash: &str| {
            let pts: Vec<String> = betas.iter().map(|&b| format!("{:.1},{:.1}", px(b), py(f(b)).clamp(y0, y0 + ph))).collect();
            format!("<polyline points=\"{}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"1.4\" stroke-dasharray=\"{dash}\"/>", pts.join(" "))
        };
        let fit = |b: f32| schelleng_window(r.speed, b, r.z, &curve, r.freq);
        svg.push_str(&line(&|b| fit(b).0, "#1f5f8b", ""));
        svg.push_str(&line(&|b| fit(b).1, "#b5462d", ""));
        let (a0, a1) = fit(0.13);
        svg.push_str(&line(&|b| a0 * (b / 0.13).powf(-2.0), "#1f5f8b", "4 4"));
        svg.push_str(&line(&|b| a1 * (b / 0.13).powf(-1.0), "#b5462d", "4 4"));
        for &(b, lo, hi) in &r.pts {
            if let Some(f) = lo {
                svg.push_str(&format!("<circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"4.5\" fill=\"#1f5f8b\"/>", px(b), py(f)));
            }
            if let Some(f) = hi {
                svg.push_str(&format!("<circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"4.5\" fill=\"#b5462d\"/>", px(b), py(f)));
            }
        }
    }
    svg.push_str(&format!("<text x=\"{m}\" y=\"{}\" font-size=\"11\" fill=\"#55524a\">dots: measured edges (blue least force, red most). solid: fitted window. dashed: slopes -2 and -1 through the fit at 0.13</text>", ph + 2.0 * m + 12.0));
    svg.push_str("</svg>");
    std::fs::write(path, svg).unwrap();
    println!("wrote {}", path.display());
}

fn sweep_notes(skill: f32, coupling: f32, subset: bool) -> Vec<(&'static str, PhysModParams)> {
    let mut v: Vec<(&'static str, PhysModParams)> = Vec::new();
    let violin: &[f32] = if subset { &[293.66, 440.0, 659.25, 349.23] } else { &[196.0, 293.66, 440.0, 659.25, 246.94, 349.23, 523.25, 880.0, 1174.66] };
    for &f in violin {
        v.push(("violin", PhysModParams { attack_skill: skill, coupling, ..plain(f) }));
    }
    let cello_notes: &[f32] = if subset { &[98.0, 220.0] } else { &[98.0, 220.0, 130.81, 329.63] };
    for &f in cello_notes {
        v.push(("cello", PhysModParams { freq: f, attack_skill: skill, coupling, ..cello() }));
    }
    if !subset {
        for &f in &[41.2f32, 55.0, 82.41] {
            v.push(("bass", PhysModParams { freq: f, attack_skill: skill, coupling, ..bass() }));
        }
    }
    v
}

#[test]
#[ignore]
fn strings_schelleng_report() {
    let recs = schelleng_sweep("attack_skill 1.0 (the player helps a stroke start), coupling 0.35", &sweep_notes(1.0, 0.35, false));
    let pick = |name: &str, f: f32| recs.iter().find(|r| r.name == name && (r.freq - f).abs() < 0.01).unwrap();
    plot_window(&[pick("violin", 293.66), pick("cello", 98.0)], &art_dir().join("schelleng-window.svg"));
}

#[test]
#[ignore]
fn strings_schelleng_no_player_report() {
    let _ = schelleng_sweep("attack_skill 0.0 (the friction alone starts the stroke), coupling 0.35", &sweep_notes(0.0, 0.35, false));
}

#[test]
#[ignore]
fn strings_schelleng_uncoupled_report() {
    let _ = schelleng_sweep("attack_skill 1.0, coupling 0.0 (the bridge does not move), subset of notes", &sweep_notes(1.0, 0.0, true));
}

#[test]
#[ignore]
fn strings_behaviour_report() {
    println!("profile: {}", profile());
    // Bow speed, force, position.
    let slow = PhysModParams { bow_velocity: 0.35, ..plain(440.0) };
    let fast = PhysModParams { bow_velocity: 0.35 + (2.0f32).ln() / 25f32.ln(), bow_force: 0.5 + 0.5 * (2.0f32).log10(), ..plain(440.0) };
    let (a, b) = (analyze_note(&slow, 0.8, 0.3), analyze_note(&fast, 0.8, 0.3));
    println!("bow speed x2 ({:.3} -> {:.3} m/s, force scaled with it): {:.1} dB -> {:.1} dB, {:+.1} dB", bow_speed(slow.bow_velocity), bow_speed(fast.bow_velocity), a.rms_db, b.rms_db, b.rms_db - a.rms_db);
    let base = PhysModParams { body_mix: 0.0, ..plain(293.66) };
    let tasto = analyze_note(&PhysModParams { bow_position: 0.2, bow_force: 0.35, ..base }, 0.8, 0.3);
    let pont = analyze_note(&PhysModParams { bow_position: 0.05, bow_force: 0.8, ..base }, 0.8, 0.3);
    println!("tasto (beta 0.2, force 0.35) centroid {:.0} Hz; ponticello (beta 0.05, force 0.8) {:.0} Hz; ratio {:.2}", tasto.centroid_hz, pont.centroid_hz, pont.centroid_hz / tasto.centroid_hz);
    let base = PhysModParams { body_mix: 0.0, bow_position: 0.1, ..plain(440.0) };
    let soft = analyze_note(&PhysModParams { bow_force: 0.35, ..base }, 0.8, 0.3);
    let hard = analyze_note(&PhysModParams { bow_force: 0.7, ..base }, 0.8, 0.3);
    println!("force 0.35 centroid {:.0} Hz, force 0.7 centroid {:.0} Hz ({:.2}x); regimes {:?} then {:?}", soft.centroid_hz, hard.centroid_hz, hard.centroid_hz / soft.centroid_hz, soft.regime.unwrap(), hard.regime.unwrap());
    // Body against no body.
    let bare = analyze_note(&PhysModParams { body_mix: 0.0, ..plain(440.0) }, 0.7, 0.3);
    let bodied = analyze_note(&PhysModParams { body_mix: 1.0, ..plain(440.0) }, 0.7, 0.3);
    let diff: f32 = bare.harmonics_db.iter().zip(bodied.harmonics_db.iter()).map(|(x, y)| (x - y).abs()).sum::<f32>() / HARMONICS_F;
    println!("body: mean change in harmonic balance {diff:.1} dB, level {:.1} -> {:.1} dB", bare.rms_db, bodied.rms_db);
    // The body's modes against the size axis.
    for &size in &[-1.0f32, 0.0, 0.13, 0.72, 1.0, 2.5] {
        let e = Engine::new(SR, &PhysModParams { body_size: size, ..Default::default() });
        let (f, _) = e.body_modes();
        println!("body_size {size:>5.2}: divisor {:>5.2}, A0 {:>6.1} Hz, B1- {:>6.1} Hz, B1+ {:>6.1} Hz, bridge hill {:>7.1} Hz", body_scale(size), f[0], f[2], f[3], f[9]);
    }
    // Sympathetic ringing.
    let ring_of = |freq: f32, coupling: f32| {
        let p = PhysModParams { coupling, ..plain(freq) };
        let mut e = Engine::new(SR, &p);
        e.note_on(1, p, true, None);
        for _ in 0..(1.0 * SR) as usize {
            e.next_frame();
        }
        e.string(0).level
    };
    let (g, fs) = (ring_of(392.0, 0.35), ring_of(370.0, 0.35));
    println!("open G string level after 1 s: bowing G4 {g:.3e}, bowing F#4 {fs:.3e}, ratio {:.1}", g / fs);
    for &c in &[0.0f32, 0.35, 0.9] {
        println!("coupling {c}: open G string level bowing G4 = {:.3e}", ring_of(392.0, c));
    }
    let with_symp = |sym: f32| {
        let p = PhysModParams { sympathetic: [sym, 0.0, 0.0, 0.0, 0.0, 0.0], ..plain(440.0) };
        let mut e = Engine::new(SR, &p);
        e.note_on(1, p, true, None);
        for _ in 0..(1.0 * SR) as usize {
            e.next_frame();
        }
        e.string(4).level
    };
    println!("sympathetic string after 1 s bowing A4: tuned to 440 {:.3e}, tuned to 415.3 {:.3e}, ratio {:.1}", with_symp(440.0), with_symp(415.3), with_symp(440.0) / with_symp(415.3));
    // The wolf.
    let wolf = |coupling: f32, force: f32| {
        let p = PhysModParams { coupling, bow_force: force, ..PhysModParams { freq: 163.6, ..cello() } };
        let a = analyze_note(&p, 1.6, 0.4);
        println!("cello 163.6 Hz, coupling {coupling}, force {force}: slips/period {:.2}, regime {:?}, pitch {:+.1} cents, level {:.1} dB", a.slips_per_period, a.regime.unwrap(), a.cents, a.rms_db);
    };
    wolf(1.0, 0.3);
    wolf(1.0, 0.7);
    wolf(0.35, 0.3);
    // Attack: the player against bare friction.
    println!("-- how a stroke starts: seconds until one release per period holds for 10 periods");
    let starts: [(&str, PhysModParams); 5] = [("violin G3", plain(196.0)), ("violin A4", plain(440.0)), ("violin B5", plain(987.77)), ("cello C2", PhysModParams { freq: 65.41, ..cello() }), ("bass E1", PhysModParams { freq: 41.2, ..bass() })];
    for (name, base) in starts {
        let (secs, win) = timing(base.freq);
        let mut line = format!("{name:<10}");
        for &skill in &[0.0f32, 0.9, 1.0] {
            let a = analyze_note(&PhysModParams { attack_skill: skill, ..base }, secs + 0.6, win);
            line.push_str(&format!("  skill {skill:.1}: {} ({:?}, {:.2} slips/period)", a.attack_secs.map_or("never".to_string(), |s| format!("{s:.3} s")), a.regime.unwrap(), a.slips_per_period));
        }
        println!("{line}");
    }
    // Impossible instruments.
    let mut worst = 0.0f32;
    let mut count = 0;
    for &body_size in &[-1.0f32, 0.0, 1.0, 2.5] {
        for &force in &[0.0f32, 0.5, 1.0] {
            for &(speed, pos) in &[(0.0f32, 0.02f32), (1.0, 0.5), (0.5, 0.12)] {
                for &(mass, coupling, stiffness) in &[(0.0f32, 1.0f32, 1.0f32), (1.0, 0.0, 0.0), (0.5, 1.0, 0.5)] {
                    let p = PhysModParams { freq: 110.0 * 4f32.powf(-body_size * 0.5).max(0.3) * 2.0, bow_force: force, bow_velocity: speed, bow_position: pos, string_mass: mass, coupling, stiffness, body_size, velocity: 1.0, duration: 0.25, ..Default::default() };
                    for v in render_note(Arc::new(PhysModShared::default()), p, 0.35) {
                        assert!(v.is_finite());
                        worst = worst.max(v.abs());
                    }
                    count += 1;
                }
            }
        }
    }
    println!("bounded output: {count} extreme instruments, largest sample {worst:.3}");
}

#[test]
#[ignore]
fn strings_cost_report() {
    println!("profile: {}", profile());
    let cost = |label: &str, p: &PhysModParams, notes: &[f32]| {
        let secs = 10.0f32;
        let mut runs = Vec::new();
        for _ in 0..3 {
            let mut e = Engine::new(SR, p);
            for (i, &f) in notes.iter().enumerate() {
                e.note_on(i as u64 + 1, PhysModParams { freq: f, ..*p }, true, None);
            }
            for _ in 0..(0.5 * SR) as usize {
                e.next_frame();
            }
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
        println!("{label:<40} {:.1}% / {:.1}% / {:.1}% of one core (min / median / max of 3, 10 s of audio each)", runs[0], runs[1], runs[2]);
    };
    let base = plain(440.0);
    cost("one bowed note", &base, &[440.0]);
    cost("four strings bowed at once (G D A E)", &base, &[196.0, 293.66, 440.0, 659.25]);
    let s4 = PhysModParams { sympathetic: [196.0, 293.66, 440.0, 659.25, 0.0, 0.0], ..base };
    cost("one note, four sympathetic strings", &s4, &[440.0]);
    let s6 = PhysModParams { sympathetic: [196.0, 293.66, 440.0, 659.25, 880.0, 1318.5], ..base };
    cost("one note, six sympathetic strings", &s6, &[440.0]);
    cost("cello, one note", &PhysModParams { freq: 110.0, ..cello() }, &[110.0]);
    cost("bass, one note", &PhysModParams { freq: 55.0, ..bass() }, &[55.0]);
}

#[test]
#[ignore]
fn strings_stiffness_report() {
    println!("profile: {}", profile());
    // Partial 8 (or lower on a high note) against the ideal harmonic, and the allpass coefficient the
    // solver chose. The string runs at twice the engine rate.
    for &f0 in &[110.0f32, 220.0, 440.0] {
        for &st in &[0.2f32, 0.4, 0.6, 0.8, 1.0] {
            let p = PhysModParams { articulation: Articulation::Pizzicato, stiffness: st, body_mix: 0.0, ring: 1.0, duration: 2.0, ..plain(f0) };
            let out = left(&render_note(Arc::new(PhysModShared::default()), p, 0.6));
            let seg = &out[(0.05 * SR) as usize..(0.55 * SR) as usize];
            let (mags, bin) = super::analysis::spectrum(seg, SR);
            let peak_near = |f: f32| {
                let (lo, hi) = (((f * 0.97) / bin) as usize, ((f * 1.12) / bin) as usize);
                (lo..hi).max_by(|&a, &b| mags[a].total_cmp(&mags[b])).unwrap() as f32 * bin
            };
            let f1 = peak_near(f0);
            let b = super::string::inharmonicity(st);
            let n = ((SR * 2.0 * 0.2 / f0).floor() as usize).clamp(2, 8) as f32;
            let ratio = peak_near(f0 * n) / (n * f1);
            let ideal = (1.0 + n * n * b).sqrt() / (1.0 + b).sqrt();
            let c = super::string::dispersion_coefficient(b, f0, SR * 2.0);
            println!("{f0:>5.0} Hz stiffness {st:.1}: partial {n} / ({n} x f1) = {ratio:.4}, theory {ideal:.4}, allpass coefficient {c:+.3}");
        }
    }
}

/// Every chromatic note of each orchestral instrument's range with the DAW's default playing (vibrato,
/// bow noise), measured over time: the median pitch early (0.1-0.4 s, what a short note is heard as)
/// and late (0.6-1.2 s).
#[test]
#[ignore]
fn strings_chromatic_tuning_report() {
    println!("profile: {}", profile());
    let insts: [(&str, [f32; 4], f32, i32, i32); 4] = [
        ("violin", VIOLIN_TUNING, 0.0, 55, 88),
        ("viola", [130.81, 196.0, 293.66, 440.0], 0.13, 48, 81),
        ("cello", [65.41, 98.0, 146.83, 220.0], 0.72, 36, 69),
        ("bass", [41.2, 55.0, 73.42, 98.0], 1.0, 28, 55),
    ];
    for (name, strings, body, lo, hi) in insts {
        let mut good = 0;
        for m in lo..=hi {
            let f = 440.0 * 2f32.powf((m - 69) as f32 / 12.0);
            let p = PhysModParams { freq: f, strings, body_size: body, gain: 0.7, duration: 2.0, ..Default::default() };
            let out = left(&render_note(Arc::new(PhysModShared::default()), p, 1.2));
            let win = ((6.0 / f).max(0.05) * SR) as usize;
            let track: Vec<(f32, f32)> = (0..out.len().saturating_sub(win)).step_by((0.025 * SR) as usize).map(|i| {
                let hz = pitch(&out[i..i + win], SR, f);
                ((i + win / 2) as f32 / SR, if hz > 0.0 { 1200.0 * (hz / f).log2() } else { f32::NAN })
            }).collect();
            let median = |a: f32, b: f32| {
                let mut xs: Vec<f32> = track.iter().filter(|(t, c)| *t >= a && *t < b && c.is_finite()).map(|x| x.1).collect();
                xs.sort_by(|a, b| a.total_cmp(b));
                xs.get(xs.len() / 2).copied().unwrap_or(f32::NAN)
            };
            let (early, late) = (median(0.1, 0.4), median(0.6, 1.2));
            let ok = early.abs() < 12.0 && late.abs() < 12.0;
            good += ok as usize;
            println!("{name:<6} midi {m:>3} {f:>8.2} Hz  early {early:+7.1} c  late {late:+7.1} c{}", if ok { "" } else { "  <-- out" });
        }
        println!("== {name}: {good}/{} notes in tune", hi - lo + 1);
    }
}

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

//! Event-stream invariants (spec 6.4) on random and hostile input: whatever goes in, the events that
//! come out are well formed (no Note On while a note is on, every Note On gets a Note Off, the bend is
//! centered before each Note On, timestamps never run backwards), nothing panics, and nothing is NaN.
//!
//! Seeded, so a failure names the seed that reproduces it.

use entropy_engine::guitar::replay::{check_well_formed, run};
use entropy_engine::guitar::testsig::{self, Motion, Pluck, Rng};
use entropy_engine::guitar::{Algorithm, GuitarConfig, GuitarEngine, GuitarEventKind, Mode};

fn random_config(rng: &mut Rng) -> GuitarConfig {
    let rates = [44_100.0f32, 48_000.0, 96_000.0];
    GuitarConfig {
        sample_rate: rates[(rng.next_u32() % 3) as usize],
        mode: Mode::ALL[(rng.next_u32() % 3) as usize],
        algorithm: if rng.next_u32() % 2 == 0 { Algorithm::Yin } else { Algorithm::Mpm },
        bend_range: 1.0 + (rng.next_u32() % 12) as f32,
        guard: rng.next_u32() % 2 == 0,
        sensitivity: rng.unit(),
        ..GuitarConfig::default()
    }
}

fn random_recording(rng: &mut Rng, fs: f32) -> Vec<f32> {
    let seconds = 3.0 + rng.unit() * 5.0;
    let count = 1 + rng.next_u32() % 14;
    let plucks: Vec<Pluck> = (0..count)
        .map(|i| {
            let mut p = Pluck::note(38 + (rng.next_u32() % 52) as u8).starting(rng.unit() * (seconds - 0.5)).loud(-40.0 + rng.unit() * 34.0).seeded(i + 1);
            p.fundamental = if rng.next_u32() % 4 == 0 { rng.unit() * 0.5 } else { 1.0 };
            p.odd_gain = if rng.next_u32() % 4 == 0 { 0.1 } else { 1.0 };
            p.decay_s = 0.2 + rng.unit() * 2.0;
            match rng.next_u32() % 6 {
                0 => p.moving(Motion::Vibrato { depth_cents: rng.unit() * 80.0, rate_hz: 3.0 + rng.unit() * 6.0, delay_s: rng.unit() * 0.4 }),
                1 => p.moving(Motion::Bend { cents: rng.unit() * 300.0, start_s: rng.unit() * 0.4, dur_s: 0.05 + rng.unit() * 0.5 }),
                2 => p.moving(Motion::Slide { semitones: 1.0 + rng.unit() * 11.0, start_s: rng.unit() * 0.4, dur_s: 0.05 + rng.unit() * 0.5 }),
                3 => p.ringing(0.05 + rng.unit() * 0.6),
                _ => p,
            }
        })
        .collect();
    let (mut x, _) = testsig::mix(fs, seconds, &plucks);
    if rng.next_u32() % 2 == 0 {
        testsig::add_hum(&mut x, fs, if rng.next_u32() % 2 == 0 { 50.0 } else { 60.0 }, -60.0 + rng.unit() * 25.0);
    }
    if rng.next_u32() % 2 == 0 {
        testsig::add_noise(&mut x, -75.0 + rng.unit() * 30.0, rng.next_u32());
    }
    for _ in 0..(rng.next_u32() % 4) {
        testsig::add_slap(&mut x, fs, rng.unit() * (seconds - 0.2), -20.0 + rng.unit() * 20.0, 3.0 + rng.unit() * 20.0, rng.next_u32());
    }
    x
}

#[test]
fn random_recordings_always_produce_well_formed_events() {
    let mut events_seen = 0usize;
    for seed in 1..=80u32 {
        let mut rng = Rng::new(seed * 7919);
        let cfg = random_config(&mut rng);
        let x = random_recording(&mut rng, cfg.sample_rate);
        let block = [16usize, 32, 64, 100, 128, 256, 512, 1024][(rng.next_u32() % 8) as usize];
        let r = run(&cfg, &x, block);
        if let Err(e) = check_well_formed(&r.events) {
            panic!("seed {seed} ({:?} {:?} fs {} block {block} bend {}): {e}", cfg.mode, cfg.algorithm, cfg.sample_rate, cfg.bend_range);
        }
        events_seen += r.events.len();
        assert!(r.diagnostics.freq_hz.is_finite() && r.diagnostics.level_db.is_finite(), "seed {seed}: non-finite diagnostics");
    }
    println!("80 random recordings, {events_seen} events, all well formed");
    assert!(events_seen > 500, "the recordings produced too few events to mean anything");
}

#[test]
fn hostile_input_neither_panics_nor_breaks_the_stream() {
    let fs = 48_000.0;
    let n = (4.0 * fs) as usize;
    let cases: Vec<(&str, Vec<f32>)> = vec![
        ("digital silence", vec![0.0; n]),
        ("full scale DC", vec![1.0; n]),
        ("full scale square 110 Hz", (0..n).map(|i| if (i as f32 * 110.0 / fs).fract() < 0.5 { 1.0 } else { -1.0 }).collect()),
        ("alternating full scale (Nyquist)", (0..n).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 }).collect()),
        ("NaN burst inside a note", {
            let (mut x, _) = testsig::mix(fs, 4.0, &[Pluck::note(52).loud(-10.0)]);
            for v in &mut x[20_000..20_600] {
                *v = f32::NAN;
            }
            x
        }),
        ("infinities", {
            let (mut x, _) = testsig::mix(fs, 4.0, &[Pluck::note(60).loud(-10.0)]);
            x[30_000] = f32::INFINITY;
            x[30_001] = f32::NEG_INFINITY;
            x
        }),
        ("denormal-scale signal", (0..n).map(|i| 1e-30 * ((i as f32) * 0.05).sin()).collect()),
        ("clipped note", {
            let (x, _) = testsig::mix(fs, 4.0, &[Pluck::note(45).loud(6.0)]);
            x.iter().map(|v| v.clamp(-1.0, 1.0)).collect()
        }),
        ("gain far past full scale", {
            let (x, _) = testsig::mix(fs, 4.0, &[Pluck::note(57).loud(-10.0)]);
            x.iter().map(|v| v * 1000.0).collect()
        }),
    ];
    for (name, x) in cases {
        for mode in Mode::ALL {
            let cfg = GuitarConfig::default().with_mode(mode);
            let r = run(&cfg, &x, 128);
            if let Err(e) = check_well_formed(&r.events) {
                panic!("{name} ({}): {e}", mode.name());
            }
        }
    }
}

#[test]
fn engine_can_restart_after_a_stop_and_stays_well_formed() {
    let cfg = GuitarConfig::default();
    let (x, _) = testsig::mix(cfg.sample_rate, 3.0, &[Pluck::note(50).loud(-12.0)]);
    let mut engine = GuitarEngine::new(cfg);
    let mut events = Vec::new();
    for round in 0..4 {
        for chunk in x.chunks(128).take(700) {
            engine.process(chunk, &mut events);
        }
        assert!(engine.diagnostics().note.is_some(), "round {round}: nothing sounding to stop");
        engine.reset(&mut events);
    }
    if let Err(e) = check_well_formed(&events) {
        panic!("{e}");
    }
    assert_eq!(events.iter().filter(|e| matches!(e.kind, GuitarEventKind::NoteOn { .. })).count(), 4);
}

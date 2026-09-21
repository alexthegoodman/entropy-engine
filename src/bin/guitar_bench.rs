//! Guitar-to-MIDI accuracy, latency and CPU on the synthetic corpus. Release builds only mean
//! anything here, so the build profile is printed with every run.
//!
//! `cargo run --release --bin guitar_bench [-- sweep|cpu|compare]`

use entropy_engine::guitar::replay::{percentile, trial, NoteTrial};
use entropy_engine::guitar::testsig::{self, Pluck};
use entropy_engine::guitar::{Algorithm, GuitarConfig, GuitarEngine, Mode};
use std::time::Instant;

fn profile() -> &'static str {
    if cfg!(debug_assertions) { "DEBUG (numbers are not valid)" } else { "release" }
}

struct Row {
    name: &'static str,
    low: u8,
    high: u8,
}

const REGISTERS: [Row; 3] = [
    Row { name: "low  E2-G#2", low: 40, high: 44 },
    Row { name: "mid  A2-D#4", low: 45, high: 63 },
    Row { name: "high E4-E6 ", low: 64, high: 88 },
];

fn sweep(cfg: &GuitarConfig, peak_db: f32, seeds: u32, motion: Option<testsig::Motion>) -> Vec<(u8, NoteTrial)> {
    let mut out = Vec::new();
    for midi in 40u8..=88 {
        for seed in 0..seeds {
            let mut p = Pluck::note(midi).loud(peak_db).seeded(seed + 1);
            if let Some(m) = motion {
                p = p.moving(m);
            }
            out.push((midi, trial(cfg, &p, 1.4, 128)));
        }
    }
    out
}

#[derive(Clone, Copy)]
struct Variant {
    name: &'static str,
    peak_db: f32,
    fundamental: f32,
    odd_gain: f32,
    hum_db: Option<f32>,
    noise_db: Option<f32>,
}

const VARIANTS: [Variant; 8] = [
    Variant { name: "normal", peak_db: -14.0, fundamental: 1.0, odd_gain: 1.0, hum_db: None, noise_db: None },
    Variant { name: "soft -34 dBFS", peak_db: -34.0, fundamental: 1.0, odd_gain: 1.0, hum_db: None, noise_db: None },
    Variant { name: "weak fundamental x0.3", peak_db: -14.0, fundamental: 0.3, odd_gain: 1.0, hum_db: None, noise_db: None },
    Variant { name: "weak fundamental x0.1", peak_db: -14.0, fundamental: 0.1, odd_gain: 1.0, hum_db: None, noise_db: None },
    Variant { name: "missing fundamental", peak_db: -14.0, fundamental: 0.0, odd_gain: 1.0, hum_db: None, noise_db: None },
    Variant { name: "octave-ambiguous (odd x0.1)", peak_db: -14.0, fundamental: 1.0, odd_gain: 0.1, hum_db: None, noise_db: None },
    Variant { name: "octave-ambiguous (fund x0.2, odd x0.1)", peak_db: -14.0, fundamental: 0.2, odd_gain: 0.1, hum_db: None, noise_db: None },
    Variant { name: "hum -52 + noise -60", peak_db: -20.0, fundamental: 1.0, odd_gain: 1.0, hum_db: Some(-52.0), noise_db: Some(-60.0) },
];

fn stress(cfg: &GuitarConfig, v: Variant, seeds: u32) -> Vec<(u8, NoteTrial)> {
    let mut out = Vec::new();
    for midi in 40u8..=88 {
        for seed in 0..seeds {
            let mut p = Pluck::note(midi).loud(v.peak_db).seeded(seed + 1);
            p.fundamental = v.fundamental;
            p.odd_gain = v.odd_gain;
            let (mut x, truth) = testsig::mix(cfg.sample_rate, 1.4, std::slice::from_ref(&p));
            if let Some(h) = v.hum_db {
                testsig::add_hum(&mut x, cfg.sample_rate, 60.0, h);
            }
            if let Some(n) = v.noise_db {
                testsig::add_noise(&mut x, n, seed + 100);
            }
            let r = entropy_engine::guitar::replay::run(cfg, &x, 128);
            let mut t = trial(cfg, &p, 0.1, 128);
            t.expected = truth[0].midi;
            t.events = r.events.clone();
            let ons: Vec<(u8, u8)> = r.events.iter().filter_map(|e| if let entropy_engine::guitar::GuitarEventKind::NoteOn { note, velocity } = e.kind { Some((note, velocity)) } else { None }).collect();
            t.first = ons.first().map(|o| o.0);
            t.latency_ms = r.events.iter().find(|e| matches!(e.kind, entropy_engine::guitar::GuitarEventKind::NoteOn { .. })).map(|e| (e.sample as f32 - truth[0].onset as f32) / cfg.sample_rate * 1000.0);
            t.note_ons = ons;
            out.push((midi, t));
        }
    }
    out
}

fn summarize(label: &str, results: &[(u8, NoteTrial)]) {
    println!("{label}  ({} notes)", results.len());
    for reg in &REGISTERS {
        let rows: Vec<&NoteTrial> = results.iter().filter(|(m, _)| (reg.low..=reg.high).contains(m)).map(|(_, t)| t).collect();
        let n = rows.len() as f32;
        let correct = rows.iter().filter(|t| t.correct()).count() as f32 / n * 100.0;
        let octave = rows.iter().filter(|t| t.octave_error()).count() as f32 / n * 100.0;
        let missed = rows.iter().filter(|t| t.first.is_none()).count();
        let extra = rows.iter().filter(|t| t.note_ons.len() > 1).count();
        let mut lat: Vec<f32> = rows.iter().filter_map(|t| t.latency_ms).collect();
        let (p50, p95) = (percentile(&mut lat.clone(), 50.0), percentile(&mut lat, 95.0));
        println!("  {}  correct {correct:5.1}%  octave {octave:4.1}%  missed {missed:3}  retriggered {extra:3}  latency p50 {p50:5.1} ms  p95 {p95:5.1} ms", reg.name);
    }
}

fn report(label: &str, cfg: &GuitarConfig, peak_db: f32, seeds: u32) {
    let results = sweep(cfg, peak_db, seeds, None);
    println!("{label}  ({} notes, peak {peak_db} dBFS)", results.len());
    for reg in &REGISTERS {
        let rows: Vec<&NoteTrial> = results.iter().filter(|(m, _)| (reg.low..=reg.high).contains(m)).map(|(_, t)| t).collect();
        let n = rows.len() as f32;
        let correct = rows.iter().filter(|t| t.correct()).count() as f32 / n * 100.0;
        let octave = rows.iter().filter(|t| t.octave_error()).count() as f32 / n * 100.0;
        let missed = rows.iter().filter(|t| t.first.is_none()).count();
        let extra = rows.iter().filter(|t| t.note_ons.len() > 1).count();
        let mut lat: Vec<f32> = rows.iter().filter_map(|t| t.latency_ms).collect();
        let (p50, p95) = (percentile(&mut lat.clone(), 50.0), percentile(&mut lat, 95.0));
        println!("  {}  correct {correct:5.1}%  octave {octave:4.1}%  missed {missed:3}  retriggered {extra:3}  latency p50 {p50:5.1} ms  p95 {p95:5.1} ms", reg.name);
    }
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_else(|| "sweep".into());
    println!("guitar_bench: {}  ({} )", profile(), std::env::consts::OS);
    match arg.as_str() {
        "sweep" => {
            for mode in Mode::ALL {
                let cfg = GuitarConfig::default().with_mode(mode);
                report(&format!("{} / {:?}", mode.name(), cfg.algorithm), &cfg, -14.0, 3);
            }
        }
        "compare" => {
            for algo in [Algorithm::Yin, Algorithm::Mpm] {
                for guard in [true, false] {
                    let cfg = GuitarConfig { algorithm: algo, guard, ..GuitarConfig::default() };
                    report(&format!("{algo:?} guard={guard}"), &cfg, -14.0, 3);
                }
            }
        }
        "stress" => {
            for algo in [Algorithm::Yin, Algorithm::Mpm] {
                for guard in [true, false] {
                    let cfg = GuitarConfig { algorithm: algo, guard, ..GuitarConfig::default() };
                    for v in VARIANTS {
                        summarize(&format!("{algo:?} guard={guard} | {}", v.name), &stress(&cfg, v, 2));
                    }
                }
            }
        }
        "fixes" => {
            // The octave-ambiguous case with each fix on and off.
            let v = VARIANTS[6];
            for (sub, verify) in [(false, 0.0), (true, 0.0), (false, 0.94), (true, 0.94)] {
                let cfg = GuitarConfig { subharmonic_check: sub, verify_below_confidence: verify, ..GuitarConfig::default() };
                summarize(&format!("YIN subharmonic_check={sub} verify_below={verify} | {}", v.name), &stress(&cfg, v, 2));
            }
        }
        "tiers" => {
            // Window spacing and length against latency and octave errors, on the cases that stress each.
            for step in [1.5f32, 1.35, 1.25] {
                for ratio in [1.0f32, 0.8, 0.65] {
                    let cfg = GuitarConfig { tier_step: step, window_ratio: ratio, ..GuitarConfig::default() };
                    let n = GuitarEngine::new(cfg.clone()).tier_lengths();
                    println!("tier_step {step} window_ratio {ratio}  windows {n:?}");
                    for vi in [0usize, 1, 6] {
                        summarize(&format!("   | {}", VARIANTS[vi].name), &stress(&cfg, VARIANTS[vi], 2));
                    }
                }
            }
        }
        "thump" => {
            let cfg = GuitarConfig::default();
            for db in [-14.0f32, -8.0, -4.0] {
                let (mut x, _) = testsig::mix(cfg.sample_rate, 1.5, &[Pluck::note(64).loud(-14.0)]);
                testsig::add_slap(&mut x, cfg.sample_rate, 0.6, db, 15.0, 99);
                let peak = x[(0.6 * 48000.0) as usize..(0.62 * 48000.0) as usize].iter().fold(0.0f32, |a, &b| a.max(b.abs()));
                let r = entropy_engine::guitar::replay::run(&cfg, &x, 128);
                println!("thump {db} dBFS (mix peak {:.1} dBFS): stats {:?}, events {}", 20.0 * peak.log10(), r.diagnostics.stats, r.events.len());
            }
        }
        "trace" => {
            let midi: u8 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(45);
            let vi: usize = std::env::args().nth(3).and_then(|a| a.parse().ok()).unwrap_or(0);
            let cfg = GuitarConfig::default();
            let v = VARIANTS[vi];
            println!("trace: note {midi}, variant {}", v.name);
            let all = midi == 0;
            for (m, t) in stress(&cfg, v, 2).into_iter().enumerate().map(|(i, (m, t))| (format!("{m} seed {}", i % 2 + 1), t)).filter(|(m, t)| if all { t.note_ons.len() != 1 } else { m.starts_with(&format!("{midi} ")) }) {
                println!("expected {m}, first {:?}, ons {:?}, latency {:?}", t.first, t.note_ons, t.latency_ms);
                for e in t.events.iter().take(40) {
                    println!("  {:>7} (pick {:>7})  {:?}", e.sample, e.source_sample, e.kind);
                }
            }
        }
        "cpu" => {
            let cfg = GuitarConfig::default();
            let plucks: Vec<Pluck> = (0..40).map(|i| Pluck::note(40 + (i * 7) % 48).starting(0.2 + i as f32 * 0.25).loud(-16.0).seeded(i as u32 + 1)).collect();
            let (x, _) = testsig::mix(cfg.sample_rate, 11.0, &plucks);
            let mut engine = GuitarEngine::new(cfg.clone());
            let mut events = Vec::new();
            let mut times: Vec<f32> = Vec::new();
            for chunk in x.chunks(128) {
                let t = Instant::now();
                engine.process(chunk, &mut events);
                times.push(t.elapsed().as_secs_f32() * 1e6);
                events.clear();
            }
            let period_us = 128.0 / cfg.sample_rate * 1e6;
            let mean = times.iter().sum::<f32>() / times.len() as f32;
            let mut sorted = times.clone();
            let (p99, p999, max) = (percentile(&mut sorted.clone(), 99.0), percentile(&mut sorted.clone(), 99.9), percentile(&mut sorted, 100.0));
            println!("128-sample callback ({period_us:.0} us of audio), {} callbacks", times.len());
            println!("  mean {mean:.1} us ({:.1}%)  p99 {p99:.1} us  p99.9 {p999:.1} us ({:.1}%)  max {max:.1} us", mean / period_us * 100.0, p999 / period_us * 100.0);
        }
        other => eprintln!("unknown mode {other}; use sweep, compare or cpu"),
    }
}

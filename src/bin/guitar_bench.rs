//! Guitar-to-MIDI accuracy, latency and CPU on the synthetic corpus. CPU timing only means anything in
//! a release build (and replaying the corpus is slow in debug), so the build profile is printed with
//! every run.
//!
//! `cargo run --release --bin guitar_bench [-- sweep|cpu|compare|stress|poly|chords|chord-trace NAME|tune]`
//! (`poly`: the chord engine end to end; `chords`: the chord detector alone on the chord corpus)

use entropy_engine::guitar::replay::{percentile, trial, NoteTrial};
use entropy_engine::guitar::testsig::{self, Pluck};
use entropy_engine::guitar::poly::{NoteSet, PolyDetector, PolyFrame, PolyParams};
use entropy_engine::guitar::{Algorithm, GuitarConfig, GuitarEngine, Mode, Polyphony, STANDARD_TUNING};
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

/// One chord trial's note-level outcome.
#[derive(Default, Clone, Copy)]
struct Score {
    tp: usize,
    fp: usize,
    fn_: usize,
    exact: usize,
    trials: usize,
    /// Pitch classes right, octaves aside.
    chroma_exact: usize,
}

impl Score {
    fn add(&mut self, truth: &[u8], got: &[u8]) {
        let tp = got.iter().filter(|n| truth.contains(n)).count();
        self.tp += tp;
        self.fp += got.len() - tp;
        self.fn_ += truth.len() - tp;
        self.trials += 1;
        if tp == truth.len() && got.len() == truth.len() {
            self.exact += 1;
        }
        let pc = |v: &[u8]| v.iter().fold(0u16, |m, n| m | 1 << (n % 12));
        if pc(truth) == pc(got) {
            self.chroma_exact += 1;
        }
    }

    fn line(&self) -> String {
        let p = self.tp as f32 / (self.tp + self.fp).max(1) as f32 * 100.0;
        let r = self.tp as f32 / (self.tp + self.fn_).max(1) as f32 * 100.0;
        let f = 2.0 * p * r / (p + r).max(1e-6);
        format!(
            "precision {p:5.1}%  recall {r:5.1}%  F1 {f:5.1}  exact {:5.1}%  pitch classes exact {:5.1}%  ({} trials)",
            self.exact as f32 / self.trials.max(1) as f32 * 100.0,
            self.chroma_exact as f32 / self.trials.max(1) as f32 * 100.0,
            self.trials
        )
    }
}

/// A rendered trial: the samples from 3 ms after the first string, and the notes in it.
struct ChordCase {
    name: String,
    x: Vec<f32>,
    notes: Vec<u8>,
    single: bool,
}

/// Every chord shape strummed with each seed, and every single note, rendered once.
fn chord_corpus(seeds: u32, spread_ms: f32, seconds: f32) -> Vec<ChordCase> {
    let fs = 48_000.0;
    let mut out = Vec::new();
    let skip = (0.1 * fs) as usize + (0.003 * fs) as usize;
    for seed in 1..=seeds {
        for (name, shape) in testsig::CHORD_SHAPES {
            let notes = testsig::shape_notes(shape, &STANDARD_TUNING);
            let plucks = testsig::strum(&notes, 0.1, spread_ms, -18.0, seed % 2 == 1, seed * 101 + notes[0] as u32);
            let (x, _) = testsig::mix(fs, 0.1 + seconds, &plucks);
            let mut sorted = notes.clone();
            sorted.sort();
            sorted.dedup();
            out.push(ChordCase { name: format!("{name} seed {seed}"), x: x[skip..].to_vec(), notes: sorted, single: false });
        }
        for midi in 40u8..=88 {
            let plucks = testsig::strum(&[midi], 0.1, 0.0, -18.0, true, seed * 7 + midi as u32);
            let (x, _) = testsig::mix(fs, 0.1 + seconds, &plucks);
            out.push(ChordCase { name: format!("single {midi} seed {seed}"), x: x[skip..].to_vec(), notes: vec![midi], single: true });
        }
    }
    out
}

/// The detector alone on each case, reading everything from 3 ms after the first string to `after_ms`.
fn chord_frames(corpus: &[ChordCase], params: PolyParams, after_ms: f32, verbose: bool) -> (Score, Score) {
    let fs = 48_000.0;
    let mut det = PolyDetector::new(&mut realfft::RealFftPlanner::new(), fs, 70.0, 1400.0, 440.0, STANDARD_TUNING, 24, 4096);
    det.set_params(params);
    let (mut chords, mut singles) = (Score::default(), Score::default());
    let end = ((after_ms - 3.0) / 1000.0 * fs) as usize;
    for case in corpus {
        let mut frame = PolyFrame::default();
        det.analyze(&case.x[..end.min(case.x.len())], NoteSet::default(), &mut frame);
        let mut got: Vec<u8> = frame.iter().map(|n| n.note).collect();
        got.sort();
        if case.single { singles.add(&case.notes, &got) } else { chords.add(&case.notes, &got) }
        if verbose && got != case.notes {
            println!("  {:24}: want {:?} got {got:?}", case.name, case.notes);
        }
    }
    (chords, singles)
}

/// Runs a recording through a fresh polyphonic engine and returns the events.
fn poly_run(cfg: &GuitarConfig, x: &[f32]) -> Vec<entropy_engine::guitar::GuitarEvent> {
    entropy_engine::guitar::replay::run(cfg, x, 128).events
}

fn note_ons(events: &[entropy_engine::guitar::GuitarEvent]) -> Vec<(u64, u64, u8)> {
    events.iter().filter_map(|e| if let entropy_engine::guitar::GuitarEventKind::NoteOn { note, .. } = e.kind { Some((e.sample, e.source_sample, note)) } else { None }).collect()
}

/// The whole polyphonic engine on strummed chords, single notes, a progression, a let-ring arpeggio
/// and a noisy room.
fn poly_report(cfg: &GuitarConfig, seeds: u32, verbose: bool) {
    let fs = cfg.sample_rate;
    let at = |s: f32| (s * fs) as u64;
    let mut chords = Score::default();
    let mut singles = Score::default();
    let (mut first_lat, mut all_lat): (Vec<f32>, Vec<f32>) = (Vec::new(), Vec::new());
    let mut malformed = 0;
    let mut single_extra = 0;
    for seed in 1..=seeds {
        for (name, shape) in testsig::CHORD_SHAPES {
            let notes = testsig::shape_notes(shape, &STANDARD_TUNING);
            let mut plucks = testsig::strum(&notes, 0.2, 25.0, -18.0, seed % 2 == 1, seed * 101 + notes[0] as u32);
            for p in plucks.iter_mut() {
                p.ring_s = 0.8;
            }
            let (x, _) = testsig::mix(fs, 1.3, &plucks);
            let ev = poly_run(cfg, &x);
            if entropy_engine::guitar::replay::check_well_formed_poly(&ev).is_err() {
                malformed += 1;
            }
            let ons = note_ons(&ev);
            let mut got: Vec<u8> = ons.iter().map(|o| o.2).collect();
            got.sort();
            got.dedup();
            let mut want = notes.clone();
            want.sort();
            want.dedup();
            chords.add(&want, &got);
            if let Some(f) = ons.first() {
                first_lat.push((f.0 as f32 - at(0.2) as f32) / fs * 1000.0);
            }
            if let Some(l) = ons.iter().filter(|o| want.contains(&o.2)).map(|o| o.0).max() {
                all_lat.push((l as f32 - at(0.2) as f32) / fs * 1000.0);
            }
            if verbose && got != want {
                println!("  {name:18} seed {seed}: want {want:?} got {got:?}  ({} Note Ons)", ons.len());
            }
        }
        for midi in 40u8..=88 {
            let p = Pluck::note(midi).starting(0.2).loud(-18.0).seeded(seed * 13 + midi as u32).ringing(0.8);
            let (x, _) = testsig::mix(fs, 1.3, &[p]);
            let ev = poly_run(cfg, &x);
            if entropy_engine::guitar::replay::check_well_formed_poly(&ev).is_err() {
                malformed += 1;
            }
            let ons = note_ons(&ev);
            let got: Vec<u8> = ons.iter().map(|o| o.2).collect();
            if ons.len() > 1 {
                single_extra += 1;
            }
            let mut uniq = got.clone();
            uniq.sort();
            uniq.dedup();
            singles.add(&[midi], &uniq);
            if verbose && got != [midi] {
                println!("  single {midi} seed {seed}: got {got:?}");
            }
        }
    }
    println!("{} / polyphonic  (strum 25 ms, strings muted 0.8 s later)", cfg.mode.name());
    println!("  chords   {}", chords.line());
    println!("  singles  {}  more than one Note On: {single_extra}", singles.line());
    println!("  first note of a chord p50 {:.1} ms p95 {:.1} ms; last correct note p50 {:.1} ms p95 {:.1} ms (from the first string)", percentile(&mut first_lat.clone(), 50.0), percentile(&mut first_lat, 95.0), percentile(&mut all_lat.clone(), 50.0), percentile(&mut all_lat, 95.0));
    println!("  malformed event streams: {malformed}");

    // A progression: each chord muted as the next is strummed.
    let prog = [("G", "320003"), ("C", "x32010"), ("D", "xx0232"), ("Em", "022000"), ("Am", "x02210"), ("F", "133211"), ("E", "022100"), ("A", "x02220")];
    let mut plucks = Vec::new();
    let mut truth = Vec::new();
    for (i, (_, shape)) in prog.iter().enumerate() {
        let notes = testsig::shape_notes(shape, &STANDARD_TUNING);
        let t = 0.2 + i as f32 * 0.6;
        let mut ps = testsig::strum(&notes, t, 20.0, -18.0, true, 500 + i as u32);
        for p in ps.iter_mut() {
            p.ring_s = 0.6 - (p.start_s - t) - 0.005;
            p.mute_ms = 8.0;
        }
        plucks.extend(ps);
        truth.push((at(t), notes));
    }
    let (x, _) = testsig::mix(fs, 0.2 + prog.len() as f32 * 0.6 + 0.5, &plucks);
    let ev = poly_run(cfg, &x);
    let ons = note_ons(&ev);
    let mut prog_score = Score::default();
    for (i, (t, notes)) in truth.iter().enumerate() {
        let next = truth.get(i + 1).map_or(u64::MAX, |n| n.0);
        let mut got: Vec<u8> = ons.iter().filter(|o| o.1 + at(0.03) >= *t && o.1 < next.saturating_sub(at(0.03))).map(|o| o.2).collect();
        got.sort();
        got.dedup();
        let mut want = notes.clone();
        want.sort();
        want.dedup();
        prog_score.add(&want, &got);
        if verbose && got != want {
            println!("  progression {}: want {want:?} got {got:?}", prog[i].0);
        }
    }
    // Notes left sounding into the next chord more than 100 ms.
    let spans = entropy_engine::guitar::replay::poly_spans(&ev);
    let hung = spans.iter().filter(|s| {
        let chord = truth.iter().rposition(|t| t.0 <= s.on_source + at(0.03)).unwrap_or(0);
        let next = truth.get(chord + 1).map_or(u64::MAX, |n| n.0);
        let h = s.off_source.map_or(true, |o| o > next.saturating_add(at(0.1))) && !truth.get(chord + 1).map_or(false, |n| n.1.contains(&s.note));
        if h && verbose {
            println!("  hanging: note {} on {:.3}s off {:?}s (chord {} ends {:.3}s)", s.note, s.on_source as f32 / fs, s.off_source.map(|o| o as f32 / fs), prog[chord].0, next as f32 / fs);
        }
        h
    }).count();
    println!("  progression of {} chords  {}  notes hanging into the next chord: {hung}  well formed: {}", prog.len(), prog_score.line(), entropy_engine::guitar::replay::check_well_formed_poly(&ev).is_ok());

    // An arpeggio left to ring: C major, one string every 250 ms.
    let notes = testsig::shape_notes("x32010", &STANDARD_TUNING);
    let plucks: Vec<Pluck> = notes.iter().enumerate().map(|(i, &n)| {
        let mut p = Pluck::note(n).starting(0.2 + i as f32 * 0.25).loud(-18.0).seeded(900 + i as u32);
        p.pluck_position = 0.15;
        p
    }).collect();
    let (x, _) = testsig::mix(fs, 2.0, &plucks);
    let ev = poly_run(cfg, &x);
    let ons = note_ons(&ev);
    let got: Vec<u8> = ons.iter().map(|o| o.2).collect();
    let early_offs = ev.iter().filter(|e| matches!(e.kind, entropy_engine::guitar::GuitarEventKind::NoteOff { .. }) && e.sample < x.len() as u64 - 64).count();
    println!("  arpeggio let ring: played {notes:?}, Note Ons {got:?}, notes ended before the stop: {early_offs}");

    // A noisy room with handling thumps.
    let mut room = vec![0.0f32; (30.0 * fs) as usize];
    testsig::add_hum(&mut room, fs, 60.0, -52.0);
    testsig::add_noise(&mut room, -60.0, 77);
    let times: Vec<f32> = (0..20).map(|i| 0.7 + i as f32 * 1.43).collect();
    testsig::add_handling_noise(&mut room, fs, &times, -22.0, 4242);
    let ev = poly_run(cfg, &room);
    println!("  30 s of room noise and 20 thumps: {} Note Ons", note_ons(&ev).len());
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
            for polyphony in [Polyphony::Mono, Polyphony::Poly] {
                let cfg = GuitarConfig::default().with_polyphony(polyphony);
                let mut plucks: Vec<Pluck> = (0..40).map(|i| Pluck::note(40 + (i * 7) % 48).starting(0.2 + i as f32 * 0.25).loud(-16.0).seeded(i as u32 + 1)).collect();
                for (i, (_, shape)) in testsig::CHORD_SHAPES.iter().take(10).enumerate() {
                    plucks.extend(testsig::strum(&testsig::shape_notes(shape, &STANDARD_TUNING), 0.3 + i as f32 * 1.0, 25.0, -18.0, true, i as u32 + 1));
                }
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
                println!("{}: 128-sample callback ({period_us:.0} us of audio), {} callbacks", polyphony.name(), times.len());
                println!("  mean {mean:.1} us ({:.1}%)  p99 {p99:.1} us  p99.9 {p999:.1} us ({:.1}%)  max {max:.1} us", mean / period_us * 100.0, p999 / period_us * 100.0);
            }
        }
        "chords" => {
            let verbose = std::env::args().any(|a| a == "-v");
            let corpus = chord_corpus(4, 25.0, 0.2);
            for after in [45.0f32, 70.0, 100.0, 150.0] {
                let (c, s) = chord_frames(&corpus, PolyParams::default(), after, verbose);
                println!("detector alone, window {after} ms after the first string, strum 25 ms");
                println!("  chords  {}", c.line());
                println!("  singles {}", s.line());
            }
        }
        "chord-trace" => {
            let name = std::env::args().nth(2).unwrap_or_else(|| "A octave".into());
            let after: f32 = std::env::args().nth(3).and_then(|a| a.parse().ok()).unwrap_or(100.0);
            let corpus = chord_corpus(4, 25.0, 0.2);
            let mut det = PolyDetector::new(&mut realfft::RealFftPlanner::new(), 48_000.0, 70.0, 1400.0, 440.0, STANDARD_TUNING, 24, 4096);
            let end = ((after - 3.0) / 1000.0 * 48_000.0) as usize;
            for case in corpus.iter().filter(|c| c.name.starts_with(&name)) {
                let mut frame = PolyFrame::default();
                det.analyze(&case.x[..end], NoteSet::default(), &mut frame);
                let mut got: Vec<u8> = frame.iter().map(|n| n.note).collect();
                got.sort();
                println!("{}: want {:?} got {got:?}", case.name, case.notes);
                for t in det.trace() {
                    println!("    {:3} rel {:5.3} {:6.1} dB {:?}", t.note, t.rel, t.strength_db, t.verdict);
                }
            }
        }
        "poly" => {
            let verbose = std::env::args().any(|a| a == "-v");
            for mode in Mode::ALL {
                let cfg = GuitarConfig::default().with_mode(mode).with_polyphony(Polyphony::Poly);
                poly_report(&cfg, 3, verbose && mode == Mode::Balanced);
            }
        }
        "tune" => {
            let corpus = chord_corpus(3, 25.0, 0.2);
            let d = PolyParams::default();
            let f1 = |s: &Score| {
                let pr = s.tp as f32 / (s.tp + s.fp).max(1) as f32;
                let r = s.tp as f32 / (s.tp + s.fn_).max(1) as f32;
                2.0 * pr * r / (pr + r).max(1e-6) * 100.0
            };
            let mut rows = Vec::new();
            for rel_new in [0.18f32, 0.22, 0.28] {
                for rel_clean in [0.12f32, 0.16, 0.2] {
                    for rel_related in [0.3f32, 0.45] {
                        for max_below_db in [15.0f32, 20.0, 30.0] {
                            for compress in [1.0f32, 0.7] {
                                let p = PolyParams { rel_new, rel_clean: rel_clean.min(rel_new), rel_related, max_below_db, compress, ..d };
                                let mut line = String::new();
                                let (mut total, mut single_fp) = (0.0, 0);
                                for after in [70.0f32, 100.0, 150.0] {
                                    let (c, s) = chord_frames(&corpus, p, after, false);
                                    total += f1(&c);
                                    single_fp += s.fp;
                                    line += &format!(" {after}ms F1 {:.1} exact {:.0}% pc {:.0}% |", f1(&c), c.exact as f32 / c.trials as f32 * 100.0, c.chroma_exact as f32 / c.trials as f32 * 100.0);
                                }
                                let score = total / 3.0 - 0.5 * single_fp as f32;
                                rows.push((score, format!("new {rel_new} clean {rel_clean} related {rel_related} below {max_below_db} compress {compress}:{line} singles fp {single_fp}")));
                            }
                        }
                    }
                }
            }
            rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
            for r in rows.iter().take(20) {
                println!("{:.1} {}", r.0, r.1);
            }
        }
        other => eprintln!("unknown mode {other}; use sweep, compare, stress, cpu, poly, chords, chord-trace or tune"),
    }
}

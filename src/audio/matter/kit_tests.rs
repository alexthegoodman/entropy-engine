//! The kit, measured: pieces together, hearing each other, sleeping when silent. Run with
//! `cargo test --release --lib matter`.

use super::cymbal::{Cymbal, CymbalSpec};
use super::kit::*;
use super::*;

const SR: f32 = 44_100.0;

fn left(x: &[[f32; 2]]) -> Vec<f32> {
    x.iter().map(|f| f[0] + f[1]).collect()
}

fn run(kit: &mut Kit, seconds: f32) -> Vec<[f32; 2]> {
    (0..(seconds * SR) as usize).map(|_| kit.next_frame()).collect()
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

/// Build times, peaks at a hard hit, the cost of a groove, and what the pieces hear of each other.
#[test]
#[ignore]
fn kit_report() {
    let t = std::time::Instant::now();
    let mut kit = Kit::new(KitSpec::default(), SR);
    println!("built in {:.2}s (cold); min delay {} samples", t.elapsed().as_secs_f32(), kit.min_delay());
    let t = std::time::Instant::now();
    let _ = Kit::new(KitSpec::default(), SR);
    println!("built in {:.3}s (warm)", t.elapsed().as_secs_f32());
    for p in Piece::ALL {
        let mut k = Kit::new(KitSpec { sympathetic: false, ..KitSpec::default() }, SR);
        k.strike(p, KitHit::at(p, 6.0, if p.is_cymbal() { 0.9 } else { 0.35 }).strike);
        let out = run(&mut k, 1.0);
        let peak = out.iter().fold(0.0f32, |m, f| m.max(f[0].abs()).max(f[1].abs()));
        let s = k.state(p);
        println!("{:>9}: peak {:.3} ({:.1} dBFS); contact {:.2} ms, {:.0} N, out {:.2} m/s", p.name(), peak, 20.0 * peak.log10(), s.report.contact_samples as f32 / SR * 1e3, s.report.peak_force, s.report.speed_out);
    }
    // A groove: kick and snare with the ride, a crash on one.
    let groove = |kit: &mut Kit| {
        let mut cost = std::time::Duration::ZERO;
        let beat = (0.25 * SR) as usize;
        for i in 0..(4.0 * SR) as usize {
            if i % BLOCK == 0 {
                if i % beat == 0 {
                    let b = i / beat;
                    kit.strike(Piece::Ride, KitHit::at(Piece::Ride, 2.5, 0.6).strike);
                    if b % 4 == 0 {
                        kit.strike(Piece::Kick, KitHit::at(Piece::Kick, 3.0, 0.2).strike);
                    }
                    if b % 4 == 2 {
                        kit.strike(Piece::Snare, KitHit::at(Piece::Snare, 4.0, 0.3).strike);
                    }
                    if b == 0 {
                        kit.strike(Piece::Crash, KitHit::at(Piece::Crash, 5.0, 0.92).strike);
                    }
                }
            }
            let t = std::time::Instant::now();
            std::hint::black_box(kit.next_frame());
            cost += t.elapsed();
        }
        cost.as_secs_f32() / 4.0 * 100.0
    };
    for w in [0, 1, 2, 3] {
        println!("groove, {w} workers: the audio thread is busy {:.0}% of real time", groove(&mut Kit::with_workers(KitSpec::default(), SR, w)));
    }
    // The same with the cymbals' coupling always on.
    let mut k = Kit::new(KitSpec::default(), SR);
    for p in [Piece::Crash, Piece::Ride, Piece::Splash] {
        k.with_body(p, |b| if let Body::Cymbal(c) = b { c.set_nonlinear_floor(0.0) });
    }
    println!("groove, cymbal coupling never resting: {:.0}% of a core", groove(&mut k));
    // Sympathy: a floor tom hit, and what the snare does.
    for sym in [true, false] {
        let mut k = Kit::new(KitSpec { sympathetic: sym, ..KitSpec::default() }, SR);
        k.strike(Piece::FloorTom, KitHit::at(Piece::FloorTom, 4.0, 0.35).strike);
        let _ = run(&mut k, 1.0);
        let s = k.state(Piece::Snare);
        println!("floor tom hit, sympathetic {sym}: snare landings {}, awake pieces {}", s.wire_landings, k.awake());
    }
    // Resting the crash's coupling.
    for floor in [0.0, 1.0e-3, 3.0e-3, 1.0e-2, 3.0e-2] {
        let mut c = Cymbal::new(CymbalSpec::crash(), SR);
        c.set_nonlinear_floor(floor);
        c.strike(Strike { velocity: 5.0, position: 0.92, angle: 0.0, striker: CymbalSpec::crash().striker });
        let mut rest_at = None;
        let x: Vec<f32> = (0..(8.0 * SR) as usize)
            .map(|i| {
                let v = c.next_sample();
                if rest_at.is_none() && c.nonlinear_resting() {
                    rest_at = Some(i as f32 / SR);
                }
                v
            })
            .collect();
        println!("floor {floor:e}: rests at {rest_at:?} s, bands {:?}", bands(&x).iter().map(|b| (b * 10.0).round() / 10.0).collect::<Vec<_>>());
    }
}

#[test]
fn every_piece_answers_a_strike_and_then_sleeps() {
    let mut kit = Kit::new(KitSpec { sympathetic: false, ..KitSpec::default() }, SR);
    assert!(kit.is_silent());
    for p in Piece::ALL {
        kit.strike(p, KitHit::at(p, 3.0, 0.4).strike);
    }
    let out = run(&mut kit, 0.2);
    assert_eq!(kit.awake(), PIECES);
    let peak = out.iter().fold(0.0f32, |m, f| m.max(f[0].abs()));
    assert!(peak > 0.01, "the kit should sound ({peak})");
    for p in Piece::ALL {
        assert!(kit.state(p).report.count == 1 && kit.state(p).report.peak_force > 0.0, "{p:?} was not struck");
    }
    // Long after, everything has fallen silent and gone to sleep.
    let _ = run(&mut kit, 20.0);
    assert!(kit.is_silent(), "still awake: {:?}", Piece::ALL.iter().filter(|p| kit.state(**p).awake).collect::<Vec<_>>());
}

#[test]
fn the_kit_sounds_its_pieces_and_pans_them_where_they_stand() {
    // A struck piece in the kit sounds as the same drum on its own (sympathy off), panned.
    let spec = KitSpec { sympathetic: false, ..KitSpec::default() };
    let hit = KitHit::at(Piece::FloorTom, 3.0, 0.4);
    let mut kit = Kit::new(spec, SR);
    kit.strike(hit.piece, hit.strike);
    let out = run(&mut kit, 0.5);
    let alone = render_hit(&spec.drum(Piece::FloorTom).unwrap(), hit.strike, SR, 0.5);
    let (gl, gr) = pan(Piece::FloorTom);
    assert!(gr > gl, "the floor tom stands on the right");
    for (i, f) in out.iter().enumerate() {
        assert!((f[0] - alone[i] * gl * KIT_GAIN).abs() < 1.0e-6 && (f[1] - alone[i] * gr * KIT_GAIN).abs() < 1.0e-6, "sample {i}");
    }
}

#[test]
fn strikes_are_sample_accurate_within_a_block() {
    let spec = KitSpec { sympathetic: false, ..KitSpec::default() };
    let hit = KitHit::at(Piece::RackTom, 3.0, 0.4);
    let onset = |offset: usize| {
        let mut kit = Kit::with_workers(spec, SR, 0);
        kit.schedule(hit.piece, hit.strike, offset);
        let out = left(&run(&mut kit, 0.01));
        out.iter().position(|v| v.abs() > 1.0e-6).unwrap()
    };
    assert_eq!(onset(13), onset(0) + 13);
}

#[test]
fn no_two_pieces_are_closer_than_a_block_of_sound() {
    let kit = Kit::new(KitSpec::default(), SR);
    assert!(kit.min_delay() >= BLOCK);
    // And the layout's sizes are the drums' own.
    for p in Piece::ALL {
        let r = match (KitSpec::default().drum(p), KitSpec::default().cymbal(p)) {
            (Some(d), _) => d.batter.radius,
            (_, Some(c)) => c.plate.radius,
            _ => unreachable!(),
        };
        assert!((placement(p).radius - r).abs() < 1.0e-4, "{p:?}: drawn {} vs {r}", placement(p).radius);
        if let Some(d) = KitSpec::default().drum(p) {
            assert!((placement(p).depth - d.depth).abs() < 1.0e-4, "{p:?} depth");
        }
    }
}

#[test]
fn a_tom_sets_the_snare_wires_buzzing_through_the_air() {
    // The rack tom: the nearest drum, tuned nearest the snare.
    let hit = KitHit::at(Piece::RackTom, 3.0, 0.35);
    let landings = |spec: KitSpec| {
        let mut kit = Kit::new(spec, SR);
        kit.strike(hit.piece, hit.strike);
        let _ = run(&mut kit, 1.0);
        (kit.state(Piece::Snare).wire_landings, kit.state(Piece::Snare).report.count)
    };
    let (with, struck) = landings(KitSpec::default());
    assert_eq!(struck, 0, "nothing struck the snare");
    assert!(with >= 10, "the tom should set the wires buzzing ({with} landings)");
    assert_eq!(landings(KitSpec { sympathetic: false, ..KitSpec::default() }).0, 0, "without the air between them, nothing");
    assert_eq!(landings(KitSpec { snares: false, ..KitSpec::default() }).0, 0, "snares off: no wires to buzz");
}

#[test]
fn sympathy_arrives_after_the_sound_has_crossed_the_kit() {
    let mut kit = Kit::new(KitSpec::default(), SR);
    kit.strike(Piece::Kick, KitHit::at(Piece::Kick, 4.0, 0.2).strike);
    let mut woke = None;
    for i in 0..(0.1 * SR) as usize {
        kit.next_frame();
        if woke.is_none() && kit.state(Piece::Snare).awake {
            woke = Some(i);
        }
    }
    let woke = woke.expect("a hard kick should wake the snare") as f32;
    let d = distance_between(Piece::Kick, Piece::Snare);
    // The snare wakes at the block the kick's sound reaches it (it wakes on whole blocks).
    assert!(woke + BLOCK as f32 >= d / 343.0 * SR, "woke at {woke} samples, the sound takes {:.0}", d / 343.0 * SR);
}

fn distance_between(a: Piece, b: Piece) -> f32 {
    let (x, y) = (placement(a).source(), placement(b).centre);
    ((x[0] - y[0]).powi(2) + (x[1] - y[1]).powi(2) + (x[2] - y[2]).powi(2)).sqrt()
}

#[test]
fn a_resting_cymbal_coupling_changes_the_crash_by_under_a_decibel() {
    let run = |floor: f32| {
        let mut c = Cymbal::new(CymbalSpec::crash(), SR);
        c.set_nonlinear_floor(floor);
        c.strike(Strike { velocity: 5.0, position: 0.92, angle: 0.0, striker: CymbalSpec::crash().striker });
        let x: Vec<f32> = (0..(8.0 * SR) as usize).map(|_| c.next_sample()).collect();
        (x, c.nonlinear_resting())
    };
    let (always, _) = run(0.0);
    let (resting, rested) = run(NONLINEAR_FLOOR);
    assert!(rested, "the coupling should rest within eight seconds");
    let (a, b) = (bands(&always), bands(&resting));
    let worst = a.iter().zip(b.iter()).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
    let mean = a.iter().zip(b.iter()).map(|(x, y)| (x - y).abs()).sum::<f32>() / a.len() as f32;
    assert!(mean < 0.5 && worst < 1.5, "third-octave bands move by {mean:.2} dB on average, {worst:.2} at most");
}

#[test]
fn field_and_modes_follow_the_struck_head() {
    let mut kit = Kit::new(KitSpec { sympathetic: false, ..KitSpec::default() }, SR);
    let mut field = vec![0.0; FIELD];
    kit.field(Piece::Snare, &mut field);
    assert!(field.iter().all(|v| *v == 0.0), "at rest the head is flat");
    kit.strike(Piece::Snare, KitHit::at(Piece::Snare, 4.0, 0.0).strike);
    let _ = run(&mut kit, 0.004);
    kit.field(Piece::Snare, &mut field);
    let peak = field.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(peak > 1.0e-5, "a centre hit moves the head ({peak} m)");
    // A centre strike is axisymmetric: every point of a ring moves alike.
    let ring = &field[1 + 2 * FIELD_SPOKES..1 + 3 * FIELD_SPOKES];
    let spread = ring.iter().fold(0.0f32, |m, v| m.max((v - ring[0]).abs()));
    assert!(spread < 0.02 * peak, "ring spread {spread} against {peak}");
    let (mut hz, mut amp) = ([0.0; SPECTRUM], [0.0; SPECTRUM]);
    let n = kit.modes(Piece::Snare, &mut hz, &mut amp);
    assert_eq!(n, SPECTRUM);
    assert!(hz[..n].iter().all(|f| *f > 50.0 && *f < 20_000.0));
    assert!(amp.iter().any(|a| *a > 0.0));
    // The force trace caught the stick's contact.
    assert_eq!(kit.focus(), Piece::Snare);
    let mut trace = vec![0.0; TRACE_CAPTURE];
    let n = kit.trace(Piece::Snare, &mut trace);
    assert!(trace[..n].iter().any(|f| *f > 10.0));
}


#[test]
fn the_pieces_sound_the_same_on_one_thread_or_several() {
    let play = |workers: usize| {
        let mut kit = Kit::with_workers(KitSpec::default(), SR, workers);
        assert_eq!(kit.workers(), workers);
        let mut out = Vec::new();
        for (i, p) in [Piece::Kick, Piece::Ride, Piece::Snare, Piece::Crash, Piece::RackTom].iter().enumerate() {
            kit.schedule(*p, KitHit::at(*p, 3.0 + i as f32, 0.4).strike, i * 5);
            out.extend(run(&mut kit, 0.05));
        }
        out.extend(run(&mut kit, 0.3));
        out
    };
    let one = play(0);
    assert!(one.iter().any(|f| f[0].abs() > 1.0e-3));
    for w in [1, 3] {
        assert!(play(w) == one, "{w} workers changed the sound");
    }
}

#[test]
fn a_performance_renders_each_hit_at_its_time_and_ends_when_the_kit_is_silent() {
    let spec = KitSpec { sympathetic: false, ..KitSpec::default() };
    let hits = [(0.25f64, KitHit::at(Piece::RackTom, 3.0, 0.4)), (0.5, KitHit::at(Piece::Kick, 3.0, 0.2))];
    let out = super::live::render_performance(spec, [1.0; PIECES], &hits, 20.0);
    let first = out.chunks(2).position(|f| f[0].abs() + f[1].abs() > 1.0e-6).unwrap();
    assert!((first as i64 - (0.25 * SR) as i64).abs() <= 2, "the first hit sounds at {first}");
    // It stops once everything has rung down, well before the 20 s cap.
    let secs = out.len() as f32 / 2.0 / SR;
    assert!(secs > 1.0 && secs < 15.0, "rendered {secs} s");
    // The mix scales a piece's level.
    let louder = super::live::render_performance(spec, [2.0; PIECES], &hits[..1], 20.0);
    let quiet = super::live::render_performance(spec, [1.0; PIECES], &hits[..1], 20.0);
    let peak = |x: &[f32]| x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!((peak(&louder) / peak(&quiet) - 2.0).abs() < 1.0e-3);
}

/// Renders the kit playing to `test-artifacts/matter/` for ears: a groove, a fill round the toms
/// into a crash, the same tom hits with the pieces hearing each other and without, and a jazz ride
/// pattern with ghost notes.
#[test]
#[ignore]
fn kit_listening_examples() {
    let dir = std::path::Path::new("test-artifacts/matter");
    std::fs::create_dir_all(dir).unwrap();
    let write = |name: &str, x: &[f32]| {
        let spec = hound::WavSpec { channels: 2, sample_rate: SR as u32, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(dir.join(name), spec).unwrap();
        let peak = x.iter().fold(1.0e-6f32, |m, v| m.max(v.abs()));
        for v in x {
            w.write_sample((v / peak * 0.8 * 32767.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    };
    let mix = [3.0, 1.0, 2.0, 2.5, 2.0, 3.0, 1.5];
    let h = |t: f64, p: Piece, v: f32, pos: f32| (t, KitHit::at(p, v, pos));
    // A groove at 100 bpm: ride on eighths, kick on 1 and 3, backbeat on the snare, a crash on one.
    let e = 0.3f64;
    let mut groove = vec![h(0.0, Piece::Crash, 5.0, 0.92)];
    for i in 0..16 {
        let t = i as f64 * e;
        groove.push(h(t, Piece::Ride, if i % 2 == 0 { 3.0 } else { 1.8 }, 0.6));
        if i % 4 == 0 {
            groove.push(h(t, Piece::Kick, 4.0, 0.25));
        }
        if i % 4 == 2 {
            groove.push(h(t, Piece::Snare, 4.5, 0.3));
        }
    }
    write("kit_groove.wav", &super::live::render_performance(KitSpec::default(), mix, &groove, 3.0));
    // A fill down the toms into a crash and a kick.
    let fill: Vec<_> = [(Piece::Snare, 0.3), (Piece::Snare, 0.3), (Piece::RackTom, 0.35), (Piece::RackTom, 0.35), (Piece::FloorTom, 0.35), (Piece::FloorTom, 0.35)]
        .iter()
        .enumerate()
        .map(|(i, &(p, pos))| h(i as f64 * 0.15, p, 5.0, pos))
        .chain([h(0.9, Piece::Crash, 6.0, 0.92), h(0.9, Piece::Kick, 5.0, 0.25)])
        .collect();
    write("kit_fill.wav", &super::live::render_performance(KitSpec::default(), mix, &fill, 3.0));
    // Toms alone, then the same with the pieces deaf to each other: the snare wires answer or not.
    let toms = vec![h(0.0, Piece::RackTom, 5.0, 0.35), h(0.6, Piece::FloorTom, 6.0, 0.35), h(1.2, Piece::Kick, 5.0, 0.25)];
    write("kit_toms_sympathetic.wav", &super::live::render_performance(KitSpec::default(), mix, &toms, 2.0));
    write("kit_toms_deaf.wav", &super::live::render_performance(KitSpec { sympathetic: false, ..KitSpec::default() }, mix, &toms, 2.0));
    // Jazz: a small kit, the ride's spang-a-lang and feathered ghost notes.
    let jazz = KitSpec { kick: 68.0, snare: 260.0, rack_tom: 190.0, floor_tom: 110.0, kick_muffling: 0.15, snare_tension: 0.1, ..KitSpec::default() };
    let swing = 0.4f64;
    let mut pattern = Vec::new();
    for bar in 0..4 {
        let b = bar as f64 * 4.0 * swing;
        for beat in 0..4 {
            pattern.push(h(b + beat as f64 * swing, Piece::Ride, 2.5, 0.6));
            if beat % 2 == 1 {
                pattern.push(h(b + beat as f64 * swing + swing * 0.66, Piece::Ride, 1.5, 0.6));
            }
            pattern.push(h(b + beat as f64 * swing, Piece::Kick, 0.6, 0.25));
            pattern.push(h(b + beat as f64 * swing + swing * 0.66, Piece::Snare, 0.5, 0.4));
        }
    }
    write("kit_jazz.wav", &super::live::render_performance(jazz, mix, &pattern, 3.0));
}

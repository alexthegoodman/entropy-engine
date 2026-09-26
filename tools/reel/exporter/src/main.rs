//! The reel's soundtrack and telemetry: every note is played by Entropy DAW's physical models
//! (the brass players, the bowed strings, the drum kit), and at every video frame we record what
//! the models are doing - bore pressure, lip motion, slide and valves, string shapes, drum-head
//! fields - so the picture is drawn from the same state the sound comes from.
//!
//! Output (in the directory given as the first argument):
//!   stems/<part>.wav   float stereo 44.1 kHz, one per part
//!   telemetry.json     60 fps state for the renderer
//!   mix.wav            the mixed soundtrack, the picture's length (16-bit; see `mix`)
//!   mix_env.json       the mix's level and spectrum per frame

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use entropy_reel::audio::brass::{self, Articulation as BArt, BrassInstrument, BrassLive, BrassParams, Mute, BORE_POINTS, TRACE_POINTS};
use entropy_reel::audio::matter::kit::{placement, Kit, KitSpec, Piece, FIELD, SPECTRUM};
use entropy_reel::audio::matter::{Strike, StrikerSpec};
use entropy_reel::audio::physmod::engine::{Engine as SEngine, PhysModLive, PhysModParams, StringReport, MAX_ALL_STRINGS};
use entropy_reel::audio::physmod::SHAPE_POINTS;
use entropy_reel::tubing::{fit_box, tubing};
use serde_json::{json, Value};

mod mix;

const SR: f32 = 44_100.0;
const FPS: usize = 60;
const SPF: usize = 735; // samples per video frame
const FRAMES: usize = 900; // 15.0 s
/// Rendered a little past the picture so the reverb has something to decay into.
const SECONDS: f32 = 15.6;

// ------------------------------------------------------------------------------------------
// Pitches (B-flat minor, ending in B-flat major)
// ------------------------------------------------------------------------------------------
const F1: f32 = 43.65;
const GB1: f32 = 46.25;
const AB1: f32 = 51.91;
const BB1: f32 = 58.27;
const F2: f32 = 87.31;
const GB2: f32 = 92.50;
const AB2: f32 = 103.83;
const BB2: f32 = 116.54;
const B2: f32 = 123.47;
const C3: f32 = 130.81;
const DB3: f32 = 138.59;
const D3: f32 = 146.83;
const EB3: f32 = 155.56;
const E3: f32 = 164.81;
const F3: f32 = 174.61;
const A3: f32 = 220.00;
const BB3: f32 = 233.08;
const C4: f32 = 261.63;
const D4: f32 = 293.66;
const F4: f32 = 349.23;
const A4: f32 = 440.00;
const BB4: f32 = 466.16;
const C5: f32 = 523.25;
const DB5: f32 = 554.37;
const D5: f32 = 587.33;
const EB5: f32 = 622.25;
const F5: f32 = 698.46;
const GB5: f32 = 739.99;

/// The smear's chromatic steps on partial 3, and seconds per step.
const SMEAR: [f32; 7] = [B2, C3, DB3, D3, EB3, E3, F3];
const SMEAR_STEP: f32 = 0.13;

fn smooth(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}
/// Linear interpolation through (time, value) keys, eased between keys.
fn keys(k: &[(f32, f32)], t: f32) -> f32 {
    if t <= k[0].0 {
        return k[0].1;
    }
    for w in k.windows(2) {
        if t <= w[1].0 {
            let u = (t - w[0].0) / (w[1].0 - w[0].0).max(1e-6);
            return w[0].1 + (w[1].1 - w[0].1) * smooth(u);
        }
    }
    k[k.len() - 1].1
}

fn r(v: f32, digits: i32) -> Value {
    if !v.is_finite() {
        return json!(0);
    }
    let m = 10f32.powi(digits);
    json!((v * m).round() / m)
}
fn arr(v: &[f32], digits: i32) -> Value {
    Value::Array(v.iter().map(|x| r(*x, digits)).collect())
}
/// Rounds to `sig` significant digits (for values spanning decades: pressures, fields).
fn sig(v: f32, sig: i32) -> Value {
    if !v.is_finite() || v == 0.0 {
        return json!(0);
    }
    let d = sig - 1 - v.abs().log10().floor() as i32;
    let m = 10f64.powi(d);
    json!(((v as f64) * m).round() / m)
}
fn sigs(v: &[f32], s: i32) -> Value {
    Value::Array(v.iter().map(|x| sig(*x, s)).collect())
}

// ------------------------------------------------------------------------------------------
// Brass
// ------------------------------------------------------------------------------------------

struct BNote {
    t: f32,
    off: f32,
    p: BrassParams,
}

struct BrassPart {
    name: &'static str,
    instrument: BrassInstrument,
    notes: Vec<BNote>,
    /// Live breath over time (None: each note's own).
    breath: Option<Vec<(f32, f32)>>,
    pan: f32,
    featured: bool,
}

fn bp(instrument: BrassInstrument, freq: f32, breath: f32, attack: f32, release: f32) -> BrassParams {
    BrassParams { instrument, freq, breath, velocity: 0.75, gain: 0.7, attack, release, attack_skill: 1.0, vibrato_depth: 0.0, articulation: BArt::Tongued, ..Default::default() }
}

fn brass_parts() -> Vec<BrassPart> {
    use BrassInstrument::*;
    // Every player's notes; `off` is when the note is released (gated).
    let n = |t: f32, off: f32, p: BrassParams| BNote { t, off, p };
    let hit = |i, f| bp(i, f, 0.95, 0.002, 0.18);
    let stab = |i, f| bp(i, f, 0.88, 0.002, 0.12);
    let swell = |i, f| bp(i, f, 0.40, 0.03, 0.06);
    let fin = |i, f| bp(i, f, 0.95, 0.002, 0.35);
    // The dominant swell and the final chord share one breath curve per player.
    let swell_breath = [(11.45, 0.30), (12.30, 0.93)];
    let final_breath = [(12.5, 0.97), (12.72, 0.97), (13.05, 0.56), (13.95, 0.9)];
    let join = |a: &[(f32, f32)], b: &[(f32, f32)], c: &[(f32, f32)]| -> Vec<(f32, f32)> { a.iter().chain(b.iter()).chain(c.iter()).copied().collect() };
    let hit_breath = [(2.5, 0.97), (3.1, 0.97)];

    vec![
        BrassPart {
            name: "tbn1",
            instrument: TenorTrombone,
            notes: vec![
                // The swell: one breath from pianissimo to a shocked, blazing wavefront.
                n(0.12, 2.49, bp(TenorTrombone, BB2, 0.14, 0.035, 0.08)),
                // Re-tongued on the hit.
                n(2.5, 3.02, hit(TenorTrombone, BB2)),
                n(12.5, 14.08, fin(TenorTrombone, BB2)),
            ]
            .into_iter()
            // The smear: B2 to F3, every step on partial 3 (7th position in to 1st), slurred with
            // no tongue so the slide's glide is heard; each step re-aims the lips at the resonance
            // the slide is moving through.
            .chain(SMEAR.iter().enumerate().map(|(k, &f)| {
                let t = 10.5 + SMEAR_STEP * k as f32;
                let off = if k + 1 < SMEAR.len() { t + SMEAR_STEP + 0.001 } else { 12.33 };
                let art = if k == 0 { BArt::Tongued } else { BArt::Glissando };
                n(t, off, BrassParams { articulation: art, slide_time: SMEAR_STEP, ..bp(TenorTrombone, f, 0.5, 0.012, 0.05) })
            }))
            .collect(),
            breath: Some(join(
                &[(0.0, 0.14), (0.45, 0.16), (1.2, 0.42), (1.9, 0.78), (2.38, 0.99), (2.49, 0.99)],
                &join(&hit_breath, &[(10.45, 0.5), (11.3, 0.88), (11.6, 0.64), (12.3, 0.95)], &[]),
                &final_breath,
            )),
            pan: 0.1,
            featured: true,
        },
        BrassPart {
            name: "tbn2",
            instrument: TenorTrombone,
            notes: vec![n(2.5, 3.02, hit(TenorTrombone, F3)), n(11.5, 12.33, swell(TenorTrombone, A3)), n(12.5, 14.08, fin(TenorTrombone, F3))],
            breath: Some(join(&hit_breath, &swell_breath, &final_breath)),
            pan: 0.25,
            featured: false,
        },
        BrassPart {
            name: "tuba",
            instrument: Tuba,
            notes: vec![
                n(2.5, 3.05, hit(Tuba, BB1)),
                n(4.5, 4.86, stab(Tuba, BB1)),
                n(11.5, 12.33, swell(Tuba, F1)),
                n(12.5, 14.08, fin(Tuba, BB1)),
            ],
            breath: Some(join(&hit_breath, &[(4.5, 0.88), (4.9, 0.88), (11.45, 0.3)], &join(&swell_breath, &[], &final_breath))),
            pan: 0.35,
            featured: false,
        },
        BrassPart {
            name: "hn1",
            instrument: Horn,
            notes: vec![
                n(2.5, 3.0, hit(Horn, BB3)),
                n(4.0, 4.36, stab(Horn, F4)),
                n(11.5, 12.33, swell(Horn, C4)),
                n(12.5, 14.08, fin(Horn, D4)),
            ],
            breath: Some(join(&hit_breath, &[(4.0, 0.88), (4.4, 0.88), (11.45, 0.3)], &join(&swell_breath, &[], &final_breath))),
            pan: -0.35,
            featured: false,
        },
        BrassPart {
            name: "hn2",
            instrument: Horn,
            notes: vec![n(2.5, 3.0, hit(Horn, F4)), n(11.5, 12.33, swell(Horn, F4)), n(12.5, 14.08, fin(Horn, F4))],
            breath: Some(join(&hit_breath, &swell_breath, &final_breath)),
            pan: -0.25,
            featured: false,
        },
        BrassPart {
            name: "tpt1",
            instrument: Trumpet,
            notes: vec![n(3.5, 3.82, stab(Trumpet, BB4)), n(11.5, 12.33, swell(Trumpet, A4)), n(12.5, 14.08, fin(Trumpet, BB4))],
            breath: Some(join(&[(3.5, 0.86), (3.9, 0.86), (11.45, 0.3)], &swell_breath, &final_breath)),
            pan: -0.12,
            featured: false,
        },
        BrassPart {
            name: "tpt2",
            instrument: Trumpet,
            notes: vec![n(11.5, 12.33, swell(Trumpet, C5)), n(12.5, 14.08, fin(Trumpet, D5))],
            breath: Some(join(&[(11.45, 0.3)], &swell_breath, &final_breath)),
            pan: 0.02,
            featured: false,
        },
    ]
}

/// A cache of tubing layouts: the renderer draws each by id.
#[derive(Default)]
struct Geometry {
    ids: HashMap<(u32, i32, i32, u32, i32), usize>,
    shapes: Vec<Value>,
}

impl Geometry {
    fn get(&mut self, inst: BrassInstrument, extension: f32, tuning: f32, valves: u32, hand: f32) -> usize {
        let key = (inst.index(), (extension * 500.0).round() as i32, (tuning * 500.0).round() as i32, valves, (hand * 20.0).round() as i32);
        if let Some(&id) = self.ids.get(&key) {
            return id;
        }
        let t = tubing(inst, key.1 as f32 / 500.0, key.2 as f32 / 500.0, valves, Mute::Open, key.4 as f32 / 20.0, 220);
        let mut flat = Vec::with_capacity(t.pts.len() * 11);
        for p in &t.pts {
            flat.extend_from_slice(&[p.pos[0], p.pos[1], p.pos[2], p.normal[0], p.normal[1], p.normal[2], p.binormal[0], p.binormal[1], p.binormal[2], p.radius, p.open]);
        }
        let loops: Vec<Value> = t.idle_loops.iter().map(|l| Value::Array(l.iter().step_by(2).flat_map(|v| v.iter().map(|x| r(*x, 4))).collect())).collect();
        let valves_v: Vec<Value> = t.valves.iter().map(|v| json!({"pos": arr(&v.pos, 4), "down": v.down, "label": v.label})).collect();
        let id = self.shapes.len();
        self.shapes.push(json!({"inst": inst.index(), "pts": arr(&flat, 4), "loops": loops, "valves": valves_v}));
        self.ids.insert(key, id);
        id
    }
}

fn render_brass(part: &BrassPart, geo: &mut Geometry) -> (Vec<f32>, Value) {
    let n = (SECONDS * SR) as usize;
    let mut notes: Vec<&BNote> = part.notes.iter().collect();
    notes.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    let first = &notes[0].p;
    let mut engine = brass::Engine::new(SR, first);
    let live = Arc::new(BrassLive::from_params(first));
    let mut out = Vec::with_capacity(n * 2);
    let mut frames = Vec::with_capacity(FRAMES);
    let (mut on_i, mut off_i) = (0usize, 0usize);
    let mut offs: Vec<(usize, u64)> = notes.iter().enumerate().map(|(i, nt)| ((nt.off * SR) as usize, i as u64 + 1)).collect();
    offs.sort_by_key(|o| o.0);
    let mut bore = [0.0f32; BORE_POINTS];
    let (mut mp, mut lip) = ([0.0f32; TRACE_POINTS], [0.0f32; TRACE_POINTS]);
    let (mut lhz, mut lmag) = ([0.0f32; 16], [0.0f32; 16]);
    let mut sq = 0.0f64;
    for i in 0..n {
        let t = i as f32 / SR;
        if i % 32 == 0 {
            if let Some(b) = &part.breath {
                live.breath.store(keys(b, t).to_bits(), Ordering::Relaxed);
            }
        }
        while on_i < notes.len() && (notes[on_i].t * SR) as usize <= i {
            let nt = notes[on_i];
            engine.note_on(on_i as u64 + 1, nt.p, true, Some(live.clone()));
            on_i += 1;
        }
        while off_i < offs.len() && offs[off_i].0 <= i {
            engine.note_off(offs[off_i].1);
            off_i += 1;
        }
        let [y, _] = engine.next_frame();
        let (gl, gr) = pan_gains(part.pan);
        out.push(y * gl);
        out.push(y * gr);
        sq += (y as f64) * (y as f64);
        if (i + 1) % SPF == 0 && frames.len() < FRAMES {
            let rep = engine.report();
            engine.bore_pressure(&mut bore);
            let rms = (sq / SPF as f64).sqrt() as f32;
            sq = 0.0;
            let gid = geo.get(part.instrument, rep.extension, engine.tuning_slide(), rep.valves, rep.hand);
            let mut f = json!({
                "on": rep.playing,
                "partial": rep.partial,
                "ext": r(rep.extension, 4),
                "pos": r(rep.position, 3),
                "pm": r(rep.mouth_pressure, 0),
                "breath": r(rep.breath, 3),
                "lipHz": r(rep.lip_freq, 2),
                "lipOpen": sig(rep.lip_opening, 3),
                "hz": r(rep.sounding, 2),
                "target": r(rep.target, 2),
                "res": r(rep.resonance, 2),
                "steep": sig(rep.wave_steepness, 3),
                "mpLevel": r(rep.mouthpiece_level, 1),
                "valves": rep.valves,
                "rms": sig(rms, 3),
                "geo": gid,
                "bore": sigs(&bore, 3),
            });
            if part.featured {
                if engine.traces(&mut mp, &mut lip) {
                    f["mp"] = sigs(&mp, 3);
                    f["lip"] = sigs(&lip, 3);
                }
                let k = engine.ladder(&mut lhz, &mut lmag);
                f["ladHz"] = arr(&lhz[..k], 1);
                f["ladMag"] = sigs(&lmag[..k], 3);
            }
            frames.push(f);
        }
    }
    let (lo, hi) = fit_box(part.instrument);
    (out, json!({"name": part.name, "instrument": part.instrument.index(), "fit": [arr(&lo, 4), arr(&hi, 4)], "frames": frames}))
}

fn pan_gains(p: f32) -> (f32, f32) {
    let a = (p.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
    (a.cos() * std::f32::consts::SQRT_2, a.sin() * std::f32::consts::SQRT_2)
}

// ------------------------------------------------------------------------------------------
// Strings
// ------------------------------------------------------------------------------------------

struct SNote {
    t: f32,
    dur: f32,
    p: PhysModParams,
}

struct StringPart {
    name: &'static str,
    notes: Vec<SNote>,
    /// Live bow force and bow speed over time (for swells: a string player swells with the bow's
    /// speed, keeping the force where the string speaks).
    force: Option<Vec<(f32, f32)>>,
    speed: Option<Vec<(f32, f32)>>,
    pan: f32,
}

fn sp(base: &PhysModParams, freq: f32, velocity: f32, dur: f32) -> PhysModParams {
    PhysModParams { freq, velocity, duration: dur, ..*base }
}

fn string_parts() -> Vec<StringPart> {
    let violin = PhysModParams { gain: 0.7, bow_force: 0.55, bow_velocity: 0.62, bow_position: 0.12, brightness: 0.62, body_mix: 0.5, vibrato_depth: 18.0, vibrato_delay: 0.12, attack: 0.05, release: 0.12, damping: 0.1, ..Default::default() };
    let cello = PhysModParams {
        gain: 0.7,
        body_size: 0.72,
        strings: [65.41, 98.0, 146.83, 220.0],
        // A fast, light bow near the bridge: short strokes that speak at once (measured: the
        // clearest of the settings tried for 0.19 s strokes on the C and G strings).
        bow_force: 0.38,
        bow_velocity: 0.8,
        bow_position: 0.10,
        brightness: 0.55,
        body_mix: 0.6,
        vibrato_depth: 0.0,
        attack: 0.012,
        release: 0.05,
        damping: 0.15,
        attack_skill: 1.0,
        ..Default::default()
    };
    let bass = PhysModParams {
        gain: 0.7,
        body_size: 1.0,
        strings: [41.2, 55.0, 73.42, 98.0],
        bow_force: 0.6,
        bow_velocity: 0.55,
        bow_position: 0.12,
        brightness: 0.45,
        body_mix: 0.7,
        vibrato_depth: 6.0,
        vibrato_delay: 0.4,
        slide: 0.04,
        attack: 0.12,
        release: 0.2,
        damping: 0.1,
        ..Default::default()
    };
    let mut cel = Vec::new();
    // The ostinato: eighths on each bar's root (root, root, fifth, root, root, root, fifth, octave).
    let bars: [(f32, f32, f32, usize); 4] = [(3.0, BB2, F3, 8), (5.0, GB2, DB3, 8), (7.0, AB2, EB3, 8), (9.0, F2, C3, 6)];
    for (start, root, fifth, count) in bars {
        let pat = [root, root, fifth, root, root, root, fifth, root * 2.0];
        for k in 0..count {
            let t = start + k as f32 * 0.25;
            let f = if count == 6 && k == 5 { fifth } else { pat[k] };
            let accent = if k % 2 == 0 { 0.92 } else { 0.72 };
            cel.push(SNote { t, dur: 0.19, p: sp(&cello, f, accent, 0.19) });
        }
    }
    cel.push(SNote { t: 12.5, dur: 1.58, p: PhysModParams { attack: 0.02, release: 0.3, vibrato_depth: 10.0, ..sp(&cello, BB2, 1.0, 1.58) } });
    vec![
        StringPart {
            name: "violin",
            notes: vec![
                SNote { t: 5.0, dur: 0.72, p: sp(&violin, F5, 0.85, 0.72) },
                SNote { t: 5.75, dur: 0.24, p: sp(&violin, GB5, 0.8, 0.24) },
                SNote { t: 6.0, dur: 0.46, p: sp(&violin, F5, 0.85, 0.46) },
                SNote { t: 6.5, dur: 0.46, p: sp(&violin, DB5, 0.85, 0.46) },
                SNote { t: 7.0, dur: 0.95, p: sp(&violin, EB5, 0.78, 0.95) },
                SNote { t: 12.5, dur: 1.58, p: PhysModParams { release: 0.3, ..sp(&violin, D5, 1.0, 1.58) } },
            ],
            force: None,
            speed: None,
            pan: -0.4,
        },
        StringPart { name: "cello", notes: cel, force: None, speed: None, pan: 0.3 },
        StringPart {
            name: "bass",
            // One slurred line (a new stroke on a string still ringing from the last one can start
            // in multiple slipping and stay there): the bow keeps going, the finger moves.
            notes: vec![
                SNote { t: 0.35, dur: 4.67, p: sp(&bass, BB1, 0.8, 4.67) },
                SNote { t: 4.99, dur: 2.03, p: sp(&bass, GB1, 0.8, 2.03) },
                SNote { t: 6.99, dur: 2.03, p: sp(&bass, AB1, 0.8, 2.03) },
                SNote { t: 8.99, dur: 3.34, p: sp(&bass, F1, 0.8, 3.34) },
                SNote { t: 12.5, dur: 1.58, p: PhysModParams { attack: 0.01, release: 0.35, ..sp(&bass, BB1, 1.0, 1.58) } },
            ],
            force: Some(vec![(0.35, 0.44), (2.45, 0.5), (2.5, 0.5), (3.0, 0.47)]),
            speed: Some(vec![(0.35, 0.3), (1.2, 0.45), (2.45, 0.85), (2.5, 0.85), (3.0, 0.55), (11.5, 0.5), (12.3, 0.82), (12.5, 0.8)]),
            pan: 0.1,
        },
    ]
}

fn render_strings(part: &StringPart) -> (Vec<f32>, Value) {
    let n = (SECONDS * SR) as usize;
    let first = &part.notes[0].p;
    let mut engine = SEngine::new(SR, first);
    let live = Arc::new(PhysModLive::from_params(first));
    let mut out = Vec::with_capacity(n * 2);
    let mut frames = Vec::with_capacity(FRAMES);
    // (sample, is_on, note index), offs before ons at the same sample.
    let mut events: Vec<(usize, bool, usize)> = Vec::new();
    for (i, nt) in part.notes.iter().enumerate() {
        let on = (nt.t * SR) as usize;
        events.push((on, true, i));
        events.push((on + (nt.dur * SR) as usize, false, i));
    }
    events.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut next = 0;
    let mut reports = [StringReport::default(); MAX_ALL_STRINGS];
    let mut shape = [0.0f32; SHAPE_POINTS];
    let mut sq = 0.0f64;
    for i in 0..n {
        let t = i as f32 / SR;
        if i % 32 == 0 {
            if let Some(f) = &part.force {
                live.bow_force.store(keys(f, t).to_bits(), Ordering::Relaxed);
            }
            if let Some(v) = &part.speed {
                live.bow_velocity.store(keys(v, t).to_bits(), Ordering::Relaxed);
            }
        }
        while next < events.len() && events[next].0 <= i {
            let (_, on, k) = events[next];
            let id = k as u64 + 1;
            if on {
                let p = part.notes[k].p;
                if part.force.is_none() {
                    live.bow_force.store(p.bow_force.to_bits(), Ordering::Relaxed);
                }
                if part.speed.is_none() {
                    live.bow_velocity.store(p.bow_velocity.to_bits(), Ordering::Relaxed);
                }
                live.bow_position.store(p.bow_position.to_bits(), Ordering::Relaxed);
                live.vibrato_depth.store(p.vibrato_depth.to_bits(), Ordering::Relaxed);
                engine.note_on(id, p, true, Some(live.clone()));
            } else {
                engine.note_off(id);
            }
            next += 1;
        }
        let [l, rr] = engine.next_frame();
        let (gl, gr) = pan_gains(part.pan);
        let m = 0.5 * (l + rr);
        // Keep the engine's own stereo image, steered toward the part's seat.
        out.push((0.6 * l + 0.4 * m) * gl);
        out.push((0.6 * rr + 0.4 * m) * gr);
        sq += (m as f64) * (m as f64);
        if (i + 1) % SPF == 0 && frames.len() < FRAMES {
            let count = engine.report(&mut reports);
            let (bowed, _) = engine.string_count();
            let mut strings = Vec::new();
            for s in 0..count.min(bowed) {
                let rp = reports[s];
                engine.string_shape(s, &mut shape);
                strings.push(json!({
                    "open": r(rp.open_freq, 2), "hz": r(rp.freq, 2), "beta": r(rp.beta, 4),
                    "on": rp.phase_active, "v": r(rp.bow_velocity, 4), "f": r(rp.bow_force, 4),
                    "spp": r(rp.slips_per_period, 3), "stick": r(rp.stick_fraction, 3), "lvl": sig(rp.level, 3),
                    "fMin": r(rp.force_min, 4), "fMax": r(rp.force_max, 4),
                    "kMin": r(rp.force_min_knob, 3), "kMax": r(rp.force_max_knob, 3), "k": r(rp.bow_force_knob, 3),
                    "shape": sigs(&shape, 3),
                }));
            }
            let (mf, me) = engine.body_modes();
            let rms = (sq / SPF as f64).sqrt() as f32;
            sq = 0.0;
            frames.push(json!({"rms": sig(rms, 3), "strings": strings, "modeHz": arr(&mf, 1), "modeE": sigs(&me, 3)}));
        }
    }
    (out, json!({"name": part.name, "frames": frames}))
}

// ------------------------------------------------------------------------------------------
// The kit
// ------------------------------------------------------------------------------------------

fn kit_hits() -> Vec<(f32, Piece, Strike)> {
    use Piece::*;
    let mut h: Vec<(f32, Piece, Strike)> = Vec::new();
    let st = |v: f32, pos: f32, ang: f32, s: StrikerSpec| Strike { velocity: v, position: pos, angle: ang, striker: s };
    let stick = StrikerSpec::stick();
    let shoulder = StrikerSpec::stick_shoulder();
    let beater = StrikerSpec::plastic_beater();
    let yarn = StrikerSpec::yarn_mallet();
    // Intro: a suspended-cymbal roll with yarn mallets (two mallets, opposite edges), and a floor
    // tom roll that speeds up, both swelling into the hit.
    let mut t = 0.85f32;
    let mut k = 0;
    while t < 2.44 {
        let u = ((t - 0.85) / 1.6).clamp(0.0, 1.0);
        h.push((t, Crash, st(0.35 + 3.4 * u.powf(1.6), 0.8, if k % 2 == 0 { 0.3 } else { 3.4 }, yarn)));
        t += 0.072 - 0.02 * u;
        k += 1;
    }
    let mut t = 1.4f32;
    let mut k = 0;
    while t < 2.44 {
        let u = ((t - 1.4) / 1.05).clamp(0.0, 1.0);
        h.push((t, FloorTom, st(0.9 + 6.0 * u.powf(1.4), 0.34, if k % 2 == 0 { 0.5 } else { -0.5 }, stick)));
        t += 0.125 - 0.075 * u;
        k += 1;
    }
    // THE HIT
    h.push((2.5, Kick, st(9.0, 0.1, 0.0, beater)));
    h.push((2.5, FloorTom, st(8.5, 0.18, 0.2, stick)));
    h.push((2.5, Crash, st(8.5, 0.86, 0.0, shoulder)));
    // Bar A: brass family stabs.
    for &(t, p, v, pos) in &[(3.0, Kick, 7.0, 0.1), (3.5, Snare, 6.5, 0.3), (3.75, Kick, 5.0, 0.1), (4.0, Kick, 7.0, 0.1), (4.5, Snare, 7.0, 0.28), (4.875, Snare, 1.3, 0.55)] {
        h.push((t, p, st(v, pos, 0.4, if p == Kick { beater } else { stick })));
    }
    // Bar B: strings; the ride keeps eighths.
    for k in 0..8 {
        let t = 5.0 + 0.25 * k as f32;
        h.push((t, Ride, st(if k % 2 == 0 { 3.6 } else { 2.4 }, 0.55, 0.3, stick)));
    }
    for &(t, p, v) in &[(5.0, Kick, 7.0), (5.5, Snare, 6.5), (6.0, Kick, 6.5), (6.25, Kick, 5.0), (6.5, Snare, 7.0), (6.875, Snare, 1.4)] {
        h.push((t, p, st(v, if p == Kick { 0.1 } else { 0.3 }, 0.4, if p == Kick { beater } else { stick })));
    }
    // Bar C: the drums' bar - toms and a fill.
    for &(t, p, v, pos, ang) in &[
        (7.0, Kick, 8.0, 0.1, 0.0),
        (7.5, Snare, 7.5, 0.3, 0.4),
        (7.75, RackTom, 6.5, 0.3, 0.2),
        (8.0, Kick, 8.0, 0.1, 0.0),
        (8.0, FloorTom, 7.0, 0.3, 0.6),
        (8.25, Snare, 2.0, 0.5, 0.8),
        (8.5, Snare, 8.0, 0.28, 0.4),
        (8.625, RackTom, 6.5, 0.32, 0.1),
        (8.75, RackTom, 7.0, 0.28, 0.9),
        (8.875, FloorTom, 7.5, 0.3, 0.3),
    ] {
        h.push((t, p, st(v, pos, ang, if p == Kick { beater } else { stick })));
    }
    // Bar D: the crash's bar.
    h.push((9.0, Crash, st(9.0, 0.85, 0.2, shoulder)));
    h.push((9.0, Kick, st(9.0, 0.1, 0.0, beater)));
    for &(t, p, v, pos) in &[(9.5, Snare, 7.0, 0.3), (9.75, Splash, 5.5, 0.7), (10.0, Kick, 7.0, 0.1), (10.25, Kick, 5.0, 0.1)] {
        h.push((t, p, st(v, pos, 0.5, if p == Kick { beater } else { stick })));
    }
    h.push((10.0, Ride, st(4.5, 0.12, 0.2, stick)));
    // The smear: half time, then a snare roll swelling into the gap.
    h.push((10.5, Kick, st(8.0, 0.1, 0.0, beater)));
    h.push((11.0, Snare, st(7.5, 0.3, 0.4, stick)));
    h.push((11.5, Kick, st(7.5, 0.1, 0.0, beater)));
    h.push((11.5, FloorTom, st(6.5, 0.3, 0.5, stick)));
    h.push((12.0, Kick, st(8.0, 0.1, 0.0, beater)));
    h.push((12.0, FloorTom, st(7.5, 0.3, 0.5, stick)));
    let mut t = 11.5f32;
    let mut k = 0;
    while t < 12.32 {
        let u = ((t - 11.5) / 0.82).clamp(0.0, 1.0);
        h.push((t, Snare, st(1.2 + 7.0 * u * u, 0.3 + 0.05 * (k % 2) as f32, if k % 2 == 0 { 0.3 } else { -0.3 }, stick)));
        t += 0.0625 - 0.02 * u;
        k += 1;
    }
    // THE FINAL HIT, and the button.
    h.push((12.5, Kick, st(10.0, 0.1, 0.0, beater)));
    h.push((12.5, FloorTom, st(9.0, 0.2, 0.3, stick)));
    h.push((12.5, Crash, st(9.5, 0.86, 0.1, shoulder)));
    h.push((12.5, Splash, st(6.0, 0.7, 0.2, shoulder)));
    h.push((14.12, Kick, st(8.5, 0.1, 0.0, beater)));
    h.push((14.12, FloorTom, st(7.0, 0.2, 0.3, stick)));
    h.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    h
}

fn render_kit() -> (Vec<f32>, Value) {
    let spec = KitSpec { kick: 50.0, snare: 200.0, rack_tom: 125.0, floor_tom: 76.0, kick_muffling: 0.9, snares: true, snare_tension: 0.18, sympathetic: true };
    let mix = [3.0, 1.0, 2.0, 2.5, 2.0, 3.0, 1.5];
    let mut kit = Kit::new(spec, SR);
    kit.set_mix(mix);
    let hits = kit_hits();
    let n = (SECONDS * SR) as usize;
    let mut out = Vec::with_capacity(n * 2);
    let mut frames = Vec::with_capacity(FRAMES);
    let mut field = [0.0f32; FIELD];
    let (mut hz, mut amp) = ([0.0f32; SPECTRUM], [0.0f32; SPECTRUM]);
    let mut trace = vec![0.0f32; 2048];
    let mut next = 0;
    let mut sq = 0.0f64;
    let block = 32usize;
    let mut i = 0usize;
    while i < n {
        if kit.at_block_start() {
            while next < hits.len() && ((hits[next].0 * SR) as usize) < i + block {
                let (t, p, s) = hits[next];
                kit.schedule(p, s, ((t * SR) as usize).saturating_sub(i));
                next += 1;
            }
        }
        let [l, rr] = kit.next_frame();
        out.push(l);
        out.push(rr);
        sq += 0.5 * ((l * l + rr * rr) as f64);
        i += 1;
        if i % SPF == 0 && frames.len() < FRAMES {
            let mut pieces = Vec::new();
            for p in Piece::ALL {
                let s = kit.state(p);
                kit.field(p, &mut field);
                let k = kit.modes(p, &mut hz, &mut amp);
                let quiet = !s.awake || s.energy < 1.0e-9;
                let mut pv = json!({
                    "awake": s.awake, "energy": sig(s.energy, 3), "level": sig(s.level, 3),
                    "strikes": s.report.count, "rpos": r(s.report.position, 3), "rang": r(s.report.angle, 3),
                    "vin": r(s.report.speed_in, 2), "vout": r(s.report.speed_out, 2),
                    "contactMs": r(s.report.contact_samples as f32 / SR * 1000.0, 3), "force": r(s.report.peak_force, 1),
                    "gap": sig(s.report.gap, 3), "flying": s.report.flying,
                    "glide": r(s.glide_cents, 1), "wires": s.wires_lifted, "landings": s.wire_landings, "nonlinear": s.nonlinear,
                });
                if !quiet {
                    pv["field"] = sigs(&field, 3);
                    pv["modeHz"] = arr(&hz[..k.min(SPECTRUM)], 1);
                    pv["modeAmp"] = sigs(&amp[..k.min(SPECTRUM)], 3);
                }
                // The latest strike's contact force pulse, 96 points over its first 20 ms.
                let m = kit.trace(p, &mut trace);
                if m > 0 && !quiet {
                    let span = 882.min(m);
                    let pts: Vec<f32> = (0..96).map(|j| trace[(j * span / 96).min(m - 1)]).collect();
                    pv["trace"] = sigs(&pts, 3);
                    pv["traceMs"] = r(span as f32 / SR * 1000.0, 2);
                }
                pieces.push(pv);
            }
            let rms = (sq / SPF as f64).sqrt() as f32;
            sq = 0.0;
            frames.push(json!({"rms": sig(rms, 3), "focus": kit.focus().index(), "pieces": pieces}));
        }
    }
    let places: Vec<Value> = Piece::ALL
        .iter()
        .map(|&p| {
            let pl = placement(p);
            let dome = spec.cymbal(p).map_or(0.0, |c| c.plate.dome_radius);
            json!({"name": p.name(), "centre": arr(&pl.centre, 4), "normal": arr(&pl.normal, 4), "radius": r(pl.radius, 4), "depth": r(pl.depth, 4), "dome": r(dome, 4)})
        })
        .collect();
    let hit_list: Vec<Value> = hits.iter().map(|(t, p, s)| json!([r(*t, 4), p.index(), r(s.velocity, 2), r(s.position, 2), r(s.angle, 2)])).collect();
    (out, json!({"pieces": places, "hits": hit_list, "frames": frames}))
}

/// A stem: float stereo at the engine rate.
fn write_wav(path: &str, data: &[f32]) {
    let spec = hound::WavSpec { channels: 2, sample_rate: SR as u32, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut w = hound::WavWriter::create(path, spec).expect("wav");
    for &s in data {
        w.write_sample(s).unwrap();
    }
    w.finalize().unwrap();
}

fn rms_db(x: &[f32]) -> f32 {
    let s: f64 = x.iter().map(|v| (*v as f64) * (*v as f64)).sum();
    10.0 * ((s / x.len().max(1) as f64).max(1e-20)).log10() as f32
}
fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| "out".into());
    std::fs::create_dir_all(format!("{dir}/stems")).unwrap();
    let t0 = std::time::Instant::now();

    // Everything renders in parallel: seven brass players, three string players, the kit.
    let brass_handle = std::thread::spawn(|| {
        let parts = brass_parts();
        let handles: Vec<_> = parts
            .into_iter()
            .map(|p| {
                std::thread::spawn(move || {
                    let mut geo = Geometry::default();
                    let (audio, tele) = render_brass(&p, &mut geo);
                    (p.name, audio, tele, geo.shapes)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect::<Vec<_>>()
    });
    let strings_handle = std::thread::spawn(|| {
        let handles: Vec<_> = string_parts()
            .into_iter()
            .map(|p| {
                std::thread::spawn(move || {
                    let (audio, tele) = render_strings(&p);
                    (p.name, audio, tele)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect::<Vec<_>>()
    });
    let (kit_audio, kit_tele) = render_kit();
    let brass_out = brass_handle.join().unwrap();
    let strings_out = strings_handle.join().unwrap();
    eprintln!("rendered in {:.1}s", t0.elapsed().as_secs_f32());

    // Geometry ids are per player: renumber into one table.
    let mut geometry: Vec<Value> = Vec::new();
    let mut brass_tele = Vec::new();
    for (name, audio, mut tele, shapes) in brass_out.iter().map(|(n, a, t, s)| (n, a, t.clone(), s.clone())) {
        let base = geometry.len();
        geometry.extend(shapes);
        if let Some(fr) = tele["frames"].as_array_mut() {
            for f in fr.iter_mut() {
                let g = f["geo"].as_u64().unwrap_or(0) as usize + base;
                f["geo"] = json!(g);
            }
        }
        write_wav(&format!("{dir}/stems/{name}.wav"), audio);
        eprintln!("  {name:6} rms {:6.1} dB  peak {:.3}", rms_db(audio), peak(audio));
        brass_tele.push(tele);
    }
    let mut strings_tele = Vec::new();
    for (name, audio, tele) in &strings_out {
        write_wav(&format!("{dir}/stems/{name}.wav"), audio);
        eprintln!("  {name:6} rms {:6.1} dB  peak {:.3}", rms_db(audio), peak(audio));
        strings_tele.push(tele.clone());
    }
    write_wav(&format!("{dir}/stems/kit.wav"), &kit_audio);
    eprintln!("  kit    rms {:6.1} dB  peak {:.3}", rms_db(&kit_audio), peak(&kit_audio));

    // ---- the mix
    let mut stems: Vec<(&str, &[f32])> = Vec::new();
    for (name, audio, _, _) in &brass_out {
        stems.push((name, audio));
    }
    for (name, audio, _) in &strings_out {
        stems.push((name, audio));
    }
    stems.push(("kit", &kit_audio));
    let mix = mix::mix(&dir, &stems);
    eprintln!("mix: rms {:.1} dB, peak {:.3}", rms_db(&mix), peak(&mix));

    // The playing map's slot centre: where the lips sit, as a ratio of the resonance, per breath.
    let slot: Vec<f32> = (0..=32).map(|k| brass::lip_center(1000.0, brass::breath_pressure(k as f32 / 32.0)) / 1000.0).collect();
    let tele = json!({
        "fps": FPS, "frames": FRAMES, "sr": SR, "slotCentre": arr(&slot, 5),
        "brass": brass_tele, "strings": strings_tele, "kit": kit_tele,
        "geometry": geometry,
    });
    std::fs::write(format!("{dir}/telemetry.json"), serde_json::to_string(&tele).unwrap()).unwrap();
    eprintln!("done in {:.1}s", t0.elapsed().as_secs_f32());
}

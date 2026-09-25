//! The DAW's "character" effects: one-knob processors that sit on a track's mixing bus after its
//! delay and reverb (see `EffectParams::Character` in mod.rs).
//!
//! - **Pump**: beat-synced volume ducking, the sidechain-compressor sound, from a tempo curve.
//! - **Gate**: chops the signal into rhythmic pulses (eighths, sixteenths or a syncopated figure).
//! - **Grit**: saturation that turns into bit and sample-rate reduction, with automatic level
//!   compensation so turning it up does not simply make the track louder.
//! - **Space**: moves a sound from close and dry to far and washed out: less direct sound, more
//!   reverb, and less top end on both.
//! - **Fader**: a declicked on/off gain. The DAW uses it to hard-cut a track in a drop gap.
//!
//! Every one of them is a plain struct ticked one stereo frame at a time, so the live bus and the
//! offline export run the exact same code (see `render_mix_to_wav`). Amount 0 is always an exact
//! bypass; the DAW also leaves a zero-amount effect out of the bus chain altogether.
//!
//! Tempo-synced effects follow a bar clock: `beat` is the position in a 4/4 bar in beats (0..4).
//! It advances by itself at `bpm`, and the caller re-anchors it when the transport starts, seeks
//! or changes tempo. A jump in the clock cannot click: every gain here is smoothed.

use fundsp::prelude::*;

pub const BEATS_PER_BAR: f64 = 4.0;

/// Gate figures, as (start, length) pulses in sixteenths across one bar.
pub const GATE_PATTERNS: [&[(f32, f32)]; 3] = [
    // Straight eighths.
    &[(0.0, 1.2), (2.0, 1.2), (4.0, 1.2), (6.0, 1.2), (8.0, 1.2), (10.0, 1.2), (12.0, 1.2), (14.0, 1.2)],
    // Sixteenths.
    &[
        (0.0, 0.6), (1.0, 0.6), (2.0, 0.6), (3.0, 0.6), (4.0, 0.6), (5.0, 0.6), (6.0, 0.6), (7.0, 0.6),
        (8.0, 0.6), (9.0, 0.6), (10.0, 0.6), (11.0, 0.6), (12.0, 0.6), (13.0, 0.6), (14.0, 0.6), (15.0, 0.6),
    ],
    // Syncopated: the 3+3+2 figure (dotted eighths), twice a bar.
    &[(0.0, 1.6), (3.0, 1.6), (6.0, 1.2), (8.0, 1.6), (11.0, 1.6), (14.0, 1.2)],
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CharacterKind {
    Pump,
    Gate,
    Grit,
    Space,
    Fader,
}

impl CharacterKind {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "pump" => Some(CharacterKind::Pump),
            "gate" => Some(CharacterKind::Gate),
            "grit" => Some(CharacterKind::Grit),
            "space" => Some(CharacterKind::Space),
            "fader" => Some(CharacterKind::Fader),
            _ => None,
        }
    }
}

/// Settings for one character effect. `amount` is the knob (0..1; for a Fader, the gain it moves
/// to). `pattern` picks a `GATE_PATTERNS` entry. `bpm` drives the clock of Pump and Gate, and
/// `beat`, when given, puts that clock at a position in the bar (0..4 beats).
#[derive(Clone, Copy, Debug)]
pub struct CharacterParams {
    pub kind: CharacterKind,
    pub amount: f32,
    pub pattern: usize,
    pub bpm: f64,
    pub beat: Option<f64>,
}

impl CharacterParams {
    pub fn new(kind: CharacterKind, amount: f32) -> Self {
        CharacterParams { kind, amount, pattern: 0, bpm: 120.0, beat: None }
    }
}

/// One-pole smoothing coefficient for a time constant in seconds.
fn coef(seconds: f32, sr: f32) -> f32 {
    1.0 - (-1.0 / (seconds.max(1e-5) * sr)).exp()
}

/// Where a tempo-synced effect is in the bar.
#[derive(Clone, Copy, Debug)]
struct BarClock {
    beat: f64,
    bpm: f64,
}

impl BarClock {
    fn new(bpm: f64, beat: Option<f64>) -> Self {
        let mut c = BarClock { beat: 0.0, bpm: 120.0 };
        c.set(bpm, beat);
        c
    }

    fn set(&mut self, bpm: f64, beat: Option<f64>) {
        self.bpm = bpm.clamp(20.0, 400.0);
        if let Some(b) = beat.filter(|b| b.is_finite()) {
            self.beat = b.rem_euclid(BEATS_PER_BAR);
        }
    }

    fn tick(&mut self, sr: f32) {
        self.beat = (self.beat + self.bpm / 60.0 / sr as f64) % BEATS_PER_BAR;
    }
}

/// How far below unity Pump pulls the level at `phase` (0..1 through a beat), 0..1. The duck is
/// deepest on the beat and recovers along a squared curve; more amount means both a deeper duck
/// and a longer recovery, so the knob runs from a gentle breathing to the deep house pump.
pub fn pump_duck(amount: f32, phase: f32) -> f32 {
    let a = amount.clamp(0.0, 1.0);
    if a <= 0.0 {
        return 0.0;
    }
    let depth = 0.9 * a.powf(0.7);
    let release = 0.25 + 0.5 * a;
    let p = phase.rem_euclid(1.0);
    if p >= release {
        return 0.0;
    }
    let r = 1.0 - p / release;
    depth * r * r
}

/// Whether a gate pattern is open at `sixteenth` (0..16 across the bar).
pub fn gate_open(pattern: usize, sixteenth: f32) -> bool {
    let pulses = GATE_PATTERNS[Ord::min(pattern, GATE_PATTERNS.len() - 1)];
    let s = sixteenth.rem_euclid(16.0);
    pulses.iter().any(|&(start, len)| s >= start && s < start + len)
}

struct Pump {
    clock: BarClock,
    amount: f32,
    gain: f32,
}

struct Gate {
    clock: BarClock,
    amount: f32,
    pattern: usize,
    gain: f32,
}

/// Follows a signal's mean square with a one-pole filter.
#[derive(Clone, Copy)]
struct PowerFollower {
    value: f32,
    k: f32,
}

impl PowerFollower {
    fn new(seconds: f32, sr: f32) -> Self {
        PowerFollower { value: 0.0, k: coef(seconds, sr) }
    }

    fn push(&mut self, x: [f32; 2]) {
        let p = 0.5 * (x[0] * x[0] + x[1] * x[1]);
        self.value += (p - self.value) * self.k;
    }
}

struct Grit {
    amount: f32,
    held: [f32; 2],
    hold_count: u32,
    input_power: PowerFollower,
    output_power: PowerFollower,
    makeup: f32,
    makeup_k: f32,
}

/// Grit's shaping, before level compensation: saturation, then (past 35%) fewer bits and a lower
/// sample rate. `held`/`hold_count` are the sample-rate reducer's state.
fn grit_shape(amount: f32, x: [f32; 2], held: &mut [f32; 2], hold_count: &mut u32) -> [f32; 2] {
    let a = amount.clamp(0.0, 1.0);
    let drive = 1.0 + 14.0 * a.powf(1.5);
    let mut y = [(x[0] * drive).tanh(), (x[1] * drive).tanh()];
    let rough = ((a - 0.35) / 0.65).clamp(0.0, 1.0);
    if rough > 0.0 {
        let bits = 16.0 - 12.0 * rough;
        let step = 2.0 / 2f32.powf(bits);
        y = [(y[0] / step).round() * step, (y[1] / step).round() * step];
        let hold = 1 + (rough * rough * 11.0) as u32;
        if *hold_count == 0 {
            *held = y;
        }
        *hold_count = (*hold_count + 1) % hold;
        y = *held;
    }
    y
}

/// The static part of Grit's level compensation: roughly what the saturation adds to a
/// full-scale signal. The rest is done by comparing input and output loudness as it plays.
fn grit_static_makeup(amount: f32) -> f32 {
    let drive = 1.0 + 14.0 * amount.clamp(0.0, 1.0).powf(1.5);
    1.0 / drive.sqrt()
}

struct OnePole {
    z: [f32; 2],
}

impl OnePole {
    fn lowpass(&mut self, x: [f32; 2], k: f32) -> [f32; 2] {
        self.z[0] += (x[0] - self.z[0]) * k;
        self.z[1] += (x[1] - self.z[1]) * k;
        self.z
    }
}

struct Space {
    amount: f32,
    reverb: Box<dyn AudioUnit>,
    /// Two one-poles in series on everything (12 dB/octave), and one on the dry path's lows.
    tone_a: OnePole,
    tone_b: OnePole,
    low: OnePole,
}

/// Space's coordinated settings at `amount`: (dry gain, wet gain, lowpass cutoff Hz, low cut Hz).
pub fn space_mix(amount: f32) -> (f32, f32, f32, f32) {
    let s = amount.clamp(0.0, 1.0);
    let dry = 1.0 - 0.75 * s.powf(1.2);
    let wet = 0.95 * s.powf(1.1);
    let cutoff = 18_000.0 * (2_400.0f32 / 18_000.0).powf(s);
    let low_cut = 20.0 + 160.0 * s * s;
    (dry, wet, cutoff, low_cut)
}

struct Fader {
    target: f32,
    gain: f32,
}

enum Inner {
    Pump(Pump),
    Gate(Gate),
    Grit(Grit),
    Space(Space),
    Fader(Fader),
}

/// One character effect instance. See the module doc comment.
pub struct Character {
    inner: Inner,
    sample_rate: f32,
}

impl Character {
    pub fn new(params: CharacterParams, sample_rate: f32) -> Self {
        let sr = sample_rate.max(1.0);
        let amount = params.amount.clamp(0.0, 1.0);
        let inner = match params.kind {
            CharacterKind::Pump => Inner::Pump(Pump { clock: BarClock::new(params.bpm, params.beat), amount, gain: 1.0 }),
            CharacterKind::Gate => Inner::Gate(Gate {
                clock: BarClock::new(params.bpm, params.beat),
                amount,
                pattern: Ord::min(params.pattern, GATE_PATTERNS.len() - 1),
                gain: 1.0,
            }),
            CharacterKind::Grit => Inner::Grit(Grit {
                amount,
                held: [0.0; 2],
                hold_count: 0,
                input_power: PowerFollower::new(0.25, sr),
                output_power: PowerFollower::new(0.25, sr),
                makeup: grit_static_makeup(amount),
                makeup_k: coef(0.05, sr),
            }),
            CharacterKind::Space => {
                let mut reverb = reverb_stereo(24.0, 3.2, 0.45);
                reverb.set_sample_rate(sr as f64);
                reverb.reset();
                Inner::Space(Space {
                    amount,
                    reverb: Box::new(reverb),
                    tone_a: OnePole { z: [0.0; 2] },
                    tone_b: OnePole { z: [0.0; 2] },
                    low: OnePole { z: [0.0; 2] },
                })
            }
            CharacterKind::Fader => {
                let g = params.amount.clamp(0.0, 1.0);
                Inner::Fader(Fader { target: g, gain: g })
            }
        };
        Character { inner, sample_rate: sr }
    }

    pub fn kind(&self) -> CharacterKind {
        match self.inner {
            Inner::Pump(_) => CharacterKind::Pump,
            Inner::Gate(_) => CharacterKind::Gate,
            Inner::Grit(_) => CharacterKind::Grit,
            Inner::Space(_) => CharacterKind::Space,
            Inner::Fader(_) => CharacterKind::Fader,
        }
    }

    /// Updates the settings in place. Params of another kind are ignored.
    pub fn set(&mut self, params: CharacterParams) {
        if params.kind != self.kind() {
            return;
        }
        let amount = params.amount.clamp(0.0, 1.0);
        match &mut self.inner {
            Inner::Pump(p) => {
                p.amount = amount;
                p.clock.set(params.bpm, params.beat);
            }
            Inner::Gate(g) => {
                g.amount = amount;
                g.pattern = Ord::min(params.pattern, GATE_PATTERNS.len() - 1);
                g.clock.set(params.bpm, params.beat);
            }
            Inner::Grit(g) => g.amount = amount,
            Inner::Space(s) => s.amount = amount,
            Inner::Fader(f) => f.target = amount,
        }
    }

    /// Processes one stereo frame and returns the processed frame (not a wet signal to mix in).
    pub fn process(&mut self, x: [f32; 2]) -> [f32; 2] {
        let sr = self.sample_rate;
        match &mut self.inner {
            Inner::Pump(p) => {
                let target = 1.0 - pump_duck(p.amount, p.clock.beat.fract() as f32);
                p.clock.tick(sr);
                // 2 ms takes the edge off the drop on the beat without softening the pump itself.
                p.gain += (target - p.gain) * coef(0.002, sr);
                [x[0] * p.gain, x[1] * p.gain]
            }
            Inner::Gate(g) => {
                let open = gate_open(g.pattern, (g.clock.beat * 4.0) as f32);
                g.clock.tick(sr);
                let target = if open { 1.0 } else { 1.0 - g.amount };
                // Opens in 1 ms, closes in 5: crisp pulses, no clicks.
                let k = if target > g.gain { coef(0.001, sr) } else { coef(0.005, sr) };
                g.gain += (target - g.gain) * k;
                [x[0] * g.gain, x[1] * g.gain]
            }
            Inner::Grit(g) => {
                if g.amount <= 0.0 {
                    return x;
                }
                let shaped = grit_shape(g.amount, x, &mut g.held, &mut g.hold_count);
                g.input_power.push(x);
                g.output_power.push(shaped);
                // Match the output's loudness to the input's; hold the last gain through silence.
                let target = if g.input_power.value > 1e-8 && g.output_power.value > 1e-8 {
                    (g.input_power.value / g.output_power.value).sqrt().clamp(0.05, 1.5)
                } else {
                    g.makeup
                };
                g.makeup += (target - g.makeup) * g.makeup_k;
                // Crossfade in over the first 12% of the knob so leaving zero is not a step.
                let mix = (g.amount / 0.12).min(1.0);
                [
                    x[0] + (shaped[0] * g.makeup - x[0]) * mix,
                    x[1] + (shaped[1] * g.makeup - x[1]) * mix,
                ]
            }
            Inner::Space(s) => {
                if s.amount <= 0.0 {
                    return x;
                }
                let (dry_gain, wet_gain, cutoff, low_cut) = space_mix(s.amount);
                let lows = s.low.lowpass(x, coef(1.0 / (std::f32::consts::TAU * low_cut), sr));
                let dry = [(x[0] - lows[0]) * dry_gain, (x[1] - lows[1]) * dry_gain];
                let mut wet = [0.0f32; 2];
                s.reverb.tick(&x, &mut wet);
                let sum = [dry[0] + wet[0] * wet_gain, dry[1] + wet[1] * wet_gain];
                let k = coef(1.0 / (std::f32::consts::TAU * cutoff), sr);
                let once = s.tone_a.lowpass(sum, k);
                s.tone_b.lowpass(once, k)
            }
            Inner::Fader(f) => {
                f.gain += (f.target - f.gain) * coef(0.003, sr);
                [x[0] * f.gain, x[1] * f.gain]
            }
        }
    }

    /// How long this effect keeps sounding after its input stops, in seconds.
    pub fn tail_seconds(&self) -> f64 {
        match &self.inner {
            Inner::Space(s) if s.amount > 0.0 => 4.5,
            _ => 0.0,
        }
    }
}

/// A track's bus in an offline render: its character chain, its gain (applied after the chain,
/// as the live bus does), and the stretches where it is hard-cut to silence.
#[derive(Clone, Debug)]
pub struct TrackBusRender {
    pub gain: f32,
    pub effects: Vec<CharacterParams>,
    /// (start, end) in seconds.
    pub silences: Vec<(f64, f64)>,
}

impl Default for TrackBusRender {
    fn default() -> Self {
        TrackBusRender { gain: 1.0, effects: Vec::new(), silences: Vec::new() }
    }
}

impl TrackBusRender {
    /// Seconds the chain rings on after its input stops.
    pub fn tail_seconds(&self, sample_rate: f32) -> f64 {
        self.effects.iter().map(|p| Character::new(*p, sample_rate).tail_seconds()).fold(0.0, f64::max)
    }

    /// Runs an interleaved stereo buffer through the chain, then the gain and the silences.
    pub fn process(&self, buf: &mut [f32], sample_rate: f32) {
        let mut chain: Vec<Character> = self.effects.iter().map(|p| {
            // An offline render starts at the top of the song, so the clock starts on beat 0.
            let mut p = *p;
            p.beat = Some(p.beat.unwrap_or(0.0));
            Character::new(p, sample_rate)
        }).collect();
        let open = if self.silenced_at(0.0) { 0.0 } else { 1.0 };
        let mut fader = Character::new(CharacterParams::new(CharacterKind::Fader, open), sample_rate);
        let use_fader = !self.silences.is_empty();
        for (i, frame) in buf.chunks_exact_mut(2).enumerate() {
            let mut x = [frame[0], frame[1]];
            for c in chain.iter_mut() {
                x = c.process(x);
            }
            if use_fader {
                let t = i as f64 / sample_rate as f64;
                fader.set(CharacterParams::new(CharacterKind::Fader, if self.silenced_at(t) { 0.0 } else { 1.0 }));
                x = fader.process(x);
            }
            frame[0] = x[0] * self.gain;
            frame[1] = x[1] * self.gain;
        }
    }

    fn silenced_at(&self, t: f64) -> bool {
        self.silences.iter().any(|&(a, b)| t >= a && t < b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    fn sine(freq: f32, i: usize) -> [f32; 2] {
        let v = 0.5 * (std::f32::consts::TAU * freq * i as f32 / SR).sin();
        [v, v]
    }

    fn rms(frames: &[[f32; 2]]) -> f32 {
        (frames.iter().map(|f| 0.5 * (f[0] * f[0] + f[1] * f[1])).sum::<f32>() / Ord::max(frames.len(), 1) as f32).sqrt()
    }

    fn run(c: &mut Character, frames: usize, input: impl Fn(usize) -> [f32; 2]) -> Vec<[f32; 2]> {
        (0..frames).map(|i| c.process(input(i))).collect()
    }

    #[test]
    fn zero_amount_is_an_exact_bypass() {
        for kind in [CharacterKind::Pump, CharacterKind::Gate, CharacterKind::Grit, CharacterKind::Space] {
            let mut c = Character::new(CharacterParams::new(kind, 0.0), SR);
            for i in 0..4800 {
                let x = sine(220.0, i);
                assert_eq!(c.process(x), x, "{kind:?} at zero changed the signal");
            }
        }
    }

    #[test]
    fn pump_ducks_on_the_beat_and_recovers_before_the_next() {
        // 120 bpm: a beat is 0.5 s = 24000 frames.
        let mut c = Character::new(CharacterParams { kind: CharacterKind::Pump, amount: 1.0, pattern: 0, bpm: 120.0, beat: Some(0.0) }, SR);
        let out = run(&mut c, 48_000, |_| [1.0, 1.0]);
        let on_beat = out[480][0]; // 10 ms after the beat
        let late = out[23_000][0]; // just before the next beat
        assert!(on_beat < 0.2, "a full pump should be deep on the beat, got {on_beat}");
        assert!(late > 0.99, "the level should be back before the next beat, got {late}");
        // Same shape on the second beat: the clock keeps time by itself.
        assert!(out[24_000 + 480][0] < 0.2);
        // A little pump breathes rather than pumps.
        let mut soft = Character::new(CharacterParams { kind: CharacterKind::Pump, amount: 0.15, pattern: 0, bpm: 120.0, beat: Some(0.0) }, SR);
        let out = run(&mut soft, 2400, |_| [1.0, 1.0]);
        assert!(out[480][0] > 0.6 && out[480][0] < 0.95, "subtle pump dipped to {}", out[480][0]);
    }

    #[test]
    fn pump_follows_the_bar_clock_it_is_given() {
        let mut c = Character::new(CharacterParams { kind: CharacterKind::Pump, amount: 1.0, pattern: 0, bpm: 120.0, beat: Some(0.5) }, SR);
        // Half a beat in: the duck has passed, so the level is up...
        let out = run(&mut c, 2400, |_| [1.0, 1.0]);
        assert!(out[2000][0] > 0.9);
        // ...until the clock is moved back onto a beat.
        c.set(CharacterParams { kind: CharacterKind::Pump, amount: 1.0, pattern: 0, bpm: 120.0, beat: Some(1.0) });
        let out = run(&mut c, 960, |_| [1.0, 1.0]);
        assert!(out[900][0] < 0.25, "re-anchored on a beat, got {}", out[900][0]);
    }

    #[test]
    fn gate_chops_eighths_and_sixteenths() {
        // 120 bpm: a sixteenth is 6000 frames.
        let level_at = |pattern: usize, sixteenth: f32| {
            let mut c = Character::new(CharacterParams { kind: CharacterKind::Gate, amount: 1.0, pattern, bpm: 120.0, beat: Some(0.0) }, SR);
            let out = run(&mut c, (sixteenth * 6000.0) as usize + 1, |_| [1.0, 1.0]);
            out.last().unwrap()[0]
        };
        assert!(level_at(0, 0.5) > 0.95, "an eighth pulse is open");
        assert!(level_at(0, 1.6) < 0.05, "and closed after it");
        assert!(level_at(1, 1.3) > 0.95, "sixteenths open on every sixteenth");
        assert!(level_at(1, 1.8) < 0.05);
        assert!(level_at(2, 3.5) > 0.95, "the syncopated figure opens on the dotted eighth");
        assert!(level_at(2, 2.5) < 0.05);
        // Depth is the knob: half the amount closes halfway.
        let mut half = Character::new(CharacterParams { kind: CharacterKind::Gate, amount: 0.5, pattern: 0, bpm: 120.0, beat: Some(0.0) }, SR);
        let out = run(&mut half, 10_000, |_| [1.0, 1.0]);
        assert!((out[9_999][0] - 0.5).abs() < 0.02);
    }

    #[test]
    fn grit_roughens_without_winning_a_loudness_contest() {
        let input: Vec<[f32; 2]> = (0..SR as usize).map(|i| sine(110.0, i)).collect();
        let in_rms = rms(&input[24_000..]);
        for amount in [0.2f32, 0.5, 0.8, 1.0] {
            let mut c = Character::new(CharacterParams::new(CharacterKind::Grit, amount), SR);
            let out: Vec<[f32; 2]> = input.iter().map(|&x| c.process(x)).collect();
            let out_rms = rms(&out[24_000..]);
            let db = 20.0 * (out_rms / in_rms).log10();
            assert!(db.abs() < 1.5, "grit {amount} changed the level by {db:.2} dB");
            // Not just a scaled copy: the waveform itself changed.
            let scale = out_rms / in_rms;
            let diff: f32 = out[24_000..].iter().zip(&input[24_000..]).map(|(o, i)| (o[0] - i[0] * scale).abs()).sum::<f32>() / 24_000.0;
            assert!(diff > 0.01 * amount, "grit {amount} barely changed the waveform ({diff})");
        }
    }

    #[test]
    fn space_darkens_the_sound_and_leaves_a_tail() {
        let noise = |i: usize| {
            // Deterministic white-ish noise.
            let v = ((i as u32).wrapping_mul(2_654_435_761) >> 8) as f32 / (1u32 << 24) as f32 - 0.5;
            [v, v]
        };
        let highs = |frames: &[[f32; 2]]| frames.windows(2).map(|w| (w[1][0] - w[0][0]).abs()).sum::<f32>() / frames.len() as f32;
        let mut near = Character::new(CharacterParams::new(CharacterKind::Space, 0.05), SR);
        let mut far = Character::new(CharacterParams::new(CharacterKind::Space, 1.0), SR);
        let near_out = run(&mut near, 24_000, noise);
        let far_out = run(&mut far, 24_000, noise);
        assert!(highs(&far_out) < highs(&near_out) * 0.5, "far should be darker");
        // After the input stops, far keeps ringing and near does not.
        let far_tail = run(&mut far, 24_000, |_| [0.0, 0.0]);
        assert!(rms(&far_tail[..12_000]) > 0.005, "far has a reverb tail");
        assert!(far.tail_seconds() > 1.0);
    }

    #[test]
    fn an_offline_bus_applies_gain_after_the_chain_and_cuts_silences_cleanly() {
        let bus = TrackBusRender {
            gain: 0.5,
            effects: vec![CharacterParams { kind: CharacterKind::Pump, amount: 1.0, pattern: 0, bpm: 120.0, beat: None }],
            silences: vec![(1.0, 1.5)],
        };
        let mut buf = vec![1.0f32; 2 * SR as usize * 2];
        bus.process(&mut buf, SR);
        let at = |t: f32| buf[(t * SR) as usize * 2];
        assert!(at(0.01) < 0.1, "the pump starts on beat 0");
        assert!((at(0.49) - 0.5).abs() < 0.01, "gain is applied after the chain");
        assert!(at(1.2).abs() < 1e-4, "silenced inside the gap");
        assert!(at(1.99) > 0.45, "back after the gap");
        // No step bigger than the pump's own movement at the cut: the fader is declicked.
        let edge = (SR as usize) * 2;
        let jump = (buf[edge] - buf[edge - 2]).abs();
        assert!(jump < 0.02, "the cut clicked ({jump})");
    }
}

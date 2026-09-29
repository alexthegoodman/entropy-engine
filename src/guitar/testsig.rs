//! Synthetic guitar signals with known ground truth: the corpus the offline tests and benchmarks
//! run against. Not a substitute for recordings of a real guitar (the spec's labeled corpus); it is
//! what lets every claim about detection, latency and stuck notes be checked repeatably before
//! anyone plugs in.
//!
//! A string is additive: a fundamental and harmonics that fall in weight with their number and decay
//! faster, a little stiffness so the partials are not exact multiples, and a short burst of filtered
//! noise for the pick. It is deliberately not Karplus-Strong: here the pitch at every instant is
//! exactly what the caller said, which is what an accuracy claim needs.

use super::dsp::db_to_amp;
use std::f32::consts::PI;

/// Small deterministic generator, so a failing case can be replayed from its seed.
#[derive(Clone, Debug)]
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed.max(1))
    }

    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    /// Uniform in `[-1, 1)`.
    pub fn signed(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 23) as f32 - 1.0
    }

    /// Uniform in `[0, 1)`.
    pub fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 24) as f32
    }
}

/// How the pitch moves over the life of a note.
#[derive(Clone, Copy, Debug)]
pub enum Motion {
    Steady,
    /// Sinusoidal vibrato starting `delay_s` in.
    Vibrato { depth_cents: f32, rate_hz: f32, delay_s: f32 },
    /// A bend up (or down) by `cents`, starting at `start_s`, taking `dur_s`, then held.
    Bend { cents: f32, start_s: f32, dur_s: f32 },
    /// A slide of `semitones` starting at `start_s`, taking `dur_s`, then held.
    Slide { semitones: f32, start_s: f32, dur_s: f32 },
}

impl Motion {
    pub fn cents_at(self, t: f32) -> f32 {
        match self {
            Motion::Steady => 0.0,
            Motion::Vibrato { depth_cents, rate_hz, delay_s } => {
                if t < delay_s { 0.0 } else { depth_cents * (2.0 * PI * rate_hz * (t - delay_s)).sin() }
            }
            Motion::Bend { cents, start_s, dur_s } => cents * ((t - start_s) / dur_s.max(1e-3)).clamp(0.0, 1.0),
            Motion::Slide { semitones, start_s, dur_s } => semitones * 100.0 * ((t - start_s) / dur_s.max(1e-3)).clamp(0.0, 1.0),
        }
    }
}

/// One plucked note.
#[derive(Clone, Copy, Debug)]
pub struct Pluck {
    /// Time of the pick, seconds from the start of the recording.
    pub start_s: f32,
    /// Base frequency, before `motion`.
    pub f0: f32,
    /// Loudest sample the note reaches, dBFS.
    pub peak_db: f32,
    /// How long the string rings before a hand mutes it, seconds. `f32::INFINITY` lets it decay alone.
    pub ring_s: f32,
    /// How fast the mute takes hold, milliseconds.
    pub mute_ms: f32,
    /// Fundamental's decay time constant, seconds. Harmonics decay faster.
    pub decay_s: f32,
    /// Relative weight of the fundamental. 1 is normal, 0 leaves it out entirely.
    pub fundamental: f32,
    /// Gain on the odd partials from the third up. Small values leave mostly even partials, whose
    /// waveform repeats at half the true period: the case that makes a detector read an octave high.
    pub odd_gain: f32,
    /// How many partials.
    pub partials: usize,
    /// Stiffness: partial n sits at `n * f0 * sqrt(1 + B n^2)`.
    pub inharmonicity: f32,
    /// Pick noise level relative to the note's peak.
    pub pick_noise: f32,
    /// Where the string is plucked, as a fraction of its length from the bridge. A pluck at 1/n of the
    /// length leaves out every nth partial, and the partials between the gaps rise and fall: the comb
    /// that gives a real string its uneven spectrum. 0 leaves the spectrum smooth.
    pub pluck_position: f32,
    pub motion: Motion,
    pub seed: u32,
}

impl Default for Pluck {
    fn default() -> Self {
        Pluck {
            start_s: 0.1,
            f0: 110.0,
            peak_db: -14.0,
            ring_s: f32::INFINITY,
            mute_ms: 15.0,
            decay_s: 1.6,
            fundamental: 1.0,
            odd_gain: 1.0,
            partials: 14,
            inharmonicity: 1.0e-4,
            pick_noise: 0.35,
            pluck_position: 0.0,
            motion: Motion::Steady,
            seed: 1,
        }
    }
}

impl Pluck {
    pub fn at(f0: f32) -> Self {
        Pluck { f0, ..Pluck::default() }
    }

    pub fn note(midi: u8) -> Self {
        Pluck::at(440.0 * ((midi as f32 - 69.0) / 12.0).exp2())
    }

    pub fn starting(mut self, s: f32) -> Self {
        self.start_s = s;
        self
    }

    pub fn loud(mut self, peak_db: f32) -> Self {
        self.peak_db = peak_db;
        self
    }

    pub fn ringing(mut self, s: f32) -> Self {
        self.ring_s = s;
        self
    }

    pub fn moving(mut self, m: Motion) -> Self {
        self.motion = m;
        self
    }

    pub fn without_fundamental(mut self) -> Self {
        self.fundamental = 0.0;
        self
    }

    pub fn seeded(mut self, seed: u32) -> Self {
        self.seed = seed;
        self
    }

    /// Length in seconds after which the note is inaudible (or muted), so a mix can be sized.
    pub fn duration_s(&self) -> f32 {
        let natural = self.decay_s * 6.0;
        self.ring_s.min(natural) + self.mute_ms / 1000.0 * 6.0
    }
}

/// A chord shape as frets on each string, lowest string first: `x` is a string not played, `0`-`9`
/// frets 0 to 9 and `a`-`o` frets 10 to 24. "x32010" is an open C major.
pub fn shape_notes(shape: &str, tuning: &[u8; 6]) -> Vec<u8> {
    assert_eq!(shape.chars().count(), 6, "a shape names all six strings: {shape}");
    shape
        .chars()
        .zip(tuning.iter())
        .filter_map(|(c, &open)| match c {
            'x' | 'X' => None,
            '0'..='9' => Some(open + c as u8 - b'0'),
            'a'..='o' => Some(open + 10 + c as u8 - b'a'),
            other => panic!("{other} is not a fret in {shape}"),
        })
        .collect()
}

/// Common chord shapes in standard tuning, as a guitarist plays them: open chords, sevenths, barre
/// chords up the neck, power chords, partial chords on the top strings and two-note intervals. The
/// corpus the chord detector is measured on.
pub const CHORD_SHAPES: [(&str, &str); 40] = [
    ("E", "022100"),
    ("Em", "022000"),
    ("E7", "020100"),
    ("A", "x02220"),
    ("Am", "x02210"),
    ("A7", "x02020"),
    ("Amaj7", "x02120"),
    ("D", "xx0232"),
    ("Dm", "xx0231"),
    ("D7", "xx0212"),
    ("Dmaj7", "xx0222"),
    ("G", "320003"),
    ("G (4-note top)", "320033"),
    ("G7", "320001"),
    ("C", "x32010"),
    ("C7", "x32310"),
    ("Cmaj7", "x32000"),
    ("Cadd9", "x32033"),
    ("F barre", "133211"),
    ("Fmaj7", "xx3210"),
    ("B7", "x21202"),
    ("Bm barre", "x24432"),
    ("Bb barre", "x13331"),
    ("F#m barre", "244222"),
    ("G barre 3", "355433"),
    ("Am barre 5", "577555"),
    ("C barre 8", "8aa988"),
    ("D barre 10", "accbba"),
    ("E5 power", "022xxx"),
    ("A5 power", "x022xx"),
    ("G5 power", "355xxx"),
    ("C5 power", "x355xx"),
    ("D triad top", "xxx775"),
    ("G triad top", "xxx433"),
    ("C triad top", "xxx558"),
    ("E octave", "xx2x5x"),
    ("A octave", "x0x2xx"),
    ("third C-E", "xxx55x"),
    ("sixth G-E", "xx5x5x"),
    ("semitone B-C", "xxx41x"),
];

/// A strum: the notes picked one after another, lowest first for a downstroke, `spread_ms` from the
/// first string to the last. Each string gets its own seed, a slightly different level and pluck
/// position, as a real strum does.
pub fn strum(notes: &[u8], start_s: f32, spread_ms: f32, peak_db: f32, down: bool, seed: u32) -> Vec<Pluck> {
    let mut rng = Rng::new(seed.wrapping_mul(747796405).max(1));
    let n = notes.len().max(1);
    let mut order: Vec<u8> = notes.to_vec();
    if !down {
        order.reverse();
    }
    order
        .iter()
        .enumerate()
        .map(|(i, &note)| {
            let t = if n > 1 { i as f32 / (n - 1) as f32 } else { 0.0 };
            let mut p = Pluck::note(note)
                .starting(start_s + t * spread_ms / 1000.0)
                .loud(peak_db + 3.0 * rng.signed())
                .seeded(seed.wrapping_mul(31).wrapping_add(i as u32 + 1));
            p.pluck_position = 0.1 + 0.15 * rng.unit();
            p
        })
        .collect()
}

/// Ground truth for one note in a mix.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Truth {
    /// Sample of the pick.
    pub onset: u64,
    pub midi: u8,
    /// Sample at which a hand mute began, if there is one.
    pub mute: Option<u64>,
    pub f0: f32,
}

/// Renders one note into `out`, adding to what is there. Returns its ground truth.
pub fn add_pluck(out: &mut [f32], fs: f32, p: &Pluck) -> Truth {
    let mut rng = Rng::new(p.seed.wrapping_mul(2654435761).max(1));
    let start = (p.start_s * fs) as usize;
    let n = out.len().saturating_sub(start);
    let mut note = vec![0.0f32; n];
    let base_phases: Vec<f32> = (0..p.partials).map(|_| rng.unit() * 2.0 * PI).collect();
    let mut phases = base_phases.clone();

    for (i, s) in note.iter_mut().enumerate() {
        let t = i as f32 / fs;
        let f = p.f0 * (p.motion.cents_at(t) / 1200.0).exp2();
        // Fast attack, then each partial dies at its own rate.
        let attack = (t / 0.0008).min(1.0);
        let mut v = 0.0;
        for h in 1..=p.partials {
            let hf = h as f32;
            let stretch = (1.0 + p.inharmonicity * hf * hf).sqrt();
            phases[h - 1] += 2.0 * PI * f * hf * stretch / fs;
            if phases[h - 1] > 2.0 * PI {
                phases[h - 1] -= 2.0 * PI;
            }
            let odd = if h >= 3 && h % 2 == 1 { p.odd_gain } else { 1.0 };
            // |sin(pi h beta)| over its average, so the comb reshapes the spectrum without making it quieter.
            let comb = if p.pluck_position > 0.0 { (PI * hf * p.pluck_position).sin().abs() * 1.5 } else { 1.0 };
            let weight = if h == 1 { p.fundamental } else { odd } * comb / hf.powf(0.9);
            let decay = (-t / (p.decay_s / hf.powf(0.6))).exp();
            v += weight * decay * phases[h - 1].sin();
        }
        *s = v * attack;
    }

    // The pick: a few milliseconds of low-passed noise.
    let click_len = (0.004 * fs) as usize;
    let mut lp = 0.0f32;
    for i in 0..click_len.min(n) {
        lp += 0.35 * (rng.signed() - lp);
        note[i] += p.pick_noise * lp * (1.0 - i as f32 / click_len as f32) * 2.0;
    }

    // Normalise to the requested peak before the mute, which only takes energy away.
    let peak = note.iter().fold(0.0f32, |a, &b| a.max(b.abs())).max(1e-9);
    let gain = db_to_amp(p.peak_db) / peak;
    let mute_sample = p.ring_s.is_finite().then(|| (p.ring_s * fs) as usize);
    for (i, s) in note.iter_mut().enumerate() {
        let mut g = gain;
        if let Some(m) = mute_sample {
            if i >= m {
                g *= (-((i - m) as f32) / (p.mute_ms / 1000.0 * fs / 4.0).max(1.0)).exp();
            }
        }
        *s *= g;
    }
    for (o, s) in out[start..].iter_mut().zip(note.iter()) {
        *o += *s;
    }
    Truth {
        onset: start as u64,
        midi: (69.0 + 12.0 * (p.f0 / 440.0).log2()).round() as u8,
        mute: mute_sample.map(|m| (start + m) as u64),
        f0: p.f0,
    }
}

/// Mixes plucks into one recording of `seconds`, returning the ground truth for each in order.
pub fn mix(fs: f32, seconds: f32, plucks: &[Pluck]) -> (Vec<f32>, Vec<Truth>) {
    let mut out = vec![0.0f32; (seconds * fs) as usize];
    let truth = plucks.iter().map(|p| add_pluck(&mut out, fs, p)).collect();
    (out, truth)
}

/// Adds mains hum: `hz` and its next harmonics, `level_db` dBFS RMS for the fundamental.
pub fn add_hum(out: &mut [f32], fs: f32, hz: f32, level_db: f32) {
    let a = db_to_amp(level_db) * 2.0f32.sqrt();
    for (i, s) in out.iter_mut().enumerate() {
        let t = i as f32 / fs;
        *s += a * (2.0 * PI * hz * t).sin() + 0.4 * a * (2.0 * PI * 2.0 * hz * t).sin() + 0.2 * a * (2.0 * PI * 3.0 * hz * t).sin();
    }
}

/// Adds white noise at `level_db` dBFS RMS.
pub fn add_noise(out: &mut [f32], level_db: f32, seed: u32) {
    let mut rng = Rng::new(seed);
    // Uniform in [-1, 1) has RMS 1/sqrt(3).
    let a = db_to_amp(level_db) * 3.0f32.sqrt();
    for s in out.iter_mut() {
        *s += a * rng.signed();
    }
}

/// Adds handling noise: dull thumps and short clicks at the given times, none of them a pitched
/// note. `peak_db` is each one's peak.
pub fn add_handling_noise(out: &mut [f32], fs: f32, times_s: &[f32], peak_db: f32, seed: u32) {
    let mut rng = Rng::new(seed);
    let a = db_to_amp(peak_db);
    for &t in times_s {
        let start = (t * fs) as usize;
        let len = (0.012 * fs) as usize;
        let mut lp = 0.0f32;
        for i in 0..len {
            if start + i >= out.len() {
                break;
            }
            // Broadband and short: no stable period to find.
            lp += 0.15 * (rng.signed() - lp);
            let env = (-(i as f32) / (0.003 * fs)).exp();
            out[start + i] += a * env * (lp * 3.0 + 0.3 * rng.signed());
        }
    }
}

/// Adds a slap: a flat burst of noise `ms` long at `peak_db`, the fret hand hitting the neck. Long
/// enough to register as an onset over a ringing string, gone before a pitch could be read from it.
pub fn add_slap(out: &mut [f32], fs: f32, at_s: f32, peak_db: f32, ms: f32, seed: u32) {
    let mut rng = Rng::new(seed);
    let a = db_to_amp(peak_db);
    let start = (at_s * fs) as usize;
    let len = (ms / 1000.0 * fs) as usize;
    let fade = (0.002 * fs) as usize;
    for i in 0..len {
        if start + i >= out.len() {
            break;
        }
        let edge = (i.min(len - 1 - i) as f32 / fade.max(1) as f32).min(1.0);
        out[start + i] += a * edge * rng.signed();
    }
}

/// A steady sine, for calibration-style checks.
pub fn sine(fs: f32, hz: f32, level_db: f32, seconds: f32) -> Vec<f32> {
    let a = db_to_amp(level_db) * 2.0f32.sqrt();
    (0..(seconds * fs) as usize).map(|i| a * (2.0 * PI * hz * i as f32 / fs).sin()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn a_pluck_peaks_where_it_was_told_to() {
        let (x, t) = mix(48_000.0, 1.0, &[Pluck::at(110.0).loud(-12.0)]);
        let peak = x.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        assert!((20.0 * peak.log10() + 12.0).abs() < 0.2, "peak {peak}");
        assert_eq!(t[0].midi, 45);
        assert_eq!(t[0].onset, 4800);
    }

    #[test]
    fn silence_before_the_pick() {
        let (x, _) = mix(48_000.0, 1.0, &[Pluck::at(110.0).starting(0.5)]);
        assert!(x[..24_000].iter().all(|&v| v == 0.0));
        assert!(x[24_000..26_000].iter().any(|&v| v != 0.0));
    }

    #[test]
    fn muting_silences_the_string() {
        let p = Pluck::at(196.0).ringing(0.5);
        let (x, t) = mix(48_000.0, 1.5, &[p]);
        let m = t[0].mute.unwrap() as usize;
        let before = rms(&x[m - 4800..m]);
        let after = rms(&x[m + 4800..m + 9600]);
        assert!(after < before * 0.03, "before {before} after {after}");
    }

    #[test]
    fn missing_fundamental_leaves_the_fundamental_bin_empty() {
        // Correlate against 110 Hz: with the fundamental removed there is almost no energy there.
        let fs = 48_000.0;
        let with = mix(fs, 1.0, &[Pluck::at(110.0)]).0;
        let without = mix(fs, 1.0, &[Pluck::at(110.0).without_fundamental()]).0;
        let energy_at = |x: &[f32], hz: f32| {
            let (mut c, mut s) = (0.0f32, 0.0f32);
            for (i, &v) in x.iter().enumerate() {
                let a = 2.0 * PI * hz * i as f32 / fs;
                c += v * a.cos();
                s += v * a.sin();
            }
            (c * c + s * s).sqrt() / x.len() as f32
        };
        assert!(energy_at(&without[4800..24_000], 110.0) < 0.1 * energy_at(&with[4800..24_000], 110.0));
    }

    #[test]
    fn same_seed_same_signal() {
        let a = mix(48_000.0, 0.3, &[Pluck::at(82.4).seeded(9)]).0;
        let b = mix(48_000.0, 0.3, &[Pluck::at(82.4).seeded(9)]).0;
        assert_eq!(a, b);
    }

    #[test]
    fn hum_has_the_level_asked_for() {
        let mut x = vec![0.0f32; 48_000];
        add_hum(&mut x, 48_000.0, 60.0, -40.0);
        // The fundamental alone would be -40 dB; the harmonics add a little.
        let db = 20.0 * rms(&x).log10();
        assert!(db > -40.0 && db < -38.5, "{db}");
    }
}

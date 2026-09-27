//! The instrument body as a bank of resonant modes, split by job:
//!
//! * **Coupled modes** - the few strong low-frequency modes (the air "A0" mode and the main
//!   corpus/wood modes around 400-600 Hz on a violin). They run at the string model's oversampled
//!   rate and their summed velocity *is* the bridge's motion, which is fed back into every string's
//!   bridge reflection. That feedback is what gives each note a slightly different decay and colour
//!   depending on where it falls against the body's resonances, lets the open strings ring in
//!   sympathy, and - pushed hard - produces a wolf note.
//! * **Radiating modes** - a denser statistical field of higher modes (up to ~10 kHz, the violin's
//!   "bridge hill" around 2-3 kHz included). They only colour the sound the body radiates; they are
//!   driven by the bridge force but do not push back on the strings, so they can run at the engine's
//!   base rate.
//!
//! Each mode is a two-pole resonator (a damped mass-spring's velocity response to force). The low
//! mode frequencies at scale 1 (A0 ~275 Hz, CBR ~405, B1- ~470, B1+ ~540 Hz ...) are the figures
//! commonly quoted in violin-acoustics literature (e.g. Bissinger's and Jansson's modal surveys),
//! used as illustrative defaults, not a measurement of one instrument; the high-frequency field is
//! generated from a seed (a different seed is a different "maker's" instrument of the same family).
//! Every frequency scales by `1 / size`, so the same body grows continuously from violin through
//! viola and cello to bass - and past them.
//!
//! **Quality tiers** (`crate::audio::quality`) change only the radiating field, never the coupled
//! modes (what the strings feel is the same at every tier):
//!
//! * `Live` and `Draft` use the field above, 40 modes spaced evenly in log frequency. (A sparser
//!   field for `Draft` saved nothing measurable - the field runs as one vectorized bank - and moved
//!   a note's bands by several dB, so `Draft` saves elsewhere: see `engine::Engine::new`.)
//! * `Render` is a dense field: [`RENDER_RADIATING_MODES`] modes, `Live`'s 40 at half their power
//!   and 200 more, of random sign, spaced evenly *in Hz* between them, the way a plate's modes fall
//!   (a thin plate's modal density is constant per Hz). Above ~2 kHz on a violin they are a few tens
//!   of Hz apart and overlap - the dense, overlapping response measured on real instruments, where a note's
//!   upper partials each land among several peaks and vibrato sweeps them across peaks and
//!   troughs. With 40 modes most upper partials sit in the gaps between isolated peaks.
//!
//! `Render`'s field is scaled band by band (third octaves) until its response matches `Live`'s with
//! the same seed, so a "maker" keeps its colour at every tier: the tiers differ only in how finely
//! the response is detailed within a band.

use super::dsp::{Noise, Resonator};
use crate::audio::quality::Quality;

pub const COUPLED_MODES: usize = 10;
/// The radiating field at `Live` (and `Draft`).
pub const RADIATING_MODES: usize = 40;
/// ... and at `Render`.
pub const RENDER_RADIATING_MODES: usize = 240;

/// How many radiating modes a body has at `quality`.
pub fn radiating_modes(quality: Quality) -> usize {
    match quality {
        Quality::Draft | Quality::Live => RADIATING_MODES,
        Quality::Render => RENDER_RADIATING_MODES,
    }
}

/// The share of the field's power `Render` leaves in `Live`'s modes; its own modes carry the rest.
const RENDER_KEEPS_LIVE: f32 = 0.5;

/// Modes the radiating field processes together (it runs as one vectorized bank).
const LANES: usize = 8;
/// Third-octave bands the tiers are matched over (enough for the largest body's field).
const MAX_BANDS: usize = 40;

/// (frequency Hz, Q, peak bridge admittance s/kg, radiation weight) at size 1 (a violin).
const VIOLIN_LOW_MODES: [(f32, f32, f32, f32); COUPLED_MODES] = [
    (275.0, 16.0, 0.010, 1.00), // A0: the air mode through the f-holes
    (405.0, 28.0, 0.012, 0.20), // CBR: centre-bout rotation, a poor radiator
    (470.0, 26.0, 0.035, 0.90), // B1-: first strong corpus bending mode
    (540.0, 30.0, 0.045, 1.00), // B1+
    (650.0, 30.0, 0.020, 0.55),
    (770.0, 32.0, 0.022, 0.60),
    (900.0, 34.0, 0.020, 0.55),
    (1050.0, 34.0, 0.026, 0.65),
    (1220.0, 36.0, 0.020, 0.55),
    // The bridge hill: the bridge's own rocking resonance on its feet, broad and lossy. It barely
    // radiates by itself (the radiating field below carries its colour), but it is the main way a
    // string loses high-frequency energy at the bridge, which is what damps the secondary waves
    // that would otherwise split the Helmholtz corner into multiple slips.
    (2600.0, 2.5, 0.060, 0.0),
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BodySpec {
    /// Frequency divisor: 1 a violin, ~1.2 a viola, ~2.7 a cello, ~4 a bass. Any positive value.
    pub size: f32,
    /// Scales every mode's Q: below 1 a deader, more heavily damped body, above 1 a livelier one.
    pub resonance: f32,
    /// Scales the coupled modes' admittance: how much the bridge moves, and so how much the strings
    /// hear the body (and each other). 1 is a normal instrument; well above 1 invites wolf notes.
    pub coupling: f32,
    /// Tilts the radiating field: 0 dark, 1 bright (moves and scales the bridge hill).
    pub brightness: f32,
    /// Picks the random high-frequency mode field: a different "maker".
    pub seed: u32,
    /// Left/right difference between the two virtual microphones, 0 mono .. 1 wide.
    pub spread: f32,
}

impl Default for BodySpec {
    fn default() -> Self {
        Self { size: 1.0, resonance: 1.0, coupling: 1.0, brightness: 0.5, seed: 1, spread: 0.6 }
    }
}

/// A mode's gains: admittance (coupled modes only) and radiation into the two microphones.
#[derive(Clone, Copy, Default)]
struct ModeGains {
    admittance: f32,
    rad_l: f32,
    rad_r: f32,
}

pub struct Body {
    pub spec: BodySpec,
    sr_os: f32,
    sr_base: f32,
    coupled: [Resonator; COUPLED_MODES],
    coupled_g: [ModeGains; COUPLED_MODES],
    coupled_freq: [f32; COUPLED_MODES],
    quality: Quality,
    radiating: Field,
    /// The bridge's velocity last oversampled tick (fed to the strings next tick).
    pub bridge_velocity: f32,
}

impl Body {
    /// A body at `quality` (which sets how many radiating modes it has; see the module doc).
    pub fn new(spec: BodySpec, sr_os: f32, sr_base: f32, quality: Quality) -> Self {
        let mut b = Self {
            spec,
            sr_os,
            sr_base,
            coupled: [Resonator::default(); COUPLED_MODES],
            coupled_g: [ModeGains::default(); COUPLED_MODES],
            coupled_freq: [0.0; COUPLED_MODES],
            quality,
            radiating: Field::new(radiating_modes(quality)),
            bridge_velocity: 0.0,
        };
        b.configure(spec);
        b
    }

    /// Recomputes every mode for a new spec. No allocation; safe on the audio thread. Resonator
    /// state is kept, so a body can be reshaped while it rings.
    pub fn configure(&mut self, spec: BodySpec) {
        self.spec = spec;
        let size = spec.size.clamp(0.1, 20.0);
        let q_scale = spec.resonance.clamp(0.05, 8.0);
        let spread = spec.spread.clamp(0.0, 1.0);
        let mut rng = Noise(0x2545F491 ^ spec.seed.wrapping_mul(0x9E3779B1).max(1));

        for (i, &(f, q, y, rad)) in VIOLIN_LOW_MODES.iter().enumerate() {
            // Small seeded detune so two "makers" differ in the low modes too, not only up high.
            // The bridge hill is the bridge's own resonance, and bridges grow far less than bodies
            // do (a bass bridge is not four times a violin's in every dimension): it scales with the
            // square root of the size, everything else with the size.
            let is_bridge = i == COUPLED_MODES - 1;
            let f = f * (1.0 + 0.04 * rng.bipolar()) / if is_bridge { size.sqrt() } else { size };
            self.coupled_freq[i] = f;
            self.coupled[i].set(f, q * q_scale, self.sr_os);
            // A larger body is heavier: its modes move less per newton, roughly with area.
            let admittance = y * spec.coupling.max(0.0) / size.powf(0.5);
            let pan = spread * rng.bipolar();
            self.coupled_g[i] = ModeGains { admittance, rad_l: rad * (1.0 + pan), rad_r: rad * (1.0 - pan) };
        }

        // The radiating field: log-spaced with jitter from ~1.1 kHz to ~10 kHz (at size 1), with an
        // envelope that peaks at the bridge hill and rolls off above it. This is `Live`'s field
        // (and `Draft`'s); `Render`'s is built on it.
        let bright = spec.brightness.clamp(0.0, 1.0);
        let hill = (1800.0 + 1600.0 * bright) / size.powf(0.35);
        let lo = 1150.0 / size;
        let hi = (10_000.0 / size.powf(0.3)).min(self.sr_base * 0.45);
        let shape = FieldShape { lo, hi, hill, bright, q_scale, spread };
        let mut live = [FieldMode::default(); RADIATING_MODES];
        for (i, m) in live.iter_mut().enumerate() {
            let t = (i as f32 + 0.5 + 0.8 * rng.bipolar() * 0.5) / RADIATING_MODES as f32;
            *m = shape.mode(lo * (hi / lo).powf(t.clamp(0.0, 1.0)), &mut rng);
        }
        let sr = self.sr_base;
        match self.quality {
            Quality::Draft | Quality::Live => {
                for (i, m) in live.iter().enumerate() {
                    self.radiating.set(i, m, sr);
                }
            }
            Quality::Render => {
                // The same body described more finely, so a note's harmonics meet the same peaks
                // at every tier: all of `Live`'s modes (at a share of their level), and modes of
                // its own between them, evenly in Hz as a plate's fall. Each of those reaches the
                // microphones in or out of phase at random, as a mode does depending on its shape:
                // with all 200 of one sign, their skirts added up in phase under the field and
                // everything below it came out 5-8 dB too loud. Then the whole field is scaled,
                // band by band, until its response matches `Live`'s. (Its own modes come from a
                // random stream of their own, so `Live`'s stay exactly as they are.)
                let mut rng = Noise(0x6C8E_9CF5 ^ spec.seed.wrapping_mul(0x85EB_CA6B).max(1));
                let n = self.radiating.len();
                let keep = RENDER_KEEPS_LIVE.sqrt();
                let fill = ((1.0 - RENDER_KEEPS_LIVE) * RADIATING_MODES as f32 / (n - RADIATING_MODES) as f32).sqrt();
                for (i, m) in live.iter().enumerate() {
                    self.radiating.set(i, &m.scaled(keep), sr);
                }
                for i in RADIATING_MODES..n {
                    let k = (i - RADIATING_MODES) as f32;
                    let t = ((k + 0.5 + 0.4 * rng.bipolar()) / (n - RADIATING_MODES) as f32).clamp(0.0, 1.0);
                    let mut m = shape.mode(lo + (hi - lo) * t, &mut rng);
                    if rng.unit() < 0.5 {
                        m.flip();
                    }
                    self.radiating.set(i, &m.scaled(fill), sr);
                }
                let grid = MatchGrid::new(lo, hi, sr);
                let mut live_coefs = [(0.0f32, 0.0f32, 0.0f32, 0.0f32); RADIATING_MODES];
                for (c, m) in live_coefs.iter_mut().zip(live.iter()) {
                    let (b0, a1, a2) = resonance(m.freq, m.q, sr);
                    *c = (b0, a1, a2, m.g);
                }
                let target = grid.band_power(live_coefs.iter().copied());
                for _ in 0..MATCH_PASSES {
                    let now = grid.band_power(self.radiating.coefs());
                    for i in 0..n {
                        let b = grid.band(self.radiating.modes[i].freq);
                        if now[b] > 0.0 && target[b] > 0.0 {
                            self.radiating.scale_gain(i, (target[b] / now[b]).sqrt());
                        }
                    }
                }
            }
        }
    }

    pub fn clear(&mut self) {
        self.coupled.iter_mut().for_each(|r| r.clear());
        self.radiating.clear();
        self.bridge_velocity = 0.0;
    }

    /// One oversampled tick of the coupled modes, driven by the total bridge force. Updates
    /// `bridge_velocity` and returns the coupled modes' radiation into (left, right).
    #[inline]
    pub fn tick_coupled(&mut self, bridge_force: f32) -> (f32, f32) {
        let mut v = 0.0;
        let (mut l, mut r) = (0.0, 0.0);
        for (m, g) in self.coupled.iter_mut().zip(self.coupled_g.iter()) {
            let u = m.process(bridge_force) * g.admittance;
            v += u;
            l += u * g.rad_l;
            r += u * g.rad_r;
        }
        // The bridge can't physically run away; a soft ceiling keeps an extreme lab setting from
        // blowing up without touching any normal playing level (bridge velocities are ~mm/s).
        self.bridge_velocity = 0.5 * (v * 2.0).tanh();
        (l, r)
    }

    /// One base-rate tick of the radiating field, driven by the (decimated) bridge force.
    #[inline]
    pub fn tick_radiating(&mut self, bridge_force: f32) -> (f32, f32) {
        self.radiating.tick(bridge_force)
    }

    /// The tier this body was built at.
    pub fn quality(&self) -> Quality {
        self.quality
    }

    /// How many radiating modes it runs.
    pub fn radiating_count(&self) -> usize {
        self.radiating.len()
    }

    /// Radiating mode `i`'s frequency (Hz), Q and (left, right) gain, for tests.
    pub fn radiating_mode(&self, i: usize) -> (f32, f32, f32, f32) {
        let m = &self.radiating.modes[i.min(self.radiating.len() - 1)];
        (m.freq, m.q, m.rad_l, m.rad_r)
    }

    /// The coupled modes' frequencies and how hard each is ringing (for Physics View).
    pub fn mode_frequencies(&self) -> [f32; COUPLED_MODES] {
        self.coupled_freq
    }

    pub fn mode_energy(&self, i: usize) -> f32 {
        let g = self.coupled_g[i.min(COUPLED_MODES - 1)].admittance;
        self.coupled[i.min(COUPLED_MODES - 1)].energy().sqrt() * g
    }
}

// ------------------------------------------------------------------------------------------
// The radiating field
// ------------------------------------------------------------------------------------------

/// What every radiating mode is drawn from: where the field lies and its envelope.
struct FieldShape {
    lo: f32,
    hi: f32,
    hill: f32,
    bright: f32,
    q_scale: f32,
    spread: f32,
}

#[derive(Clone, Copy, Default)]
struct FieldMode {
    freq: f32,
    q: f32,
    /// Radiation into (left, right), and its level before panning.
    rad_l: f32,
    rad_r: f32,
    g: f32,
}

impl FieldMode {
    fn scaled(mut self, k: f32) -> Self {
        self.g *= k;
        self.rad_l *= k;
        self.rad_r *= k;
        self
    }

    /// Radiates in opposite phase.
    fn flip(&mut self) {
        self.g = -self.g;
        self.rad_l = -self.rad_l;
        self.rad_r = -self.rad_r;
    }
}

/// A two-pole resonance with unit gain at its peak (as `Resonator::set`): `(b0, a1, a2)` of
/// `b0 (1 - z^-2) / (1 + a1 z^-1 + a2 z^-2)`.
fn resonance(freq: f32, q: f32, sr: f32) -> (f32, f32, f32) {
    let f = freq.clamp(10.0, sr * 0.45);
    let w0 = std::f32::consts::TAU * f / sr;
    let alpha = w0.sin() / (2.0 * q.max(0.5));
    let a0 = 1.0 + alpha;
    (alpha / a0, -2.0 * w0.cos() / a0, (1.0 - alpha) / a0)
}

/// Times a tier's field is rescaled toward `Live`'s response (each pass also corrects what the
/// last one did to the neighbouring bands through the modes' skirts).
const MATCH_PASSES: usize = 2;
/// Frequencies each band's response is averaged over: finer than a `Live` mode's bandwidth (about
/// 2.5% at Q 40), so its peaks are neither missed nor over-counted.
const MATCH_POINTS: usize = 16;

/// Where the tiers' fields are compared: third-octave bands from two octaves under the field (its
/// skirt, where it mixes with the coupled modes) to its top, `MATCH_POINTS` frequencies in each.
struct MatchGrid {
    lo: f32,
    bands: usize,
    /// `(cos w, sin w)` at each point, band by band.
    points: [[(f32, f32); MATCH_POINTS]; MAX_BANDS],
}

impl MatchGrid {
    fn new(field_lo: f32, field_hi: f32, sr: f32) -> Self {
        let lo = field_lo / 4.0;
        let top = (field_hi * 1.26).min(sr * 0.45);
        let bands = ((3.0 * (top / lo).log2()).ceil() as usize).clamp(1, MAX_BANDS);
        let mut points = [[(0.0, 0.0); MATCH_POINTS]; MAX_BANDS];
        for (b, band) in points.iter_mut().enumerate().take(bands) {
            for (k, p) in band.iter_mut().enumerate() {
                let f = lo * 2f32.powf((b as f32 + (k as f32 + 0.5) / MATCH_POINTS as f32) / 3.0);
                let w = std::f32::consts::TAU * f.min(sr * 0.49) / sr;
                *p = (w.cos(), w.sin());
            }
        }
        Self { lo, bands, points }
    }

    fn band(&self, f: f32) -> usize {
        ((3.0 * (f / self.lo).log2()).max(0.0) as usize).min(self.bands - 1)
    }

    /// Each band's mean power response of a field given as `(b0, a1, a2, gain)` per mode.
    fn band_power(&self, modes: impl Iterator<Item = (f32, f32, f32, f32)> + Clone) -> [f32; MAX_BANDS] {
        let mut out = [0.0f32; MAX_BANDS];
        for (b, band) in self.points.iter().enumerate().take(self.bands) {
            let mut sum = 0.0;
            for &(c, s) in band {
                // e^-jw and e^-2jw.
                let (c2, s2) = (c * c - s * s, 2.0 * s * c);
                let (mut re, mut im) = (0.0f32, 0.0f32);
                for (b0, a1, a2, g) in modes.clone() {
                    // H = b0 (1 - e^-2jw) / (1 + a1 e^-jw + a2 e^-2jw)
                    let (nr, ni) = (b0 * (1.0 - c2), b0 * s2);
                    let (dr, di) = (1.0 + a1 * c + a2 * c2, -(a1 * s + a2 * s2));
                    let d = dr * dr + di * di;
                    re += g * (nr * dr + ni * di) / d;
                    im += g * (ni * dr - nr * di) / d;
                }
                sum += re * re + im * im;
            }
            out[b] = sum / MATCH_POINTS as f32;
        }
        out
    }
}

impl FieldShape {
    /// A mode at `f`, with its level, Q and pan drawn from `rng` (four draws, in the order the field
    /// has always used).
    fn mode(&self, f: f32, rng: &mut Noise) -> FieldMode {
        let octaves_from_hill = (f / self.hill).log2();
        // Rises toward the hill, falls ~9 dB/oct past it (less for a brighter body).
        let env_db = if octaves_from_hill < 0.0 { 5.0 * octaves_from_hill } else { -(12.0 - 6.0 * self.bright) * octaves_from_hill };
        // Rayleigh-ish per-mode scatter: real modal fields are lumpy, that's the character.
        let scatter = 0.35 + 1.3 * rng.unit();
        let g = 10f32.powf(env_db / 20.0) * scatter;
        let q = (28.0 + 30.0 * rng.unit()) * self.q_scale;
        let pan = self.spread * rng.bipolar();
        FieldMode { freq: f, q, rad_l: g * (1.0 + pan), rad_r: g * (1.0 - pan), g }
    }
}

/// The radiating modes as one bank: every mode hears the same drive, so each keeps only its own
/// two outputs, and the bank runs `LANES` modes at a time (it vectorizes; the dense `Render` field
/// is 240 modes). Padded to a whole number of lanes with silent modes.
struct Field {
    n: usize,
    b0: Vec<f32>,
    a1: Vec<f32>,
    a2: Vec<f32>,
    y1: Vec<f32>,
    y2: Vec<f32>,
    gl: Vec<f32>,
    gr: Vec<f32>,
    /// The drive one and two samples ago (shared by every mode).
    x1: f32,
    x2: f32,
    modes: Vec<FieldMode>,
}

impl Field {
    fn new(n: usize) -> Self {
        let padded = n.div_ceil(LANES) * LANES;
        let z = || vec![0.0; padded];
        Self { n, b0: z(), a1: z(), a2: z(), y1: z(), y2: z(), gl: z(), gr: z(), x1: 0.0, x2: 0.0, modes: vec![FieldMode::default(); n] }
    }

    fn len(&self) -> usize {
        self.n
    }

    /// Sets mode `i` (the same two-pole resonance as `Resonator`, unit gain at its peak). Keeps its
    /// state, so a body can be reshaped while it rings.
    fn set(&mut self, i: usize, m: &FieldMode, sr: f32) {
        (self.b0[i], self.a1[i], self.a2[i]) = resonance(m.freq, m.q, sr);
        self.gl[i] = m.rad_l;
        self.gr[i] = m.rad_r;
        self.modes[i] = *m;
    }

    /// `(b0, a1, a2, gain)` of every mode.
    fn coefs(&self) -> impl Iterator<Item = (f32, f32, f32, f32)> + Clone + '_ {
        (0..self.n).map(|i| (self.b0[i], self.a1[i], self.a2[i], self.modes[i].g))
    }

    fn scale_gain(&mut self, i: usize, k: f32) {
        self.gl[i] *= k;
        self.gr[i] *= k;
        let m = &mut self.modes[i];
        m.rad_l *= k;
        m.rad_r *= k;
        m.g *= k;
    }

    fn clear(&mut self) {
        self.y1.iter_mut().chain(self.y2.iter_mut()).for_each(|v| *v = 0.0);
        self.x1 = 0.0;
        self.x2 = 0.0;
    }

    #[inline]
    fn tick(&mut self, x: f32) -> (f32, f32) {
        // Each mode: y = b0 (x - x2) - a1 y1 - a2 y2.
        let d = x - self.x2;
        self.x2 = self.x1;
        self.x1 = x;
        let (b0, _) = self.b0.as_chunks::<LANES>();
        let (a1, _) = self.a1.as_chunks::<LANES>();
        let (a2, _) = self.a2.as_chunks::<LANES>();
        let (gl, _) = self.gl.as_chunks::<LANES>();
        let (gr, _) = self.gr.as_chunks::<LANES>();
        let (y1, _) = self.y1.as_chunks_mut::<LANES>();
        let (y2, _) = self.y2.as_chunks_mut::<LANES>();
        let (mut l, mut r) = ([0.0f32; LANES], [0.0f32; LANES]);
        for c in 0..b0.len() {
            let (b0, a1, a2, gl, gr) = (&b0[c], &a1[c], &a2[c], &gl[c], &gr[c]);
            let (y1, y2) = (&mut y1[c], &mut y2[c]);
            for k in 0..LANES {
                let y = b0[k] * d - a1[k] * y1[k] - a2[k] * y2[k];
                y2[k] = y1[k];
                y1[k] = y;
                l[k] += y * gl[k];
                r[k] += y * gr[k];
            }
        }
        (l.iter().sum(), r.iter().sum())
    }
}

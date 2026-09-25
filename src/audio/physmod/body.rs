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

use super::dsp::{Noise, Resonator};

pub const COUPLED_MODES: usize = 10;
pub const RADIATING_MODES: usize = 40;

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
    radiating: [Resonator; RADIATING_MODES],
    radiating_g: [ModeGains; RADIATING_MODES],
    /// The bridge's velocity last oversampled tick (fed to the strings next tick).
    pub bridge_velocity: f32,
}

impl Body {
    pub fn new(spec: BodySpec, sr_os: f32, sr_base: f32) -> Self {
        let mut b = Self {
            spec,
            sr_os,
            sr_base,
            coupled: [Resonator::default(); COUPLED_MODES],
            coupled_g: [ModeGains::default(); COUPLED_MODES],
            coupled_freq: [0.0; COUPLED_MODES],
            radiating: [Resonator::default(); RADIATING_MODES],
            radiating_g: [ModeGains::default(); RADIATING_MODES],
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
        // envelope that peaks at the bridge hill and rolls off above it.
        let bright = spec.brightness.clamp(0.0, 1.0);
        let hill = (1800.0 + 1600.0 * bright) / size.powf(0.35);
        let lo = 1150.0 / size;
        let hi = (10_000.0 / size.powf(0.3)).min(self.sr_base * 0.45);
        for i in 0..RADIATING_MODES {
            let t = (i as f32 + 0.5 + 0.8 * rng.bipolar() * 0.5) / RADIATING_MODES as f32;
            let f = lo * (hi / lo).powf(t.clamp(0.0, 1.0));
            let octaves_from_hill = (f / hill).log2();
            // Rises toward the hill, falls ~9 dB/oct past it (less for a brighter body).
            let env_db = if octaves_from_hill < 0.0 { 5.0 * octaves_from_hill } else { -(12.0 - 6.0 * bright) * octaves_from_hill };
            // Rayleigh-ish per-mode scatter: real modal fields are lumpy, that's the character.
            let scatter = 0.35 + 1.3 * rng.unit();
            let g = 10f32.powf(env_db / 20.0) * scatter;
            let q = (28.0 + 30.0 * rng.unit()) * q_scale;
            self.radiating[i].set(f, q, self.sr_base);
            let pan = spread * rng.bipolar();
            self.radiating_g[i] = ModeGains { admittance: 0.0, rad_l: g * (1.0 + pan), rad_r: g * (1.0 - pan) };
        }
    }

    pub fn clear(&mut self) {
        self.coupled.iter_mut().for_each(|r| r.clear());
        self.radiating.iter_mut().for_each(|r| r.clear());
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
        let (mut l, mut r) = (0.0, 0.0);
        for (m, g) in self.radiating.iter_mut().zip(self.radiating_g.iter()) {
            let u = m.process(bridge_force);
            l += u * g.rad_l;
            r += u * g.rad_r;
        }
        (l, r)
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

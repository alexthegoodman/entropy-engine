//! One string as a digital waveguide (Smith, "Physical Audio Signal Processing", CCRMA): travelling
//! velocity waves in four delay lines, because the bow splits the string into two segments -
//! finger (or nut) to bow, and bow to bridge - each carrying a wave in both directions.
//!
//! ```text
//!   finger/nut           bow                        bridge
//!      |  --- a_r --->    |   --- b_r --->            |
//!      |  <--- a_l ---    |   <--- b_l ---            |
//!    reflect (-1,       friction                reflect (-1, losses,
//!    soft finger)       junction                stiffness) + bridge motion
//! ```
//!
//! Every sample: the waves arriving at each end reflect (inverted, minus that end's losses), and at
//! the bow the two arriving waves are summed into the string's free velocity `v_h`, which the
//! friction solve ([`super::friction::solve`]) turns into the contact velocity; the difference is
//! launched both ways. The force on the bridge (what drives the body) falls out of the bridge-end
//! waves, and the bridge's own motion - driven by every string at once - is fed back into the
//! reflection, which is what lets strings exchange energy through the bridge (sympathetic
//! resonance, and the wolf note when coupling is strong).
//!
//! Tuning: the four segment lengths plus the phase delay of the termination filters add up to one
//! period, so the pitch is right to within a cent or so regardless of note, stiffness or losses
//! (the bow itself can still pull a note slightly flat under heavy force - a real effect).

use super::dsp::{Allpass1, Delay, OnePole};
use super::friction::{self, Contact, FrictionCurve};
use std::f32::consts::TAU;

/// Waveguide sections of this many first-order allpasses model bending stiffness.
const DISPERSION_STAGES: usize = 8;
/// Samples per delay line: enough for the lowest supported note at the oversampled rate.
pub const LINE_CAPACITY: usize = 4096;
/// Fewest samples a segment may have (the cubic interpolator's reach).
const MIN_SEG: f32 = 2.05;

/// A string's physical construction. Frequencies in Hz, impedance in kg/s.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StringSpec {
    /// Open (unstopped) pitch.
    pub open_freq: f32,
    /// Characteristic impedance `sqrt(tension * linear density)`: a heavier or tighter string needs
    /// more bow force for the same motion.
    pub impedance: f32,
    /// Seconds for the fundamental of a free, undamped-by-hand string to fall 60 dB from its own
    /// internal and end losses (the body adds more through the bridge).
    pub t60: f32,
    /// Where the string's per-trip lowpass loss sits, Hz: lower is a darker, gut-like string.
    pub loss_hz: f32,
    /// 0..1: bending stiffness, 0 an ideal flexible string, 1 something closer to a thin bar whose
    /// upper partials land audibly sharp.
    pub stiffness: f32,
}

impl Default for StringSpec {
    fn default() -> Self {
        Self { open_freq: 440.0, impedance: 0.25, t60: 2.0, loss_hz: 9000.0, stiffness: 0.05 }
    }
}

/// The inharmonicity coefficient `B` (partial n at `n f0 sqrt(1 + B n^2)`) for a 0..1 stiffness: 0 an
/// ideal string, ~0.1 a violin string (B ~ 4e-5, inaudible but real), 1 a thin metal bar (B = 4e-3,
/// the 8th partial ~12% sharp).
pub fn inharmonicity(stiffness: f32) -> f32 {
    0.004 * stiffness.clamp(0.0, 1.0).powi(2)
}

/// The first-order allpass coefficient that, in a cascade of `DISPERSION_STAGES` inside a loop tuned
/// to `freq`, puts a reference partial (the 8th, or lower for high notes) where inharmonicity `b`
/// says it should be relative to the fundamental. Bisection: the dispersion grows monotonically as
/// the coefficient goes more negative.
pub fn dispersion_coefficient(b: f32, freq: f32, sr: f32) -> f32 {
    if b <= 0.0 {
        return 0.0;
    }
    let period = sr / freq;
    let n = ((sr * 0.2 / freq).floor() as usize).clamp(2, 8) as f32;
    let w1 = TAU * freq / sr;
    // The loop delay at partial n must be shorter than at the fundamental by this many samples.
    let target = period * (1.0 - ((1.0 + b) / (1.0 + n * n * b)).sqrt());
    let m = DISPERSION_STAGES as f32;
    let spread = |c: f32| {
        // Partial n's own frequency moves with c; one fixed-point step is plenty for this.
        let wn = w1 * n * ((1.0 + n * n * b) / (1.0 + b)).sqrt();
        m * (Allpass1::phase_delay(c, w1) - Allpass1::phase_delay(c, wn))
    };
    // Keep the allpasses' own delay well inside one period, so the delay lines never run short.
    let max_delay = |c: f32| m * Allpass1::phase_delay(c, w1) < period * 0.5;
    let (mut lo, mut hi) = (-0.97f32, 0.0f32);
    while !max_delay(lo) && lo < -0.01 {
        lo *= 0.9;
    }
    if spread(lo) <= target {
        return lo;
    }
    for _ in 0..30 {
        let mid = 0.5 * (lo + hi);
        if spread(mid) > target { lo = mid } else { hi = mid }
    }
    0.5 * (lo + hi)
}

/// What the bow and hand are doing to a string this sample.
#[derive(Clone, Copy, Debug, Default)]
pub struct Excitation {
    /// Bow speed, m/s (signed: the sign is the bow direction).
    pub bow_velocity: f32,
    /// Bow force, N (0 = the bow is off the string).
    pub bow_force: f32,
    /// A force applied at the bow point by something other than the bow (a plucking finger, a
    /// strike), N.
    pub external_force: f32,
    /// A guided attack (see `Engine`'s player): the contact velocity an ideal stick-slip cycle
    /// would have right now, how strongly to impose it (0 = pure friction, 1 = fully guided), and
    /// whether that ideal cycle is in its sticking phase.
    pub guide_velocity: f32,
    pub guide_weight: f32,
    pub guide_stuck: bool,
}

/// Running statistics about the contact, read (and reset) by whoever publishes them.
#[derive(Clone, Copy, Debug, Default)]
pub struct ContactStats {
    pub samples: u32,
    pub stuck: u32,
    /// Stick-to-slip transitions: one per period is Helmholtz motion.
    pub releases: u32,
}

pub struct BowedString {
    pub spec: StringSpec,
    sr: f32,
    a_r: Delay,
    a_l: Delay,
    b_r: Delay,
    b_l: Delay,
    /// One-way lengths (samples) of the finger-bow and bow-bridge segments, smoothed.
    len_a: f32,
    len_b: f32,
    target_a: f32,
    target_b: f32,
    /// The pitch the finger is stopping (== open_freq when no finger is down).
    freq: f32,
    beta: f32,
    bridge_lp: OnePole,
    finger_lp: OnePole,
    disp: [Allpass1; DISPERSION_STAGES],
    disp_c: f32,
    /// (freq, B) the dispersion coefficient was last solved for.
    disp_key: (f32, f32),
    bridge_a: f32,
    finger_a: f32,
    /// Per-round-trip gain at DC, split between the two ends.
    g_bridge: f32,
    g_finger: f32,
    /// Extra damping on top of `spec.t60` (a light left-hand mute, a finger lifting): 0..1.
    extra_damping: f32,
    pub contact: Contact,
    pub stats: ContactStats,
    /// Contact velocity and free velocity at the bow last sample (m/s), for visualization/tests.
    pub last_v: f32,
    pub last_vh: f32,
    /// Force on the bridge last sample, N.
    pub last_force: f32,
    friction: FrictionCurve,
    /// A slowly updated amplitude estimate of the waves on the string, for "is it still ringing".
    pub level: f32,
    /// Oversampled ticks so far, the tick of the last stick-to-slip release, and a running average
    /// of the interval between releases (the period the string is actually vibrating at while
    /// bowed in Helmholtz motion), 0 when there is none yet.
    ticks: u64,
    last_release: u64,
    pub period_estimate: f32,
    /// 0..1: how consistently recent releases have come once per period (clean Helmholtz motion).
    pub helmholtz_confidence: f32,
}

impl BowedString {
    pub fn new(spec: StringSpec, sr: f32) -> Self {
        let mut s = Self {
            spec,
            sr,
            a_r: Delay::new(LINE_CAPACITY),
            a_l: Delay::new(LINE_CAPACITY),
            b_r: Delay::new(LINE_CAPACITY),
            b_l: Delay::new(LINE_CAPACITY),
            len_a: 0.0,
            len_b: 0.0,
            target_a: 0.0,
            target_b: 0.0,
            freq: spec.open_freq,
            beta: 0.12,
            bridge_lp: OnePole::default(),
            finger_lp: OnePole::default(),
            disp: [Allpass1::default(); DISPERSION_STAGES],
            disp_c: 0.0,
            disp_key: (0.0, -1.0),
            bridge_a: 0.0,
            finger_a: 0.0,
            g_bridge: 1.0,
            g_finger: 1.0,
            extra_damping: 0.0,
            contact: Contact::SlipBehind,
            stats: ContactStats::default(),
            last_v: 0.0,
            last_vh: 0.0,
            last_force: 0.0,
            friction: FrictionCurve::default(),
            level: 0.0,
            ticks: 0,
            last_release: 0,
            period_estimate: 0.0,
            helmholtz_confidence: 0.0,
        };
        s.retune(spec.open_freq, s.beta);
        s.len_a = s.target_a;
        s.len_b = s.target_b;
        s
    }

    /// The lowest pitch the delay lines can hold at this sample rate.
    pub fn min_freq(sr: f32) -> f32 {
        sr / (2.0 * (LINE_CAPACITY as f32 - 8.0))
    }

    pub fn set_spec(&mut self, spec: StringSpec) {
        if spec != self.spec {
            self.spec = spec;
            self.retune(self.freq, self.beta);
        }
    }

    pub fn set_friction(&mut self, curve: FrictionCurve) {
        self.friction = curve;
    }

    pub fn set_extra_damping(&mut self, d: f32) {
        let d = d.clamp(0.0, 1.0);
        if (d - self.extra_damping).abs() > 1.0e-4 {
            self.extra_damping = d;
            self.retune(self.freq, self.beta);
        }
    }

    pub fn freq(&self) -> f32 {
        self.freq
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    pub fn beta(&self) -> f32 {
        self.beta
    }

    /// Whether a finger is stopping the string (as opposed to it ringing open).
    pub fn stopped(&self) -> bool {
        self.freq > self.spec.open_freq * 1.0005
    }

    /// Moves the finger to sound `freq` and the bow to `beta` (fraction of the vibrating length from
    /// the bridge). The lengths glide there over a few milliseconds (see `tick`), which is also what
    /// a slur or vibrato sounds like.
    pub fn retune(&mut self, freq: f32, beta: f32) {
        let sr = self.sr;
        let freq = freq.clamp(Self::min_freq(sr), sr * 0.25);
        self.freq = freq;
        let w = TAU * freq / sr;

        // Losses. The per-trip gain is chosen for `t60` at the fundamental; extra damping shortens it
        // steeply (a fully damped string dies in a few tens of milliseconds).
        let t60 = (self.spec.t60.max(0.02) * (1.0 - 0.985 * self.extra_damping)).max(0.015);
        let g_total = 10f32.powf(-3.0 / (t60 * freq)).clamp(0.0, 0.99995);
        let stopped = freq > self.spec.open_freq * 1.0005;
        // A fingertip is a softer, lossier termination than the nut - but the nut is not lossless
        // either (the groove, and the afterlength behind it), and that little high-frequency loss
        // matters: with a perfectly rigid nut the open strings' Helmholtz motion was measurably
        // fragile (a playable force window several times narrower than the stopped notes').
        self.finger_a = OnePole::coef_for(if stopped { 7000.0 } else { 9000.0 }, sr);
        self.g_finger = if stopped { 0.997 } else { 0.999 };
        self.bridge_a = OnePole::coef_for(self.spec.loss_hz.clamp(500.0, sr * 0.45), sr);
        let lp_gain = |a: f32| {
            // |H(w)| of the one-pole at the fundamental, so the fundamental's decay stays at t60.
            let (s, c) = w.sin_cos();
            (1.0 - a) / ((1.0 - a * c).powi(2) + (a * s).powi(2)).sqrt()
        };
        let lp_at_f0 = lp_gain(self.bridge_a) * lp_gain(self.finger_a);
        self.g_bridge = (g_total / (self.g_finger * lp_at_f0)).min(0.99995);

        // Stiffness: allpass coefficient; negative c delays lows more than highs, so upper partials
        // come round sooner and land sharp. Solved per note for the target inharmonicity.
        // Cached: vibrato retunes every few samples, and the coefficient barely moves over a few
        // cents (the small tuning error it leaves is compensated below via its phase delay anyway).
        let b = inharmonicity(self.spec.stiffness);
        if b != self.disp_key.1 || (freq / self.disp_key.0 - 1.0).abs() > 0.004 {
            self.disp_c = dispersion_coefficient(b, freq, sr);
            self.disp_key = (freq, b);
        }

        let pd = OnePole::phase_delay(self.bridge_a, w) + OnePole::phase_delay(self.finger_a, w) + DISPERSION_STAGES as f32 * Allpass1::phase_delay(self.disp_c, w);
        let one_way = ((sr / freq - pd) * 0.5).clamp(2.0 * MIN_SEG, self.a_r.max_delay() * 0.98);
        let beta = beta.clamp(MIN_SEG / one_way, 1.0 - MIN_SEG / one_way);
        self.beta = beta;
        self.target_b = one_way * beta;
        self.target_a = one_way - self.target_b;
    }

    /// Snaps the lengths to their targets (a new note on a silent string, not a slide).
    pub fn snap(&mut self) {
        self.len_a = self.target_a;
        self.len_b = self.target_b;
    }

    /// Empties the string.
    pub fn silence(&mut self) {
        self.a_r.clear();
        self.a_l.clear();
        self.b_r.clear();
        self.b_l.clear();
        self.level = 0.0;
    }

    /// One sample. `bridge_velocity` is how fast the bridge is moving (from the body, driven by every
    /// string); returns the force this string puts on the bridge.
    #[inline]
    pub fn tick(&mut self, ex: Excitation, bridge_velocity: f32, glide: f32) -> f32 {
        self.len_a += (self.target_a - self.len_a) * glide;
        self.len_b += (self.target_b - self.len_b) * glide;

        let a_r_out = self.a_r.read(self.len_a);
        let a_l_out = self.a_l.read(self.len_a);
        let b_r_out = self.b_r.read(self.len_b);
        let b_l_out = self.b_l.read(self.len_b);

        // Finger / nut: an inverting, slightly lossy reflection.
        let finger_ref = -self.g_finger * self.finger_lp.process(a_l_out, self.finger_a);

        // Bridge: stiffness dispersion, losses, inversion, plus the bridge's own motion.
        let mut x = b_r_out;
        for ap in self.disp.iter_mut() {
            x = ap.process(x, self.disp_c);
        }
        let bridge_ref = -self.g_bridge * self.bridge_lp.process(x, self.bridge_a) + bridge_velocity;

        // Bow: friction against the string's free velocity at the contact.
        let z = self.spec.impedance;
        let v_h = a_r_out + b_l_out;
        let (mut v, mut contact) = friction::solve(v_h, ex.bow_velocity, z, ex.bow_force, &self.friction, self.contact);
        if ex.guide_weight > 0.0 {
            let w = ex.guide_weight.min(1.0);
            v += (ex.guide_velocity - v) * w;
            if w > 0.5 {
                contact = if ex.guide_stuck { Contact::Stick } else { Contact::SlipBehind };
            }
        }
        let two_z = 2.0 * z;
        let dv = (v - v_h) + ex.external_force / two_z;

        self.ticks += 1;
        if ex.bow_force > 0.0 {
            self.stats.samples += 1;
            if contact.is_stuck() {
                self.stats.stuck += 1;
            } else if self.contact.is_stuck() {
                self.stats.releases += 1;
                // Track the release-to-release interval while it looks like one period of
                // Helmholtz motion (not a multiple slip or a long raucous stick).
                let interval = (self.ticks - self.last_release) as f32;
                let nominal = self.sr / self.freq;
                if (interval / nominal - 1.0).abs() < 0.15 {
                    self.period_estimate = if self.period_estimate > 0.0 { self.period_estimate + (interval - self.period_estimate) * 0.1 } else { interval };
                    self.helmholtz_confidence += (1.0 - self.helmholtz_confidence) * 0.15;
                } else {
                    self.helmholtz_confidence *= 0.7;
                }
                self.last_release = self.ticks;
            }
        } else {
            self.period_estimate = 0.0;
            self.helmholtz_confidence = 0.0;
        }
        self.contact = contact;
        self.last_v = v_h + dv;
        self.last_vh = v_h;

        self.a_r.push(finger_ref);
        self.a_l.push(b_l_out + dv);
        self.b_r.push(a_r_out + dv);
        self.b_l.push(bridge_ref);

        // Force on the bridge: Z (v+ - v-) at the bridge end.
        let force = self.spec.impedance * (b_r_out - bridge_ref);
        self.last_force = force;
        self.level += (a_r_out.abs() + b_r_out.abs() - self.level) * 0.0005;
        force
    }

    /// The string's transverse displacement (arbitrary units) from finger to bridge, at `out.len()`
    /// evenly spaced points, rebuilt from the travelling velocity waves: along a string the slope is
    /// `(v- - v+) / c`, so integrating the wave difference along the delay lines gives the shape, the
    /// way the Helmholtz corner is drawn in textbooks. Pinned to zero at both ends.
    pub fn shape(&self, out: &mut [f32]) {
        let la = self.len_a.max(1.0);
        let lb = self.len_b.max(1.0);
        let total = la + lb;
        let n_steps = (total.round() as usize).clamp(4, 2 * LINE_CAPACITY);
        let step = total / n_steps as f32;
        let n_out = out.len();
        if n_out == 0 {
            return;
        }
        let slope = |i: usize| {
            let p = (i as f32 + 0.5) * step;
            let (vp, vm) = if p < la {
                (self.a_r.tap(p as usize), self.a_l.tap((la - p) as usize))
            } else {
                let q = p - la;
                (self.b_r.tap(q as usize), self.b_l.tap((lb - q) as usize))
            };
            (vm - vp) * step / self.sr
        };
        // Two passes rather than a scratch buffer: this runs on the audio thread, which must not
        // allocate. The first finds where the integral ends up (to pin the bridge end to zero), the
        // second writes the output points as the running integral passes them.
        let end: f32 = (0..n_steps).map(slope).sum();
        let mut y = 0.0f32;
        let mut k = 0usize;
        for i in 0..=n_steps {
            // `y` is the displacement at step boundary i.
            while k < n_out && (k * n_steps) <= i * (n_out - 1).max(1) {
                let t = k as f32 / (n_out - 1).max(1) as f32;
                out[k] = y - end * t;
                k += 1;
            }
            if i < n_steps {
                y += slope(i);
            }
        }
        while k < n_out {
            out[k] = 0.0;
            k += 1;
        }
    }

    /// Where the bow is along the vibrating length, as a fraction from the *finger* end (0) to the
    /// bridge (1) - the same orientation `shape` uses.
    pub fn bow_point(&self) -> f32 {
        let total = (self.len_a + self.len_b).max(1.0);
        self.len_a / total
    }
}

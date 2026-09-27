//! A six-band parametric EQ for a track's mixing bus: a low cut, a low shelf, two bells, a high
//! shelf and a high cut. Like the character effects it is inline (its output replaces the signal)
//! and a plain struct ticked one stereo frame at a time, so the live bus and the offline export
//! run the exact same code (see `EffectParams::Eq` in mod.rs and `TrackBusRender::eq`).
//!
//! Every band is an RBJ-cookbook biquad in transposed direct form II. Three things keep it quiet
//! while it is being played with:
//!
//! * **Parameters glide.** A dragged node moves the band's target; the band follows along a 20 ms
//!   curve (frequency and Q in the log domain, gain in dB), with its coefficients recomputed every
//!   `BLOCK` frames. A jump from 200 Hz to 8 kHz sweeps instead of stepping.
//! * **Switching fades.** A bell or shelf that is switched off glides to 0 dB; a cut filter fades
//!   between its input and its output. Neither pops.
//! * **Flat is free.** When every band is flat and the output trim is 0 dB, `process` hands the
//!   input back untouched: an EQ nobody has touched costs nothing and changes nothing.
//!
//! `response_db` is the same maths the filters run, evaluated on the unit circle: what the DAW's
//! EQ view draws is exactly what the track hears.

use std::f32::consts::PI;

pub const EQ_BANDS: usize = 6;
/// Frames between coefficient updates while a parameter is gliding.
const BLOCK: u32 = 16;
/// Time constant of the parameter glide, seconds.
const GLIDE_SECONDS: f32 = 0.02;
pub const MIN_FREQ: f32 = 20.0;
pub const MAX_FREQ: f32 = 20_000.0;
pub const MAX_GAIN_DB: f32 = 18.0;
pub const MIN_Q: f32 = 0.1;
pub const MAX_Q: f32 = 18.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BandKind {
    LowCut,
    LowShelf,
    Peak,
    HighShelf,
    HighCut,
}

impl BandKind {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "lowcut" => Some(BandKind::LowCut),
            "lowshelf" => Some(BandKind::LowShelf),
            "peak" => Some(BandKind::Peak),
            "highshelf" => Some(BandKind::HighShelf),
            "highcut" => Some(BandKind::HighCut),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            BandKind::LowCut => "lowcut",
            BandKind::LowShelf => "lowshelf",
            BandKind::Peak => "peak",
            BandKind::HighShelf => "highshelf",
            BandKind::HighCut => "highcut",
        }
    }

    /// A cut has no gain: it is either in the signal or not.
    pub fn is_cut(self) -> bool {
        matches!(self, BandKind::LowCut | BandKind::HighCut)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EqBand {
    pub kind: BandKind,
    pub enabled: bool,
    /// Centre (bell), corner (shelf) or cutoff (cut) frequency, Hz.
    pub freq: f32,
    /// Boost or cut, dB. Ignored by the cut filters.
    pub gain_db: f32,
    /// Bandwidth of a bell, steepness of a shelf, resonance of a cut. 0.707 is Butterworth.
    pub q: f32,
}

impl EqBand {
    pub const fn new(kind: BandKind, enabled: bool, freq: f32, gain_db: f32, q: f32) -> Self {
        EqBand { kind, enabled, freq, gain_db, q }
    }

    /// The band with every value pulled into range (a saved song can hold anything).
    pub fn clamped(self) -> Self {
        let finite = |v: f32, fallback: f32| if v.is_finite() { v } else { fallback };
        EqBand {
            kind: self.kind,
            enabled: self.enabled,
            freq: finite(self.freq, 1000.0).clamp(MIN_FREQ, MAX_FREQ),
            gain_db: finite(self.gain_db, 0.0).clamp(-MAX_GAIN_DB, MAX_GAIN_DB),
            q: finite(self.q, 0.707).clamp(MIN_Q, MAX_Q),
        }
    }

    /// Whether this band changes the sound at all.
    pub fn is_active(&self) -> bool {
        self.enabled && (self.kind.is_cut() || self.gain_db.abs() > 1.0e-3)
    }
}

/// The default layout: cuts off, shelves and bells flat. Also what `EqParams::default` holds.
pub const DEFAULT_BANDS: [EqBand; EQ_BANDS] = [
    EqBand::new(BandKind::LowCut, false, 30.0, 0.0, 0.707),
    EqBand::new(BandKind::LowShelf, true, 120.0, 0.0, 0.707),
    EqBand::new(BandKind::Peak, true, 420.0, 0.0, 1.0),
    EqBand::new(BandKind::Peak, true, 2400.0, 0.0, 1.0),
    EqBand::new(BandKind::HighShelf, true, 8000.0, 0.0, 0.707),
    EqBand::new(BandKind::HighCut, false, 18_000.0, 0.0, 0.707),
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EqParams {
    pub bands: [EqBand; EQ_BANDS],
    /// Output trim after the bands, dB.
    pub output_db: f32,
}

impl Default for EqParams {
    fn default() -> Self {
        EqParams { bands: DEFAULT_BANDS, output_db: 0.0 }
    }
}

impl EqParams {
    pub fn clamped(mut self) -> Self {
        for b in self.bands.iter_mut() {
            *b = b.clamped();
        }
        self.output_db = if self.output_db.is_finite() { self.output_db.clamp(-MAX_GAIN_DB, MAX_GAIN_DB) } else { 0.0 };
        self
    }

    /// True when the EQ leaves the signal exactly as it is.
    pub fn is_flat(&self) -> bool {
        self.output_db.abs() <= 1.0e-3 && !self.bands.iter().any(|b| b.is_active())
    }
}

/// Normalised biquad coefficients (a0 = 1).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coefs {
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
}

impl Coefs {
    pub const IDENTITY: Coefs = Coefs { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 };

    /// The RBJ cookbook filter for a band. `gain_db` is ignored by the cuts.
    pub fn for_band(kind: BandKind, freq: f32, gain_db: f32, q: f32, sr: f32) -> Coefs {
        // Keep the corner a little below Nyquist so a high cut at 20 kHz is still a filter at 44.1k.
        let f = freq.clamp(1.0, sr * 0.49);
        let w0 = 2.0 * PI * f / sr;
        let (sn, cs) = w0.sin_cos();
        let q = q.clamp(MIN_Q, MAX_Q);
        let alpha = sn / (2.0 * q);
        let a = 10f32.powf(gain_db / 40.0);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            BandKind::LowCut => ((1.0 + cs) / 2.0, -(1.0 + cs), (1.0 + cs) / 2.0, 1.0 + alpha, -2.0 * cs, 1.0 - alpha),
            BandKind::HighCut => ((1.0 - cs) / 2.0, 1.0 - cs, (1.0 - cs) / 2.0, 1.0 + alpha, -2.0 * cs, 1.0 - alpha),
            BandKind::Peak => (1.0 + alpha * a, -2.0 * cs, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cs, 1.0 - alpha / a),
            BandKind::LowShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cs + s),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cs),
                    a * ((a + 1.0) - (a - 1.0) * cs - s),
                    (a + 1.0) + (a - 1.0) * cs + s,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cs),
                    (a + 1.0) + (a - 1.0) * cs - s,
                )
            }
            BandKind::HighShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cs + s),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cs),
                    a * ((a + 1.0) + (a - 1.0) * cs - s),
                    (a + 1.0) - (a - 1.0) * cs + s,
                    2.0 * ((a - 1.0) - (a + 1.0) * cs),
                    (a + 1.0) - (a - 1.0) * cs - s,
                )
            }
        };
        Coefs { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    /// Gain at `freq`, dB: |H(e^jw)| evaluated directly.
    pub fn magnitude_db(&self, freq: f32, sr: f32) -> f32 {
        let w = 2.0 * PI * (freq / sr).clamp(0.0, 0.5);
        let (s1, c1) = w.sin_cos();
        let (s2, c2) = (2.0 * w).sin_cos();
        let (nr, ni) = (self.b0 + self.b1 * c1 + self.b2 * c2, -(self.b1 * s1 + self.b2 * s2));
        let (dr, di) = (1.0 + self.a1 * c1 + self.a2 * c2, -(self.a1 * s1 + self.a2 * s2));
        let num = nr * nr + ni * ni;
        let den = (dr * dr + di * di).max(1.0e-20);
        10.0 * (num / den).max(1.0e-20).log10()
    }
}

/// One band's contribution at `freq`, dB (0 for a band that is off).
pub fn band_response_db(band: &EqBand, freq: f32, sr: f32) -> f32 {
    if !band.is_active() {
        return 0.0;
    }
    let b = band.clamped();
    Coefs::for_band(b.kind, b.freq, b.gain_db, b.q, sr).magnitude_db(freq, sr)
}

/// The whole EQ's gain at `freq`, dB: every band plus the output trim.
pub fn response_db(params: &EqParams, freq: f32, sr: f32) -> f32 {
    params.bands.iter().map(|b| band_response_db(b, freq, sr)).sum::<f32>() + params.output_db
}

/// A band as it is being played right now, part way along its glide to the target.
#[derive(Clone, Copy, Debug)]
struct Live {
    ln_freq: f32,
    gain_db: f32,
    ln_q: f32,
    /// A cut's presence, 0 (bypassed) to 1. Bells and shelves glide their gain to 0 instead.
    amount: f32,
}

impl Live {
    fn target(b: &EqBand) -> Live {
        let b = b.clamped();
        let on = b.enabled as u8 as f32;
        Live {
            ln_freq: b.freq.ln(),
            gain_db: if b.kind.is_cut() { 0.0 } else { b.gain_db * on },
            ln_q: b.q.ln(),
            amount: if b.kind.is_cut() { on } else { 1.0 },
        }
    }

    /// Moves toward `t` by `k` (0..1); true when it is (close enough to) there.
    fn approach(&mut self, t: &Live, k: f32) -> bool {
        let step = |v: &mut f32, to: f32, eps: f32| {
            let d = to - *v;
            if d.abs() <= eps {
                *v = to;
                true
            } else {
                *v += d * k;
                false
            }
        };
        let a = step(&mut self.ln_freq, t.ln_freq, 1.0e-4);
        let b = step(&mut self.gain_db, t.gain_db, 1.0e-3);
        let c = step(&mut self.ln_q, t.ln_q, 1.0e-4);
        let d = step(&mut self.amount, t.amount, 1.0e-4);
        a && b && c && d
    }
}

pub struct Eq {
    sr: f32,
    target: EqParams,
    kinds: [BandKind; EQ_BANDS],
    live: [Live; EQ_BANDS],
    goal: [Live; EQ_BANDS],
    coefs: [Coefs; EQ_BANDS],
    /// Transposed direct form II state: [band][channel] = (z1, z2).
    z: [[[f32; 2]; 2]; EQ_BANDS],
    out_gain: f32,
    out_goal: f32,
    /// Frames until the next glide step.
    countdown: u32,
    gliding: bool,
    /// Whether the last frame went through the filters (so their state is warm).
    running: bool,
}

impl Eq {
    pub fn new(params: EqParams, sample_rate: f32) -> Self {
        let p = params.clamped();
        let goal: [Live; EQ_BANDS] = std::array::from_fn(|i| Live::target(&p.bands[i]));
        let kinds = std::array::from_fn(|i| p.bands[i].kind);
        let mut eq = Eq {
            sr: sample_rate,
            target: p,
            kinds,
            live: goal,
            goal,
            coefs: [Coefs::IDENTITY; EQ_BANDS],
            z: [[[0.0; 2]; 2]; EQ_BANDS],
            out_gain: db_to_gain(p.output_db),
            out_goal: db_to_gain(p.output_db),
            countdown: 0,
            gliding: false,
            running: false,
        };
        eq.recompute();
        eq
    }

    pub fn params(&self) -> &EqParams {
        &self.target
    }

    /// New settings. They are reached along the glide, not jumped to - except a band whose kind
    /// changed, which is rebuilt at once (its old state means nothing to the new filter).
    pub fn set(&mut self, params: EqParams) {
        let p = params.clamped();
        for i in 0..EQ_BANDS {
            self.goal[i] = Live::target(&p.bands[i]);
            if p.bands[i].kind != self.kinds[i] {
                self.kinds[i] = p.bands[i].kind;
                self.live[i] = self.goal[i];
                self.z[i] = [[0.0; 2]; 2];
            }
        }
        self.out_goal = db_to_gain(p.output_db);
        self.target = p;
        self.gliding = true;
        self.countdown = 0;
    }

    fn recompute(&mut self) {
        for i in 0..EQ_BANDS {
            let l = &self.live[i];
            self.coefs[i] = Coefs::for_band(self.kinds[i], l.ln_freq.exp(), l.gain_db, l.ln_q.exp(), self.sr);
        }
    }

    /// Whether the EQ, as it is sounding right now, changes anything.
    fn audible(&self) -> bool {
        if (self.out_gain - 1.0).abs() > 1.0e-6 {
            return true;
        }
        (0..EQ_BANDS).any(|i| if self.kinds[i].is_cut() { self.live[i].amount > 1.0e-4 } else { self.live[i].gain_db.abs() > 1.0e-3 })
    }

    pub fn process(&mut self, x: [f32; 2]) -> [f32; 2] {
        if self.gliding {
            if self.countdown == 0 {
                self.countdown = BLOCK;
                let k = 1.0 - (-(BLOCK as f32) / (GLIDE_SECONDS * self.sr)).exp();
                let mut done = true;
                for i in 0..EQ_BANDS {
                    let goal = self.goal[i];
                    done &= self.live[i].approach(&goal, k);
                }
                let d = self.out_goal - self.out_gain;
                if d.abs() < 1.0e-5 {
                    self.out_gain = self.out_goal;
                } else {
                    self.out_gain += d * k;
                    done = false;
                }
                self.recompute();
                self.gliding = !done;
            }
            self.countdown -= 1;
        }
        if !self.audible() {
            self.running = false;
            return x;
        }
        if !self.running {
            // Coming out of bypass: the filters start from silence rather than from stale state.
            self.z = [[[0.0; 2]; 2]; EQ_BANDS];
            self.running = true;
        }
        let mut y = x;
        for i in 0..EQ_BANDS {
            let cut = self.kinds[i].is_cut();
            let amount = self.live[i].amount;
            if cut && amount <= 1.0e-4 {
                continue;
            }
            if !cut && self.live[i].gain_db.abs() <= 1.0e-3 {
                continue;
            }
            let c = self.coefs[i];
            for ch in 0..2 {
                let input = y[ch];
                let z = &mut self.z[i][ch];
                let out = c.b0 * input + z[0];
                z[0] = c.b1 * input - c.a1 * out + z[1];
                z[1] = c.b2 * input - c.a2 * out;
                // Flush denormals: a long quiet tail through a resonant low band would otherwise
                // crawl through subnormal floats.
                if z[0].abs() < 1.0e-25 {
                    z[0] = 0.0;
                }
                if z[1].abs() < 1.0e-25 {
                    z[1] = 0.0;
                }
                y[ch] = if cut && amount < 1.0 { input + (out - input) * amount } else { out };
            }
        }
        [y[0] * self.out_gain, y[1] * self.out_gain]
    }
}

fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    fn sine_gain_db(eq: &mut Eq, freq: f32) -> f32 {
        let n = SR as usize;
        let mut in_e = 0.0f64;
        let mut out_e = 0.0f64;
        for i in 0..n {
            let v = 0.25 * (2.0 * PI * freq * i as f32 / SR).sin();
            let y = eq.process([v, v]);
            if i > n / 2 {
                in_e += (v as f64).powi(2);
                out_e += (y[0] as f64).powi(2);
            }
        }
        10.0 * (out_e / in_e).log10() as f32
    }

    fn with(bands: &[(usize, EqBand)]) -> EqParams {
        let mut p = EqParams::default();
        for (i, b) in bands {
            p.bands[*i] = *b;
        }
        p
    }

    #[test]
    fn an_untouched_eq_is_an_exact_bypass() {
        let mut eq = Eq::new(EqParams::default(), SR);
        assert!(EqParams::default().is_flat());
        for i in 0..4800 {
            let v = (i as f32 * 0.013).sin() * 0.7;
            assert_eq!(eq.process([v, -v]), [v, -v]);
        }
    }

    #[test]
    fn a_bell_boosts_its_centre_by_its_gain_and_leaves_distant_frequencies_alone() {
        let p = with(&[(2, EqBand::new(BandKind::Peak, true, 1000.0, 6.0, 1.0))]);
        let mut eq = Eq::new(p, SR);
        let at_centre = sine_gain_db(&mut eq, 1000.0);
        assert!((at_centre - 6.0).abs() < 0.2, "centre gain {at_centre}");
        let mut eq = Eq::new(p, SR);
        let far = sine_gain_db(&mut eq, 60.0);
        assert!(far.abs() < 0.3, "60 Hz moved by {far}");
    }

    #[test]
    fn the_drawn_response_matches_what_is_heard() {
        let p = with(&[
            (0, EqBand::new(BandKind::LowCut, true, 80.0, 0.0, 0.707)),
            (1, EqBand::new(BandKind::LowShelf, true, 200.0, -4.0, 0.707)),
            (3, EqBand::new(BandKind::Peak, true, 3000.0, 5.0, 2.0)),
            (4, EqBand::new(BandKind::HighShelf, true, 9000.0, 3.0, 0.707)),
        ]);
        for f in [40.0, 150.0, 700.0, 3000.0, 12_000.0] {
            let mut eq = Eq::new(p, SR);
            let heard = sine_gain_db(&mut eq, f);
            let drawn = response_db(&p, f, SR);
            assert!((heard - drawn).abs() < 0.3, "{f} Hz: heard {heard:.2} dB, drawn {drawn:.2} dB");
        }
    }

    #[test]
    fn the_cuts_remove_what_they_should() {
        let p = with(&[(0, EqBand::new(BandKind::LowCut, true, 200.0, 0.0, 0.707)), (5, EqBand::new(BandKind::HighCut, true, 2000.0, 0.0, 0.707))]);
        assert!(response_db(&p, 30.0, SR) < -25.0);
        assert!(response_db(&p, 15_000.0, SR) < -25.0);
        assert!(response_db(&p, 630.0, SR).abs() < 1.0);
        // A cut ignores its gain field.
        let mut q = p;
        q.bands[0].gain_db = 12.0;
        assert_eq!(response_db(&q, 30.0, SR), response_db(&p, 30.0, SR));
    }

    #[test]
    fn a_jump_in_settings_glides_instead_of_clicking() {
        let mut eq = Eq::new(with(&[(2, EqBand::new(BandKind::Peak, true, 200.0, 12.0, 1.0))]), SR);
        let v = |i: usize| 0.3 * (2.0 * PI * 1000.0 * i as f32 / SR).sin();
        let mut last = 0.0f32;
        let mut worst = 0.0f32;
        for i in 0..SR as usize {
            if i == 12_000 {
                eq.set(with(&[(2, EqBand::new(BandKind::Peak, true, 1000.0, -12.0, 4.0))]));
            }
            let y = eq.process([v(i), v(i)])[0];
            if i > 100 {
                worst = worst.max((y - last).abs());
            }
            last = y;
        }
        // A 1 kHz sine at 0.3 moves at most ~0.04 per sample at 48k; a hard switch would jump far more.
        assert!(worst < 0.12, "largest step {worst}");
        // And it got there.
        let mut settled = Eq::new(with(&[(2, EqBand::new(BandKind::Peak, true, 1000.0, -12.0, 4.0))]), SR);
        assert!((sine_gain_db(&mut eq, 1000.0) - sine_gain_db(&mut settled, 1000.0)).abs() < 0.1);
    }

    #[test]
    fn switching_a_band_off_returns_to_an_exact_bypass() {
        let mut eq = Eq::new(with(&[(0, EqBand::new(BandKind::LowCut, true, 400.0, 0.0, 0.707))]), SR);
        for i in 0..2000 {
            eq.process([(i as f32 * 0.02).sin(), 0.0]);
        }
        eq.set(EqParams::default());
        for i in 0..SR as usize / 4 {
            eq.process([(i as f32 * 0.02).sin(), 0.0]);
        }
        let x = [0.123, -0.456];
        assert_eq!(eq.process(x), x);
    }

    #[test]
    fn saved_nonsense_is_pulled_into_range() {
        let b = EqBand::new(BandKind::Peak, true, f32::NAN, 99.0, -1.0).clamped();
        assert_eq!(b.freq, 1000.0);
        assert_eq!(b.gain_db, MAX_GAIN_DB);
        assert_eq!(b.q, MIN_Q);
        for k in ["lowcut", "lowshelf", "peak", "highshelf", "highcut"] {
            assert_eq!(BandKind::parse(k).unwrap().name(), k);
        }
    }
}

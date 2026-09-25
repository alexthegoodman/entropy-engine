//! The air column at audio rate: a digital waveguide built from a [`BoreProfile`].
//!
//! * The **front** (mouthpiece and leadpipe) and the **bell** are chains of short cells, each one
//!   sample of travel long (c / sample rate, about 3.9 mm at the model's 88.2 kHz), each with the
//!   cross-section of the bore it stands for (averaged, so it holds the same air). Where neighbouring
//!   cells differ in area, pressure waves partly reflect (Kelly-Lochbaum scattering): that is how the
//!   mouthpiece's cup and throat and the bell's flare shape the resonances. A cell chain is passive
//!   by construction, so no choice of profile can make it unstable.
//! * The **cylinder** between them is a pair of fractional delay lines (one each way) whose length
//!   is the slide's, so the slide can move smoothly while a note sounds. The wall losses of the whole
//!   bore are one lumped filter per direction, fitted to the boundary-layer attenuation (which
//!   grows as `sqrt(f) / r`): the cells count as the length of cylinder that loses as much as they
//!   do, so the narrow throat counts double and the wide bell hardly at all.
//! * The same boundary layer also slows sound a little (by 1-2% in these tubes, more at low
//!   frequencies, as `1 / sqrt(f)`), which flattens the resonances. The model adds that extra travel
//!   time as it is at the pitch being played (the player sets it with each note), so the sounding
//!   resonance sits where the reference puts it. A first-order allpass can't carry the slope at
//!   this sample rate - any stage that bends the delay near 100-1000 Hz swings it by hundreds of
//!   samples, where the boundary layer moves it by about nine - so resonances well above the
//!   played one come out slightly flat of the reference (about 15 cents eight partials up; see
//!   `docs/PHYS_MOD_BRASS.md`).
//! * At high levels, the wave going down the cylinder toward the bell steepens: pressure crests
//!   travel faster than troughs (`c ~ c0 (1 + beta p / rho c0^2)`, beta = 1.2 for air). The forward
//!   line is split into a few segments, each reading its own output at a delay shortened by the
//!   pressure it carries - the generalized-Burgers treatment of brass "brassiness". At *pp* this is
//!   nothing; at *fff* in a long cylinder it pushes the wavefront toward a shock, and the radiated
//!   spectrum fills with high harmonics. The weak wave returning from the bell is left linear.
//! * The **mouth** is loaded by the same lumped radiation impedance as the reference model: the
//!   reflection it sends back is a one-pole lowpass (lows return, highs leave), discretized by the
//!   bilinear transform. What leaves is the radiated sound. Below the bell's cutoff (`ka < 1`) the
//!   mouth radiates like a small source, its pressure following the rate of change of the flow out
//!   of it; above, the radiated power per unit flow stops growing (the bell beams its highs forward
//!   instead). The output is that radiated power's pressure - what a listener in a room hears - so
//!   it rises as `f` up to the cutoff and levels off above.
//!
//! Waves are pressure waves in pascals and flows in m³/s throughout, so the lips (in `lips`) see a
//! physically scaled mouthpiece.

use super::bore::BoreProfile;
use super::impedance::{attenuation, propagation, zc, C, END_CORRECTION, RHO};
use crate::audio::physmod::dsp::{Delay, OnePole};

/// Most the nonlinear delay may change per sample (see `step`).
const MAX_DELAY_SLEW: f32 = 0.5;
/// Nonlinearity coefficient of air, (gamma + 1) / 2.
pub const BETA_AIR: f32 = 1.2;
/// Forward cylinder segments for the nonlinear propagation.
const SEGMENTS: usize = 4;
/// Frequencies at which the cylinder's loss filter matches the boundary-layer attenuation.
const LOSS_FIT_HZ: (f64, f64) = (150.0, 1500.0);

/// A chain of one-sample cells.
struct Cells {
    /// Characteristic impedance per cell.
    z: Vec<f32>,
    /// Reflection coefficient at the junction on each cell's right (`k[i]` between cell `i` and
    /// `i + 1`; the last one is set by whatever the chain joins on its right).
    k: Vec<f32>,
    /// Right-going wave emitted at each cell's left end last sample (arriving at its right end now).
    r: Vec<f32>,
    /// Left-going wave emitted at each cell's right end last sample (arriving at its left end now).
    l: Vec<f32>,
    /// The next sample's waves (double-buffered, so every junction scatters independently and the
    /// loop vectorizes).
    r_next: Vec<f32>,
    l_next: Vec<f32>,
}

impl Cells {
    fn build(areas: &[f32]) -> Self {
        let n = areas.len();
        let z: Vec<f32> = areas.iter().map(|a| (RHO * C) as f32 / a).collect();
        let mut k = vec![0.0; n];
        for i in 0..n.saturating_sub(1) {
            k[i] = (z[i + 1] - z[i]) / (z[i + 1] + z[i]);
        }
        Self { z, k, r: vec![0.0; n], l: vec![0.0; n], r_next: vec![0.0; n], l_next: vec![0.0; n] }
    }

    fn len(&self) -> usize {
        self.z.len()
    }

    fn clear(&mut self) {
        for v in [&mut self.r, &mut self.l, &mut self.r_next, &mut self.l_next] {
            v.iter_mut().for_each(|x| *x = 0.0);
        }
    }

    /// The left-going wave arriving at the chain's left end now.
    #[inline]
    fn left_out(&self) -> f32 {
        self.l[0]
    }

    /// The right-going wave arriving at the chain's right end now.
    #[inline]
    fn right_out(&self) -> f32 {
        self.r[self.len() - 1]
    }

    /// Advances one sample: `left_in` enters at the left end, `right_in` at the right end. Reads
    /// the arriving waves (`left_out`, `right_out`) *before* calling this.
    #[inline]
    fn step(&mut self, left_in: f32, right_in: f32) {
        let n = self.len();
        {
            // Junction j scatters r[j] (from the left) against l[j + 1] (from the right).
            let (r_in, l_in) = (&self.r[..n - 1], &self.l[1..]);
            let (r_out, l_out) = (&mut self.r_next[1..], &mut self.l_next[..n - 1]);
            for ((((&k, &a), &b), ro), lo) in self.k[..n - 1].iter().zip(r_in).zip(l_in).zip(r_out.iter_mut()).zip(l_out.iter_mut()) {
                let w = k * (a - b);
                *ro = a + w;
                *lo = b + w;
            }
        }
        self.r_next[0] = left_in;
        self.l_next[n - 1] = right_in;
        std::mem::swap(&mut self.r, &mut self.r_next);
        std::mem::swap(&mut self.l, &mut self.l_next);
    }

    /// Acoustic pressure at each cell (the sum of the two travelling waves), for the view.
    fn pressure(&self, i: usize) -> f32 {
        self.r[i] + self.l[i]
    }
}

/// Scattering between two impedances: `(z_right - z_left) / (z_right + z_left)`.
fn reflection(z_left: f32, z_right: f32) -> f32 {
    (z_right - z_left) / (z_right + z_left)
}

/// Wall loss as a symmetric three-tap filter `g (b, 1 - 2b, b)`: linear phase (exactly one sample
/// of delay at every frequency), so it attenuates without adding dispersion of its own - the
/// dispersion is modelled separately and physically, below.
#[derive(Clone, Copy, Default)]
struct Loss {
    g: f32,
    b: f32,
}

impl Loss {
    /// Fits the filter to the attenuation of `length` metres of tube of radius `r` at the two
    /// `LOSS_FIT_HZ` frequencies (closed form: `|H(w)| = g (1 - 2b (1 - cos w))`).
    fn fit(r: f32, length: f32, sr: f32) -> Self {
        let (f1, f2) = LOSS_FIT_HZ;
        let t1 = (-attenuation(f1, r as f64) * length as f64).exp();
        let t2 = (-attenuation(f2, r as f64) * length as f64).exp();
        let q1 = 1.0 - (std::f64::consts::TAU * f1 / sr as f64).cos();
        let q2 = 1.0 - (std::f64::consts::TAU * f2 / sr as f64).cos();
        // t1 / t2 = (1 - 2b q1) / (1 - 2b q2)  =>  b = (t1 - t2) / (2 (t1 q2 - t2 q1))
        let b = ((t1 - t2) / (2.0 * (t1 * q2 - t2 * q1))).clamp(0.0, 0.25);
        let g = t1 / (1.0 - 2.0 * b * q1);
        Self { g: g as f32, b: b as f32 }
    }

    /// Phase delay, samples (the same at every frequency).
    fn phase_delay(&self, _w: f32) -> f32 {
        1.0
    }
}

/// Running state of a [`Loss`] filter.
#[derive(Clone, Copy, Default)]
struct LossState {
    x1: f32,
    x2: f32,
}

impl LossState {
    #[inline]
    fn process(&mut self, x: f32, l: Loss) -> f32 {
        let y = l.g * (l.b * (x + self.x2) + (1.0 - 2.0 * l.b) * self.x1);
        self.x2 = self.x1;
        self.x1 = x;
        y
    }
}

/// Extra one-way travel time (samples) the boundary layer adds over the whole bore at `f` Hz, for
/// `cells` (radius per one-sample cell) plus a cylinder of `length` metres and radius `r`.
fn excess_delay(f: f64, cells: &[f32], r: f32, length: f32, sr: f32) -> f64 {
    let k = std::f64::consts::TAU * f / C;
    let dx = C / sr as f64;
    // The slowing is Im(Gamma) / k - 1 per metre of travel.
    let slow = |radius: f32| propagation(f, radius as f64).im / k - 1.0;
    let cells: f64 = cells.iter().map(|&rc| slow(rc)).sum();
    cells + slow(r) * length as f64 / dx
}

/// Everything the audio thread needs, built from a profile off the audio thread.
pub struct AirBore {
    sr: f32,
    profile: BoreProfile,
    front: Cells,
    bell: Cells,
    /// Forward cylinder segments (toward the bell) and the single backward line.
    fwd: [Delay; SEGMENTS],
    bwd: Delay,
    fwd_loss: Loss,
    bwd_loss: Loss,
    fwd_lp: LossState,
    bwd_lp: LossState,
    /// The pitch the boundary-layer slowing is evaluated at, Hz, and that slowing (samples).
    tuning_hz: f32,
    slowing: f32,
    /// Radius of every cell, front then bell, for the slowing.
    cell_radii: Vec<f32>,
    /// Reflection coefficients where the front meets the cylinder and the cylinder meets the bell.
    k_front: f32,
    k_bell: f32,
    /// Cylinder length the cells don't account for (front/bell rounding), metres.
    residual: f32,
    /// Current slide extension, metres, and the one-way cylinder delay it gives, samples.
    extra: f32,
    delay: f32,
    /// Nonlinear propagation scale: 1 is air.
    pub nonlinearity: f32,
    /// Radiation: `y = (-(x + x1) - (1 - K) y1) / (1 + K)`.
    rad_k: f32,
    rad_x1: f32,
    rad_y1: f32,
    mouth_z: f32,
    last_flow: f32,
    /// The radiated far-field pressure at 1 m, Pa.
    pub radiated: f32,
    /// Mouthpiece pressure, Pa (set by the caller each sample, for the view and analysis).
    pub mouthpiece_pressure: f32,
    /// The radiated pressure's levelling-off above the bell cutoff (one-pole state and coefficient).
    rad_lp: OnePole,
    rad_lp_a: f32,
    /// Last read delay per forward segment (the nonlinear delay's slew is limited).
    seg_delay: [f32; SEGMENTS],
    /// Largest forward-wave slope seen at the bell end since last read, Pa per second.
    peak_slope: f32,
    last_fwd_out: f32,
}

impl AirBore {
    /// Longest cylinder (slide fully out) the delay lines are sized for, plus room.
    pub fn new(profile: &BoreProfile, sr: f32) -> Self {
        let dx = C as f32 / sr;
        // Front: cells laid from the lips.
        let lf = profile.front_length();
        let nf = ((lf / dx).round() as usize).max(1);
        let (mut fa, mut fr) = (Vec::with_capacity(nf), Vec::with_capacity(nf));
        for i in 0..nf {
            let (x0, x1) = (i as f32 * dx, (i + 1) as f32 * dx);
            let a = if x0 >= lf { std::f32::consts::PI * profile.cylinder_radius.powi(2) } else { profile.mean_area(x0, x1.min(lf), 0.0) };
            fa.push(a);
            fr.push((a / std::f32::consts::PI).sqrt());
        }
        // Bell: cells laid back from the mouth, so the mouth falls on a cell boundary.
        let lb = profile.bell_length();
        let nb = ((lb / dx).round() as usize).max(1);
        let start = lf + profile.cylinder_length;
        let end = start + lb;
        let (mut ba, mut br) = (vec![0.0; nb], vec![0.0; nb]);
        for i in 0..nb {
            let (x1, x0) = (end - (nb - 1 - i) as f32 * dx, end - (nb - i) as f32 * dx);
            let a = if x1 <= start { std::f32::consts::PI * profile.cylinder_radius.powi(2) } else { profile.mean_area(x0.max(start), x1, 0.0) };
            ba[i] = a;
            br[i] = (a / std::f32::consts::PI).sqrt();
        }
        let cell_radii: Vec<f32> = fr.iter().chain(br.iter()).copied().collect();
        let front = Cells::build(&fa);
        let bell = Cells::build(&ba);
        let zcyl = zc(profile.cylinder_radius as f64) as f32;
        let k_front = reflection(*front.z.last().unwrap(), zcyl);
        let k_bell = reflection(zcyl, bell.z[0]);
        let residual = (lf - nf as f32 * dx) + (lb - nb as f32 * dx);
        let max_len = profile.cylinder_length + profile.slide_max + residual.max(0.0) + 0.1;
        let cap = (max_len / dx) as usize + 16;
        let a = profile.mouth_radius();
        let tau = 2.0 * END_CORRECTION as f32 * a / C as f32;
        let mut s = Self {
            sr,
            profile: profile.clone(),
            front,
            bell,
            fwd: std::array::from_fn(|_| Delay::new(cap / SEGMENTS + 16)),
            bwd: Delay::new(cap),
            fwd_loss: Loss::default(),
            bwd_loss: Loss::default(),
            fwd_lp: LossState::default(),
            bwd_lp: LossState::default(),
            tuning_hz: 0.0,
            slowing: 0.0,
            cell_radii,
            k_front,
            k_bell,
            residual,
            extra: -1.0,
            delay: 0.0,
            nonlinearity: 1.0,
            rad_k: 2.0 * sr * tau,
            rad_x1: 0.0,
            rad_y1: 0.0,
            mouth_z: (RHO * C) as f32 / ba[nb - 1].max(1.0e-9),
            last_flow: 0.0,
            radiated: 0.0,
            mouthpiece_pressure: 0.0,
            peak_slope: 0.0,
            last_fwd_out: 0.0,
            rad_lp: OnePole::default(),
            rad_lp_a: OnePole::coef_for(C as f32 / (std::f32::consts::TAU * a), sr),
            seg_delay: [0.0; SEGMENTS],
        };
        s.set_tuning(profile.nominal_fundamental * 4.0);
        s
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    pub fn profile(&self) -> &BoreProfile {
        &self.profile
    }

    /// Characteristic impedance at the lips (the cup's entrance).
    pub fn z_in(&self) -> f32 {
        self.front.z[0]
    }

    /// Sets the slide extension (metres of extra cylinder). Cheap enough for control rate; the
    /// loss filters are refitted only when the length has moved by a millimetre or more.
    pub fn set_extra(&mut self, extra: f32) {
        let extra = extra.clamp(0.0, self.profile.slide_max);
        let dx = C as f32 / self.sr;
        let len = (self.profile.cylinder_length + extra + self.residual).max(4.0 * dx);
        if (extra - self.extra).abs() >= 0.001 {
            let rc = self.profile.cylinder_radius;
            let cells: f32 = self.cell_radii.iter().map(|&r| dx * rc / r).sum();
            self.fwd_loss = Loss::fit(rc, len + cells, self.sr);
            self.bwd_loss = self.fwd_loss;
            self.slowing = excess_delay(self.tuning_hz as f64, &self.cell_radii, self.profile.cylinder_radius, len, self.sr) as f32;
        }
        self.extra = extra;
        // The loss filter's own (constant) delay is part of the travel time.
        let w = std::f32::consts::TAU * self.tuning_hz / self.sr;
        self.delay = (len / dx + self.slowing - self.fwd_loss.phase_delay(w)).max(SEGMENTS as f32 * 2.0);
    }

    /// Sets the pitch the boundary layer's slowing is evaluated at: the note being played.
    pub fn set_tuning(&mut self, hz: f32) {
        self.tuning_hz = hz.clamp(20.0, 4000.0);
        let extra = self.extra.max(0.0);
        self.extra = -1.0;
        self.set_extra(extra);
    }

    pub fn extra(&self) -> f32 {
        self.extra
    }

    pub fn clear(&mut self) {
        self.front.clear();
        self.bell.clear();
        self.fwd.iter_mut().for_each(|d| d.clear());
        self.bwd.clear();
        self.fwd_lp = LossState::default();
        self.bwd_lp = LossState::default();
        self.rad_x1 = 0.0;
        self.rad_y1 = 0.0;
        self.last_flow = 0.0;
        self.radiated = 0.0;
        self.peak_slope = 0.0;
        self.last_fwd_out = 0.0;
        self.rad_lp = OnePole::default();
        self.seg_delay = [0.0; SEGMENTS];
    }

    /// The wave arriving back at the lips now. The lips combine it with their flow to give the
    /// mouthpiece pressure (`2 * incoming + z_in * flow`) and the wave they send in
    /// (`incoming + z_in * flow`), which goes to [`AirBore::step`].
    #[inline]
    pub fn incoming(&self) -> f32 {
        self.front.left_out()
    }

    /// Advances the air column one sample with `inject` entering at the lips.
    #[inline]
    pub fn step(&mut self, inject: f32) {
        // Front <-> cylinder junction.
        let from_front = self.front.right_out();
        let from_cyl = self.bwd_lp.process(self.bwd.read(self.delay), self.bwd_loss);
        let w = self.k_front * (from_front - from_cyl);
        let into_cyl = from_front + w;
        let back_to_front = from_cyl + w;

        // Forward cylinder, segment by segment, with pressure-dependent speed.
        let seg = self.delay / SEGMENTS as f32;
        let eps = self.nonlinearity * BETA_AIR / (RHO * C * C) as f32;
        let mut x = into_cyl;
        for (d, last) in self.fwd.iter_mut().zip(self.seg_delay.iter_mut()) {
            let nominal = d.read(seg);
            let y = if eps > 0.0 {
                // The crest arrives early, the trough late. The read point may not move by more
                // than half a sample per sample: where the wave would overtake itself (a shock),
                // the front is held at the steepest a sampled wave can carry, band-limited
                // instead of folding over.
                let want = seg * (1.0 - eps * nominal).clamp(0.5, 1.5);
                let dd = (want - *last).clamp(-MAX_DELAY_SLEW, MAX_DELAY_SLEW);
                *last = if *last == 0.0 { want } else { *last + dd };
                d.read(*last)
            } else {
                *last = seg;
                nominal
            };
            d.push(x);
            x = y;
        }
        let at_bell = self.fwd_lp.process(x, self.fwd_loss);
        let slope = (at_bell - self.last_fwd_out).abs() * self.sr;
        self.last_fwd_out = at_bell;
        self.peak_slope = self.peak_slope.max(slope);

        // Cylinder <-> bell junction.
        let from_bell = self.bell.left_out();
        let w = self.k_bell * (at_bell - from_bell);
        let into_bell = at_bell + w;
        let back_to_cyl = from_bell + w;
        self.bwd.push(back_to_cyl);

        // Mouth: radiation reflection and the radiated sound.
        let x = self.bell.right_out();
        let k = self.rad_k;
        let y = (-(x + self.rad_x1) - (1.0 - k) * self.rad_y1) / (1.0 + k);
        self.rad_x1 = x;
        self.rad_y1 = y;
        let flow = (x - y) / self.mouth_z;
        let small_source = RHO as f32 / (4.0 * std::f32::consts::PI) * (flow - self.last_flow) * self.sr;
        self.radiated = self.rad_lp.process(small_source, self.rad_lp_a);
        self.last_flow = flow;

        self.front.step(inject, back_to_front);
        self.bell.step(into_bell, y);
    }

    /// Largest slope of the wave arriving at the bell since the last call, Pa/s: how close the
    /// wavefront has come to a shock.
    pub fn take_peak_slope(&mut self) -> f32 {
        std::mem::take(&mut self.peak_slope)
    }

    /// Cells in the front and bell chains.
    pub fn cell_counts(&self) -> (usize, usize) {
        (self.front.len(), self.bell.len())
    }

    /// Acoustic pressure (Pa) at `out.len()` evenly spaced points from the lips to the mouth: the
    /// two travelling waves summed wherever they are - in the cells, or read back out of the
    /// cylinder's delay lines at the right age.
    pub fn pressure_along(&self, out: &mut [f32]) {
        let n = out.len();
        if n == 0 {
            return;
        }
        let (nf, nb) = (self.front.len() as f32, self.bell.len() as f32);
        let cyl = self.delay.max(1.0);
        let total = nf + cyl + nb;
        let seg = self.delay / SEGMENTS as f32;
        for (j, o) in out.iter_mut().enumerate() {
            let x = total * j as f32 / (n - 1).max(1) as f32;
            *o = if x < nf {
                self.front.pressure((x as usize).min(self.front.len() - 1))
            } else if x < nf + cyl {
                // `d` samples in from the front end: the forward wave pushed `d` samples ago, the
                // backward one pushed at the bell end `cyl - d` samples ago.
                let d = x - nf;
                let k = ((d / seg.max(1.0)) as usize).min(SEGMENTS - 1);
                let fwd = self.fwd[k].tap((d - k as f32 * seg).max(0.0) as usize);
                let bwd = self.bwd.tap((cyl - d).max(0.0) as usize);
                fwd + bwd
            } else {
                self.bell.pressure(((x - nf - cyl) as usize).min(self.bell.len() - 1))
            };
        }
    }

    /// Pressure at front cell `i` (0 = the cup), Pa.
    pub fn front_pressure(&self, i: usize) -> f32 {
        self.front.pressure(i.min(self.front.len() - 1))
    }

    /// Pressure at bell cell `i` (last = the mouth), Pa.
    pub fn bell_pressure(&self, i: usize) -> f32 {
        self.bell.pressure(i.min(self.bell.len() - 1))
    }
}

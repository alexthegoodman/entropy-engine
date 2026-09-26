//! Bubbles: the voice of water.
//!
//! Almost everything water says - a drip's "plink", the babble of a brook, the hiss of surf, the
//! 14 kHz whisper of rain on a lake - is **gas bubbles ringing**. A bubble of radius `R` just after
//! it pinches off is not at rest: its wall moves, and the gas inside is a spring against the water
//! around it, which is the mass. It rings as one mode, the breathing mode, at the **Minnaert
//! frequency** (about 3.26 kHz for a bubble of 1 mm radius, inversely with its size), and radiates
//! as a monopole: a pulsating volume.
//!
//! Nothing about a bubble's note is fitted here. The frequency and the three ways a bubble loses
//! energy come from its radius and depth:
//!
//! * **The gas spring is neither adiabatic nor isothermal.** Heat flows between the gas and the
//!   water during each cycle, which both softens the spring (the effective polytropic exponent lies
//!   between 1 and `gamma`) and damps it. Prosperetti's (1977) solution of heat conduction in the
//!   gas gives both as the real and imaginary parts of one complex function of `D / (omega R^2)`
//!   ([`bubble_mode`]); it is solved together with the frequency it changes.
//! * **Viscosity** of the water at the wall: `2 mu / (rho R^2)`.
//! * **Radiation**: a monopole of radius `R` radiates with `k R` of damping; within a fraction of a
//!   wavelength of the free surface the image source (the surface is a pressure-release plane)
//!   cancels most of it, `1 - sinc(2 k h)`.
//!
//! A bubble near the surface rings higher: the image reduces the water mass it has to move
//! (Strasberg: `f / f_deep = (1 - R / 2h)^(-1/2)` at depth `h` below a free surface). Bubbles rise
//! (from rest, accelerating at about `2 g` - buoyancy against their added mass - to their terminal
//! speed), so a bubble born just under the surface **chirps upward** as it rises: the plink's
//! glide.
//!
//! **What is heard in the air.** Water is incompressible on the scale of a bubble's neighbourhood,
//! so a bubble's changing volume moves the free surface above it by the same volume: to the air,
//! the surface is a small piston in a large baffle with the bubble's volume acceleration, which
//! radiates `p = rho_air V'' / (2 pi r)` at distance `r` - about 400 times weaker than the same
//! bubble heard underwater, which is why water sounds as delicate as it does.
//!
//! **How hard it rings.** A bubble is born by a neck of water closing: its wall starts moving at
//! the capillary speed `sqrt(sigma / (rho R))`, the speed surface tension closes a neck of its own
//! size. With the frequency that sets the whole amplitude (larger bubbles are lower and a little
//! louder: `p ~ R^(1/2)`).
//!
//! [`BubbleBank`] rings many bubbles at once, each gliding in frequency every sample as it rises,
//! and panned where it was born. A bank slot can stand for many real bubbles (surf entrains
//! millions a second): it rings with `sqrt(count)` of one bubble's amplitude, the incoherent sum -
//! the same device as the drums' sampled high band.
//!
//! Nothing here allocates after construction.

use super::membrane::RHO_AIR;
use std::f64::consts::PI;

/// Water at about 20 C, SI units.
pub const RHO_WATER: f32 = 998.0;
pub const C_WATER: f32 = 1482.0;
/// Surface tension of clean water against air, N/m.
pub const SURFACE_TENSION: f32 = 0.0728;
/// Dynamic viscosity, Pa s.
pub const VISCOSITY: f32 = 1.0e-3;
pub const P_ATM: f32 = 101_325.0;
pub const G: f32 = 9.81;
/// Air: ratio of specific heats, and thermal diffusivity at one atmosphere (m^2/s).
pub const GAMMA_AIR: f32 = 1.4;
pub const AIR_DIFFUSIVITY: f32 = 2.12e-5;

/// Bubbles ringing at once in a bank.
pub const MAX_BUBBLES: usize = 384;
/// Samples between updates of each bubble's depth and tuning; the frequency glides linearly in
/// between, every sample.
pub const BUBBLE_BLOCK: usize = 32;
/// Bubbles smaller than this ring above hearing (about 22 kHz) and are not made.
pub const MIN_RADIUS: f32 = 0.15e-3;

// ------------------------------------------------------------------------------------------
// A little complex arithmetic (build time only)
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct C(f64, f64);

impl C {
    fn add(self, o: C) -> C {
        C(self.0 + o.0, self.1 + o.1)
    }
    fn sub(self, o: C) -> C {
        C(self.0 - o.0, self.1 - o.1)
    }
    fn mul(self, o: C) -> C {
        C(self.0 * o.0 - self.1 * o.1, self.0 * o.1 + self.1 * o.0)
    }
    fn div(self, o: C) -> C {
        let d = o.0 * o.0 + o.1 * o.1;
        C((self.0 * o.0 + self.1 * o.1) / d, (self.1 * o.0 - self.0 * o.1) / d)
    }
    fn scale(self, s: f64) -> C {
        C(self.0 * s, self.1 * s)
    }
    fn sqrt(self) -> C {
        let r = (self.0 * self.0 + self.1 * self.1).sqrt();
        let re = (0.5 * (r + self.0)).max(0.0).sqrt();
        let im = (0.5 * (r - self.0)).max(0.0).sqrt();
        C(re, if self.1 < 0.0 { -im } else { im })
    }
    fn exp(self) -> C {
        let e = self.0.exp();
        C(e * self.1.cos(), e * self.1.sin())
    }
    /// `coth(z)` as `(1 + e^-2z) / (1 - e^-2z)`, which stays finite for large `Re z`.
    fn coth(self) -> C {
        let e = self.scale(-2.0).exp();
        C(1.0, 0.0).add(e).div(C(1.0, 0.0).sub(e))
    }
}

// ------------------------------------------------------------------------------------------
// One bubble's physics
// ------------------------------------------------------------------------------------------

/// A bubble's breathing mode.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BubbleMode {
    /// Resonance frequency far from any surface, Hz.
    pub freq: f32,
    /// Amplitude decay rates, 1/s: viscous, thermal, and radiation far from the surface.
    pub viscous: f32,
    pub thermal: f32,
    pub radiation: f32,
    /// Effective polytropic exponent of the gas (1 isothermal, `gamma` adiabatic).
    pub kappa: f32,
}

impl BubbleMode {
    /// Total amplitude decay rate far from the surface, 1/s.
    pub fn sigma(&self) -> f32 {
        self.viscous + self.thermal + self.radiation
    }

    /// Total damping constant `delta = 2 sigma / omega` (the usual measure in the bubble literature).
    pub fn delta(&self) -> f32 {
        2.0 * self.sigma() / (std::f32::consts::TAU * self.freq)
    }

    /// Decay rate at depth `h` (m) under a free surface: the image cancels radiation near it.
    pub fn sigma_at(&self, radius: f32, h: f32) -> f32 {
        self.viscous + self.thermal + self.radiation * image_radiation(self.freq * surface_factor(radius, h), h)
    }
}

/// Prosperetti's complex polytropic function `Phi` for a gas bubble at angular frequency `omega`:
/// `3 kappa = Re Phi`, and the thermal damping is `p_g Im Phi / (2 rho omega R^2)`.
fn prosperetti_phi(omega: f64, radius: f64, p_gas: f64) -> C {
    let gamma = GAMMA_AIR as f64;
    // Thermal diffusivity scales inversely with the gas pressure.
    let d = AIR_DIFFUSIVITY as f64 * P_ATM as f64 / p_gas;
    let chi = d / (omega * radius * radius);
    let root = C(0.0, 1.0 / chi).sqrt();
    let bracket = root.mul(root.coth()).sub(C(1.0, 0.0));
    let den = C(1.0, 0.0).sub(C(0.0, 3.0 * (gamma - 1.0) * chi).mul(bracket));
    C(3.0 * gamma, 0.0).div(den)
}

/// The breathing mode of a bubble of `radius` (m) at `depth` (m) of water under the atmosphere,
/// far from any surface for its tuning (see [`surface_factor`]) but under that depth's pressure.
pub fn bubble_mode(radius: f32, depth: f32) -> BubbleMode {
    let r = radius.max(1.0e-6) as f64;
    let rho = RHO_WATER as f64;
    let sigma_s = SURFACE_TENSION as f64;
    let p0 = P_ATM as f64 + rho * G as f64 * depth.max(0.0) as f64;
    // The gas inside is at the ambient pressure plus the Laplace pressure of its curved wall.
    let p_gas = p0 + 2.0 * sigma_s / r;
    // Minnaert (adiabatic) to start; then the frequency and the heat flow it implies, together.
    let mut omega = ((3.0 * GAMMA_AIR as f64 * p_gas - 2.0 * sigma_s / r) / (rho * r * r)).sqrt();
    let mut phi = C(3.0 * GAMMA_AIR as f64, 0.0);
    for _ in 0..30 {
        phi = prosperetti_phi(omega, r, p_gas);
        let next = ((p_gas * phi.0 - 2.0 * sigma_s / r) / (rho * r * r)).max(1.0).sqrt();
        let done = (next / omega - 1.0).abs() < 1.0e-9;
        omega = next;
        if done {
            break;
        }
    }
    let thermal = p_gas * phi.1.abs() / (2.0 * rho * omega * r * r);
    let viscous = 2.0 * VISCOSITY as f64 / (rho * r * r);
    let radiation = omega * omega * r / (2.0 * C_WATER as f64);
    BubbleMode { freq: (omega / (2.0 * PI)) as f32, viscous: viscous as f32, thermal: thermal as f32, radiation: radiation as f32, kappa: (phi.0 / 3.0) as f32 }
}

/// How much higher a bubble rings at depth `h` (m, to its centre) below a free surface than far
/// from it (Strasberg 1953): the image takes away some of the water it has to move. `h` is taken as at least
/// the bubble's radius (a bubble at the surface).
pub fn surface_factor(radius: f32, h: f32) -> f32 {
    let h = h.max(radius * 1.02);
    (1.0 - radius / (2.0 * h)).max(0.05).powf(-0.5)
}

/// Fraction of a free-field monopole's radiation left at depth `h` under a pressure-release
/// surface: the bubble and its (inverted) image, `1 - sin(2kh) / 2kh`.
pub fn image_radiation(freq: f32, h: f32) -> f32 {
    let x = 2.0 * std::f32::consts::TAU * freq / C_WATER * h.max(0.0);
    if x < 1.0e-3 {
        x * x / 6.0
    } else {
        1.0 - x.sin() / x
    }
}

/// Terminal rise speed of a bubble of `radius` in clean water, m/s: the viscous (Hadamard-Rybczynski,
/// a mobile wall) speed for small bubbles, Mendelson's wave analogy once the bubble is large
/// enough to deform, whichever is slower.
pub fn rise_speed(radius: f32) -> f32 {
    let r = radius.max(1.0e-6);
    let viscous = RHO_WATER * G * r * r / (3.0 * VISCOSITY);
    let d = 2.0 * r;
    let wave = (2.14 * SURFACE_TENSION / (RHO_WATER * d) + 0.505 * G * d).sqrt();
    viscous.min(wave)
}

/// The capillary speed of a bubble's wall at birth, m/s (see the module notes).
pub fn birth_speed(radius: f32) -> f32 {
    (SURFACE_TENSION / (RHO_WATER * radius.max(1.0e-6))).sqrt()
}

/// The radius (m) of a bubble that rings at `freq` Hz near the surface (just under it, at twice
/// its radius): the inverse of the Minnaert relation with the heat flow and the image included.
pub fn radius_for(freq: f32) -> f32 {
    let (mut lo, mut hi) = (MIN_RADIUS * 0.5, 0.05f32);
    let f = |r: f32| bubble_mode(r, 2.0 * r).freq * surface_factor(r, 2.0 * r);
    for _ in 0..60 {
        let mid = (lo * hi).sqrt();
        if f(mid) > freq {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo * hi).sqrt()
}

// ------------------------------------------------------------------------------------------
// Bubbles made by turbulence
// ------------------------------------------------------------------------------------------

/// The Hinze scale, m: turbulence splits bubbles larger than about this, not smaller ones.
pub const HINZE: f32 = 1.0e-3;

fn power_integral(p: f32, a: f32, b: f32) -> f32 {
    // integral of R^p from a to b.
    if (p + 1.0).abs() < 1.0e-6 {
        (b / a).ln()
    } else {
        (b.powf(p + 1.0) - a.powf(p + 1.0)) / (p + 1.0)
    }
}

/// The sizes of bubbles torn from air by turbulence (a breaking wave, a plunging jet), as Deane and
/// Stokes measured them: `R^(-3/2)` below the Hinze scale and `R^(-10/3)` above, from
/// [`MIN_RADIUS`] to `max`. Sampled by the inverse of each power law's distribution.
#[derive(Clone, Copy, Debug)]
pub struct TurbulentSizes {
    max: f32,
    hinze: f32,
    small: f32,
    /// Mean `R^2` and `R^3`, m^2 and m^3.
    pub r2: f32,
    pub r3: f32,
}

impl TurbulentSizes {
    pub fn new(max: f32) -> Self {
        let max = max.max(MIN_RADIUS * 1.5);
        let hinze = HINZE.clamp(MIN_RADIUS * 1.01, max);
        // Continuous at the Hinze scale: N = R^-1.5 below, H^(-1.5 + 10/3) R^(-10/3) above.
        let c = hinze.powf(-1.5 + 10.0 / 3.0);
        let n_small = power_integral(-1.5, MIN_RADIUS, hinze);
        let n_big = if max > hinze { c * power_integral(-10.0 / 3.0, hinze, max) } else { 0.0 };
        let total = n_small + n_big;
        let m = |k: f32| (power_integral(-1.5 + k, MIN_RADIUS, hinze) + if max > hinze { c * power_integral(-10.0 / 3.0 + k, hinze, max) } else { 0.0 }) / total;
        Self { max, hinze, small: n_small / total, r2: m(2.0), r3: m(3.0) }
    }

    /// The share of bubbles below the Hinze scale.
    pub fn below_hinze(&self) -> f32 {
        self.small
    }

    /// Mean volume, m^3.
    pub fn mean_volume(&self) -> f32 {
        4.0 / 3.0 * std::f32::consts::PI * self.r3
    }

    pub fn sample(&self, rng: &mut Rng) -> f32 {
        let u = rng.uniform();
        let inv = |p: f32, a: f32, b: f32, t: f32| {
            let (ea, eb) = (a.powf(p + 1.0), b.powf(p + 1.0));
            (ea + t * (eb - ea)).powf(1.0 / (p + 1.0))
        };
        if u < self.small || self.max <= self.hinze {
            inv(-1.5, MIN_RADIUS, self.hinze, (u / self.small).min(1.0))
        } else {
            inv(-10.0 / 3.0, self.hinze, self.max, (u - self.small) / (1.0 - self.small))
        }
    }
}

// ------------------------------------------------------------------------------------------
// Random numbers (no allocation, deterministic per seed)
// ------------------------------------------------------------------------------------------

/// A small, fast generator (xorshift64*), for births, arrivals and sizes.
#[derive(Clone, Copy, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform in `[0, 1)`.
    pub fn uniform(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }

    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.uniform()
    }

    /// Exponentially distributed with mean `mean` (the waiting time of a Poisson process).
    pub fn exponential(&mut self, mean: f32) -> f32 {
        -mean * (1.0 - self.uniform()).max(1.0e-12).ln()
    }

    /// A standard normal deviate.
    pub fn normal(&mut self) -> f32 {
        let (u, v) = (self.uniform().max(1.0e-12), self.uniform());
        (-2.0 * u.ln()).sqrt() * (std::f32::consts::TAU * v).cos()
    }

    /// A Poisson count with mean `mean` (exact for small means, normal beyond).
    pub fn poisson(&mut self, mean: f32) -> u32 {
        if mean <= 0.0 {
            return 0;
        }
        if mean > 30.0 {
            return (mean + mean.sqrt() * self.normal()).round().max(0.0) as u32;
        }
        let limit = (-mean).exp();
        let (mut k, mut p) = (0u32, 1.0f32);
        loop {
            p *= self.uniform();
            if p <= limit {
                return k;
            }
            k += 1;
        }
    }
}

// ------------------------------------------------------------------------------------------
// Resonators that glide
// ------------------------------------------------------------------------------------------

/// A set of damped oscillators whose frequency and damping may change every sample, run as the
/// exact response to a force held for a sample (as `ModalBody` does), in a structure of arrays. A
/// change is asked for over a number of samples ([`Resonators::glide`]): the rotation is then
/// turned a little every sample, so the frequency moves linearly with no steps, and the state is
/// rescaled so the displacement and velocity stay continuous. Each slot has output weights on its
/// displacement and on the other half of its state (so the output can be the displacement, or the
/// acceleration), which also ramp, and three output gains (left, right, and a third channel for
/// whoever listens - a vessel's air, for bubbles).
pub struct Resonators {
    h: f32,
    len: usize,
    re: Vec<f32>,
    im: Vec<f32>,
    rr: Vec<f32>,
    ri: Vec<f32>,
    tr: Vec<f32>,
    ti: Vec<f32>,
    resc: Vec<f32>,
    wi: Vec<f32>,
    wr: Vec<f32>,
    dwi: Vec<f32>,
    dwr: Vec<f32>,
    kick: Vec<f32>,
    /// Undamped angular frequency and decay rate each slot is at (or gliding to).
    w0: Vec<f32>,
    sigma: Vec<f32>,
    gain: Vec<[f32; 3]>,
    force: Vec<f32>,
    /// Whether the outputs are accelerations (true) or displacements.
    accel: Vec<bool>,
    /// Samples left of each slot's glide (the turn and ramps stop when it ends).
    left: Vec<u32>,
}

fn damped(w0: f32, sigma: f32) -> f32 {
    (w0 * w0 - sigma * sigma).max(1.0e-6).sqrt()
}

impl Resonators {
    pub fn new(capacity: usize, sr: f32) -> Self {
        let z = || vec![0.0f32; capacity];
        Self { h: 1.0 / sr, len: 0, re: z(), im: z(), rr: z(), ri: z(), tr: z(), ti: z(), resc: z(), wi: z(), wr: z(), dwi: z(), dwr: z(), kick: z(), w0: z(), sigma: z(), gain: vec![[0.0; 3]; capacity], force: z(), accel: vec![false; capacity], left: vec![0; capacity] }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn capacity(&self) -> usize {
        self.re.len()
    }

    /// Silences every slot (they keep their tuning).
    pub fn clear(&mut self) {
        self.re.iter_mut().for_each(|v| *v = 0.0);
        self.im.iter_mut().for_each(|v| *v = 0.0);
        self.force.iter_mut().for_each(|v| *v = 0.0);
    }

    /// Displacement of slot `k`.
    pub fn q(&self, k: usize) -> f32 {
        self.im[k]
    }

    /// Squared amplitude of slot `k`, `q^2 + ((q' + sigma q) / omega_d)^2`.
    pub fn amplitude2(&self, k: usize) -> f32 {
        self.re[k] * self.re[k] + self.im[k] * self.im[k]
    }

    pub fn omega(&self, k: usize) -> f32 {
        self.w0[k]
    }

    pub fn sigma(&self, k: usize) -> f32 {
        self.sigma[k]
    }

    /// Adds a slot ringing at `w0` (rad/s) with decay `sigma` (1/s), from displacement `q` and
    /// velocity `v`; `accel` makes its outputs its acceleration, and `mass` sets how a force moves
    /// it. Returns its index, or `None` if full.
    #[allow(clippy::too_many_arguments)]
    pub fn add(&mut self, w0: f32, sigma: f32, mass: f32, q: f32, v: f32, accel: bool, gain: [f32; 3]) -> Option<usize> {
        if self.len >= self.capacity() {
            return None;
        }
        let k = self.len;
        self.len += 1;
        self.w0[k] = w0;
        self.sigma[k] = sigma;
        self.accel[k] = accel;
        self.gain[k] = gain;
        self.force[k] = 0.0;
        let wd = damped(w0, sigma);
        self.im[k] = q;
        self.re[k] = (v + sigma * q) / wd;
        self.set_exact(k, mass);
        Some(k)
    }

    fn weights(&self, k: usize) -> (f32, f32) {
        let (w0, s) = (self.w0[k], self.sigma[k]);
        if self.accel[k] {
            let wd = damped(w0, s);
            (-w0 * w0 + 2.0 * s * s, -2.0 * s * wd)
        } else {
            (1.0, 0.0)
        }
    }

    /// Sets slot `k`'s rotation exactly for where it is now, with no glide.
    fn set_exact(&mut self, k: usize, mass: f32) {
        let wd = damped(self.w0[k], self.sigma[k]);
        let r = (-self.sigma[k] * self.h).exp();
        let theta = wd * self.h;
        if theta >= std::f32::consts::PI * 0.98 {
            // Above Nyquist: silent.
            self.rr[k] = 0.0;
            self.ri[k] = 0.0;
            self.re[k] = 0.0;
            self.im[k] = 0.0;
        } else {
            let (sn, cs) = theta.sin_cos();
            self.rr[k] = r * cs;
            self.ri[k] = r * sn;
        }
        self.tr[k] = 1.0;
        self.ti[k] = 0.0;
        self.resc[k] = 1.0;
        self.kick[k] = self.h / (mass.max(1.0e-30) * wd);
        let (a, b) = self.weights(k);
        self.wi[k] = a;
        self.wr[k] = b;
        self.dwi[k] = 0.0;
        self.dwr[k] = 0.0;
        self.left[k] = 0;
    }

    /// Moves slot `k` from where it is to `w0` (rad/s) and `sigma` (1/s) linearly over the next
    /// `samples` samples (then it stays there until told otherwise).
    pub fn glide(&mut self, k: usize, w0: f32, sigma: f32, mass: f32, samples: usize) {
        // Resynchronize the rotation exactly for where the slot is now (the previous glide's end).
        let (w_start, s_start) = (self.w0[k], self.sigma[k]);
        let wd_start = damped(w_start, s_start);
        self.set_exact(k, mass);
        let n = samples.max(1) as f32;
        let wd_end = damped(w0, sigma);
        if wd_end * self.h >= std::f32::consts::PI * 0.98 {
            self.w0[k] = w0;
            self.sigma[k] = sigma;
            self.set_exact(k, mass);
            return;
        }
        let (dw, ds) = ((wd_end - wd_start) * self.h / n, (sigma - s_start) * self.h / n);
        let m = (-ds).exp();
        let (sn, cs) = dw.sin_cos();
        self.tr[k] = m * cs;
        self.ti[k] = m * sn;
        self.resc[k] = (wd_start / wd_end).powf(1.0 / n);
        let (a0, b0) = (self.wi[k], self.wr[k]);
        self.w0[k] = w0;
        self.sigma[k] = sigma;
        let (a1, b1) = self.weights(k);
        self.dwi[k] = (a1 - a0) / n;
        self.dwr[k] = (b1 - b0) / n;
        self.kick[k] = self.h / (mass.max(1.0e-30) * wd_end);
        self.left[k] = samples.max(1) as u32;
    }

    /// Sets slot `k`'s output gains.
    pub fn set_gain(&mut self, k: usize, gain: [f32; 3]) {
        self.gain[k] = gain;
    }

    /// Adds a force on slot `k` for the coming sample.
    #[inline]
    pub fn push(&mut self, k: usize, f: f32) {
        self.force[k] += f;
    }

    /// Removes slot `k` (the last slot takes its place).
    pub fn remove(&mut self, k: usize) {
        let last = self.len - 1;
        if k != last {
            macro_rules! mv {
                ($($f:ident),*) => { $( self.$f[k] = self.$f[last]; )* };
            }
            mv!(re, im, rr, ri, tr, ti, resc, wi, wr, dwi, dwr, kick, w0, sigma, gain, force, accel, left);
        }
        self.len = last;
    }

    /// Moves every slot one sample, and returns the three output channels.
    pub fn step(&mut self) -> [f32; 3] {
        let n = self.len;
        let mut out = [0.0f32; 3];
        for k in 0..n {
            let x = self.re[k] + self.kick[k] * self.force[k];
            let y = self.im[k];
            let (a, b) = (self.rr[k], self.ri[k]);
            let nre = a * x - b * y;
            let nim = b * x + a * y;
            self.force[k] = 0.0;
            self.im[k] = nim;
            if self.left[k] > 0 {
                self.left[k] -= 1;
                self.re[k] = nre * self.resc[k];
                let (t, u) = (self.tr[k], self.ti[k]);
                self.rr[k] = a * t - b * u;
                self.ri[k] = a * u + b * t;
                self.wi[k] += self.dwi[k];
                self.wr[k] += self.dwr[k];
            } else {
                self.re[k] = nre;
            }
            let v = self.wi[k] * nim + self.wr[k] * self.re[k];
            let g = self.gain[k];
            out[0] += v * g[0];
            out[1] += v * g[1];
            out[2] += v * g[2];
        }
        out
    }
}

// ------------------------------------------------------------------------------------------
// The bank
// ------------------------------------------------------------------------------------------

/// A bubble to make.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Birth {
    /// Radius, m.
    pub radius: f32,
    /// Depth of its centre below the free surface, m.
    pub depth: f32,
    /// Where it is, left (-1) to right (+1), for the stereo image.
    pub pan: f32,
    /// Distance from the listener, m.
    pub distance: f32,
    /// How many real bubbles this one stands for (they ring incoherently: `sqrt(count)`).
    pub count: f32,
    /// Its wall's speed at birth, as a multiple of the capillary speed (1: a neck closing by
    /// surface tension alone).
    pub violence: f32,
}

impl Birth {
    pub fn new(radius: f32, depth: f32) -> Self {
        Self { radius, depth, pan: 0.0, distance: 1.0, count: 1.0, violence: 1.0 }
    }
}

/// Equal-power gains for a pan position in `[-1, 1]`.
pub fn pan_gains(pan: f32) -> (f32, f32) {
    let a = (pan.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
    (a.cos(), a.sin())
}

#[derive(Clone, Copy, Debug, Default)]
struct Life {
    mode: BubbleMode,
    radius: f32,
    depth: f32,
    /// Rise speed now, its terminal value, m/s.
    speed: f32,
    terminal: f32,
    /// Squared amplitude below which it is done, and at birth.
    floor: f32,
    start: f32,
    /// Where it is, left (-1) to right (+1), as born.
    pan: f32,
    age: u32,
}

/// A ringing bubble as the view draws it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BubbleDot {
    /// Radius and depth of its centre below the surface, m.
    pub radius: f32,
    pub depth: f32,
    /// Left (-1) to right (+1), as born.
    pub pan: f32,
    /// What it rings at now, Hz.
    pub freq: f32,
    /// Its amplitude against its amplitude at birth (1 at birth, falling as it rings out).
    pub amp: f32,
}

/// Many bubbles ringing. See the module notes.
pub struct BubbleBank {
    sr: f32,
    res: Resonators,
    life: Vec<Life>,
    counter: usize,
    /// Depth of the water the bubbles are in, m (they can't be born deeper).
    pub water_depth: f32,
    /// Bubbles made so far, and births refused because the bank was full.
    pub born: u64,
    pub refused: u64,
    /// The newest bubble's frequency when born (for the view and the ops), Hz.
    pub last_freq: f32,
}

impl BubbleBank {
    pub fn new(sr: f32) -> Self {
        Self::with_capacity(MAX_BUBBLES, sr)
    }

    pub fn with_capacity(capacity: usize, sr: f32) -> Self {
        Self { sr, res: Resonators::new(capacity, sr), life: vec![Life::default(); capacity], counter: 0, water_depth: 100.0, born: 0, refused: 0, last_freq: 0.0 }
    }

    /// Bubbles ringing now.
    pub fn ringing(&self) -> usize {
        self.res.len()
    }

    pub fn is_silent(&self) -> bool {
        self.res.is_empty()
    }

    /// The bubbles ringing now, for the view (allocates nothing).
    pub fn dots(&self, mut f: impl FnMut(BubbleDot)) {
        for k in 0..self.res.len() {
            let l = &self.life[k];
            let amp = (self.res.amplitude2(k) / l.start.max(1.0e-30)).max(0.0).sqrt().min(1.0);
            f(BubbleDot { radius: l.radius, depth: l.depth, pan: l.pan, freq: self.res.omega(k) / std::f32::consts::TAU, amp });
        }
    }

    /// Makes a bubble ring. Returns false if it couldn't be made (too small to hear, or the bank
    /// full - then the quietest bubble gives way if it is quieter than this one would be).
    pub fn spawn(&mut self, b: Birth) -> bool {
        if b.radius < MIN_RADIUS || !(b.radius.is_finite() && b.depth.is_finite()) {
            return false;
        }
        let depth = b.depth.clamp(b.radius * 1.05, self.water_depth.max(b.radius * 1.05));
        let mode = bubble_mode(b.radius, depth);
        let factor = surface_factor(b.radius, depth);
        let w0 = std::f32::consts::TAU * mode.freq * factor;
        if w0 / self.sr >= std::f32::consts::PI * 0.95 {
            return false;
        }
        let sigma = mode.sigma_at(b.radius, depth);
        let (l, r) = pan_gains(b.pan);
        let amp = b.count.max(0.0).sqrt();
        // Pressure in air per unit wall acceleration: rho_air 4 pi R^2 / (2 pi r).
        let air = 2.0 * RHO_AIR * b.radius * b.radius / b.distance.max(0.05) * amp;
        let volume = 4.0 * std::f32::consts::PI * b.radius * b.radius * amp;
        let v0 = -b.violence.max(0.0) * birth_speed(b.radius);
        if self.res.len() >= self.res.capacity() {
            // Full: the quietest gives way, if quieter than the newcomer.
            let loud = |res: &Resonators, k: usize, g: f32| res.amplitude2(k) * res.omega(k).powi(4) * g * g;
            let wd = damped(w0, sigma);
            let newcomer = (v0 / wd).powi(2) * w0.powi(4) * air * air;
            let (mut q, mut qv) = (0, f32::MAX);
            for k in 0..self.res.len() {
                let v = loud(&self.res, k, self.res.gain[k][0].max(self.res.gain[k][1]) * std::f32::consts::SQRT_2);
                if v < qv {
                    qv = v;
                    q = k;
                }
            }
            if qv >= newcomer {
                self.refused += 1;
                return false;
            }
            self.res.remove(q);
            self.life.swap(q, self.res.len());
        }
        let Some(k) = self.res.add(w0, sigma, 1.0, 0.0, v0, true, [air * l, air * r, volume]) else {
            self.refused += 1;
            return false;
        };
        let start = (v0 / damped(w0, sigma)).powi(2);
        self.life[k] = Life { mode, radius: b.radius, depth, speed: 0.0, terminal: rise_speed(b.radius), floor: start * 1.0e-10, start, pan: b.pan, age: 0 };
        self.born += 1;
        self.last_freq = w0 / std::f32::consts::TAU;
        true
    }

    /// One sample: `[left, right]` in pascals in the air, and the bubbles' total volume
    /// acceleration (m^3/s^2) for anything the water surface drives (a vessel's air).
    pub fn next(&mut self) -> ([f32; 2], f32) {
        if self.counter % BUBBLE_BLOCK == 0 {
            self.update();
        }
        self.counter = self.counter.wrapping_add(1);
        let o = self.res.step();
        ([o[0], o[1]], o[2])
    }

    /// Every block: rises, retunes, and retires the bubbles that have rung out.
    fn update(&mut self) {
        let dt = BUBBLE_BLOCK as f32 / self.sr;
        let mut k = 0;
        while k < self.res.len() {
            let life = &mut self.life[k];
            life.age = life.age.saturating_add(BUBBLE_BLOCK as u32);
            if self.res.amplitude2(k) < life.floor || life.age as f32 > 3.0 * self.sr {
                self.res.remove(k);
                let last = self.res.len();
                self.life.swap(k, last);
                continue;
            }
            // Accelerating from rest at about 2g (buoyancy against its added mass, half its
            // displaced water) up to its terminal speed; it stops at the surface.
            life.speed = (life.speed + 2.0 * G * dt).min(life.terminal);
            let top = life.radius * 1.05;
            if life.depth > top {
                life.depth = (life.depth - life.speed * dt).max(top);
                let factor = surface_factor(life.radius, life.depth);
                let w0 = std::f32::consts::TAU * life.mode.freq * factor;
                let sigma = life.mode.sigma_at(life.radius, life.depth);
                self.res.glide(k, w0, sigma, 1.0, BUBBLE_BLOCK);
            } else if self.res.omega(k) > 0.0 {
                let (w0, s) = (self.res.omega(k), self.res.sigma(k));
                self.res.glide(k, w0, s, 1.0, BUBBLE_BLOCK);
            }
            k += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_millimetre_bubble_rings_near_minnaert() {
        let m = bubble_mode(1.0e-3, 0.0);
        // Minnaert's adiabatic value is 3.26 kHz; heat flow softens the gas a little.
        assert!(m.freq > 3000.0 && m.freq < 3300.0, "{}", m.freq);
        assert!(m.kappa > 1.2 && m.kappa < 1.4, "kappa {}", m.kappa);
        // Frequency goes inversely with radius (to within the heat flow's change).
        let small = bubble_mode(0.2e-3, 0.0);
        let ratio = small.freq * 0.2e-3 / (m.freq * 1.0e-3);
        assert!(ratio > 0.9 && ratio < 1.15, "{ratio}");
    }

    #[test]
    fn damping_matches_devins_measured_range() {
        // Devin's damping constant for a millimetre bubble at a few kHz is about 0.03-0.04, and
        // thermal damping dominates at this size; van den Doel's fit to it: 0.13/R + 0.0072 R^-1.5.
        let m = bubble_mode(1.0e-3, 0.0);
        let d = m.delta();
        assert!(d > 0.025 && d < 0.045, "delta {d}");
        let fit = 0.13 / 1.0e-3 + 0.0072 * (1.0e-3f32).powf(-1.5);
        assert!((m.sigma() / fit - 1.0).abs() < 0.35, "sigma {} vs fit {fit}", m.sigma());
        // Radiation takes over for larger bubbles; viscosity matters only for tiny ones.
        let big = bubble_mode(5.0e-3, 0.0);
        assert!(big.radiation > big.thermal && big.radiation > big.viscous, "{big:?}");
        let tiny = bubble_mode(0.03e-3, 0.0);
        assert!(tiny.viscous / tiny.sigma() > 10.0 * m.viscous / m.sigma(), "{tiny:?}");
    }

    #[test]
    fn the_surface_raises_the_pitch_and_hushes_radiation() {
        let r = 1.0e-3;
        assert!((surface_factor(r, 1.0) - 1.0).abs() < 1.0e-3);
        assert!(surface_factor(r, 1.2 * r) > 1.3);
        assert!(image_radiation(3000.0, 0.002) < 0.01);
        assert!((image_radiation(3000.0, 2.0) - 1.0).abs() < 0.02);
    }

    #[test]
    fn radius_for_inverts_the_pitch() {
        for f in [500.0f32, 1500.0, 4000.0, 12_000.0] {
            let r = radius_for(f);
            let got = bubble_mode(r, 2.0 * r).freq * surface_factor(r, 2.0 * r);
            assert!((got / f - 1.0).abs() < 1.0e-3, "{f}: {got}");
        }
    }

    #[test]
    fn a_glide_ends_where_it_was_asked_to() {
        // Retuned over one sample and then left alone, a slot rings at its new frequency and decays
        // at its new rate (the turn stops).
        let sr = 44_100.0;
        let mut r = Resonators::new(1, sr);
        r.add(std::f32::consts::TAU * 3000.0, 400.0, 1.0, 0.0, 1.0, false, [1.0, 0.0, 0.0]).unwrap();
        r.glide(0, std::f32::consts::TAU * 500.0, 5.0, 1.0, 1);
        let x: Vec<f32> = (0..4410).map(|_| r.step()[0]).collect();
        let crossings = x.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((crossings as i32 - 50).abs() <= 1, "{crossings}");
        let (a, b) = (x[..441].iter().fold(0.0f32, |m, v| m.max(v.abs())), x[3969..].iter().fold(0.0f32, |m, v| m.max(v.abs())));
        assert!((b / a - (-5.0f32 * 0.09).exp()).abs() < 0.05, "{a} {b}");
    }

    #[test]
    fn a_resonator_glides_without_a_step() {
        // A slot gliding an octave keeps its displacement continuous and ends at its new frequency.
        let sr = 44_100.0;
        let mut r = Resonators::new(1, sr);
        let w = std::f32::consts::TAU * 1000.0;
        r.add(w, 5.0, 1.0, 0.0, 1.0, false, [1.0, 0.0, 0.0]).unwrap();
        let mut prev = 0.0f32;
        let mut worst = 0.0f32;
        for i in 0..4410 {
            if i % 32 == 0 {
                let f = 1000.0 * 2.0f32.powf((i as f32 / 4410.0).min(1.0));
                r.glide(0, std::f32::consts::TAU * f, 5.0, 1.0, 32);
            }
            let y = r.step()[0];
            worst = worst.max((y - prev).abs());
            prev = y;
        }
        // Largest per-sample change is what a 2 kHz sine of that amplitude does.
        let amp = 1.0 / w;
        assert!(worst < amp * std::f32::consts::TAU * 2000.0 / sr * 1.2, "{worst}");
    }
}

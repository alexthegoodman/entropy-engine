//! The reference acoustics of a bore: its input impedance at the mouthpiece, by the transfer-matrix
//! method. This is the ground truth the runtime waveguide is checked against, the resonance ladder
//! the player aims at, and (later) what Physics View draws. It runs at build time and in tests,
//! never on the audio thread.
//!
//! The bore is cut into thin cylinders (a staircase, fine enough - 1 mm - that the steps don't
//! matter below a few kHz). Each carries a plane wave with the visco-thermal wall losses of a tube
//! of its radius: an attenuation and a slight slowing, both growing with frequency and with
//! narrowness (the textbook boundary-layer result - Benade's `alpha ~ 3e-5 sqrt(f) / r` Np/m). The
//! mouth is loaded by the radiation impedance of an open end in its low-frequency lumped form - an
//! inertance (the end correction, 0.61 of the radius) in parallel with the characteristic
//! resistance - which reflects lows back up the bore and lets highs out. The runtime model uses the
//! same radiation load, so the two differ only in how they propagate the waves.

use super::bore::BoreProfile;

pub const RHO: f64 = 1.2;
pub const C: f64 = 343.0;
/// Air viscosity, Pa·s.
const ETA: f64 = 1.81e-5;
/// Thermal-loss factor `1 + (gamma - 1) / sqrt(Pr)`.
const THERMAL: f64 = 1.476;
/// Staircase step for the tapered runs, metres.
const STEP: f32 = 0.001;
/// End correction of an open (unflanged) end, as a fraction of its radius.
pub const END_CORRECTION: f64 = 0.6133;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct C64 {
    pub re: f64,
    pub im: f64,
}

impl C64 {
    pub const fn new(re: f64, im: f64) -> Self {
        Self { re, im }
    }
    pub fn abs(self) -> f64 {
        self.re.hypot(self.im)
    }
    fn mul(self, o: Self) -> Self {
        Self::new(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re)
    }
    fn add(self, o: Self) -> Self {
        Self::new(self.re + o.re, self.im + o.im)
    }
    fn div(self, o: Self) -> Self {
        let d = o.re * o.re + o.im * o.im;
        Self::new((self.re * o.re + self.im * o.im) / d, (self.im * o.re - self.re * o.im) / d)
    }
    fn scale(self, k: f64) -> Self {
        Self::new(self.re * k, self.im * k)
    }
}

/// The complex propagation constant `Gamma = alpha + j omega / v` of a tube of radius `r` at `f` Hz.
pub fn propagation(f: f64, r: f64) -> C64 {
    let w = std::f64::consts::TAU * f.max(1.0e-3);
    let k = w / C;
    let rv = r * (w * RHO / ETA).sqrt();
    let eps = THERMAL / (std::f64::consts::SQRT_2 * rv);
    C64::new(k * eps, k * (1.0 + eps))
}

/// Attenuation of a plane wave in a tube of radius `r` at `f` Hz, nepers per metre.
pub fn attenuation(f: f64, r: f64) -> f64 {
    propagation(f, r).re
}

/// `cosh` and `sinh` of `Gamma * l`.
fn cosh_sinh(g: C64, l: f64) -> (C64, C64) {
    let (a, b) = (g.re * l, g.im * l);
    let (ch, sh) = (a.cosh(), a.sinh());
    let (s, c) = b.sin_cos();
    (C64::new(ch * c, sh * s), C64::new(sh * c, ch * s))
}

/// Characteristic impedance of a tube of radius `r`.
pub fn zc(r: f64) -> f64 {
    RHO * C / (std::f64::consts::PI * r * r)
}

/// What an impedance `z_load` at the far end of a tube looks like from its near end.
fn through(z_load: C64, f: f64, r: f64, l: f64) -> C64 {
    let (ch, sh) = cosh_sinh(propagation(f, r), l);
    let z0 = zc(r);
    // (A Z + B) / (C Z + D) with A = D = cosh, B = Z0 sinh, C = sinh / Z0.
    ch.mul(z_load).add(sh.scale(z0)).div(sh.scale(1.0 / z0).mul(z_load).add(ch))
}

/// Radiation impedance of the mouth, radius `a`.
pub fn radiation(f: f64, a: f64) -> C64 {
    let w = std::f64::consts::TAU * f;
    let s = std::f64::consts::PI * a * a;
    let r = RHO * C / s;
    let l = RHO * END_CORRECTION * a / s;
    // jwL R / (R + jwL)
    let jwl = C64::new(0.0, w * l);
    jwl.scale(r).div(C64::new(r, w * l))
}

/// The staircase of a run of sections: `(radius, length)` per step, in order.
fn staircase(profile: &BoreProfile, x0: f32, x1: f32) -> Vec<(f64, f64)> {
    let n = ((x1 - x0) / STEP).ceil().max(1.0) as usize;
    let dx = (x1 - x0) / n as f32;
    (0..n)
        .map(|i| {
            let a = profile.mean_area(x0 + i as f32 * dx, x0 + (i + 1) as f32 * dx, 0.0);
            ((a as f64 / std::f64::consts::PI).sqrt(), dx as f64)
        })
        .collect()
}

/// A bore's input impedance on a frequency grid, with the parts that don't depend on the slide
/// precomputed so the resonances at any slide extension come cheaply.
pub struct Reference {
    pub profile: BoreProfile,
    pub freqs: Vec<f32>,
    front: Vec<(f64, f64)>,
    /// The impedance looking into the bell from the end of the cylinder, per grid frequency.
    bell_in: Vec<C64>,
}

/// One resonance of the air column: an impedance peak.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Peak {
    pub freq: f32,
    /// |Z| at the peak, Pa·s/m³.
    pub magnitude: f32,
}

impl Reference {
    /// Grid from `lo` to `hi` Hz every `step` Hz.
    pub fn new(profile: &BoreProfile, lo: f32, hi: f32, step: f32) -> Self {
        let n = ((hi - lo) / step).floor() as usize + 1;
        let freqs: Vec<f32> = (0..n).map(|i| lo + i as f32 * step).collect();
        let f0 = profile.front_length();
        let front = staircase(profile, 0.0, f0);
        let b0 = profile.front_length() + profile.cylinder_length;
        let bell = staircase(profile, b0, b0 + profile.bell_length());
        let a = profile.mouth_radius() as f64;
        let bell_in = freqs
            .iter()
            .map(|&f| {
                let f = f as f64;
                bell.iter().rev().fold(radiation(f, a), |z, &(r, l)| through(z, f, r, l))
            })
            .collect();
        Self { profile: profile.clone(), freqs, front, bell_in }
    }

    /// Input impedance at grid point `i` with `extra` metres of slide.
    pub fn zin_at(&self, i: usize, extra: f32) -> C64 {
        let f = self.freqs[i] as f64;
        let cyl = (self.profile.cylinder_length + extra) as f64;
        let z = through(self.bell_in[i], f, self.profile.cylinder_radius as f64, cyl);
        self.front.iter().rev().fold(z, |z, &(r, l)| through(z, f, r, l))
    }

    /// |Z_in| over the whole grid.
    pub fn magnitude(&self, extra: f32) -> Vec<f32> {
        (0..self.freqs.len()).map(|i| self.zin_at(i, extra).abs() as f32).collect()
    }

    /// The impedance peaks (resonances), low to high, each refined by a parabola through log|Z|.
    pub fn peaks(&self, extra: f32) -> Vec<Peak> {
        let m: Vec<f64> = (0..self.freqs.len()).map(|i| self.zin_at(i, extra).abs().ln()).collect();
        let step = if self.freqs.len() > 1 { self.freqs[1] - self.freqs[0] } else { 1.0 };
        let mut out = Vec::new();
        for i in 1..m.len().saturating_sub(1) {
            if m[i] > m[i - 1] && m[i] >= m[i + 1] {
                let (a, b, c) = (m[i - 1], m[i], m[i + 1]);
                let den = a - 2.0 * b + c;
                let d = if den.abs() > 1.0e-12 { 0.5 * (a - c) / den } else { 0.0 };
                let peak = b - 0.25 * (a - c) * d;
                out.push(Peak { freq: self.freqs[i] + d as f32 * step, magnitude: peak.exp() as f32 });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_losses_match_the_textbook_figure() {
        // Benade's rule of thumb: alpha ~ 3e-5 sqrt(f) / r nepers per metre.
        for &(f, r) in &[(100.0, 0.007), (1000.0, 0.01), (3000.0, 0.005)] {
            let a = attenuation(f, r);
            let rule = 3.0e-5 * f.sqrt() / r;
            assert!((a / rule - 1.0).abs() < 0.1, "{f} Hz, r {r}: {a} vs {rule}");
        }
    }

    #[test]
    fn a_lossless_open_cylinder_resonates_at_odd_quarter_wavelengths_from_a_closed_end() {
        // The textbook check of the machinery: a closed-open pipe driven at its closed end has
        // impedance peaks at (2n - 1) v / 4 (L + end correction), with v the speed of sound in the
        // tube - a little below c, since the boundary layer slows it (by ~2% at 85 Hz in a 1 cm
        // radius tube; 30 cents).
        let r = 0.01f32;
        let l = 1.0f32;
        let profile = BoreProfile {
            front: vec![],
            cylinder_radius: r,
            cylinder_length: l,
            bell: vec![],
            slide_max: 0.0,
            nominal_fundamental: 0.0,
            obstruction: None,
        };
        let reference = Reference::new(&profile, 20.0, 800.0, 0.25);
        let peaks = reference.peaks(0.0);
        let leff = l as f64 + END_CORRECTION * r as f64;
        for (n, p) in peaks.iter().take(4).enumerate() {
            let mut expect = (2 * n + 1) as f64 * C / (4.0 * leff);
            for _ in 0..3 {
                let v = std::f64::consts::TAU * expect / propagation(expect, r as f64).im;
                expect = (2 * n + 1) as f64 * v / (4.0 * leff);
            }
            let cents = 1200.0 * (p.freq as f64 / expect).log2();
            assert!(cents.abs() < 3.0, "peak {} at {} Hz, expected {expect:.2} ({cents:+.2} cents)", n + 1, p.freq);
        }
    }
}

//! A body that rings as a set of modes. Each mode is a damped mass-spring (frequency, decay, modal
//! mass); where a force is applied, and where the body is watched, each mode moves in proportion to
//! its **shape** at that point.
//!
//! Every mode is run as the *exact* response of a damped oscillator to a force held for one sample:
//! a complex state rotated by `exp((-sigma + i omega_d) h)` each sample, which is well conditioned
//! in `f32` even for low modes at a high rate (where the usual two-pole recurrence loses its tuning),
//! can never go unstable, and simply has no mode above Nyquist. The state is kept scaled so that its
//! imaginary part *is* the modal displacement and its real part is `(q' + sigma q) / omega_d`: the
//! body's frequencies can then be scaled while it rings (the tension of a stretched membrane rising
//! with its amplitude, for instance) with displacement and velocity continuous.
//!
//! What a contact needs from a body is two numbers at the contact point: where the point would be
//! next sample if no new force acted (`predict`), and how far a newton of force held for this sample
//! moves it (`compliance`). The modal body answers both exactly, which is what lets the contact
//! force be solved implicitly (see `contact`).
//!
//! Nothing here allocates after construction.

use std::f32::consts::TAU;

/// One mode as specified: the undamped frequency (Hz) at frequency scale 1, the amplitude decay rate
/// `sigma` (1/s, so the 60 dB decay time is `6.91 / sigma`), the modal mass (kg) and the weight of
/// its acceleration in the radiated output.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ModeSpec {
    pub freq: f32,
    pub sigma: f32,
    pub mass: f32,
    pub radiation: f32,
}

impl ModeSpec {
    /// 60 dB decay time, seconds.
    pub fn t60(&self) -> f32 {
        6.907_755 / self.sigma.max(1.0e-6)
    }
}

pub struct ModalBody {
    sr: f32,
    h: f32,
    specs: Vec<ModeSpec>,
    // Per mode, structure of arrays.
    re: Vec<f32>,
    im: Vec<f32>,
    rot_re: Vec<f32>,
    rot_im: Vec<f32>,
    /// `h / (m omega_d)`: what one newton held for one sample adds to the state's real part (before
    /// the rotation).
    kick: Vec<f32>,
    /// `h R sin(theta) / (m omega_d)`: how far one newton held for this sample moves the mode by the
    /// next sample - its share of the driving-point compliance.
    reach: Vec<f32>,
    /// Output weights on `im` and `re` giving the mode's acceleration times its radiation weight.
    out_im: Vec<f32>,
    out_re: Vec<f32>,
    omega_d: Vec<f32>,
    /// Generalized forces accumulated for the coming step.
    force: Vec<f32>,
    scale: f32,
    /// Small scale changes applied incrementally since the last exact recomputation.
    increments: u32,
    active: usize,
}

impl ModalBody {
    pub fn new(specs: &[ModeSpec], sr: f32) -> Self {
        let n = specs.len();
        let mut b = Self {
            sr,
            h: 1.0 / sr,
            specs: specs.to_vec(),
            re: vec![0.0; n],
            im: vec![0.0; n],
            rot_re: vec![0.0; n],
            rot_im: vec![0.0; n],
            kick: vec![0.0; n],
            reach: vec![0.0; n],
            out_im: vec![0.0; n],
            out_re: vec![0.0; n],
            omega_d: vec![0.0; n],
            force: vec![0.0; n],
            scale: 0.0,
            increments: 0,
            active: 0,
        };
        b.set_scale(1.0);
        b
    }

    pub fn len(&self) -> usize {
        self.specs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.specs.is_empty()
    }

    pub fn specs(&self) -> &[ModeSpec] {
        &self.specs
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    /// The current frequency scale.
    pub fn scale(&self) -> f32 {
        self.scale
    }

    /// Scales every mode's undamped frequency by `s` (1 = as specified), keeping each mode's
    /// displacement and velocity continuous.
    ///
    /// A small change (a tension that drifts as a hit decays) turns each mode's rotation by the small
    /// change in its angle - a few multiplies and a square root per mode, since the decay per sample
    /// doesn't depend on the frequency - and a large one recomputes it exactly.
    pub fn set_scale(&mut self, s: f32) {
        if (s - self.scale).abs() <= 2.0e-6 * self.scale {
            return;
        }
        let small = self.scale > 0.0 && (s / self.scale - 1.0).abs() < 0.02 && self.increments < 64;
        let nyq = 0.5 * TAU * 0.49;
        let mut active = 0;
        for k in 0..self.specs.len() {
            let sp = self.specs[k];
            let w0 = TAU * sp.freq * s;
            let sig = sp.sigma.max(0.0);
            let wd = (w0 * w0 - sig * sig).max(1.0e-6).sqrt();
            let theta = wd * self.h;
            if theta >= nyq || sp.mass <= 0.0 {
                // Above Nyquist (or massless): the mode can't be represented, so it is silent.
                self.rot_re[k] = 0.0;
                self.rot_im[k] = 0.0;
                self.kick[k] = 0.0;
                self.reach[k] = 0.0;
                self.out_im[k] = 0.0;
                self.out_re[k] = 0.0;
                self.re[k] = 0.0;
                self.im[k] = 0.0;
                self.omega_d[k] = 0.0;
                continue;
            }
            active = k + 1;
            let old = self.omega_d[k];
            if small && old > 0.0 {
                // Turn the rotation by the change in angle (third-order sine, second-order cosine:
                // exact to 1e-10 for the changes allowed here).
                let d = (wd - old) * self.h;
                let (sn, cs) = (d - d * d * d / 6.0, 1.0 - 0.5 * d * d);
                let (a, b) = (self.rot_re[k], self.rot_im[k]);
                self.rot_re[k] = a * cs - b * sn;
                self.rot_im[k] = a * sn + b * cs;
            } else {
                let r = (-sig * self.h).exp();
                let (sn, cs) = theta.sin_cos();
                self.rot_re[k] = r * cs;
                self.rot_im[k] = r * sn;
            }
            // Velocity continuity: re = (q' + sigma q) / omega_d.
            if old > 0.0 {
                self.re[k] *= old / wd;
            }
            self.kick[k] = self.h / (sp.mass * wd);
            self.reach[k] = self.kick[k] * self.rot_im[k];
            // q'' = -w0^2 q - 2 sigma q' with q = im, q' = wd re - sigma im.
            self.out_im[k] = sp.radiation * (-w0 * w0 + 2.0 * sig * sig);
            self.out_re[k] = sp.radiation * (-2.0 * sig * wd);
            self.omega_d[k] = wd;
        }
        self.increments = if small { self.increments + 1 } else { 0 };
        self.active = active;
        self.scale = s;
    }

    pub fn clear(&mut self) {
        self.re.iter_mut().for_each(|v| *v = 0.0);
        self.im.iter_mut().for_each(|v| *v = 0.0);
        self.force.iter_mut().for_each(|v| *v = 0.0);
    }

    /// Modal displacement of mode `k` (metres, in the mode's normalization).
    #[inline]
    pub fn q(&self, k: usize) -> f32 {
        self.im[k]
    }

    /// Mode `k`'s squared amplitude averaged over a cycle, `(q^2 + (q'/omega)^2) / 2` (from the
    /// rotating state, so it has no ripple at twice the mode's frequency).
    #[inline]
    pub fn mean_square(&self, k: usize) -> f32 {
        0.5 * (self.re[k] * self.re[k] + self.im[k] * self.im[k])
    }

    /// Modal velocity of mode `k`.
    #[inline]
    pub fn q_dot(&self, k: usize) -> f32 {
        self.omega_d[k] * self.re[k] - self.specs[k].sigma * self.im[k]
    }

    /// Displacement of a point whose shape values are `shape` (one per mode).
    pub fn displacement(&self, shape: &[f32]) -> f32 {
        let n = self.active.min(shape.len());
        let mut acc = 0.0;
        for k in 0..n {
            acc += shape[k] * self.im[k];
        }
        acc
    }

    /// Where the point `shape` will be after the coming step if no further force is added, and how
    /// far one newton applied there for the coming step would move it: `(free, compliance)`.
    pub fn predict(&self, shape: &[f32]) -> (f32, f32) {
        let n = self.active.min(shape.len());
        let (mut free, mut comp) = (0.0f32, 0.0f32);
        for k in 0..n {
            let re = self.re[k] + self.kick[k] * self.force[k];
            free += shape[k] * (self.rot_im[k] * re + self.rot_re[k] * self.im[k]);
            comp += shape[k] * shape[k] * self.reach[k];
        }
        (free, comp)
    }

    /// Adds a force `f` (newtons) at the point `shape` for the coming step.
    pub fn add_force(&mut self, shape: &[f32], f: f32) {
        let n = self.active.min(shape.len());
        for k in 0..n {
            self.force[k] += shape[k] * f;
        }
    }

    /// Adds a generalized force on mode `k` for the coming step.
    #[inline]
    pub fn add_modal_force(&mut self, k: usize, f: f32) {
        self.force[k] += f;
    }

    /// Advances every mode by one sample under the accumulated forces (which are then cleared), and
    /// returns the radiated output (the modes' accelerations weighted by their radiation).
    pub fn step(&mut self) -> f32 {
        const L: usize = 8;
        let n = self.active;
        // Fixed-width chunks with one partial sum per lane: no bounds checks and no ordered
        // floating-point sum, so the loop vectorizes.
        let (re, im, force) = (&mut self.re[..n], &mut self.im[..n], &mut self.force[..n]);
        let (rr, ri, kick) = (&self.rot_re[..n], &self.rot_im[..n], &self.kick[..n]);
        let (oi, or) = (&self.out_im[..n], &self.out_re[..n]);
        let mut lanes = [0.0f32; L];
        let body = n / L * L;
        {
            let it = re[..body].chunks_exact_mut(L).zip(im[..body].chunks_exact_mut(L)).zip(force[..body].chunks_exact_mut(L));
            let co = rr[..body].chunks_exact(L).zip(ri[..body].chunks_exact(L)).zip(kick[..body].chunks_exact(L)).zip(oi[..body].chunks_exact(L).zip(or[..body].chunks_exact(L)));
            for (((re, im), f), (((a, b), kk), (oi, or))) in it.zip(co) {
                for i in 0..L {
                    let x = re[i] + kk[i] * f[i];
                    let y = im[i];
                    let nre = a[i] * x - b[i] * y;
                    let nim = b[i] * x + a[i] * y;
                    re[i] = nre;
                    im[i] = nim;
                    f[i] = 0.0;
                    lanes[i] += oi[i] * nim + or[i] * nre;
                }
            }
        }
        let mut out: f32 = lanes.iter().sum();
        for i in body..n {
            let x = re[i] + kick[i] * force[i];
            let y = im[i];
            let nre = rr[i] * x - ri[i] * y;
            let nim = ri[i] * x + rr[i] * y;
            re[i] = nre;
            im[i] = nim;
            force[i] = 0.0;
            out += oi[i] * nim + or[i] * nre;
        }
        out
    }

    /// Zeroes modes that have decayed below any audible level (about 1e-15 m of motion). Without
    /// this a decaying mode ends in subnormal floats, which some processors handle a hundred times
    /// slower than normal ones. Cheap enough to call every block.
    pub fn flush_quiet(&mut self) {
        for k in 0..self.active {
            if self.re[k].abs() < 1.0e-15 && self.im[k].abs() < 1.0e-15 {
                self.re[k] = 0.0;
                self.im[k] = 0.0;
            }
        }
    }

    /// Total vibrational energy (joules): kinetic plus potential over the modes.
    pub fn energy(&self) -> f32 {
        let mut e = 0.0;
        for k in 0..self.active {
            let w0 = TAU * self.specs[k].freq * self.scale;
            let v = self.q_dot(k);
            e += 0.5 * self.specs[k].mass * (v * v + w0 * w0 * self.im[k] * self.im[k]);
        }
        e
    }
}

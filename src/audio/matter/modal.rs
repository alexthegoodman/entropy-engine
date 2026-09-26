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

/// Frequency-scale changes smaller than this (relative; 0.017 cents) are held until they add up.
/// Each retuning of a mode under a load makes it ring a little about its new equilibrium; a change
/// spread over many tiny steps stays inaudible (it approaches the continuous, adiabatic change), and
/// holding back the tiniest keeps a slow drift cheap.
pub const SCALE_RESOLUTION: f32 = 1.0e-5;

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
    /// Modes `0..coupled` push back on contacts (`predict` sees them); the rest only listen - they are
    /// driven by forces but don't take part in a contact's balance (see `set_coupled`).
    coupled: usize,
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
            coupled: n,
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
        if (s - self.scale).abs() <= SCALE_RESOLUTION * self.scale {
            return;
        }
        let small = self.scale > 0.0 && (s / self.scale - 1.0).abs() < 0.02 && self.increments < 64;
        let nyq = 0.5 * TAU * 0.49;
        let mut active = 0;
        for k in 0..self.specs.len() {
            let sp = self.specs[k];
            if k >= self.coupled && self.scale > 0.0 {
                // Listening modes keep their tuning (see `set_coupled`).
                if self.omega_d[k] > 0.0 {
                    active = k + 1;
                }
                continue;
            }
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

    /// Replaces the modes' specifications (as many as the body has) while it rings - a glass whose
    /// water changes, say - keeping every mode's displacement and velocity continuous.
    pub fn set_specs(&mut self, specs: &[ModeSpec]) {
        let n = self.specs.len().min(specs.len());
        self.specs[..n].copy_from_slice(&specs[..n]);
        let s = self.scale;
        // A scale that can't be matched forces the exact recomputation of every mode.
        self.scale = -1.0;
        self.increments = 0;
        self.set_scale(s);
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

    /// Only modes `0..n` take part in contacts; the rest are driven by the forces applied but are
    /// left out of `predict`. For a sampled high band (a few modes each standing for many): as
    /// resonators they are sparse and lightly damped, where the dense band they stand for acts on a
    /// contact as a smooth load, so coupling them both ways makes a contact chatter at their
    /// frequencies that the real body would not. Driven one way, they receive the contact force's
    /// own high frequencies - its sharp edges - which is the part that matters.
    ///
    /// They also keep their tuning when the body is rescaled: a percent of glide in a dense,
    /// noise-like band is inaudible, while retuning modes that carry a large quasi-static load (and a
    /// sampled mode stands for many) in steps makes each step ring.
    pub fn set_coupled(&mut self, n: usize) {
        self.coupled = n.min(self.specs.len());
    }

    /// How many modes take part in contacts (see `set_coupled`).
    pub fn coupled(&self) -> usize {
        self.coupled.min(self.active)
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
        let n = self.active.min(shape.len()).min(self.coupled);
        let (sh, re, im, kick, force) = (&shape[..n], &self.re[..n], &self.im[..n], &self.kick[..n], &self.force[..n]);
        let (rr, ri, reach) = (&self.rot_re[..n], &self.rot_im[..n], &self.reach[..n]);
        #[cfg(target_arch = "x86_64")]
        let ((mut free, mut comp), done) = predict_sse(sh, re, im, kick, force, rr, ri, reach);
        #[cfg(not(target_arch = "x86_64"))]
        let ((mut free, mut comp), done) = ((0.0f32, 0.0f32), 0usize);
        for k in done..n {
            let x = re[k] + kick[k] * force[k];
            free += sh[k] * (ri[k] * x + rr[k] * im[k]);
            comp += sh[k] * sh[k] * reach[k];
        }
        (free, comp)
    }

    /// The one-step compliance at a point alone (the second half of `predict`): it depends only on
    /// the tuning, so a caller can keep it while the scale barely moves and use `predict_free`.
    pub fn compliance(&self, shape: &[f32]) -> f32 {
        self.cross_compliance(shape, shape)
    }

    /// Every coupled mode's displacement after the coming step if no further force is added, into
    /// `out` (at least as long as the body): with it, the free position of any point is one dot
    /// product with its shape (`dot`), which is cheaper than `predict` when many points are asked.
    pub fn free_displacements(&self, out: &mut [f32]) {
        let n = self.active.min(self.coupled);
        let (re, im, kick, force) = (&self.re[..n], &self.im[..n], &self.kick[..n], &self.force[..n]);
        let (rr, ri) = (&self.rot_re[..n], &self.rot_im[..n]);
        for (k, o) in out[..n].iter_mut().enumerate() {
            let x = re[k] + kick[k] * force[k];
            *o = ri[k] * x + rr[k] * im[k];
        }
        out[n..].iter_mut().for_each(|v| *v = 0.0);
    }

    /// `sum a b reach` over the coupled modes: how far one newton held for this sample at the point
    /// `b` moves the point `a` (the cross-compliance; `a = b` gives `compliance`).
    pub fn cross_compliance(&self, a: &[f32], b: &[f32]) -> f32 {
        let n = self.active.min(self.coupled).min(a.len()).min(b.len());
        dot3(&a[..n], &b[..n], &self.reach[..n])
    }

    /// Adds a force `f` (newtons) at the point `shape` for the coming step.
    pub fn add_force(&mut self, shape: &[f32], f: f32) {
        let n = self.active.min(shape.len());
        for (dst, s) in self.force[..n].iter_mut().zip(&shape[..n]) {
            *dst += s * f;
        }
    }

    /// Every mode's displacement and the generalized forces accumulated for the coming step, as
    /// slices: for couplings that read and drive many modes at once.
    pub fn displacements_and_forces(&mut self) -> (&[f32], &mut [f32]) {
        (&self.im, &mut self.force)
    }

    /// Adds a generalized force on mode `k` for the coming step.
    #[inline]
    pub fn add_modal_force(&mut self, k: usize, f: f32) {
        self.force[k] += f;
    }

    /// Advances every mode by one sample under the accumulated forces (which are then cleared), and
    /// returns the radiated output (the modes' accelerations weighted by their radiation).
    pub fn step(&mut self) -> f32 {
        let n = self.active;
        let (re, im, force) = (&mut self.re[..n], &mut self.im[..n], &mut self.force[..n]);
        let (rr, ri, kick) = (&self.rot_re[..n], &self.rot_im[..n], &self.kick[..n]);
        let (oi, or) = (&self.out_im[..n], &self.out_re[..n]);
        #[cfg(target_arch = "x86_64")]
        let (mut out, done) = step_sse(re, im, force, rr, ri, kick, oi, or);
        #[cfg(not(target_arch = "x86_64"))]
        let (mut out, done) = (0.0f32, 0usize);
        for i in done..n {
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

/// The body of `ModalBody::step` four modes at a time (SSE2 is part of every x86-64 processor; the
/// compiler would not vectorize the plain loop). Returns the output of the modes done and how many.
#[cfg(target_arch = "x86_64")]
#[allow(clippy::too_many_arguments)]
fn step_sse(re: &mut [f32], im: &mut [f32], force: &mut [f32], rr: &[f32], ri: &[f32], kick: &[f32], oi: &[f32], or: &[f32]) -> (f32, usize) {
    use std::arch::x86_64::*;
    let n = re.len();
    let body = n / 4 * 4;
    for s in [im.len(), force.len(), rr.len(), ri.len(), kick.len(), oi.len(), or.len()] {
        assert!(s >= n);
    }
    // SAFETY: every slice is at least `n` long (checked above) and each access reads or writes four
    // floats at an index below `body <= n`, unaligned loads and stores.
    unsafe {
        let mut acc = _mm_setzero_ps();
        let zero = _mm_setzero_ps();
        let mut i = 0;
        while i < body {
            let x = _mm_add_ps(_mm_loadu_ps(re.as_ptr().add(i)), _mm_mul_ps(_mm_loadu_ps(kick.as_ptr().add(i)), _mm_loadu_ps(force.as_ptr().add(i))));
            let y = _mm_loadu_ps(im.as_ptr().add(i));
            let a = _mm_loadu_ps(rr.as_ptr().add(i));
            let b = _mm_loadu_ps(ri.as_ptr().add(i));
            let nre = _mm_sub_ps(_mm_mul_ps(a, x), _mm_mul_ps(b, y));
            let nim = _mm_add_ps(_mm_mul_ps(b, x), _mm_mul_ps(a, y));
            _mm_storeu_ps(re.as_mut_ptr().add(i), nre);
            _mm_storeu_ps(im.as_mut_ptr().add(i), nim);
            _mm_storeu_ps(force.as_mut_ptr().add(i), zero);
            acc = _mm_add_ps(acc, _mm_add_ps(_mm_mul_ps(_mm_loadu_ps(oi.as_ptr().add(i)), nim), _mm_mul_ps(_mm_loadu_ps(or.as_ptr().add(i)), nre)));
            i += 4;
        }
        let mut lanes = [0.0f32; 4];
        _mm_storeu_ps(lanes.as_mut_ptr(), acc);
        (lanes.iter().sum(), body)
    }
}

/// `ModalBody::predict`'s sums four modes at a time. Returns the partial sums and how many modes
/// they cover.
#[cfg(target_arch = "x86_64")]
#[allow(clippy::too_many_arguments)]
fn predict_sse(sh: &[f32], re: &[f32], im: &[f32], kick: &[f32], force: &[f32], rr: &[f32], ri: &[f32], reach: &[f32]) -> ((f32, f32), usize) {
    use std::arch::x86_64::*;
    let n = sh.len();
    let body = n / 4 * 4;
    for s in [re.len(), im.len(), kick.len(), force.len(), rr.len(), ri.len(), reach.len()] {
        assert!(s >= n);
    }
    // SAFETY: every slice is at least `n` long (checked above); each access reads four floats at an
    // index below `body <= n`.
    unsafe {
        let (mut fa, mut ca) = (_mm_setzero_ps(), _mm_setzero_ps());
        let mut i = 0;
        while i < body {
            let s = _mm_loadu_ps(sh.as_ptr().add(i));
            let x = _mm_add_ps(_mm_loadu_ps(re.as_ptr().add(i)), _mm_mul_ps(_mm_loadu_ps(kick.as_ptr().add(i)), _mm_loadu_ps(force.as_ptr().add(i))));
            let q = _mm_add_ps(_mm_mul_ps(_mm_loadu_ps(ri.as_ptr().add(i)), x), _mm_mul_ps(_mm_loadu_ps(rr.as_ptr().add(i)), _mm_loadu_ps(im.as_ptr().add(i))));
            fa = _mm_add_ps(fa, _mm_mul_ps(s, q));
            ca = _mm_add_ps(ca, _mm_mul_ps(_mm_mul_ps(s, s), _mm_loadu_ps(reach.as_ptr().add(i))));
            i += 4;
        }
        let (mut f4, mut c4) = ([0.0f32; 4], [0.0f32; 4]);
        _mm_storeu_ps(f4.as_mut_ptr(), fa);
        _mm_storeu_ps(c4.as_mut_ptr(), ca);
        ((f4.iter().sum(), c4.iter().sum()), body)
    }
}

/// `sum a b`, four independent partial sums (vectorizes).
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let (a, b) = (&a[..n], &b[..n]);
    let mut acc = [0.0f32; 8];
    let body = n / 8 * 8;
    for (ca, cb) in a[..body].chunks_exact(8).zip(b[..body].chunks_exact(8)) {
        for l in 0..8 {
            acc[l] += ca[l] * cb[l];
        }
    }
    let mut s: f32 = acc.iter().sum();
    for k in body..n {
        s += a[k] * b[k];
    }
    s
}

/// `sum a b c`.
fn dot3(a: &[f32], b: &[f32], c: &[f32]) -> f32 {
    let n = a.len().min(b.len()).min(c.len());
    let mut acc = [0.0f32; 8];
    let body = n / 8 * 8;
    for i in (0..body).step_by(8) {
        for l in 0..8 {
            acc[l] += a[i + l] * b[i + l] * c[i + l];
        }
    }
    let mut s: f32 = acc.iter().sum();
    for k in body..n {
        s += a[k] * b[k] * c[k];
    }
    s
}

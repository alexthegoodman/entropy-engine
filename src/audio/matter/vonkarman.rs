//! The von Karman nonlinearity of a plate or shallow shell, run on its modes: what makes a cymbal
//! crash and a gong shimmer.
//!
//! The stretching energy (see `plate`) beyond the linear part folded into the shell modes is
//!
//! ```text
//! U(q) = sum_k c_k (P_k^2 + 2 P_k l_k),    P_k = sum_pq H^k_pq q_p q_q,   l_k = sum_p B^k_p q_p
//! ```
//!
//! and its force on the modes is `-grad U`: quadratic terms from the dome (`P l`) and cubic ones from
//! stretching (`P^2`). At small amplitudes it is nothing; at amplitudes near the plate's thickness it
//! couples every mode to the others, and energy put into a few low modes by a stick spreads through
//! the rest over tens of milliseconds.
//!
//! **Integration.** The force is stiff and grows with the square of the amplitude, so evaluating it
//! explicitly (as a force held for a step) is only stable up to some amplitude, and a hard crash is
//! exactly where it is needed. It is run with a *scalar auxiliary variable* (SAV): a scalar
//! `psi ~ sqrt(2 (U + C))` carried along with the modes, the force taken as `-psi g` with
//! `g = grad U / sqrt(2 (U + C))`, and `psi` updated so that the work the force does on the modes is
//! exactly what `psi^2 / 2` loses. The modal body applies a force as an impulse at the start of a step
//! and then follows each mode's exact (damped) motion, so over one step
//!
//! ```text
//! Delta E_modes = H f.v + H^2 |f|^2 / (2M),   f = -(psi + Delta psi / 2) g
//! ```
//!
//! and asking `Delta (psi^2 / 2) = -Delta E_modes` gives `Delta psi` in closed form - one scalar, no
//! solve. The sum of the modes' energy and `psi^2 / 2` then never grows (damping only removes it),
//! whatever the amplitude and whatever `g` is: the scheme cannot blow up. How well `psi` tracks
//! `sqrt(2 (U + C))` is the accuracy, which the tests measure. `C` is a constant offset (the dome's
//! quadratic term lets `U` go negative); it is raised, and `psi` resynchronized, while a striker is in
//! contact, when energy is being added anyway.
//!
//! The force is evaluated every `every` samples (an impulse `every` times as long): the nonlinear set
//! stops at a few kHz, far below the rate at which that would matter.
//!
//! Nothing here allocates after construction.

use super::modal::ModalBody;
use super::plate::Couplings;

pub struct VonKarman {
    /// Body modes `0..n` are the nonlinear set.
    n: usize,
    blocks: Vec<Block>,
    /// The quadratic couplings, grouped by pair of orders (see [`Pair`]).
    pairs: Vec<Pair>,
    /// Every pair's rows, contiguous (for the gradient).
    rows: Vec<f32>,
    /// The same coefficients interleaved four rows at a time, `[group][entry][lane]` (for `P`).
    lanes: Vec<f32>,
    /// `P_k` and `2 c_k (P_k + l_k)` of each in-plane function, and scratch for one pair's outer
    /// product and row sum.
    pk: Vec<f32>,
    alpha: Vec<f32>,
    outer: Vec<f32>,
    rsum: Vec<f32>,
    lp: Vec<u16>,
    lb: Vec<f32>,
    lstarts: Vec<u32>,
    c: Vec<f32>,
    /// `omega^2` of each nonlinear mode, for its energy.
    omega2: Vec<f64>,
    mass: f64,
    psi: f64,
    shift: f64,
    pub every: u32,
    counter: u32,
    h: f64,
    qs: Vec<f32>,
    vs: Vec<f32>,
    qp: Vec<f32>,
    gp: Vec<f32>,
    gs: Vec<f32>,
    /// The last evaluation's `U` (J), for the view and the tests.
    pub potential: f64,
}

/// All couplings between the flat-plate modes of orders `m1 <= m2`: for each in-plane function `k`
/// that couples them (order `m1 + m2` or `m2 - m1`), a dense row of `n1 n2` coefficients, so
/// `P_k += row . (q_m1 outer q_m2)`. Dense rows make both passes contiguous dot products and
/// accumulations, which run four at a time with SSE2 (the compiler would not vectorize the
/// gather-scatter over sparse entries).
struct Pair {
    a0: usize,
    n1: usize,
    b0: usize,
    n2: usize,
    /// In-plane function of each row, and where the rows start in `rows`.
    ks: Vec<u32>,
    offset: usize,
    /// Start of this pair's groups in `lanes`; `ks4` is `ks` padded to whole groups with a slot
    /// that is never read.
    loffset: usize,
    ks4: Vec<u32>,
    /// Row length: `n1 n2` padded with zeros to a multiple of four, so rows are whole SSE2 lanes.
    w: usize,
}

struct Block {
    shell: Vec<usize>,
    plate0: usize,
    /// Flat-plate x shell, row-major.
    v: Vec<f32>,
}

impl VonKarman {
    pub fn new(c: &Couplings, body: &ModalBody, mass: f64, every: u32) -> Self {
        let mut blocks = Vec::new();
        let mut p0 = 0;
        let mut n = 0;
        for (_, shell, v) in &c.blocks {
            n += shell.len();
            blocks.push(Block { shell: shell.clone(), plate0: p0, v: v.iter().map(|&x| x as f32).collect() });
            p0 += shell.len();
        }
        // Where each flat-plate mode sits: its block's first index and size.
        let mut place = vec![(0usize, 0usize); p0];
        for b in &blocks {
            for i in 0..b.shell.len() {
                place[b.plate0 + i] = (b.plate0, b.shell.len());
            }
        }
        // Gather the sparse entries into dense rows per (pair of blocks, k).
        let mut map: std::collections::BTreeMap<(usize, usize), std::collections::BTreeMap<u32, Vec<f32>>> = Default::default();
        for k in 0..c.c.len() {
            for &(p, q, hv) in &c.quad[k] {
                let (pa, pb) = (place[p as usize], place[q as usize]);
                let ((a0, n1), (b0, n2), i, j) = if pa.0 <= pb.0 { (pa, pb, p as usize - pa.0, q as usize - pb.0) } else { (pb, pa, q as usize - pb.0, p as usize - pa.0) };
                let row = map.entry((a0, b0)).or_default().entry(k as u32).or_insert_with(|| vec![0.0; n1 * n2]);
                if a0 == b0 {
                    // Within one block the full square is summed: H at (i, j) and (j, i).
                    row[i * n2 + j] = hv as f32;
                    row[j * n2 + i] = hv as f32;
                } else {
                    // Across blocks each product appears once: 2H.
                    row[i * n2 + j] = 2.0 * hv as f32;
                }
            }
        }
        let (mut pairs, mut rows, mut lanes) = (Vec::new(), Vec::new(), Vec::new());
        let dummy = c.c.len() as u32;
        for ((a0, b0), ks) in map {
            let (n1, n2) = (place[a0].1, place[b0].1);
            let w = (n1 * n2).div_ceil(4) * 4;
            let (offset, loffset) = (rows.len(), lanes.len());
            let mut kv = Vec::new();
            let mut all: Vec<Vec<f32>> = Vec::new();
            for (k, mut row) in ks {
                kv.push(k);
                row.resize(w, 0.0);
                rows.extend_from_slice(&row);
                all.push(row);
            }
            let mut ks4 = kv.clone();
            ks4.resize(kv.len().div_ceil(4) * 4, dummy);
            for g in 0..ks4.len() / 4 {
                for e in 0..n1 * n2 {
                    for l in 0..4 {
                        lanes.push(all.get(g * 4 + l).map_or(0.0, |r| r[e]));
                    }
                }
            }
            pairs.push(Pair { a0, n1, b0, n2, ks: kv, offset, loffset, ks4, w });
        }
        let (mut lp, mut lb, mut lstarts) = (Vec::new(), Vec::new(), vec![0u32]);
        for k in 0..c.c.len() {
            for &(p, b) in &c.lin[k] {
                lp.push(p);
                lb.push(b as f32);
            }
            lstarts.push(lp.len() as u32);
        }
        let widest = pairs.iter().map(|p| p.w).max().unwrap_or(0);
        let omega2 = (0..n).map(|k| (std::f64::consts::TAU * body.specs()[k].freq as f64).powi(2)).collect();
        Self {
            n,
            blocks,
            pairs,
            rows,
            lanes,
            pk: vec![0.0; c.c.len() + 1],
            alpha: vec![0.0; c.c.len()],
            outer: vec![0.0; widest],
            rsum: vec![0.0; widest],
            lp,
            lb,
            lstarts,
            c: c.c.iter().map(|&x| x as f32).collect(),
            omega2,
            mass,
            psi: 0.0,
            shift: 0.0,
            every: every.max(1),
            counter: 0,
            h: 1.0 / body.sample_rate() as f64,
            qs: vec![0.0; n],
            vs: vec![0.0; n],
            qp: vec![0.0; n],
            gp: vec![0.0; n],
            gs: vec![0.0; n],
            potential: 0.0,
        }
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    /// Number of quadratic couplings evaluated per step.
    pub fn couplings(&self) -> usize {
        self.rows.len()
    }

    /// `U` at the flat-plate amplitudes in `qp`, and `grad U` into `gp`.
    fn evaluate(&mut self) -> f64 {
        let qp = &self.qp;
        self.pk.iter_mut().for_each(|p| *p = 0.0);
        for pr in &self.pairs {
            let w = pr.w;
            let outer = &mut self.outer[..w];
            for i in 0..pr.n1 {
                let qi = qp[pr.a0 + i];
                for j in 0..pr.n2 {
                    outer[i * pr.n2 + j] = qi * qp[pr.b0 + j];
                }
            }
            let nn = pr.n1 * pr.n2;
            for (g, ks) in pr.ks4.chunks_exact(4).enumerate() {
                let p4 = dot4(&self.lanes[pr.loffset + g * nn * 4..pr.loffset + (g + 1) * nn * 4], &outer[..nn]);
                for l in 0..4 {
                    self.pk[ks[l] as usize] += p4[l];
                }
            }
        }
        let gp = &mut self.gp;
        gp.iter_mut().for_each(|g| *g = 0.0);
        let mut u = 0.0f64;
        for k in 0..self.c.len() {
            let p = self.pk[k];
            let (la, lb_) = (self.lstarts[k] as usize, self.lstarts[k + 1] as usize);
            let mut l = 0.0f32;
            for i in la..lb_ {
                l += self.lb[i] * qp[self.lp[i] as usize];
            }
            let c = self.c[k];
            u += (c * (p * p + 2.0 * p * l)) as f64;
            // dU/dq = 2c (P + l) dP/dq + 2c P B.
            self.alpha[k] = 2.0 * c * (p + l);
            let beta = 2.0 * c * p;
            for i in la..lb_ {
                gp[self.lp[i] as usize] += beta * self.lb[i];
            }
        }
        for pr in &self.pairs {
            let w = pr.w;
            let rsum = &mut self.rsum[..w];
            rsum.iter_mut().for_each(|v| *v = 0.0);
            for (r, &k) in pr.ks.iter().enumerate() {
                let a = self.alpha[k as usize];
                if a != 0.0 {
                    axpy(a, &self.rows[pr.offset + r * w..pr.offset + (r + 1) * w], rsum);
                }
            }
            // dP/dq_i = sum_j row_ij q_j (and the transpose for the second block).
            for i in 0..pr.n1 {
                let mut acc = 0.0f32;
                let qi = qp[pr.a0 + i];
                for j in 0..pr.n2 {
                    let v = rsum[i * pr.n2 + j];
                    acc += v * qp[pr.b0 + j];
                    gp[pr.b0 + j] += v * qi;
                }
                gp[pr.a0 + i] += acc;
            }
        }
        u
    }

    fn to_plate(&mut self) {
        for b in &self.blocks {
            let nb = b.shell.len();
            for i in 0..nb {
                let row = &b.v[i * nb..(i + 1) * nb];
                self.qp[b.plate0 + i] = row.iter().zip(&b.shell).map(|(v, &s)| v * self.qs[s]).sum();
            }
        }
    }

    fn to_shell(&mut self) {
        for b in &self.blocks {
            let nb = b.shell.len();
            for (j, &s) in b.shell.iter().enumerate() {
                self.gs[s] = (0..nb).map(|i| b.v[i * nb + j] * self.gp[b.plate0 + i]).sum();
            }
        }
    }

    /// The stretching energy `U` at the body's present state, J.
    pub fn stretching(&mut self, body: &ModalBody) -> f64 {
        for k in 0..self.n {
            self.qs[k] = body.q(k);
        }
        self.to_plate();
        self.evaluate()
    }

    /// `U` and `grad U` (in the body's modal coordinates) at the nonlinear modes' amplitudes `q`: the
    /// force the scheme approximates, for tests. Allocates.
    pub fn gradient_at(&mut self, q: &[f32]) -> (f64, Vec<f32>) {
        self.qs.copy_from_slice(&q[..self.n]);
        self.to_plate();
        let u = self.evaluate();
        self.to_shell();
        (u, self.gs.clone())
    }

    /// The scheme's nonlinear energy, `psi^2 / 2 - C`: what the modes' energy plus it conserve.
    pub fn energy(&self) -> f64 {
        0.5 * self.psi * self.psi - self.shift
    }

    /// Energy of the nonlinear set's modes, J.
    fn modal_energy(&self) -> f64 {
        (0..self.n).map(|k| 0.5 * self.mass * ((self.vs[k] as f64).powi(2) + self.omega2[k] * (self.qs[k] as f64).powi(2))).sum()
    }

    /// Called once per sample, before the body steps: every `every` samples, applies the nonlinear
    /// force for the coming interval. `resync` while something else (a striker) adds energy.
    pub fn tick(&mut self, body: &mut ModalBody, resync: bool) {
        self.counter = self.counter.wrapping_add(1);
        if (self.counter - 1) % self.every != 0 {
            return;
        }
        for k in 0..self.n {
            self.qs[k] = body.q(k);
            self.vs[k] = body.q_dot(k);
        }
        if !resync && self.psi == 0.0 && self.shift == 0.0 {
            // Never struck: at rest.
            return;
        }
        self.to_plate();
        let u = self.evaluate();
        self.potential = u;
        if resync {
            // U >= -(the dome's share of the modes' potential energy) >= -E: an offset of twice the
            // modes' energy keeps U + C comfortably positive.
            self.shift = self.shift.max(2.0 * self.modal_energy());
            self.psi = (2.0 * (u + self.shift)).max(0.0).sqrt();
        }
        self.to_shell();
        let den = (2.0 * (u + self.shift)).max(0.02 * self.shift).max(1.0e-30).sqrt();
        let (mut gv, mut gg) = (0.0f64, 0.0f64);
        for k in 0..self.n {
            let g = self.gs[k] as f64 / den;
            self.gs[k] = g as f32;
            gv += g * self.vs[k] as f64;
            gg += g * g;
        }
        let hh = self.h * self.every as f64;
        let im = 1.0 / self.mass;
        let dpsi = (hh * gv - 0.5 * hh * hh * gg * im * self.psi) / (1.0 + 0.25 * hh * hh * gg * im);
        let mid = self.psi + 0.5 * dpsi;
        // An impulse H f, applied as a force `every f` held for one sample.
        let scale = -(mid * self.every as f64) as f32;
        for k in 0..self.n {
            body.add_modal_force(k, scale * self.gs[k]);
        }
        self.psi += dpsi;
    }
}

/// `y += a x`, four lanes at a time with SSE2.
fn axpy(a: f32, x: &[f32], y: &mut [f32]) {
    let n = x.len().min(y.len());
    let body = n / 4 * 4;
    #[cfg(target_arch = "x86_64")]
    // SAFETY: both slices hold at least `n` floats; each access touches four at an index below
    // `body <= n`.
    unsafe {
        use std::arch::x86_64::*;
        let av = _mm_set1_ps(a);
        let mut i = 0;
        while i < body {
            let yv = _mm_loadu_ps(y.as_ptr().add(i));
            _mm_storeu_ps(y.as_mut_ptr().add(i), _mm_add_ps(yv, _mm_mul_ps(av, _mm_loadu_ps(x.as_ptr().add(i)))));
            i += 4;
        }
    }
    #[cfg(not(target_arch = "x86_64"))]
    let body = 0;
    for k in body..n {
        y[k] += a * x[k];
    }
}

/// Four dot products at once: `lanes` holds `x.len()` groups of four coefficients (one per row);
/// returns `sum_e lanes[e][l] x[e]` for each lane `l`. One broadcast multiply-add per entry, no
/// horizontal sums.
fn dot4(lanes: &[f32], x: &[f32]) -> [f32; 4] {
    let n = x.len().min(lanes.len() / 4);
    let mut out = [0.0f32; 4];
    #[cfg(target_arch = "x86_64")]
    // SAFETY: `lanes` holds at least `4 n` floats and `x` at least `n`; each load reads four floats at
    // `4 e` (or one at `e`) with `e < n`.
    unsafe {
        use std::arch::x86_64::*;
        let (mut a0, mut a1) = (_mm_setzero_ps(), _mm_setzero_ps());
        let mut e = 0;
        while e + 2 <= n {
            a0 = _mm_add_ps(a0, _mm_mul_ps(_mm_set1_ps(*x.get_unchecked(e)), _mm_loadu_ps(lanes.as_ptr().add(4 * e))));
            a1 = _mm_add_ps(a1, _mm_mul_ps(_mm_set1_ps(*x.get_unchecked(e + 1)), _mm_loadu_ps(lanes.as_ptr().add(4 * e + 4))));
            e += 2;
        }
        if e < n {
            a0 = _mm_add_ps(a0, _mm_mul_ps(_mm_set1_ps(*x.get_unchecked(e)), _mm_loadu_ps(lanes.as_ptr().add(4 * e))));
        }
        _mm_storeu_ps(out.as_mut_ptr(), _mm_add_ps(a0, a1));
    }
    #[cfg(not(target_arch = "x86_64"))]
    for e in 0..n {
        for l in 0..4 {
            out[l] += lanes[4 * e + l] * x[e];
        }
    }
    out
}

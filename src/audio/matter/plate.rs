//! A thin circular plate, free at its edge, and the same plate bent into a shallow dome: the body of
//! a cymbal (and later a gong or a sheet of metal).
//!
//! **Bending.** A Kirchhoff plate of radius `a`, thickness `h`, bending stiffness
//! `D = E h^3 / (12 (1 - nu^2))`, has modes `W(r) cos(m theta)` with
//! `W = J_m(lambda r / a) + C I_m(lambda r / a)` (the modified Bessel function carries the part of the
//! motion that dies away from the edge), and frequency `omega = lambda^2 sqrt(D / (rho h)) / a^2`:
//! plates are dispersive, frequency growing with the square of the wavenumber, so unlike a membrane
//! their modes are spread evenly in frequency (about `S / 2 sqrt(rho h / D)` per Hz). A free edge
//! carries no bending moment and no Kirchhoff shear, two conditions whose determinant vanishes at the
//! `lambda` of each mode.
//!
//! **Stretching.** When a plate bends by more than a fraction of its thickness it also stretches in its
//! own plane. Von Karman's equations describe that with an Airy stress function `F`:
//!
//! ```text
//! rho h w_tt + D del^4 w = L(w, F) + (1/R) del^2 F + p
//! del^4 F = -(E h / 2) (L(w, w) + (2/R) del^2 w)
//! ```
//!
//! with `L(f, g) = f_xx g_yy + f_yy g_xx - 2 f_xy g_xy`, and `R` the radius of a shallow spherical
//! dome (a cymbal's bow; infinite for a flat plate). At a free edge the plate's rim is unloaded in its
//! own plane, `F = dF/dr = 0`, so `F` is expanded on the modes `Psi_k` of `del^4 Psi = zeta^4 Psi`
//! with those conditions (the modes of a *clamped* plate). Projected on the bending modes this gives
//! the stretching energy exactly as a sum of squares,
//!
//! ```text
//! U = sum_k c_k (P_k + l_k)^2,     P_k = sum_pq H^k_pq q_p q_q,     l_k = sum_p B^k_p q_p
//! ```
//!
//! with `c_k = E h / (8 A zeta_k^4)`, `H^k_pq = integral Psi_k L(Phi_p, Phi_q) dA` and
//! `B^k_p = (2/R) integral Psi_k del^2 Phi_p dA`. The linear part, `sum c_k l_k^2`, is the dome's
//! stiffness: bending a dome stretches it, so the modes that change its volume (the axisymmetric
//! ones) rise a long way above the flat plate's, while the others, which can bend without
//! stretching, barely move. Here that part is folded into the modes (an eigen-solve per order: the
//! **shell modes**); the rest, cubic and quartic in the amplitudes, is the nonlinearity that makes a
//! cymbal crash (see `vonkarman`).
//!
//! **Radiation.** Each mode's radiation resistance is the baffled Rayleigh integral in the wavenumber
//! domain, as for the membrane, with the Hankel transform of `J_m` and `I_m` in closed form
//! (Lommel's integrals); both faces radiate. Below the coincidence frequency (17 kHz for a millimetre
//! of bronze) a plate radiates only from its edge and its long wavelengths, so its modes are damped
//! mostly by the metal.
//!
//! Everything here runs at build time.

use super::bessel::{in_scaled_range, jn_range};
use super::membrane::{C_AIR, RHO_AIR};
use super::modal::ModeSpec;
use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::{Mutex, OnceLock};

/// A plate, SI units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlateSpec {
    /// Radius, m.
    pub radius: f32,
    /// Thickness, m.
    pub thickness: f32,
    pub young: f32,
    pub poisson: f32,
    pub density: f32,
    /// Radius of curvature of the dome, m, convex toward the striker; 0 for a flat plate.
    pub dome_radius: f32,
    /// Internal losses: amplitude decay rate at low frequency (1/s)...
    pub loss: f32,
    /// ...plus this much per kHz of mode frequency.
    pub loss_hf: f32,
    /// The stand: the whole plate bouncing on its felts (Hz), rocking on them (Hz), and their Q.
    pub mount_freq: f32,
    pub rock_freq: f32,
    pub mount_q: f32,
}

impl PlateSpec {
    /// Bending stiffness `D`, N m.
    pub fn rigidity(&self) -> f64 {
        let (e, h, nu) = (self.young as f64, self.thickness as f64, self.poisson as f64);
        e * h * h * h / (12.0 * (1.0 - nu * nu))
    }

    pub fn area(&self) -> f64 {
        PI * (self.radius as f64).powi(2)
    }

    /// The plate's mass, kg (every mode's modal mass: shapes are normalized to a mean square of one).
    pub fn mass(&self) -> f64 {
        self.density as f64 * self.thickness as f64 * self.area()
    }

    /// `sqrt(D / (rho h)) / a^2`: `omega = lambda^2` times this.
    fn omega_scale(&self) -> f64 {
        (self.rigidity() / (self.density as f64 * self.thickness as f64)).sqrt() / (self.radius as f64).powi(2)
    }

    /// Frequency (Hz) of a flat-plate mode of dimensionless wavenumber `lambda`.
    pub fn freq_of(&self, lambda: f64) -> f64 {
        lambda * lambda * self.omega_scale() / (2.0 * PI)
    }

    /// The dimensionless wavenumber of a flat-plate mode at `freq` Hz.
    pub fn lambda_of(&self, freq: f64) -> f64 {
        (2.0 * PI * freq / self.omega_scale()).sqrt()
    }

    /// `E / (rho R^2)`, rad^2/s^2: what the dome adds to `omega^2` of a mode whose wavelength is short
    /// compared with the plate (a spherical shell's dispersion, `rho h omega^2 = D k^4 + E h / R^2`).
    pub fn dome_omega2(&self) -> f64 {
        if self.dome_radius == 0.0 {
            0.0
        } else {
            self.young as f64 / (self.density as f64 * (self.dome_radius as f64).powi(2))
        }
    }

    /// Frequency above which the plate radiates efficiently (bending waves faster than sound), Hz.
    pub fn coincidence(&self) -> f64 {
        let c = C_AIR as f64;
        c * c / (2.0 * PI) * (self.density as f64 * self.thickness as f64 / self.rigidity()).sqrt()
    }
}

/// A radial shape `norm (J_m(lambda r) + c I_m(lambda r) / I_m(lambda))`, `r` in units of the
/// radius. `lambda = 0` marks a rigid motion: `norm` for `m = 0` (bouncing), `norm r` for `m = 1`
/// (rocking).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Radial {
    pub m: u32,
    pub lambda: f64,
    pub c: f64,
    pub norm: f64,
    /// `I_m(lambda) e^-lambda`, the scaling of the `I` part.
    ilam: f64,
}

impl Radial {
    fn new(m: u32, lambda: f64, c: f64) -> Self {
        let mut i = [0.0f64];
        in_scaled_range(m as i32, m as i32, lambda, &mut i);
        let mut r = Self { m, lambda, c, norm: 1.0, ilam: i[0] };
        // Mean square one over the disc.
        let g = Grid::new(((lambda / 2.0) as usize + 8).max(8));
        let ms: f64 = g.r.iter().zip(&g.w).map(|(&x, &w)| r.eval(x)[0].powi(2) * x * w).sum::<f64>() * if m == 0 { 2.0 } else { 1.0 };
        r.norm = 1.0 / ms.sqrt();
        r
    }

    fn rigid(m: u32) -> Self {
        // Mean square of 1 over the disc: 1 for bouncing; (2 r cos theta)^2 averages to 1.
        Self { m, lambda: 0.0, c: 0.0, norm: if m == 0 { 1.0 } else { 2.0 }, ilam: 1.0 }
    }

    /// `[W, W', W'', del^2 W]` at `r` (derivatives in units of the radius; the Laplacian of
    /// `W cos(m theta)`, over `cos(m theta)`). Allocation-free.
    pub fn eval(&self, r: f64) -> [f64; 4] {
        if self.lambda == 0.0 {
            return if self.m == 0 { [self.norm, 0.0, 0.0, 0.0] } else { [self.norm * r, self.norm, 0.0, 0.0] };
        }
        let (m, l) = (self.m as i32, self.lambda);
        let x = l * r;
        let (mut j, mut i) = ([0.0f64; 5], [0.0f64; 5]);
        jn_range(m - 2, m + 2, x, &mut j);
        in_scaled_range(m - 2, m + 2, x, &mut i);
        let s = self.c * (x - l).exp() / self.ilam;
        let (j0, j1, j2) = (j[2], 0.5 * (j[1] - j[3]), 0.25 * (j[0] - 2.0 * j[2] + j[4]));
        let (i0, i1, i2) = (i[2], 0.5 * (i[1] + i[3]), 0.25 * (i[0] + 2.0 * i[2] + i[4]));
        let n = self.norm;
        [n * (j0 + s * i0), n * l * (j1 + s * i1), n * l * l * (j2 + s * i2), n * l * l * (-j0 + s * i0)]
    }

    /// The Hankel transform `integral_0^1 W(r) J_m(x r) r dr`, in closed form (Lommel's integrals for
    /// `J_m J_m` and `I_m J_m`).
    pub fn hankel(&self, x: f64) -> f64 {
        let (m, l) = (self.m as i32, self.lambda);
        if l == 0.0 {
            return 0.0;
        }
        let mut jx = [0.0f64; 3];
        jn_range(m - 1, m + 1, x, &mut jx);
        let (jm_x, jp_x) = (jx[1], 0.5 * (jx[0] - jx[2]));
        let mut jl = [0.0f64; 3];
        jn_range(m - 1, m + 1, l, &mut jl);
        let (jm_l, jp_l) = (jl[1], 0.5 * (jl[0] - jl[2]));
        let mut il = [0.0f64; 3];
        in_scaled_range(m - 1, m + 1, l, &mut il);
        // I_m(lambda r) / I_m(lambda): value 1 and slope I_m'(lambda) / I_m(lambda) at the edge.
        let ip_l = 0.5 * (il[0] + il[2]) / il[1];
        let d = l * l - x * x;
        let jj = if d.abs() < 1.0e-6 * l * l {
            let mf = self.m as f64;
            0.5 * (jp_l * jp_l + (1.0 - mf * mf / (l * l)) * jm_l * jm_l)
        } else {
            (x * jm_l * jp_x - l * jm_x * jp_l) / d
        };
        let ij = (l * ip_l * jm_x - x * jp_x) / (l * l + x * x);
        self.norm * (jj + self.c * ij)
    }
}

/// Composite 8-point Gauss-Legendre nodes on `0..1`.
pub struct Grid {
    pub r: Vec<f64>,
    pub w: Vec<f64>,
}

impl Grid {
    pub fn new(panels: usize) -> Self {
        const X: [f64; 4] = [0.183_434_642_495_649_8, 0.525_532_409_916_329, 0.796_666_477_413_626_7, 0.960_289_856_497_536_3];
        const W: [f64; 4] = [0.362_683_783_378_362, 0.313_706_645_877_887_3, 0.222_381_034_453_374_5, 0.101_228_536_290_376_3];
        let (mut r, mut w) = (Vec::with_capacity(panels * 8), Vec::with_capacity(panels * 8));
        let hw = 0.5 / panels as f64;
        for p in 0..panels {
            let mid = (p as f64 + 0.5) / panels as f64;
            for i in 0..4 {
                for s in [-1.0, 1.0] {
                    r.push(mid + s * X[i] * hw);
                    w.push(W[i] * hw);
                }
            }
        }
        Self { r, w }
    }
}

/// A radial function tabulated on a grid: value, first and second derivative, Laplacian.
pub struct Tab {
    pub m: u32,
    pub v: Vec<f64>,
    pub d1: Vec<f64>,
    pub d2: Vec<f64>,
    pub lap: Vec<f64>,
}

impl Tab {
    pub fn new(parts: &[(Radial, f64)], grid: &Grid) -> Self {
        let n = grid.r.len();
        let mut t = Tab { m: parts[0].0.m, v: vec![0.0; n], d1: vec![0.0; n], d2: vec![0.0; n], lap: vec![0.0; n] };
        for (radial, coef) in parts {
            for (i, &r) in grid.r.iter().enumerate() {
                let e = radial.eval(r);
                t.v[i] += coef * e[0];
                t.d1[i] += coef * e[1];
                t.d2[i] += coef * e[2];
                t.lap[i] += coef * e[3];
            }
        }
        t
    }
}

/// `integral over the disc of cos(j theta) cos(l theta) dtheta`.
fn angular(j: u32, l: u32) -> f64 {
    if j != l {
        0.0
    } else if j == 0 {
        2.0 * PI
    } else {
        PI
    }
}

/// `integral P L(f, g) dA` over the unit disc, for `P = P(r) cos(m_P theta)` and likewise `f`, `g`.
///
/// With `f = F(r) cos(a theta)`, `g = G(r) cos(b theta)`:
/// `L(f, g) = cos((a - b) theta) (A/2 - a b B) + cos((a + b) theta) (A/2 + a b B)`, where
/// `A = F'' (G'/r - b^2 G / r^2) + G'' (F'/r - a^2 F / r^2)` and
/// `B = (F'/r - F / r^2)(G'/r - G / r^2)`.
pub fn project(p: &Tab, f: &Tab, g: &Tab, grid: &Grid) -> f64 {
    let (a, b) = (f.m, g.m);
    let (lo, hi) = (a.abs_diff(b), a + b);
    let (wl, wh) = (angular(p.m, lo), angular(p.m, hi));
    if wl == 0.0 && wh == 0.0 {
        return 0.0;
    }
    let (af, bf, ab) = ((a * a) as f64, (b * b) as f64, (a * b) as f64);
    let (mut sl, mut sh) = (0.0, 0.0);
    for i in 0..grid.r.len() {
        let r = grid.r[i];
        let (fv, f1, f2) = (f.v[i], f.d1[i], f.d2[i]);
        let (gv, g1, g2) = (g.v[i], g.d1[i], g.d2[i]);
        let aa = f2 * (g1 / r - bf * gv / (r * r)) + g2 * (f1 / r - af * fv / (r * r));
        let bb = (f1 / r - fv / (r * r)) * (g1 / r - gv / (r * r));
        let wgt = p.v[i] * r * grid.w[i];
        sl += wgt * (0.5 * aa - ab * bb);
        sh += wgt * (0.5 * aa + ab * bb);
    }
    wl * sl + wh * sh
}

/// `integral P del^2 f dA` over the unit disc.
pub fn project_laplacian(p: &Tab, f: &Tab, grid: &Grid) -> f64 {
    let w = angular(p.m, f.m);
    if w == 0.0 {
        return 0.0;
    }
    w * (0.. grid.r.len()).map(|i| p.v[i] * f.lap[i] * grid.r[i] * grid.w[i]).sum::<f64>()
}

/// The roots of `det` between `lo` and `hi`, by a scan (step `step`) and bisection.
fn roots(det: impl Fn(f64) -> f64, lo: f64, hi: f64, step: f64) -> Vec<f64> {
    let mut out = Vec::new();
    let mut x = lo;
    let mut fx = det(x);
    while x < hi {
        let x2 = x + step;
        let f2 = det(x2);
        if fx * f2 < 0.0 {
            let (mut a, mut b, mut fa) = (x, x2, fx);
            for _ in 0..52 {
                let mid = 0.5 * (a + b);
                let fm = det(mid);
                if fm * fa <= 0.0 {
                    b = mid;
                } else {
                    a = mid;
                    fa = fm;
                }
            }
            let r = 0.5 * (a + b);
            if r <= hi {
                out.push(r);
            }
        }
        x = x2;
        fx = f2;
    }
    out
}

/// `J_m`, `I_m / I_m(lambda)` and their first two derivatives (in the argument) at `lambda`.
fn edge(m: u32, l: f64) -> ([f64; 3], [f64; 3]) {
    let m = m as i32;
    let (mut j, mut i) = ([0.0f64; 5], [0.0f64; 5]);
    jn_range(m - 2, m + 2, l, &mut j);
    in_scaled_range(m - 2, m + 2, l, &mut i);
    let s = 1.0 / i[2];
    ([j[2], 0.5 * (j[1] - j[3]), 0.25 * (j[0] - 2.0 * j[2] + j[4])], [1.0, 0.5 * (i[1] + i[3]) * s, 0.25 * (i[0] + 2.0 * i[2] + i[4]) * s])
}

/// The free edge's two conditions for `J_m + C I_m`: `(moment of J, moment of I, shear of J, shear
/// of I)`.
fn free_edge(m: u32, l: f64, nu: f64) -> [f64; 4] {
    let (j, i) = edge(m, l);
    let m2 = (m * m) as f64;
    let moment = |z: [f64; 3]| l * l * z[2] + nu * (l * z[1] - m2 * z[0]);
    // Kirchhoff shear: d/dr del^2 W + (1 - nu) (1/r^2) d^2/dtheta^2 (W' - W / r), at r = 1.
    let twist = |z: [f64; 3]| -(1.0 - nu) * m2 * (l * z[1] - z[0]);
    [moment(j), moment(i), -l * l * l * j[1] + twist(j), l * l * l * i[1] + twist(i)]
}

/// The free-edge modes of order `m` with `lambda` below `max`: their `lambda`s and shapes.
pub fn free_modes(m: u32, nu: f64, max: f64) -> Vec<Radial> {
    let det = |l: f64| {
        let e = free_edge(m, l, nu);
        e[0] * e[3] - e[1] * e[2]
    };
    roots(det, 0.4, max, 0.05)
        .into_iter()
        .map(|l| {
            let e = free_edge(m, l, nu);
            Radial::new(m, l, -e[0] / e[1])
        })
        .collect()
}

/// The free-edge modes of order `m` with `lambda` within `lo..hi`.
pub fn free_modes_between(m: u32, nu: f64, lo: f64, hi: f64) -> Vec<Radial> {
    let det = |l: f64| {
        let e = free_edge(m, l, nu);
        e[0] * e[3] - e[1] * e[2]
    };
    roots(det, lo.max(0.4), hi, 0.05)
        .into_iter()
        .map(|l| {
            let e = free_edge(m, l, nu);
            Radial::new(m, l, -e[0] / e[1])
        })
        .collect()
}

/// The in-plane (Airy) functions of order `m` with `zeta` below `max`: `J_m + C I_m` with value and
/// slope zero at the edge (the modes of a clamped plate).
pub fn airy_modes(m: u32, max: f64) -> Vec<Radial> {
    let det = |l: f64| {
        let (j, i) = edge(m, l);
        j[0] * i[1] - i[0] * j[1]
    };
    roots(det, 0.4, max, 0.05).into_iter().map(|l| Radial::new(m, l, -edge(m, l).0[0])).collect()
}

/// What part a mode plays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModeKind {
    /// A shell mode in the nonlinear (von Karman) set.
    Nonlinear,
    /// A flat-plate mode above that set, linear, with the dome's short-wave stiffness added.
    Linear,
    /// The whole plate bouncing or rocking on its stand.
    Rigid,
    /// A sampled high-band mode standing for `count` modes (see `membrane::MembraneOptions`).
    Sampled,
}

/// One mode of the plate.
#[derive(Clone, Debug, PartialEq)]
pub struct PlateMode {
    pub m: u32,
    pub kind: ModeKind,
    /// The radial shape as a sum of flat-plate shapes of order `m` (one, except for shell modes).
    pub parts: Vec<(Radial, f64)>,
    /// Frequency of the flat plate's mode (for a shell mode: of its largest part), and the mode's
    /// own, Hz.
    pub flat_freq: f32,
    pub freq: f32,
    pub count: f32,
    /// For a sampled mode, the plane wave standing in for its shape (see `membrane::MembraneMode`).
    pub orient: f32,
    pub phase: f32,
    pub lambda: f32,
    /// Radiation resistance, both faces, kg/s.
    pub resistance: f32,
    pub spec: ModeSpec,
}

/// Which modes a plate is built with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlateOptions {
    /// Flat-plate modes up to this frequency (Hz) take part in the von Karman coupling.
    pub nonlinear_freq: f32,
    /// In-plane functions up to `zeta = inplane * lambda` of the highest nonlinear mode.
    pub inplane: f32,
    /// Every mode up to this frequency (Hz) is kept (cosine members: strikes are on `theta = 0`).
    pub complete_freq: f32,
    /// Sampled modes per octave above it, up to `max_freq` Hz.
    pub high_band_per_octave: f32,
    pub max_freq: f32,
    /// Couplings `H^k_pq` smaller than this fraction of the largest for the same `k` are dropped.
    pub prune: f32,
    pub seed: u32,
}

impl PlateOptions {
    pub fn standard() -> Self {
        Self { nonlinear_freq: 2000.0, inplane: 1.2, complete_freq: 5000.0, high_band_per_octave: 40.0, max_freq: 16_000.0, prune: 0.0, seed: 1 }
    }
}

/// The von Karman couplings among the nonlinear set, in the flat-plate basis (see `vonkarman`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Couplings {
    /// Per order: the body indices of its shell modes, and `V` (flat-plate x shell, row-major): the
    /// flat-plate amplitudes are `V q_shell`. Flat-plate indices run order by order.
    pub blocks: Vec<(u32, Vec<usize>, Vec<f64>)>,
    /// Per in-plane function `k`: `c_k` (J), its entries `(p, q, H)` with `p <= q` (1/m^2), and its
    /// linear entries `(p, B)` (1/m).
    pub c: Vec<f64>,
    pub quad: Vec<Vec<(u16, u16, f64)>>,
    pub lin: Vec<Vec<(u16, f64)>>,
    /// Flat-plate basis size.
    pub n: usize,
    /// Couplings before pruning.
    pub full: usize,
}

pub struct Plate {
    pub spec: PlateSpec,
    pub options: PlateOptions,
    /// In body order: the nonlinear set, the other complete-band modes, the rigid modes, the sampled
    /// high band.
    pub modes: Vec<PlateMode>,
    pub nonlinear: usize,
    /// Modes `0..coupled` take part in contacts (all but the sampled band).
    pub coupled: usize,
    pub couplings: Couplings,
}

/// The symmetric eigenproblem of `a` (`n x n`, row-major) by cyclic Jacobi: eigenvalues, and the
/// eigenvectors as the columns of a row-major matrix.
pub fn sym_eigen(a: &[f64], n: usize) -> (Vec<f64>, Vec<f64>) {
    let mut a = a.to_vec();
    let mut v = vec![0.0; n * n];
    for i in 0..n {
        v[i * n + i] = 1.0;
    }
    for _ in 0..100 {
        let off: f64 = (0..n).flat_map(|i| (0..n).filter(move |&j| j != i).map(move |j| (i, j))).map(|(i, j)| a[i * n + j].powi(2)).sum();
        let diag: f64 = (0..n).map(|i| a[i * n + i].powi(2)).sum();
        if off <= 1.0e-26 * diag.max(1.0e-300) {
            break;
        }
        for p in 0..n {
            for q in p + 1..n {
                let apq = a[p * n + q];
                if apq.abs() < 1.0e-300 {
                    continue;
                }
                let theta = (a[q * n + q] - a[p * n + p]) / (2.0 * apq);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let t = if theta == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..n {
                    let (akp, akq) = (a[k * n + p], a[k * n + q]);
                    a[k * n + p] = c * akp - s * akq;
                    a[k * n + q] = s * akp + c * akq;
                }
                for k in 0..n {
                    let (apk, aqk) = (a[p * n + k], a[q * n + k]);
                    a[p * n + k] = c * apk - s * aqk;
                    a[q * n + k] = s * apk + c * aqk;
                }
                for k in 0..n {
                    let (vkp, vkq) = (v[k * n + p], v[k * n + q]);
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    ((0..n).map(|i| a[i * n + i]).collect(), v)
}

/// Radiation resistance (kg/s, both faces) of a mode whose shape is `parts`, ringing at `freq` Hz.
///
/// The baffled Rayleigh integral in the wavenumber domain (see `membrane::radiation`): only the part
/// of the shape's spectrum inside the acoustic wavenumber radiates. With `x = u sin(phi)` the integral
/// over it has no singularity.
fn resistance(spec: &PlateSpec, parts: &[(Radial, f64)], freq: f64) -> f64 {
    let a = spec.radius as f64;
    let omega = 2.0 * PI * freq;
    let u = omega * a / C_AIR as f64;
    if u <= 0.0 || parts[0].0.lambda == 0.0 {
        return 0.0;
    }
    let m = parts[0].0.m;
    let cm = if m == 0 { 2.0 * PI } else { PI };
    let n = ((8.0 * u) as usize).max(64);
    let f = |phi: f64| {
        let x = u * phi.sin();
        let h: f64 = parts.iter().map(|(r, c)| c * r.hankel(x)).sum();
        h * h * x
    };
    let dphi = 0.5 * PI / n as f64;
    let mut acc = f(0.0) + f(0.5 * PI);
    for i in 1..n {
        acc += f(i as f64 * dphi) * if i % 2 == 1 { 4.0 } else { 2.0 };
    }
    let r_nd = cm * acc * dphi / 3.0;
    2.0 * RHO_AIR as f64 * omega * a * a * a * r_nd
}

impl Plate {
    pub fn new(spec: PlateSpec, options: PlateOptions) -> Self {
        // Built plates are cached by description: the root searches and coupling integrals take a
        // moment, and the same cymbal is built again for every voice.
        static BUILT: OnceLock<Mutex<HashMap<String, (Vec<PlateMode>, usize, usize, Couplings)>>> = OnceLock::new();
        let key = format!("{spec:?}{options:?}");
        let built = BUILT.get_or_init(|| Mutex::new(HashMap::new()));
        if let Some((modes, nonlinear, coupled, couplings)) = built.lock().unwrap().get(&key) {
            return Self { spec, options, modes: modes.clone(), nonlinear: *nonlinear, coupled: *coupled, couplings: couplings.clone() };
        }
        let p = Self::build(spec, options);
        let mut map = built.lock().unwrap();
        if map.len() > 64 {
            map.clear();
        }
        map.insert(key, (p.modes.clone(), p.nonlinear, p.coupled, p.couplings.clone()));
        p
    }

    fn build(spec: PlateSpec, o: PlateOptions) -> Self {
        let nu = spec.poisson as f64;
        let mass = spec.mass();
        let a = spec.radius as f64;
        let top = o.max_freq.min(0.45 * 48_000.0) as f64;
        let l_nl = spec.lambda_of(o.nonlinear_freq as f64);
        let l_complete = spec.lambda_of(o.complete_freq as f64).max(l_nl);
        let decay = |f: f64| spec.loss as f64 + spec.loss_hf as f64 * f / 1000.0;

        // Every flat-plate mode (cosine member) up to the complete band, by order.
        let mut flat: Vec<Radial> = Vec::new();
        for m in 0..(super::bessel::MAX_RANGE as u32 - 4) {
            let ms = free_modes(m, nu, l_complete);
            if ms.is_empty() {
                break;
            }
            flat.extend(ms);
        }
        let nl: Vec<Radial> = {
            let mut v: Vec<Radial> = flat.iter().copied().filter(|r| r.lambda <= l_nl).collect();
            v.sort_by(|x, y| x.m.cmp(&y.m).then(x.lambda.partial_cmp(&y.lambda).unwrap()));
            v
        };
        let max_order = nl.iter().map(|r| r.m).max().unwrap_or(0);

        // The in-plane functions, and every coupling of the nonlinear set.
        let zeta_max = o.inplane as f64 * nl.iter().map(|r| r.lambda).fold(0.0, f64::max);
        let panels = ((zeta_max + 2.0 * l_complete) / 3.0) as usize + 16;
        let grid = Grid::new(panels);
        let mut airy: Vec<Radial> = Vec::new();
        for j in 0..=(2 * max_order) {
            airy.extend(airy_modes(j, zeta_max));
        }
        let tabs: Vec<Tab> = nl.iter().map(|r| Tab::new(&[(*r, 1.0)], &grid)).collect();
        let airy_tabs: Vec<Tab> = airy.iter().map(|r| Tab::new(&[(*r, 1.0)], &grid)).collect();
        let (e, h) = (spec.young as f64, spec.thickness as f64);
        let dome = if spec.dome_radius == 0.0 { 0.0 } else { 2.0 / spec.dome_radius as f64 };
        let mut couplings = Couplings { n: nl.len(), ..Default::default() };
        for (k, psi) in airy.iter().enumerate() {
            let c = e * h * a * a / (8.0 * PI * psi.lambda.powi(4));
            let mut quad = Vec::new();
            for p in 0..nl.len() {
                for q in p..nl.len() {
                    let (mp, mq) = (nl[p].m, nl[q].m);
                    if psi.m != mp + mq && psi.m != mp.abs_diff(mq) {
                        continue;
                    }
                    let v = project(&airy_tabs[k], &tabs[p], &tabs[q], &grid) / (a * a);
                    if v != 0.0 {
                        quad.push((p as u16, q as u16, v));
                    }
                }
            }
            couplings.full += quad.len();
            let lin: Vec<(u16, f64)> = if dome == 0.0 {
                Vec::new()
            } else {
                (0..nl.len()).filter(|&p| nl[p].m == psi.m).map(|p| (p as u16, dome * project_laplacian(&airy_tabs[k], &tabs[p], &grid))).collect()
            };
            if quad.is_empty() && lin.is_empty() {
                continue;
            }
            couplings.c.push(c);
            couplings.quad.push(quad);
            couplings.lin.push(lin);
        }

        // Pruning: each coupling's weight in the energy is `sqrt(c_k) |H|` (U is a sum of squares of
        // `sqrt(c_k) P_k`); drop those below `prune` of the largest.
        let big = couplings.c.iter().zip(&couplings.quad).flat_map(|(c, q)| q.iter().map(move |e| c.sqrt() * e.2.abs())).fold(0.0f64, f64::max);
        for (c, q) in couplings.c.iter().zip(couplings.quad.iter_mut()) {
            q.retain(|e| c.sqrt() * e.2.abs() >= o.prune as f64 * big);
        }

        // Shell modes: per order, the flat modes plus the dome's stiffness `2 sum c_k B_k B_k^T`.
        let omega = |r: &Radial| 2.0 * PI * spec.freq_of(r.lambda);
        let mut modes: Vec<PlateMode> = Vec::new();
        let mut blocks: Vec<(u32, Vec<usize>, Vec<f64>)> = Vec::new();
        let mut start = 0;
        while start < nl.len() {
            let m = nl[start].m;
            let end = (start..nl.len()).find(|&i| nl[i].m != m).unwrap_or(nl.len());
            let nb = end - start;
            let mut kmat = vec![0.0; nb * nb];
            for i in 0..nb {
                kmat[i * nb + i] = omega(&nl[start + i]).powi(2);
            }
            for (k, lin) in couplings.lin.iter().enumerate() {
                for &(p, bp) in lin.iter().filter(|e| (e.0 as usize) >= start && (e.0 as usize) < end) {
                    for &(q, bq) in lin.iter().filter(|e| (e.0 as usize) >= start && (e.0 as usize) < end) {
                        kmat[(p as usize - start) * nb + (q as usize - start)] += 2.0 * couplings.c[k] * bp * bq / mass;
                    }
                }
            }
            let (vals, vecs) = sym_eigen(&kmat, nb);
            let mut shells = Vec::new();
            for s in 0..nb {
                let parts: Vec<(Radial, f64)> = (0..nb).map(|i| (nl[start + i], vecs[i * nb + s])).collect();
                let main = (0..nb).max_by(|&x, &y| vecs[x * nb + s].abs().partial_cmp(&vecs[y * nb + s].abs()).unwrap()).unwrap();
                let f = vals[s].max(0.0).sqrt() / (2.0 * PI);
                shells.push(modes.len());
                modes.push(PlateMode { m, kind: ModeKind::Nonlinear, parts, flat_freq: spec.freq_of(nl[start + main].lambda) as f32, freq: f as f32, count: 1.0, orient: 0.0, phase: 0.0, lambda: nl[start + main].lambda as f32, resistance: 0.0, spec: ModeSpec::default() });
            }
            blocks.push((m, shells, vecs));
            start = end;
        }
        // Body order: sort the shell modes by frequency, and renumber the blocks' columns.
        let mut order: Vec<usize> = (0..modes.len()).collect();
        order.sort_by(|&x, &y| modes[x].freq.partial_cmp(&modes[y].freq).unwrap());
        let mut place = vec![0; modes.len()];
        for (new, &old) in order.iter().enumerate() {
            place[old] = new;
        }
        modes = order.iter().map(|&i| modes[i].clone()).collect();
        for b in blocks.iter_mut() {
            b.1.iter_mut().for_each(|i| *i = place[*i]);
        }
        couplings.blocks = blocks;
        let nonlinear = modes.len();

        // The rest of the complete band: flat modes with the dome's short-wave stiffness.
        let mut rest: Vec<Radial> = flat.iter().copied().filter(|r| r.lambda > l_nl).collect();
        rest.sort_by(|x, y| x.lambda.partial_cmp(&y.lambda).unwrap());
        for r in rest {
            let f = (omega(&r).powi(2) + spec.dome_omega2()).sqrt() / (2.0 * PI);
            if f > top {
                continue;
            }
            modes.push(PlateMode { m: r.m, kind: ModeKind::Linear, parts: vec![(r, 1.0)], flat_freq: spec.freq_of(r.lambda) as f32, freq: f as f32, count: 1.0, orient: 0.0, phase: 0.0, lambda: r.lambda as f32, resistance: 0.0, spec: ModeSpec::default() });
        }
        // The stand.
        for (m, f) in [(0u32, spec.mount_freq), (1, spec.rock_freq)] {
            if f > 0.0 {
                modes.push(PlateMode { m, kind: ModeKind::Rigid, parts: vec![(Radial::rigid(m), 1.0)], flat_freq: 0.0, freq: f, count: 1.0, orient: 0.0, phase: 0.0, lambda: 0.0, resistance: 0.0, spec: ModeSpec::default() });
            }
        }
        let coupled = modes.len();

        // The sampled high band.
        if o.high_band_per_octave > 0.0 {
            let mut rng = crate::audio::physmod::dsp::Noise(0x85EB_CA6B ^ o.seed.wrapping_mul(2_654_435_761).max(1));
            let step = 2f64.powf(0.5 / o.high_band_per_octave as f64);
            let l_max = spec.lambda_of(top);
            let mut lo = l_complete;
            while lo * step <= l_max {
                let hi = lo * step;
                let target = (lo * lo + rng.unit() as f64 * (hi * hi - lo * lo)).sqrt();
                let m_max = (target - 1.0).max(0.0) as u32;
                let pick = |rng: &mut crate::audio::physmod::dsp::Noise, m_top: u32| -> Option<Radial> {
                    for _ in 0..8 {
                        let m = ((rng.unit() as f64 * (m_top + 1) as f64) as u32).min(m_top);
                        if let Some(r) = free_modes_between(m, nu, target - 1.6, target + 1.6).into_iter().min_by(|x, y| (x.lambda - target).abs().partial_cmp(&(y.lambda - target).abs()).unwrap()) {
                            return Some(r);
                        }
                    }
                    None
                };
                if let Some(r) = pick(&mut rng, m_max) {
                    let count = (hi * hi - lo * lo) / 4.0;
                    let f = (omega(&r).powi(2) + spec.dome_omega2()).sqrt() / (2.0 * PI);
                    // The slice's mean radiation: orders above ka hardly radiate (their angular
                    // variation is evanescent in the air), so the fraction that can, times the mean of
                    // a few that do.
                    let u = 2.0 * PI * f * a / C_AIR as f64;
                    let radiating = (u.floor() as u32).min(m_max);
                    let mut rs = Vec::new();
                    for _ in 0..3 {
                        if let Some(rr) = pick(&mut rng, radiating) {
                            rs.push(resistance(&spec, &[(rr, 1.0)], f));
                        }
                    }
                    let res = if rs.is_empty() { 0.0 } else { rs.iter().sum::<f64>() / rs.len() as f64 * (radiating + 1) as f64 / (m_max + 1) as f64 };
                    let mut md = PlateMode { m: r.m, kind: ModeKind::Sampled, parts: vec![(r, 1.0)], flat_freq: spec.freq_of(r.lambda) as f32, freq: f as f32, count: count as f32, orient: rng.unit() * std::f32::consts::TAU, phase: rng.unit() * std::f32::consts::TAU, lambda: r.lambda as f32, resistance: res as f32, spec: ModeSpec::default() };
                    md.spec = Self::mode_spec(&spec, &md, decay(f), mass);
                    modes.push(md);
                }
                lo = hi;
            }
        }

        // Radiation and losses of the rest.
        for md in modes.iter_mut().filter(|m| m.kind != ModeKind::Sampled) {
            if md.kind == ModeKind::Rigid {
                // Felt: heavily damped, and a whole cymbal swaying a few times a second doesn't sound.
                md.spec = ModeSpec { freq: md.freq, sigma: std::f32::consts::PI * md.freq / spec.mount_q.max(0.1), mass: mass as f32, radiation: 0.0 };
                continue;
            }
            md.resistance = resistance(&spec, &md.parts, md.freq as f64) as f32;
            md.spec = Self::mode_spec(&spec, md, decay(md.freq as f64), mass);
        }
        Self { spec, options: o, modes, nonlinear, coupled, couplings }
    }

    /// A mode's decay, mass and radiated weight (as `membrane`: pressure at 1 m per unit modal
    /// acceleration from the power it radiates, signed for axisymmetric modes, whose far fields add).
    fn mode_spec(spec: &PlateSpec, md: &PlateMode, loss: f64, mass: f64) -> ModeSpec {
        let (rho, c) = (RHO_AIR as f64, C_AIR as f64);
        let r = md.resistance as f64 / md.count as f64;
        let k = 2.0 * PI * md.freq as f64 / c;
        let v_eff = if r > 0.0 { (2.0 * PI * r / (rho * c * k * k)).sqrt() } else { 0.0 };
        let sign = if md.m == 0 && md.count == 1.0 {
            let g = Grid::new(8);
            let vol: f64 = md.parts.iter().map(|(rad, cf)| cf * g.r.iter().zip(&g.w).map(|(&x, &w)| rad.eval(x)[0] * x * w).sum::<f64>()).sum();
            vol.signum()
        } else {
            1.0
        };
        let _ = spec;
        ModeSpec { freq: md.freq, sigma: (loss + md.resistance as f64 / (2.0 * mass)) as f32, mass: (mass / md.count as f64) as f32, radiation: (-(rho / (2.0 * PI)) * v_eff * sign / (md.count as f64).sqrt()) as f32 }
    }

    pub fn mode_specs(&self) -> Vec<ModeSpec> {
        self.modes.iter().map(|m| m.spec).collect()
    }

    /// Each mode's shape at radius `r` (fraction of the radius) and angle `theta`, into `out`.
    /// Allocation-free.
    pub fn shape_at(&self, r: f32, theta: f32, out: &mut [f32]) {
        let r = r.clamp(0.0, 1.0) as f64;
        let (px, py) = (r * (theta as f64).cos(), r * (theta as f64).sin());
        for (o, md) in out.iter_mut().zip(self.modes.iter()) {
            if md.kind == ModeKind::Sampled {
                let (dx, dy) = ((md.orient as f64).cos(), (md.orient as f64).sin());
                *o = (std::f64::consts::SQRT_2 * (md.lambda as f64 * (dx * px + dy * py) + md.phase as f64).cos()) as f32;
                continue;
            }
            let w: f64 = md.parts.iter().map(|(rad, c)| c * rad.eval(r)[0]).sum();
            *o = (w * (md.m as f64 * theta as f64).cos()) as f32;
        }
    }
}

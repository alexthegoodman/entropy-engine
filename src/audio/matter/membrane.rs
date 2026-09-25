//! A stretched circular membrane: a drumhead.
//!
//! Its modes are those of an ideal membrane of radius `a` under tension `T` (N/m) with surface
//! density `sigma` (kg/m^2): shapes `J_m(j_mn r / a) cos(m theta)`, wavenumbers `k_mn = j_mn / a`,
//! with `j_mn` the zeros of `J_m`. Each shape is normalized to a mean square of one over the head, so
//! a mode's own mass is simply the head's mass `sigma pi a^2`.
//!
//! Three things make a real head differ from the textbook one, and all three are computed:
//!
//! * **Air loading.** The air next to the head moves with it. Its pressure on each mode is the
//!   Rayleigh integral, which in the wavenumber domain needs only the mode's Hankel transform
//!   `F_mn(kappa)`: the part of its spectrum beyond the acoustic wavenumber `k` is evanescent and
//!   loads the mode with mass, the part below radiates and damps it (see [`radiation`]). Low modes,
//!   whose spectra sit at small wavenumbers, carry far more air than high ones, which is what pulls a
//!   timpani's `(m,1)` modes toward a harmonic series. The same numbers give each mode's radiation
//!   damping and its weight in the radiated sound: one computation, no fitting.
//! * **The enclosed air** is a spring on the modes that change the volume (the `m = 0` ones), and
//!   couples the heads of a drum; that lives in `drum`, which owns the cavity. Here each mode reports
//!   the volume it sweeps.
//! * **Tension modulation.** A displaced head is stretched, so its tension rises by
//!   `E h / (4 (1 - nu)) * sum k^2 q^2` (uniform in-plane strain; exact for these shapes since their
//!   gradients are orthogonal with `integral |grad phi|^2 = k^2 A`). Every mode's frequency rises by
//!   `sqrt(T / T0)`, so a hard hit starts sharp and glides down as it decays.
//!
//! The head is taken as baffled on its outer side (by the shell and the air around it) for radiation;
//! the inner side is loaded with the same air mass, and its compressibility is the cavity's spring.

use super::bessel::{jn, jn_zeros};
use super::modal::ModeSpec;
use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::{Mutex, OnceLock};

pub const RHO_AIR: f32 = 1.2;
pub const C_AIR: f32 = 343.0;

/// A drumhead, SI units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HeadSpec {
    /// Radius, m.
    pub radius: f32,
    /// Tension, N/m.
    pub tension: f32,
    /// Film thickness, m (all plies).
    pub thickness: f32,
    /// Film material (polyester film for modern heads).
    pub young: f32,
    pub poisson: f32,
    pub density: f32,
    /// Internal and edge losses: amplitude decay rate at low frequency (1/s)...
    pub loss: f32,
    /// ...plus this much per kHz of mode frequency (1/s per kHz).
    pub loss_hf: f32,
    /// Radiation into the room from the outer side; false for a head whose outside is closed off.
    pub radiates: bool,
}

impl HeadSpec {
    /// A single-ply polyester head of `radius`, 0.19 mm (a typical 7.5 mil film).
    pub fn single_ply(radius: f32) -> Self {
        Self { radius, tension: 2000.0, thickness: 0.19e-3, young: 4.5e9, poisson: 0.38, density: 1390.0, loss: 1.2, loss_hf: 2.0, radiates: true }
    }

    /// A two-ply head (two 7 mil films): heavier, more damped, more durable.
    pub fn two_ply(radius: f32) -> Self {
        Self { thickness: 0.36e-3, loss: 3.0, loss_hf: 5.0, ..Self::single_ply(radius) }
    }

    pub fn surface_density(&self) -> f32 {
        self.density * self.thickness
    }

    pub fn area(&self) -> f32 {
        std::f32::consts::PI * self.radius * self.radius
    }
}

/// One mode of the head.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MembraneMode {
    pub m: u32,
    pub n: u32,
    /// Zero of `J_m`.
    pub j: f32,
    /// Normalization so the mean square of the shape over the head is one.
    pub norm: f32,
    /// Volume swept per metre of modal displacement, m^2 (`m = 0` only; zero otherwise).
    pub volume: f32,
    /// Air mass on the outer side, kg.
    pub air_mass: f32,
    /// Radiation resistance of the outer side, kg/s.
    pub resistance: f32,
    /// In-vacuo frequency and the loaded one, Hz.
    pub vacuum_freq: f32,
    pub freq: f32,
    pub spec: ModeSpec,
}

pub struct Membrane {
    pub spec: HeadSpec,
    pub modes: Vec<MembraneMode>,
}

/// The dimensionless radiation impedance of mode `(m, j)` of a baffled circular membrane at
/// `u = k a`: `(mass, resistance)` with the air mass `rho a^3 * mass` (kg) and resistance
/// `rho omega a^3 * resistance` (kg/s), for the shape normalized to mean square one.
///
/// In the wavenumber domain the Rayleigh integral becomes `rho / sqrt(kappa^2 - k^2)` weighting the
/// mode's spectrum `|Phi(kappa)|^2`: real (mass) beyond `k`, imaginary (resistance) below it. The
/// spectrum of `N J_m(j r / a) cos(m theta)` is `2 pi cos(m psi) F(kappa)` with the Hankel transform
/// in closed form (Lommel): `F(x) = N j J_m(x) J_m'(j) / (x^2 - j^2)` in units of `a`. Substituting
/// `s = sqrt(kappa^2 - k^2)` (and `t = sqrt(k^2 - kappa^2)` below `k`) removes the square-root
/// singularity, leaving smooth integrals done by Simpson's rule.
pub fn radiation(m: u32, j: f64, u: f64) -> (f64, f64) {
    let norm = mode_norm(m, j);
    let jp = if m == 0 { -jn(1, j) } else { -jn(m + 1, j) };
    let f = |x: f64| -> f64 {
        let d = x * x - j * j;
        if d.abs() < 1.0e-6 * j * j {
            // Removable singularity: the integral of J_m(j s)^2 s over the head.
            norm * 0.5 * jp * jp
        } else {
            norm * j * jn(m, x) * jp / d
        }
    };
    let cm = if m == 0 { 2.0 * PI } else { PI };
    // Mass: s from 0 to well past the spectral peak at x = j (F^2 falls as x^-5 beyond).
    let s_max = j + 80.0;
    let mass = cm * simpson(|s| { let x = (s * s + u * u).sqrt(); f(x).powi(2) }, 0.0, s_max, ((s_max / 0.1) as usize).max(64));
    let res = if u > 0.0 { cm * simpson(|t| { let x = (u * u - t * t).max(0.0).sqrt(); f(x).powi(2) }, 0.0, u, ((u / 0.05) as usize).max(32)) } else { 0.0 };
    (mass, res)
}

/// Normalization of `J_m(j r / a) cos(m theta)` to a mean square of one over the disc.
pub fn mode_norm(m: u32, j: f64) -> f64 {
    if m == 0 {
        1.0 / jn(1, j).abs()
    } else {
        std::f64::consts::SQRT_2 / jn(m + 1, j).abs()
    }
}

fn simpson(f: impl Fn(f64) -> f64, a: f64, b: f64, n: usize) -> f64 {
    let n = n + (n & 1);
    let h = (b - a) / n as f64;
    let mut acc = f(a) + f(b);
    for i in 1..n {
        acc += f(a + i as f64 * h) * if i % 2 == 1 { 4.0 } else { 2.0 };
    }
    acc * h / 3.0
}

/// The radiation integrals are the costly part of building a head, and drums are rebuilt with the
/// same modes at nearby frequencies all the time: cache them by mode and `ka` (to 0.1%).
fn radiation_cached(m: u32, n: u32, j: f64, u: f64) -> (f64, f64) {
    static CACHE: OnceLock<Mutex<HashMap<(u32, u32, i64), (f64, f64)>>> = OnceLock::new();
    let key = (m, n, (u.max(1.0e-6).ln() * 1000.0).round() as i64);
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = cache.lock().unwrap().get(&key) {
        return *v;
    }
    let v = radiation(m, j, u);
    cache.lock().unwrap().insert(key, v);
    v
}

/// The zeros of `J_m` for the orders and overtones a head uses, computed once.
fn zeros_table() -> &'static Vec<(u32, u32, f64)> {
    static TABLE: OnceLock<Vec<(u32, u32, f64)>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut all = Vec::new();
        for m in 0..MAX_ORDER {
            for (i, z) in jn_zeros(m, MAX_OVERTONE as usize).into_iter().enumerate() {
                all.push((m, i as u32 + 1, z));
            }
        }
        all.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap());
        all
    })
}

const MAX_ORDER: u32 = 56;
const MAX_OVERTONE: u32 = 24;

impl Membrane {
    /// The head's lowest `max_modes` modes (in `j`), those below `max_freq` Hz. With `air` false the
    /// head is in a vacuum: no added mass, no radiation.
    pub fn new(spec: HeadSpec, max_modes: usize, max_freq: f32, air: bool) -> Self {
        Self::build(spec, max_modes, max_freq, air, false)
    }

    /// Only the axisymmetric (`m = 0`) modes: all a head needs when nothing but the air in the
    /// shell drives it (a resonant head), since the air's pressure is uniform over the head.
    pub fn axisymmetric(spec: HeadSpec, max_modes: usize, max_freq: f32, air: bool) -> Self {
        Self::build(spec, max_modes, max_freq, air, true)
    }

    fn build(spec: HeadSpec, max_modes: usize, max_freq: f32, air: bool, only_axisymmetric: bool) -> Self {
        let a = spec.radius as f64;
        let sigma = spec.surface_density() as f64;
        let area = PI * a * a;
        let head_mass = sigma * area;
        let tension = spec.tension as f64;
        let rho = RHO_AIR as f64;
        let c = C_AIR as f64;
        let mut modes = Vec::with_capacity(max_modes);
        // Beyond the first zero of the highest order used, the table stops being complete.
        let complete_below = jn_zeros(MAX_ORDER, 1)[0].min(zeros_table().iter().filter(|z| z.1 == MAX_OVERTONE).map(|z| z.2).fold(f64::MAX, f64::min));
        for &(m, n, j) in zeros_table().iter() {
            if modes.len() >= max_modes || j >= complete_below {
                break;
            }
            if only_axisymmetric && m != 0 {
                continue;
            }
            let k = j / a;
            let wv = (tension / sigma).sqrt() * k;
            if wv / (2.0 * PI) > max_freq as f64 {
                break;
            }
            let norm = mode_norm(m, j);
            let volume = if m == 0 { 2.0 * area * norm * jn(1, j) / j } else { 0.0 };
            let (mut w, mut air_mass, mut resistance) = (wv, 0.0, 0.0);
            if air {
                // The load depends on the frequency, the frequency on the load: iterate.
                for _ in 0..4 {
                    let u = w * a / c;
                    let (mh, rh) = radiation_cached(m, n, j, u);
                    air_mass = rho * a * a * a * mh;
                    resistance = if spec.radiates { rho * w * a * a * a * rh } else { 0.0 };
                    // Both sides carry the air's mass; only the outer side radiates.
                    w = (tension * k * k * area / (head_mass + 2.0 * air_mass)).sqrt();
                }
            }
            let total_mass = head_mass + 2.0 * air_mass;
            let f = w / (2.0 * PI);
            let decay = spec.loss as f64 + spec.loss_hf as f64 * f / 1000.0 + resistance / (2.0 * total_mass);
            // Radiated pressure at 1 m (half-space) per unit modal acceleration: rho / (2 pi) times the
            // monopole volume radiating the same power, sqrt(2 pi R / (rho c k^2)); signed for the
            // volume-changing modes, whose far fields add. The head moving *in* (positive q) sends a
            // negative pulse out.
            let kk = w / c;
            let v_eff = if resistance > 0.0 { (2.0 * PI * resistance / (rho * c * kk * kk)).sqrt() } else { 0.0 };
            let v_eff = if m == 0 { v_eff * volume.signum() } else { v_eff };
            let radiation = -(rho / (2.0 * PI)) * v_eff;
            modes.push(MembraneMode {
                m,
                n,
                j: j as f32,
                norm: norm as f32,
                volume: volume as f32,
                air_mass: air_mass as f32,
                resistance: resistance as f32,
                vacuum_freq: (wv / (2.0 * PI)) as f32,
                freq: f as f32,
                spec: ModeSpec { freq: f as f32, sigma: decay as f32, mass: total_mass as f32, radiation: radiation as f32 },
            });
        }
        Self { spec, modes }
    }

    /// The modes as a modal body needs them.
    pub fn mode_specs(&self) -> Vec<ModeSpec> {
        self.modes.iter().map(|m| m.spec).collect()
    }

    /// Each mode's shape at radius `r` (fraction of the radius, 0 = centre) and angle `theta` (rad),
    /// written into `out`.
    pub fn shape_at(&self, r: f32, theta: f32, out: &mut [f32]) {
        let r = r.clamp(0.0, 1.0) as f64;
        for (o, md) in out.iter_mut().zip(self.modes.iter()) {
            *o = (md.norm as f64 * jn(md.m, md.j as f64 * r) * (md.m as f64 * theta as f64).cos()) as f32;
        }
    }

    /// `E h / (4 (1 - nu))`: tension added (N/m) per unit of `sum k^2 q^2`.
    pub fn stretch_coefficient(&self) -> f32 {
        self.spec.young * self.spec.thickness / (4.0 * (1.0 - self.spec.poisson))
    }

    /// `k^2` of each mode (1/m^2), for the tension-modulation sum.
    pub fn wavenumbers_squared(&self) -> Vec<f32> {
        self.modes.iter().map(|m| (m.j / self.spec.radius).powi(2)).collect()
    }

    /// The tension (N/m) that puts mode `index` at `freq` Hz, air loading included.
    pub fn tension_for(spec: HeadSpec, index_m: u32, index_n: u32, freq: f32, air: bool) -> f32 {
        let mut s = spec;
        for _ in 0..6 {
            let mem = Membrane::new(s, 64, 1.0e6, air);
            let Some(md) = mem.modes.iter().find(|m| m.m == index_m && m.n == index_n) else { return s.tension };
            s.tension *= (freq / md.freq).powi(2);
        }
        s.tension
    }
}

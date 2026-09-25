//! The air inside a drum: a hard-walled cylinder closed by its heads, as a set of acoustic modes.
//!
//! Each mode has the shape `Psi = N J_m(alpha r / a) cos(m (theta - psi)) cos(l pi z / L)`, `alpha`
//! a zero of `J_m'` (the shell is rigid), normalized so `integral Psi^2 dV = V`, and frequency
//! `c sqrt((alpha / a)^2 + (l pi / L)^2)`. The heads drive it: with `D` the heads' displacement into
//! the cavity projected on `Psi` (`integral Psi w dA` over both heads),
//!
//! ```text
//! P'' + omega^2 P = (rho c^2 / V) D''
//! ```
//!
//! and it pushes back on every head mode `k` with the generalized force `-P integral Psi phi_k dA`.
//! Written as `P = (rho c^2 / V) (D - Y)` with `Y'' + omega^2 Y = omega^2 D`, the uniform mode
//! (`omega = 0`, so `Y = 0`) is the familiar air spring on the volume-changing modes; every other mode
//! follows `D` below its resonance and so presses back only as sloshing air (an added mass that grows
//! toward the resonance), and near it couples the heads strongly. The first transverse mode
//! (`m = 1`) is what ties the two heads' `(1,1)` modes together in a shallow drum like a snare.
//!
//! The overlap `integral Psi phi_k dA` of a head mode `J_m(j r / a) cos(m theta)` with a cavity mode of
//! the same order is Lommel's integral in closed form; modes of different order or orientation don't
//! couple.

use super::bessel::{jn, jn_prime, jn_prime_zeros};
use super::membrane::{Membrane, C_AIR, RHO_AIR};
use super::modal::{ModalBody, ModeSpec};
use std::f64::consts::PI;

/// Highest azimuthal order of the cavity modes kept.
pub const MAX_CAVITY_ORDER: u32 = 4;
/// Cavity modes are kept up to this frequency, Hz: well above the head modes they matter to (a
/// cavity mode loads a head mode far below it only as a little extra air mass).
const MAX_CAVITY_FREQ: f64 = 2000.0;
/// Couplings are dropped when they would change the head mode's effective stiffness by less than
/// this fraction. At frequency `omega`, a cavity mode presses on a head mode of mass `m` with the
/// stiffness `K C^2 omega^2 / (omega^2 - omega_c^2)` (`K = rho c^2 / V`, `C` their overlap; the
/// uniform mode, `omega_c = 0`, is the plain spring `K C^2`): relative to the mode's own `m omega^2`,
/// that is `K C^2 / (m |omega^2 - omega_c^2|)`. A thousandth is under a cent.
const MIN_EFFECT: f64 = 1.0e-3;
/// Quality factor of the non-uniform cavity modes (losses at the walls and through the heads).
const CAVITY_Q: f32 = 30.0;

#[derive(Clone, Copy, Debug)]
pub struct CavityMode {
    pub m: u32,
    pub l: u32,
    pub alpha: f32,
    pub orient: f32,
    pub freq: f32,
}

pub struct Cavity {
    pub modes: Vec<CavityMode>,
    /// `Y` of each non-uniform mode.
    osc: ModalBody,
    /// Per head, `(head mode, cavity mode, overlap m^2)`, sorted by head mode (for the forces)...
    pairs: [Vec<(u32, u32, f32)>; 2],
    /// ...and the same sorted by cavity mode (for the projections). Each loop then sums a run of
    /// entries in a register instead of waiting on the store of the one before.
    by_cavity: [Vec<(u32, u32, f32)>; 2],
    /// `rho c^2 / V`, Pa per m^3.
    stiffness: f32,
    d: Vec<f32>,
    /// Pressure amplitude of each mode this step.
    p: Vec<f32>,
    omega2: Vec<f32>,
}

impl Cavity {
    /// The air in a cylinder of the heads' radius and `depth` (0: only the uniform mode, for a
    /// vessel that isn't a cylinder, such as a timpani's kettle) and `volume`, closed by `heads` (the
    /// first at `z = 0`, a second at `z = depth`).
    pub fn new(heads: &[&Membrane], volume: f32, depth: f32, sr: f32) -> Self {
        let a = heads[0].spec.radius as f64;
        let v = volume as f64;
        let c = C_AIR as f64;
        let mut modes = Vec::new();
        let orders = if depth > 0.0 { MAX_CAVITY_ORDER } else { 0 };
        for m in 0..=orders {
            for alpha in jn_prime_zeros(m, 3) {
                for l in 0..=(if depth > 0.0 { 2 } else { 0 }) {
                    let kz = if depth > 0.0 { l as f64 * PI / depth as f64 } else { 0.0 };
                    let f = c * ((alpha / a).powi(2) + kz * kz).sqrt() / (2.0 * PI);
                    if f > MAX_CAVITY_FREQ || (depth <= 0.0 && (m, l) != (0, 0)) {
                        continue;
                    }
                    let orients: &[f64] = if m == 0 { &[0.0] } else { &[0.0, 0.5] };
                    for &o in orients {
                        let orient = if m == 0 { 0.0 } else { o * PI / m as f64 };
                        modes.push(CavityMode { m, l, alpha: alpha as f32, orient: orient as f32, freq: f as f32 });
                    }
                }
            }
        }
        let mut pairs: [Vec<(u32, u32, f32)>; 2] = [Vec::new(), Vec::new()];
        let k_air = RHO_AIR as f64 * c * c / v;
        for (i, cm) in modes.iter().enumerate() {
            let wc2 = (2.0 * PI * cm.freq as f64).powi(2);
            let (m, alpha) = (cm.m, cm.alpha as f64);
            // Normalization: integral Psi^2 dV = V.
            let radial = if alpha == 0.0 { 0.5 } else { 0.5 * (1.0 - (m as f64 / alpha).powi(2)) * jn(m, alpha).powi(2) };
            let theta = if m == 0 { 2.0 * PI } else { PI };
            let axial = if cm.l == 0 { depth.max(1.0e-6) as f64 } else { depth as f64 * 0.5 };
            let axial = if depth > 0.0 { axial } else { 1.0 };
            let nc = (v / (a * a * radial * theta * axial)).sqrt();
            for (h, head) in heads.iter().enumerate() {
                let end = if h == 0 || cm.l % 2 == 0 { 1.0 } else { -1.0 };
                for (k, hm) in head.modes.iter().enumerate() {
                    if hm.count != 1.0 || hm.m != m {
                        continue;
                    }
                    let angular = if m == 0 { 2.0 * PI } else { PI * (m as f64 * (cm.orient - hm.orient) as f64).cos() };
                    if angular.abs() < 1.0e-6 {
                        continue;
                    }
                    let j = hm.j as f64;
                    // Lommel: integral_0^1 J_m(alpha s) J_m(j s) s ds with J_m(j) = 0.
                    let radial_overlap = if (j - alpha).abs() < 1.0e-9 { 0.0 } else { -j * jn(m, alpha) * jn_prime(m, j) / (j * j - alpha * alpha) };
                    let overlap = end * nc * hm.norm as f64 * a * a * angular * radial_overlap;
                    let w2 = (2.0 * PI * hm.freq as f64).powi(2);
                    let effect = k_air * overlap * overlap / (hm.spec.mass as f64 * if cm.freq > 0.0 { (w2 - wc2).abs().max(1.0e-3 * wc2) } else { w2 });
                    if effect > MIN_EFFECT {
                        pairs[h.min(1)].push((k as u32, i as u32, overlap as f32));
                    }
                }
            }
        }
        let specs: Vec<ModeSpec> = modes.iter().map(|m| ModeSpec { freq: m.freq.max(1.0e-3), sigma: std::f32::consts::PI * m.freq / CAVITY_Q, mass: 1.0, radiation: 0.0 }).collect();
        let omega2 = modes.iter().map(|m| (std::f32::consts::TAU * m.freq).powi(2)).collect();
        let n = modes.len();
        for list in pairs.iter_mut() {
            list.sort_by_key(|p| (p.0, p.1));
        }
        let mut by_cavity = pairs.clone();
        for list in by_cavity.iter_mut() {
            list.sort_by_key(|p| (p.1, p.0));
        }
        Self { modes, osc: ModalBody::new(&specs, sr), pairs, by_cavity, stiffness: RHO_AIR * C_AIR * C_AIR / volume, d: vec![0.0; n], p: vec![0.0; n], omega2 }
    }

    /// The pressure of each mode from the heads' motion, applied back to the heads (the batter,
    /// then the resonant head if there is one) as modal forces for the coming step, and the cavity
    /// advanced one step.
    pub fn step(&mut self, batter: &mut ModalBody, reso: Option<&mut ModalBody>) {
        let d = &mut self.d[..];
        d.iter_mut().for_each(|v| *v = 0.0);
        let mut heads: [Option<&mut ModalBody>; 2] = [Some(batter), reso];
        for (h, list) in self.by_cavity.iter().enumerate() {
            let Some(body) = heads[h].as_mut() else { continue };
            let (q, _) = body.displacements_and_forces();
            let (mut cur, mut acc) = (u32::MAX, 0.0f32);
            for &(k, i, c) in list {
                if i != cur {
                    if cur != u32::MAX {
                        d[cur as usize] += acc;
                    }
                    cur = i;
                    acc = 0.0;
                }
                acc += c * q[k as usize];
            }
            if cur != u32::MAX {
                d[cur as usize] += acc;
            }
        }
        for i in 0..self.p.len() {
            let y = if self.omega2[i] > 0.0 { self.osc.q(i) } else { 0.0 };
            self.p[i] = self.stiffness * (d[i] - y);
        }
        for (h, list) in self.pairs.iter().enumerate() {
            let Some(body) = heads[h].as_mut() else { continue };
            let (_, force) = body.displacements_and_forces();
            let (mut cur, mut acc) = (u32::MAX, 0.0f32);
            for &(k, i, c) in list {
                if k != cur {
                    if cur != u32::MAX {
                        force[cur as usize] -= acc;
                    }
                    cur = k;
                    acc = 0.0;
                }
                acc += self.p[i as usize] * c;
            }
            if cur != u32::MAX {
                force[cur as usize] -= acc;
            }
        }
        for i in 0..self.modes.len() {
            if self.omega2[i] > 0.0 {
                self.osc.add_modal_force(i, self.omega2[i] * d[i]);
            }
        }
        self.osc.step();
    }

    /// Zeroes cavity modes that have fallen silent (before they turn subnormal; see
    /// `ModalBody::flush_quiet`).
    pub fn flush_quiet(&mut self) {
        self.osc.flush_quiet();
    }

    pub fn pair_count(&self) -> usize {
        self.pairs.iter().map(|p| p.len()).sum()
    }
}

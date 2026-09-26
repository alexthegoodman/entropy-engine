//! A face's mode shapes at *any* point, fast enough to follow a moving contact every few samples.
//!
//! A strike lands at one point, so its shape (one value per mode) is worked out once, with Bessel
//! functions, when it lands. A contact that slides - a brush swept across a head, a finger dragged
//! over glass - is at a new point every sample, and working the shapes out from scratch there would
//! cost hundreds of Bessel evaluations a sample. The shapes of a circular face separate, though:
//! every complete-band mode is a radial function times `cos(m (theta - orient))`. So the radial
//! functions (and their slopes) are tabulated once, when the body is built, and a point costs a
//! table lookup per mode plus the `cos(m theta)`, `sin(m theta)` of its angle, which a complex
//! power gives for every order at once. Sampled high-band modes are plane waves (see
//! `membrane::MembraneOptions`) and are evaluated directly.
//!
//! Besides the shape `phi_k` at a point, a map gives the slope of every mode along a direction,
//! `d phi_k / ds` (1/m). A tangential force on the surface of a plate of thickness `h` acts on its
//! bending modes through the moment it makes about the mid-plane, `F h / 2` - which is how a
//! finger rubbed across a glass pane, whose bending is all that sounds, makes it ring - and the
//! surface there slides by `-(h / 2) dw / ds` when the plate bends: both are the slope.
//!
//! Nothing here allocates after construction.

use super::bessel::{jn, jn_prime};
use super::membrane::Membrane;
use super::plate::{ModeKind, Plate};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// Radial table points from the centre to the edge. The highest complete-band modes of the kit's
/// heads and plates have `j` (or `lambda`) up to about 40, so a step is under 0.08 of a radian of
/// their argument and linear interpolation is good to about 1e-3.
const POINTS: usize = 512;

/// The tables of one face (shared between every map of the same face: see `SurfaceMap::cached`).
struct Tables {
    radius: f32,
    /// Modes mapped (in body order): `radial` modes first, then plane waves.
    n: usize,
    radial: usize,
    /// Per radial mode: its order, and `cos(m orient)`, `sin(m orient)`.
    order: Vec<u32>,
    co: Vec<f32>,
    so: Vec<f32>,
    /// `POINTS + 1` rows of `radial` values: the radial function, and its slope (per unit of the
    /// radius).
    value: Vec<f32>,
    slope: Vec<f32>,
    /// Per plane-wave mode: its wavenumber vector (per unit of the radius) and phase.
    kx: Vec<f32>,
    ky: Vec<f32>,
    phase: Vec<f32>,
}

/// One face's mode shapes, anywhere on it. See the module notes.
pub struct SurfaceMap {
    /// Radius of the face, m.
    pub radius: f32,
    t: Arc<Tables>,
    /// `cos(m theta)`, `sin(m theta)` for every order (scratch).
    cm: Vec<f32>,
    sm: Vec<f32>,
}

/// Maps already built, by a fingerprint of the modes they map: a kit's pieces are rebuilt with the
/// same heads and plates whenever it is retuned elsewhere, and a head's tables take a moment.
fn cache() -> &'static Mutex<HashMap<u64, Arc<Tables>>> {
    static BUILT: OnceLock<Mutex<HashMap<u64, Arc<Tables>>>> = OnceLock::new();
    BUILT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// FNV-1a over the bit patterns of `values`.
fn fingerprint(values: impl Iterator<Item = f32>) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for v in values {
        for b in v.to_bits().to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    h
}

impl SurfaceMap {
    /// A map of `n` modes of a face of `radius` m: modes `0..radial` are `R_k(r) cos(m_k (theta -
    /// orient_k))` with `R_k` and its slope given by `radial_fn(k, r) -> (R, dR/dr)` (r a fraction of
    /// the radius), the rest plane waves `sqrt(2) cos(k . x + phase)` from `plane_fn(k) -> (kx, ky,
    /// phase)`.
    fn build(radius: f32, n: usize, radial: usize, order_orient: impl Fn(usize) -> (u32, f32), radial_fn: impl Fn(usize, f64) -> (f64, f64) + Sync, plane_fn: impl Fn(usize) -> (f32, f32, f32)) -> Tables {
        let (mut order, mut co, mut so) = (Vec::with_capacity(radial), Vec::with_capacity(radial), Vec::with_capacity(radial));
        for k in 0..radial {
            let (m, orient) = order_orient(k);
            order.push(m);
            co.push((m as f32 * orient).cos());
            so.push((m as f32 * orient).sin());
        }
        let rows: Vec<(Vec<f32>, Vec<f32>)> = {
            let f = &radial_fn;
            let per = (POINTS + 1).div_ceil(4);
            std::thread::scope(|s| {
                let handles: Vec<_> = (0..4)
                    .map(|t| {
                        s.spawn(move || {
                            let lo = t * per;
                            let hi = ((t + 1) * per).min(POINTS + 1);
                            let mut v = Vec::with_capacity((hi.saturating_sub(lo)) * radial);
                            let mut d = Vec::with_capacity((hi.saturating_sub(lo)) * radial);
                            for i in lo..hi {
                                let r = i as f64 / POINTS as f64;
                                for k in 0..radial {
                                    let (a, b) = f(k, r);
                                    v.push(a as f32);
                                    d.push(b as f32);
                                }
                            }
                            (v, d)
                        })
                    })
                    .collect();
                handles.into_iter().map(|h| h.join().expect("tabulating a surface")).collect()
            })
        };
        let (mut value, mut slope) = (Vec::with_capacity((POINTS + 1) * radial), Vec::with_capacity((POINTS + 1) * radial));
        for (v, d) in rows {
            value.extend(v);
            slope.extend(d);
        }
        let (mut kx, mut ky, mut phase) = (Vec::new(), Vec::new(), Vec::new());
        for k in radial..n {
            let (x, y, p) = plane_fn(k);
            kx.push(x);
            ky.push(y);
            phase.push(p);
        }
        Tables { radius, n, radial, order, co, so, value, slope, kx, ky, phase }
    }

    /// The map with these tables, from the cache or built by `make`.
    fn cached(key: u64, make: impl FnOnce() -> Tables) -> Self {
        let found = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&key).cloned();
        let t = match found {
            Some(t) => t,
            None => {
                let t = Arc::new(make());
                let mut map = cache().lock().unwrap_or_else(|e| e.into_inner());
                if map.len() > 64 {
                    map.clear();
                }
                map.insert(key, t.clone());
                t
            }
        };
        let top = t.order.iter().copied().max().unwrap_or(0) as usize;
        Self { radius: t.radius, cm: vec![0.0; top + 1], sm: vec![0.0; top + 1], t }
    }

    /// The map of a drumhead: every mode it was built with.
    pub fn of_membrane(mem: &Membrane) -> Self {
        let radial = mem.modes.iter().take_while(|m| m.count == 1.0).count();
        let modes = &mem.modes;
        let key = fingerprint([0.0, mem.spec.radius].into_iter().chain(modes.iter().flat_map(|m| [m.m as f32, m.j, m.orient, m.phase, m.norm, m.count])));
        Self::cached(key, || Self::build(
            mem.spec.radius,
            modes.len(),
            radial,
            |k| (modes[k].m, modes[k].orient),
            |k, r| {
                let md = &modes[k];
                let (j, n) = (md.j as f64, md.norm as f64);
                (n * jn(md.m, j * r), n * j * jn_prime(md.m, j * r))
            },
            |k| {
                let md = &modes[k];
                (md.j * md.orient.cos(), md.j * md.orient.sin(), md.phase)
            },
        ))
    }

    /// The map of a plate: every mode it was built with (cosine members only, as the plate has them:
    /// see `PlateOptions::complete_freq`).
    pub fn of_plate(plate: &Plate) -> Self {
        let modes = &plate.modes;
        let radial = modes.iter().take_while(|m| m.kind != ModeKind::Sampled).count();
        let key = fingerprint([1.0, plate.spec.radius].into_iter().chain(modes.iter().flat_map(|m| [m.m as f32, m.lambda, m.freq, m.orient, m.phase, m.count])));
        Self::cached(key, || Self::build(
            plate.spec.radius,
            modes.len(),
            radial,
            |k| (modes[k].m, 0.0),
            |k, r| {
                let e = modes[k].parts.iter().fold([0.0f64; 2], |acc, (rad, c)| {
                    let v = rad.eval(r);
                    [acc[0] + c * v[0], acc[1] + c * v[1]]
                });
                (e[0], e[1])
            },
            |k| {
                let md = &modes[k];
                (md.lambda * md.orient.cos(), md.lambda * md.orient.sin(), md.phase)
            },
        ))
    }

    /// Modes mapped.
    pub fn len(&self) -> usize {
        self.t.n
    }

    pub fn is_empty(&self) -> bool {
        self.t.n == 0
    }

    /// Every mode's shape at the point `(x, y)` (metres from the centre) into `phi`, and its slope
    /// along the unit direction `(tx, ty)` (1/m) into `dphi`. Points beyond the edge are taken at the
    /// edge.
    pub fn eval(&mut self, x: f32, y: f32, tx: f32, ty: f32, phi: &mut [f32], dphi: &mut [f32]) {
        let t = &*self.t;
        let a = t.radius;
        let (px, py) = (x / a, y / a);
        let r = (px * px + py * py).sqrt();
        let (rc, (c1, s1)) = if r > 1.0e-6 { (r.min(1.0), (px / r, py / r)) } else { (0.0, (1.0, 0.0)) };
        // `cos(m theta)`, `sin(m theta)` by complex powers.
        let (mut c, mut s) = (1.0f32, 0.0f32);
        for m in 0..self.cm.len() {
            self.cm[m] = c;
            self.sm[m] = s;
            let nc = c * c1 - s * s1;
            s = c * s1 + s * c1;
            c = nc;
        }
        let f = rc * POINTS as f32;
        let i = (f as usize).min(POINTS - 1);
        let w = f - i as f32;
        let (row0, row1) = (i * t.radial, (i + 1) * t.radial);
        // Direction of the slope: along the radius, and around (per unit of the radius, with the
        // `1 / r` of the angular derivative; near the centre a mode of order m >= 1 goes as r^m, so
        // `R / r` stays finite and the smallest table step stands in for r).
        let (along, around) = (c1 * tx + s1 * ty, -s1 * tx + c1 * ty);
        let inv_r = 1.0 / rc.max(1.0 / POINTS as f32);
        let n = t.radial.min(phi.len()).min(dphi.len());
        for k in 0..n {
            let v = t.value[row0 + k] + w * (t.value[row1 + k] - t.value[row0 + k]);
            let d = t.slope[row0 + k] + w * (t.slope[row1 + k] - t.slope[row0 + k]);
            let m = t.order[k] as usize;
            let (cm, sm) = (self.cm[m], self.sm[m]);
            let ang = cm * t.co[k] + sm * t.so[k];
            let dang = m as f32 * (cm * t.so[k] - sm * t.co[k]);
            phi[k] = v * ang;
            dphi[k] = (d * ang * along + v * dang * inv_r * around) / a;
        }
        let root2 = std::f32::consts::SQRT_2;
        for j in 0..(t.n - t.radial) {
            let k = t.radial + j;
            if k >= phi.len() || k >= dphi.len() {
                break;
            }
            let arg = t.kx[j] * px + t.ky[j] * py + t.phase[j];
            let (sn, cs) = arg.sin_cos();
            phi[k] = root2 * cs;
            dphi[k] = -root2 * sn * (t.kx[j] * tx + t.ky[j] * ty) / a;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::matter::membrane::{HeadSpec, MembraneOptions};
    use crate::audio::matter::plate::{PlateOptions, PlateSpec};

    fn compare(shape_at: impl Fn(f32, f32, &mut [f32]), map: &mut SurfaceMap, radius: f32) {
        let n = map.len();
        let (mut want, mut phi, mut dphi) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        let (mut ahead, mut behind) = (vec![0.0; n], vec![0.0; n]);
        let mut worst = (0.0f32, 0.0f32);
        for &(r, theta) in &[(0.0f32, 0.0f32), (0.13, 0.4), (0.37, 2.2), (0.61, -1.0), (0.83, 3.0), (0.97, 5.1)] {
            shape_at(r, theta, &mut want);
            let (x, y) = (r * radius * theta.cos(), r * radius * theta.sin());
            let (tx, ty) = (0.6f32, 0.8f32);
            map.eval(x, y, tx, ty, &mut phi, &mut dphi);
            let scale = want.iter().fold(0.0f32, |m, v| m.max(v.abs()));
            for k in 0..n {
                worst.0 = worst.0.max((phi[k] - want[k]).abs() / scale);
            }
            // The slope against a centred difference of the exact shapes.
            let e = 2.0e-4 * radius;
            let to = |dx: f32, dy: f32| {
                let (qx, qy) = (x + dx, y + dy);
                ((qx * qx + qy * qy).sqrt() / radius, qy.atan2(qx))
            };
            let (ra, ta) = to(e * tx, e * ty);
            let (rb, tb) = to(-e * tx, -e * ty);
            if ra > 0.99 || r == 0.0 {
                continue;
            }
            shape_at(ra, ta, &mut ahead);
            shape_at(rb, tb, &mut behind);
            let slope_scale = (0..n).map(|k| ((ahead[k] - behind[k]) / (2.0 * e)).abs()).fold(0.0f32, f32::max);
            for k in 0..n {
                let fd = (ahead[k] - behind[k]) / (2.0 * e);
                worst.1 = worst.1.max((dphi[k] - fd).abs() / slope_scale);
            }
        }
        assert!(worst.0 < 3.0e-3, "shape error {}", worst.0);
        assert!(worst.1 < 1.5e-2, "slope error {}", worst.1);
    }

    #[test]
    fn a_membrane_map_matches_its_shapes_and_slopes() {
        let spec = HeadSpec { tension: 3000.0, ..HeadSpec::single_ply(0.1778) };
        let mem = Membrane::with(spec, MembraneOptions { sine_partners: true, high_band_per_octave: 20.0, ..MembraneOptions::complete(300, 12_000.0, true) });
        let mut map = SurfaceMap::of_membrane(&mem);
        assert_eq!(map.len(), mem.modes.len());
        compare(|r, t, o| mem.shape_at(r, t, o), &mut map, spec.radius);
    }

    #[test]
    fn a_plate_map_matches_its_shapes_and_slopes() {
        let spec = PlateSpec { radius: 0.15, thickness: 0.004, young: 70.0e9, poisson: 0.22, density: 2500.0, dome_radius: 0.0, loss: 1.0, loss_hf: 0.5, mount_freq: 0.0, rock_freq: 0.0, mount_q: 3.0 };
        let plate = Plate::new(spec, PlateOptions { nonlinear_freq: 1.0, complete_freq: 4000.0, high_band_per_octave: 20.0, max_freq: 12_000.0, ..PlateOptions::standard() });
        let mut map = SurfaceMap::of_plate(&plate);
        compare(|r, t, o| plate.shape_at(r, t, o), &mut map, spec.radius);
    }
}

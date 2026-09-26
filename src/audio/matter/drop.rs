//! Droplets: a drop of water as a striker.
//!
//! **On water** the sound a drop makes, when it makes one, is the **bubble it entrains**: the
//! "plink" of a drip is a bubble ringing, not the impact. The impact itself is nearly silent in the
//! air: the drop was liquid before it landed and water is incompressible, so the crater it digs is
//! paid for by water raised around it - no net change of the air's volume, so no monopole, only
//! the far weaker multipoles of the surface's rearrangement (and the drop's own deceleration in the
//! air, a dipole ten thousand times weaker than the plink). A bubble is gas: when it swells, the
//! water - and the surface above - has to move out of its way, which the air hears. Whether
//! a bubble is made depends on the drop's size and speed (Oguz and Prosperetti 1990): between
//! `We = 41.3 Fr^0.179` and `We = 48.3 Fr^0.247` (Weber and Froude numbers of the drop) the crater
//! the drop digs closes on a bubble every time - **regular entrainment**, which for raindrops at their
//! terminal speed picks out diameters of about 0.85-1.1 mm, the source of rain's 14 kHz whisper on a
//! lake; drips from a tap are regular when they fall from a few centimetres. Faster, larger drops
//! entrain **irregularly** (sometimes, bubbles of assorted sizes); slower, smaller ones not at all.
//! The regular bubble's radius is about 0.45 of the drop's (the ratio measured for the rain drops
//! that make the 14 kHz peak); where it is born is the crater's floor as it collapses, taken at half
//! the crater's greatest depth, which comes from the drop's kinetic energy against the crater's
//! gravity and surface energy.
//!
//! **On a solid** ([`Splashes`]) a drop is a soft striker that doesn't bounce: it flattens and
//! spreads, stopping part of itself every instant. The force is the momentum of the part being
//! stopped: `F = rho pi (2 r d - d^2) v_rel^2` once a depth `d` of the drop has passed the surface
//! (the area of the drop at the surface's plane, times the momentum flux through it). It peaks at
//! `rho v^2 D^2 pi / 4 = 0.79 rho v^2 D^2` - measured drop impacts peak at about `0.8 rho v^2 D^2` -
//! and its impulse is the drop's momentum. The surface gives way as it is pushed (the body's
//! one-step compliance, as in `contact`), which lowers `v_rel`; the balance is a quadratic, solved
//! exactly every sample. Rain on a window, a tent or a cymbal is these splashes on those bodies.
//!
//! Nothing here allocates after construction.

use super::bubble::{Birth, Rng, G, RHO_WATER, SURFACE_TENSION};
use super::modal::ModalBody;
use super::surface::SurfaceMap;
use std::f32::consts::PI;

/// Splashes in contact with a body at once.
pub const MAX_SPLASHES: usize = 16;
/// Above the regular band, drops make no bubble until their Weber number passes this: the medium
/// raindrops (1.1-2.2 mm) are the quiet ones, and large drops (2.2 mm and up at their terminal speed,
/// `We` over about a thousand) entrain bubbles irregularly as their craters' walls fold in (Medwin
/// et al. 1992; Nystuen's classes of raindrop sound).
pub const IRREGULAR_WEBER: f32 = 1000.0;
/// Regular entrainment's bubble radius as a fraction of the drop's.
pub const REGULAR_BUBBLE: f32 = 0.45;

/// A drop of water: its radius (m) and its speed when it lands (m/s).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Drop {
    pub radius: f32,
    pub speed: f32,
}

/// Terminal speed of a raindrop of `diameter` m (Atlas, Srivastava and Sekhon's fit to Gunn and
/// Kinzer's measurements, for 0.1-6 mm), m/s; Stokes' law below 0.1 mm.
pub fn terminal_speed(diameter: f32) -> f32 {
    let dmm = diameter * 1000.0;
    if dmm < 0.1 {
        let r = 0.5 * diameter;
        return 2.0 / 9.0 * RHO_WATER * G * r * r / 1.8e-5;
    }
    (9.65 - 10.3 * (-0.6 * dmm.min(6.0)).exp()).max(0.27)
}

impl Drop {
    pub fn diameter(&self) -> f32 {
        2.0 * self.radius
    }

    pub fn mass(&self) -> f32 {
        RHO_WATER * 4.0 / 3.0 * PI * self.radius.powi(3)
    }

    /// A raindrop of `diameter` m at its terminal speed.
    pub fn raindrop(diameter: f32) -> Self {
        Self { radius: 0.5 * diameter, speed: terminal_speed(diameter) }
    }

    /// A drop of `radius` let go from rest `height` m above where it lands, slowed by the air
    /// (quadratic drag, which its terminal speed fixes).
    pub fn falling(radius: f32, height: f32) -> Self {
        let vt = terminal_speed(2.0 * radius);
        let speed = vt * (1.0 - (-2.0 * G * height.max(0.0) / (vt * vt)).exp()).sqrt();
        Self { radius, speed }
    }

    /// The drop that falls from a tap (or a pipette) of `nozzle` radius (m): Tate's law with Harkins
    /// and Brown's correction (about 0.6 of the ideal weight leaves), let go `height` m above the
    /// surface.
    pub fn from_tap(nozzle: f32, height: f32) -> Self {
        let mass = 2.0 * PI * nozzle * SURFACE_TENSION * 0.6 / G;
        let radius = (3.0 * mass / (4.0 * PI * RHO_WATER)).cbrt();
        Self::falling(radius, height)
    }

    /// Weber and Froude numbers on the diameter.
    pub fn weber(&self) -> f32 {
        RHO_WATER * self.speed * self.speed * self.diameter() / SURFACE_TENSION
    }

    pub fn froude(&self) -> f32 {
        self.speed * self.speed / (G * self.diameter())
    }

    /// Kinetic energy, J.
    pub fn energy(&self) -> f32 {
        0.5 * self.mass() * self.speed * self.speed
    }

    /// The deepest the crater gets (m): the drop's kinetic energy spent digging a hemispherical
    /// crater against gravity (`pi rho g d^4 / 4`) and against surface tension (`2 pi sigma d^2`,
    /// the new surface).
    pub fn crater_depth(&self) -> f32 {
        let e = self.energy();
        let (a, b) = (PI * RHO_WATER * G / 4.0, 2.0 * PI * SURFACE_TENSION);
        // a d^4 + b d^2 = e, a quadratic in d^2.
        let d2 = (-b + (b * b + 4.0 * a * e).sqrt()) / (2.0 * a);
        d2.max(0.0).sqrt()
    }

    /// Whether and how it entrains a bubble on a water surface.
    pub fn regime(&self) -> Entrainment {
        let (we, fr) = (self.weber(), self.froude());
        if we < 41.3 * fr.powf(0.179) {
            Entrainment::None
        } else if we <= 48.3 * fr.powf(0.247) {
            Entrainment::Regular
        } else if we < IRREGULAR_WEBER {
            Entrainment::None
        } else {
            Entrainment::Irregular
        }
    }

    /// The drop of the regular band that entrains a bubble of `bubble` radius: its radius from
    /// [`REGULAR_BUBBLE`], its speed in the middle of the band (found by bisection on the bounds).
    pub fn entraining(bubble: f32) -> Self {
        let radius = bubble / REGULAR_BUBBLE;
        let within = |v: f32, upper: bool| {
            let d = Drop { radius, speed: v };
            let (we, fr) = (d.weber(), d.froude());
            if upper { we - 48.3 * fr.powf(0.247) } else { we - 41.3 * fr.powf(0.179) }
        };
        let bound = |upper: bool| {
            let (mut lo, mut hi) = (0.01f32, 30.0f32);
            for _ in 0..60 {
                let mid = 0.5 * (lo + hi);
                if within(mid, upper) < 0.0 {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            0.5 * (lo + hi)
        };
        Drop { radius, speed: 0.5 * (bound(false) + bound(true)) }
    }

    /// Where a regularly entrained bubble of `bubble` radius is born under the surface: at half the
    /// crater's depth (the crater's floor as it collapses), no shallower than just under the surface.
    pub fn birth_depth(&self, bubble: f32) -> f32 {
        (0.5 * self.crater_depth()).max(1.1 * bubble)
    }

    /// The drop of the regular band whose bubble is born ringing at `freq` Hz (it glides up from
    /// there as it rises): the pitch of a drip, tuned.
    pub fn ringing_at(freq: f32) -> Self {
        let born = |r: f32| {
            let d = Drop::entraining(r);
            let depth = d.birth_depth(r);
            super::bubble::bubble_mode(r, depth).freq * super::bubble::surface_factor(r, depth)
        };
        let (mut lo, mut hi) = (super::bubble::MIN_RADIUS, 0.03f32);
        for _ in 0..60 {
            let mid = (lo * hi).sqrt();
            if born(mid) > freq {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        Drop::entraining((lo * hi).sqrt())
    }

    /// How far a drop falls to land at its speed (the inverse of [`Drop::falling`]), m.
    pub fn fall_height(&self) -> f32 {
        let vt = terminal_speed(self.diameter());
        let x = (self.speed / vt).min(0.999);
        -(1.0 - x * x).ln() * vt * vt / (2.0 * G)
    }
}

/// What a drop does to a water surface (see the module notes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entrainment {
    None,
    Regular,
    Irregular,
}

/// The bubbles a drop landing on water makes, into `out` (at most `out.len()`); returns how many.
/// `water_depth` limits how deep they are born.
pub fn entrain(drop: Drop, water_depth: f32, rng: &mut Rng, out: &mut [Birth]) -> usize {
    let crater = drop.crater_depth().min(water_depth.max(0.0));
    match drop.regime() {
        Entrainment::None => 0,
        Entrainment::Regular => {
            if out.is_empty() {
                return 0;
            }
            let r = REGULAR_BUBBLE * drop.radius;
            out[0] = Birth::new(r, drop.birth_depth(r).min(water_depth.max(1.1 * r)));
            1
        }
        Entrainment::Irregular => {
            // Large, fast drops: a crater that collapses untidily. A bubble about half the time,
            // of a size between a quarter and all of the drop's radius (log-uniform), somewhere
            // down the crater - a statistical stand-in, not a derived law (see the docs).
            let mut n = 0;
            if rng.uniform() < 0.5 && !out.is_empty() {
                let r = drop.radius * (0.25f32.ln() * (1.0 - rng.uniform())).exp();
                out[0] = Birth::new(r, rng.range(1.1 * r, crater.max(1.2 * r)));
                n = 1;
            }
            n
        }
    }
}

// ------------------------------------------------------------------------------------------
// Splashes on solid bodies
// ------------------------------------------------------------------------------------------

struct Splash {
    shape: Vec<f32>,
    radius: f32,
    /// The unstopped part's speed, m/s (it keeps falling).
    speed: f32,
    /// How much of the drop has passed the surface's plane, m (done at `2 r`).
    depth: f32,
    /// The surface's displacement at the point after the last sample.
    surface: f32,
    /// How many drops it stands for: its force reaches the body `sqrt(count)` times over (drops at
    /// different moments and places add incoherently on a linear body).
    gain: f32,
    active: bool,
    age: u32,
}

/// What the splashes on a body have done.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SplashReport {
    pub landed: u64,
    /// The largest force of the latest splash, N, and how many samples it pushed.
    pub peak_force: f32,
    pub samples: u32,
    /// Where the latest landed, m from the centre of the face.
    pub x: f32,
    pub y: f32,
}

/// Drops splashing on a body's face (see the module notes). Call [`Splashes::tick`] every sample
/// before the body steps, as for a rub.
pub struct Splashes {
    map: SurfaceMap,
    h: f32,
    splashes: Vec<Splash>,
    dphi: Vec<f32>,
    newest: usize,
    pub report: SplashReport,
}

impl Splashes {
    /// Splashes on the face `map` describes (the modes of the body they will push).
    pub fn new(map: SurfaceMap, sr: f32) -> Self {
        let n = map.len();
        let splashes = (0..MAX_SPLASHES).map(|_| Splash { shape: vec![0.0; n], radius: 0.0, speed: 0.0, depth: 0.0, surface: 0.0, gain: 1.0, active: false, age: 0 }).collect();
        Self { map, h: 1.0 / sr, splashes, dphi: vec![0.0; n], newest: 0, report: SplashReport::default() }
    }

    /// Radius of the face, m.
    pub fn radius(&self) -> f32 {
        self.map.radius
    }

    pub fn active(&self) -> bool {
        self.splashes.iter().any(|s| s.active)
    }

    /// A drop lands at `(x, y)` (m from the centre of the face) on `body`. If every slot is busy,
    /// the oldest splash gives way.
    pub fn land(&mut self, body: &ModalBody, drop: Drop, x: f32, y: f32) {
        self.land_many(body, drop, x, y, 1.0);
    }

    /// As `land`, the splash standing for `count` drops (see `Splash::gain`).
    pub fn land_many(&mut self, body: &ModalBody, drop: Drop, x: f32, y: f32, count: f32) {
        let slot = self.splashes.iter().position(|s| !s.active).unwrap_or_else(|| (0..self.splashes.len()).max_by_key(|&i| self.splashes[i].age).unwrap_or(0));
        let s = &mut self.splashes[slot];
        self.map.eval(x, y, 1.0, 0.0, &mut s.shape, &mut self.dphi);
        s.radius = drop.radius.max(1.0e-5);
        s.speed = drop.speed.max(0.0);
        s.depth = 0.0;
        s.surface = body.displacement(&s.shape);
        s.gain = count.max(0.0).sqrt();
        s.active = true;
        s.age = 0;
        self.newest = slot;
        self.report.landed += 1;
        self.report.peak_force = 0.0;
        self.report.samples = 0;
        self.report.x = x;
        self.report.y = y;
    }

    /// One sample of every splash against `body`; returns the total force (N).
    pub fn tick(&mut self, body: &mut ModalBody) -> f32 {
        let h = self.h;
        let mut total = 0.0;
        for (i, s) in self.splashes.iter_mut().enumerate().filter(|(_, s)| s.active) {
            let (free, comp) = body.predict(&s.shape);
            // Approach speed if no force acted, and how much a newton slows it over the step.
            let w = s.speed - (free - s.surface) / h;
            let c = comp / h;
            let d = (s.depth + 0.5 * w.max(0.0) * h).clamp(0.0, 2.0 * s.radius);
            let a = RHO_WATER * PI * (2.0 * s.radius * d - d * d);
            let f = if w > 0.0 && a > 0.0 {
                let x = a * c * w;
                2.0 * a * w * w / (1.0 + 2.0 * x + (1.0 + 4.0 * x).sqrt())
            } else {
                0.0
            };
            body.add_force(&s.shape, f * s.gain);
            let v_rel = w - c * f;
            s.depth += v_rel.max(0.0) * h;
            s.surface = free + comp * f;
            s.age += 1;
            total += f;
            if i == self.newest {
                self.report.peak_force = self.report.peak_force.max(f);
                if f > 0.0 {
                    self.report.samples += 1;
                }
            }
            if s.depth >= 2.0 * s.radius || s.age > 4410 {
                s.active = false;
            }
        }
        total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raindrops_between_about_085_and_11_mm_entrain_regularly() {
        let regime = |d: f32| Drop::raindrop(d * 1.0e-3).regime();
        assert_eq!(regime(0.6), Entrainment::None);
        assert_eq!(regime(0.95), Entrainment::Regular);
        assert_eq!(regime(1.05), Entrainment::Regular);
        assert_eq!(regime(1.6), Entrainment::None);
        assert_eq!(regime(3.0), Entrainment::Irregular);
        // The regular bubble of a millimetre raindrop rings near 14 kHz.
        let r = REGULAR_BUBBLE * 0.5e-3;
        let f = super::super::bubble::bubble_mode(r, 1.0e-3).freq;
        assert!(f > 12_000.0 && f < 17_000.0, "{f}");
    }

    #[test]
    fn a_tap_drip_is_regular_from_a_few_centimetres() {
        let at = |h: f32| Drop::from_tap(2.0e-3, h);
        let d = at(0.07);
        assert!(d.radius > 2.0e-3 && d.radius < 2.8e-3, "{}", d.radius);
        assert_eq!(d.regime(), Entrainment::Regular, "{d:?} We {} Fr {}", d.weber(), d.froude());
        assert_eq!(at(0.01).regime(), Entrainment::None);
        assert_eq!(at(0.5).regime(), Entrainment::None);
        assert_eq!(at(3.0).regime(), Entrainment::Irregular);
    }

    #[test]
    fn entraining_finds_a_drop_in_the_band_and_its_height() {
        for r in [0.3e-3f32, 1.0e-3, 3.0e-3] {
            let d = Drop::entraining(r);
            assert_eq!(d.regime(), Entrainment::Regular, "{d:?}");
            let back = Drop::falling(d.radius, d.fall_height());
            assert!((back.speed / d.speed - 1.0).abs() < 1.0e-3);
        }
    }

    #[test]
    fn a_drip_can_be_tuned() {
        for f in [600.0f32, 1500.0, 4000.0] {
            let d = Drop::ringing_at(f);
            assert_eq!(d.regime(), Entrainment::Regular);
            let mut rng = Rng::new(1);
            let mut out = [Birth::new(1.0, 1.0); 2];
            assert_eq!(entrain(d, 1.0, &mut rng, &mut out), 1);
            let b = out[0];
            let born = super::super::bubble::bubble_mode(b.radius, b.depth).freq * super::super::bubble::surface_factor(b.radius, b.depth);
            assert!((born / f - 1.0).abs() < 1.0e-3, "{f}: {born}");
        }
    }

    #[test]
    fn a_splash_on_a_heavy_body_gives_the_drop_s_momentum_and_peak() {
        // A drop on a nearly rigid body: impulse = m v, peak about 0.8 rho v^2 D^2, over ~D/v.
        let sr = 1.0e6;
        let body_spec = [super::super::modal::ModeSpec { freq: 50.0, sigma: 1.0, mass: 1.0e4, radiation: 0.0 }];
        let mut body = ModalBody::new(&body_spec, sr);
        let d = Drop::raindrop(3.0e-3);
        let (mut impulse, mut peak, mut n) = (0.0f64, 0.0f32, 0);
        let shape = [1.0f32];
        let (mut depth, mut surface) = (0.0f32, 0.0f32);
        // The same loop as `Splashes::tick`, on a one-mode body (no surface map needed).
        for _ in 0..(sr as usize / 50) {
            let (free, comp) = body.predict(&shape);
            let h = 1.0 / sr;
            let w = d.speed - (free - surface) / h;
            let c = comp / h;
            let dd = (depth + 0.5 * w * h).clamp(0.0, 2.0 * d.radius);
            let a = RHO_WATER * PI * (2.0 * d.radius * dd - dd * dd);
            let x = a * c * w;
            let f = if w > 0.0 { 2.0 * a * w * w / (1.0 + 2.0 * x + (1.0 + 4.0 * x).sqrt()) } else { 0.0 };
            body.add_force(&shape, f);
            depth += (w - c * f).max(0.0) * h;
            surface = free + comp * f;
            body.step();
            impulse += f as f64 * h as f64;
            peak = peak.max(f);
            if f > 0.0 {
                n += 1;
            }
            if depth >= 2.0 * d.radius {
                break;
            }
        }
        let p = d.mass() * d.speed;
        assert!((impulse as f32 / p - 1.0).abs() < 0.02, "impulse {impulse} vs {p}");
        let want = 0.8 * RHO_WATER * d.speed * d.speed * d.diameter().powi(2);
        assert!((peak / want - 1.0).abs() < 0.1, "peak {peak} vs {want}");
        let t = n as f32 / sr;
        assert!(t > 0.8 * d.diameter() / d.speed && t < 1.3 * d.diameter() / d.speed, "{t}");
    }
}

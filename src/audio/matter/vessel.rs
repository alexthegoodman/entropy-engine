//! Vessels: water in a container - a glass, a jar, a bottle - and the air above it.
//!
//! **The air column.** Whatever happens in the water (a drop landing, a bubble ringing, a stream
//! plunging in) moves the water's surface, and the surface is the closed end of the air above it.
//! That air rings: a glass is a tube closed by the water, a bottle a cavity (the air left in its
//! body) under a neck. Both are one equation: a tube of effective length `L'` (the neck, or the
//! whole air column, with its end corrections) closed by a cavity of volume `V` rings where
//!
//! ```text
//! cot(k L') = k V / S
//! ```
//!
//! which is Helmholtz's `k^2 = S / (V L')` when the cavity is large and the tube short, and the
//! quarter-wave tube's `k L' = pi / 2` when there is no cavity left. As a bottle fills, `V` shrinks
//! and the note rises ever faster until the water reaches the neck; as a glass fills, its column
//! shortens. That is the rising pitch of a bottle being filled, from the geometry alone. The modes'
//! losses are radiation from the open end (an unflanged pipe's resistance) and the viscous and
//! thermal boundary layers on the walls; the source is the water surface's volume acceleration at
//! the closed end; what is heard is the open end's volume velocity, a small monopole.
//!
//! **Pouring.** A stream falls from a spout, speeds up (`v^2 = v_0^2 + 2 g h` over the drop to the
//! water, which shortens as the vessel fills), thins (`r_j = sqrt(q / (pi v))`), and breaks into
//! drops (Rayleigh-Plateau: the fastest-growing wavelength, `9.02 r_j` of jet, pinches into a drop of
//! `1.89 r_j`), which land as drops (`drop`) and entrain bubbles, which the air column hears through
//! the water's surface.
//!
//! **The glass itself.** A struck glass rings in its wall's bending modes, `cos(m theta)` round the
//! rim with `m = 2, 3, 4...` (a ring's inextensional modes, `omega^2 ~ E h^2 m^2 (m^2 - 1)^2 /
//! (12 rho (1 - nu^2) R^4 (m^2 + 1))`, stiffened a little by the base: French 1983). Water inside
//! moves with the wall and adds mass: per unit height, a wall mode of order `m` carries
//! `rho_l pi R^2 / m` of liquid against `rho_g h pi R (1 + 1/m^2)` of glass, weighted by how much the
//! wall moves at that height. With the wall's motion growing as `(z / H)^(3/2)` - the shape that
//! gives the `(level / H)^4` law French measured on wine glasses - a mode falls as
//! `f = f_empty / sqrt(1 + C_m (level / H)^4)`, `C_m = rho_l R / (m (1 + 1/m^2) rho_g h)`. So a glass
//! can be **tuned by its water**: [`GlassSpec::level_for`] finds the level for a note, which is the
//! glass harp.
//!
//! Nothing here allocates after construction.

use super::bubble::{Birth, BubbleBank, Resonators, Rng, G, GAMMA_AIR, RHO_WATER};
use super::contact::{Contact, ContactLaw, Material, StrikeReport, Striker, Tip};
use super::drop::{entrain, Drop};
use super::drum::{StrikerSpec, MAX_STRIKERS};
use super::membrane::{C_AIR, RHO_AIR};
use super::modal::{ModalBody, ModeSpec};
use std::f32::consts::PI;

/// Modes of the air column kept (up to [`AIR_TOP`]).
pub const AIR_MODES: usize = 32;
pub const AIR_TOP: f32 = 18_000.0;
/// Samples between retunings of the air column while the level moves (it glides in between).
const AIR_BLOCK: usize = 128;
/// Kinematic viscosity of air (m^2/s) and its Prandtl number, for the walls' boundary layers.
const NU_AIR: f32 = 1.5e-5;
const PRANDTL: f32 = 0.71;
/// Wall modes of a glass: orders `2..2 + WALL_MODES`.
pub const WALL_MODES: usize = 6;

// ------------------------------------------------------------------------------------------
// The container
// ------------------------------------------------------------------------------------------

/// A container, SI units: a cylindrical body, optionally with a neck on top.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VesselSpec {
    /// Inner radius and height of the body, m.
    pub radius: f32,
    pub height: f32,
    /// Inner radius and length of the neck, m (0 radius: no neck - a glass, a jar, a vase).
    pub neck_radius: f32,
    pub neck_length: f32,
    /// The wall: material, thickness (m), and its loss factor (glass about 1e-3).
    pub wall: Material,
    pub wall_thickness: f32,
    pub wall_loss: f32,
}

impl VesselSpec {
    /// A straight tumbler, 7 cm across and 10 cm tall, 2 mm glass.
    pub fn tumbler() -> Self {
        Self { radius: 0.035, height: 0.10, neck_radius: 0.0, neck_length: 0.0, wall: Material::GLASS, wall_thickness: 0.002, wall_loss: 1.0e-3 }
    }

    /// A 75 cl wine bottle: 3.7 cm body radius, 20 cm of body, a 9.5 mm neck 8 cm long.
    pub fn bottle() -> Self {
        Self { radius: 0.037, height: 0.20, neck_radius: 0.0095, neck_length: 0.08, wall: Material::GLASS, wall_thickness: 0.003, wall_loss: 1.0e-3 }
    }

    /// A tall vase (or a measuring cylinder): 4 cm radius, 30 cm tall.
    pub fn vase() -> Self {
        Self { radius: 0.04, height: 0.30, neck_radius: 0.0, neck_length: 0.0, wall: Material::GLASS, wall_thickness: 0.003, wall_loss: 1.0e-3 }
    }

    /// A 2 litre jug with a wide mouth.
    pub fn jug() -> Self {
        Self { radius: 0.065, height: 0.16, neck_radius: 0.045, neck_length: 0.03, wall: Material::GLASS, wall_thickness: 0.004, wall_loss: 1.0e-3 }
    }

    fn has_neck(&self) -> bool {
        self.neck_radius > 0.0 && self.neck_length > 0.0
    }

    /// Height of the whole vessel, m.
    pub fn total_height(&self) -> f32 {
        self.height + if self.has_neck() { self.neck_length } else { 0.0 }
    }

    /// Water's surface area at `level` m, m^2.
    pub fn area_at(&self, level: f32) -> f32 {
        let r = if level < self.height || !self.has_neck() { self.radius } else { self.neck_radius };
        PI * r * r
    }

    /// Volume of water up to `level`, m^3.
    pub fn volume_to(&self, level: f32) -> f32 {
        let l = level.clamp(0.0, self.total_height());
        let body = PI * self.radius * self.radius * l.min(self.height);
        body + if self.has_neck() { PI * self.neck_radius * self.neck_radius * (l - self.height).max(0.0) } else { 0.0 }
    }

    /// The air above water at `level`: a tube (length, radius, open-end correction plus inner
    /// correction) closed by a cavity of `V` m^3 and radius (for its walls).
    fn air(&self, level: f32) -> AirGeometry {
        let l = level.clamp(0.0, self.total_height());
        if !self.has_neck() {
            return AirGeometry { tube: self.height - l, radius: self.radius, cavity: 0.0, cavity_radius: self.radius, inner: 0.0 };
        }
        if l < self.height {
            let v = PI * self.radius * self.radius * (self.height - l);
            let xi = self.neck_radius / self.radius;
            // Inner end correction of a neck into a larger cavity (Ingard), for small `xi`.
            let inner = 0.82 * self.neck_radius * (1.0 - 1.33 * xi).max(0.3);
            AirGeometry { tube: self.neck_length, radius: self.neck_radius, cavity: v, cavity_radius: self.radius, inner }
        } else {
            AirGeometry { tube: self.total_height() - l, radius: self.neck_radius, cavity: 0.0, cavity_radius: self.neck_radius, inner: 0.0 }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct AirGeometry {
    tube: f32,
    radius: f32,
    cavity: f32,
    cavity_radius: f32,
    inner: f32,
}

/// One acoustic mode of the air above the water.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AirMode {
    pub freq: f32,
    /// Amplitude decay: radiation from the open end, and the walls' boundary layers, 1/s.
    pub radiation: f32,
    pub walls: f32,
    /// The mode's pressure at the water's surface divided by its "mass" `Lambda` (the volume
    /// integral of its squared shape over `rho c^2`): a volume acceleration `Q'` at the surface
    /// drives its amplitude as `a'' + ... = drive * Q'`.
    pub drive: f32,
    /// Pressure at 1 m from the open end per unit of the mode's amplitude (Pa/Pa).
    pub out: f32,
}

impl AirMode {
    pub fn sigma(&self) -> f32 {
        self.radiation + self.walls
    }
}

/// The boundary layers' attenuation along a tube of `radius` at `omega`, 1/m (Kirchhoff).
fn wall_attenuation(omega: f32, radius: f32) -> f32 {
    (omega * NU_AIR / 2.0).sqrt() / (C_AIR * radius.max(1.0e-4)) * (1.0 + (GAMMA_AIR - 1.0) / PRANDTL.sqrt())
}

/// The air column's modes above water at `level` in `spec`, into `out` (at most `out.len()`, up
/// to `top` Hz). Returns how many.
pub fn air_modes(spec: &VesselSpec, level: f32, top: f32, out: &mut [AirMode]) -> usize {
    let g = spec.air(level);
    let s = PI * g.radius * g.radius;
    let outer = 0.6133 * g.radius;
    let lp = g.tube.max(0.0) + outer + if g.cavity > 0.0 { g.inner } else { 0.0 };
    let v = g.cavity;
    let rc2 = RHO_AIR * C_AIR * C_AIR;
    let f = |k: f32| s * (k * lp).cos() - k * v * (k * lp).sin();
    let mut n = 0;
    for i in 0..out.len() {
        let (mut lo, mut hi) = (i as f32 * PI / lp, (i as f32 + 0.5) * PI / lp);
        if i == 0 {
            lo = 1.0e-6;
        }
        let flo = f(lo);
        for _ in 0..48 {
            let mid = 0.5 * (lo + hi);
            if (f(mid) > 0.0) == (flo > 0.0) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let k = 0.5 * (lo + hi);
        let freq = k * C_AIR / (2.0 * PI);
        if freq > top {
            break;
        }
        let tube = s * (0.5 * lp - (2.0 * k * lp).sin() / (4.0 * k));
        let cav = v * (k * lp).sin().powi(2);
        let lambda = (tube + cav) / rc2;
        let ka = k * g.radius;
        let r = 0.25 * ka * ka / (1.0 + 0.25 * ka * ka);
        let radiation = r * s / (2.0 * RHO_AIR * C_AIR * lambda);
        let omega = k * C_AIR;
        let walls = C_AIR * (wall_attenuation(omega, g.radius) * tube + wall_attenuation(omega, g.cavity_radius) * cav) / (tube + cav);
        out[i] = AirMode { freq, radiation, walls, drive: (k * lp).sin() / lambda, out: s * k / (4.0 * PI) };
        n = i + 1;
    }
    n
}

// ------------------------------------------------------------------------------------------
// The glass's wall
// ------------------------------------------------------------------------------------------

/// A drinking glass as a struck instrument (see the module notes): its wall's bending modes, the
/// water in it, and a note to tune it to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlassSpec {
    pub vessel: VesselSpec,
}

/// The wall's radial motion grows up the wall as `(z / H)^WALL_POWER`.
const WALL_POWER: f32 = 1.5;

impl GlassSpec {
    /// The wall's mode of order `m` when empty, Hz (French's ring-plus-base formula).
    pub fn empty_freq(&self, m: u32) -> f32 {
        let v = &self.vessel;
        let mm = m as f32 * m as f32;
        let ring = mm * (mm - 1.0).powi(2) / (mm + 1.0);
        let e = v.wall.young / (12.0 * v.wall.density * (1.0 - v.wall.poisson * v.wall.poisson));
        let base = 1.0 + 4.0 / 3.0 * (v.radius / v.height).powi(4);
        (e * v.wall_thickness * v.wall_thickness * ring * base).sqrt() / (v.radius * v.radius) / (2.0 * PI)
    }

    /// How much the water loads the mode of order `m`, full to the rim: `C_m`.
    pub fn loading(&self, m: u32) -> f32 {
        let v = &self.vessel;
        let mm = m as f32;
        RHO_WATER * v.radius / (mm * (1.0 + 1.0 / (mm * mm)) * v.wall.density * v.wall_thickness)
    }

    /// The mode of order `m` with water to `level` m, Hz.
    pub fn freq(&self, m: u32, level: f32) -> f32 {
        let x = (level / self.vessel.height).clamp(0.0, 1.0);
        self.empty_freq(m) / (1.0 + self.loading(m) * x.powi(4)).sqrt()
    }

    /// The lowest (sounding) note's range: empty, and full to the rim, Hz.
    pub fn range(&self) -> (f32, f32) {
        (self.empty_freq(2), self.freq(2, self.vessel.height))
    }

    /// The level (m) that tunes the glass to `pitch` Hz, if it is in range.
    pub fn level_for(&self, pitch: f32) -> Option<f32> {
        let (top, bottom) = self.range();
        if pitch > top * 1.0001 || pitch < bottom * 0.9999 {
            return None;
        }
        let x = (((top / pitch).powi(2) - 1.0) / self.loading(2)).max(0.0).powf(0.25);
        Some((x * self.vessel.height).min(self.vessel.height))
    }

    /// A tumbler scaled so that `pitch` sits two thirds of the way down its range: the glass a
    /// glass harp would use for that note, and its level. Its walls are 2 mm glass; the radius
    /// follows `f ~ h / R^2`, the height stays three times the radius.
    pub fn tuned(pitch: f32) -> (Self, f32) {
        let base = VesselSpec::tumbler();
        let shape = |radius: f32| GlassSpec { vessel: VesselSpec { radius, height: radius * 2.86, ..base } };
        // Two thirds of the way down (in log frequency) from empty to full.
        let target = |g: &GlassSpec| {
            let (top, bottom) = g.range();
            (top.ln() + (bottom.ln() - top.ln()) * 2.0 / 3.0).exp()
        };
        let (mut lo, mut hi) = (0.005f32, 0.3f32);
        for _ in 0..60 {
            let mid = (lo * hi).sqrt();
            if target(&shape(mid)) > pitch {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let g = shape((lo * hi).sqrt());
        let level = g.level_for(pitch).unwrap_or(0.0);
        (g, level)
    }

    /// The wall's modes with water to `level` (orders `2..2 + WALL_MODES`), shapes normalized to
    /// one at the rim: frequency, the glass's losses, modal mass at the rim and radiation weight
    /// (pascals at 1 m per m/s^2 of the rim).
    pub fn modes(&self, level: f32) -> [ModeSpec; WALL_MODES] {
        let v = &self.vessel;
        std::array::from_fn(|i| {
            let m = (i + 2) as u32;
            let mm = m as f32;
            let freq = self.freq(m, level);
            let x = (level / v.height).clamp(0.0, 1.0);
            let glass = v.wall.density * v.wall_thickness * PI * v.radius * v.height * (1.0 + 1.0 / (mm * mm)) / (2.0 * WALL_POWER + 1.0);
            let mass = glass * (1.0 + self.loading(m) * x.powi(4));
            // A multipole of order m: the net flow cancels to `(k R)^m / (2^m m!)` of the moving
            // wall's (the wall's area weighted by its motion) while the wall is small against the
            // wavelength; it can't radiate better than the wall moving as a whole (efficiency 1).
            let k = 2.0 * PI * freq / C_AIR;
            let fact: f32 = (1..=m).map(|j| j as f32).product();
            let area = PI * v.radius * v.height / (WALL_POWER + 1.0);
            let x = (k * v.radius).powi(m as i32) / (2.0f32.powi(m as i32) * fact);
            let efficiency = x / (1.0 + x * x).sqrt();
            let radiation = RHO_AIR * area * efficiency / (4.0 * PI);
            // What it radiates it loses: a weight `w` (Pa at 1 m per m/s^2) radiates
            // `2 pi w^2 omega^2 v^2 / (rho c)` at velocity amplitude `v`, against the mode's energy
            // `M v^2 / 2`.
            let omega = 2.0 * PI * freq;
            let damping = 2.0 * PI * radiation * radiation * omega * omega / (RHO_AIR * C_AIR * mass);
            ModeSpec { freq, sigma: PI * freq * v.wall_loss + damping, mass, radiation }
        })
    }
}

// ------------------------------------------------------------------------------------------
// A vessel, played
// ------------------------------------------------------------------------------------------

/// A stream poured in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pour {
    /// Flow, m^3/s (a gentle pour from a jug ~5e-5, a tap full on ~2e-4).
    pub flow: f32,
    /// Height of the spout above the vessel's bottom, m, and the stream's speed leaving it (m/s).
    pub height: f32,
    pub spout_speed: f32,
    /// How long it pours, s.
    pub duration: f32,
}

impl Pour {
    pub fn new(flow: f32, height: f32, duration: f32) -> Self {
        Self { flow, height, spout_speed: 0.5, duration }
    }
}

struct Flight {
    striker: Striker,
    contact: Contact,
    active: bool,
    age: u32,
}

/// A vessel with water in it: its air column, the water's bubbles, a stream poured in,
/// and (for a glass) its wall, struck.
pub struct Vessel {
    pub spec: VesselSpec,
    sr: f32,
    h: f32,
    level: f32,
    /// Listener's distance from the vessel, m.
    pub distance: f32,
    pub pan: f32,
    air: Resonators,
    modes: [AirMode; AIR_MODES],
    n_air: usize,
    tuned_level: f32,
    bubbles: BubbleBank,
    walls: ModalBody,
    glass: GlassSpec,
    wall_level: f32,
    wall_shape: [f32; WALL_MODES],
    flights: [Option<Flight>; MAX_STRIKERS],
    pour: Option<Pour>,
    poured: f32,
    next_parcel: f32,
    rng: Rng,
    counter: usize,
    births: [Birth; 2],
    pub report: StrikeReport,
    /// Parcels of the stream landed so far.
    pub parcels: u64,
}

impl Vessel {
    /// A vessel filled to `level` m, heard from `distance` m.
    pub fn new(spec: VesselSpec, level: f32, distance: f32, sr: f32) -> Self {
        let glass = GlassSpec { vessel: spec };
        let walls = ModalBody::new(&glass.modes(level), sr);
        let mut v = Self {
            spec,
            sr,
            h: 1.0 / sr,
            level: level.clamp(0.0, spec.total_height()),
            distance,
            pan: 0.0,
            air: Resonators::new(AIR_MODES, sr),
            modes: [AirMode::default(); AIR_MODES],
            n_air: 0,
            tuned_level: -1.0,
            bubbles: BubbleBank::with_capacity(128, sr),
            walls,
            glass,
            wall_level: level,
            wall_shape: [1.0; WALL_MODES],
            flights: std::array::from_fn(|_| None),
            pour: None,
            poured: 0.0,
            next_parcel: 0.0,
            rng: Rng::new(7),
            counter: 0,
            births: [Birth::new(1.0e-3, 1.0e-3); 2],
            report: StrikeReport::default(),
            parcels: 0,
        };
        v.retune(true);
        v
    }

    pub fn level(&self) -> f32 {
        self.level
    }

    /// Sets the water level at once (m).
    pub fn set_level(&mut self, level: f32) {
        self.level = level.clamp(0.0, self.spec.total_height());
        self.retune(true);
    }

    /// The air column's modes now.
    pub fn air_modes(&self) -> &[AirMode] {
        &self.modes[..self.n_air]
    }

    pub fn glass(&self) -> GlassSpec {
        self.glass
    }

    pub fn wall(&self) -> &ModalBody {
        &self.walls
    }

    pub fn bubbles(&self) -> &BubbleBank {
        &self.bubbles
    }

    pub fn pouring(&self) -> bool {
        self.pour.is_some()
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    /// Whether anything is still going on (for sleeping).
    pub fn busy(&self) -> bool {
        self.pour.is_some() || !self.bubbles.is_silent() || self.flights.iter().any(|f| f.as_ref().is_some_and(|f| f.active))
    }

    /// Pours a stream in (replacing any stream already pouring).
    pub fn pour(&mut self, p: Pour) {
        self.pour = Some(p);
        self.poured = 0.0;
        self.next_parcel = 0.0;
    }

    /// Stops pouring.
    pub fn stop_pouring(&mut self) {
        self.pour = None;
    }

    /// A drop falls into the water.
    pub fn drip(&mut self, drop: Drop) {
        self.land(drop, 1.0);
    }

    fn land(&mut self, drop: Drop, count: f32) {
        if self.level <= 0.0 {
            return;
        }
        self.bubbles.water_depth = self.level;
        let n = entrain(drop, self.level, &mut self.rng, &mut self.births);
        for i in 0..n {
            let mut b = self.births[i];
            b.pan = self.pan;
            b.count = count;
            self.bubbles.spawn(b);
        }
    }

    /// Strikes the glass's rim (a spoon, a mallet).
    pub fn strike(&mut self, speed: f32, striker: StrikerSpec) {
        let slot = self.flights.iter().position(|f| f.as_ref().is_none_or(|f| !f.active)).unwrap_or(0);
        let surface = self.walls.displacement(&self.wall_shape);
        let v = speed.max(0.0);
        self.flights[slot] = Some(Flight {
            striker: Striker { mass: striker.mass, tip: striker.tip, y: surface - v * self.h * 1.5, v },
            contact: Contact::new(ContactLaw::between(striker.tip, self.spec.wall, striker.restitution)),
            active: true,
            age: 0,
        });
        self.report.begin(v, 1.0, 0.0);
    }

    /// Retunes the air column (and the wall) to the level, gliding over the next block.
    fn retune(&mut self, exact: bool) {
        if !exact && (self.level - self.tuned_level).abs() < 1.0e-6 {
            return;
        }
        let n = air_modes(&self.spec, self.level, AIR_TOP.min(0.45 * self.sr), &mut self.modes);
        let r = self.distance.max(0.05);
        let (l, rr) = super::bubble::pan_gains(self.pan);
        for k in 0..n {
            let m = self.modes[k];
            let w0 = 2.0 * PI * m.freq;
            let gain = [m.out / r * l, m.out / r * rr, 0.0];
            if k >= self.air.len() {
                self.air.add(w0, m.sigma(), 1.0, 0.0, 0.0, false, gain);
            } else if exact {
                self.air.glide(k, w0, m.sigma(), 1.0, 1);
                self.air.set_gain(k, gain);
            } else {
                self.air.glide(k, w0, m.sigma(), 1.0, AIR_BLOCK);
                self.air.set_gain(k, gain);
            }
        }
        while self.air.len() > n {
            self.air.remove(self.air.len() - 1);
        }
        self.n_air = n;
        self.tuned_level = self.level;
        // The wall's tuning follows the level too (slowly: it only matters once a centimetre or so
        // has changed, and retuning it is exact and continuous).
        if exact || (self.level - self.wall_level).abs() > 0.002 {
            let specs = self.glass.modes(self.level);
            self.walls.set_specs(&specs);
            self.wall_level = self.level;
        }
    }

    /// One sample, `[left, right]` in pascals.
    pub fn next_frame(&mut self) -> [f32; 2] {
        if self.counter % AIR_BLOCK == 0 {
            self.retune(false);
        }
        self.counter = self.counter.wrapping_add(1);
        // The stream.
        if let Some(p) = self.pour {
            let h = self.h;
            let area = self.spec.area_at(self.level);
            self.level = (self.level + p.flow * h / area).min(self.spec.total_height());
            self.poured += h;
            self.next_parcel -= h;
            if self.next_parcel <= 0.0 {
                let fall = (p.height - self.level).max(0.0);
                let v = (p.spout_speed * p.spout_speed + 2.0 * G * fall).sqrt().max(0.05);
                let rj = (p.flow / (PI * v)).sqrt();
                let drop = Drop { radius: 1.89 * rj, speed: v };
                let volume = 4.0 / 3.0 * PI * drop.radius.powi(3);
                self.land(drop, 1.0);
                self.parcels += 1;
                // The stream breaks up irregularly: intervals scattered about their mean.
                let mean = volume / p.flow.max(1.0e-9);
                self.next_parcel += mean * (0.4 + self.rng.exponential(0.6));
            }
            if self.poured >= p.duration || self.level >= self.spec.total_height() {
                self.pour = None;
            }
        }
        // Water: its bubbles move its surface, the air column's closed end. (What they would
        // radiate in the open is not heard: the air column is the way out.)
        let (_, q) = self.bubbles.next();
        for k in 0..self.n_air {
            self.air.push(k, self.modes[k].drive * q);
        }
        let air = self.air.step();
        // The wall, struck.
        let h = self.h;
        for f in self.flights.iter_mut().flatten().filter(|f| f.active) {
            let (sy, sc) = f.striker.predict(h);
            let (by, bc) = self.walls.predict(&self.wall_shape);
            let force = f.contact.solve(sy - by, sc + bc, h);
            f.striker.apply(force, h);
            self.walls.add_force(&self.wall_shape, force);
            f.age += 1;
            self.report.track(&f.contact, f.striker.v);
            let gone = f.contact.touches > 0 && !f.contact.touching && f.striker.v < 0.0 && f.contact.delta < -0.002;
            if gone || f.age as f32 > 0.5 * self.sr {
                f.active = false;
            }
        }
        let wall = self.walls.step() / self.distance.max(0.05);
        let (l, r) = super::bubble::pan_gains(self.pan);
        [air[0] + wall * l, air[1] + wall * r]
    }
}

/// A spoon: a steel bowl's back (about 4 mm of curvature), light.
pub fn spoon() -> StrikerSpec {
    StrikerSpec { mass: 0.012, tip: Tip::Solid { radius: 0.004, material: Material::STEEL }, restitution: 0.8 }
}

/// A glass harp's soft mallet.
pub fn soft_mallet() -> StrikerSpec {
    StrikerSpec { mass: 0.01, tip: Tip::Felt { stiffness: 2.0e7, exponent: 2.2 }, restitution: 0.6 }
}

/// Where the glasses' water tuning comes from, for the ops: the rim's pitch empty and full.
pub fn glass_range(g: &GlassSpec) -> (f32, f32) {
    g.range()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_glass_column_is_a_quarter_wave_tube() {
        let v = VesselSpec::tumbler();
        let mut modes = [AirMode::default(); AIR_MODES];
        let n = air_modes(&v, 0.03, 20_000.0, &mut modes);
        assert!(n > 5);
        let lp = 0.07 + 0.6133 * v.radius;
        let want = C_AIR / (4.0 * lp);
        assert!((modes[0].freq / want - 1.0).abs() < 1.0e-3, "{} vs {want}", modes[0].freq);
        assert!((modes[1].freq / modes[0].freq - 3.0).abs() < 1.0e-2);
    }

    #[test]
    fn a_bottle_is_a_helmholtz_resonator_then_a_tube() {
        let b = VesselSpec::bottle();
        let mut modes = [AirMode::default(); AIR_MODES];
        air_modes(&b, 0.0, 20_000.0, &mut modes);
        // Helmholtz: f = c / 2 pi sqrt(S / (V L')).
        let s = PI * b.neck_radius * b.neck_radius;
        let v = PI * b.radius * b.radius * b.height;
        let xi = b.neck_radius / b.radius;
        let lp = b.neck_length + 0.6133 * b.neck_radius + 0.82 * b.neck_radius * (1.0 - 1.33 * xi);
        let helm = C_AIR / (2.0 * PI) * (s / (v * lp)).sqrt();
        assert!((modes[0].freq / helm - 1.0).abs() < 0.05, "{} vs {helm}", modes[0].freq);
        // Filling raises it, ever faster, and it passes smoothly into the neck's quarter wave.
        let at = |l: f32| {
            let mut m = [AirMode::default(); 1];
            air_modes(&b, l, 20_000.0, &mut m);
            m[0].freq
        };
        let (f0, f1, f2, f3) = (at(0.0), at(0.1), at(0.18), at(0.1999));
        assert!(f1 > f0 * 1.3 && f2 > f1 * 1.8 && f3 > f2, "{f0} {f1} {f2} {f3}");
        let neck = at(0.2001);
        assert!((f3 / neck - 1.0).abs() < 0.1, "{f3} into the neck {neck}");
    }

    #[test]
    fn a_glass_falls_as_it_is_filled_and_can_be_tuned() {
        let g = GlassSpec { vessel: VesselSpec::tumbler() };
        let (top, bottom) = g.range();
        assert!(top > 800.0 && top < 2000.0, "{top}");
        assert!(bottom < top / 1.5, "{bottom}");
        // The overtones sit at the ring's ratios (2.83 for m = 3).
        assert!((g.empty_freq(3) / g.empty_freq(2) - 2.83).abs() < 0.05);
        let pitch = (top * bottom).sqrt();
        let level = g.level_for(pitch).unwrap();
        assert!((g.freq(2, level) / pitch - 1.0).abs() < 1.0e-4);
        let (tuned, l) = GlassSpec::tuned(440.0);
        assert!((tuned.freq(2, l) / 440.0 - 1.0).abs() < 1.0e-3, "{}", tuned.freq(2, l));
    }
}

//! Drums: one or two heads, the air between them, and whatever strikes them.
//!
//! A drum here is a batter head (the one that is hit), optionally a resonant head, and the enclosed
//! air. The air is a spring on every mode that changes the volume: pressing one head in raises the
//! pressure, which pushes on both - so the heads of a tom or a kick are coupled, and the kettle of a
//! timpani stiffens its lowest mode. Strikers (sticks, beaters, mallets) meet the batter head
//! through the contact model, solved every sample while they touch, and are thrown back by it.
//!
//! The presets set physical quantities only: head size, film, tension (solved from the tuning the
//! player asks for), the shell's volume, losses such as a pillow in the kick, and the striker. The
//! sounds - the kick's thump, a tom's pitch glide, the timpani's pitch - are what those quantities do.

use super::contact::{Contact, ContactLaw, Material, Striker, Tip};
use super::membrane::{HeadSpec, Membrane, C_AIR, RHO_AIR};
use super::modal::ModalBody;

/// Most strikers in flight or in contact at once (a flam, a roll, a buzz).
pub const MAX_STRIKERS: usize = 4;
/// Mode shapes and the tension are refreshed every this many samples.
const BLOCK: u32 = 16;
/// Strain at which polyester film yields (about 3%).
const YIELD_STRAIN: f32 = 0.03;
/// Radiated pressure (Pa at 1 m) that maps to full scale.
pub const FULL_SCALE_PA: f32 = 20.0;

/// What strikes the drum.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StrikerSpec {
    /// Effective mass at the tip, kg.
    pub mass: f32,
    pub tip: Tip,
    pub restitution: f32,
}

impl StrikerSpec {
    /// A hickory drumstick (about 45 g; a third of it at the bead) with a wooden tip.
    pub fn stick() -> Self {
        Self { mass: 0.016, tip: Tip::Solid { radius: 0.005, material: Material::HICKORY }, restitution: 0.7 }
    }
    /// A kick pedal's felt beater (its effective mass includes the pedal's shaft).
    pub fn felt_beater() -> Self {
        Self { mass: 0.11, tip: Tip::Felt { stiffness: 6.0e8, exponent: 2.3 }, restitution: 0.5 }
    }
    /// A hard plastic beater.
    pub fn plastic_beater() -> Self {
        Self { mass: 0.11, tip: Tip::Solid { radius: 0.025, material: Material::PLASTIC }, restitution: 0.5 }
    }
    /// A general-purpose timpani mallet: a felt ball on a light shaft.
    pub fn timpani_mallet() -> Self {
        Self { mass: 0.025, tip: Tip::Felt { stiffness: 3.0e8, exponent: 2.5 }, restitution: 0.6 }
    }
    /// A hard (staccato) timpani mallet.
    pub fn hard_mallet() -> Self {
        Self { mass: 0.025, tip: Tip::Felt { stiffness: 1.0e10, exponent: 2.5 }, restitution: 0.6 }
    }
}

/// A kind of drum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrumKind {
    Kick,
    FloorTom,
    RackTom,
    Timpani,
}

/// The physical description of a drum.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrumSpec {
    pub kind: DrumKind,
    pub batter: HeadSpec,
    pub reso: Option<HeadSpec>,
    /// Enclosed air volume, m^3 (0: none).
    pub volume: f32,
    pub striker: StrikerSpec,
    /// Modes kept per head.
    pub max_modes: usize,
}

impl DrumSpec {
    /// A 22" x 18" kick: two-ply batter with a pillow against it, single-ply resonant head. `tuning`
    /// is the batter's fundamental (its `(0,1)` mode with air loading, before the shell couples it).
    pub fn kick(tuning: f32) -> Self {
        let a = 0.2794;
        let batter = HeadSpec { loss: 25.0, loss_hf: 12.0, ..HeadSpec::two_ply(a) };
        let reso = HeadSpec { loss: 4.0, ..HeadSpec::single_ply(a) };
        Self::tuned(DrumSpec { kind: DrumKind::Kick, batter, reso: Some(reso), volume: std::f32::consts::PI * a * a * 0.457, striker: StrikerSpec::felt_beater(), max_modes: 400 }, tuning, tuning * 1.1)
    }

    /// A 16" x 16" floor tom.
    pub fn floor_tom(tuning: f32) -> Self {
        let a = 0.2032;
        Self::tuned(DrumSpec { kind: DrumKind::FloorTom, batter: HeadSpec::two_ply(a), reso: Some(HeadSpec::single_ply(a)), volume: std::f32::consts::PI * a * a * 0.406, striker: StrikerSpec::stick(), max_modes: 400 }, tuning, tuning * 1.15)
    }

    /// A 12" x 9" rack tom.
    pub fn rack_tom(tuning: f32) -> Self {
        let a = 0.1524;
        Self::tuned(DrumSpec { kind: DrumKind::RackTom, batter: HeadSpec::two_ply(a), reso: Some(HeadSpec::single_ply(a)), volume: std::f32::consts::PI * a * a * 0.229, striker: StrikerSpec::stick(), max_modes: 400 }, tuning, tuning * 1.15)
    }

    /// A 26" timpani (a single calfskin-weight film over a kettle of about 0.14 m^3). `pitch` is the
    /// note it plays, which is its `(1,1)` mode.
    pub fn timpani(pitch: f32) -> Self {
        let a = 0.33;
        let batter = HeadSpec { loss: 0.6, loss_hf: 1.5, ..HeadSpec::single_ply(a) };
        let mut s = DrumSpec { kind: DrumKind::Timpani, batter, reso: None, volume: 0.14, striker: StrikerSpec::timpani_mallet(), max_modes: 400 };
        s.batter.tension = Membrane::tension_for(s.batter, 1, 1, pitch, true);
        s
    }

    fn tuned(mut s: DrumSpec, batter: f32, reso: f32) -> Self {
        s.batter.tension = Membrane::tension_for(s.batter, 0, 1, batter, true);
        if let Some(r) = s.reso.as_mut() {
            r.tension = Membrane::tension_for(*r, 0, 1, reso, true);
        }
        s
    }
}

/// One strike.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Strike {
    /// Speed at impact, m/s (a ghost note is ~0.5, a loud backbeat 4-6).
    pub velocity: f32,
    /// Where on the batter head: 0 is the centre, 1 the rim.
    pub position: f32,
    /// Around the head, radians.
    pub angle: f32,
    pub striker: StrikerSpec,
}

struct Head {
    membrane: Membrane,
    body: ModalBody,
    k2: Vec<f32>,
    stretch: f32,
    /// Added tension at the film's yield strain, N/m.
    yield_tension: f32,
    tension: f32,
    /// Smoothed added tension, N/m.
    added: f32,
    /// Indices of the volume-changing modes and their swept volumes.
    volume_modes: Vec<(usize, f32)>,
}

impl Head {
    /// `driven_by_air_only`: a resonant head, which only the enclosed air moves, keeps only its
    /// axisymmetric modes - the others could never be excited.
    fn new(spec: HeadSpec, max_modes: usize, sr: f32, driven_by_air_only: bool) -> Self {
        let membrane = if driven_by_air_only { Membrane::axisymmetric(spec, max_modes, 0.45 * sr, true) } else { Membrane::new(spec, max_modes, 0.45 * sr, true) };
        let body = ModalBody::new(&membrane.mode_specs(), sr);
        let k2 = membrane.wavenumbers_squared();
        let stretch = membrane.stretch_coefficient();
        let yield_tension = spec.young * spec.thickness * YIELD_STRAIN / (1.0 - spec.poisson);
        let volume_modes = membrane.modes.iter().enumerate().filter(|(_, m)| m.m == 0).map(|(i, m)| (i, m.volume)).collect();
        Self { membrane, body, k2, stretch, yield_tension, tension: spec.tension, added: 0.0, volume_modes }
    }

    /// Tension modulation: the stretch of the head raises its tension, and every mode's frequency.
    ///
    /// The stretch is taken from each mode's amplitude averaged over its cycle, not the instantaneous
    /// `q^2`: the instantaneous tension also ripples at twice each mode's frequency, and a ripple
    /// followed even slightly late pumps energy into the head (parametric amplification) that the
    /// real head, whose in-plane waves carry that energy back, does not gain. Averaged, the tension
    /// follows the envelope - the pitch glide - and the modes keep their adiabatic invariant. The
    /// film cannot stretch without limit: beyond its yield strain it deforms instead.
    fn update_tension(&mut self, smoothing: f32) {
        let mut s = 0.0f32;
        for k in 0..self.k2.len() {
            s += self.k2[k] * self.body.mean_square(k);
        }
        let target = (self.stretch * s).min(self.yield_tension);
        self.added += (target - self.added) * smoothing;
        self.body.set_scale(((self.tension + self.added) / self.tension).sqrt());
    }

    fn swept_volume(&self) -> f32 {
        self.volume_modes.iter().map(|&(i, v)| v * self.body.q(i)).sum()
    }
}

struct Flight {
    striker: Striker,
    contact: Contact,
    shape: Vec<f32>,
    active: bool,
    age: u32,
}

/// A playing drum.
pub struct Drum {
    pub spec: DrumSpec,
    sr: f32,
    h: f32,
    heads: Vec<Head>,
    /// `rho c^2 / V`: pressure per unit of swept volume, Pa/m^3.
    cavity_stiffness: f32,
    flights: Vec<Flight>,
    counter: u32,
    smoothing: f32,
    /// The contact force on the batter head over the last sample (for the view and the tests).
    pub last_force: f32,
}

impl Drum {
    pub fn new(spec: DrumSpec, sr: f32) -> Self {
        let mut heads = vec![Head::new(spec.batter, spec.max_modes, sr, false)];
        if let Some(r) = spec.reso {
            heads.push(Head::new(r, spec.max_modes, sr, true));
        }
        let n = heads[0].body.len();
        let flights = (0..MAX_STRIKERS)
            .map(|_| Flight { striker: Striker { mass: 1.0, tip: spec.striker.tip, y: 0.0, v: 0.0 }, contact: Contact::new(ContactLaw::between(spec.striker.tip, Material::MYLAR, 0.5)), shape: vec![0.0; n], active: false, age: 0 })
            .collect();
        let cavity_stiffness = if spec.volume > 0.0 { RHO_AIR * C_AIR * C_AIR / spec.volume } else { 0.0 };
        // In-plane waves are fast: the tension follows the stretch within about a millisecond.
        let smoothing = 1.0 - (-(BLOCK as f32) / (0.0015 * sr)).exp();
        Self { spec, sr, h: 1.0 / sr, heads, cavity_stiffness, flights, counter: 0, smoothing, last_force: 0.0 }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    /// The batter head (0) or the resonant head (1).
    pub fn head(&self, i: usize) -> Option<&Membrane> {
        self.heads.get(i).map(|h| &h.membrane)
    }

    pub fn head_body(&self, i: usize) -> Option<&ModalBody> {
        self.heads.get(i).map(|h| &h.body)
    }

    /// Current tension of a head, N/m (rest tension plus the stretch).
    pub fn head_tension(&self, i: usize) -> f32 {
        self.heads.get(i).map(|h| h.tension + h.added).unwrap_or(0.0)
    }

    /// Throws a striker at the batter head. Takes the free slot, or the oldest one.
    pub fn strike(&mut self, s: Strike) {
        let slot = match self.flights.iter().position(|f| !f.active) {
            Some(i) => i,
            None => (0..self.flights.len()).max_by_key(|&i| self.flights[i].age).unwrap_or(0),
        };
        let head = &self.heads[0];
        let f = &mut self.flights[slot];
        head.membrane.shape_at(s.position, s.angle, &mut f.shape);
        let surface = head.body.displacement(&f.shape);
        f.striker = Striker { mass: s.striker.mass, tip: s.striker.tip, y: surface - s.velocity.max(0.0) * self.h * 1.5, v: s.velocity.max(0.0) };
        f.contact = Contact::new(ContactLaw::between(s.striker.tip, Material::MYLAR, s.striker.restitution));
        f.active = true;
        f.age = 0;
    }

    /// Whether anything is still in flight or in contact.
    pub fn striking(&self) -> bool {
        self.flights.iter().any(|f| f.active)
    }

    /// Total vibrational energy in the heads, J.
    pub fn energy(&self) -> f32 {
        self.heads.iter().map(|h| h.body.energy()).sum()
    }

    /// One sample of radiated sound, normalized so `FULL_SCALE_PA` at 1 m is 1.0.
    pub fn next_sample(&mut self) -> f32 {
        if self.counter % BLOCK == 0 {
            for h in self.heads.iter_mut() {
                h.body.flush_quiet();
                h.update_tension(self.smoothing);
            }
        }
        self.counter = self.counter.wrapping_add(1);

        // The enclosed air: the heads' swept volume raises the pressure, which pushes every
        // volume-changing mode of both heads back out.
        if self.cavity_stiffness > 0.0 {
            let swept: f32 = self.heads.iter().map(|h| h.swept_volume()).sum();
            let p = self.cavity_stiffness * swept;
            for h in self.heads.iter_mut() {
                for &(i, v) in h.volume_modes.iter() {
                    h.body.add_modal_force(i, -p * v);
                }
            }
        }

        // Strikers against the batter head.
        let h = self.h;
        let mut total = 0.0;
        let batter = &mut self.heads[0];
        for f in self.flights.iter_mut().filter(|f| f.active) {
            let (sy, sc) = f.striker.predict(h);
            let (by, bc) = batter.body.predict(&f.shape);
            let force = f.contact.solve(sy - by, sc + bc, h);
            f.striker.apply(force, h);
            batter.body.add_force(&f.shape, force);
            total += force;
            f.age += 1;
            // Done once it has left and is moving away (the player lifts it), or after half a second.
            let gone = f.contact.touches > 0 && !f.contact.touching && f.striker.v < 0.0 && f.contact.delta < -0.002;
            if gone || f.age as f32 > 0.5 * self.sr {
                f.active = false;
            }
        }
        self.last_force = total;

        let mut out = 0.0;
        for hd in self.heads.iter_mut() {
            out += hd.body.step();
        }
        out / FULL_SCALE_PA
    }
}

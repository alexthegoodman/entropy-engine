//! Cymbals: a bronze plate bent into a shallow dome, on a stand, struck.
//!
//! The body is a [`Plate`]: its lowest modes (up to a couple of kHz) are shell modes coupled by the
//! von Karman stretching ([`VonKarman`]); above them a complete band of linear modes, then a sampled
//! high band. Strikers meet it through the same contact model as the drums (a hickory bead on bronze
//! is a much stiffer contact than on a drumhead, and the plate gives way much less).
//!
//! What makes it a cymbal and not a bell is the nonlinearity: a light touch rings the modes the stick
//! excites, nearly linearly; a hard hit bends the plate by more than its own thickness, the stretching
//! couples the modes, and energy put into the low modes spreads upward over tens of milliseconds - the
//! crash's swell into a wash. Nothing in the presets shapes that: they are sizes, thicknesses, a dome
//! height and the metal's losses.

use super::contact::{Contact, ContactLaw, Material, Striker, Tip};
use super::drum::{Strike, StrikerSpec, FULL_SCALE_PA, MAX_STRIKERS};
use super::modal::ModalBody;
use super::plate::{Plate, PlateOptions, PlateSpec};
use super::vonkarman::VonKarman;

/// Silent modes are flushed every this many samples.
const FLUSH_EVERY: u32 = 64;

/// A kind of cymbal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CymbalKind {
    Crash,
    Ride,
    Splash,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CymbalSpec {
    pub kind: CymbalKind,
    pub plate: PlateSpec,
    pub options: PlateOptions,
    pub striker: StrikerSpec,
    /// The nonlinear force is evaluated every this many samples.
    pub every: u32,
}

impl StrikerSpec {
    /// A drumstick's shoulder, as a crash is played: the taper of the stick meets the edge, a
    /// larger, heavier contact than the bead.
    pub fn stick_shoulder() -> Self {
        Self { mass: 0.02, tip: Tip::Solid { radius: 0.02, material: Material::HICKORY }, restitution: 0.6 }
    }
    /// A soft yarn mallet, for cymbal swells.
    pub fn yarn_mallet() -> Self {
        Self { mass: 0.03, tip: Tip::Felt { stiffness: 5.0e7, exponent: 2.2 }, restitution: 0.5 }
    }
}

/// B20 cymbal bronze.
pub const BRONZE: Material = Material { young: 110.0e9, poisson: 0.34, density: 8600.0 };

impl CymbalSpec {
    /// A plate of `diameter` (m), `mass` (kg) and dome height `rise` (m, from the rim to the centre).
    fn plate(diameter: f32, mass: f32, rise: f32) -> PlateSpec {
        let a = diameter * 0.5;
        let thickness = mass / (BRONZE.density * std::f32::consts::PI * a * a);
        // A spherical cap of rise H over radius a has R = (a^2 + H^2) / 2H.
        let dome_radius = if rise > 0.0 { (a * a + rise * rise) / (2.0 * rise) } else { 0.0 };
        PlateSpec { radius: a, thickness, young: BRONZE.young, poisson: BRONZE.poisson, density: BRONZE.density, dome_radius, loss: 0.5, loss_hf: 0.7, mount_freq: 20.0, rock_freq: 5.0, mount_q: 3.0 }
    }

    /// A 16" crash, about 1.1 kg (a millimetre of bronze), 20 mm of rise.
    pub fn crash() -> Self {
        Self { kind: CymbalKind::Crash, plate: Self::plate(0.4064, 1.1, 0.02), options: PlateOptions::standard(), striker: StrikerSpec::stick_shoulder(), every: 2 }
    }

    /// A 20" ride, about 2.5 kg (1.4 mm), 28 mm of rise: thicker, so the same stroke bends it less
    /// and it stays nearer linear - the ping.
    pub fn ride() -> Self {
        Self { kind: CymbalKind::Ride, plate: Self::plate(0.508, 2.5, 0.028), options: PlateOptions::standard(), striker: StrikerSpec::stick(), every: 2 }
    }

    /// A 10" splash, about 0.25 kg (0.6 mm), 12 mm of rise.
    pub fn splash() -> Self {
        Self { kind: CymbalKind::Splash, plate: Self::plate(0.254, 0.25, 0.012), options: PlateOptions::standard(), striker: StrikerSpec::stick(), every: 2 }
    }

    /// The same cymbal with the von Karman coupling switched off (for the tests: what linear would
    /// sound like).
    pub fn linear(mut self) -> Self {
        self.every = 0;
        self
    }
}

struct Flight {
    striker: Striker,
    contact: Contact,
    shape: Vec<f32>,
    active: bool,
    age: u32,
}

/// A playing cymbal.
pub struct Cymbal {
    pub spec: CymbalSpec,
    sr: f32,
    h: f32,
    plate: Plate,
    body: ModalBody,
    vk: Option<VonKarman>,
    flights: Vec<Flight>,
    counter: u32,
    /// The contact force over the last sample, N.
    pub last_force: f32,
}

impl Cymbal {
    pub fn new(spec: CymbalSpec, sr: f32) -> Self {
        let options = PlateOptions { max_freq: spec.options.max_freq.min(0.45 * sr), ..spec.options };
        let plate = Plate::new(spec.plate, options);
        let mut body = ModalBody::new(&plate.mode_specs(), sr);
        body.set_coupled(plate.coupled);
        let vk = (spec.every > 0).then(|| VonKarman::new(&plate.couplings, &body, spec.plate.mass(), spec.every));
        let n = body.len();
        let flights = (0..MAX_STRIKERS)
            .map(|_| Flight { striker: Striker { mass: 1.0, tip: spec.striker.tip, y: 0.0, v: 0.0 }, contact: Contact::new(ContactLaw::between(spec.striker.tip, BRONZE, 0.5)), shape: vec![0.0; n], active: false, age: 0 })
            .collect();
        Self { spec, sr, h: 1.0 / sr, plate, body, vk, flights, counter: 0, last_force: 0.0 }
    }

    pub fn plate(&self) -> &Plate {
        &self.plate
    }

    pub fn body(&self) -> &ModalBody {
        &self.body
    }

    pub fn von_karman(&mut self) -> Option<&mut VonKarman> {
        self.vk.as_mut()
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    /// Energy in the modes, J (without the stretching).
    pub fn energy(&self) -> f32 {
        self.body.energy()
    }

    /// Throws a striker at the cymbal (`position` 0 at the centre, 1 at the edge).
    pub fn strike(&mut self, s: Strike) {
        let slot = match self.flights.iter().position(|f| !f.active) {
            Some(i) => i,
            None => (0..self.flights.len()).max_by_key(|&i| self.flights[i].age).unwrap_or(0),
        };
        let f = &mut self.flights[slot];
        self.plate.shape_at(s.position.min(0.98), s.angle, &mut f.shape);
        let surface = self.body.displacement(&f.shape);
        f.striker = Striker { mass: s.striker.mass, tip: s.striker.tip, y: surface - s.velocity.max(0.0) * self.h * 1.5, v: s.velocity.max(0.0) };
        f.contact = Contact::new(ContactLaw::between(s.striker.tip, BRONZE, s.striker.restitution));
        f.active = true;
        f.age = 0;
    }

    pub fn striking(&self) -> bool {
        self.flights.iter().any(|f| f.active)
    }

    /// One sample of radiated sound, normalized so `FULL_SCALE_PA` at 1 m is 1.0.
    pub fn next_sample(&mut self) -> f32 {
        if self.counter % FLUSH_EVERY == 0 {
            self.body.flush_quiet();
        }
        self.counter = self.counter.wrapping_add(1);
        let touching = self.flights.iter().any(|f| f.active && (f.contact.touching || f.contact.touches == 0));
        if let Some(vk) = self.vk.as_mut() {
            vk.tick(&mut self.body, touching);
        }
        let h = self.h;
        let mut total = 0.0;
        for f in self.flights.iter_mut().filter(|f| f.active) {
            let (sy, sc) = f.striker.predict(h);
            let (by, bc) = self.body.predict(&f.shape);
            let force = f.contact.solve(sy - by, sc + bc, h);
            f.striker.apply(force, h);
            self.body.add_force(&f.shape, force);
            total += force;
            f.age += 1;
            let gone = f.contact.touches > 0 && !f.contact.touching && f.striker.v < 0.0 && f.contact.delta < -0.002;
            if gone || f.age as f32 > 0.5 * self.sr {
                f.active = false;
            }
        }
        self.last_force = total;
        self.body.step() / FULL_SCALE_PA
    }
}

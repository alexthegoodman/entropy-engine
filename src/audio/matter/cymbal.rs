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

use super::contact::{Contact, ContactLaw, Material, StrikeReport, Striker, Tip};
use super::drum::{Strike, StrikerSpec, FULL_SCALE_PA, MAX_STRIKERS};
use super::modal::ModalBody;
use super::plate::{Plate, PlateOptions, PlateSpec};
use super::rub::{Rub, RubReport, Stroke, SurfaceKind, ToolSpec};
use super::surface::SurfaceMap;
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
    /// The latest strike, as it happens.
    pub report: StrikeReport,
    newest: usize,
    /// While the stretching's share of the plate's energy stays under this, the plate is treated as
    /// linear and the von Karman force is not evaluated, until the next strike (see
    /// `set_nonlinear_floor`). 0: always evaluated.
    nonlinear_floor: f32,
    dormant: bool,
    /// Recent peak of the stretching's `|U|`, J (it swings through zero every cycle), and its
    /// decay per sample.
    u_peak: f32,
    u_decay: f32,
    /// A tool rubbing the plate (see `enable_rubbing`).
    rub: Option<Box<Rub>>,
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
        Self { spec, sr, h: 1.0 / sr, plate, body, vk, flights, counter: 0, last_force: 0.0, report: StrikeReport::default(), newest: 0, nonlinear_floor: 0.0, dormant: false, u_peak: 0.0, u_decay: (-1.0 / (0.05 * sr)).exp(), rub: None }
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

    /// Lets the von Karman evaluation rest once the plate has fallen back to small amplitudes: when
    /// the stretching's energy (`|U|`, which grows faster than the modes' energy `E` with the
    /// amplitude) is below `floor * E` and nothing is touching the plate, the modes carry on as a
    /// linear plate until the next strike, which wakes the coupling and resynchronizes its energy.
    /// `U` swings through zero every cycle, so it is its peak over the last 50 ms that is compared.
    /// What that changes in the sound is measured in the tests.
    pub fn set_nonlinear_floor(&mut self, floor: f32) {
        self.nonlinear_floor = floor.max(0.0);
    }

    /// Whether the von Karman coupling is resting (see `set_nonlinear_floor`).
    pub fn nonlinear_resting(&self) -> bool {
        self.dormant
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
        self.newest = slot;
        self.dormant = false;
        self.u_peak = 0.0;
        self.report.begin(s.velocity.max(0.0), s.position, s.angle);
    }

    /// Whether anything is in flight or in contact (a tool rubbing the plate included).
    pub fn striking(&self) -> bool {
        self.flights.iter().any(|f| f.active) || self.rubbed()
    }

    fn rubbed(&self) -> bool {
        self.rub.as_ref().is_some_and(|r| r.active())
    }

    /// Makes the plate ready to be rubbed by `tool` (see `Drum::enable_rubbing`). The plate has only
    /// the cosine member of each mode pair (strikes are on `theta = 0`), so a path is heard as its
    /// mirror image about that diameter would be: a stroke along the diameter is exact.
    pub fn enable_rubbing(&mut self, tool: ToolSpec) {
        if self.rub.is_none() {
            let map = SurfaceMap::of_plate(&self.plate);
            self.rub = Some(Box::new(Rub::new(map, SurfaceKind::Bronze, 0.5 * self.spec.plate.thickness, tool, self.sr)));
        }
    }

    pub fn rubbing(&self) -> Option<&Rub> {
        self.rub.as_deref()
    }

    pub fn rubbing_mut(&mut self) -> Option<&mut Rub> {
        self.rub.as_deref_mut()
    }

    /// Plays a stroke on the plate. Enables rubbing first if it was not, which allocates.
    pub fn rub(&mut self, stroke: Stroke) {
        self.enable_rubbing(stroke.tool);
        if let Some(r) = self.rub.as_mut() {
            r.stroke(stroke);
            self.dormant = false;
            self.u_peak = 0.0;
        }
    }

    /// Holds a tool on the plate live (see `Drum::hold`).
    pub fn hold(&mut self, x: f32, y: f32, pressure: f32) {
        if let Some(r) = self.rub.as_mut() {
            r.hold(x, y, pressure);
            if pressure > 0.0 {
                self.dormant = false;
            }
        }
    }

    pub fn rub_report(&self) -> RubReport {
        self.rub.as_ref().map(|r| r.report).unwrap_or_default()
    }

    /// One sample of radiated sound, normalized so `FULL_SCALE_PA` at 1 m is 1.0.
    pub fn next_sample(&mut self) -> f32 {
        let touching = self.flights.iter().any(|f| f.active && (f.contact.touching || f.contact.touches == 0)) || self.rubbed();
        if self.counter % FLUSH_EVERY == 0 {
            self.body.flush_quiet();
            if let (Some(_), true, false, false) = (self.vk.as_ref(), self.nonlinear_floor > 0.0, touching, self.dormant) {
                if self.u_peak < self.nonlinear_floor * self.body.energy() {
                    self.dormant = true;
                }
            }
        }
        self.counter = self.counter.wrapping_add(1);
        if let (Some(vk), false) = (self.vk.as_mut(), self.dormant) {
            vk.tick(&mut self.body, touching);
            self.u_peak = (self.u_peak * self.u_decay).max(vk.potential.abs() as f32);
        }
        let h = self.h;
        let mut total = 0.0;
        for (slot, f) in self.flights.iter_mut().enumerate().filter(|(_, f)| f.active) {
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
            if slot == self.newest {
                self.report.track(&f.contact, f.striker.v);
                self.report.flying = f.active;
            }
        }
        self.last_force = total;
        if let Some(r) = self.rub.as_mut() {
            r.tick(&mut self.body);
        }
        self.body.step() / FULL_SCALE_PA
    }
}

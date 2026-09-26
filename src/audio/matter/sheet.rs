//! A sheet: a flat, free, circular plate of glass, steel or wood - a pane to rub a finger or a
//! rubber ball across, a sheet of metal to scrape. The same plate model as the cymbals (`plate`),
//! with no dome and no stand, at amplitudes where it stays linear, so it is just its modes: bending
//! waves on a free disc, radiating from both faces.
//!
//! It is here as the other half of the vision's "select two objects, press them together, drag
//! one": what a tool rubs when it isn't a drum or a cymbal.

use super::contact::{Contact, ContactLaw, StrikeReport, Striker};
use super::drop::{Drop, SplashReport, Splashes};
use super::drum::{Strike, FULL_SCALE_PA, MAX_STRIKERS};
use super::modal::ModalBody;
use super::plate::{Plate, PlateOptions, PlateSpec};
use super::rub::{Rub, RubReport, Stroke, SurfaceKind, ToolSpec};
use super::surface::SurfaceMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SheetSpec {
    pub surface: SurfaceKind,
    /// Radius and thickness, m.
    pub radius: f32,
    pub thickness: f32,
    /// Material losses: decay rate (1/s) and its rise per kHz.
    pub loss: f32,
    pub loss_hf: f32,
    /// Modes kept: every mode to this frequency (Hz), then a sampled band to 16 kHz.
    pub complete_freq: f32,
    /// Density, kg/m^3, if not the material's (0): for a sheet standing for a shaped one (see
    /// `rain::roof`).
    pub density: f32,
}

impl SheetSpec {
    /// A 30 cm disc of 4 mm float glass. Glass loses little to itself; most of a pane's damping is
    /// its mounting, here the soft support of a hand or a cloth.
    pub fn glass_pane() -> Self {
        Self { surface: SurfaceKind::Glass, radius: 0.15, thickness: 0.004, loss: 1.5, loss_hf: 0.6, complete_freq: 4000.0, density: 0.0 }
    }

    /// A 40 cm disc of 1 mm mild steel.
    pub fn steel_sheet() -> Self {
        Self { surface: SurfaceKind::Steel, radius: 0.2, thickness: 0.001, loss: 1.0, loss_hf: 0.4, complete_freq: 3000.0, density: 0.0 }
    }

    /// The same sheet with its density set.
    pub fn with_density(self, density: f32) -> Self {
        Self { density, ..self }
    }

    fn plate(&self) -> PlateSpec {
        let m = self.surface.material();
        let density = if self.density > 0.0 { self.density } else { m.density };
        PlateSpec { radius: self.radius, thickness: self.thickness, young: m.young, poisson: m.poisson, density, dome_radius: 0.0, loss: self.loss, loss_hf: self.loss_hf, mount_freq: 0.0, rock_freq: 0.0, mount_q: 3.0 }
    }

    fn options(&self, sr: f32) -> PlateOptions {
        // No von Karman set: a sheet rubbed or tapped moves far less than its thickness.
        PlateOptions { nonlinear_freq: 1.0, complete_freq: self.complete_freq, high_band_per_octave: 40.0, max_freq: 16_000.0f32.min(0.45 * sr), ..PlateOptions::standard() }
    }
}

struct Flight {
    striker: Striker,
    contact: Contact,
    shape: Vec<f32>,
    active: bool,
    age: u32,
}

/// A sheet, played.
pub struct Sheet {
    pub spec: SheetSpec,
    sr: f32,
    h: f32,
    plate: Plate,
    body: ModalBody,
    flights: Vec<Flight>,
    rub: Rub,
    wet: Option<Box<Splashes>>,
    pub report: StrikeReport,
    pub last_force: f32,
    counter: u32,
}

impl Sheet {
    /// A sheet ready to be rubbed with `tool` (and struck).
    pub fn new(spec: SheetSpec, tool: ToolSpec, sr: f32) -> Self {
        let plate = Plate::new(spec.plate(), spec.options(sr));
        let mut body = ModalBody::new(&plate.mode_specs(), sr);
        body.set_coupled(plate.coupled);
        let n = body.len();
        let material = spec.surface.material();
        let flights = (0..MAX_STRIKERS).map(|_| Flight { striker: Striker { mass: 1.0, tip: super::contact::Tip::Solid { radius: 0.005, material }, y: 0.0, v: 0.0 }, contact: Contact::new(ContactLaw { k: 1.0, alpha: 1.5, restitution: 0.5 }), shape: vec![0.0; n], active: false, age: 0 }).collect();
        let rub = Rub::new(SurfaceMap::of_plate(&plate), spec.surface, 0.5 * spec.thickness, tool, sr);
        Self { spec, sr, h: 1.0 / sr, plate, body, flights, rub, wet: None, report: StrikeReport::default(), last_force: 0.0, counter: 0 }
    }

    pub fn plate(&self) -> &Plate {
        &self.plate
    }

    pub fn body(&self) -> &ModalBody {
        &self.body
    }

    pub fn rubbing(&self) -> &Rub {
        &self.rub
    }

    pub fn rubbing_mut(&mut self) -> &mut Rub {
        &mut self.rub
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    pub fn energy(&self) -> f32 {
        self.body.energy()
    }

    pub fn rub(&mut self, stroke: Stroke) {
        self.rub.stroke(stroke);
    }

    pub fn hold(&mut self, x: f32, y: f32, pressure: f32) {
        self.rub.hold(x, y, pressure);
    }

    pub fn rub_report(&self) -> RubReport {
        self.rub.report
    }

    /// Taps the sheet (`position` 0 at the centre, 1 at the edge, on `theta = 0`).
    pub fn strike(&mut self, s: Strike) {
        let slot = self.flights.iter().position(|f| !f.active).unwrap_or(0);
        let f = &mut self.flights[slot];
        self.plate.shape_at(s.position.min(0.98), s.angle, &mut f.shape);
        let surface = self.body.displacement(&f.shape);
        f.striker = Striker { mass: s.striker.mass, tip: s.striker.tip, y: surface - s.velocity.max(0.0) * self.h * 1.5, v: s.velocity.max(0.0) };
        f.contact = Contact::new(ContactLaw::between(s.striker.tip, self.spec.surface.material(), s.striker.restitution));
        f.active = true;
        f.age = 0;
        self.report.begin(s.velocity.max(0.0), s.position, s.angle);
    }

    pub fn striking(&self) -> bool {
        self.flights.iter().any(|f| f.active) || self.rub.active() || self.wet.as_ref().is_some_and(|w| w.active())
    }

    /// Makes the sheet ready for drops to land anywhere on it (see `Drum::enable_splashes`).
    pub fn enable_splashes(&mut self) {
        if self.wet.is_none() {
            self.wet = Some(Box::new(Splashes::new(SurfaceMap::of_plate(&self.plate), self.sr)));
        }
    }

    /// A drop lands on the sheet at `(x, y)` m from its centre.
    pub fn splash(&mut self, drop: Drop, x: f32, y: f32) {
        self.splash_many(drop, x, y, 1.0);
    }

    /// As `splash`, standing for `count` drops (see `Splashes::land_many`).
    pub fn splash_many(&mut self, drop: Drop, x: f32, y: f32, count: f32) {
        self.enable_splashes();
        if let Some(w) = self.wet.as_mut() {
            w.land_many(&self.body, drop, x, y, count);
        }
    }

    pub fn splash_report(&self) -> SplashReport {
        self.wet.as_ref().map(|w| w.report).unwrap_or_default()
    }

    /// One sample of radiated sound, normalized so `FULL_SCALE_PA` at 1 m is 1.0.
    pub fn next_sample(&mut self) -> f32 {
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
            self.report.track(&f.contact, f.striker.v);
            let gone = f.contact.touches > 0 && !f.contact.touching && f.striker.v < 0.0 && f.contact.delta < -0.002;
            if gone || f.age as f32 > 0.5 * self.sr {
                f.active = false;
            }
        }
        self.last_force = total;
        self.rub.tick(&mut self.body);
        if let Some(w) = self.wet.as_mut() {
            self.last_force += w.tick(&mut self.body);
        }
        self.counter = self.counter.wrapping_add(1);
        if self.counter % 64 == 0 {
            self.body.flush_quiet();
        }
        self.body.step() / FULL_SCALE_PA
    }
}

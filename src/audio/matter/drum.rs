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

use super::contact::{Contact, ContactLaw, Material, StrikeReport, Striker, Tip};
use super::cavity::{Cavity, MAX_CAVITY_ORDER};
use super::membrane::{HeadSpec, Membrane, MembraneOptions};
use super::modal::{dot, ModalBody};

/// Default density of the sampled high band, modes per octave.
pub const HIGH_BAND: f32 = 40.0;
/// Heads carry modes up to this frequency, Hz.
const TOP_FREQ: f32 = 16_000.0;

/// Most strikers in flight or in contact at once (a flam, a roll, a buzz).
pub const MAX_STRIKERS: usize = 4;
/// The head's stretch is measured every this many samples; the tension is ramped between
/// measurements every sample.
const BLOCK: u32 = 16;
/// Below this summed mean-square motion (m^2) the resonant head cannot disturb resting snare wires.
const WIRE_WAKE: f32 = 1.0e-14;
/// Silent modes are flushed every this many samples.
const FLUSH_EVERY: u32 = 64;
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

/// A set of snare wires stretched across the resonant head.
///
/// The strands are gathered into `points` groups, each touching the head at one point of the strip
/// they cover. A group is a small mass held against the head by the strainer: a soft spring, preloaded
/// so it presses with `preload / points` newtons at rest, and lightly damped (coiled wire rubs on
/// itself). Between group and head is an ordinary contact (steel on polyester film). When the head
/// swings away faster than the preload can pull a group after it, the group lifts off, flies and
/// lands again - and each landing is a small, sharp impact on the head. That, repeated at every
/// point for as long as the head moves enough, is the snare's buzz.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnareWires {
    /// Contact groups (the strands are spread over them).
    pub points: usize,
    /// Mass of the strands that moves at the contacts, kg: a few centimetres of coil at each, not
    /// the whole strand.
    pub mass: f32,
    /// Total force pressing the wires onto the head at rest, N: the snare-tension knob. The wires
    /// hang under the head and the strainer's pull, turned by the snare beds, holds them up against
    /// it; at a usual setting the middle strands barely press, and a group lifts off when the head
    /// accelerates away from it faster than `preload / mass`. Looser wires lift off more easily and
    /// buzz longer.
    pub preload: f32,
    /// Spring holding each group toward the head, N/m.
    pub stiffness: f32,
    /// Quality factor of a group on its spring.
    pub q: f32,
    /// Width of the strip across the head (fraction of the radius) and its length (fraction of the
    /// diameter the strands lie on).
    pub width: f32,
    pub length: f32,
    /// Coefficient of restitution of a strand landing on the head.
    pub restitution: f32,
}

impl SnareWires {
    /// A 20-strand steel set on a 14" drum.
    pub fn twenty_strand() -> Self {
        Self { points: 8, mass: 0.006, preload: 0.15, stiffness: 150.0, q: 4.0, width: 0.42, length: 0.75, restitution: 0.35 }
    }

    /// Where group `i` touches the head: (radius fraction, angle).
    pub fn point(&self, i: usize) -> (f32, f32) {
        let per_row = self.points.div_ceil(2).max(1);
        let row = (i / per_row) as f32;
        let col = (i % per_row) as f32;
        let x = -self.length + 2.0 * self.length * (col + 0.5) / per_row as f32;
        let y = if self.points > 1 { self.width * 0.5 * (row * 2.0 - 1.0) * 0.5 } else { 0.0 };
        ((x * x + y * y).sqrt().min(0.98), y.atan2(x))
    }
}

/// A kind of drum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrumKind {
    Kick,
    Snare,
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
    /// Depth of a cylindrical shell, m, for the air's acoustic modes (0: only the uniform one).
    pub depth: f32,
    pub striker: StrikerSpec,
    /// Modes kept per head in the complete band.
    pub max_modes: usize,
    /// Sampled high-band modes per octave above it (see `MembraneOptions`).
    pub high_band: f32,
    /// Snare wires on the resonant head.
    pub snares: Option<SnareWires>,
}

impl DrumSpec {
    /// A 22" x 18" kick: two-ply batter with a pillow against it, single-ply resonant head. `tuning`
    /// is the batter's fundamental (its `(0,1)` mode with air loading, before the shell couples it).
    pub fn kick(tuning: f32) -> Self {
        let a = 0.2794;
        let batter = HeadSpec { loss: 25.0, loss_hf: 12.0, ..HeadSpec::two_ply(a) };
        let reso = HeadSpec { loss: 4.0, ..HeadSpec::single_ply(a) };
        Self::tuned(DrumSpec { kind: DrumKind::Kick, batter, reso: Some(reso), volume: std::f32::consts::PI * a * a * 0.457, depth: 0.457, striker: StrikerSpec::felt_beater(), max_modes: 400, high_band: HIGH_BAND, snares: None }, tuning, tuning * 1.1)
    }

    /// A 16" x 16" floor tom.
    pub fn floor_tom(tuning: f32) -> Self {
        let a = 0.2032;
        Self::tuned(DrumSpec { kind: DrumKind::FloorTom, batter: HeadSpec::two_ply(a), reso: Some(HeadSpec::single_ply(a)), volume: std::f32::consts::PI * a * a * 0.406, depth: 0.406, striker: StrikerSpec::stick(), max_modes: 400, high_band: HIGH_BAND, snares: None }, tuning, tuning * 1.15)
    }

    /// A 12" x 9" rack tom.
    pub fn rack_tom(tuning: f32) -> Self {
        let a = 0.1524;
        Self::tuned(DrumSpec { kind: DrumKind::RackTom, batter: HeadSpec::two_ply(a), reso: Some(HeadSpec::single_ply(a)), volume: std::f32::consts::PI * a * a * 0.229, depth: 0.229, striker: StrikerSpec::stick(), max_modes: 400, high_band: HIGH_BAND, snares: None }, tuning, tuning * 1.15)
    }

    /// A 14" x 5.5" snare: a coated 10-mil batter, a 3-mil snare-side head tuned about a fifth above
    /// it, twenty steel strands. `tuning` is the batter's fundamental.
    pub fn snare(tuning: f32) -> Self {
        let a = 0.1778;
        let batter = HeadSpec { thickness: 0.25e-3, loss: 4.0, loss_hf: 6.0, ..HeadSpec::single_ply(a) };
        let reso = HeadSpec { thickness: 0.076e-3, loss: 3.0, loss_hf: 3.0, ..HeadSpec::single_ply(a) };
        Self::tuned(DrumSpec { kind: DrumKind::Snare, batter, reso: Some(reso), volume: std::f32::consts::PI * a * a * 0.14, depth: 0.14, striker: StrikerSpec::stick(), max_modes: 360, high_band: HIGH_BAND, snares: Some(SnareWires::twenty_strand()) }, tuning, tuning * 1.5)
    }

    /// The same drum with its snares thrown off (the strainer lowers them clear of the head).
    pub fn snares_off(mut self) -> Self {
        self.snares = None;
        self
    }

    /// A 26" timpani (a single calfskin-weight film over a kettle of about 0.14 m^3). `pitch` is the
    /// note it plays, which is its `(1,1)` mode.
    pub fn timpani(pitch: f32) -> Self {
        let a = 0.33;
        let batter = HeadSpec { loss: 0.6, loss_hf: 1.5, ..HeadSpec::single_ply(a) };
        let mut s = DrumSpec { kind: DrumKind::Timpani, batter, reso: None, volume: 0.14, depth: 0.0, striker: StrikerSpec::timpani_mallet(), max_modes: 400, high_band: HIGH_BAND, snares: None };
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
    /// Smoothed added tension, N/m, and its change per sample.
    added: f32,
    ramp: f32,
    /// Sum of the modes' mean-square amplitudes at the last measurement, m^2.
    quiet: f32,
    /// The modes a uniform pressure outside can move (those that change the volume), and the
    /// volume each sweeps per metre, m^2: the generalized force of a pressure `p` on mode `k` is
    /// `p * volume`.
    breathing: Vec<(u32, f32)>,
}

impl Head {
    fn new(spec: HeadSpec, options: MembraneOptions, sr: f32) -> Self {
        let membrane = Membrane::with(spec, options);
        let mut body = ModalBody::new(&membrane.mode_specs(), sr);
        // The sampled high band (after the complete band) listens to contacts; see `set_coupled`.
        body.set_coupled(membrane.modes.iter().take_while(|m| m.count == 1.0).count());
        // Only the modes that take part in contacts stretch the head. The sampled high band is driven
        // one way (see `set_coupled`): its motion costs the striker nothing, so if it also raised the
        // tension that pushes the striker back, a hard hit on a slack head would take energy from
        // nowhere - a 6 m/s beater left a 55 Hz kick at 19 m/s. Its share of the stretch (the high
        // band holds a small part of the head's motion) is left out instead.
        let coupled = membrane.modes.iter().take_while(|m| m.count == 1.0).count();
        let mut k2 = membrane.wavenumbers_squared();
        k2.iter_mut().skip(coupled).for_each(|v| *v = 0.0);
        let stretch = membrane.stretch_coefficient();
        let yield_tension = spec.young * spec.thickness * YIELD_STRAIN / (1.0 - spec.poisson);
        let breathing = membrane.modes.iter().enumerate().filter(|(_, m)| m.volume != 0.0).map(|(k, m)| (k as u32, m.volume)).collect();
        Self { body, membrane, k2, stretch, yield_tension, tension: spec.tension, added: 0.0, ramp: 0.0, quiet: 0.0, breathing }
    }

    /// Tension modulation: the stretch of the head raises its tension, and every mode's frequency.
    ///
    /// The stretch is taken from each mode's amplitude averaged over its cycle, not the instantaneous
    /// `q^2`: the instantaneous tension also ripples at twice each mode's frequency, and a ripple
    /// followed even slightly late pumps energy into the head (parametric amplification) that the
    /// real head, whose in-plane waves carry that energy back, does not gain. Averaged, the tension
    /// follows the envelope - the pitch glide - and the modes keep their adiabatic invariant. The
    /// film cannot stretch without limit: beyond its yield strain it deforms instead.
    fn measure_stretch(&mut self, smoothing: f32) {
        let (mut s, mut all) = (0.0f32, 0.0f32);
        for k in 0..self.k2.len() {
            let ms = self.body.mean_square(k);
            s += self.k2[k] * ms;
            all += ms;
        }
        self.quiet = all;
        let target = (self.stretch * s).min(self.yield_tension);
        let next = self.added + (target - self.added) * smoothing;
        self.ramp = (next - self.added) / BLOCK as f32;
    }

    /// One sample of the ramp toward the last measured tension.
    fn retune(&mut self) {
        self.added += self.ramp;
        self.body.set_scale(((self.tension + self.added) / self.tension).sqrt());
    }

}

struct Flight {
    striker: Striker,
    contact: Contact,
    shape: Vec<f32>,
    active: bool,
    age: u32,
}

/// One group of snare strands, measured from where it rests on the (resting) head: `x` toward the
/// head.
struct Wire {
    x: f32,
    v: f32,
    shape: Vec<f32>,
    /// Penetration at rest, and the force the strainer presses with.
    delta0: f32,
    preload: f32,
    contact: Contact,
    lifted: bool,
    landings: u32,
    /// The head's compliance between this point and each group's (itself included), and the
    /// frequency scale they were computed at: they move with the tuning only in proportion, so they
    /// are refreshed after a 0.1% change.
    cross: Vec<f32>,
    tuned: f32,
    /// Force beyond the preload applied this sample.
    applied: f32,
}

/// A playing drum.
pub struct Drum {
    pub spec: DrumSpec,
    sr: f32,
    h: f32,
    heads: Vec<Head>,
    /// The air inside, coupling the heads.
    cavity: Option<Cavity>,
    flights: Vec<Flight>,
    wires: Vec<Wire>,
    /// The resonant head's free next displacements (scratch, one per mode).
    free: Vec<f32>,
    counter: u32,
    smoothing: f32,
    /// The contact force on the batter head over the last sample (for the view and the tests).
    pub last_force: f32,
    /// The latest strike, as it happens.
    pub report: StrikeReport,
    /// The flight slot of the latest strike.
    newest: usize,
    /// Sound pressure outside each head for the coming sample, Pa (see `add_pressure`).
    outside: [f32; 2],
}

impl Drum {
    pub fn new(spec: DrumSpec, sr: f32) -> Self {
        let top = TOP_FREQ.min(0.45 * sr);
        let batter = MembraneOptions { high_band_per_octave: spec.high_band, seed: 1, ..MembraneOptions::complete(spec.max_modes, top, true) };
        let mut heads = vec![Head::new(spec.batter, batter, sr)];
        if let Some(r) = spec.reso {
            // A resonant head that only the shell's air drives needs only its axisymmetric modes
            // (the air's pressure is uniform over it); one that snare wires touch at points all over
            // needs every mode, both members of each pair.
            let o = if spec.snares.is_some() {
                MembraneOptions { sine_partners: true, high_band_per_octave: spec.high_band, seed: 2, ..MembraneOptions::complete(spec.max_modes, top, true) }
            } else {
                // Only the air drives it: its modes up to the cavity's orders are all it needs.
                MembraneOptions { max_order: if spec.depth > 0.0 { MAX_CAVITY_ORDER } else { 0 }, ..MembraneOptions::complete(spec.max_modes, top, true) }
            };
            heads.push(Head::new(r, o, sr));
        }
        let wires = match (spec.snares, heads.get(1)) {
            (Some(w), Some(reso)) => (0..w.points.max(1))
                .map(|i| {
                    let (r, theta) = w.point(i);
                    let mut shape = vec![0.0; reso.body.len()];
                    reso.membrane.shape_at(r, theta, &mut shape);
                    let law = ContactLaw::between(Tip::Solid { radius: 0.0008, material: Material::STEEL }, Material::MYLAR, w.restitution);
                    let preload = w.preload / w.points.max(1) as f32;
                    // At rest the group presses with its preload: that sets the resting penetration.
                    let delta0 = (preload / law.k).powf(1.0 / law.alpha);
                    Wire { x: 0.0, v: 0.0, shape, delta0, preload, contact: Contact::resting(law, delta0, 0.3), lifted: false, landings: 0, cross: vec![0.0; w.points.max(1)], tuned: 0.0, applied: 0.0 }
                })
                .collect(),
            _ => Vec::new(),
        };
        let n = heads[0].body.len();
        let flights = (0..MAX_STRIKERS)
            .map(|_| Flight { striker: Striker { mass: 1.0, tip: spec.striker.tip, y: 0.0, v: 0.0 }, contact: Contact::new(ContactLaw::between(spec.striker.tip, Material::MYLAR, 0.5)), shape: vec![0.0; n], active: false, age: 0 })
            .collect();
        let cavity = (spec.volume > 0.0).then(|| Cavity::new(&heads.iter().map(|h| &h.membrane).collect::<Vec<_>>(), spec.volume, spec.depth, sr));
        // In-plane waves are fast: the tension follows the stretch in the time they take to cross
        // the head (0.14 ms on a 22" kick). Any slower, and a long contact - a beater buried in a
        // slack kick head - stretches the head on the way in against a tension that lags behind it
        // and is pushed back out by one that has not yet fallen: the lag's hysteresis hands the
        // beater more energy than it brought.
        let c_l = (spec.batter.young / (spec.batter.density * (1.0 - spec.batter.poisson * spec.batter.poisson))).sqrt();
        let smoothing = 1.0 - (-(BLOCK as f32) / (spec.batter.radius / c_l * sr)).exp();
        Self { spec, sr, h: 1.0 / sr, free: vec![0.0; heads.get(1).map_or(0, |h| h.body.len())], heads, cavity, flights, wires, counter: 0, smoothing, last_force: 0.0, report: StrikeReport::default(), newest: 0, outside: [0.0; 2] }
    }

    /// Number of (cavity mode, head mode) couplings.
    pub fn cavity_pairs(&self) -> (usize, usize) {
        self.cavity.as_ref().map(|c| (c.modes.len(), c.pair_count())).unwrap_or((0, 0))
    }

    /// How many times the snare wires have landed back on the head (all groups).
    pub fn wire_landings(&self) -> u32 {
        self.wires.iter().map(|w| w.landings).sum()
    }

    /// How many wire groups are off the head right now.
    pub fn wires_lifted(&self) -> usize {
        self.wires.iter().filter(|w| w.lifted).count()
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
        self.newest = slot;
        self.report.begin(s.velocity.max(0.0), s.position, s.angle);
    }

    /// Sound arriving from outside: `batter` and `reso` are the pressures (Pa) on the outer face of
    /// each head for the coming sample - another drum's hit, a cymbal, a loud room. A pressure
    /// uniform over a head moves only the modes that change the volume (the air inside then passes
    /// it on to the rest, as it does a stick's hit); that is how a tom or a kick sets the snare's
    /// wires buzzing. The pressure gradient across a head (which would drive its `m = 1` modes
    /// directly) is left out: at the frequencies that carry the energy the heads are smaller than
    /// the wavelength.
    pub fn add_pressure(&mut self, batter: f32, reso: f32) {
        self.outside[0] += batter;
        self.outside[1] += reso;
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
            let flush = self.counter % FLUSH_EVERY == 0;
            for h in self.heads.iter_mut() {
                if flush {
                    h.body.flush_quiet();
                }
                h.measure_stretch(self.smoothing);
            }
            if let (true, Some(c)) = (flush, self.cavity.as_mut()) {
                c.flush_quiet();
            }
        }
        for h in self.heads.iter_mut() {
            h.retune();
        }
        self.counter = self.counter.wrapping_add(1);

        // Sound from outside, before anything that predicts where the heads will be.
        for (hd, p) in self.heads.iter_mut().zip(self.outside) {
            if p != 0.0 {
                for &(k, v) in &hd.breathing {
                    hd.body.add_modal_force(k as usize, p * v);
                }
            }
        }
        self.outside = [0.0; 2];

        // The enclosed air: the heads' motion drives its modes, whose pressure pushes back on them.
        if let Some(cav) = self.cavity.as_mut() {
            let (first, rest) = self.heads.split_at_mut(1);
            cav.step(&mut first[0].body, rest.first_mut().map(|h| &mut h.body));
        }

        // Strikers against the batter head.
        let h = self.h;
        let mut total = 0.0;
        let batter = &mut self.heads[0];
        for (slot, f) in self.flights.iter_mut().enumerate().filter(|(_, f)| f.active) {
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
            if slot == self.newest {
                self.report.track(&f.contact, f.striker.v);
                self.report.flying = f.active;
            }
        }
        self.last_force = total;

        // Snare wires against the resonant head. Everything here is the motion about the rest state,
        // where each group presses with its preload: the head (linear) is simulated without the
        // static dent the preload makes, and gets only the force beyond it.
        // While the head is far too quiet to move them (well under a micron) and they are at rest,
        // the wires sit exactly in balance with their preload: nothing to solve.
        let wires_awake = self.heads.get(1).is_some_and(|r| r.quiet > WIRE_WAKE) || self.wires.iter().any(|g| g.lifted || g.x.abs() > 1.0e-9 || g.v.abs() > 1.0e-7);
        if let (Some(w), Some(reso), true) = (self.spec.snares, self.heads.get_mut(1), wires_awake) {
            let m = w.mass / w.points.max(1) as f32;
            let k = w.stiffness;
            let c = m * (k / m).sqrt() / w.q.max(0.1);
            if (reso.body.scale() / self.wires[0].tuned - 1.0).abs() > 1.0e-3 || self.wires[0].tuned == 0.0 {
                // In place: this runs on the audio thread.
                for a in 0..self.wires.len() {
                    for b in 0..self.wires.len() {
                        let c = reso.body.cross_compliance(&self.wires[a].shape, &self.wires[b].shape);
                        self.wires[a].cross[b] = c;
                    }
                    self.wires[a].tuned = reso.body.scale();
                }
            }
            // Every mode's free next position once; each group's free position is then a dot
            // product, plus what the groups solved before it this sample moved it.
            reso.body.free_displacements(&mut self.free);
            for gi in 0..self.wires.len() {
                let earlier: f32 = (0..gi).map(|b| self.wires[gi].cross[b] * self.wires[b].applied).sum();
                let g = &mut self.wires[gi];
                // Free motion of the group over the step: its spring and damper, and the preload that
                // the resting contact balances.
                let v_free = g.v + h * (g.preload - k * g.x - c * g.v) / m;
                let x_free = g.x + h * v_free;
                let hy = dot(&g.shape, &self.free) + earlier;
                let force = g.contact.solve(g.delta0 + x_free - hy, h * h / m + g.cross[gi], h);
                g.v = v_free - h * force / m;
                g.x += h * g.v;
                g.applied = force - g.preload;
                reso.body.add_force(&g.shape, g.applied);
                let lifted = force <= 0.0;
                if g.lifted && !lifted {
                    g.landings += 1;
                }
                g.lifted = lifted;
            }
        }

        let mut out = 0.0;
        for hd in self.heads.iter_mut() {
            out += hd.body.step();
        }
        out / FULL_SCALE_PA
    }
}

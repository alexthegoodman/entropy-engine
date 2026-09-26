//! Rubbing: a tool pressed on a surface and dragged across it - a brush on a snare, a finger on a
//! pane of glass, a rubber ball on a window, a rod scraped along a cymbal.
//!
//! A tool touches the surface at one or more **tips** (a finger at one; a brush's fan of wires at a
//! handful of groups, each a light striker of its own). Each tip is a small mass with two motions:
//!
//! * **Normal**: pressed on by the hand with its share of the pressure, meeting the surface through
//!   the ordinary contact model (`contact`: Hertz with Hunt-Crossley losses, solved implicitly every
//!   sample). The surface under it is the body's own motion *plus the surface's roughness*
//!   (`friction::Profile`) along the way the tip has slid, so a tip dragged over grit rides up
//!   every bump and, if it is light and fast enough, leaves the surface and lands again.
//! * **Tangential**: tied to the hand by the tool's shear stiffness (a wire's bending, a fingertip's
//!   pad, a rubber block's shear), and held by friction against the surface. The friction law is the
//!   bow's (`physmod::friction`) with the pair's coefficients, and its normal force is the contact
//!   force just solved, not a constant.
//!
//! What sounds is the body. It is pushed on along its normal by the contact force (the tip's shape
//! at the point, as a strike's), and on plates also by the tangential traction's moment about the
//! mid-plane, `F h / 2` along the path (the slope of the shapes, `surface::SurfaceMap`) - which is
//! what makes a finger drawn across glass ring it, since the glass is smooth. And the two directions
//! are tied together by the surface's slope: where the tip climbs a bump of slope `z'`, the normal
//! force pushes it back by `N z'` and friction presses the surface by `F z'`.
//!
//! So nothing is chosen between "squeak" and "scrape": slow and heavy, the tip sticks, the shear
//! spring winds up, it lets go and sticks again - stick-slip, a squeak at the pitch the tool and the
//! body settle on; fast and light, the falling friction curve can no longer overcome the tool's
//! damping, the tip slides steadily and the sound is the roughness passing under it - noise whose
//! spectrum moves with the speed.
//!
//! The hand follows a target position and pressure, from a [`Stroke`] (a sweep or a swirl, offline
//! or from a sequencer) or set live (a drag in the view). The mode shapes along the way come from a
//! `SurfaceMap`, refreshed every [`REFRESH`] samples and interpolated in between.
//!
//! Nothing here allocates after construction.

use super::contact::{Contact, ContactLaw, Material, Tip};
use super::friction::{FrictionPair, Profile, Roughness};
use super::modal::ModalBody;
use super::surface::SurfaceMap;
use crate::audio::physmod::friction::{self as bow, Contact as Grip};

/// Most tips a tool has.
pub const MAX_TIPS: usize = 12;
/// The tips' mode shapes are recomputed every this many samples (0.18 ms at 44.1 kHz: a tip at
/// 2 m/s moves 0.36 mm, a small fraction of the shortest mode's wavelength) and interpolated
/// between.
pub const REFRESH: u32 = 16;
/// Modes a tip feels (the lowest of the body's coupled modes; the default is all of them, as a
/// strike feels them): where the surface under a tip is, and how it gives, are summed over these;
/// the tips' forces drive every mode. Fewer would be cheaper, but a head's give at a point keeps
/// growing with the modes counted (a membrane's point compliance diverges slowly), and the tips
/// feel it: a brush's tips feeling only the lowest 128 of a snare's 768 made its sweep 6 dB brighter
/// above 3 kHz. (The sampled high band above the complete band is driven one way, as by a strike.)
pub const TWO_WAY: usize = usize::MAX;
/// `(a . x, b . x)`, eight lanes at a time (vectorizes).
fn dot2(a: &[f32], b: &[f32], x: &[f32]) -> (f32, f32) {
    let n = a.len().min(b.len()).min(x.len());
    let (a, b, x) = (&a[..n], &b[..n], &x[..n]);
    let (mut sa, mut sb) = ([0.0f32; 8], [0.0f32; 8]);
    let body = n / 8 * 8;
    for i in (0..body).step_by(8) {
        for l in 0..8 {
            sa[l] += a[i + l] * x[i + l];
            sb[l] += b[i + l] * x[i + l];
        }
    }
    let (mut ra, mut rb): (f32, f32) = (sa.iter().sum(), sb.iter().sum());
    for k in body..n {
        ra += a[k] * x[k];
        rb += b[k] * x[k];
    }
    (ra, rb)
}

/// `(a . x, b . x, a . y, b . y)`.
fn dot2x2(a: &[f32], b: &[f32], x: &[f32], y: &[f32]) -> (f32, f32, f32, f32) {
    let (ax, bx) = dot2(a, b, x);
    let (ay, by) = dot2(a, b, y);
    (ax, bx, ay, by)
}

/// `out += ca a + cb b` (vectorizes).
fn axpy2(out: &mut [f32], a: &[f32], b: &[f32], ca: f32, cb: f32) {
    let n = out.len().min(a.len()).min(b.len());
    for ((o, x), y) in out[..n].iter_mut().zip(&a[..n]).zip(&b[..n]) {
        *o += ca * x + cb * y;
    }
}

/// A new tip starts this far above the surface (m), so it settles on rather than hits it.
const START_GAP: f32 = 5.0e-6;
/// The hand follows its target through a critically damped response of this frequency (Hz): a
/// drag in the view arrives a few dozen times a second and is smoothed into a continuous motion.
const HAND_FOLLOW_HZ: f32 = 25.0;
/// A live hold's target keeps moving at its implied velocity for at most this long (s) before
/// the next one arrives.
pub const HOLD_COAST: f32 = 0.08;
/// Pressure changes are smoothed over about this long (s).
const PRESSURE_TIME: f32 = 0.01;

/// Human skin over a fingertip's pulp (effective modulus for its contact).
pub const SKIN: Material = Material { young: 0.3e6, poisson: 0.48, density: 1100.0 };

/// What a tool is made of (for the friction and contact with a surface).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ToolMaterial {
    Steel,
    Rubber,
    Finger,
    WetFinger,
    Wood,
}

/// What a surface is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SurfaceKind {
    CoatedHead,
    ClearHead,
    Bronze,
    Glass,
    Steel,
    Wood,
}

impl SurfaceKind {
    /// The surface's elastic material.
    pub fn material(self) -> Material {
        match self {
            SurfaceKind::CoatedHead | SurfaceKind::ClearHead => Material::MYLAR,
            SurfaceKind::Bronze => super::cymbal::BRONZE,
            SurfaceKind::Glass => Material::GLASS,
            SurfaceKind::Steel => Material::STEEL,
            SurfaceKind::Wood => Material::HICKORY,
        }
    }

    /// Its roughness, as made.
    pub fn roughness(self) -> Roughness {
        match self {
            SurfaceKind::CoatedHead => Roughness::COATED_HEAD,
            SurfaceKind::ClearHead => Roughness::CLEAR_HEAD,
            SurfaceKind::Bronze => Roughness::CYMBAL,
            SurfaceKind::Glass => Roughness::GLASS,
            SurfaceKind::Steel => Roughness { rms: 0.4e-6, ..Roughness::GLASS },
            SurfaceKind::Wood => Roughness::WOOD,
        }
    }
}

/// The friction coefficients of a tool's material on a surface.
pub fn pair(tool: ToolMaterial, surface: SurfaceKind) -> FrictionPair {
    use SurfaceKind as S;
    use ToolMaterial as T;
    match (tool, surface) {
        (T::Steel, S::CoatedHead) => FrictionPair::STEEL_COATED_HEAD,
        (T::Steel, S::ClearHead) => FrictionPair::STEEL_FILM,
        (T::Steel, S::Bronze) => FrictionPair::STEEL_BRONZE,
        (T::Steel, S::Steel) => FrictionPair::STEEL_STEEL,
        (T::Steel, S::Glass) => FrictionPair::new(0.5, 0.4, 0.03),
        (T::Steel, S::Wood) => FrictionPair::WOOD_METAL,
        (T::Rubber, S::Glass) => FrictionPair::RUBBER_GLASS,
        (T::Rubber, _) => FrictionPair::new(0.9, 0.7, 0.05),
        (T::WetFinger, S::Glass) => FrictionPair::WET_FINGER_GLASS,
        (T::Finger, _) | (T::WetFinger, _) => FrictionPair::FINGER,
        (T::Wood, S::Wood) => FrictionPair::WOOD_WOOD,
        (T::Wood, _) => FrictionPair::WOOD_METAL,
    }
}

/// A tool, per tip.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToolSpec {
    pub material: ToolMaterial,
    /// Contact points (a brush's wires gathered into groups; 1 for a finger).
    pub tips: usize,
    /// Moving mass at each tip, kg.
    pub mass: f32,
    /// The tip's shape against the surface (its radius also sets how much of the roughness it can
    /// follow).
    pub tip: Tip,
    pub restitution: f32,
    /// Stiffness tying each tip to the hand along the stroke, N/m.
    pub shear: f32,
    /// Decay rates of each tip's motion relative to the hand, 1/s: along the stroke, and along the
    /// normal.
    pub shear_damping: f32,
    pub normal_damping: f32,
    /// Width of the tips' fan across the stroke, and how far they spread along it, m.
    pub spread: f32,
    pub stagger: f32,
}

impl ToolSpec {
    /// A wire brush: about two hundred 0.3 mm steel wires fanned 5 cm wide, gathered into six
    /// groups. A wire is a floppy cantilever (`3 E I / L^3` is about 0.24 N/m for 10 cm of it, a
    /// couple of dozen per group); what meets the head at each landing is the last few millimetres of
    /// each wire in the group.
    pub fn brush() -> Self {
        Self { material: ToolMaterial::Steel, tips: 6, mass: 5.0e-5, tip: Tip::Solid { radius: 0.15e-3, material: Material::STEEL }, restitution: 0.5, shear: 8.0, shear_damping: 60.0, normal_damping: 300.0, spread: 0.05, stagger: 0.015 }
    }

    /// A fingertip: a few grams of pulp over bone, soft and heavily damped.
    pub fn finger() -> Self {
        Self { material: ToolMaterial::Finger, tips: 1, mass: 3.0e-3, tip: Tip::Solid { radius: 8.0e-3, material: SKIN }, restitution: 0.2, shear: 1500.0, shear_damping: 400.0, normal_damping: 800.0, spread: 0.0, stagger: 0.0 }
    }

    /// A wet fingertip (the glass harp's).
    pub fn wet_finger() -> Self {
        Self { material: ToolMaterial::WetFinger, ..Self::finger() }
    }

    /// A rubber ball or block (a squeegee, a sneaker sole).
    pub fn rubber() -> Self {
        Self { material: ToolMaterial::Rubber, tips: 1, mass: 2.0e-3, tip: Tip::Solid { radius: 5.0e-3, material: Material::RUBBER }, restitution: 0.6, shear: 8000.0, shear_damping: 150.0, normal_damping: 300.0, spread: 0.0, stagger: 0.0 }
    }

    /// A steel rod's rounded end (a triangle beater, a scraper).
    pub fn rod() -> Self {
        Self { material: ToolMaterial::Steel, tips: 1, mass: 0.01, tip: Tip::Solid { radius: 1.0e-3, material: Material::STEEL }, restitution: 0.7, shear: 1.0e5, shear_damping: 40.0, normal_damping: 60.0, spread: 0.0, stagger: 0.0 }
    }

    /// A drumstick's tip dragged (a scrape).
    pub fn stick_tip() -> Self {
        Self { material: ToolMaterial::Wood, tips: 1, mass: 0.016, tip: Tip::Solid { radius: 5.0e-3, material: Material::HICKORY }, restitution: 0.6, shear: 5.0e4, shear_damping: 80.0, normal_damping: 120.0, spread: 0.0, stagger: 0.0 }
    }

    fn tip_radius(&self) -> f32 {
        match self.tip {
            Tip::Solid { radius, .. } => radius,
            Tip::Felt { .. } => 5.0e-3,
        }
    }
}

/// A tool by name: "brush", "finger", "wet-finger", "rubber", "rod", "stick-tip".
pub fn tool_named(name: &str) -> Option<ToolSpec> {
    Some(match name {
        "brush" => ToolSpec::brush(),
        "finger" => ToolSpec::finger(),
        "wet-finger" => ToolSpec::wet_finger(),
        "rubber" => ToolSpec::rubber(),
        "rod" => ToolSpec::rod(),
        "stick-tip" => ToolSpec::stick_tip(),
        _ => return None,
    })
}

/// A tool's name (see [`tool_named`]); "custom" for any other.
pub fn tool_name(t: &ToolSpec) -> &'static str {
    for n in ["brush", "finger", "wet-finger", "rubber", "rod", "stick-tip"] {
        if tool_named(n).as_ref() == Some(t) {
            return n;
        }
    }
    "custom"
}

/// The way a stroke goes, in metres on the face (centre at the origin).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Path {
    /// From one point toward another (stopping there if the stroke lasts longer).
    Line { from: [f32; 2], to: [f32; 2] },
    /// Round a circle, counter-clockwise from angle 0 (a brush swirl).
    Circle { centre: [f32; 2], radius: f32 },
}

impl Path {
    /// Where the hand is after travelling `s` metres, and its unit direction.
    fn at(&self, s: f32) -> ([f32; 2], [f32; 2]) {
        match *self {
            Path::Line { from, to } => {
                let (dx, dy) = (to[0] - from[0], to[1] - from[1]);
                let len = (dx * dx + dy * dy).sqrt().max(1.0e-9);
                let s = s.clamp(0.0, len);
                ([from[0] + dx * s / len, from[1] + dy * s / len], [dx / len, dy / len])
            }
            Path::Circle { centre, radius } => {
                let a = s / radius.max(1.0e-6);
                let (sn, cs) = a.sin_cos();
                ([centre[0] + radius * cs, centre[1] + radius * sn], [-sn, cs])
            }
        }
    }

    fn length(&self) -> f32 {
        match *self {
            Path::Line { from, to } => ((to[0] - from[0]).powi(2) + (to[1] - from[1]).powi(2)).sqrt(),
            Path::Circle { .. } => f32::MAX,
        }
    }
}

/// A stroke: a tool pressed with `pressure` newtons (all tips together) and moved along `path` at
/// `speed` m/s for `duration` seconds, then lifted. The speed eases in and out over `ease` seconds,
/// as a hand does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stroke {
    pub tool: ToolSpec,
    pub path: Path,
    pub speed: f32,
    pub pressure: f32,
    pub duration: f32,
    pub ease: f32,
}

impl Stroke {
    /// A brush sweep across a head of radius `a` (m): a straight stroke through the middle of the
    /// head, as jazz players sweep across on the beat.
    pub fn sweep(a: f32, speed: f32, pressure: f32, duration: f32) -> Self {
        let from = [-0.6 * a, -0.25 * a];
        let to = [0.6 * a, 0.25 * a];
        Self { tool: ToolSpec::brush(), path: Path::Line { from, to }, speed, pressure, duration, ease: 0.03 }
    }

    /// A brush swirl on a head of radius `a`: circles about half-way out.
    pub fn swirl(a: f32, speed: f32, pressure: f32, duration: f32) -> Self {
        Self { tool: ToolSpec::brush(), path: Path::Circle { centre: [0.0, 0.0], radius: 0.45 * a }, speed, pressure, duration, ease: 0.05 }
    }

    /// With another tool.
    pub fn with_tool(self, tool: ToolSpec) -> Self {
        Self { tool, ..self }
    }

    /// Hand speed at time `t` (s) into the stroke.
    fn speed_at(&self, t: f32) -> f32 {
        let e = self.ease.max(1.0e-4);
        let up = (t / e).clamp(0.0, 1.0);
        let down = ((self.duration - t) / e).clamp(0.0, 1.0);
        let w = |x: f32| 0.5 - 0.5 * (std::f32::consts::PI * x).cos();
        self.speed * w(up) * w(down)
    }
}

/// What the hand does.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Gesture {
    None,
    /// Playing a stroke: seconds in, and metres along its path.
    Stroke { stroke: Stroke, t: f32, s: f32 },
    /// Held live at a target (see `Rub::hold`).
    Held,
}

/// One tip.
#[derive(Clone, Copy, Debug)]
struct TipState {
    /// Where it sits relative to the hand: across the stroke, and along it, m.
    across: f32,
    along: f32,
    /// Normal: position toward the surface and velocity (the surface at rest is at 0).
    y: f32,
    vy: f32,
    /// Along the stroke: deflection from the hand's rest point, and absolute velocity.
    u: f32,
    w: f32,
    /// How far it has slid over the surface (for the roughness under it), m. Double precision: a
    /// slow tip moves a fraction of a micron a sample.
    s: f64,
    contact: Contact,
    grip: Grip,
    /// Friction force on the tip over the last sample (along the stroke), N.
    friction: f32,
    /// Normal contact force over the last sample, N.
    normal: f32,
}

/// What a rub is doing, measured as it happens (for the view, the ops and the tests).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RubReport {
    /// Strokes (and live holds) so far.
    pub count: u32,
    pub active: bool,
    /// The hand: where (m on the face), how fast (m/s) and how hard it presses (N).
    pub x: f32,
    pub y: f32,
    pub speed: f32,
    pub pressure: f32,
    /// Summed over the tips, over the last sample: normal and friction forces, N.
    pub normal: f32,
    pub friction: f32,
    /// Tips touching the surface now.
    pub touching: u32,
    /// Since the stroke began: samples-tip stuck and sliding, and stick-to-slip releases.
    pub stuck: u64,
    pub sliding: u64,
    pub releases: u32,
    /// Landings of tips back on the surface after leaving it.
    pub landings: u32,
}

impl RubReport {
    /// Fraction of the touching time the tips spent stuck.
    pub fn stick_fraction(&self) -> f32 {
        self.stuck as f32 / (self.stuck + self.sliding).max(1) as f32
    }
}

/// A body being rubbed: the tool's tips and the hand, on one face. See the module notes.
pub struct Rub {
    sr: f32,
    h: f32,
    map: SurfaceMap,
    surface: SurfaceKind,
    /// Half the face's thickness, m (the lever of a tangential force on its bending).
    half_thickness: f32,
    roughness: Roughness,
    tool: ToolSpec,
    law: ContactLaw,
    friction: FrictionPair,
    tips: [TipState; MAX_TIPS],
    profiles: Vec<Profile>,
    n_tips: usize,
    gesture: Gesture,
    /// The hand: position, velocity, target; direction of travel; pressure now and wanted.
    hand: [f32; 2],
    hand_v: [f32; 2],
    target: [f32; 2],
    dir: [f32; 2],
    pressure: f32,
    pressure_target: f32,
    pressure_step: f32,
    follow: f32,
    /// Per tip: normal shapes and tangential (moment) shapes at the last refresh and the one before.
    phi: Vec<f32>,
    grad: Vec<f32>,
    /// Scratch for the map (one row) and the body's free displacements.
    row_phi: Vec<f32>,
    row_grad: Vec<f32>,
    free: Vec<f32>,
    /// Per tip at the two refreshes: one-step compliances (normal, tangential).
    comp: [[f32; 4]; MAX_TIPS],
    counter: u32,
    modes: usize,
    /// Modes the tips feel (see [`TWO_WAY`]).
    two_way: usize,
    /// The last live hold, the velocity it implied, and samples since.
    held: [f32; 2],
    held_v: [f32; 2],
    since_hold: u32,
    pub report: RubReport,
}

/// Index of `(tip, slot, mode)` in the shape buffers: two slots per tip.
#[inline]
fn at(n: usize, tip: usize, slot: usize) -> usize {
    (tip * 2 + slot) * n
}

impl Rub {
    /// Ready to rub a face mapped by `map` (of `half_thickness` m, made of `surface`) with `tool`.
    /// Builds its buffers here, off the audio thread.
    pub fn new(map: SurfaceMap, surface: SurfaceKind, half_thickness: f32, tool: ToolSpec, sr: f32) -> Self {
        let n = map.len();
        let rest = TipState { across: 0.0, along: 0.0, y: -START_GAP, vy: 0.0, u: 0.0, w: 0.0, s: 0.0, contact: Contact::new(ContactLaw { k: 1.0, alpha: 1.5, restitution: 0.5 }), grip: Grip::SlipBehind, friction: 0.0, normal: 0.0 };
        let roughness = surface.roughness();
        let mut r = Self {
            sr,
            h: 1.0 / sr,
            map,
            surface,
            half_thickness,
            roughness,
            tool,
            law: ContactLaw::between(tool.tip, surface.material(), tool.restitution),
            friction: pair(tool.material, surface),
            tips: [rest; MAX_TIPS],
            profiles: Vec::with_capacity(MAX_TIPS),
            n_tips: 0,
            gesture: Gesture::None,
            hand: [0.0; 2],
            hand_v: [0.0; 2],
            target: [0.0; 2],
            dir: [1.0, 0.0],
            pressure: 0.0,
            pressure_target: 0.0,
            pressure_step: 1.0 - (-1.0 / (PRESSURE_TIME * sr)).exp(),
            follow: std::f32::consts::TAU * HAND_FOLLOW_HZ,
            phi: vec![0.0; MAX_TIPS * 2 * n],
            grad: vec![0.0; MAX_TIPS * 2 * n],
            row_phi: vec![0.0; n],
            row_grad: vec![0.0; n],
            free: vec![0.0; n],
            comp: [[0.0; 4]; MAX_TIPS],
            counter: 0,
            modes: n,
            two_way: TWO_WAY,
            held: [0.0; 2],
            held_v: [0.0; 2],
            since_hold: u32::MAX,
            report: RubReport::default(),
        };
        r.set_tool(tool);
        r
    }

    /// The surface's roughness (a surface made smoother or rougher, for the tests and the ops).
    pub fn set_roughness(&mut self, r: Roughness) {
        self.roughness = r;
        let tool = self.tool;
        self.set_tool(tool);
    }

    /// How many of the body's lowest modes the tips feel (see [`TWO_WAY`]; for the tests).
    pub fn set_two_way(&mut self, n: usize) {
        self.two_way = n.max(1);
    }

    pub fn roughness(&self) -> Roughness {
        self.roughness
    }

    pub fn surface(&self) -> SurfaceKind {
        self.surface
    }

    /// Switches tools (only between strokes: a tool in contact keeps its tips). Rebuilds the tips'
    /// roughness profiles, which allocates: call off the audio thread, or through [`Rub::stroke`],
    /// which reuses them when the tool is the same.
    pub fn set_tool(&mut self, tool: ToolSpec) {
        self.tool = tool;
        self.n_tips = tool.tips.clamp(1, MAX_TIPS);
        self.law = ContactLaw::between(tool.tip, self.surface.material(), tool.restitution);
        self.friction = pair(tool.material, self.surface);
        self.profiles.clear();
        for i in 0..self.n_tips {
            // Each tip slides over its own patch of the surface.
            self.profiles.push(Profile::new(self.roughness.seeded(self.roughness.seed.wrapping_add(i as u32 * 7919)), tool.tip_radius()));
        }
        for (i, tp) in self.tips.iter_mut().take(self.n_tips).enumerate() {
            // Spread across the fan, and staggered along the stroke (a brush's wires don't end in a
            // straight line).
            let n = self.n_tips as f32;
            tp.across = if self.n_tips > 1 { tool.spread * ((i as f32 + 0.5) / n - 0.5) } else { 0.0 };
            let wobble = [0.1, 0.8, 0.35, 0.95, 0.5, 0.2, 0.7, 0.05, 0.6, 0.3, 0.9, 0.45];
            tp.along = if self.n_tips > 1 { tool.stagger * (wobble[i % 12] - 0.5) } else { 0.0 };
        }
    }

    pub fn tool(&self) -> ToolSpec {
        self.tool
    }

    /// The friction pair in use.
    pub fn friction(&self) -> FrictionPair {
        self.friction
    }

    /// Whether the tool is on (or being lifted off) the surface.
    pub fn active(&self) -> bool {
        !matches!(self.gesture, Gesture::None)
    }

    /// Starts a stroke (the tool must be the one the rub was set up with, or a tool of the same
    /// number of tips - switching tools rebuilds the tips' profiles: see `set_tool`).
    pub fn stroke(&mut self, stroke: Stroke) {
        if stroke.tool != self.tool {
            if stroke.tool.tips.clamp(1, MAX_TIPS) == self.n_tips {
                // Same tips, other material or size: no allocation.
                let profiles_ok = stroke.tool.tip == self.tool.tip;
                let keep = std::mem::take(&mut self.profiles);
                self.tool = stroke.tool;
                self.law = ContactLaw::between(stroke.tool.tip, self.surface.material(), stroke.tool.restitution);
                self.friction = pair(stroke.tool.material, self.surface);
                self.profiles = keep;
                if !profiles_ok {
                    let r = self.roughness;
                    for (i, p) in self.profiles.iter_mut().enumerate() {
                        *p = Profile::new(r.seeded(r.seed.wrapping_add(i as u32 * 7919)), stroke.tool.tip_radius());
                    }
                }
            } else {
                self.set_tool(stroke.tool);
            }
        }
        // A swirl that follows another stroke carries on round from where the hand is, rather than
        // jumping to the circle's start.
        let s0 = match (stroke.path, self.gesture) {
            (Path::Circle { centre, radius }, g) if !matches!(g, Gesture::None) => {
                let a = (self.hand[1] - centre[1]).atan2(self.hand[0] - centre[0]).rem_euclid(std::f32::consts::TAU);
                a * radius
            }
            _ => 0.0,
        };
        let (p, d) = stroke.path.at(s0);
        self.begin(p, d);
        self.gesture = Gesture::Stroke { stroke, t: 0.0, s: s0 };
        self.pressure_target = stroke.pressure.max(0.0);
    }

    /// Holds the tool live at `(x, y)` (m on the face) with `pressure` N: the hand moves there
    /// smoothly. A pressure of zero or less lifts it. The first hold after a lift puts it down where
    /// asked.
    ///
    /// Holds arrive a few dozen times a second (a drag in the view). Between them the target carries
    /// on at the velocity the last two implied, for up to [`HOLD_COAST`] seconds, so a steady drag
    /// is a steady motion rather than a hop every frame.
    pub fn hold(&mut self, x: f32, y: f32, pressure: f32) {
        if matches!(self.gesture, Gesture::None) {
            if pressure <= 0.0 {
                return;
            }
            self.begin([x, y], self.dir);
            self.gesture = Gesture::Held;
            self.held = [x, y];
            self.held_v = [0.0; 2];
            self.since_hold = 0;
        } else {
            if matches!(self.gesture, Gesture::Stroke { .. }) {
                self.gesture = Gesture::Held;
                self.held = self.target;
                self.since_hold = u32::MAX;
            }
            let dt = self.since_hold as f32 * self.h;
            if self.since_hold != u32::MAX && dt > 1.0e-3 && dt < 0.25 {
                let v = [(x - self.held[0]) / dt, (y - self.held[1]) / dt];
                // A little smoothing, for a hand that jitters.
                self.held_v = [0.5 * (self.held_v[0] + v[0]), 0.5 * (self.held_v[1] + v[1])];
            } else {
                self.held_v = [0.0; 2];
            }
            self.held = [x, y];
            self.since_hold = 0;
        }
        self.target = [x, y];
        // Lifting pulls the tool away (as the end of a stroke does).
        self.pressure_target = if pressure > 0.0 { pressure } else { -0.5 * self.pressure.max(0.05) };
    }

    fn begin(&mut self, p: [f32; 2], d: [f32; 2]) {
        let fresh = matches!(self.gesture, Gesture::None);
        self.target = p;
        self.dir = d;
        if fresh {
            self.hand = p;
            self.hand_v = [0.0; 2];
            self.pressure = 0.0;
            for tp in self.tips.iter_mut().take(self.n_tips) {
                *tp = TipState { y: -START_GAP, vy: 0.0, u: 0.0, w: 0.0, s: 0.0, contact: Contact::new(self.law), grip: Grip::SlipBehind, friction: 0.0, normal: 0.0, ..*tp };
            }
            self.counter = 0;
            self.report = RubReport { count: self.report.count.wrapping_add(1), active: true, ..Default::default() };
        }
    }

    /// Where tip `i` is on the face now.
    fn tip_point(&self, i: usize) -> [f32; 2] {
        let tp = &self.tips[i];
        let (d, n) = (self.dir, [-self.dir[1], self.dir[0]]);
        let along = tp.along + tp.u;
        [self.hand[0] + d[0] * along + n[0] * tp.across, self.hand[1] + d[1] * along + n[1] * tp.across]
    }

    /// Where each tip is on the face now, m (for the view).
    pub fn tip_points(&self, out: &mut [[f32; 2]]) -> usize {
        let n = self.n_tips.min(out.len());
        for (i, o) in out.iter_mut().take(n).enumerate() {
            *o = self.tip_point(i);
        }
        n
    }

    /// Recomputes every tip's shapes at where it is now (the older slot becomes the one to leave).
    fn refresh(&mut self, body: &ModalBody, two_way: usize) {
        let n = self.modes;
        let ht = self.half_thickness;
        for i in 0..self.n_tips {
            let p = self.tip_point(i);
            self.map.eval(p[0], p[1], self.dir[0], self.dir[1], &mut self.row_phi, &mut self.row_grad);
            // Slot 0 <- slot 1, slot 1 <- new.
            let (a, b) = (at(n, i, 0), at(n, i, 1));
            self.phi.copy_within(b..b + n, a);
            self.phi[b..b + n].copy_from_slice(&self.row_phi);
            self.comp[i][0] = self.comp[i][2];
            self.comp[i][2] = body.compliance(&self.phi[b..b + two_way]);
            if ht > 0.0 {
                self.grad.copy_within(b..b + n, a);
                for (g, d) in self.grad[b..b + n].iter_mut().zip(&self.row_grad) {
                    *g = -ht * d;
                }
                self.comp[i][1] = self.comp[i][3];
                self.comp[i][3] = body.compliance(&self.grad[b..b + two_way]);
            }
        }
    }

    /// Moves the hand one sample along its gesture.
    fn move_hand(&mut self) {
        let h = self.h;
        match &mut self.gesture {
            Gesture::None => return,
            Gesture::Stroke { stroke, t, s } => {
                let v = stroke.speed_at(*t);
                *s = (*s + v * h).min(stroke.path.length());
                *t += h;
                let (p, _) = stroke.path.at(*s);
                self.target = p;
                if *t >= stroke.duration {
                    self.pressure_target = -0.5 * stroke.pressure.max(0.05);
                }
            }
            Gesture::Held => {
                if self.since_hold != u32::MAX {
                    self.since_hold += 1;
                    let dt = self.since_hold as f32 * h;
                    if dt <= HOLD_COAST {
                        self.target = [self.held[0] + self.held_v[0] * dt, self.held[1] + self.held_v[1] * dt];
                    }
                }
            }
        }
        // Critically damped following of the target.
        let w = self.follow;
        for c in 0..2 {
            let acc = w * w * (self.target[c] - self.hand[c]) - 2.0 * w * self.hand_v[c];
            self.hand_v[c] += acc * h;
            self.hand[c] += self.hand_v[c] * h;
        }
        let speed = (self.hand_v[0] * self.hand_v[0] + self.hand_v[1] * self.hand_v[1]).sqrt();
        if speed > 1.0e-3 {
            self.dir = [self.hand_v[0] / speed, self.hand_v[1] / speed];
        }
        self.pressure += (self.pressure_target - self.pressure) * self.pressure_step;
        self.report.x = self.hand[0];
        self.report.y = self.hand[1];
        self.report.speed = speed;
        self.report.pressure = self.pressure.max(0.0);
    }

    /// One sample: moves the hand, solves every tip's contact and friction against `body` (whose
    /// other forces for this sample are already applied), and applies the tips' forces to it. Call
    /// before `body.step()`.
    pub fn tick(&mut self, body: &mut ModalBody) {
        if matches!(self.gesture, Gesture::None) {
            return;
        }
        self.move_hand();
        if self.counter % REFRESH == 0 {
            let two_way = body.coupled().min(self.modes).min(self.two_way);
            if self.counter == 0 {
                // The first refresh fills both slots.
                self.refresh(body, two_way);
            }
            self.refresh(body, two_way);
        }
        let t = (self.counter % REFRESH) as f32 / REFRESH as f32;
        self.counter = self.counter.wrapping_add(1);

        let h = self.h;
        let n = self.modes;
        let two_way = body.coupled().min(n).min(self.two_way);
        let tangential = self.half_thickness > 0.0;
        body.free_displacements(&mut self.free);
        let hand_along = self.hand_v[0] * self.dir[0] + self.hand_v[1] * self.dir[1];
        let per_tip = self.pressure / self.n_tips as f32;
        let tool = self.tool;
        let m = tool.mass;
        let (cn, ct) = (tool.normal_damping * m, tool.shear_damping * m);
        let mut report_normal = 0.0;
        let mut report_friction = 0.0;
        let mut touching = 0;
        let mut all_clear = self.pressure_target <= 0.0;
        for i in 0..self.n_tips {
            let (a, b) = (at(n, i, 0), at(n, i, 1));
            // The surface at the tip: where it will be with no new force, where it is, and how far a
            // newton moves it, interpolated between the two refreshes.
            let (fa, fb) = dot2(&self.phi[a..a + two_way], &self.phi[b..b + two_way], &self.free[..two_way]);
            let (ga, gb, na, nb) = if tangential {
                let (q, _) = body.displacements_and_forces();
                dot2x2(&self.grad[a..a + two_way], &self.grad[b..b + two_way], &self.free[..two_way], &q[..two_way])
            } else {
                (0.0, 0.0, 0.0, 0.0)
            };
            let lerp = |x: f32, y: f32| x + t * (y - x);
            let surf_free = lerp(fa, fb);
            let (tan_free, tan_now) = (lerp(ga, gb), lerp(na, nb));
            let comp_n = lerp(self.comp[i][0], self.comp[i][2]);
            let comp_t = lerp(self.comp[i][1], self.comp[i][3]);

            let tp = &mut self.tips[i];
            let profile = &self.profiles[i];
            // The roughness under where the tip will be.
            let rel_speed = (tp.w - (tan_free - tan_now) / h).abs();
            let (z, dz) = profile.at(tp.s + (h * rel_speed) as f64, 2.0 * rel_speed * h);
            // Normal: the hand's share of the pressure, the tip's damping, and last sample's friction
            // pressing through the slope, then the contact solved implicitly.
            let extra = tp.friction * dz;
            let vy_free = tp.vy + h * (per_tip - cn * tp.vy - extra) / m;
            let y_free = tp.y + h * vy_free;
            let fn_ = tp.contact.solve(y_free - surf_free + z, h * h / m + comp_n, h);
            tp.vy = vy_free - h * fn_ / m;
            tp.y += h * tp.vy;
            let was_touching = tp.normal > 0.0;
            if fn_ > 0.0 && !was_touching && tp.contact.touches > 1 {
                self.report.landings += 1;
            }
            tp.normal = fn_;
            // Along the stroke: the shear spring to the hand, its damping, and the slope pushing the
            // tip back; then friction, solved as the bow's is against the tip's and the surface's
            // mobilities, with the contact force just found as its normal force.
            let w_free = tp.w + h * (-tool.shear * tp.u - ct * (tp.w - hand_along) - fn_ * dz) / m;
            let mobility = h / m + comp_t / h;
            let surf_v_free = (tan_free - tan_now) / h + fn_ * dz * comp_t / h;
            let r_free = w_free - surf_v_free;
            let (r, grip) = bow::solve(r_free, 0.0, 0.5 / mobility, fn_, &self.friction.curve, tp.grip);
            let friction = if fn_ > 0.0 { (r - r_free) / mobility } else { 0.0 };
            let r = if fn_ > 0.0 { r } else { r_free };
            if fn_ > 0.0 {
                if tp.grip.is_stuck() && !grip.is_stuck() {
                    self.report.releases += 1;
                }
                tp.grip = grip;
                if grip.is_stuck() {
                    self.report.stuck += 1;
                } else {
                    self.report.sliding += 1;
                }
                touching += 1;
            }
            tp.friction = friction;
            tp.w = w_free + h * friction / m;
            tp.u += h * (tp.w - hand_along);
            tp.s += (h * r) as f64;
            // The body: the normal force (and the friction pressing through the slope) on the
            // normal shape, the traction along the surface on the moment shape.
            let normal = fn_ + extra;
            let traction = fn_ * dz - friction;
            let (wa, wb) = (1.0 - t, t);
            let (_, force) = body.displacements_and_forces();
            if normal != 0.0 {
                axpy2(&mut force[..n], &self.phi[a..a + n], &self.phi[b..b + n], wa * normal, wb * normal);
            }
            if tangential && traction != 0.0 {
                axpy2(&mut force[..n], &self.grad[a..a + n], &self.grad[b..b + n], wa * traction, wb * traction);
            }
            report_normal += fn_;
            report_friction += friction;
            if tp.y > -1.0e-3 || fn_ > 0.0 {
                all_clear = false;
            }
        }
        self.report.normal = report_normal;
        self.report.friction = report_friction;
        self.report.touching = touching;
        if all_clear && self.pressure < 0.0 {
            // Lifted clear: the stroke is over.
            self.gesture = Gesture::None;
            self.report.active = false;
            self.report.normal = 0.0;
            self.report.friction = 0.0;
        }
    }
}

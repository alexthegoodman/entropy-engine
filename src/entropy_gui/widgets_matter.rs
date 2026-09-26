//! `MatterView`: the drum kit drawn from the model's own state, in the same neon style as
//! `PhysModView` and `BrassView` - glowing lines, an orbiting camera, no attempt at photorealism.
//!
//! The kit stands where the sound model puts it (`audio::matter::kit::placement`: the same layout
//! sets how long each piece's sound takes to reach the others), every drum and cymbal its real
//! size. What moves is what the audio engine publishes in `audio::matter::MatterShared`:
//!
//! * each head and plate is drawn as rings and spokes displaced by the modes the audio is ringing
//!   with (the lowest few dozen, exaggerated): a centre hit on a drum lifts and drops the whole
//!   head, a hit near the rim sets the Chladni pattern of its nodal lines rocking, a crash's plate
//!   bends in its long bending modes;
//! * the stick (or beater, or mallet) replays each strike in slow motion from what the contact
//!   measured: it lands where it landed, stays down as long as the contact lasted (stretched for
//!   the eye) and leaves at the speed it actually rebounded - a felt beater buried in a slack kick
//!   barely comes back, a stick bounces off a tight snare;
//! * the snare wires under the snare glow while they are thrown off the head and land again -
//!   whether a stick hit the snare or a tom's sound crossed the kit and set them buzzing.
//!
//! **Physics View** (`MatterViewOptions::physics_view`) adds the struck piece's modes (frequency
//! against amplitude, with a hard hit's pitch glide), the contact force of the latest strike over
//! its few milliseconds, and the energy in every piece - which shows the sympathetic ringing.
//!
//! Interaction: click a head or a cymbal to strike it there (the place decides which modes ring);
//! shift-drag on one to press a tool on it and drag it across (a brush, rubbed live: its tips are
//! drawn where they touch); click a pad to strike a piece where it is usually played. The PHYSICS
//! chip toggles Physics View.
//! The right mouse button, Alt, or a pen's barrel button orbit the camera, as in the other
//! instrument views.

use crate::audio::matter::kit::{field_point, placement, Piece, Placement, FIELD, FIELD_RINGS, FIELD_SPOKES, PIECES, SPECTRUM};
use crate::audio::matter::live::{MatterShared, PieceView, TRACE_POINTS};
use crate::audio::matter::KitSpec;
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::shape::Shape;
use crate::entropy_gui::ui::Ui;

// ------------------------------------------------------------------------------------------
// Palette (shared with the other instrument views)
// ------------------------------------------------------------------------------------------

const BG_TOP: [f32; 3] = [0.028, 0.032, 0.070];
const BG_BOTTOM: [f32; 3] = [0.060, 0.050, 0.120];
const BRASS: [f32; 3] = [1.0, 0.74, 0.30];
const AMBER: [f32; 3] = [1.0, 0.78, 0.36];
const TEAL: [f32; 3] = [0.28, 0.90, 0.84];
const VIOLET: [f32; 3] = [0.58, 0.45, 1.0];
const ROSE: [f32; 3] = [1.0, 0.36, 0.42];
const SKY: [f32; 3] = [0.45, 0.62, 1.0];
const HEAD: [f32; 3] = [0.70, 0.74, 0.90];
const DIM: [f32; 3] = [0.34, 0.34, 0.46];
const LABEL: Color32 = Color32::from_rgb(170, 176, 205);

fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
fn c32(c: [f32; 3], a: f32) -> Color32 {
    Color32::from_rgba_f32([c[0], c[1], c[2], a.clamp(0.0, 1.0)])
}

/// Each piece's colour: the shells and the pads.
fn colour(p: Piece) -> [f32; 3] {
    match p {
        Piece::Kick => VIOLET,
        Piece::Snare => TEAL,
        Piece::RackTom | Piece::FloorTom => SKY,
        Piece::Crash | Piece::Splash => BRASS,
        Piece::Ride => AMBER,
    }
}

fn label(p: Piece) -> &'static str {
    match p {
        Piece::Kick => "KICK",
        Piece::Snare => "SNARE",
        Piece::RackTom => "RACK TOM",
        Piece::FloorTom => "FLOOR TOM",
        Piece::Crash => "CRASH",
        Piece::Ride => "RIDE",
        Piece::Splash => "SPLASH",
    }
}

// ------------------------------------------------------------------------------------------
// Camera
// ------------------------------------------------------------------------------------------

type V3 = [f32; 3];
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn scale(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V3) -> V3 {
    let l = dot(a, a).sqrt().max(1.0e-9);
    scale(a, 1.0 / l)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub yaw: f32,
    pub pitch: f32,
    pub dist: f32,
}

impl Default for Camera {
    /// From the audience, a little to the left and above: the whole kit and the drummer's side of
    /// the heads.
    fn default() -> Self {
        Self { yaw: -0.3, pitch: 0.72, dist: 3.1 }
    }
}

impl Camera {
    pub const PITCH_MIN: f32 = -0.2;
    pub const PITCH_MAX: f32 = 1.45;

    pub fn orbit(&mut self, dx: f32, dy: f32) {
        self.yaw += dx * 0.008;
        self.pitch = (self.pitch + dy * 0.008).clamp(Self::PITCH_MIN, Self::PITCH_MAX);
    }
}

/// The box the kit stands in, metres.
const FIT: (V3, V3) = ([-0.86, 0.15, -0.6], [0.95, 1.3, 0.3]);

#[derive(Clone, Copy, Debug)]
struct Projector {
    eye: V3,
    right: V3,
    up: V3,
    fwd: V3,
    focal: f32,
    shift: Pos2,
}

impl Projector {
    fn new(cam: &Camera, rect: Rect) -> Self {
        let (fit_min, fit_max) = FIT;
        let target = scale(add(fit_min, fit_max), 0.5);
        let diag = sub(fit_max, fit_min);
        let dist = cam.dist * dot(diag, diag).sqrt() / 2.0;
        // The camera sits in front of the kit (+z), where the audience is.
        let (sy, cy) = cam.yaw.sin_cos();
        let (sp, cp) = cam.pitch.sin_cos();
        let eye = [target[0] + dist * cp * sy, target[1] + dist * sp, target[2] + dist * cp * cy];
        let fwd = norm(sub(target, eye));
        let right = norm(cross(fwd, [0.0, 1.0, 0.0]));
        let up = cross(right, fwd);
        let mut p = Projector { eye, right, up, fwd, focal: 1.0, shift: pos2(0.0, 0.0) };
        let (mut lo, mut hi) = (pos2(f32::MAX, f32::MAX), pos2(f32::MIN, f32::MIN));
        for &x in &[fit_min[0], fit_max[0]] {
            for &y in &[fit_min[1], fit_max[1]] {
                for &z in &[fit_min[2], fit_max[2]] {
                    if let Some((q, _)) = p.project_raw([x, y, z]) {
                        lo = pos2(lo.x.min(q.x), lo.y.min(q.y));
                        hi = pos2(hi.x.max(q.x), hi.y.max(q.y));
                    }
                }
            }
        }
        let avail = Rect::from_min_max(pos2(rect.min.x + 18.0, rect.min.y + 14.0), pos2(rect.max.x - 18.0, rect.max.y - 14.0));
        let (bw, bh) = ((hi.x - lo.x).max(1.0e-3), (hi.y - lo.y).max(1.0e-3));
        p.focal = (avail.width() / bw).min(avail.height() / bh);
        p.shift = pos2(avail.center().x - (lo.x + hi.x) * 0.5 * p.focal, avail.center().y - (lo.y + hi.y) * 0.5 * p.focal);
        p
    }

    fn project_raw(&self, w: V3) -> Option<(Pos2, f32)> {
        let v = sub(w, self.eye);
        let depth = dot(v, self.fwd);
        if depth < 0.05 {
            return None;
        }
        Some((pos2(dot(v, self.right) / depth * self.focal + self.shift.x, -dot(v, self.up) / depth * self.focal + self.shift.y), depth))
    }

    fn project(&self, w: V3) -> Option<Pos2> {
        self.project_raw(w).map(|(p, _)| p)
    }

    fn depth(&self, w: V3) -> f32 {
        dot(sub(w, self.eye), self.fwd)
    }
}

// ------------------------------------------------------------------------------------------
// The pieces' geometry
// ------------------------------------------------------------------------------------------

/// A piece's face: its placement, and the two directions in its plane. Angle 0 on the face (where
/// the engine's `theta = 0` diameter lies) points toward the drummer, where sticks land.
#[derive(Clone, Copy)]
struct Face {
    pl: Placement,
    u: V3,
    v: V3,
    /// A cymbal's dome: sphere radius (m), 0 for a flat drum head.
    dome: f32,
}

impl Face {
    fn of(piece: Piece) -> Self {
        let pl = placement(piece);
        let n = pl.normal;
        let toward_drummer = [0.0, 0.0, -1.0];
        let t = sub(toward_drummer, scale(n, dot(toward_drummer, n)));
        let u = if dot(t, t) < 1.0e-4 { norm(sub([0.0, -1.0, 0.0], scale(n, -n[1]))) } else { norm(t) };
        let v = cross(n, u);
        let dome = KitSpec::default().cymbal(piece).map_or(0.0, |c| c.plate.dome_radius);
        Self { pl, u, v, dome }
    }

    /// Height of the dome above the rim at radius fraction `r`, m (exaggerated a little, so the
    /// shape reads).
    fn rise(&self, r: f32) -> f32 {
        if self.dome <= 0.0 {
            return 0.0;
        }
        let (a, big) = (self.pl.radius, self.dome);
        1.6 * (((big * big - (r * a).powi(2)).max(0.0)).sqrt() - (big * big - a * a).max(0.0).sqrt())
    }

    /// The point of the face at radius fraction `r`, angle `theta`, lifted by `w` along the normal.
    fn point(&self, r: f32, theta: f32, w: f32) -> V3 {
        let (s, c) = theta.sin_cos();
        let radial = add(scale(self.u, c * r * self.pl.radius), scale(self.v, s * r * self.pl.radius));
        add(add(self.pl.centre, radial), scale(self.pl.normal, self.rise(r) + w))
    }

    /// A point at radius fraction `r` of a circle `back` metres behind the face (the shell).
    fn ring_point(&self, r: f32, theta: f32, back: f32) -> V3 {
        let (s, c) = theta.sin_cos();
        let radial = add(scale(self.u, c * r * self.pl.radius), scale(self.v, s * r * self.pl.radius));
        add(add(self.pl.centre, radial), scale(self.pl.normal, -back))
    }
}

// ------------------------------------------------------------------------------------------
// Public options / events / response
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct MatterViewOptions {
    pub height: f32,
    pub width: Option<f32>,
    /// The row of pads along the bottom.
    pub pads: bool,
    pub physics_view: bool,
    /// Extra visual exaggeration of the heads' motion (1 = default).
    pub exaggeration: f32,
    /// A line shown over the kit (a kit being built, say).
    pub status: Option<String>,
}

impl Default for MatterViewOptions {
    fn default() -> Self {
        Self { height: 420.0, width: None, pads: true, physics_view: false, exaggeration: 1.0, status: None }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MatterViewEvent {
    /// A click on a head or a plate: strike it there (`position` 0 centre .. 1 edge, `angle` around
    /// it, as the engine measures them).
    Strike { piece: Piece, position: f32, angle: f32, velocity: f32 },
    /// A pad: strike the piece where it is usually played.
    Pad { piece: Piece, velocity: f32 },
    /// The PHYSICS chip was clicked: the view the user asked for.
    PhysicsView(bool),
    /// A shift-drag on a head or a plate: a tool held there (`x`, `y` in fractions of its radius from
    /// the centre, in the engine's frame), sent every frame of the drag; `pressure` N, 0 when let go.
    Rub { piece: Piece, x: f32, y: f32, pressure: f32 },
}

pub struct MatterViewResponse {
    pub events: Vec<MatterViewEvent>,
}

#[derive(Clone, Copy)]
enum Drag {
    Orbit,
    /// Rubbing a piece, last held at `(x, y)` (fractions of its radius).
    Rub(Piece, f32, f32),
    None,
}

/// How hard a drag presses when the pointer has no pressure of its own, N (a brush played gently).
const DRAG_PRESSURE: f32 = 1.0;

/// A strike being replayed.
#[derive(Clone, Copy, Default)]
struct Replay {
    seen: u32,
    /// Seconds (view time) since the strike was noticed; large when idle.
    t: f32,
    position: f32,
    angle: f32,
    speed_in: f32,
    speed_out: f32,
    contact_ms: f32,
    force: f32,
}

struct ViewState {
    camera: Camera,
    drag: Option<Drag>,
    last_pointer: Option<Pos2>,
    last_time: f32,
    /// Display scale for each face's displacement: follows its peak up at once, down slowly.
    scale_ref: [f32; PIECES],
    replay: [Replay; PIECES],
    /// Snare-wire activity (recent landings), 0..1, and the landings last seen.
    wires: f32,
    landings: u32,
    energy_top: f32,
}

impl Default for ViewState {
    fn default() -> Self {
        Self { camera: Camera::default(), drag: None, last_pointer: None, last_time: 0.0, scale_ref: [2.0e-5; PIECES], replay: [Replay { t: 99.0, ..Default::default() }; PIECES], wires: 0.0, landings: 0, energy_top: 1.0e-3 }
    }
}

/// Everything drawn this frame, read once from the shared state.
struct Scene {
    pieces: [PieceView; PIECES],
    field: Vec<[f32; FIELD]>,
    focus: Piece,
    modes: [(f32, f32); SPECTRUM],
    trace: [f32; TRACE_POINTS],
    trace_ms: f32,
    spec: KitSpec,
    workers: u32,
}

impl Scene {
    fn read(shared: &MatterShared) -> Self {
        let pieces = std::array::from_fn(|i| shared.piece(Piece::from_index(i)));
        let field = Piece::ALL
            .iter()
            .map(|&p| {
                let mut f = [0.0; FIELD];
                for (i, v) in f.iter_mut().enumerate() {
                    *v = shared.field(p, i);
                }
                f
            })
            .collect();
        let focus = shared.focus();
        let modes = std::array::from_fn(|k| shared.mode(focus, k));
        let trace = std::array::from_fn(|i| shared.trace(i));
        Self { pieces, field, focus, modes, trace, trace_ms: shared.trace_span().1, spec: shared.spec(), workers: shared.workers() }
    }

    fn tuning(&self, p: Piece) -> Option<f32> {
        match p {
            Piece::Kick => Some(self.spec.kick),
            Piece::Snare => Some(self.spec.snare),
            Piece::RackTom => Some(self.spec.rack_tom),
            Piece::FloorTom => Some(self.spec.floor_tom),
            _ => None,
        }
    }
}

/// Screen-space panels.
struct Layout {
    scene: Rect,
    chip: Rect,
    modes: Option<Rect>,
    force: Option<Rect>,
    energy: Option<Rect>,
    readout: Pos2,
}

impl Layout {
    fn new(stage: Rect, physics: bool) -> Self {
        let chip = Rect::from_min_size(pos2(stage.max.x - 92.0, stage.min.y + 10.0), vec2(80.0, 22.0));
        let w = (stage.width() * 0.3).clamp(180.0, 280.0);
        let x = stage.max.x - w - 12.0;
        let avail = (stage.max.y - chip.max.y - 20.0).max(150.0);
        let h = ((avail - 16.0) / 3.0).clamp(60.0, 150.0);
        let modes = physics.then(|| Rect::from_min_size(pos2(x, chip.max.y + 8.0), vec2(w, h)));
        let force = physics.then(|| Rect::from_min_size(pos2(x, chip.max.y + 16.0 + h), vec2(w, h)));
        let energy = physics.then(|| Rect::from_min_size(pos2(x, chip.max.y + 24.0 + 2.0 * h), vec2(w, h)));
        let scene = if physics { Rect::from_min_max(stage.min, pos2(x - 8.0, stage.max.y)) } else { stage };
        Self { scene, chip, modes, force, energy, readout: pos2(stage.min.x + 14.0, stage.min.y + 12.0) }
    }
}

const PAD_H: f32 = 56.0;

/// The pads' rectangles along the bottom of `rect`.
pub fn pad_rects(rect: Rect) -> [(Piece, Rect); PIECES] {
    let row = Rect::from_min_max(pos2(rect.min.x, rect.max.y - PAD_H), rect.max);
    let w = row.width() / PIECES as f32;
    std::array::from_fn(|i| (Piece::from_index(i), Rect::from_min_max(pos2(row.min.x + w * i as f32 + 3.0, row.min.y + 5.0), pos2(row.min.x + w * (i + 1) as f32 - 3.0, row.max.y - 3.0))))
}

// ------------------------------------------------------------------------------------------
// The widget
// ------------------------------------------------------------------------------------------

pub struct MatterView {
    id: Id,
}

impl MatterView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new(id_salt) }
    }

    pub fn show(self, ui: &mut Ui, opts: &MatterViewOptions, shared: &MatterShared) -> MatterViewResponse {
        let ctx = ui.ctx().clone();
        let width = opts.width.unwrap_or_else(|| ui.available_width().max(360.0));
        let (resp, painter) = ui.allocate_painter(vec2(width, opts.height.max(260.0)), Sense::click_and_drag());
        let rect = resp.rect;
        let scene = Scene::read(shared);

        let (pointer, mods) = ctx.input(|i| (i.pointer, i.modifiers));
        let mut st: ViewState = ctx.memory_mut(|m| m.take_view_state(self.id));
        let now = ctx.time();
        let dt = (now - st.last_time).clamp(0.0, 0.1);
        st.last_time = now;
        let mut events: Vec<MatterViewEvent> = Vec::new();
        let pos = pointer.pos;

        let pad_h = if opts.pads { PAD_H } else { 0.0 };
        let stage = Rect::from_min_max(rect.min, pos2(rect.max.x, rect.max.y - pad_h));
        let pads = pad_rects(rect);
        let lay = Layout::new(stage, opts.physics_view);
        let proj = Projector::new(&st.camera, lay.scene);

        // ---------------------------------------------------------------- input
        if st.drag.is_none() && (pointer.primary_pressed || pointer.secondary_pressed) {
            if let Some(p) = pos {
                let orbit = pointer.secondary_pressed || mods.alt || pointer.pen.is_some_and(|pn| pn.barrel);
                let pressure = pointer.pen.map(|pn| pn.pressure.max(0.2));
                if pointer.primary_pressed && lay.chip.contains(p) {
                    events.push(MatterViewEvent::PhysicsView(!opts.physics_view));
                    st.drag = Some(Drag::None);
                } else if orbit && stage.contains(p) {
                    st.drag = Some(Drag::Orbit);
                } else if pointer.primary_pressed && opts.pads && p.y > stage.max.y {
                    if let Some((piece, r)) = pads.iter().find(|(_, r)| r.contains(p)) {
                        let velocity = pressure.unwrap_or(0.35 + 0.65 * ((p.y - r.min.y) / r.height()).clamp(0.0, 1.0));
                        events.push(MatterViewEvent::Pad { piece: *piece, velocity });
                    }
                    st.drag = Some(Drag::None);
                } else if pointer.primary_pressed && mods.shift && lay.scene.contains(p) && !in_panels(&lay, p) {
                    // Shift-drag: press a tool on the face and drag it (the kick can't be rubbed).
                    st.drag = Some(Drag::None);
                    if let Some((piece, position, angle)) = face_at(&proj, p).filter(|f| f.0.rubbable()) {
                        let (x, y) = (position * angle.cos(), position * angle.sin());
                        events.push(MatterViewEvent::Rub { piece, x, y, pressure: pressure.map_or(DRAG_PRESSURE, |pr| 2.0 * pr) });
                        st.drag = Some(Drag::Rub(piece, x, y));
                    }
                } else if pointer.primary_pressed && lay.scene.contains(p) && !in_panels(&lay, p) {
                    if let Some((piece, position, angle)) = face_at(&proj, p) {
                        events.push(MatterViewEvent::Strike { piece, position, angle, velocity: pressure.unwrap_or(0.8) });
                    }
                    st.drag = Some(Drag::None);
                }
            }
        }
        let still_down = pointer.primary_down || pointer.secondary_down;
        if let Some(Drag::Orbit) = st.drag {
            if let (Some(p), Some(last)) = (pos, st.last_pointer) {
                st.camera.orbit(p.x - last.x, p.y - last.y);
            }
        }
        if let Some(Drag::Rub(piece, lx, ly)) = st.drag {
            if still_down {
                // Where the pointer is on the same face (off it, the tool stays where it was).
                let (x, y) = pos.and_then(|p| face_at(&proj, p)).filter(|f| f.0 == piece).map_or((lx, ly), |(_, r, a)| (r * a.cos(), r * a.sin()));
                let pressure = pointer.pen.map_or(DRAG_PRESSURE, |pn| 2.0 * pn.pressure.max(0.1));
                events.push(MatterViewEvent::Rub { piece, x, y, pressure });
                st.drag = Some(Drag::Rub(piece, x, y));
            } else {
                events.push(MatterViewEvent::Rub { piece, x: lx, y: ly, pressure: 0.0 });
            }
        }
        if !still_down {
            st.drag = None;
        }
        st.last_pointer = pos;

        // ---------------------------------------------------------------- state updates
        // Each face's motion is scaled by its own recent peak, but never by less than a fifth of the
        // kit's loudest: a few microns of sympathetic ringing shows as what it is next to the struck
        // head, not blown up to the same size.
        let kit_ref = st.scale_ref.iter().fold(0.0f32, |m, v| m.max(*v));
        for (i, pv) in scene.pieces.iter().enumerate() {
            let peak = scene.field[i].iter().fold(0.0f32, |m, v| m.max(v.abs()));
            let r = &mut st.scale_ref[i];
            *r = if peak > *r { peak } else { (*r * (-dt / 1.5).exp()).max(peak).max(2.0e-5) };
            *r = r.max(0.2 * kit_ref);
            let rp = &mut st.replay[i];
            if pv.strikes != rp.seen {
                *rp = Replay { seen: pv.strikes, t: 0.0, position: pv.position, angle: pv.angle, speed_in: pv.speed_in, speed_out: pv.speed_out, contact_ms: pv.contact_ms, force: pv.peak_force };
            } else {
                rp.t += dt;
                // The contact finishes after the view noticed the strike: keep its measurements.
                if rp.t < 0.2 {
                    rp.speed_out = pv.speed_out;
                    rp.contact_ms = pv.contact_ms;
                    rp.force = rp.force.max(pv.peak_force);
                }
            }
        }
        let snare = scene.pieces[Piece::Snare.index()];
        let new_landings = snare.wire_landings.saturating_sub(st.landings);
        st.landings = snare.wire_landings;
        st.wires = (st.wires * (-dt / 0.12).exp() + new_landings as f32 * 0.08 + snare.wires_lifted as f32 * 0.05).min(1.0);
        let e_top = scene.pieces.iter().fold(0.0f32, |m, p| m.max(p.energy));
        st.energy_top = if e_top > st.energy_top { e_top } else { (st.energy_top * (-dt / 4.0).exp()).max(1.0e-3) };

        // ---------------------------------------------------------------- drawing
        for y in 0..24 {
            let (t0, t1) = (y as f32 / 24.0, (y + 1) as f32 / 24.0);
            let band = Rect::from_min_max(pos2(rect.min.x, rect.min.y + t0 * rect.height()), pos2(rect.max.x, rect.min.y + t1 * rect.height()));
            painter.rect_filled(band, 0u8, c32(mix3(BG_TOP, BG_BOTTOM, (t0 + t1) * 0.5), 1.0));
        }
        let clip = painter.with_clip_rect(stage);
        draw_floor(&clip, &proj);
        // Back to front.
        let mut order: Vec<Piece> = Piece::ALL.to_vec();
        order.sort_by(|a, b| proj.depth(placement(*b).source()).total_cmp(&proj.depth(placement(*a).source())));
        for p in order {
            draw_stand(&clip, &proj, p);
            if p.is_cymbal() {
                draw_cymbal(&clip, &proj, p, &scene, &st, opts);
            } else {
                draw_drum(&clip, &proj, p, &scene, &st, opts);
            }
            draw_striker(&clip, &proj, p, &st);
            draw_tool(&clip, &proj, p, &scene);
        }
        draw_readout(&clip, &lay, &scene, opts);
        if let Some(r) = lay.modes {
            draw_modes(&clip, r, &scene);
        }
        if let Some(r) = lay.force {
            draw_force(&clip, r, &scene);
        }
        if let Some(r) = lay.energy {
            draw_energy(&clip, r, &scene, &st);
        }
        draw_chip(&clip, lay.chip, opts.physics_view);
        if opts.pads {
            draw_pads(&painter, &pads, &scene);
        }

        ctx.memory_mut(|m| m.put_view_state(self.id, st));
        MatterViewResponse { events }
    }
}

fn in_panels(lay: &Layout, p: Pos2) -> bool {
    [lay.modes, lay.force, lay.energy].iter().flatten().any(|r| r.contains(p)) || lay.chip.contains(p)
}

// ------------------------------------------------------------------------------------------
// Interaction geometry
// ------------------------------------------------------------------------------------------

/// Where a point of a piece's face is drawn (at rest) for a widget occupying `rect` with the
/// default camera: for tests and automation that want to click it.
pub fn face_screen(rect: Rect, opts: &MatterViewOptions, piece: Piece, position: f32, angle: f32) -> Option<Pos2> {
    let pad_h = if opts.pads { PAD_H } else { 0.0 };
    let stage = Rect::from_min_max(rect.min, pos2(rect.max.x, rect.max.y - pad_h));
    let proj = Projector::new(&Camera::default(), Layout::new(stage, opts.physics_view).scene);
    proj.project(Face::of(piece).point(position, angle, 0.0))
}

/// The face under a screen point: the nearest piece to the eye whose drawn outline contains it,
/// and where on it (radius fraction and angle), from a fine grid over each face.
fn face_at(proj: &Projector, p: Pos2) -> Option<(Piece, f32, f32)> {
    let mut best: Option<(f32, Piece, f32, f32)> = None;
    for piece in Piece::ALL {
        let face = Face::of(piece);
        let rim: Vec<Pos2> = (0..48).filter_map(|j| proj.project(face.point(1.0, std::f32::consts::TAU * j as f32 / 48.0, 0.0))).collect();
        if rim.len() < 48 || !inside(&rim, p) {
            continue;
        }
        let depth = proj.depth(face.pl.centre);
        if best.is_some_and(|b| b.0 < depth) {
            continue;
        }
        // The grid point nearest the click.
        let mut near = (f32::MAX, 0.0, 0.0);
        for ri in 0..=40 {
            let r = ri as f32 / 40.0;
            for j in 0..96 {
                let th = std::f32::consts::TAU * j as f32 / 96.0;
                if let Some(q) = proj.project(face.point(r, th, 0.0)) {
                    let d = (q - p).length();
                    if d < near.0 {
                        near = (d, r, th);
                    }
                }
            }
        }
        best = Some((depth, piece, near.1, near.2));
    }
    best.map(|(_, p, r, a)| (p, r, a))
}

fn inside(poly: &[Pos2], p: Pos2) -> bool {
    let mut c = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            c = !c;
        }
        j = i;
    }
    c
}

// ------------------------------------------------------------------------------------------
// Drawing
// ------------------------------------------------------------------------------------------

fn polyline(painter: &Painter, pts: &[Pos2], glow: f32, core: f32, colour: [f32; 3], alpha: f32) {
    if pts.len() < 2 {
        return;
    }
    if glow > 0.0 {
        for w in pts.windows(2) {
            painter.line_segment([w[0], w[1]], Stroke::new(glow, c32(colour, alpha * 0.28)));
        }
    }
    for w in pts.windows(2) {
        painter.line_segment([w[0], w[1]], Stroke::new(core, c32(mix3(colour, [1.0, 1.0, 1.0], 0.25), alpha)));
    }
}

fn draw_floor(painter: &Painter, proj: &Projector) {
    // A rug under the kit: concentric rings on the floor.
    for k in 1..=3 {
        let r = 0.26 * k as f32;
        let pts: Vec<Pos2> = (0..=64).filter_map(|j| {
            let a = std::f32::consts::TAU * j as f32 / 64.0;
            proj.project([r * a.cos(), 0.0, -0.2 + 0.6 * r * a.sin()])
        }).collect();
        polyline(painter, &pts, 0.0, 1.0, DIM, 0.18);
    }
}

fn draw_stand(painter: &Painter, proj: &Projector, piece: Piece) {
    let pl = placement(piece);
    let alpha = 0.35;
    let seg = |a: V3, b: V3, w: f32| {
        if let (Some(p), Some(q)) = (proj.project(a), proj.project(b)) {
            painter.line_segment([p, q], Stroke::new(w, c32(DIM, alpha)));
        }
    };
    match piece {
        Piece::Kick => {
            // Spurs, front of the shell.
            let front = pl.reso_centre();
            for s in [-1.0f32, 1.0] {
                seg([front[0] + s * 0.24, 0.12, front[2] - 0.02], [front[0] + s * 0.36, 0.0, front[2] + 0.08], 1.5);
            }
        }
        Piece::RackTom => {
            // Mounted on the kick.
            let base = [0.0, pl.centre[1] - 0.05, -0.02];
            seg(base, [0.0, 0.58, -0.05], 2.0);
        }
        Piece::FloorTom => {
            let back = pl.reso_centre();
            for k in 0..3 {
                let a = std::f32::consts::TAU * k as f32 / 3.0 + 0.4;
                let top = [pl.centre[0] + (pl.radius + 0.02) * a.cos(), pl.centre[1] - 0.05, pl.centre[2] + (pl.radius + 0.02) * a.sin()];
                seg(top, [top[0] + 0.05 * a.cos(), 0.0, top[2] + 0.05 * a.sin()], 1.5);
                let _ = back;
            }
        }
        _ => {
            // A stand straight down, and a tripod.
            let under = add(pl.reso_centre(), scale(pl.normal, if piece.is_cymbal() { -0.04 } else { -0.02 }));
            let foot = [under[0], 0.0, under[2]];
            seg(under, [foot[0], 0.18, foot[2]], 2.0);
            for k in 0..3 {
                let a = std::f32::consts::TAU * k as f32 / 3.0 + 0.3;
                seg([foot[0], 0.18, foot[2]], [foot[0] + 0.22 * a.cos(), 0.0, foot[2] + 0.22 * a.sin()], 1.5);
            }
        }
    }
}

/// A face's field point `i` displaced by the display scale.
fn face_point(face: &Face, field: &[f32; FIELD], i: usize, lift: f32) -> (V3, f32) {
    let (r, th) = field_point(i);
    let w = field[i] * lift;
    (face.point(r, th, w), field[i])
}

/// Rings and spokes of a face, lit by its motion.
fn draw_field(painter: &Painter, proj: &Projector, face: &Face, field: &[f32; FIELD], sref: f32, base: [f32; 3], lift: f32, awake: bool) {
    let colour_of = |w: f32| -> ([f32; 3], f32) {
        let t = (w / sref).clamp(-1.0, 1.0);
        let c = if t >= 0.0 { mix3(base, AMBER, t) } else { mix3(base, TEAL, -t) };
        (c, t.abs())
    };
    let seg = |a: (V3, f32), b: (V3, f32), core: f32| {
        if let (Some(p), Some(q)) = (proj.project(a.0), proj.project(b.0)) {
            let (c, g) = colour_of(0.5 * (a.1 + b.1));
            let g = if awake { g } else { 0.0 };
            if g > 0.05 {
                painter.line_segment([p, q], Stroke::new(3.0 + 5.0 * g, c32(c, 0.10 + 0.25 * g)));
            }
            painter.line_segment([p, q], Stroke::new(core, c32(c, 0.40 + 0.5 * g)));
        }
    };
    let idx = |ring: usize, spoke: usize| 1 + ring * FIELD_SPOKES + spoke % FIELD_SPOKES;
    for ring in 0..FIELD_RINGS {
        for j in 0..FIELD_SPOKES {
            let (a, b) = (face_point(face, field, idx(ring, j), lift), face_point(face, field, idx(ring, j + 1), lift));
            seg(a, b, if ring + 1 == FIELD_RINGS { 1.6 } else { 1.0 });
        }
    }
    for j in (0..FIELD_SPOKES).step_by(2) {
        let mut prev = face_point(face, field, 0, lift);
        for ring in 0..FIELD_RINGS {
            let next = face_point(face, field, idx(ring, j), lift);
            seg(prev, next, 0.8);
            prev = next;
        }
    }
}

/// How far a face's motion is lifted on screen: `sref` of motion is drawn as a few centimetres.
fn lift_for(sref: f32, radius: f32, opts: &MatterViewOptions) -> f32 {
    0.14 * radius * opts.exaggeration / sref.max(1.0e-9)
}

fn draw_drum(painter: &Painter, proj: &Projector, piece: Piece, scene: &Scene, st: &ViewState, opts: &MatterViewOptions) {
    let face = Face::of(piece);
    let pl = face.pl;
    let i = piece.index();
    let pv = scene.pieces[i];
    let col = colour(piece);
    let glow = (pv.level * 6.0).sqrt().clamp(0.0, 1.0);
    // The shell: both rims and staves between them.
    let ring = |back: f32| -> Vec<Pos2> { (0..=48).filter_map(|j| proj.project(face.ring_point(1.0, std::f32::consts::TAU * j as f32 / 48.0, back))).collect() };
    let (front, rear) = (ring(0.0), ring(pl.depth));
    // A faint fill for the far head, so the drum reads as a solid.
    if rear.len() > 3 {
        painter.add(Shape::convex_polygon(rear.clone(), c32(mix3(BG_BOTTOM, col, 0.12), 0.55), Stroke::new(0.0, Color32::TRANSPARENT)));
    }
    polyline(painter, &rear, 3.0, 1.2, col, 0.35 + 0.3 * glow);
    for j in 0..16 {
        let a = std::f32::consts::TAU * j as f32 / 16.0;
        if let (Some(p), Some(q)) = (proj.project(face.ring_point(1.0, a, 0.0)), proj.project(face.ring_point(1.0, a, pl.depth))) {
            painter.line_segment([p, q], Stroke::new(1.0, c32(col, 0.18 + 0.2 * glow)));
        }
    }
    // Tension rods round the batter rim.
    let lugs = if piece == Piece::Kick { 10 } else if piece == Piece::Snare { 10 } else { 8 };
    for j in 0..lugs {
        let a = std::f32::consts::TAU * (j as f32 + 0.5) / lugs as f32;
        if let Some(p) = proj.project(face.ring_point(1.04, a, 0.015)) {
            painter.circle_filled(p, 1.8, c32(mix3(col, [1.0; 3], 0.4), 0.6));
        }
    }
    if front.len() > 3 {
        painter.add(Shape::convex_polygon(front.clone(), c32(mix3(BG_TOP, HEAD, 0.10), 0.5), Stroke::new(0.0, Color32::TRANSPARENT)));
    }
    // The snare wires under the snare, glowing while they rattle.
    if piece == Piece::Snare && scene.spec.snares {
        let a = st.wires;
        for k in 0..8 {
            let y = -0.35 + 0.7 * (k as f32 + 0.5) / 8.0;
            let jitter = if a > 0.05 { 0.004 * a * ((k as f32 * 7.3 + st.last_time * 60.0).sin()) } else { 0.0 };
            let (p0, p1) = (face.ring_point(0.9, 0.0, pl.depth + 0.004 + jitter), face.ring_point(0.9, std::f32::consts::PI, pl.depth + 0.004 + jitter));
            let off = scale(face.v, y * pl.radius);
            if let (Some(p), Some(q)) = (proj.project(add(p0, off)), proj.project(add(p1, off))) {
                if a > 0.05 {
                    painter.line_segment([p, q], Stroke::new(3.5, c32(AMBER, 0.25 * a)));
                }
                painter.line_segment([p, q], Stroke::new(0.8, c32(mix3(DIM, AMBER, a), 0.5 + 0.5 * a)));
            }
        }
    }
    let sref = st.scale_ref[i];
    draw_field(painter, proj, &face, &scene.field[i], sref, HEAD, lift_for(sref, pl.radius, opts), pv.awake);
    polyline(painter, &front, 4.0, 1.6, col, 0.55 + 0.4 * glow);
}

fn draw_cymbal(painter: &Painter, proj: &Projector, piece: Piece, scene: &Scene, st: &ViewState, opts: &MatterViewOptions) {
    let face = Face::of(piece);
    let i = piece.index();
    let pv = scene.pieces[i];
    let col = colour(piece);
    let glow = (pv.level * 8.0).sqrt().clamp(0.0, 1.0);
    let sref = st.scale_ref[i];
    let lift = lift_for(sref, face.pl.radius, opts);
    // A faint plate under the lines.
    let rim: Vec<Pos2> = (0..FIELD_SPOKES).filter_map(|j| proj.project(face_point(&face, &scene.field[i], 1 + (FIELD_RINGS - 1) * FIELD_SPOKES + j, lift).0)).collect();
    if rim.len() > 3 {
        painter.add(Shape::convex_polygon(rim, c32(mix3(BG_BOTTOM, col, 0.18 + 0.2 * glow), 0.45), Stroke::new(0.0, Color32::TRANSPARENT)));
    }
    draw_field(painter, proj, &face, &scene.field[i], sref, mix3(col, DIM, 0.35), lift, pv.awake);
    // The bell and the felt.
    if let Some(c) = proj.project(face.point(0.0, 0.0, 0.0)) {
        painter.circle_filled(c, 4.0 + 6.0 * glow, c32(col, 0.25 + 0.3 * glow));
        painter.circle_filled(c, 2.2, c32(mix3(col, [1.0; 3], 0.5), 0.9));
    }
}

/// A tool being rubbed on a piece: the hand, and each tip where it touches, bright where the tips
/// are held by friction (the friction near its static limit), cool where they slide.
fn draw_tool(painter: &Painter, proj: &Projector, piece: Piece, scene: &Scene) {
    let pv = scene.pieces[piece.index()];
    if !pv.rubbing {
        return;
    }
    let face = Face::of(piece);
    let a = face.pl.radius;
    let at = |p: [f32; 2]| -> V3 {
        let r = ((p[0] * p[0] + p[1] * p[1]).sqrt() / a).min(1.0);
        face.point(r, p[1].atan2(p[0]), 0.002)
    };
    let hand = at(pv.hand);
    // The handle, up toward the player.
    let up = add(hand, scale(norm(add(face.pl.normal, scale(face.u, 0.6))), 0.3));
    let grip = (pv.rub_friction.abs() / pv.rub_normal.max(1.0e-6)).clamp(0.0, 1.0);
    let col = mix3(TEAL, ROSE, grip);
    if let (Some(p), Some(q)) = (proj.project(hand), proj.project(up)) {
        painter.line_segment([p, q], Stroke::new(4.0, c32(col, 0.15)));
        painter.line_segment([p, q], Stroke::new(1.6, c32([0.85, 0.85, 0.9], 0.8)));
    }
    for t in pv.tips.iter().take(pv.n_tips) {
        if let (Some(p), Some(h)) = (proj.project(at(*t)), proj.project(hand)) {
            painter.line_segment([h, p], Stroke::new(0.8, c32([0.8, 0.8, 0.85], 0.5)));
            painter.circle_filled(p, 4.0, c32(col, 0.25));
            painter.circle_filled(p, 1.8, c32(mix3(col, [1.0; 3], 0.4), 0.95));
        }
    }
}

/// The stick, beater or mallet replaying the latest strike in slow motion (see the module notes).
fn draw_striker(painter: &Painter, proj: &Projector, piece: Piece, st: &ViewState) {
    let rp = st.replay[piece.index()];
    let face = Face::of(piece);
    let kick = piece == Piece::Kick;
    // Time stretched so a contact of a few milliseconds lasts long enough to see.
    let contact = (rp.contact_ms / 1000.0 * 30.0).clamp(0.05, 0.35);
    let visible = kick || (rp.seen > 0 && rp.t < 1.0);
    if !visible {
        return;
    }
    let rest = 0.10;
    let lift = if rp.seen == 0 || rp.t > 1.0 {
        rest
    } else if rp.t < contact {
        0.0
    } else {
        // It leaves at the speed it rebounded (relative to how it came in), and the player lifts it.
        let bounce = (rp.speed_out / rp.speed_in.max(0.1)).clamp(0.0, 1.2);
        (0.16 * bounce * ((rp.t - contact) / 0.35).min(1.0) + rest * ((rp.t - contact - 0.35) / 0.4).clamp(0.0, 1.0)).min(rest.max(0.16 * bounce))
    };
    let fade = if kick { 1.0 } else { (1.0 - (rp.t - 0.6).max(0.0) / 0.4).clamp(0.0, 1.0) };
    let (pos, ang) = if rp.seen == 0 { (0.3, 0.0) } else { (rp.position, rp.angle) };
    let tip = face.point(pos, ang, lift);
    // The flash of the contact itself, sized by its force.
    if rp.seen > 0 && rp.t < contact + 0.1 {
        if let Some(p) = proj.project(face.point(pos, ang, 0.0)) {
            let k = 1.0 - (rp.t / (contact + 0.1)).clamp(0.0, 1.0);
            let r = 4.0 + 3.0 * (1.0 + rp.force).log10();
            painter.circle_filled(p, r * 2.0, c32(AMBER, 0.18 * k));
            painter.circle_filled(p, r, c32([1.0, 0.95, 0.85], 0.55 * k));
        }
    }
    let (hand, tip_r) = if kick {
        // The pedal's shaft pivots near the floor, behind the batter.
        ([0.0, 0.06, face.pl.centre[2] - 0.12], 0.035)
    } else {
        // Toward the drummer's hand: up and back from where it lands.
        let d = norm([tip[0] * 0.3 - tip[0], 0.55, -0.9]);
        (add(tip, scale(d, 0.42)), 0.008)
    };
    if let (Some(p), Some(q)) = (proj.project(tip), proj.project(hand)) {
        painter.line_segment([p, q], Stroke::new(5.0, c32(AMBER, 0.12 * fade)));
        painter.line_segment([p, q], Stroke::new(if kick { 2.0 } else { 2.4 }, c32([0.95, 0.85, 0.65], 0.85 * fade)));
        let r = (tip_r * proj.focal / proj.depth(tip).max(0.1)).clamp(2.0, 12.0);
        painter.circle_filled(p, r, c32(if kick { [0.9, 0.9, 0.95] } else { [1.0, 0.9, 0.7] }, 0.9 * fade));
    }
}

fn draw_readout(painter: &Painter, lay: &Layout, scene: &Scene, opts: &MatterViewOptions) {
    let mut y = lay.readout.y;
    let line = |txt: String, y: &mut f32, c: Color32| {
        painter.text(pos2(lay.readout.x, *y), Align2::LEFT_TOP, txt, FontId::proportional(11.0), c);
        *y += 15.0;
    };
    if let Some(s) = &opts.status {
        line(s.clone(), &mut y, c32(AMBER, 0.95));
    }
    let f = scene.focus;
    let pv = scene.pieces[f.index()];
    let tuned = scene.tuning(f).map(|t| format!("  -  tuned {t:.0} Hz")).unwrap_or_default();
    line(format!("{}{}", label(f), tuned), &mut y, c32(colour(f), 0.95));
    if pv.rubbing {
        line(format!("rubbed at {:.2} m/s, {:.1} N  -  friction {:.2} N  -  stuck {:.0}% of the time, {} releases", pv.rub_speed, pv.rub_pressure, pv.rub_friction.abs(), pv.stick * 100.0, pv.releases), &mut y, c32(TEAL, 0.95));
        return;
    }
    if pv.strikes == 0 {
        line("click a head or a cymbal to strike it there - shift-drag to rub it - or play a pad".into(), &mut y, LABEL);
        return;
    }
    line(format!("in {:.1} m/s  -  contact {:.1} ms, {:.0} N  -  out {:.1} m/s", pv.speed_in, pv.contact_ms, pv.peak_force, pv.speed_out), &mut y, LABEL);
    if f.is_cymbal() {
        line(if pv.nonlinear { "bending past its thickness: modes coupled, energy climbing".to_string() } else { "ringing linearly".to_string() }, &mut y, c32(if pv.nonlinear { ROSE } else { TEAL }, 0.95));
    } else if pv.glide_cents > 3.0 {
        line(format!("head stretched: pitch {:+.0} cents, gliding down", pv.glide_cents), &mut y, c32(ROSE, 0.95));
    }
    let snare = scene.pieces[Piece::Snare.index()];
    if scene.spec.snares && (snare.wires_lifted > 0 || (f == Piece::Snare && snare.wire_landings > 0)) {
        line(format!("snare wires: {} of 8 off the head, {} landings", snare.wires_lifted, snare.wire_landings), &mut y, c32(AMBER, 0.9));
    }
    if opts.physics_view {
        line(format!("sympathetic ringing {}  -  {} threads", if scene.spec.sympathetic { "on" } else { "off" }, scene.workers + 1), &mut y, LABEL);
    }
}

fn panel(painter: &Painter, r: Rect, title: &str) {
    painter.rect_filled(r, 6u8, c32([0.03, 0.03, 0.07], 0.82));
    painter.rect_stroke(r, 6u8, Stroke::new(1.0, c32(DIM, 0.6)), StrokeKind::Middle);
    painter.text(pos2(r.min.x + 8.0, r.min.y + 5.0), Align2::LEFT_TOP, title, FontId::proportional(9.5), LABEL);
}

fn inner(r: Rect) -> Rect {
    Rect::from_min_max(pos2(r.min.x + 26.0, r.min.y + 20.0), pos2(r.max.x - 8.0, r.max.y - 16.0))
}

/// The modes panel's frequency axis (log), Hz.
const MODES_HZ: (f32, f32) = (30.0, 6000.0);

fn hz_to_x(plot: Rect, hz: f32) -> f32 {
    let (lo, hi) = MODES_HZ;
    plot.min.x + (hz.clamp(lo, hi).ln() - lo.ln()) / (hi.ln() - lo.ln()) * plot.width()
}

fn draw_modes(painter: &Painter, r: Rect, scene: &Scene) {
    let f = scene.focus;
    panel(painter, r, &format!("MODES - {}", label(f)));
    let plot = inner(r);
    let top = scene.modes.iter().fold(1.0e-12f32, |m, v| m.max(v.1));
    for &(hz, amp) in &scene.modes {
        if hz <= MODES_HZ.0 || hz >= MODES_HZ.1 || amp <= 0.0 {
            continue;
        }
        let x = hz_to_x(plot, hz);
        let t = ((20.0 * (amp / top).log10() + 60.0) / 60.0).clamp(0.0, 1.0);
        let y = plot.max.y - t * plot.height();
        painter.line_segment([pos2(x, plot.max.y), pos2(x, y)], Stroke::new(3.0, c32(colour(f), 0.18 + 0.25 * t)));
        painter.line_segment([pos2(x, plot.max.y), pos2(x, y)], Stroke::new(1.0, c32(mix3(colour(f), [1.0; 3], 0.3), 0.5 + 0.5 * t)));
    }
    for hz in [100.0f32, 1000.0] {
        let x = hz_to_x(plot, hz);
        painter.text(pos2(x, r.max.y - 3.0), Align2::CENTER_BOTTOM, if hz < 1000.0 { "100 Hz".to_string() } else { "1 kHz".to_string() }, FontId::proportional(8.0), LABEL);
    }
    let glide = scene.pieces[f.index()].glide_cents;
    if !f.is_cymbal() && glide > 1.0 {
        painter.text(pos2(plot.max.x, r.min.y + 5.0), Align2::RIGHT_TOP, format!("glide {glide:+.0} c"), FontId::proportional(8.5), c32(ROSE, 1.0));
    }
    painter.text(pos2(r.min.x + 4.0, plot.center().y), Align2::LEFT_CENTER, "dB", FontId::proportional(8.5), LABEL);
}

fn draw_force(painter: &Painter, r: Rect, scene: &Scene) {
    panel(painter, r, "CONTACT FORCE");
    let plot = inner(r);
    let top = scene.trace.iter().fold(1.0e-3f32, |m, v| m.max(*v));
    let pts: Vec<Pos2> = (0..TRACE_POINTS).map(|i| pos2(plot.min.x + plot.width() * i as f32 / (TRACE_POINTS - 1) as f32, plot.max.y - (scene.trace[i] / top).clamp(0.0, 1.0) * plot.height())).collect();
    polyline(painter, &pts, 3.0, 1.3, AMBER, 0.95);
    let pv = scene.pieces[scene.focus.index()];
    painter.text(pos2(plot.max.x, r.min.y + 5.0), Align2::RIGHT_TOP, format!("{:.0} N peak", pv.peak_force), FontId::proportional(8.5), LABEL);
    painter.text(pos2(plot.center().x, r.max.y - 3.0), Align2::CENTER_BOTTOM, format!("{:.1} ms from the strike", scene.trace_ms), FontId::proportional(8.5), LABEL);
}

fn draw_energy(painter: &Painter, r: Rect, scene: &Scene, st: &ViewState) {
    panel(painter, r, "ENERGY IN EACH PIECE");
    let plot = inner(r);
    let h = plot.height() / PIECES as f32;
    let top = st.energy_top.log10();
    for (i, pv) in scene.pieces.iter().enumerate() {
        let p = Piece::from_index(i);
        let y = plot.min.y + h * i as f32;
        // Seven decades down from the loudest.
        let t = if pv.energy > 0.0 { ((pv.energy.log10() - top + 7.0) / 7.0).clamp(0.0, 1.0) } else { 0.0 };
        let bar = Rect::from_min_max(pos2(plot.min.x + 34.0, y + 2.0), pos2(plot.min.x + 34.0 + t * (plot.width() - 34.0), y + h - 2.0));
        painter.rect_filled(bar, 2u8, c32(colour(p), 0.25 + 0.5 * t));
        painter.text(pos2(r.min.x + 8.0, y + h * 0.5), Align2::LEFT_CENTER, label(p).split(' ').next().unwrap_or(""), FontId::proportional(8.0), if pv.awake { c32(colour(p), 1.0) } else { LABEL });
    }
}

fn draw_chip(painter: &Painter, r: Rect, on: bool) {
    painter.rect_filled(r, 11u8, c32(if on { TEAL } else { [0.08, 0.08, 0.14] }, if on { 0.85 } else { 0.9 }));
    painter.rect_stroke(r, 11u8, Stroke::new(1.0, c32(TEAL, 0.8)), StrokeKind::Middle);
    painter.text(r.center(), Align2::CENTER_CENTER, "PHYSICS", FontId::proportional(10.0), if on { Color32::from_rgb(10, 20, 30) } else { c32(TEAL, 1.0) });
}

fn draw_pads(painter: &Painter, pads: &[(Piece, Rect); PIECES], scene: &Scene) {
    for (p, r) in pads {
        let lit = (scene.pieces[p.index()].level * 6.0).sqrt().clamp(0.0, 1.0);
        painter.rect_filled(*r, 6u8, c32(mix3([0.07, 0.07, 0.13], colour(*p), 0.15 + 0.6 * lit), 0.95));
        painter.rect_stroke(*r, 6u8, Stroke::new(1.0 + 1.5 * lit, c32(colour(*p), 0.5 + 0.5 * lit)), StrokeKind::Middle);
        painter.text(r.center(), Align2::CENTER_CENTER, label(*p), FontId::proportional(10.0), if lit > 0.4 { Color32::from_rgb(12, 14, 26) } else { c32(colour(*p), 1.0) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_face_is_found_where_it_is_drawn() {
        let rect = Rect::from_min_size(pos2(0.0, 0.0), vec2(1000.0, 600.0));
        let opts = MatterViewOptions::default();
        let stage = Rect::from_min_max(rect.min, pos2(rect.max.x, rect.max.y - PAD_H));
        let proj = Projector::new(&Camera::default(), Layout::new(stage, false).scene);
        for piece in Piece::ALL {
            let p = face_screen(rect, &opts, piece, 0.5, 0.3).expect("on screen");
            assert!(stage.contains(p), "{piece:?} at {p:?}");
            let (found, r, _) = face_at(&proj, p).unwrap_or_else(|| panic!("nothing found at {piece:?}'s face"));
            assert_eq!(found, piece);
            assert!((r - 0.5).abs() < 0.2, "{piece:?}: radius {r}");
        }
    }

    #[test]
    fn pads_tile_the_bottom_row() {
        let rect = Rect::from_min_size(pos2(0.0, 0.0), vec2(700.0, 400.0));
        let pads = pad_rects(rect);
        for w in pads.windows(2) {
            assert!(w[0].1.max.x <= w[1].1.min.x);
        }
        assert!(pads.iter().all(|(_, r)| r.min.y >= 400.0 - PAD_H));
    }
}

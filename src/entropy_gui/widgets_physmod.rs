//! `PhysModView`: the bowed-string instrument drawn from the model's own state, in the same neon
//! style as `WavetableView` - glowing lines, an orbiting camera, no attempt at photorealism.
//!
//! What is drawn is what the audio engine publishes in `audio::physmod::PhysModShared`, never an
//! animation painted on top of it:
//!
//! * every string's real displacement, rebuilt from the waveguide's travelling waves (exaggerated
//!   and compressed so a faint sympathetic ring is visible next to a bowed note), stopped by the
//!   finger where the note is fingered;
//! * the bow at its real contact point, coloured by what the friction is doing - clean Helmholtz
//!   motion, airy surface sound (too little force for where it is), or raucous crunch (too much);
//! * the body, glowing with its coupled modes, and any sympathetic strings below the fingerboard.
//!
//! **Physics View** (`PhysModOptions::physics_view`) adds what the eye can't normally see: each
//! string's standing-wave envelope (nodes and antinodes), the Helmholtz corner travelling round the
//! bowed string, energy pulsing from bow to bridge to body, a live Schelleng diagram (where the bow
//! sits in the playable window for its position - drag in it to move the bow), and the body's mode
//! levels.
//!
//! Interaction: dragging near the sounding string moves the bow - along the string sets the bow
//! position, closeness to the string sets the force - as does dragging in the Schelleng diagram.
//! The PHYSICS chip toggles Physics View. The right mouse button, Alt, or a pen's barrel button orbit
//! the camera, the convention `WavetableView` uses.

use crate::audio::physmod::{BowRegime, PhysModShared, StringInfo, MAX_ALL_STRINGS, SCHELLENG_MAX_BETA_EXP, SCHELLENG_MIN_BETA_EXP, SHAPE_POINTS};
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::shape::Shape;
use crate::entropy_gui::ui::Ui;

// ------------------------------------------------------------------------------------------
// Palette
// ------------------------------------------------------------------------------------------

const BG_TOP: [f32; 3] = [0.028, 0.032, 0.070];
const BG_BOTTOM: [f32; 3] = [0.060, 0.050, 0.120];
const AMBER: [f32; 3] = [1.0, 0.78, 0.36];
const TEAL: [f32; 3] = [0.28, 0.90, 0.84];
const VIOLET: [f32; 3] = [0.58, 0.45, 1.0];
const ROSE: [f32; 3] = [1.0, 0.36, 0.42];
const SKY: [f32; 3] = [0.45, 0.62, 1.0];
const DIM: [f32; 3] = [0.34, 0.34, 0.46];
const WOOD: [f32; 3] = [0.85, 0.52, 0.22];
const LABEL: Color32 = Color32::from_rgb(170, 176, 205);

/// Kept for callers that scale their own drawings the way this view does.
pub const DISPLAY_GAIN: f32 = 0.16;
/// Bowed strings drawn (sympathetic strings are drawn separately, below the fingerboard).
pub const MAX_STRINGS: usize = 4;

fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
fn c32(c: [f32; 3], a: f32) -> Color32 {
    Color32::from_rgba_f32([c[0], c[1], c[2], a.clamp(0.0, 1.0)])
}
fn bg_at(y_frac: f32) -> [f32; 3] {
    mix3(BG_TOP, BG_BOTTOM, y_frac)
}
fn regime_colour(r: BowRegime) -> [f32; 3] {
    match r {
        BowRegime::Helmholtz => TEAL,
        BowRegime::SurfaceSound => SKY,
        BowRegime::Raucous => ROSE,
        BowRegime::Free => VIOLET,
    }
}
pub fn regime_label(r: BowRegime) -> &'static str {
    match r {
        BowRegime::Helmholtz => "Helmholtz motion",
        BowRegime::SurfaceSound => "surface sound - more force, or move away from the bridge",
        BowRegime::Raucous => "raucous - less force, a faster bow, or further from the bridge",
        BowRegime::Free => "bow lifted",
    }
}

fn note_name(freq: f32) -> String {
    if freq <= 0.0 {
        return String::new();
    }
    const NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    let midi = (69.0 + 12.0 * (freq / 440.0).log2()).round() as i32;
    format!("{}{}", NAMES[midi.rem_euclid(12) as usize], midi.div_euclid(12) - 1)
}

// ------------------------------------------------------------------------------------------
// A small fixed-target 3D camera
// ------------------------------------------------------------------------------------------

type V3 = [f32; 3];
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

// World layout: x runs along the strings from the nut (-1) to the bridge (+1); the body extends past
// the bridge, like a real violin's (the bridge stands at the middle of its lower half). y is up.
// The strings fan out from STRING_SPREAD_NUT at the nut to STRING_SPREAD_BRIDGE at the bridge.
const STRING_SPREAD_NUT: f32 = 0.26;
const STRING_SPREAD_BRIDGE: f32 = 0.52;
const BODY_TOP_X: f32 = -0.2;
const BODY_LEN: f32 = 2.15;
const PLATE_Y: f32 = -0.20;
const HEIGHT_SCALE: f32 = 0.34;
/// For compatibility with callers that sized things off the old flat layout.
pub const STRING_DEPTH: f32 = STRING_SPREAD_BRIDGE;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub yaw: f32,
    pub pitch: f32,
    pub dist: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self { yaw: 0.42, pitch: 0.62, dist: 5.4 }
    }
}

impl Camera {
    pub const PITCH_MIN: f32 = 0.10;
    pub const PITCH_MAX: f32 = 1.50;

    pub fn orbit(&mut self, dx: f32, dy: f32) {
        self.yaw += dx * 0.008;
        self.pitch = (self.pitch + dy * 0.008).clamp(Self::PITCH_MIN, Self::PITCH_MAX);
    }
}

#[derive(Clone, Copy, Debug)]
struct Projector {
    eye: V3,
    right: V3,
    up: V3,
    fwd: V3,
    focal: f32,
    shift: Pos2,
}

/// The centre the camera orbits.
const TARGET: V3 = [0.45, -0.05, 0.0];

impl Projector {
    fn new(cam: &Camera, rect: Rect) -> Self {
        let (sy, cy) = cam.yaw.sin_cos();
        let (sp, cp) = cam.pitch.sin_cos();
        let eye = [TARGET[0] + cam.dist * cp * sy, TARGET[1] + cam.dist * sp, TARGET[2] + cam.dist * cp * cy];
        let fwd = norm(sub(TARGET, eye));
        let right = norm(cross(fwd, [0.0, 1.0, 0.0]));
        let up = cross(right, fwd);
        let mut p = Projector { eye, right, up, fwd, focal: 1.0, shift: pos2(0.0, 0.0) };
        let bounds = |p: &Projector| {
            let mut lo = pos2(f32::MAX, f32::MAX);
            let mut hi = pos2(f32::MIN, f32::MIN);
            for &x in &[-1.05f32, BODY_TOP_X + BODY_LEN] {
                for &y in &[PLATE_Y, HEIGHT_SCALE * 0.6] {
                    for &z in &[-0.62f32, 0.62] {
                        if let Some((q, _)) = p.project_raw([x, y, z]) {
                            lo = pos2(lo.x.min(q.x), lo.y.min(q.y));
                            hi = pos2(hi.x.max(q.x), hi.y.max(q.y));
                        }
                    }
                }
            }
            (lo, hi)
        };
        let avail = Rect::from_min_max(pos2(rect.min.x + 18.0, rect.min.y + 14.0), pos2(rect.max.x - 18.0, rect.max.y - 14.0));
        let (lo, hi) = bounds(&p);
        let (bw, bh) = ((hi.x - lo.x).max(1.0e-3), (hi.y - lo.y).max(1.0e-3));
        p.focal = (avail.width() / bw).min(avail.height() / bh) * 0.96;
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
}

/// World z of string `i` of `n` at world x (0 = lowest string, nearest the camera).
fn string_z_at(i: usize, n: usize, x: f32) -> f32 {
    if n <= 1 {
        return 0.0;
    }
    let t = ((x + 1.0) / 2.0).clamp(0.0, 1.2);
    let spread = STRING_SPREAD_NUT + (STRING_SPREAD_BRIDGE - STRING_SPREAD_NUT) * t;
    (0.5 - i as f32 / (n - 1) as f32) * spread
}

/// World z of string `i` of `n` at the bridge (kept for tests and callers of the old layout).
pub fn string_z(i: usize, n: usize) -> f32 {
    string_z_at(i, n, 1.0)
}

/// World x of the finger for a string (0 = open: at the nut).
fn finger_x(finger: f32) -> f32 {
    -1.0 + 2.0 * finger.clamp(0.0, 0.95)
}

/// World x of the bow for a bow position (fraction of the *vibrating* length from the bridge).
pub fn bow_x(bow_position: f32, finger: f32) -> f32 {
    1.0 - bow_position.clamp(0.02, 0.5) * (1.0 - finger_x(finger))
}

/// The inverse of `bow_x`.
pub fn bow_position_from_x(x: f32, finger: f32) -> f32 {
    ((1.0 - x) / (1.0 - finger_x(finger)).max(1.0e-3)).clamp(0.02, 0.5)
}

/// Open-string forms of the above (finger at the nut), for callers of the old layout.
pub fn bow_position_to_x(bow_position: f32) -> f32 {
    bow_x(bow_position, 0.0)
}
pub fn x_to_bow_position(x: f32) -> f32 {
    bow_position_from_x(x, 0.0)
}

/// Half-width of the body outline at `u` (0 = top of the body near the neck, 1 = the end pin), in
/// violin proportions (upper bout, C-bout waist, lower bout), world units at size 1.
fn body_half_width(u: f32) -> f32 {
    const PTS: [(f32, f32); 13] = [
        (0.0, 0.0),
        (0.03, 0.26),
        (0.1, 0.44),
        (0.2, 0.51),
        (0.3, 0.47),
        (0.4, 0.35),
        (0.5, 0.33),
        (0.6, 0.40),
        (0.7, 0.58),
        (0.8, 0.635),
        (0.9, 0.56),
        (0.97, 0.33),
        (1.0, 0.0),
    ];
    let u = u.clamp(0.0, 1.0);
    let i = PTS.iter().position(|p| p.0 >= u).unwrap_or(PTS.len() - 1).max(1);
    let (a, b) = (PTS[i - 1], PTS[i]);
    let t = ((u - a.0) / (b.0 - a.0).max(1.0e-6)).clamp(0.0, 1.0);
    let t = t * t * (3.0 - 2.0 * t);
    a.1 + (b.1 - a.1) * t
}

// ------------------------------------------------------------------------------------------
// Public options / events / response
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct PhysModOptions {
    pub height: f32,
    pub width: Option<f32>,
    /// Bowed strings to draw when nothing has been published yet.
    pub strings: usize,
    /// The string to put the bow on when nothing is sounding (the engine's own choice wins once a
    /// note has played).
    pub active_string: Option<usize>,
    pub bow_position: f32,
    pub bow_force: f32,
    pub body_size: f32,
    pub keyboard: bool,
    pub first_key: u8,
    pub key_octaves: u8,
    pub held: Vec<u8>,
    /// Show the Physics View overlays.
    pub physics_view: bool,
    /// Extra visual exaggeration of string motion (1 = default).
    pub exaggeration: f32,
}

impl Default for PhysModOptions {
    fn default() -> Self {
        Self {
            height: 360.0,
            width: None,
            strings: MAX_STRINGS,
            active_string: None,
            bow_position: 0.12,
            bow_force: 0.5,
            body_size: 0.0,
            keyboard: true,
            first_key: 48,
            key_octaves: 2,
            held: Vec::new(),
            physics_view: false,
            exaggeration: 1.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PhysModEvent {
    /// A drag on the bow (in 3D or in the Schelleng diagram): the new bow position (0.02..0.5, as
    /// `PhysModParams::bow_position`) and force (0..1, as `PhysModParams::bow_force`).
    BowDrag { position: f32, force: f32 },
    KeyDown { midi: u8, velocity: f32 },
    KeyUp { midi: u8 },
    /// The PHYSICS chip was clicked: the view the user asked for.
    PhysicsView(bool),
}

pub struct PhysModResponse {
    pub events: Vec<PhysModEvent>,
}

#[derive(Clone, Copy)]
enum Drag {
    Orbit,
    Bow,
    Diagram,
    Key { midi: u8 },
}

struct ViewState {
    camera: Camera,
    drag: Option<Drag>,
    last_pointer: Option<Pos2>,
    /// Slowly decaying reference for the display scale (see `display_y`): the loudest string's
    /// peak displacement, and each string's own.
    scale_ref: f32,
    string_ref: [f32; MAX_ALL_STRINGS],
    /// Per string, the recent peak displacement at each point (the standing-wave envelope).
    envelope: [[f32; SHAPE_POINTS]; MAX_ALL_STRINGS],
    /// Where along the hair the bow is (for drawing it travel), -1..1.
    bow_travel: f32,
    last_time: f32,
}

impl Default for ViewState {
    fn default() -> Self {
        Self { camera: Camera::default(), drag: None, last_pointer: None, scale_ref: 1.0e-6, string_ref: [1.0e-7; MAX_ALL_STRINGS], envelope: [[0.0; SHAPE_POINTS]; MAX_ALL_STRINGS], bow_travel: 0.0, last_time: 0.0 }
    }
}

fn key_layout(first: u8, octaves: u8, rect: Rect) -> Vec<(u8, Rect, bool)> {
    crate::entropy_gui::widgets_wavetable::key_layout(first, octaves, rect)
}

fn key_at(keys: &[(u8, Rect, bool)], p: Pos2) -> Option<(u8, Rect)> {
    // Black keys sit on top of white ones: test them first.
    keys.iter().filter(|k| k.2).chain(keys.iter().filter(|k| !k.2)).find(|(_, r, _)| r.contains(p)).map(|(m, r, _)| (*m, *r))
}

/// Everything the view draws about the instrument this frame, read once from the shared state.
struct Scene {
    n_bowed: usize,
    n_symp: usize,
    strings: [StringInfo; MAX_ALL_STRINGS],
    shapes: [[f32; SHAPE_POINTS]; MAX_ALL_STRINGS],
    active: Option<usize>,
    sounding: bool,
    energy: f32,
    modes: Vec<(f32, f32)>,
    bridge_force: f32,
}

impl Scene {
    fn read(shared: &PhysModShared, opts: &PhysModOptions) -> Self {
        let count = shared.string_count();
        let mut strings = [StringInfo::default(); MAX_ALL_STRINGS];
        let mut shapes = [[0.0; SHAPE_POINTS]; MAX_ALL_STRINGS];
        let (mut n_bowed, mut n_symp) = (0, 0);
        for i in 0..count {
            strings[i] = shared.string_info(i);
            if strings[i].sympathetic {
                n_symp += 1;
            } else {
                n_bowed += 1;
            }
            for (k, v) in shapes[i].iter_mut().enumerate() {
                *v = shared.string_shape_at(i, k);
            }
        }
        if count == 0 {
            // Nothing published yet: draw the strings at rest, open, with the bow where the knobs
            // say it is.
            n_bowed = opts.strings.clamp(1, MAX_STRINGS);
            for s in strings.iter_mut().take(n_bowed) {
                *s = StringInfo { bowed: true, beta: opts.bow_position, ..Default::default() };
            }
        }
        let activity = shared.activity();
        let active = shared.active_string().filter(|&i| i < n_bowed).or(opts.active_string.filter(|&i| i < n_bowed));
        let modes = (0..shared.body_mode_count()).map(|i| shared.body_mode(i)).collect();
        Self { n_bowed, n_symp, strings, shapes, active, sounding: activity.is_some(), energy: activity.map(|a| a.3).unwrap_or(0.0), modes, bridge_force: shared.bridge_force() }
    }
}

pub struct PhysModView {
    id: Id,
}

impl PhysModView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new(id_salt) }
    }

    pub fn show(self, ui: &mut Ui, opts: &PhysModOptions, shared: &PhysModShared) -> PhysModResponse {
        let ctx = ui.ctx().clone();
        let width = opts.width.unwrap_or_else(|| ui.available_width().max(360.0));
        let (resp, painter) = ui.allocate_painter(vec2(width, opts.height.max(220.0)), Sense::click_and_drag());
        let rect = resp.rect;
        let scene = Scene::read(shared, opts);

        let (pointer, mods) = ctx.input(|i| (i.pointer, i.modifiers));
        let mut st: ViewState = ctx.memory_mut(|m| m.take_view_state(self.id));
        let now = ctx.time();
        let dt = (now - st.last_time).clamp(0.0, 0.1);
        st.last_time = now;
        let mut events: Vec<PhysModEvent> = Vec::new();
        let pos = pointer.pos;

        let key_h = if opts.keyboard { 64.0 } else { 0.0 };
        let stage = Rect::from_min_max(rect.min, pos2(rect.max.x, rect.max.y - key_h));
        let key_rect = Rect::from_min_max(pos2(rect.min.x, rect.max.y - key_h), rect.max);
        let key_rects = if opts.keyboard { key_layout(opts.first_key, opts.key_octaves, key_rect) } else { Vec::new() };
        let lay = Layout::new(stage, opts.physics_view);

        // ---------------------------------------------------------------- input
        let started_primary = pointer.primary_pressed;
        let started_secondary = pointer.secondary_pressed;
        let pen = pointer.pen;
        if st.drag.is_none() && (started_primary || started_secondary) {
            if let Some(p) = pos {
                let orbit = started_secondary || mods.alt || pen.is_some_and(|pn| pn.barrel);
                if started_primary && lay.chip.contains(p) {
                    events.push(PhysModEvent::PhysicsView(!opts.physics_view));
                } else if started_primary && lay.diagram.is_some_and(|d| d.contains(p)) {
                    st.drag = Some(Drag::Diagram);
                    if let Some((position, force)) = diagram_value(lay.diagram.unwrap(), p) {
                        events.push(PhysModEvent::BowDrag { position, force });
                    }
                } else if orbit && stage.contains(p) {
                    st.drag = Some(Drag::Orbit);
                } else if started_primary && bowing_zone(&st.camera, stage, &scene, opts).is_some_and(|z| z.contains(p)) {
                    st.drag = Some(Drag::Bow);
                    if let Some((position, force)) = bow_drag_value(&st.camera, stage, &scene, opts, p) {
                        events.push(PhysModEvent::BowDrag { position, force });
                    }
                } else if started_primary && opts.keyboard && key_rect.contains(p) {
                    if let Some((midi, kr)) = key_at(&key_rects, p) {
                        let velocity = pen.map(|pn| pn.pressure.max(0.2)).unwrap_or(0.35 + 0.65 * ((p.y - kr.min.y) / kr.height()).clamp(0.0, 1.0));
                        events.push(PhysModEvent::KeyDown { midi, velocity });
                        st.drag = Some(Drag::Key { midi });
                    }
                }
            }
        }

        let still_down = pointer.primary_down || pointer.secondary_down;
        if let Some(drag) = st.drag {
            match drag {
                Drag::Orbit => {
                    if let (Some(p), Some(last)) = (pos, st.last_pointer) {
                        st.camera.orbit(p.x - last.x, p.y - last.y);
                    }
                }
                Drag::Bow => {
                    if let (Some(p), true) = (pos, still_down) {
                        if let Some((position, force)) = bow_drag_value(&st.camera, stage, &scene, opts, p) {
                            events.push(PhysModEvent::BowDrag { position, force });
                        }
                    }
                }
                Drag::Diagram => {
                    if let (Some(p), true, Some(d)) = (pos, still_down, lay.diagram) {
                        if let Some((position, force)) = diagram_value(d, p) {
                            events.push(PhysModEvent::BowDrag { position, force });
                        }
                    }
                }
                Drag::Key { midi } => {
                    if let (Some(p), true) = (pos, still_down) {
                        if let Some((m2, kr)) = key_at(&key_rects, p) {
                            if m2 != midi {
                                events.push(PhysModEvent::KeyUp { midi });
                                let velocity = pen.map(|pn| pn.pressure.max(0.2)).unwrap_or(0.35 + 0.65 * ((p.y - kr.min.y) / kr.height()).clamp(0.0, 1.0));
                                events.push(PhysModEvent::KeyDown { midi: m2, velocity });
                                st.drag = Some(Drag::Key { midi: m2 });
                            }
                        }
                    }
                }
            }
            if !still_down {
                if let Drag::Key { midi } = drag {
                    events.push(PhysModEvent::KeyUp { midi });
                }
                st.drag = None;
            }
        }
        st.last_pointer = pos;

        // ---------------------------------------------------------------- state updates
        // Display scale: follow each string's peak quickly up and slowly down, so a note's motion
        // fills the view and a fading note visibly shrinks rather than being re-normalised.
        let follow = |r: f32, peak: f32| if peak > r { peak } else { (r * (-dt / 2.5).exp()).max(peak).max(1.0e-9) };
        let mut loudest = 0.0f32;
        for i in 0..MAX_ALL_STRINGS {
            let peak = scene.shapes[i].iter().fold(0.0f32, |m, v| m.max(v.abs()));
            st.string_ref[i] = follow(st.string_ref[i], peak);
            loudest = loudest.max(peak);
        }
        st.scale_ref = follow(st.scale_ref, loudest).max(1.0e-7);
        let decay = (-dt / 0.6).exp();
        for i in 0..MAX_ALL_STRINGS {
            let r = string_scale(&st, i);
            for k in 0..SHAPE_POINTS {
                let y = display_y(scene.shapes[i][k], r, opts.exaggeration);
                st.envelope[i][k] = (st.envelope[i][k] * decay).max(y.abs());
            }
        }
        if let Some(a) = scene.active {
            let v = scene.strings[a].bow_velocity;
            st.bow_travel += v * dt * 2.2;
            if st.bow_travel.abs() > 1.0 {
                st.bow_travel = st.bow_travel.clamp(-1.0, 1.0);
            }
        }

        // ---------------------------------------------------------------- drawing
        for y in 0..24 {
            let t0 = y as f32 / 24.0;
            let t1 = (y + 1) as f32 / 24.0;
            let band = Rect::from_min_max(pos2(rect.min.x, rect.min.y + t0 * rect.height()), pos2(rect.max.x, rect.min.y + t1 * rect.height()));
            painter.rect_filled(band, 0u8, c32(bg_at((t0 + t1) * 0.5), 1.0));
        }

        let clip = painter.with_clip_rect(stage);
        let proj = Projector::new(&st.camera, stage);
        let body_energy: f32 = scene.modes.iter().map(|m| m.1).sum::<f32>();
        draw_body(&clip, &proj, opts.body_size, body_energy, scene.sounding);
        draw_fingerboard(&clip, &proj, scene.n_bowed);
        draw_sympathetic(&clip, &proj, &scene, &st, opts);
        draw_bridge(&clip, &proj, scene.n_bowed, scene.bridge_force, opts.physics_view);
        for i in 0..scene.n_bowed {
            let is_active = scene.active == Some(i);
            if opts.physics_view {
                draw_envelope(&clip, &proj, i, &scene, &st);
            }
            draw_string(&clip, &proj, i, &scene, &st, opts, is_active, now);
        }
        if let Some(a) = scene.active.or(opts.active_string) {
            draw_bow(&clip, &proj, a, &scene, &st, opts);
            if opts.physics_view && scene.strings[a].playing {
                draw_corner(&clip, &proj, a, &scene, &st, opts, now);
            }
        }
        draw_readout(&clip, &lay, &scene, opts);
        if let Some(d) = lay.diagram {
            draw_schelleng(&clip, d, &scene, opts);
        }
        if let Some(m) = lay.modes {
            draw_modes(&clip, m, &scene);
        }
        draw_chip(&clip, lay.chip, opts.physics_view);
        if opts.keyboard {
            draw_keys(&painter, &key_rects, opts.held.as_slice());
        }

        ctx.memory_mut(|m| m.put_view_state(self.id, st));
        PhysModResponse { events }
    }
}

/// Screen-space panels.
struct Layout {
    chip: Rect,
    diagram: Option<Rect>,
    modes: Option<Rect>,
    readout: Pos2,
}

impl Layout {
    fn new(stage: Rect, physics: bool) -> Self {
        let chip = Rect::from_min_size(pos2(stage.max.x - 92.0, stage.min.y + 10.0), vec2(80.0, 22.0));
        let (w, h) = ((stage.width() * 0.3).clamp(170.0, 260.0), (stage.height() * 0.34).clamp(110.0, 180.0));
        let diagram = physics.then(|| Rect::from_min_size(pos2(stage.max.x - w - 12.0, chip.max.y + 10.0), vec2(w, h)));
        let modes = physics.then(|| Rect::from_min_size(pos2(stage.max.x - w - 12.0, stage.max.y - 96.0), vec2(w, 84.0)));
        Self { chip, diagram, modes, readout: pos2(stage.min.x + 14.0, stage.min.y + 12.0) }
    }
}

/// Maps a string displacement to world height, linearly (so the Helmholtz corner's two straight
/// lines stay straight) against `reference` - see `string_scale`.
fn display_y(v: f32, reference: f32, exaggeration: f32) -> f32 {
    (v / reference.max(1.0e-9)).clamp(-1.5, 1.5) * DISPLAY_GAIN * exaggeration.clamp(0.1, 4.0)
}

/// The reference string `i` is scaled against: its own recent peak, but never less than a quarter
/// of the loudest string's, so a faint sympathetic ring is enlarged up to 4x - visible next to a
/// bowed note, still visibly the quieter of the two.
fn string_scale(st: &ViewState, i: usize) -> f32 {
    st.string_ref[i].max(st.scale_ref * 0.25)
}

/// The world point of string `i` at fraction `t` along its vibrating part (0 = finger, 1 = bridge).
fn string_point(i: usize, scene: &Scene, t: f32, y: f32) -> V3 {
    let xf = finger_x(scene.strings[i].finger);
    let x = xf + (1.0 - xf) * t;
    [x, y, string_z_at(i, scene.n_bowed, x)]
}

fn shape_at(shape: &[f32; SHAPE_POINTS], t: f32) -> f32 {
    let f = t.clamp(0.0, 1.0) * (SHAPE_POINTS - 1) as f32;
    let i0 = f.floor() as usize;
    let i1 = (i0 + 1).min(SHAPE_POINTS - 1);
    let fr = f - i0 as f32;
    shape[i0] * (1.0 - fr) + shape[i1] * fr
}

// ------------------------------------------------------------------------------------------
// Interaction geometry
// ------------------------------------------------------------------------------------------

/// The screen-space box around the vibrating part of the bowed string (where a drag moves the bow).
fn bowing_zone(cam: &Camera, rect: Rect, scene: &Scene, opts: &PhysModOptions) -> Option<Rect> {
    let i = scene.active.or(opts.active_string)?;
    let proj = Projector::new(cam, rect);
    let a = proj.project(string_point(i, scene, 0.5, 0.0))?;
    let b = proj.project(string_point(i, scene, 1.0, 0.0))?;
    let pad = 26.0;
    Some(Rect::from_min_max(pos2(a.x.min(b.x) - pad, a.y.min(b.y) - pad), pos2(a.x.max(b.x) + pad, a.y.max(b.y) + pad)))
}

/// A drag point projected onto the bridge half of the vibrating string: bow position from where
/// along it the drag lands, force from how close to the string (closer = harder).
fn bow_drag_value(cam: &Camera, rect: Rect, scene: &Scene, opts: &PhysModOptions, p: Pos2) -> Option<(f32, f32)> {
    let zone = bowing_zone(cam, rect, scene, opts)?;
    if !zone.contains(p) {
        return None;
    }
    let i = scene.active.or(opts.active_string)?;
    let proj = Projector::new(cam, rect);
    let a = proj.project(string_point(i, scene, 0.5, 0.0))?;
    let b = proj.project(string_point(i, scene, 1.0, 0.0))?;
    let ab = vec2(b.x - a.x, b.y - a.y);
    let len2 = (ab.x * ab.x + ab.y * ab.y).max(1.0);
    let t = (((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2).clamp(0.0, 1.0);
    let along = pos2(a.x + ab.x * t, a.y + ab.y * t);
    let dist = ((p.x - along.x).powi(2) + (p.y - along.y).powi(2)).sqrt();
    let force = (1.0 - dist / 40.0).clamp(0.0, 1.0);
    // t = 0 is mid-string (bow position 0.5), t = 1 the bridge.
    let position = (0.5 * (1.0 - t)).clamp(0.02, 0.5);
    Some((position, force))
}

// Schelleng diagram axes: bow position on a log axis, bridge on the left as in Schelleng's paper;
// force in the 0..1 knob units (itself logarithmic in newtons) upward.
const DIAGRAM_BETA: (f32, f32) = (0.02, 0.5);

fn diagram_plot(d: Rect) -> Rect {
    Rect::from_min_max(pos2(d.min.x + 30.0, d.min.y + 22.0), pos2(d.max.x - 8.0, d.max.y - 20.0))
}
fn beta_to_x(plot: Rect, beta: f32) -> f32 {
    let (lo, hi) = DIAGRAM_BETA;
    let t = (beta.clamp(lo, hi).ln() - lo.ln()) / (hi.ln() - lo.ln());
    plot.min.x + t * plot.width()
}
fn x_to_beta(plot: Rect, x: f32) -> f32 {
    let (lo, hi) = DIAGRAM_BETA;
    let t = ((x - plot.min.x) / plot.width()).clamp(0.0, 1.0);
    (lo.ln() + t * (hi.ln() - lo.ln())).exp()
}
fn knob_to_y(plot: Rect, k: f32) -> f32 {
    plot.max.y - k.clamp(0.0, 1.0) * plot.height()
}

/// A point in the Schelleng diagram as (bow position, force knob).
pub fn diagram_value(d: Rect, p: Pos2) -> Option<(f32, f32)> {
    let plot = diagram_plot(d);
    if !d.contains(p) {
        return None;
    }
    let beta = x_to_beta(plot, p.x);
    let k = ((plot.max.y - p.y) / plot.height()).clamp(0.0, 1.0);
    Some((beta.clamp(0.02, 0.5), k))
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

fn draw_body(painter: &Painter, proj: &Projector, body_size: f32, energy: f32, sounding: bool) {
    let s = 1.0 + 0.22 * body_size.clamp(-1.0, 2.5);
    let len = BODY_LEN * s;
    let top = 1.0 - (1.0 - BODY_TOP_X) * s;
    let n = 48;
    let mut outline = Vec::with_capacity(2 * n + 2);
    for k in 0..=n {
        let u = k as f32 / n as f32;
        outline.push([top + u * len, PLATE_Y, body_half_width(u) * s]);
    }
    for k in (0..=n).rev() {
        let u = k as f32 / n as f32;
        outline.push([top + u * len, PLATE_Y, -body_half_width(u) * s]);
    }
    let pts: Vec<Pos2> = outline.iter().filter_map(|w| proj.project(*w)).collect();
    if pts.len() < 3 {
        return;
    }
    // Resonance glow: how hard the body's coupled modes are ringing (bridge velocity, m/s - a few
    // mm/s is a loud note).
    let e = (energy * 60.0).clamp(0.0, 1.0);
    let colour = mix3(WOOD, AMBER, e);
    painter.add(Shape::convex_polygon(pts.clone(), c32(mix3(BG_BOTTOM, WOOD, 0.10 + 0.25 * e), 0.85), Stroke::new(0.0, Color32::TRANSPARENT)));
    let mut closed = pts.clone();
    closed.push(pts[0]);
    polyline(painter, &closed, 7.0 + 6.0 * e, 1.6, colour, if sounding { 0.55 + 0.45 * e } else { 0.45 });
    // f-holes: two S-curves either side of the bridge.
    for side in [-1.0f32, 1.0] {
        let f: Vec<Pos2> = (0..=12)
            .filter_map(|k| {
                let t = k as f32 / 12.0;
                let x = 1.0 + (t - 0.5) * 0.52 * s;
                let z = side * (0.29 + 0.05 * (std::f32::consts::PI * (t * 2.0 - 1.0)).sin()) * s;
                proj.project([x, PLATE_Y, z])
            })
            .collect();
        polyline(painter, &f, 3.0, 1.2, colour, 0.5 + 0.4 * e);
    }
}

fn draw_fingerboard(painter: &Painter, proj: &Projector, n: usize) {
    let (x0, x1) = (-1.02f32, 0.35f32);
    let half = |x: f32| string_z_at(0, n.max(2), x).abs() + 0.06;
    let quad = [[x0, -0.05, half(x0)], [x1, -0.05, half(x1)], [x1, -0.05, -half(x1)], [x0, -0.05, -half(x0)]];
    let pts: Vec<Pos2> = quad.iter().filter_map(|w| proj.project(*w)).collect();
    if pts.len() == 4 {
        painter.add(Shape::convex_polygon(pts.clone(), c32([0.04, 0.04, 0.08], 0.9), Stroke::new(1.0, c32(DIM, 0.5))));
    }
    // The nut.
    if let (Some(a), Some(b)) = (proj.project([-1.0, 0.0, half(-1.0)]), proj.project([-1.0, 0.0, -half(-1.0)])) {
        painter.line_segment([a, b], Stroke::new(3.0, c32(mix3(DIM, [1.0, 1.0, 1.0], 0.3), 0.8)));
    }
}

fn draw_bridge(painter: &Painter, proj: &Projector, n: usize, force: f32, physics: bool) {
    let half = STRING_SPREAD_BRIDGE * 0.5 + 0.08;
    let pts: Vec<Pos2> = (0..=16)
        .filter_map(|k| {
            let t = k as f32 / 16.0;
            let z = -half + 2.0 * half * t;
            let arch = 0.035 * (1.0 - (2.0 * t - 1.0).powi(2));
            proj.project([1.0, -0.005 + arch - 0.035, z])
        })
        .collect();
    let pulse = (force * 6.0).clamp(0.0, 1.0);
    polyline(painter, &pts, 6.0 + if physics { 10.0 * pulse } else { 0.0 }, 2.2, mix3(AMBER, [1.0, 1.0, 1.0], 0.3 * pulse), 0.85);
    for side in [-1.0f32, 1.0] {
        if let (Some(a), Some(b)) = (proj.project([1.0, -0.04, side * half * 0.7]), proj.project([1.0, PLATE_Y, side * half * 0.7])) {
            painter.line_segment([a, b], Stroke::new(2.0, c32(AMBER, 0.6)));
        }
    }
    let _ = n;
}

fn draw_string(painter: &Painter, proj: &Projector, i: usize, scene: &Scene, st: &ViewState, opts: &PhysModOptions, active: bool, time: f32) {
    let info = &scene.strings[i];
    let n = scene.n_bowed;
    // Nut to finger: at rest (a stopped string does not vibrate behind the finger).
    let xf = finger_x(info.finger);
    if info.finger > 0.0 {
        let back: Vec<Pos2> = (0..=6).filter_map(|k| { let x = -1.0 + (xf + 1.0) * k as f32 / 6.0; proj.project([x, 0.0, string_z_at(i, n, x)]) }).collect();
        polyline(painter, &back, 0.0, 1.0, DIM, 0.45);
        // The fingertip.
        if let Some(p) = proj.project([xf, 0.01, string_z_at(i, n, xf)]) {
            painter.circle_filled(p, 5.0, c32(AMBER, 0.35));
            painter.circle_filled(p, 2.5, c32(mix3(AMBER, [1.0, 1.0, 1.0], 0.5), 0.95));
        }
    }
    let points = 72;
    let pts: Vec<Pos2> = (0..=points)
        .filter_map(|k| {
            let t = k as f32 / points as f32;
            let y = display_y(shape_at(&scene.shapes[i], t), string_scale(st, i), opts.exaggeration);
            proj.project(string_point(i, scene, t, y))
        })
        .collect();
    let lvl = (info.level * 3.0).clamp(0.0, 1.0);
    let (colour, glow, core, alpha) = if active && info.playing {
        (mix3(TEAL, AMBER, 0.5 + 0.5 * (time * 0.6).sin()), 10.0, 2.6, 0.95)
    } else if lvl > 0.02 {
        // Ringing without the bow: an open string in sympathy, or a note's tail.
        (mix3(DIM, VIOLET, lvl), 3.0 + 6.0 * lvl, 1.4, 0.45 + 0.5 * lvl)
    } else {
        (DIM, 3.0, 1.0, 0.45)
    };
    polyline(painter, &pts, glow, core, colour, alpha);
    // Open-string name at the nut end.
    if let Some(p) = proj.project([-1.12, 0.0, string_z_at(i, n, -1.0)]) {
        painter.text(p, Align2::RIGHT_CENTER, note_name(info.open_freq), FontId::proportional(10.0), c32(if active { AMBER } else { DIM }, 0.9));
    }
}

fn draw_envelope(painter: &Painter, proj: &Projector, i: usize, scene: &Scene, st: &ViewState) {
    let env = &st.envelope[i];
    if env.iter().fold(0.0f32, |m, v| m.max(*v)) < 1.0e-3 {
        return;
    }
    let mut verts_top = Vec::with_capacity(SHAPE_POINTS);
    let mut verts_bot = Vec::with_capacity(SHAPE_POINTS);
    for k in 0..SHAPE_POINTS {
        let t = k as f32 / (SHAPE_POINTS - 1) as f32;
        if let (Some(a), Some(b)) = (proj.project(string_point(i, scene, t, env[k])), proj.project(string_point(i, scene, t, -env[k]))) {
            verts_top.push(a);
            verts_bot.push(b);
        }
    }
    let col = c32(VIOLET, 0.16);
    for k in 1..verts_top.len() {
        let quad = vec![verts_top[k - 1], verts_top[k], verts_bot[k], verts_bot[k - 1]];
        painter.add(Shape::convex_polygon(quad, col, Stroke::new(0.0, Color32::TRANSPARENT)));
    }
    polyline(painter, &verts_top, 0.0, 1.0, VIOLET, 0.45);
    polyline(painter, &verts_bot, 0.0, 1.0, VIOLET, 0.45);
    // Nodes: where the envelope pinches in (local minima well below its peak), away from the ends.
    let peak = env.iter().fold(0.0f32, |m, v| m.max(*v));
    for k in 2..SHAPE_POINTS - 2 {
        if env[k] < env[k - 1] && env[k] <= env[k + 1] && env[k] < 0.35 * peak {
            let t = k as f32 / (SHAPE_POINTS - 1) as f32;
            if let Some(p) = proj.project(string_point(i, scene, t, 0.0)) {
                painter.circle_stroke(p, 3.5, Stroke::new(1.2, c32(SKY, 0.85)));
            }
        }
    }
}

/// The Helmholtz corner: the kink in a bowed string's shape (for two straight lines pinned at the
/// ends, the point furthest from rest), marked as it travels round.
fn draw_corner(painter: &Painter, proj: &Projector, i: usize, scene: &Scene, st: &ViewState, opts: &PhysModOptions, time: f32) {
    let shape = &scene.shapes[i];
    let (k, _) = shape.iter().enumerate().fold((0, 0.0f32), |b, (k, v)| if v.abs() > b.1 { (k, v.abs()) } else { b });
    if k == 0 || k == SHAPE_POINTS - 1 {
        return;
    }
    let t = k as f32 / (SHAPE_POINTS - 1) as f32;
    let y = display_y(shape[k], string_scale(st, i), opts.exaggeration);
    if let Some(p) = proj.project(string_point(i, scene, t, y)) {
        let pulse = 0.6 + 0.4 * (time * 9.0).sin();
        painter.circle_filled(p, 9.0, c32(AMBER, 0.18 * pulse));
        painter.circle_filled(p, 4.0, c32([1.0, 0.95, 0.8], 0.95));
        painter.text(pos2(p.x + 8.0, p.y - 10.0), Align2::LEFT_BOTTOM, "corner", FontId::proportional(9.5), c32(AMBER, 0.85));
    }
}

fn draw_sympathetic(painter: &Painter, proj: &Projector, scene: &Scene, st: &ViewState, opts: &PhysModOptions) {
    let ns = scene.n_symp;
    for j in 0..ns {
        let i = scene.n_bowed + j;
        let info = &scene.strings[i];
        let z = if ns <= 1 { 0.0 } else { (0.5 - j as f32 / (ns - 1) as f32) * 0.26 };
        let pts: Vec<Pos2> = (0..=40)
            .filter_map(|k| {
                let t = k as f32 / 40.0;
                let y = -0.11 + 0.5 * display_y(shape_at(&scene.shapes[i], t), string_scale(st, i), opts.exaggeration);
                proj.project([-1.0 + 2.25 * t, y, z])
            })
            .collect();
        let lvl = (info.level * 3.0).clamp(0.0, 1.0);
        polyline(painter, &pts, 2.0 + 6.0 * lvl, 1.0, VIOLET, 0.35 + 0.6 * lvl);
    }
}

fn draw_bow(painter: &Painter, proj: &Projector, i: usize, scene: &Scene, st: &ViewState, opts: &PhysModOptions) {
    let info = &scene.strings[i];
    let n = scene.n_bowed;
    let beta = if info.beta > 0.0 { info.beta } else { opts.bow_position };
    let x = bow_x(beta, info.finger);
    let z = string_z_at(i, n, x);
    let regime = if info.playing || info.bow_force > 0.0 { info.regime() } else { BowRegime::Free };
    let colour = regime_colour(regime);
    let force = if info.bow_force_knob > 0.0 { info.bow_force_knob } else { opts.bow_force };
    let lifted = matches!(regime, BowRegime::Free);
    let lift = if lifted { 0.08 } else { 0.012 };
    // The bow crosses the string at a slight angle; where along the hair it touches shifts as it
    // travels (up-bow / down-bow).
    let half = 0.75;
    let off = -st.bow_travel * 0.45;
    let (za, zb) = (z - half + off, z + half + off);
    let skew = 0.10;
    let hair = [proj.project([x - skew, lift, za]), proj.project([x + skew, lift, zb])];
    let stick = [proj.project([x - skew, lift + 0.07, za]), proj.project([x + skew, lift + 0.05, zb])];
    let glow = if lifted { 0.25 } else { (0.35 + force.clamp(0.0, 1.0) * 0.65).min(1.0) };
    if let [Some(a), Some(b)] = hair {
        painter.line_segment([a, b], Stroke::new(10.0, c32(colour, glow * 0.3)));
        painter.line_segment([a, b], Stroke::new(2.4, c32(mix3(colour, [1.0, 1.0, 1.0], 0.5), 0.9)));
    }
    if let [Some(a), Some(b)] = stick {
        painter.line_segment([a, b], Stroke::new(2.0, c32(WOOD, 0.8)));
    }
    if let (Some(a), Some(b)) = (hair[0].zip(stick[0]).map(|(h, s)| [h, s]), hair[1].zip(stick[1]).map(|(h, s)| [h, s])) {
        painter.line_segment(a, Stroke::new(2.0, c32(WOOD, 0.8)));
        painter.line_segment(b, Stroke::new(2.0, c32(WOOD, 0.8)));
    }
    // Contact point.
    if !lifted {
        if let Some(p) = proj.project([x, 0.0, z]) {
            painter.circle_filled(p, 4.0 + 5.0 * force, c32(colour, 0.35));
        }
    }
}

fn draw_readout(painter: &Painter, lay: &Layout, scene: &Scene, opts: &PhysModOptions) {
    let Some(i) = scene.active else {
        painter.text(lay.readout, Align2::LEFT_TOP, "play a key, or drag along the string to bow", FontId::proportional(11.0), LABEL);
        return;
    };
    let s = &scene.strings[i];
    let name = format!("{} string", note_name(s.open_freq));
    let mut y = lay.readout.y;
    let line = |txt: String, y: &mut f32, c: Color32| {
        painter.text(pos2(lay.readout.x, *y), Align2::LEFT_TOP, txt, FontId::proportional(11.0), c);
        *y += 15.0;
    };
    if s.playing {
        line(format!("{name}  -  {} ({:.1} Hz){}", note_name(s.freq), s.freq, if s.finger > 0.0 { "  stopped" } else { "  open" }), &mut y, c32(AMBER, 0.95));
        let r = s.regime();
        if r != BowRegime::Free {
            line(format!("bow {:.2} N at {:.0}% from the bridge, {:.2} m/s", s.bow_force, s.beta * 100.0, s.bow_velocity.abs()), &mut y, LABEL);
            line(format!("{}", regime_label(r)), &mut y, c32(regime_colour(r), 0.95));
            if opts.physics_view {
                line(format!("sticking {:.0}% of each period  -  {:.2} slips per period", s.stick_fraction * 100.0, s.slips_per_period), &mut y, LABEL);
            }
        }
    } else {
        line(format!("{name}  -  ringing"), &mut y, LABEL);
    }
    if opts.physics_view {
        let ringing: Vec<String> = (0..scene.n_bowed + scene.n_symp).filter(|&j| j != i && scene.strings[j].level > 0.004).map(|j| note_name(scene.strings[j].open_freq)).collect();
        if !ringing.is_empty() {
            line(format!("ringing in sympathy: {}", ringing.join(", ")), &mut y, c32(VIOLET, 0.95));
        }
    }
}

fn draw_schelleng(painter: &Painter, d: Rect, scene: &Scene, opts: &PhysModOptions) {
    painter.rect_filled(d, 6u8, c32([0.03, 0.03, 0.07], 0.82));
    painter.rect_stroke(d, 6u8, Stroke::new(1.0, c32(DIM, 0.6)), StrokeKind::Middle);
    painter.text(pos2(d.min.x + 8.0, d.min.y + 6.0), Align2::LEFT_TOP, "PLAYABLE WINDOW", FontId::proportional(9.5), LABEL);
    let plot = diagram_plot(d);
    let active = scene.active.map(|i| scene.strings[i]);
    // The window at the current bow position, extrapolated along the model's measured slopes: the
    // minimum force goes as beta^-2.5, the maximum as beta^-1.4 (Schelleng's -2 and -1, measured a
    // little steeper). In knob units that is 0.5 * log10 of the force ratio.
    let (beta0, kmin0, kmax0) = match active {
        Some(s) if s.force_max_knob > s.force_min_knob && s.beta > 0.0 => (s.beta, s.force_min_knob, s.force_max_knob),
        _ => (opts.bow_position.max(0.02), 0.2, 0.75),
    };
    let steps = 40;
    let mut top = Vec::with_capacity(steps + 1);
    let mut bot = Vec::with_capacity(steps + 1);
    for k in 0..=steps {
        let x = plot.min.x + plot.width() * k as f32 / steps as f32;
        let beta = x_to_beta(plot, x);
        let kmin = kmin0 + 0.5 * SCHELLENG_MIN_BETA_EXP * (beta0 / beta).log10();
        let kmax = kmax0 + 0.5 * SCHELLENG_MAX_BETA_EXP * (beta0 / beta).log10();
        bot.push(pos2(x, knob_to_y(plot, kmin)));
        top.push(pos2(x, knob_to_y(plot, kmax)));
    }
    let clip = painter.with_clip_rect(plot);
    for k in 1..top.len() {
        if top[k].y < bot[k].y {
            clip.add(Shape::convex_polygon(vec![top[k - 1], top[k], bot[k], bot[k - 1]], c32(TEAL, 0.14), Stroke::new(0.0, Color32::TRANSPARENT)));
        }
    }
    polyline(&clip, &top, 0.0, 1.4, ROSE, 0.85);
    polyline(&clip, &bot, 0.0, 1.4, SKY, 0.85);
    painter.text(pos2(plot.max.x - 4.0, plot.min.y + 2.0), Align2::RIGHT_TOP, "raucous", FontId::proportional(9.0), c32(ROSE, 0.9));
    painter.text(pos2(plot.min.x + 4.0, plot.max.y - 2.0), Align2::LEFT_BOTTOM, "surface sound", FontId::proportional(9.0), c32(SKY, 0.9));
    painter.text(pos2(plot.center().x, d.max.y - 4.0), Align2::CENTER_BOTTOM, "bridge  <-  bow position  ->  fingerboard", FontId::proportional(8.5), LABEL);
    painter.text(pos2(d.min.x + 6.0, plot.center().y), Align2::LEFT_CENTER, "force", FontId::proportional(8.5), LABEL);
    // The bow, where it is now.
    let (beta, k, colour) = match active {
        Some(s) if s.playing && s.bow_force > 0.0 => (s.beta, s.bow_force_knob, regime_colour(s.regime())),
        _ => (opts.bow_position, opts.bow_force, VIOLET),
    };
    let p = pos2(beta_to_x(plot, beta), knob_to_y(plot, k));
    painter.circle_filled(p, 7.0, c32(colour, 0.3));
    painter.circle_filled(p, 3.5, c32(mix3(colour, [1.0, 1.0, 1.0], 0.4), 1.0));
}

fn draw_modes(painter: &Painter, m: Rect, scene: &Scene) {
    painter.rect_filled(m, 6u8, c32([0.03, 0.03, 0.07], 0.82));
    painter.rect_stroke(m, 6u8, Stroke::new(1.0, c32(DIM, 0.6)), StrokeKind::Middle);
    painter.text(pos2(m.min.x + 8.0, m.min.y + 6.0), Align2::LEFT_TOP, "BODY MODES", FontId::proportional(9.5), LABEL);
    let n = scene.modes.len().max(1);
    let area = Rect::from_min_max(pos2(m.min.x + 8.0, m.min.y + 20.0), pos2(m.max.x - 8.0, m.max.y - 14.0));
    let bw = area.width() / n as f32;
    for (k, &(f, level)) in scene.modes.iter().enumerate() {
        // Level is the mode's share of bridge velocity; show it on a 50 dB scale.
        let db = 20.0 * (level.max(1.0e-9) / 3.0e-3).log10();
        let h = ((db + 50.0) / 50.0).clamp(0.0, 1.0) * area.height();
        let x0 = area.min.x + k as f32 * bw + 2.0;
        let r = Rect::from_min_max(pos2(x0, area.max.y - h), pos2(x0 + bw - 4.0, area.max.y));
        let c = mix3(WOOD, AMBER, h / area.height());
        painter.rect_filled(r, 2u8, c32(c, 0.85));
        if f > 0.0 {
            let label = if f >= 1000.0 { format!("{:.1}k", f / 1000.0) } else { format!("{:.0}", f) };
            painter.text(pos2(x0 + (bw - 4.0) * 0.5, m.max.y - 2.0), Align2::CENTER_BOTTOM, label, FontId::proportional(8.0), LABEL);
        }
    }
}

fn draw_chip(painter: &Painter, r: Rect, on: bool) {
    painter.rect_filled(r, 11u8, c32(if on { TEAL } else { [0.08, 0.08, 0.14] }, if on { 0.85 } else { 0.9 }));
    painter.rect_stroke(r, 11u8, Stroke::new(1.0, c32(TEAL, 0.8)), StrokeKind::Middle);
    painter.text(r.center(), Align2::CENTER_CENTER, "PHYSICS", FontId::proportional(10.0), if on { Color32::from_rgb(10, 20, 30) } else { c32(TEAL, 1.0) });
}

fn draw_keys(painter: &Painter, keys: &[(u8, Rect, bool)], held: &[u8]) {
    for (midi, r, is_black) in keys.iter().filter(|k| !k.2).chain(keys.iter().filter(|k| k.2)) {
        let pressed = held.contains(midi);
        let base = if *is_black { [0.08, 0.08, 0.14] } else { [0.85, 0.86, 0.92] };
        let colour = if pressed { AMBER } else { base };
        let alpha = if pressed { 1.0 } else if *is_black { 1.0 } else { 0.92 };
        painter.rect_filled(*r, 3u8, c32(colour, alpha));
        painter.rect_stroke(*r, 3u8, Stroke::new(1.0, c32(DIM, 0.6)), StrokeKind::Middle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bow_position_and_x_are_inverses_within_the_playable_range() {
        for &finger in &[0.0f32, 0.2, 0.5] {
            for &p in &[0.02f32, 0.1, 0.25, 0.5] {
                let x = bow_x(p, finger);
                let back = bow_position_from_x(x, finger);
                assert!((back - p).abs() < 1.0e-4, "{p} -> {x} -> {back} (finger {finger})");
            }
        }
    }

    #[test]
    fn the_bow_sits_between_the_finger_and_the_bridge() {
        assert!((bow_position_to_x(0.02) - 0.96).abs() < 1.0e-4);
        assert!((bow_position_to_x(0.5) - 0.0).abs() < 1.0e-4);
        // A stopped string's vibrating part is shorter, so the same bow position sits nearer the
        // bridge in the world.
        assert!(bow_x(0.2, 0.3) > bow_x(0.2, 0.0));
    }

    #[test]
    fn strings_fan_out_from_the_nut_to_the_bridge() {
        let zs: Vec<f32> = (0..4).map(|i| string_z(i, 4)).collect();
        assert!(zs[0] > zs[1] && zs[1] > zs[2] && zs[2] > zs[3]);
        assert!((zs[0] + zs[3]).abs() < 1.0e-5);
        assert!(string_z_at(0, 4, -1.0) < string_z_at(0, 4, 1.0));
    }

    #[test]
    fn the_body_outline_has_bouts_and_a_waist() {
        let upper = body_half_width(0.2);
        let waist = body_half_width(0.5);
        let lower = body_half_width(0.8);
        assert!(upper > waist && lower > waist && lower > upper);
        assert_eq!(body_half_width(0.0), 0.0);
    }

    #[test]
    fn the_schelleng_diagram_maps_points_back_to_bow_settings() {
        let d = Rect::from_min_size(pos2(100.0, 100.0), vec2(240.0, 160.0));
        let plot = diagram_plot(d);
        let p = pos2(beta_to_x(plot, 0.1), knob_to_y(plot, 0.6));
        let (beta, k) = diagram_value(d, p).unwrap();
        assert!((beta - 0.1).abs() < 1.0e-3 && (k - 0.6).abs() < 1.0e-3, "{beta} {k}");
        assert!(diagram_value(d, pos2(0.0, 0.0)).is_none());
    }

    #[test]
    fn note_names_read_like_a_musician_would() {
        assert_eq!(note_name(440.0), "A4");
        assert_eq!(note_name(196.0), "G3");
        assert_eq!(note_name(65.41), "C2");
    }
}

//! `BrassView`: the brass instrument drawn from the model's own state, in the same neon style as
//! `PhysModView` - glowing lines, an orbiting camera, no attempt at photorealism.
//!
//! The instrument is built from the same bore profile the acoustics use: every point of the tubing
//! is where that length of air column is, as wide as the bore is there (widened for the eye), and
//! the slide's legs lengthen as the slide moves out. What moves is what the audio engine publishes
//! in `audio::brass::BrassShared`:
//!
//! * the pressure in the air column, lips to bell, glowing along the tube;
//! * the lips in the mouthpiece, opening and closing through one period of the real lip motion,
//!   slowed down so the eye can follow it;
//! * the slide where the player has put it (with the ear's corrections and the vibrato);
//! * the sound leaving the bell: its beam narrows as the wavefront steepens and the tone brightens.
//!
//! **Physics View** (`BrassViewOptions::physics_view`) adds what the eye can't normally see: the
//! pressure wave along the bore with its standing-wave envelope (nodes and antinodes), the air
//! column's resonance ladder with the note, the lips and the sounding pitch marked on it, the
//! playing map (breath against lip setting, with the slots where the lips lock onto each partial -
//! drag in it to play the held note there), and one period of mouthpiece pressure and lip opening.
//!
//! Interaction: dragging the slide's crook moves the slide (a bend, on a held note); dragging in
//! the playing map sets breath and lip tension. The PHYSICS chip toggles Physics View. The right
//! mouse button, Alt, or a pen's barrel button orbit the camera, as in the other instrument views.

use crate::audio::brass::{breath_pressure, lip_center, BrassInstrument, BrassShared, BrassState, BORE_POINTS, LADDER_POINTS, TRACE_POINTS};
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
const DIM: [f32; 3] = [0.34, 0.34, 0.46];
const LABEL: Color32 = Color32::from_rgb(170, 176, 205);

fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
fn c32(c: [f32; 3], a: f32) -> Color32 {
    Color32::from_rgba_f32([c[0], c[1], c[2], a.clamp(0.0, 1.0)])
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
    fn default() -> Self {
        Self { yaw: 0.35, pitch: 0.38, dist: 4.2 }
    }
}

impl Camera {
    pub const PITCH_MIN: f32 = -0.6;
    pub const PITCH_MAX: f32 = 1.45;

    pub fn orbit(&mut self, dx: f32, dy: f32) {
        self.yaw += dx * 0.008;
        self.pitch = (self.pitch + dy * 0.008).clamp(Self::PITCH_MIN, Self::PITCH_MAX);
    }
}

/// The centre the camera orbits, and the box the instrument is fitted into (world units: metres).
const TARGET: V3 = [0.3, 0.14, 0.0];
const FIT_MIN: V3 = [-0.42, -0.1, -0.12];
const FIT_MAX: V3 = [1.05, 0.42, 0.12];

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
        let (sy, cy) = cam.yaw.sin_cos();
        let (sp, cp) = cam.pitch.sin_cos();
        let eye = [TARGET[0] + cam.dist * cp * sy, TARGET[1] + cam.dist * sp, TARGET[2] + cam.dist * cp * cy];
        let fwd = norm(sub(TARGET, eye));
        let right = norm(cross(fwd, [0.0, 1.0, 0.0]));
        let up = cross(right, fwd);
        let mut p = Projector { eye, right, up, fwd, focal: 1.0, shift: pos2(0.0, 0.0) };
        let (mut lo, mut hi) = (pos2(f32::MAX, f32::MAX), pos2(f32::MIN, f32::MIN));
        for &x in &[FIT_MIN[0], FIT_MAX[0]] {
            for &y in &[FIT_MIN[1], FIT_MAX[1]] {
                for &z in &[FIT_MIN[2], FIT_MAX[2]] {
                    if let Some((q, _)) = p.project_raw([x, y, z]) {
                        lo = pos2(lo.x.min(q.x), lo.y.min(q.y));
                        hi = pos2(hi.x.max(q.x), hi.y.max(q.y));
                    }
                }
            }
        }
        let avail = Rect::from_min_max(pos2(rect.min.x + 18.0, rect.min.y + 14.0), pos2(rect.max.x - 18.0, rect.max.y - 14.0));
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

// ------------------------------------------------------------------------------------------
// The tubing, laid out from the bore
// ------------------------------------------------------------------------------------------

/// Length of each slide leg in first position, metres (a tenor trombone's slide is ~0.65 m).
const SLIDE_LEG: f32 = 0.62;
/// Radius of the slide's crook and of the tuning loop behind the player.
const CROOK_R: f32 = 0.05;
const TUNING_R: f32 = 0.09;
/// How far the tubing runs back past the player before the tuning loop.
const BACK_RUN: f32 = 0.30;
/// Drawn radius = `RADIUS_BASE + RADIUS_GAIN * bore radius`: a 7 mm bore would be a hairline at
/// this scale, so narrow tubing is widened more than the bell.
const RADIUS_BASE: f32 = 0.012;
const RADIUS_GAIN: f32 = 1.3;

/// One sample along the tubing: where it is, which way the air goes, the in-plane normal, the
/// bore's real radius, and how far along the air column (0 = lips, 1 = bell mouth).
#[derive(Clone, Copy, Debug)]
struct TubePoint {
    pos: V3,
    normal: V3,
    radius: f32,
    along: f32,
}

/// The trombone's path for a slide `extension` (metres beyond first position): mouthpiece, down
/// the inner slide leg, round the crook, back up the outer leg, back past the player to the tuning
/// loop, then forward through the bell section to the mouth. The path is exactly as long as the air
/// column, so each point sits where that part of the bore is.
fn tube(instrument: BrassInstrument, extension: f32, tuning: f32, samples: usize) -> Vec<TubePoint> {
    let profile = instrument.profile();
    let extra = tuning + extension;
    let total = profile.total_length(extra);
    let leg = SLIDE_LEG + extension * 0.5;
    let pi = std::f32::consts::PI;
    // Pieces: (length, kind) - straight along a heading, or a half turn about a centre.
    let fixed = 2.0 * leg + pi * CROOK_R + BACK_RUN + pi * TUNING_R;
    let forward = (total - fixed).max(0.2);
    let at = |s: f32| -> (V3, V3) {
        let mut s = s;
        // Inner leg, +x.
        if s <= leg {
            return ([s, 0.0, 0.0], [1.0, 0.0, 0.0]);
        }
        s -= leg;
        // Crook: a half turn up, centre (leg, CROOK_R).
        let crook = pi * CROOK_R;
        if s <= crook {
            let a = -pi / 2.0 + s / CROOK_R;
            return ([leg + CROOK_R * a.cos(), CROOK_R + CROOK_R * a.sin(), 0.0], [-a.sin(), a.cos(), 0.0]);
        }
        s -= crook;
        // Outer leg and on back past the player, -x.
        if s <= leg + BACK_RUN {
            return ([leg - s, 2.0 * CROOK_R, 0.0], [-1.0, 0.0, 0.0]);
        }
        s -= leg + BACK_RUN;
        // Tuning loop: a half turn up, centre (-BACK_RUN, 2 CROOK_R + TUNING_R).
        let tl = pi * TUNING_R;
        if s <= tl {
            // Arriving heading -x below the centre, leaving heading +x above it.
            let a = -pi / 2.0 - s / TUNING_R;
            let c = [-BACK_RUN, 2.0 * CROOK_R + TUNING_R];
            return ([c[0] + TUNING_R * a.cos(), c[1] + TUNING_R * a.sin(), 0.0], [a.sin(), -a.cos(), 0.0]);
        }
        s -= tl;
        // Bell section, forward (+x).
        ([-BACK_RUN + s.min(forward + 1.0), 2.0 * CROOK_R + 2.0 * TUNING_R, 0.0], [1.0, 0.0, 0.0])
    };
    (0..samples)
        .map(|k| {
            let u = k as f32 / (samples - 1).max(1) as f32;
            let s = u * total;
            let (pos, dir) = at(s);
            TubePoint { pos, normal: [-dir[1], dir[0], 0.0], radius: profile.radius_at(s, extra), along: u }
        })
        .collect()
}

/// Where the slide's crook is (the handle) for an extension, world units.
fn crook_centre(extension: f32) -> V3 {
    [SLIDE_LEG + extension * 0.5 + CROOK_R, CROOK_R, 0.0]
}

fn drawn_radius(r: f32) -> f32 {
    RADIUS_BASE + RADIUS_GAIN * r
}

// ------------------------------------------------------------------------------------------
// Public options / events / response
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct BrassViewOptions {
    pub height: f32,
    pub width: Option<f32>,
    pub keyboard: bool,
    pub first_key: u8,
    pub key_octaves: u8,
    pub held: Vec<u8>,
    pub physics_view: bool,
    /// Extra visual exaggeration of the pressure wave (1 = default).
    pub exaggeration: f32,
    /// The breath and lip-tension settings, shown on the playing map when nothing is sounding.
    pub breath: f32,
    pub lip_tension: f32,
}

impl Default for BrassViewOptions {
    fn default() -> Self {
        Self { height: 380.0, width: None, keyboard: true, first_key: 40, key_octaves: 3, held: Vec::new(), physics_view: false, exaggeration: 1.0, breath: 0.5, lip_tension: 0.0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BrassViewEvent {
    KeyDown { midi: u8, velocity: f32 },
    KeyUp { midi: u8 },
    /// The slide was dragged: the slide position (1 = closed .. 7) the drag points at.
    SlideDrag { position: f32 },
    /// A drag in the playing map: breath (0..1) and lip tension (-1..1).
    PlayDrag { breath: f32, lip_tension: f32 },
    /// The PHYSICS chip was clicked: the view the user asked for.
    PhysicsView(bool),
}

pub struct BrassViewResponse {
    pub events: Vec<BrassViewEvent>,
}

#[derive(Clone, Copy)]
enum Drag {
    Orbit,
    Slide,
    Map,
    Key { midi: u8 },
}

struct ViewState {
    camera: Camera,
    drag: Option<Drag>,
    last_pointer: Option<Pos2>,
    /// Display scale for the bore pressure: follows the peak quickly up, slowly down.
    scale_ref: f32,
    /// The pressure envelope along the bore (recent peak at each point).
    envelope: [f32; BORE_POINTS],
    /// Slow-motion phase through the published period of lip motion, 0..1.
    lip_phase: f32,
    /// Phase of the wavefronts drawn leaving the bell.
    beam_phase: f32,
    energy_ref: f32,
    last_time: f32,
}

impl Default for ViewState {
    fn default() -> Self {
        Self { camera: Camera::default(), drag: None, last_pointer: None, scale_ref: 50.0, envelope: [0.0; BORE_POINTS], lip_phase: 0.0, beam_phase: 0.0, energy_ref: 1.0e-4, last_time: 0.0 }
    }
}

/// Everything drawn this frame, read once from the shared state.
struct Scene {
    s: BrassState,
    instrument: BrassInstrument,
    bore: [f32; BORE_POINTS],
    mp: [f32; TRACE_POINTS],
    lip: [f32; TRACE_POINTS],
    ladder: [(f32, f32); LADDER_POINTS],
}

impl Scene {
    fn read(shared: &BrassShared) -> Self {
        let s = shared.state();
        let mut bore = [0.0; BORE_POINTS];
        for (i, v) in bore.iter_mut().enumerate() {
            *v = shared.bore_pressure(i);
        }
        let (mut mp, mut lip) = ([0.0; TRACE_POINTS], [0.0; TRACE_POINTS]);
        for i in 0..TRACE_POINTS {
            (mp[i], lip[i]) = shared.trace(i);
        }
        let mut ladder = [(0.0, 0.0); LADDER_POINTS];
        for (n, l) in ladder.iter_mut().enumerate() {
            *l = shared.resonance(n + 1);
        }
        Self { s, instrument: shared.instrument(), bore, mp, lip, ladder }
    }

    /// The resonance a partial sits on now (Hz), 0 if unknown.
    fn resonance(&self, n: usize) -> f32 {
        if n == 0 || n > LADDER_POINTS {
            return 0.0;
        }
        self.ladder[n - 1].0
    }
}

/// Screen-space panels.
struct Layout {
    chip: Rect,
    ladder: Option<Rect>,
    map: Option<Rect>,
    traces: Option<Rect>,
    readout: Pos2,
}

impl Layout {
    fn new(stage: Rect, physics: bool) -> Self {
        let chip = Rect::from_min_size(pos2(stage.max.x - 92.0, stage.min.y + 10.0), vec2(80.0, 22.0));
        let w = (stage.width() * 0.3).clamp(180.0, 280.0);
        let x = stage.max.x - w - 12.0;
        let avail = (stage.max.y - chip.max.y - 20.0).max(150.0);
        let h = ((avail - 16.0) / 3.0).clamp(60.0, 140.0);
        let ladder = physics.then(|| Rect::from_min_size(pos2(x, chip.max.y + 8.0), vec2(w, h)));
        let map = physics.then(|| Rect::from_min_size(pos2(x, chip.max.y + 16.0 + h), vec2(w, h)));
        let traces = physics.then(|| Rect::from_min_size(pos2(x, chip.max.y + 24.0 + 2.0 * h), vec2(w, h)));
        Self { chip, ladder, map, traces, readout: pos2(stage.min.x + 14.0, stage.min.y + 12.0) }
    }
}

fn key_layout(first: u8, octaves: u8, rect: Rect) -> Vec<(u8, Rect, bool)> {
    crate::entropy_gui::widgets_wavetable::key_layout(first, octaves, rect)
}

fn key_at(keys: &[(u8, Rect, bool)], p: Pos2) -> Option<(u8, Rect)> {
    keys.iter().filter(|k| k.2).chain(keys.iter().filter(|k| !k.2)).find(|(_, r, _)| r.contains(p)).map(|(m, r, _)| (*m, *r))
}

// ------------------------------------------------------------------------------------------
// The playing map and the ladder: axes
// ------------------------------------------------------------------------------------------

/// Lip frequency as a ratio of the note's resonance, on the playing map's vertical (log) axis.
const MAP_RATIO: (f32, f32) = (0.5, 1.25);
/// The slot's half-width around its centre, as a ratio (the fitted lock-in window is about ±8%).
const SLOT_HALF: f32 = 0.08;
/// The ladder's frequency axis (log), Hz.
const LADDER_HZ: (f32, f32) = (25.0, 1100.0);
/// Quality factor used to draw each resonance's peak (brass resonances have Q of a few tens).
const LADDER_Q: f32 = 22.0;

fn inner(r: Rect) -> Rect {
    Rect::from_min_max(pos2(r.min.x + 26.0, r.min.y + 20.0), pos2(r.max.x - 8.0, r.max.y - 16.0))
}
fn ratio_to_y(plot: Rect, r: f32) -> f32 {
    let (lo, hi) = MAP_RATIO;
    let t = (r.clamp(lo, hi).ln() - lo.ln()) / (hi.ln() - lo.ln());
    plot.max.y - t * plot.height()
}
fn y_to_ratio(plot: Rect, y: f32) -> f32 {
    let (lo, hi) = MAP_RATIO;
    let t = ((plot.max.y - y) / plot.height()).clamp(0.0, 1.0);
    (lo.ln() + t * (hi.ln() - lo.ln())).exp()
}
fn hz_to_x(plot: Rect, hz: f32) -> f32 {
    let (lo, hi) = LADDER_HZ;
    plot.min.x + (hz.clamp(lo, hi).ln() - lo.ln()) / (hi.ln() - lo.ln()) * plot.width()
}
fn x_to_hz(plot: Rect, x: f32) -> f32 {
    let (lo, hi) = LADDER_HZ;
    (lo.ln() + ((x - plot.min.x) / plot.width()).clamp(0.0, 1.0) * (hi.ln() - lo.ln())).exp()
}

/// Where the player's lips sit in the slot for a breath knob: the fitted `lip_center` law, as a
/// ratio of the resonance (the same for every partial).
fn slot_centre(breath: f32) -> f32 {
    lip_center(1000.0, breath_pressure(breath)) / 1000.0
}

/// A point in the playing map as (breath, lip tension).
pub fn map_value(m: Rect, p: Pos2) -> Option<(f32, f32)> {
    if !m.contains(p) {
        return None;
    }
    let plot = inner(m);
    let breath = ((p.x - plot.min.x) / plot.width()).clamp(0.0, 1.0);
    let ratio = y_to_ratio(plot, p.y);
    let tension = ((ratio / slot_centre(breath)).log2() / 0.35).clamp(-1.0, 1.0);
    Some((breath, tension))
}

// ------------------------------------------------------------------------------------------
// The widget
// ------------------------------------------------------------------------------------------

pub struct BrassView {
    id: Id,
}

impl BrassView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new(id_salt) }
    }

    pub fn show(self, ui: &mut Ui, opts: &BrassViewOptions, shared: &BrassShared) -> BrassViewResponse {
        let ctx = ui.ctx().clone();
        let width = opts.width.unwrap_or_else(|| ui.available_width().max(360.0));
        let (resp, painter) = ui.allocate_painter(vec2(width, opts.height.max(240.0)), Sense::click_and_drag());
        let rect = resp.rect;
        let scene = Scene::read(shared);

        let (pointer, mods) = ctx.input(|i| (i.pointer, i.modifiers));
        let mut st: ViewState = ctx.memory_mut(|m| m.take_view_state(self.id));
        let now = ctx.time();
        let dt = (now - st.last_time).clamp(0.0, 0.1);
        st.last_time = now;
        let mut events: Vec<BrassViewEvent> = Vec::new();
        let pos = pointer.pos;

        let key_h = if opts.keyboard { 60.0 } else { 0.0 };
        let stage = Rect::from_min_max(rect.min, pos2(rect.max.x, rect.max.y - key_h));
        let key_rect = Rect::from_min_max(pos2(rect.min.x, rect.max.y - key_h), rect.max);
        let key_rects = if opts.keyboard { key_layout(opts.first_key, opts.key_octaves, key_rect) } else { Vec::new() };
        let lay = Layout::new(stage, opts.physics_view);
        let proj = Projector::new(&st.camera, stage);

        // ---------------------------------------------------------------- input
        let velocity_at = |p: Pos2, kr: Rect| pointer.pen.map(|pn| pn.pressure.max(0.2)).unwrap_or(0.35 + 0.65 * ((p.y - kr.min.y) / kr.height()).clamp(0.0, 1.0));
        if st.drag.is_none() && (pointer.primary_pressed || pointer.secondary_pressed) {
            if let Some(p) = pos {
                let orbit = pointer.secondary_pressed || mods.alt || pointer.pen.is_some_and(|pn| pn.barrel);
                if pointer.primary_pressed && lay.chip.contains(p) {
                    events.push(BrassViewEvent::PhysicsView(!opts.physics_view));
                } else if pointer.primary_pressed && lay.map.is_some_and(|m| m.contains(p)) {
                    st.drag = Some(Drag::Map);
                    if let Some((breath, lip_tension)) = map_value(lay.map.unwrap(), p) {
                        events.push(BrassViewEvent::PlayDrag { breath, lip_tension });
                    }
                } else if orbit && stage.contains(p) {
                    st.drag = Some(Drag::Orbit);
                } else if pointer.primary_pressed && slide_handle(&proj, &scene).is_some_and(|(c, r)| (p - c).length() < r) {
                    st.drag = Some(Drag::Slide);
                    if let Some(position) = slide_value(&proj, &scene, p) {
                        events.push(BrassViewEvent::SlideDrag { position });
                    }
                } else if pointer.primary_pressed && opts.keyboard && key_rect.contains(p) {
                    if let Some((midi, kr)) = key_at(&key_rects, p) {
                        events.push(BrassViewEvent::KeyDown { midi, velocity: velocity_at(p, kr) });
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
                Drag::Slide => {
                    if let (Some(p), true) = (pos, still_down) {
                        if let Some(position) = slide_value(&proj, &scene, p) {
                            events.push(BrassViewEvent::SlideDrag { position });
                        }
                    }
                }
                Drag::Map => {
                    if let (Some(p), true, Some(m)) = (pos, still_down, lay.map) {
                        if let Some((breath, lip_tension)) = map_value(m, p) {
                            events.push(BrassViewEvent::PlayDrag { breath, lip_tension });
                        }
                    }
                }
                Drag::Key { midi } => {
                    if let (Some(p), true) = (pos, still_down) {
                        if let Some((m2, kr)) = key_at(&key_rects, p) {
                            if m2 != midi {
                                events.push(BrassViewEvent::KeyUp { midi });
                                events.push(BrassViewEvent::KeyDown { midi: m2, velocity: velocity_at(p, kr) });
                                st.drag = Some(Drag::Key { midi: m2 });
                            }
                        }
                    }
                }
            }
            if !still_down {
                if let Drag::Key { midi } = drag {
                    events.push(BrassViewEvent::KeyUp { midi });
                }
                st.drag = None;
            }
        }
        st.last_pointer = pos;

        // ---------------------------------------------------------------- state updates
        let peak = scene.bore.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        st.scale_ref = if peak > st.scale_ref { peak } else { (st.scale_ref * (-dt / 2.0).exp()).max(peak).max(50.0) };
        let decay = (-dt / 0.5).exp();
        for (e, v) in st.envelope.iter_mut().zip(scene.bore.iter()) {
            *e = (*e * decay).max(v.abs());
        }
        // One period of lip motion every 1.5 s: slow enough to follow.
        st.lip_phase = (st.lip_phase + dt / 1.5).fract();
        st.beam_phase = (st.beam_phase + dt * 0.9).fract();
        st.energy_ref = if scene.s.energy > st.energy_ref { scene.s.energy } else { (st.energy_ref * (-dt / 3.0).exp()).max(1.0e-4) };

        // ---------------------------------------------------------------- drawing
        for y in 0..24 {
            let (t0, t1) = (y as f32 / 24.0, (y + 1) as f32 / 24.0);
            let band = Rect::from_min_max(pos2(rect.min.x, rect.min.y + t0 * rect.height()), pos2(rect.max.x, rect.min.y + t1 * rect.height()));
            painter.rect_filled(band, 0u8, c32(mix3(BG_TOP, BG_BOTTOM, (t0 + t1) * 0.5), 1.0));
        }
        let clip = painter.with_clip_rect(stage);
        let pts = tube(scene.instrument, scene.s.extension, scene.s.tuning, 260);
        draw_beam(&clip, &proj, &pts, &scene, &st);
        draw_tube(&clip, &proj, &pts, &scene, &st, opts);
        draw_lips(&clip, &proj, &scene, &st);
        draw_slide_handle(&clip, &proj, &scene, matches!(st.drag, Some(Drag::Slide)));
        draw_readout(&clip, &lay, &scene, opts);
        if let Some(r) = lay.ladder {
            draw_ladder(&clip, r, &scene);
        }
        if let Some(r) = lay.map {
            draw_map(&clip, r, &scene, opts);
        }
        if let Some(r) = lay.traces {
            draw_traces(&clip, r, &scene, &st);
        }
        draw_chip(&clip, lay.chip, opts.physics_view);
        if opts.keyboard {
            draw_keys(&painter, &key_rects, &opts.held);
        }

        ctx.memory_mut(|m| m.put_view_state(self.id, st));
        BrassViewResponse { events }
    }
}

// ------------------------------------------------------------------------------------------
// Interaction geometry
// ------------------------------------------------------------------------------------------

/// Where the slide's handle is drawn for a widget occupying `rect` with the default camera: for
/// tests and automation that want to grab it.
pub fn slide_handle_screen(rect: Rect, opts: &BrassViewOptions, shared: &BrassShared) -> Option<Pos2> {
    let key_h = if opts.keyboard { 60.0 } else { 0.0 };
    let stage = Rect::from_min_max(rect.min, pos2(rect.max.x, rect.max.y - key_h));
    let proj = Projector::new(&Camera::default(), stage);
    slide_handle(&proj, &Scene::read(shared)).map(|(c, _)| c)
}

/// The slide's handle on screen: its centre and grab radius.
fn slide_handle(proj: &Projector, scene: &Scene) -> Option<(Pos2, f32)> {
    proj.project(crook_centre(scene.s.extension)).map(|c| (c, 26.0))
}

/// The slide position (1..7) a drag point asks for: projected onto the slide's travel on screen.
fn slide_value(proj: &Projector, scene: &Scene, p: Pos2) -> Option<f32> {
    let max = scene.s.slide_max.max(0.01);
    let a = proj.project(crook_centre(0.0))?;
    let b = proj.project(crook_centre(max))?;
    let ab = vec2(b.x - a.x, b.y - a.y);
    let t = (((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x * ab.x + ab.y * ab.y).max(1.0)).clamp(0.0, 1.0);
    let profile = scene.instrument.profile();
    let total0 = profile.total_length(scene.s.tuning);
    Some(1.0 + 12.0 * ((total0 + t * max) / total0).log2())
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

/// Bore pressure at a fraction along the air column (published points, interpolated).
fn pressure_at(values: &[f32; BORE_POINTS], along: f32) -> f32 {
    let f = along.clamp(0.0, 1.0) * (BORE_POINTS - 1) as f32;
    let i = (f as usize).min(BORE_POINTS - 2);
    let t = f - i as f32;
    values[i] * (1.0 - t) + values[i + 1] * t
}

fn draw_tube(painter: &Painter, proj: &Projector, pts: &[TubePoint], scene: &Scene, st: &ViewState, opts: &BrassViewOptions) {
    let sounding = scene.s.playing;
    let norm_p = |v: f32| (v / st.scale_ref).clamp(-1.5, 1.5);
    // Both walls of the tube, glowing where the air is moving most (the envelope's antinodes).
    for side in [-1.0f32, 1.0] {
        let edge: Vec<(Pos2, f32)> = pts
            .iter()
            .filter_map(|t| {
                let glow = if sounding { (pressure_at(&st.envelope, t.along) / st.scale_ref).clamp(0.0, 1.0) } else { 0.0 };
                proj.project(add(t.pos, scale(t.normal, side * drawn_radius(t.radius)))).map(|p| (p, glow))
            })
            .collect();
        for w in edge.windows(2) {
            let g = 0.5 * (w[0].1 + w[1].1);
            let colour = mix3(BRASS, [1.0, 0.95, 0.8], g * 0.6);
            painter.line_segment([w[0].0, w[1].0], Stroke::new(4.0 + 6.0 * g, c32(colour, 0.12 + 0.2 * g)));
            painter.line_segment([w[0].0, w[1].0], Stroke::new(1.4, c32(colour, 0.55 + 0.4 * g)));
        }
    }
    // Rings: the tube's cross-sections, lit by the pressure there now.
    for t in pts.iter().step_by(6) {
        let r = drawn_radius(t.radius);
        let ring: Vec<Pos2> = (0..=14)
            .filter_map(|k| {
                let a = std::f32::consts::TAU * k as f32 / 14.0;
                proj.project(add(t.pos, add(scale(t.normal, r * a.cos()), [0.0, 0.0, r * a.sin()])))
            })
            .collect();
        let v = if sounding { norm_p(pressure_at(&scene.bore, t.along)) } else { 0.0 };
        let colour = if v >= 0.0 { mix3(BRASS, AMBER, v) } else { mix3(BRASS, VIOLET, -v) };
        polyline(painter, &ring, 0.0, 1.0, colour, 0.25 + 0.5 * v.abs().min(1.0));
    }
    if opts.physics_view && sounding {
        // The pressure wave itself, drawn beside the tube (outward along the normal), and its
        // envelope: the standing wave, nodes and antinodes.
        let gain = 0.09 * opts.exaggeration.clamp(0.1, 4.0);
        let wave: Vec<Pos2> = pts
            .iter()
            .filter_map(|t| {
                let off = drawn_radius(t.radius) + 0.03 + gain * norm_p(pressure_at(&scene.bore, t.along));
                proj.project(add(t.pos, [0.0, 0.0, off]))
            })
            .collect();
        polyline(painter, &wave, 5.0, 1.6, TEAL, 0.9);
        for side in [-1.0f32, 1.0] {
            let env: Vec<Pos2> = pts
                .iter()
                .filter_map(|t| {
                    let off = drawn_radius(t.radius) + 0.03 + side * gain * (pressure_at(&st.envelope, t.along) / st.scale_ref).min(1.5);
                    proj.project(add(t.pos, [0.0, 0.0, off]))
                })
                .collect();
            polyline(painter, &env, 0.0, 1.0, SKY, 0.45);
        }
    }
}

fn draw_lips(painter: &Painter, proj: &Projector, scene: &Scene, st: &ViewState) {
    // The mouthpiece's rim, and the lips across it opening and closing through one period of the
    // real lip motion (slowed, and the few-millimetre opening enlarged 40x).
    let rim = drawn_radius(0.0127);
    let centre = [-0.012, 0.0, 0.0];
    let ring: Vec<Pos2> = (0..=18)
        .filter_map(|k| {
            let a = std::f32::consts::TAU * k as f32 / 18.0;
            proj.project(add(centre, [0.0, rim * a.cos(), rim * a.sin()]))
        })
        .collect();
    polyline(painter, &ring, 3.0, 1.4, BRASS, 0.8);
    let idx = ((st.lip_phase * TRACE_POINTS as f32) as usize).min(TRACE_POINTS - 1);
    let opening = if scene.s.playing { scene.lip[idx].max(0.0) } else { scene.s.lip_opening.max(0.0) };
    let gap = (opening * 40.0).min(rim * 0.9);
    for side in [-1.0f32, 1.0] {
        let lip: Vec<Pos2> = (0..=10)
            .filter_map(|k| {
                let z = -rim * 0.9 + 1.8 * rim * k as f32 / 10.0;
                let bulge = 0.006 * (1.0 - (z / (rim * 0.9)).powi(2));
                proj.project([-0.02, side * (gap * 0.5 + bulge), z])
            })
            .collect();
        polyline(painter, &lip, 6.0, 2.2, ROSE, if scene.s.playing { 0.95 } else { 0.5 });
    }
}

fn draw_slide_handle(painter: &Painter, proj: &Projector, scene: &Scene, dragging: bool) {
    if let Some(c) = proj.project(crook_centre(scene.s.extension)) {
        let colour = if dragging { TEAL } else { AMBER };
        painter.circle_stroke(c, 10.0, Stroke::new(1.6, c32(colour, 0.8)));
        painter.text(pos2(c.x, c.y + 14.0), Align2::CENTER_TOP, format!("pos {:.1}", scene.s.position), FontId::proportional(9.5), c32(colour, 0.9));
    }
}

fn draw_beam(painter: &Painter, proj: &Projector, pts: &[TubePoint], scene: &Scene, st: &ViewState) {
    // The sound leaving the bell: wavefronts spreading from the mouth. How far they carry follows the
    // level; how narrow the beam is follows the wavefront's steepness at the bell (a brassier note
    // puts its energy into highs, which the bell beams forward).
    let Some(mouth) = pts.last() else { return };
    if !scene.s.playing || scene.s.energy <= 1.0e-5 {
        return;
    }
    let level = (scene.s.energy / st.energy_ref).clamp(0.0, 1.0).sqrt();
    let steep = ((scene.s.wave_steepness.max(1.0).log10() - 5.0) / 2.5).clamp(0.0, 1.0);
    let half = (1.1 - 0.75 * steep).max(0.2);
    let reach = 0.25 + 0.55 * level;
    let r0 = drawn_radius(mouth.radius);
    for k in 0..4 {
        let t = (st.beam_phase + k as f32 * 0.25).fract();
        let r = r0 + t * reach;
        let arc: Vec<Pos2> = (0..=16)
            .filter_map(|j| {
                let a = -half + 2.0 * half * j as f32 / 16.0;
                proj.project(add(mouth.pos, [r * a.cos(), r * a.sin(), 0.0]))
            })
            .collect();
        polyline(painter, &arc, 4.0, 1.2, mix3(AMBER, TEAL, steep), (1.0 - t) * 0.8);
    }
}

fn draw_readout(painter: &Painter, lay: &Layout, scene: &Scene, opts: &BrassViewOptions) {
    let s = &scene.s;
    let mut y = lay.readout.y;
    let line = |txt: String, y: &mut f32, c: Color32| {
        painter.text(pos2(lay.readout.x, *y), Align2::LEFT_TOP, txt, FontId::proportional(11.0), c);
        *y += 15.0;
    };
    line(format!("{}", scene.instrument.name().to_uppercase()), &mut y, c32(BRASS, 0.9));
    if !s.playing {
        line("play a key - drag the slide or the playing map to steer a held note".into(), &mut y, LABEL);
        return;
    }
    let cents = if s.sounding > 0.0 && s.target > 0.0 { 1200.0 * (s.sounding / s.target).log2() } else { 0.0 };
    line(format!("{}  ({:.1} Hz, {:+.0} cents)", note_name(s.target), s.sounding, cents), &mut y, c32(AMBER, 0.95));
    line(format!("partial {}  -  slide position {:.1}", s.partial, s.position), &mut y, LABEL);
    line(format!("breath {:.1} kPa  -  lips {:.0} Hz, open {:.2} mm", s.mouth_pressure / 1000.0, s.lip_freq, s.lip_opening * 1000.0), &mut y, LABEL);
    let steep = s.wave_steepness;
    let (label, colour) = if steep > 2.0e7 {
        ("wavefront shocked - blazing", ROSE)
    } else if steep > 4.0e6 {
        ("wavefront steepening - brassy", AMBER)
    } else {
        ("smooth wave - round tone", TEAL)
    };
    line(label.into(), &mut y, c32(colour, 0.95));
    if opts.physics_view {
        line(format!("mouthpiece {:.1} kPa rms  -  bell slope {:.1e} Pa/s", s.mouthpiece_level / 1000.0, steep), &mut y, LABEL);
    }
}

fn panel(painter: &Painter, r: Rect, title: &str) {
    painter.rect_filled(r, 6u8, c32([0.03, 0.03, 0.07], 0.82));
    painter.rect_stroke(r, 6u8, Stroke::new(1.0, c32(DIM, 0.6)), StrokeKind::Middle);
    painter.text(pos2(r.min.x + 8.0, r.min.y + 5.0), Align2::LEFT_TOP, title, FontId::proportional(9.5), LABEL);
}

fn draw_ladder(painter: &Painter, r: Rect, scene: &Scene) {
    panel(painter, r, "RESONANCES");
    let plot = inner(r);
    let top = scene.ladder.iter().fold(1.0f32, |m, l| m.max(l.1));
    // The air column's input impedance, drawn from its resonances (each a peak of its measured
    // height), and the partials numbered.
    let curve: Vec<Pos2> = (0..=120)
        .map(|k| {
            let x = plot.min.x + plot.width() * k as f32 / 120.0;
            let f = x_to_hz(plot, x);
            let z = scene.ladder.iter().filter(|l| l.0 > 0.0).map(|&(fr, mag)| mag / (1.0 + (LADDER_Q * (f / fr - fr / f)).powi(2)).sqrt()).fold(0.0f32, f32::max);
            pos2(x, plot.max.y - (z / top).clamp(0.0, 1.0) * plot.height())
        })
        .collect();
    polyline(painter, &curve, 3.0, 1.2, BRASS, 0.85);
    for (n, &(fr, mag)) in scene.ladder.iter().enumerate() {
        if fr > LADDER_HZ.0 && fr < LADDER_HZ.1 && (n + 1 == scene.s.partial || n < 8) {
            let x = hz_to_x(plot, fr);
            let y = plot.max.y - (mag / top).clamp(0.0, 1.0) * plot.height();
            let c = if n + 1 == scene.s.partial { AMBER } else { DIM };
            painter.text(pos2(x, y - 2.0), Align2::CENTER_BOTTOM, format!("{}", n + 1), FontId::proportional(8.5), c32(c, 1.0));
        }
    }
    let mark = |hz: f32, colour: [f32; 3], label: &str, row: f32| {
        if hz > 0.0 {
            let x = hz_to_x(plot, hz);
            painter.line_segment([pos2(x, plot.min.y), pos2(x, plot.max.y)], Stroke::new(1.2, c32(colour, 0.9)));
            painter.text(pos2(x + 2.0, plot.min.y + row), Align2::LEFT_TOP, label, FontId::proportional(8.0), c32(colour, 1.0));
        }
    };
    if scene.s.playing {
        mark(scene.s.lip_freq, ROSE, "lips", 0.0);
        mark(scene.s.sounding, TEAL, "sounding", 10.0);
    }
    painter.text(pos2(plot.center().x, r.max.y - 3.0), Align2::CENTER_BOTTOM, "frequency (Hz, log)", FontId::proportional(8.5), LABEL);
}

fn draw_map(painter: &Painter, r: Rect, scene: &Scene, opts: &BrassViewOptions) {
    panel(painter, r, "PLAYING MAP");
    let plot = inner(r);
    let clip = painter.with_clip_rect(plot);
    // The slots: for the note's partial and its neighbours, the band of lip settings (as a ratio of
    // the note's resonance) that lock onto each, across the breath range - the fitted law.
    let n = scene.s.partial.max(1);
    let res = scene.resonance(n).max(1.0);
    for (k, colour) in [(n.saturating_sub(1), SKY), (n + 1, ROSE), (n, TEAL)] {
        let fk = scene.resonance(k);
        if k == 0 || fk <= 0.0 {
            continue;
        }
        let steps = 32;
        let band: Vec<(Pos2, Pos2)> = (0..=steps)
            .map(|j| {
                let b = j as f32 / steps as f32;
                let c = slot_centre(b) * fk / res;
                let x = plot.min.x + b * plot.width();
                (pos2(x, ratio_to_y(plot, c * (1.0 + SLOT_HALF))), pos2(x, ratio_to_y(plot, c * (1.0 - SLOT_HALF))))
            })
            .collect();
        for w in band.windows(2) {
            clip.add(Shape::convex_polygon(vec![w[0].0, w[1].0, w[1].1, w[0].1], c32(colour, if k == n { 0.22 } else { 0.12 }), Stroke::new(0.0, Color32::TRANSPARENT)));
        }
        let label_at = band[steps / 2].1;
        clip.text(pos2(label_at.x, label_at.y - 1.0), Align2::CENTER_BOTTOM, format!("partial {k}"), FontId::proportional(8.0), c32(colour, 0.9));
    }
    painter.text(pos2(plot.center().x, r.max.y - 3.0), Align2::CENTER_BOTTOM, "breath  ->", FontId::proportional(8.5), LABEL);
    painter.text(pos2(r.min.x + 4.0, plot.center().y), Align2::LEFT_CENTER, "lips", FontId::proportional(8.5), LABEL);
    // Where the player is now.
    let (breath, ratio, colour) = if scene.s.playing && scene.s.lip_freq > 0.0 {
        (scene.s.breath, scene.s.lip_freq / res, AMBER)
    } else {
        (opts.breath, slot_centre(opts.breath) * 2f32.powf(opts.lip_tension * 0.35), VIOLET)
    };
    let p = pos2(plot.min.x + breath.clamp(0.0, 1.0) * plot.width(), ratio_to_y(plot, ratio));
    painter.circle_filled(p, 7.0, c32(colour, 0.3));
    painter.circle_filled(p, 3.5, c32(mix3(colour, [1.0, 1.0, 1.0], 0.4), 1.0));
}

fn draw_traces(painter: &Painter, r: Rect, scene: &Scene, st: &ViewState) {
    panel(painter, r, "ONE PERIOD");
    let plot = inner(r);
    let (lo, hi) = scene.mp.iter().fold((f32::MAX, f32::MIN), |(a, b), v| (a.min(*v), b.max(*v)));
    let span = (hi - lo).max(1.0);
    let top = scene.lip.iter().fold(1.0e-6f32, |m, v| m.max(*v));
    let x_of = |i: usize| plot.min.x + plot.width() * i as f32 / (TRACE_POINTS - 1) as f32;
    let pressure: Vec<Pos2> = (0..TRACE_POINTS).map(|i| pos2(x_of(i), plot.max.y - (scene.mp[i] - lo) / span * plot.height())).collect();
    let lips: Vec<Pos2> = (0..TRACE_POINTS).map(|i| pos2(x_of(i), plot.max.y - (scene.lip[i].max(0.0) / top) * plot.height() * 0.9)).collect();
    polyline(painter, &pressure, 3.0, 1.3, AMBER, 0.9);
    polyline(painter, &lips, 3.0, 1.3, ROSE, 0.9);
    // Where the slow-motion lips in the 3D view are in the period.
    let x = plot.min.x + st.lip_phase * plot.width();
    painter.line_segment([pos2(x, plot.min.y), pos2(x, plot.max.y)], Stroke::new(1.0, c32(DIM, 0.8)));
    painter.text(pos2(plot.max.x, r.min.y + 5.0), Align2::RIGHT_TOP, "mouthpiece / lips", FontId::proportional(8.5), LABEL);
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
        painter.rect_filled(*r, 3u8, c32(if pressed { BRASS } else { base }, if pressed || *is_black { 1.0 } else { 0.92 }));
        painter.rect_stroke(*r, 3u8, Stroke::new(1.0, c32(DIM, 0.6)), StrokeKind::Middle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tubing_is_as_long_as_the_air_column_and_the_slide_lengthens_it() {
        let length = |pts: &[TubePoint]| pts.windows(2).map(|w| dot(sub(w[1].pos, w[0].pos), sub(w[1].pos, w[0].pos)).sqrt()).sum::<f32>();
        let profile = BrassInstrument::TenorTrombone.profile();
        for &e in &[0.0f32, 0.5, 1.1] {
            let pts = tube(BrassInstrument::TenorTrombone, e, 0.1, 2000);
            let want = profile.total_length(0.1 + e);
            assert!((length(&pts) - want).abs() < 0.02 * want, "extension {e}: tube {} m, bore {want} m", length(&pts));
            // It starts at the lips and ends at the bell, whose drawn radius is the widest.
            assert!(pts.last().unwrap().radius > 5.0 * pts[pts.len() / 2].radius);
        }
        assert!(crook_centre(1.0)[0] > crook_centre(0.0)[0] + 0.45, "the slide travels out");
    }

    #[test]
    fn the_playing_map_maps_points_back_to_breath_and_lips() {
        let m = Rect::from_min_size(pos2(50.0, 50.0), vec2(240.0, 140.0));
        let plot = inner(m);
        for &(b, t) in &[(0.3f32, 0.0f32), (0.7, 0.4), (0.5, -0.5)] {
            let p = pos2(plot.min.x + b * plot.width(), ratio_to_y(plot, slot_centre(b) * 2f32.powf(t * 0.35)));
            let (b2, t2) = map_value(m, p).unwrap();
            assert!((b2 - b).abs() < 1.0e-3 && (t2 - t).abs() < 1.0e-3, "{b},{t} -> {b2},{t2}");
        }
        assert!(map_value(m, pos2(0.0, 0.0)).is_none());
    }

    #[test]
    fn the_ladder_axis_round_trips() {
        let plot = Rect::from_min_size(pos2(0.0, 0.0), vec2(300.0, 100.0));
        for &f in &[40.0f32, 233.0, 900.0] {
            assert!((x_to_hz(plot, hz_to_x(plot, f)) / f - 1.0).abs() < 1.0e-3);
        }
    }
}

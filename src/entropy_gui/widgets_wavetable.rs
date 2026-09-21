//! `WavetableView`: a wavetable as terrain you sculpt, with a single-cycle pen strip, the harmonics
//! of the selected frame, and a keyboard to hear it with. The data is `audio::wavetable::Wavetable`;
//! the widget edits it in place and the audio thread hears the edit on its next sample.
//!
//! One rect, four regions:
//!
//! * **Terrain.** Every frame is a ridge, drawn back to front with an opaque curtain under it, so a
//!   ridge hides what is behind it the way a solid would (hidden-line removal by painter's order, no
//!   depth buffer). The camera orbits; the brush works on the surface under the pointer.
//! * **Cycle.** The selected frame as one flat wave. Drag to draw it.
//! * **Harmonics.** The first partials of the selected frame, as bars.
//! * **Keys.** Two or three octaves. Press to play, slide to glide between keys.
//!
//! Mouse and pen work the same way with the same gestures. A mouse presses at a fixed comfortable
//! pressure; a pen presses with its own, leans the brush footprint with its tilt, and inverts the
//! brush with its eraser end. The pen's side button (and the right mouse button, and Alt) orbits, so
//! a stylus never needs a keyboard to move the camera.
//!
//! Like `TrackView` and the analysis widgets the geometry the caller may want (the projector, every
//! button rect, every key rect) is handed back in the response, so a test can aim at a cell of the
//! table instead of a pixel.

use std::f32::consts::PI;

use crate::audio::wavetable::{frame_at_z, BrushTool, Heights, Stamp, Surface, Wavetable, TABLE_SIZE, WORLD_DEPTH, WORLD_WIDTH};
use crate::core::vertex::Vertex;
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::Ui;

// ------------------------------------------------------------------------------------------
// Palette
// ------------------------------------------------------------------------------------------

const BG_TOP: [f32; 3] = [0.028, 0.032, 0.070];
const BG_BOTTOM: [f32; 3] = [0.060, 0.050, 0.120];
const PANEL_TOP: Color32 = Color32::from_rgb(11, 13, 25);
const PANEL_BOTTOM: Color32 = Color32::from_rgb(18, 17, 36);
const TEAL: [f32; 3] = [0.28, 0.90, 0.84];
const VIOLET: [f32; 3] = [0.58, 0.45, 1.0];
const PINK: [f32; 3] = [1.0, 0.38, 0.66];
const AMBER: [f32; 3] = [1.0, 0.78, 0.36];
const LABEL: Color32 = Color32::from_rgb(120, 128, 156);
const LABEL_BRIGHT: Color32 = Color32::from_rgb(196, 204, 230);

/// World height of a full-scale sample. Everything vertical (drawing, picking) uses this.
pub const HEIGHT_SCALE: f32 = 0.30;
/// How hard a mouse presses, 0..1. A pen presses with its own pressure.
pub const MOUSE_PRESSURE: f32 = 0.8;
/// Brush strength 1.0 changes the surface by this much per second at full pressure under the brush's centre.
pub const BRUSH_RATE: f32 = 3.0;
const RIDGE_POINTS: usize = 144;

fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn rgba(c: [f32; 3], a: f32) -> [f32; 4] {
    [c[0], c[1], c[2], a.clamp(0.0, 1.0)]
}

/// The terrain's colour at `t` (0 front, 1 back): teal, through violet, to pink.
fn ramp(t: f32) -> [f32; 3] {
    if t < 0.5 { mix3(TEAL, VIOLET, t * 2.0) } else { mix3(VIOLET, PINK, (t - 0.5) * 2.0) }
}

fn bg_at(y_frac: f32) -> [f32; 3] {
    mix3(BG_TOP, BG_BOTTOM, y_frac)
}

fn c32(c: [f32; 3], a: f32) -> Color32 {
    Color32::from_rgba_f32([c[0], c[1], c[2], a])
}

// ------------------------------------------------------------------------------------------
// 3D
// ------------------------------------------------------------------------------------------

pub type V3 = [f32; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
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

/// An orbit camera around the middle of the terrain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    /// Turn around the vertical axis, radians. 0 looks along -z from the front.
    pub yaw: f32,
    /// Elevation above the floor, radians.
    pub pitch: f32,
    /// Eye distance, world units. Only changes how strong the perspective is: the picture is fitted
    /// to the widget either way.
    pub dist: f32,
    /// Magnification of the fitted picture.
    pub zoom: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self { yaw: 0.42, pitch: 0.62, dist: 5.2, zoom: 1.0 }
    }
}

impl Camera {
    pub const PITCH_MIN: f32 = 0.10;
    pub const PITCH_MAX: f32 = 1.50;

    /// Turns the camera by a pointer drag, in pixels.
    pub fn orbit(&mut self, dx: f32, dy: f32) {
        self.yaw += dx * 0.008;
        self.pitch = (self.pitch + dy * 0.008).clamp(Self::PITCH_MIN, Self::PITCH_MAX);
    }

    pub fn top_view() -> Self {
        Self { yaw: 0.0, pitch: Self::PITCH_MAX, ..Self::default() }
    }

    pub fn front_view() -> Self {
        Self { yaw: 0.0, pitch: 0.16, ..Self::default() }
    }
}

/// A camera fitted to a rect: what projects a world point to a pixel and a pixel to a ray.
#[derive(Clone, Copy, Debug)]
pub struct Projector {
    eye: V3,
    right: V3,
    up: V3,
    fwd: V3,
    centre: Pos2,
    focal: f32,
    shift: Pos2,
    /// The phase axis is stretched by this much on screen, so a wide widget is filled rather than
    /// letterboxed by the height-limited fit. World space (what is picked and brushed) is unstretched.
    xs: f32,
    pub rect: Rect,
}

impl Projector {
    pub fn new(cam: &Camera, rect: Rect) -> Self {
        let (sy, cy) = cam.yaw.sin_cos();
        let (sp, cp) = cam.pitch.sin_cos();
        let eye = [cam.dist * cp * sy, cam.dist * sp, cam.dist * cp * cy];
        let fwd = norm(scale(eye, -1.0));
        let right = norm(cross(fwd, [0.0, 1.0, 0.0]));
        let up = cross(right, fwd);
        let mut p = Projector { eye, right, up, fwd, centre: rect.center(), focal: 1.0, shift: pos2(0.0, 0.0), xs: 1.0, rect };
        // Fit: project the slab's corners with a unit focal length, then scale and shift the
        // picture so their bounds fill the rect with a margin. The toolbar takes the top and the
        // depth rail the right, so the picture is fitted to the rect between them.
        let hs = HEIGHT_SCALE;
        let bounds = |p: &Projector| {
            let mut lo = pos2(f32::MAX, f32::MAX);
            let mut hi = pos2(f32::MIN, f32::MIN);
            for &x in &[-1.0f32, 1.0] {
                for &y in &[-hs, hs] {
                    for &z in &[-WORLD_DEPTH / 2.0, WORLD_DEPTH / 2.0] {
                        if let Some((q, _)) = p.project_raw([x, y, z]) {
                            lo = pos2(lo.x.min(q.x), lo.y.min(q.y));
                            hi = pos2(hi.x.max(q.x), hi.y.max(q.y));
                        }
                    }
                }
            }
            (lo, hi)
        };
        let avail = Rect::from_min_max(pos2(rect.min.x + 14.0, rect.min.y + 46.0), pos2(rect.max.x - 46.0, rect.max.y - 30.0));
        let (lo, hi) = bounds(&p);
        let want = (avail.width() / avail.height().max(1.0)) / ((hi.x - lo.x).max(1.0e-3) / (hi.y - lo.y).max(1.0e-3));
        p.xs = (want * 0.92).clamp(1.0, 2.6);
        let (lo, hi) = bounds(&p);
        let (bw, bh) = ((hi.x - lo.x).max(1.0e-3), (hi.y - lo.y).max(1.0e-3));
        p.focal = (avail.width() / bw).min(avail.height() / bh) * cam.zoom.clamp(0.4, 3.0) * 0.98;
        p.shift = pos2(avail.center().x - (lo.x + hi.x) * 0.5 * p.focal, avail.center().y - (lo.y + hi.y) * 0.5 * p.focal);
        p
    }

    fn project_raw(&self, w: V3) -> Option<(Pos2, f32)> {
        let v = sub([w[0] * self.xs, w[1], w[2]], self.eye);
        let depth = dot(v, self.fwd);
        if depth < 0.05 {
            return None;
        }
        Some((pos2(dot(v, self.right) / depth * self.focal + self.shift.x, -dot(v, self.up) / depth * self.focal + self.shift.y), depth))
    }

    /// The pixel a world point lands on, and its distance along the view direction.
    pub fn project(&self, w: V3) -> Option<(Pos2, f32)> {
        self.project_raw(w)
    }

    pub fn depth(&self, w: V3) -> f32 {
        dot(sub([w[0] * self.xs, w[1], w[2]], self.eye), self.fwd)
    }

    /// The ray through a pixel, in unstretched world space: (origin, direction). The direction is
    /// not a unit vector when the phase axis is stretched; every user treats it as a parameterised
    /// line, which it is.
    pub fn ray(&self, p: Pos2) -> (V3, V3) {
        let xn = (p.x - self.shift.x) / self.focal;
        let yn = -(p.y - self.shift.y) / self.focal;
        let d = norm(add(self.fwd, add(scale(self.right, xn), scale(self.up, yn))));
        ([self.eye[0] / self.xs, self.eye[1], self.eye[2]], [d[0] / self.xs, d[1], d[2]])
    }

    /// The on-screen direction of "screen right" and "screen down" laid on the floor, as unit
    /// (x, z) vectors: how a pen's lean maps onto the terrain.
    fn ground_axes(&self) -> ([f32; 2], [f32; 2]) {
        let unit = |x: f32, z: f32| {
            let l = (x * x + z * z).sqrt().max(1.0e-6);
            [x / l, z / l]
        };
        // Screen directions live in stretched space; the table's are unstretched.
        let right = unit(self.right[0] / self.xs, self.right[2]);
        let toward = unit(-self.fwd[0] / self.xs, -self.fwd[2]);
        (right, toward)
    }
}

/// A point on the terrain: fractional frame, phase in cycles, and the height there (-1..1).
#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub frame: f32,
    pub phase: f32,
    pub value: f32,
    pub world: V3,
}

fn slab(o: V3, d: V3, min: V3, max: V3) -> Option<(f32, f32)> {
    let (mut t0, mut t1) = (0.0f32, f32::MAX);
    for i in 0..3 {
        if d[i].abs() < 1.0e-8 {
            if o[i] < min[i] || o[i] > max[i] {
                return None;
            }
        } else {
            let (a, b) = ((min[i] - o[i]) / d[i], (max[i] - o[i]) / d[i]);
            t0 = t0.max(a.min(b));
            t1 = t1.min(a.max(b));
        }
    }
    (t1 >= t0).then_some((t0, t1))
}

fn hit_at(h: &impl Heights, w: V3) -> Hit {
    let frame = frame_at_z(h.frames(), w[2]);
    let phase = (w[0] * 0.5 + 0.5).clamp(0.0, 1.0);
    Hit { frame, phase, value: h.value_at(frame, phase), world: w }
}

/// Where a ray meets the terrain surface, by marching through the slab that holds it and refining
/// the crossing. A ray that only meets the floor plane (y = 0) inside the slab hits that instead,
/// so flat parts can be painted too.
pub fn pick_surface(table: &impl Heights, o: V3, d: V3) -> Option<Hit> {
    let hs = HEIGHT_SCALE;
    // The surface is picked a hair thick on top. A ray aimed exactly at a knife-edge peak only
    // grazes it (the far flank falls away faster than the ray descends), and without this tolerance
    // the pick slips through to whatever is behind the peak, six frames away.
    const TOLERANCE: f32 = 0.008;
    let min = [-1.0, -hs * 1.02, -WORLD_DEPTH / 2.0];
    let max = [1.0, hs * 1.02, WORLD_DEPTH / 2.0];
    let (t0, t1) = slab(o, d, min, max)?;
    let above = |t: f32| {
        let p = add(o, scale(d, t));
        let frame = frame_at_z(table.frames(), p[2]);
        p[1] - table.value_at(frame, p[0] * 0.5 + 0.5) * hs - TOLERANCE
    };
    if above(t0) <= 0.0 {
        return Some(hit_at(table, add(o, scale(d, t0))));
    }
    let steps = 256;
    let dt = (t1 - t0) / steps as f32;
    let mut prev = t0;
    for i in 1..=steps {
        let t = t0 + dt * i as f32;
        if above(t) <= 0.0 {
            let (mut a, mut b) = (prev, t);
            for _ in 0..12 {
                let m = 0.5 * (a + b);
                if above(m) <= 0.0 { b = m } else { a = m }
            }
            return Some(hit_at(table, add(o, scale(d, 0.5 * (a + b)))));
        }
        prev = t;
    }
    plane_hit(table, o, d, 0.0, false)
}

/// Where a ray meets the horizontal plane `y = y0`. With `clamp` the point is pulled inside the
/// terrain's footprint, so a stroke dragged past the edge keeps working at the edge.
pub fn plane_hit(table: &impl Heights, o: V3, d: V3, y0: f32, clamp: bool) -> Option<Hit> {
    if d[1].abs() < 1.0e-5 {
        return None;
    }
    let t = (y0 - o[1]) / d[1];
    if t <= 0.0 {
        return None;
    }
    let mut p = add(o, scale(d, t));
    let inside = p[0].abs() <= 1.0 && p[2].abs() <= WORLD_DEPTH / 2.0;
    if !inside {
        if !clamp {
            return None;
        }
        p[0] = p[0].clamp(-1.0, 1.0);
        p[2] = p[2].clamp(-WORLD_DEPTH / 2.0, WORLD_DEPTH / 2.0);
    }
    Some(hit_at(table, p))
}

// ------------------------------------------------------------------------------------------
// Tools, options, events
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewTool {
    Brush(BrushTool),
    /// Drag turns the camera instead of sculpting.
    Orbit,
}

impl ViewTool {
    pub fn name(self) -> &'static str {
        match self {
            ViewTool::Brush(b) => b.name(),
            ViewTool::Orbit => "orbit",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        if name == "orbit" { Some(ViewTool::Orbit) } else { BrushTool::from_name(name).map(ViewTool::Brush) }
    }
}

const TOOL_PILLS: [(ViewTool, &str); 5] = [
    (ViewTool::Brush(BrushTool::Raise), "Raise"),
    (ViewTool::Brush(BrushTool::Lower), "Lower"),
    (ViewTool::Brush(BrushTool::Smooth), "Smooth"),
    (ViewTool::Brush(BrushTool::Level), "Level"),
    (ViewTool::Orbit, "Orbit"),
];

#[derive(Clone, Debug)]
pub struct WavetableOptions {
    pub width: Option<f32>,
    /// Total height: terrain, the cycle and harmonics strip, and the keys when shown.
    pub height: f32,
    pub tool: ViewTool,
    /// Brush radius, world units.
    pub radius: f32,
    /// 0..1.
    pub strength: f32,
    /// The selected frame, which the cycle strip and harmonics show and edit.
    pub frame: usize,
    pub keyboard: bool,
    pub first_key: u8,
    pub key_octaves: u8,
    /// Notes to draw as held, beyond the one the pointer is pressing (a latched or sequenced note).
    pub held: Vec<u8>,
}

impl Default for WavetableOptions {
    fn default() -> Self {
        Self {
            width: None,
            height: 620.0,
            tool: ViewTool::Brush(BrushTool::Raise),
            radius: 0.16,
            strength: 0.5,
            frame: 0,
            keyboard: true,
            first_key: 48,
            key_octaves: 3,
            held: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum WavetableEvent {
    /// A sculpting stroke began (a good moment to start an audition note).
    StrokeBegan,
    StrokeEnded,
    /// The table changed for good: a stroke or a pen stroke ended, or an undo or redo. Save now.
    Edited,
    FrameSelected(usize),
    ToolSelected(ViewTool),
    KeyDown { midi: u8, velocity: f32 },
    KeyUp { midi: u8 },
}

#[derive(Clone, Debug)]
pub struct HoverInfo {
    pub frame: f32,
    pub phase: f32,
    pub value: f32,
}

#[derive(Clone, Debug)]
pub struct WavetableResponse {
    pub rect: Rect,
    pub terrain: Rect,
    pub cycle: Rect,
    pub harmonics: Rect,
    pub keys: Rect,
    pub rail: Rect,
    pub pills: Vec<(String, Rect)>,
    pub key_rects: Vec<(u8, Rect, bool)>,
    pub projector: Projector,
    pub camera: Camera,
    pub events: Vec<WavetableEvent>,
    pub hover: Option<HoverInfo>,
    /// True while a sculpting stroke is in progress.
    pub sculpting: bool,
}

impl WavetableResponse {
    /// The pixel of table cell (`frame`, `phase`) on the terrain surface.
    pub fn cell(&self, table: &Wavetable, frame: f32, phase: f32) -> Option<Pos2> {
        let w = [Wavetable::world_x(phase), table.value_at(frame, phase) * HEIGHT_SCALE, table.world_z(frame)];
        self.projector.project(w).map(|(p, _)| p)
    }

    /// The pixel of table cell (`frame`, `phase`) at height `value`, wherever the surface is.
    pub fn cell_at(&self, table: &Wavetable, frame: f32, phase: f32, value: f32) -> Option<Pos2> {
        self.projector.project([Wavetable::world_x(phase), value * HEIGHT_SCALE, table.world_z(frame)]).map(|(p, _)| p)
    }

    pub fn pill(&self, label: &str) -> Option<Rect> {
        self.pills.iter().find(|(l, _)| l == label).map(|(_, r)| *r)
    }

    /// The pixel in the cycle strip for a phase (0..1) and a value (-1..1).
    pub fn cycle_point(&self, phase: f32, value: f32) -> Pos2 {
        let r = cycle_inner(self.cycle);
        pos2(r.min.x + phase * r.width(), r.center().y - value * r.height() * 0.5)
    }

    pub fn key(&self, midi: u8) -> Option<Rect> {
        self.key_rects.iter().find(|(m, _, _)| *m == midi).map(|(_, r, _)| *r)
    }
}

// ------------------------------------------------------------------------------------------
// Sculpting maths (pure, and used by the tests)
// ------------------------------------------------------------------------------------------

/// How much one moment of brushing changes the surface: strength, pressure and time, so a stroke is
/// the same at 30 and 144 frames per second.
pub fn brush_amount(strength: f32, pressure: f32, dt: f32) -> f32 {
    strength.clamp(0.0, 1.0) * BRUSH_RATE * pressure.clamp(0.0, 1.0) * dt.clamp(0.0, 0.1)
}

/// A brush footprint for the pen's lean: (aspect, angle in the table's phase/frame plane).
/// Upright (or no tilt) is round. Leaning stretches the dab along the lean by up to 3.2x.
pub fn tilt_footprint(tilt_x: f32, tilt_y: f32, proj: &Projector) -> (f32, f32) {
    let mag = (tilt_x * tilt_x + tilt_y * tilt_y).sqrt();
    if mag < 4.0 {
        return (1.0, 0.0);
    }
    let aspect = 1.0 + (mag / 60.0).clamp(0.0, 1.0) * 2.2;
    let (right, toward) = proj.ground_axes();
    // Screen +x is `right` on the floor; screen +y (down, toward the user) is `toward`.
    let (nx, ny) = (tilt_x / mag, tilt_y / mag);
    let dir = [right[0] * nx + toward[0] * ny, right[1] * nx + toward[1] * ny];
    // Frames run toward -z, so a world dz of `d` is a table dz of `-d`.
    (aspect, (-dir[1]).atan2(dir[0]))
}

/// The dabs that carry the brush from `from` to `to` (each a (frame, phase) pair) in one moment,
/// spaced a fraction of the radius apart, sharing the moment's total `amount` between them.
pub fn stroke_stamps(table: &Wavetable, tool: BrushTool, from: (f32, f32), to: (f32, f32), radius: f32, aspect: f32, angle: f32, amount: f32, target: f32) -> Vec<Stamp> {
    let pitch = table.frame_pitch();
    let (dx, dz) = ((to.1 - from.1) * WORLD_WIDTH, (to.0 - from.0) * pitch);
    let len = (dx * dx + dz * dz).sqrt();
    let n = ((len / (radius * 0.3)).ceil() as usize).clamp(1, 48);
    (0..n)
        .map(|i| {
            let t = if n == 1 { 1.0 } else { (i + 1) as f32 / n as f32 };
            let mut s = Stamp::new(tool, from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
            s.radius = radius;
            s.aspect = aspect;
            s.angle = angle;
            s.amount = amount / n as f32;
            s.target = target;
            s
        })
        .collect()
}

/// Sizes of the first `count` harmonics of a frame, as amplitude (a unit sine reads 1.0).
pub fn harmonic_amplitudes(frame: &[f32], count: usize) -> Vec<f32> {
    static SIN: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();
    let sin = SIN.get_or_init(|| (0..TABLE_SIZE).map(|i| (2.0 * PI * i as f32 / TABLE_SIZE as f32).sin()).collect());
    let mask = TABLE_SIZE - 1;
    (1..=count)
        .map(|h| {
            let (mut re, mut im) = (0.0f32, 0.0f32);
            for (n, v) in frame.iter().enumerate() {
                let k = (h * n) & mask;
                re += v * sin[(k + TABLE_SIZE / 4) & mask];
                im += v * sin[k];
            }
            2.0 * (re * re + im * im).sqrt() / TABLE_SIZE as f32
        })
        .collect()
}

// ------------------------------------------------------------------------------------------
// Drawing helpers
// ------------------------------------------------------------------------------------------

/// A stroke along `pts` as a triangle strip, coloured per point: cheaper than a tessellated path
/// and it lets a ridge brighten toward its crests.
fn ribbon(painter: &Painter, pts: &[Pos2], width: f32, color_at: impl Fn(usize) -> [f32; 4]) {
    let n = pts.len();
    if n < 2 || width <= 0.0 {
        return;
    }
    let seg = |a: Pos2, b: Pos2| {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l = (dx * dx + dy * dy).sqrt().max(1.0e-6);
        (dx / l, dy / l)
    };
    let mut verts = Vec::with_capacity(n * 2);
    let mut idx = Vec::with_capacity(n * 6);
    let half = width * 0.5;
    for i in 0..n {
        let a = if i > 0 { seg(pts[i - 1], pts[i]) } else { seg(pts[0], pts[1]) };
        let b = if i + 1 < n { seg(pts[i], pts[i + 1]) } else { a };
        let (mut tx, mut ty) = (a.0 + b.0, a.1 + b.1);
        let tl = (tx * tx + ty * ty).sqrt();
        if tl < 1.0e-4 {
            tx = a.0;
            ty = a.1;
        } else {
            tx /= tl;
            ty /= tl;
        }
        let (nx, ny) = (-ty, tx);
        // Miter, limited so a sharp turn does not spike.
        let m = 1.0 / (nx * -a.1 + ny * a.0).abs().max(0.55);
        let c = color_at(i);
        verts.push(Vertex::new(pts[i].x + nx * half * m, pts[i].y + ny * half * m, 0.0, c));
        verts.push(Vertex::new(pts[i].x - nx * half * m, pts[i].y - ny * half * m, 0.0, c));
        if i > 0 {
            let k = (i * 2) as u32;
            idx.extend([k - 2, k - 1, k, k - 1, k + 1, k]);
        }
    }
    painter.mesh(verts, idx);
}

/// The band between `top` and `bottom` (same length), coloured per column.
fn band(painter: &Painter, top: &[Pos2], bottom: &[Pos2], top_color: impl Fn(usize) -> [f32; 4], bottom_color: impl Fn(usize) -> [f32; 4]) {
    let n = top.len().min(bottom.len());
    if n < 2 {
        return;
    }
    let mut verts = Vec::with_capacity(n * 2);
    let mut idx = Vec::with_capacity(n * 6);
    for i in 0..n {
        verts.push(Vertex::new(top[i].x, top[i].y, 0.0, top_color(i)));
        verts.push(Vertex::new(bottom[i].x, bottom[i].y, 0.0, bottom_color(i)));
        if i > 0 {
            let k = (i * 2) as u32;
            idx.extend([k - 2, k - 1, k, k - 1, k + 1, k]);
        }
    }
    painter.mesh(verts, idx);
}

fn text(painter: &Painter, p: Pos2, align: Align2, s: impl ToString, size: f32, color: Color32) -> Rect {
    painter.text(p, align, s, FontId::proportional(size), color)
}

fn panel(painter: &Painter, rect: Rect) {
    painter.rect_filled_gradient(rect, PANEL_TOP, PANEL_TOP, PANEL_BOTTOM, PANEL_BOTTOM);
    painter.rect_stroke(rect, 6u8, Stroke::new(1.0, Color32::from_white_alpha(30)), StrokeKind::Middle);
}

// ------------------------------------------------------------------------------------------
// State kept between frames
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Drag {
    Orbit,
    Sculpt { plane_y: f32, target: f32, last: (f32, f32), tool: BrushTool },
    Rail,
    Cycle { last: (f32, f32) },
    Key { midi: u8 },
}

struct ViewState {
    camera: Camera,
    drag: Option<Drag>,
    last_pointer: Option<Pos2>,
    harmonics: Vec<f32>,
    harmonics_for: (u64, usize),
    /// Smoothed glow of the live position ridge.
    glow: f32,
    /// The surface as it was when the current sculpting stroke began (see `Surface`).
    stroke_surface: Option<Surface>,
}

impl Default for ViewState {
    fn default() -> Self {
        Self { camera: Camera::default(), drag: None, last_pointer: None, harmonics: Vec::new(), harmonics_for: (u64::MAX, usize::MAX), glow: 0.0, stroke_surface: None }
    }
}

// ------------------------------------------------------------------------------------------
// The widget
// ------------------------------------------------------------------------------------------

pub struct WavetableView {
    id: Id,
    opts: WavetableOptions,
}

struct Layout {
    terrain: Rect,
    cycle: Rect,
    harmonics: Rect,
    keys: Rect,
    rail: Rect,
}

fn layout(rect: Rect, opts: &WavetableOptions) -> Layout {
    let gap = 8.0;
    let keys_h = if opts.keyboard { 74.0 } else { 0.0 };
    let strip_h = 116.0;
    let keys = Rect::from_min_max(pos2(rect.min.x, rect.max.y - keys_h), rect.max);
    let strip_bottom = if opts.keyboard { keys.min.y - gap } else { rect.max.y };
    let strip_top = strip_bottom - strip_h;
    let terrain = Rect::from_min_max(rect.min, pos2(rect.max.x, (strip_top - gap).max(rect.min.y + 120.0)));
    let split = rect.min.x + rect.width() * 0.62;
    let cycle = Rect::from_min_max(pos2(rect.min.x, strip_top), pos2(split - gap * 0.5, strip_bottom));
    let harmonics = Rect::from_min_max(pos2(split + gap * 0.5, strip_top), pos2(rect.max.x, strip_bottom));
    let rail = Rect::from_min_max(pos2(terrain.max.x - 34.0, terrain.min.y + 62.0), pos2(terrain.max.x - 10.0, terrain.max.y - 30.0));
    Layout { terrain, cycle, harmonics, keys, rail }
}

/// Keys from `first` for `octaves` octaves and one more C: (note, rect, is_black).
pub fn key_layout(first: u8, octaves: u8, rect: Rect) -> Vec<(u8, Rect, bool)> {
    const WHITE: [bool; 12] = [true, false, true, false, true, true, false, true, false, true, false, true];
    let last = first as u32 + octaves as u32 * 12;
    let whites = (first as u32..=last).filter(|m| WHITE[(*m % 12) as usize]).count().max(1);
    let kw = rect.width() / whites as f32;
    let mut out = Vec::new();
    let mut white_index = 0usize;
    let mut blacks = Vec::new();
    for m in first as u32..=last {
        if WHITE[(m % 12) as usize] {
            let x0 = rect.min.x + white_index as f32 * kw;
            out.push((m as u8, Rect::from_min_max(pos2(x0, rect.min.y), pos2(x0 + kw, rect.max.y)), false));
            white_index += 1;
        } else {
            let boundary = rect.min.x + white_index as f32 * kw;
            blacks.push((m as u8, Rect::from_min_max(pos2(boundary - kw * 0.3, rect.min.y), pos2(boundary + kw * 0.3, rect.min.y + rect.height() * 0.6)), true));
        }
    }
    out.extend(blacks);
    out
}

/// The key under `p`, black keys first since they sit on top.
fn key_at(keys: &[(u8, Rect, bool)], p: Pos2) -> Option<(u8, Rect)> {
    keys.iter().filter(|k| k.2).chain(keys.iter().filter(|k| !k.2)).find(|k| k.1.contains(p)).map(|k| (k.0, k.1))
}

impl WavetableView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("wavetable_view").with(id_salt), opts: WavetableOptions::default() }
    }

    pub fn options(mut self, opts: WavetableOptions) -> Self {
        self.opts = opts;
        self
    }

    pub fn show(self, ui: &mut Ui, table: &mut Wavetable) -> WavetableResponse {
        let ctx = ui.ctx().clone();
        let o = self.opts;
        let width = o.width.unwrap_or_else(|| ui.available_size().x.max(360.0));
        let (resp, painter) = ui.allocate_painter(vec2(width, o.height.max(360.0)), Sense::click_and_drag());
        let rect = resp.rect;
        let lay = layout(rect, &o);
        let frames = table.frames();
        let sel = o.frame.min(frames - 1);

        let (pointer, scroll, mods, dt) = ctx.input(|i| (i.pointer, i.scroll_delta.y, i.modifiers, i.dt));
        let mut st: ViewState = ctx.memory_mut(|m| m.take_view_state(self.id));
        let mut events: Vec<WavetableEvent> = Vec::new();
        let pos = pointer.pos;

        // --- geometry the pointer needs before anything is drawn ---
        let pills = pill_rects(&ctx, &lay.terrain, &o, table);
        let key_rects = if o.keyboard { key_layout(o.first_key, o.key_octaves, lay.keys) } else { Vec::new() };
        let over = |r: Rect| pos.is_some_and(|p| r.contains(p));
        let pill_under = pos.and_then(|p| pills.iter().find(|(_, r, _)| r.contains(p)).map(|(l, _, _)| l.clone()));

        // Wheel zoom over the terrain.
        if over(lay.terrain) && scroll.abs() > 0.0 && st.drag.is_none() {
            st.camera.zoom = (st.camera.zoom * (scroll * 0.0016).exp()).clamp(0.6, 2.6);
        }

        let pen = pointer.pen;
        let pressure = pen.map(|p| p.pressure).unwrap_or(MOUSE_PRESSURE);
        let mut proj = Projector::new(&st.camera, lay.terrain);
        let mut sculpting = false;

        // --- start of a gesture ---
        let started_primary = pointer.primary_pressed;
        let started_secondary = pointer.secondary_pressed;
        if st.drag.is_none() && (started_primary || started_secondary) {
            if let Some(p) = pos {
                if started_primary && pill_under.is_some() {
                    // Buttons act on press; the press is consumed so it cannot also start a stroke.
                    let label = pill_under.clone().unwrap_or_default();
                    match label.as_str() {
                        "Undo" => {
                            if table.undo() {
                                events.push(WavetableEvent::Edited);
                            }
                        }
                        "Redo" => {
                            if table.redo() {
                                events.push(WavetableEvent::Edited);
                            }
                        }
                        "Top" => st.camera = Camera::top_view(),
                        "Front" => st.camera = Camera::front_view(),
                        "3D" => st.camera = Camera::default(),
                        other => {
                            if let Some((tool, _)) = TOOL_PILLS.iter().find(|(_, l)| *l == other) {
                                events.push(WavetableEvent::ToolSelected(*tool));
                            }
                        }
                    }
                } else if started_primary && lay.rail.expand(8.0).contains(p) {
                    st.drag = Some(Drag::Rail);
                } else if lay.terrain.contains(p) {
                    let orbit = started_secondary || mods.alt || o.tool == ViewTool::Orbit || pen.is_some_and(|p| p.barrel);
                    if orbit {
                        st.drag = Some(Drag::Orbit);
                    } else if let ViewTool::Brush(base) = o.tool {
                        let (origin, dir) = proj.ray(p);
                        if let Some(hit) = pick_surface(table, origin, dir) {
                            let tool = effective_tool(base, mods.shift, mods.ctrl, pen.is_some_and(|p| p.eraser));
                            st.stroke_surface = Some(Surface::of(table));
                            table.begin_edit();
                            st.drag = Some(Drag::Sculpt { plane_y: hit.world[1], target: hit.value, last: (hit.frame, hit.phase), tool });
                            events.push(WavetableEvent::StrokeBegan);
                            let f = hit.frame.round() as usize;
                            if f != sel {
                                events.push(WavetableEvent::FrameSelected(f.min(frames - 1)));
                            }
                        }
                    }
                } else if started_primary && lay.cycle.contains(p) {
                    table.begin_edit();
                    let (ph, v) = cycle_value(&lay.cycle, p);
                    let (a, b) = table.draw_segment(sel, ph, v, ph, v, 0.0);
                    table.commit(a, b);
                    st.drag = Some(Drag::Cycle { last: (ph, v) });
                } else if started_primary && o.keyboard && lay.keys.contains(p) {
                    if let Some((midi, kr)) = key_at(&key_rects, p) {
                        let velocity = pen.map(|p| p.pressure.max(0.2)).unwrap_or(0.35 + 0.65 * ((p.y - kr.min.y) / kr.height()).clamp(0.0, 1.0));
                        events.push(WavetableEvent::KeyDown { midi, velocity });
                        st.drag = Some(Drag::Key { midi });
                    }
                }
            }
        }

        // --- an active gesture ---
        let still_down = pointer.primary_down || pointer.secondary_down;
        if let Some(drag) = st.drag {
            match drag {
                Drag::Orbit => {
                    if let (Some(p), Some(last)) = (pos, st.last_pointer) {
                        st.camera.orbit(p.x - last.x, p.y - last.y);
                    }
                }
                Drag::Rail => {
                    if let Some(p) = pos {
                        let t = ((p.y - lay.rail.min.y) / lay.rail.height()).clamp(0.0, 1.0);
                        // Frame 0 is at the front, which is the bottom of the rail.
                        let f = ((1.0 - t) * (frames - 1) as f32).round() as usize;
                        if f != sel {
                            events.push(WavetableEvent::FrameSelected(f));
                        }
                    }
                }
                Drag::Sculpt { plane_y, target, last, tool } => {
                    let cur = pos.and_then(|p| {
                        let (origin, dir) = proj.ray(p);
                        // Aim at the surface as it was when the stroke began; past its edge, at the
                        // plane through the first touch.
                        let surface = st.stroke_surface.as_ref();
                        surface.and_then(|s| pick_surface(s, origin, dir)).or_else(|| plane_hit(table, origin, dir, plane_y, true)).map(|h| (h.frame, h.phase))
                    });
                    if let Some(cur) = cur.filter(|_| still_down) {
                        let (aspect, angle) = match pen {
                            Some(pn) if pn.has_tilt => tilt_footprint(pn.tilt_x, pn.tilt_y, &proj),
                            _ => (1.0, 0.0),
                        };
                        let radius = o.radius.clamp(0.04, 0.6) * (0.7 + 0.3 * pressure);
                        let amount = brush_amount(o.strength, pressure, dt);
                        let mut range: Option<(usize, usize)> = None;
                        for s in stroke_stamps(table, tool, last, cur, radius, aspect, angle, amount, target) {
                            if let Some((a, b)) = table.stamp(&s) {
                                range = Some(range.map_or((a, b), |(x, y)| (x.min(a), y.max(b))));
                            }
                        }
                        if let Some((a, b)) = range {
                            table.commit(a, b);
                        }
                        st.drag = Some(Drag::Sculpt { plane_y, target, last: cur, tool });
                    }
                    sculpting = still_down;
                }
                Drag::Cycle { last } => {
                    if let (Some(p), true) = (pos, still_down) {
                        let cur = cycle_value(&lay.cycle, p);
                        let (a, b) = table.draw_segment(sel, last.0, last.1, cur.0, cur.1, 0.0);
                        table.commit(a, b);
                        st.drag = Some(Drag::Cycle { last: cur });
                    }
                }
                Drag::Key { midi } => {
                    if let (Some(p), true) = (pos, still_down) {
                        if let Some((m2, kr)) = key_at(&key_rects, p) {
                            if m2 != midi {
                                events.push(WavetableEvent::KeyUp { midi });
                                let velocity = pen.map(|p| p.pressure.max(0.2)).unwrap_or(0.35 + 0.65 * ((p.y - kr.min.y) / kr.height()).clamp(0.0, 1.0));
                                events.push(WavetableEvent::KeyDown { midi: m2, velocity });
                                st.drag = Some(Drag::Key { midi: m2 });
                            }
                        }
                    }
                }
            }
            // --- end of a gesture ---
            if !still_down {
                match drag {
                    Drag::Sculpt { .. } => {
                        table.end_edit();
                        st.stroke_surface = None;
                        events.push(WavetableEvent::StrokeEnded);
                        events.push(WavetableEvent::Edited);
                    }
                    Drag::Cycle { .. } => {
                        table.end_edit();
                        events.push(WavetableEvent::Edited);
                    }
                    Drag::Key { midi } => events.push(WavetableEvent::KeyUp { midi }),
                    _ => {}
                }
                st.drag = None;
            }
        }
        st.last_pointer = pos;
        // The orbit above may have changed the camera; draw with the new one.
        proj = Projector::new(&st.camera, lay.terrain);

        // Hover pick, for the cursor ring and the readout.
        let hover_hit = match (pos, st.drag) {
            (Some(p), None) if over(lay.terrain) && pill_under.is_none() && !lay.rail.expand(8.0).contains(p) => {
                let (origin, dir) = proj.ray(p);
                pick_surface(table, origin, dir)
            }
            (Some(p), Some(Drag::Sculpt { plane_y, .. })) => {
                let (origin, dir) = proj.ray(p);
                st.stroke_surface.as_ref().and_then(|s| pick_surface(s, origin, dir)).or_else(|| plane_hit(table, origin, dir, plane_y, true))
            }
            _ => None,
        };

        // Harmonics of the selected frame, recomputed only when it changes.
        if st.harmonics_for != (table.revision(), sel) {
            st.harmonics = harmonic_amplitudes(table.frame(sel), 48);
            st.harmonics_for = (table.revision(), sel);
        }
        let activity = table.shared().activity();
        st.glow += (activity.map(|(_, e)| (e * 6.0).min(1.0)).unwrap_or(0.0) - st.glow) * 0.25;

        // --- paint ---
        let held_by_pointer = match st.drag {
            Some(Drag::Key { midi }) => Some(midi),
            _ => None,
        };
        draw_terrain(&painter, table, &proj, lay.terrain, sel, activity.map(|(p, _)| p), st.glow, ctx.time());
        draw_cursor(&painter, table, &proj, lay.terrain, &o, hover_hit, st.drag.is_some(), pressure, pen.map(|p| (p.tilt_x, p.tilt_y, p.has_tilt)));
        draw_toolbar(&painter, &pills, &o, table, pill_under.as_deref());
        draw_rail(&painter, lay.rail, frames, sel, activity.map(|(p, _)| p));
        if let Some(h) = hover_hit {
            text(&painter.with_clip_rect(lay.terrain), pos2(lay.terrain.min.x + 12.0, lay.terrain.max.y - 10.0), Align2::LEFT_BOTTOM, format!("frame {}   phase {:.2}   {:+.2}", h.frame.round() as usize + 1, h.phase, h.value), 10.5, LABEL);
        } else {
            text(&painter.with_clip_rect(lay.terrain), pos2(lay.terrain.min.x + 12.0, lay.terrain.max.y - 10.0), Align2::LEFT_BOTTOM, format!("frame {} of {}", sel + 1, frames), 10.5, LABEL);
        }
        draw_cycle(&painter, table, lay.cycle, sel, st.drag.is_some_and(|d| matches!(d, Drag::Cycle { .. })));
        draw_harmonics(&painter, lay.harmonics, &st.harmonics, sel, frames);
        if o.keyboard {
            draw_keys(&painter, &key_rects, held_by_pointer, &o.held);
        }

        let camera = st.camera;
        ctx.memory_mut(|m| m.put_view_state(self.id, st));
        WavetableResponse {
            rect,
            terrain: lay.terrain,
            cycle: lay.cycle,
            harmonics: lay.harmonics,
            keys: lay.keys,
            rail: lay.rail,
            pills: pills.iter().map(|(l, r, _)| (l.clone(), *r)).collect(),
            key_rects,
            projector: proj,
            camera,
            events,
            hover: hover_hit.map(|h| HoverInfo { frame: h.frame, phase: h.phase, value: h.value }),
            sculpting,
        }
    }
}

/// Shift inverts raise and lower (for a mouse), Ctrl smooths, and a pen's eraser end inverts.
fn effective_tool(base: BrushTool, shift: bool, ctrl: bool, eraser: bool) -> BrushTool {
    if ctrl {
        return BrushTool::Smooth;
    }
    if shift || eraser {
        return match base {
            BrushTool::Raise => BrushTool::Lower,
            BrushTool::Lower => BrushTool::Raise,
            other => other,
        };
    }
    base
}

/// Where the wave is drawn inside the cycle strip: clear of the label along the top.
pub fn cycle_inner(cycle: Rect) -> Rect {
    Rect::from_min_max(pos2(cycle.min.x + 6.0, cycle.min.y + 22.0), pos2(cycle.max.x - 6.0, cycle.max.y - 8.0))
}

/// The phase and value a pointer position means in the cycle strip.
fn cycle_value(cycle: &Rect, p: Pos2) -> (f32, f32) {
    let r = cycle_inner(*cycle);
    (((p.x - r.min.x) / r.width()).clamp(0.0, 0.999), (1.0 - 2.0 * (p.y - r.min.y) / r.height()).clamp(-1.0, 1.0))
}

// ------------------------------------------------------------------------------------------
// Toolbar
// ------------------------------------------------------------------------------------------

/// The toolbar's buttons and where they are: (label, rect, on the right side). Tools and the view
/// presets from the left, undo and redo from the right.
fn pill_rects(ctx: &crate::entropy_gui::context::Context, terrain: &Rect, _o: &WavetableOptions, _table: &Wavetable) -> Vec<(String, Rect, bool)> {
    let h = 24.0;
    let top = terrain.min.y + 10.0;
    let mut out = Vec::new();
    let mut x = terrain.min.x + 12.0;
    for (_, label) in TOOL_PILLS {
        let w = Painter::measure_text(ctx, FontId::proportional(11.5), label).x + 20.0;
        out.push((label.to_string(), Rect::from_min_size(pos2(x, top), vec2(w, h)), false));
        x += w + 5.0;
    }
    x += 10.0;
    for label in ["3D", "Top", "Front"] {
        let w = Painter::measure_text(ctx, FontId::proportional(11.5), label).x + 16.0;
        out.push((label.to_string(), Rect::from_min_size(pos2(x, top), vec2(w, h)), false));
        x += w + 4.0;
    }
    let mut rx = terrain.max.x - 12.0;
    for label in ["Redo", "Undo"] {
        let w = Painter::measure_text(ctx, FontId::proportional(11.5), label).x + 20.0;
        rx -= w;
        out.push((label.to_string(), Rect::from_min_size(pos2(rx, top), vec2(w, h)), true));
        rx -= 5.0;
    }
    out
}

fn draw_toolbar(painter: &Painter, pills: &[(String, Rect, bool)], o: &WavetableOptions, table: &Wavetable, hovered: Option<&str>) {
    for (label, r, _) in pills {
        let active = TOOL_PILLS.iter().any(|(t, l)| l == label && *t == o.tool);
        let disabled = (label == "Undo" && !table.can_undo()) || (label == "Redo" && !table.can_redo());
        let hot = hovered == Some(label.as_str()) && !disabled;
        if active {
            painter.rect_filled(r.expand(3.0), 10u8, c32(TEAL, 0.16));
            painter.rect_filled(*r, 8u8, c32(mix3(TEAL, VIOLET, 0.25), 0.92));
        } else {
            painter.rect_filled(*r, 8u8, Color32::from_rgba_unmultiplied(20, 22, 42, if hot { 235 } else { 190 }));
            painter.rect_stroke(*r, 8u8, Stroke::new(1.0, Color32::from_white_alpha(if hot { 70 } else { 34 })), StrokeKind::Middle);
        }
        let color = if active { Color32::from_rgb(8, 12, 24) } else if disabled { Color32::from_rgb(78, 84, 108) } else { LABEL_BRIGHT };
        text(painter, r.center(), Align2::CENTER, label, 11.5, color);
    }
}

fn draw_rail(painter: &Painter, rail: Rect, frames: usize, sel: usize, live: Option<f32>) {
    let x = rail.center().x;
    painter.line_segment([pos2(x, rail.min.y), pos2(x, rail.max.y)], Stroke::new(1.0, Color32::from_white_alpha(34)));
    let y_of = |f: f32| rail.max.y - f / (frames - 1) as f32 * rail.height();
    for f in 0..frames {
        let major = f % 4 == 0 || f == frames - 1;
        let y = y_of(f as f32);
        let len = if major { 6.0 } else { 3.0 };
        painter.line_segment([pos2(x - len, y), pos2(x + len, y)], Stroke::new(1.0, Color32::from_white_alpha(if major { 56 } else { 26 })));
    }
    let c = ramp(sel as f32 / (frames - 1) as f32);
    let y = y_of(sel as f32);
    painter.circle_filled(pos2(x, y), 9.0, c32(c, 0.18));
    painter.circle_filled(pos2(x, y), 5.0, c32(mix3(c, [1.0, 1.0, 1.0], 0.35), 1.0));
    if let Some(p) = live {
        let y = y_of(p * (frames - 1) as f32);
        painter.line_segment([pos2(x - 10.0, y), pos2(x + 10.0, y)], Stroke::new(2.0, c32(AMBER, 0.95)));
    }
    text(painter, pos2(x, rail.min.y - 8.0), Align2::CENTER_BOTTOM, "FRAME", 9.0, LABEL);
}

// ------------------------------------------------------------------------------------------
// Terrain
// ------------------------------------------------------------------------------------------

struct Ridge {
    frame: f32,
    depth: f32,
    live: bool,
}

fn draw_terrain(painter: &Painter, table: &Wavetable, proj: &Projector, rect: Rect, sel: usize, live_pos: Option<f32>, glow: f32, time: f32) {
    let painter = painter.with_clip_rect(rect);
    let frames = table.frames();
    // Backdrop: a deep vertical gradient with a soft bloom rising from behind the terrain.
    painter.rect_filled_gradient(rect, c32(BG_TOP, 1.0), c32(BG_TOP, 1.0), c32(BG_BOTTOM, 1.0), c32(BG_BOTTOM, 1.0));
    painter.rect_stroke(rect, 6u8, Stroke::new(1.0, Color32::from_white_alpha(30)), StrokeKind::Middle);
    let bloom_c = pos2(rect.center().x, rect.min.y + rect.height() * 0.42);
    for i in 0..9 {
        let t = i as f32 / 8.0;
        let r = rect.width() * (0.10 + 0.34 * t);
        painter.circle_filled(bloom_c, r, c32(mix3(VIOLET, TEAL, 0.3), 0.010 * (1.0 - t * 0.6)));
    }

    let hs = HEIGHT_SCALE;
    let mut ridges: Vec<Ridge> = (0..frames).map(|f| Ridge { frame: f as f32, depth: proj.depth([0.0, 0.0, table.world_z(f as f32)]), live: false }).collect();
    if let Some(p) = live_pos {
        let f = p.clamp(0.0, 1.0) * (frames - 1) as f32;
        ridges.push(Ridge { frame: f, depth: proj.depth([0.0, 0.0, table.world_z(f)]) + 1.0e-3, live: true });
    }
    let (dmin, dmax) = ridges.iter().fold((f32::MAX, f32::MIN), |(a, b), r| (a.min(r.depth), b.max(r.depth)));
    ridges.sort_by(|a, b| b.depth.partial_cmp(&a.depth).unwrap_or(std::cmp::Ordering::Equal));

    let bg = |y: f32| bg_at(((y - rect.min.y) / rect.height()).clamp(0.0, 1.0));
    let mut live_line: Option<Vec<Pos2>> = None;

    for ridge in &ridges {
        let z = table.world_z(ridge.frame);
        let mut top = Vec::with_capacity(RIDGE_POINTS + 1);
        let mut base = Vec::with_capacity(RIDGE_POINTS + 1);
        let mut vals = Vec::with_capacity(RIDGE_POINTS + 1);
        for i in 0..=RIDGE_POINTS {
            let phase = i as f32 / RIDGE_POINTS as f32;
            let v = table.value_at(ridge.frame, phase);
            let x = Wavetable::world_x(phase);
            let (Some((a, _)), Some((b, _))) = (proj.project([x, v * hs, z]), proj.project([x, -hs * 1.04, z])) else { continue };
            top.push(a);
            base.push(b);
            vals.push(v);
        }
        if top.len() < 2 {
            continue;
        }
        let t = ridge.frame / (frames - 1) as f32;
        let fog = 1.0 - 0.5 * ((ridge.depth - dmin) / (dmax - dmin).max(1.0e-3));
        let is_sel = !ridge.live && ridge.frame.round() as usize == sel && ridge.frame.fract() == 0.0;
        let colour = if ridge.live { AMBER } else { ramp(t) };

        // 1. The opaque curtain that hides what is behind this ridge, in the backdrop's own colours.
        band(&painter, &top, &base, |i| rgba(bg(top[i].y), 1.0), |i| rgba(bg(base[i].y), 1.0));
        // 2. A tinted wash just under the crest, stronger where the wave is high.
        let wash = 30.0 * proj.focal_scale();
        let low: Vec<Pos2> = top.iter().zip(&base).map(|(a, b)| pos2(a.x, (a.y + wash).min(b.y.max(a.y)))).collect();
        band(
            &painter,
            &top,
            &low,
            |i| rgba(colour, (0.05 + 0.30 * vals[i].max(0.0)) * fog + if is_sel { 0.10 } else { 0.0 }),
            |_| rgba(colour, 0.0),
        );
        // 3. Glow, then the line itself, brightening toward crests.
        let (glow_w, core_w) = if is_sel { (11.0, 2.8) } else if ridge.live { (12.0, 2.4) } else { (5.0, 1.3) };
        let glow_a = if is_sel { 0.30 } else if ridge.live { 0.22 + 0.5 * glow } else { 0.08 * fog };
        ribbon(&painter, &top, glow_w, |i| rgba(mix3(colour, [1.0, 1.0, 1.0], 0.2), glow_a * (0.6 + 0.4 * vals[i].max(0.0))));
        ribbon(&painter, &top, core_w, |i| {
            let crest = vals[i].max(0.0).powf(1.4);
            let heat = if is_sel { 0.55 + 0.4 * crest } else if ridge.live { 0.1 + 0.2 * crest } else { 0.28 * crest };
            rgba(mix3(colour, [1.0, 1.0, 1.0], heat), if is_sel || ridge.live { 1.0 } else { (0.55 + 0.4 * vals[i].max(0.0)) * fog })
        });
        if ridge.live {
            live_line = Some(top.clone());
        }
    }
    // The live ridge shows through the ridges in front of it, faintly, so it is never lost.
    if let Some(line) = live_line {
        ribbon(&painter, &line, 1.2, |_| rgba(AMBER, 0.28 + 0.3 * glow));
    }
    // Faint scanning hint while nothing plays keeps the picture alive.
    let _ = time;

    // The phase axis along the front foot of the terrain: a line, ticks, and where a cycle begins,
    // is half way and ends.
    let foot = |phase: f32| proj.project([Wavetable::world_x(phase), -hs * 1.04, table.world_z(0.0)]).map(|(p, _)| p);
    let edge: Vec<Pos2> = (0..=16).filter_map(|i| foot(i as f32 / 16.0)).collect();
    ribbon(&painter, &edge, 1.0, |_| rgba(TEAL, 0.22));
    for (phase, label) in [(0.0f32, "0"), (0.25, "1/4"), (0.5, "1/2"), (0.75, "3/4"), (1.0, "1")] {
        if let Some(p) = foot(phase) {
            painter.line_segment([p, pos2(p.x, p.y + 5.0)], Stroke::new(1.0, Color32::from_white_alpha(60)));
            text(&painter, pos2(p.x, p.y + 7.0), Align2::CENTER_TOP, label, 9.0, Color32::from_rgb(92, 100, 128));
        }
    }
    if let (Some(a), Some(b)) = (foot(0.0), foot(1.0)) {
        text(&painter, pos2((a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + 20.0), Align2::CENTER_TOP, "PHASE", 9.0, LABEL);
    }
}

impl Projector {
    /// Roughly how many pixels a world unit spans at the terrain's middle: scales pixel-sized effects.
    fn focal_scale(&self) -> f32 {
        (self.focal / 260.0).clamp(0.5, 2.5)
    }
}

/// The brush cursor: a ring lying on the terrain, the shape and size of the footprint.
fn draw_cursor(painter: &Painter, table: &Wavetable, proj: &Projector, rect: Rect, o: &WavetableOptions, hit: Option<Hit>, dragging: bool, pressure: f32, pen: Option<(f32, f32, bool)>) {
    let ViewTool::Brush(_) = o.tool else { return };
    let Some(h) = hit else { return };
    let painter = painter.with_clip_rect(rect);
    let (aspect, angle) = match pen {
        Some((tx, ty, true)) => tilt_footprint(tx, ty, proj),
        _ => (1.0, 0.0),
    };
    let radius = o.radius.clamp(0.04, 0.6) * (0.7 + 0.3 * pressure);
    let (a, b) = (radius * aspect.sqrt(), radius / aspect.sqrt());
    let (sin_a, cos_a) = angle.sin_cos();
    let pitch = table.frame_pitch();
    let mut ring = Vec::new();
    for i in 0..=48 {
        let th = i as f32 / 48.0 * 2.0 * PI;
        let (u, v) = (a * th.cos(), b * th.sin());
        let (dx, dz) = (u * cos_a - v * sin_a, u * sin_a + v * cos_a);
        let phase = (h.phase + dx / WORLD_WIDTH).clamp(0.0, 1.0);
        let frame = (h.frame + dz / pitch).clamp(0.0, (table.frames() - 1) as f32);
        let w = [Wavetable::world_x(phase), table.value_at(frame, phase) * HEIGHT_SCALE + 0.004, table.world_z(frame)];
        if let Some((p, _)) = proj.project(w) {
            ring.push(p);
        }
    }
    let live = if dragging { 1.0 } else { 0.55 };
    ribbon(&painter, &ring, 6.0, |_| rgba([1.0, 1.0, 1.0], 0.10 * live));
    ribbon(&painter, &ring, 1.6, |_| rgba([1.0, 1.0, 1.0], 0.85 * live));
    if let Some((c, _)) = proj.project([h.world[0], table.value_at(h.frame, h.phase) * HEIGHT_SCALE + 0.004, h.world[2]]) {
        painter.circle_filled(c, if dragging { 2.0 + 3.0 * pressure } else { 2.0 }, c32([1.0, 1.0, 1.0], 0.9 * live));
    }
}

// ------------------------------------------------------------------------------------------
// The cycle strip, the harmonics and the keys
// ------------------------------------------------------------------------------------------

fn draw_cycle(painter: &Painter, table: &Wavetable, rect: Rect, sel: usize, active: bool) {
    panel(painter, rect);
    let painter = painter.with_clip_rect(rect);
    let inner = cycle_inner(rect);
    let frames = table.frames();
    let colour = ramp(sel as f32 / (frames - 1) as f32);
    // Grid: zero line, quarter lines in phase.
    painter.line_segment([pos2(inner.min.x, inner.center().y), pos2(inner.max.x, inner.center().y)], Stroke::new(1.0, Color32::from_white_alpha(44)));
    for q in 1..4 {
        let x = inner.min.x + inner.width() * q as f32 / 4.0;
        painter.line_segment([pos2(x, inner.min.y), pos2(x, inner.max.y)], Stroke::new(1.0, Color32::from_white_alpha(14)));
    }
    let pts_of = |f: usize| -> Vec<Pos2> {
        let n = (inner.width() as usize).clamp(64, 512);
        (0..=n).map(|i| {
            let ph = i as f32 / n as f32;
            pos2(inner.min.x + ph * inner.width(), inner.center().y - table.value_at(f as f32, ph) * inner.height() * 0.5)
        }).collect()
    };
    // Neighbours as ghosts, so a change can be judged against its context.
    for (d, a) in [(-1i32, 0.16f32), (1, 0.16)] {
        let f = sel as i32 + d;
        if f >= 0 && (f as usize) < frames {
            ribbon(&painter, &pts_of(f as usize), 1.2, |_| rgba(ramp(f as f32 / (frames - 1) as f32), a));
        }
    }
    let pts = pts_of(sel);
    let zero: Vec<Pos2> = pts.iter().map(|p| pos2(p.x, inner.center().y)).collect();
    band(&painter, &pts, &zero, |_| rgba(colour, 0.34), |_| rgba(colour, 0.02));
    ribbon(&painter, &pts, if active { 9.0 } else { 7.0 }, |_| rgba(colour, 0.14));
    ribbon(&painter, &pts, 1.8, |_| rgba(mix3(colour, [1.0, 1.0, 1.0], 0.35), 1.0));
    text(&painter, pos2(rect.min.x + 10.0, rect.min.y + 6.0), Align2::LEFT_TOP, format!("CYCLE  frame {}", sel + 1), 9.5, LABEL);
    text(&painter, pos2(rect.max.x - 10.0, rect.min.y + 6.0), Align2::RIGHT_TOP, "drag to draw", 9.5, Color32::from_rgb(84, 90, 116));
}

/// Where the harmonic bars are drawn inside the harmonics panel: 48 bars share this rect's width.
pub fn harmonics_plot(rect: Rect) -> Rect {
    let inner = rect.shrink2(vec2(10.0, 8.0));
    Rect::from_min_max(pos2(inner.min.x, inner.min.y + 12.0), pos2(inner.max.x, inner.max.y - 12.0))
}

fn draw_harmonics(painter: &Painter, rect: Rect, harmonics: &[f32], sel: usize, frames: usize) {
    panel(painter, rect);
    let painter = painter.with_clip_rect(rect);
    let plot = harmonics_plot(rect);
    let n = harmonics.len().max(1);
    let peak = harmonics.iter().cloned().fold(0.05f32, f32::max);
    let bw = plot.width() / n as f32;
    for (i, a) in harmonics.iter().enumerate() {
        let h = (a / peak).powf(0.6).clamp(0.0, 1.0) * plot.height();
        let x0 = plot.min.x + i as f32 * bw;
        let t = i as f32 / n as f32;
        let c = mix3(ramp(sel as f32 / (frames - 1) as f32), ramp(0.9), t * 0.6);
        let r = Rect::from_min_max(pos2(x0 + 0.5, plot.max.y - h), pos2(x0 + bw - 0.5, plot.max.y));
        painter.rect_filled_gradient(r, c32(mix3(c, [1.0, 1.0, 1.0], 0.3), 0.95), c32(mix3(c, [1.0, 1.0, 1.0], 0.3), 0.95), c32(c, 0.30), c32(c, 0.30));
    }
    painter.line_segment([pos2(plot.min.x, plot.max.y), pos2(plot.max.x, plot.max.y)], Stroke::new(1.0, Color32::from_white_alpha(40)));
    text(&painter, pos2(rect.min.x + 10.0, rect.min.y + 6.0), Align2::LEFT_TOP, "HARMONICS", 9.5, LABEL);
    for h in [1usize, 8, 16, 24, 32, 40, 48] {
        if h <= n {
            text(&painter, pos2(plot.min.x + (h as f32 - 0.5) * bw, rect.max.y - 4.0), Align2::CENTER_BOTTOM, h, 8.5, Color32::from_rgb(84, 90, 116));
        }
    }
}

fn is_black_key(midi: u8) -> bool {
    matches!(midi % 12, 1 | 3 | 6 | 8 | 10)
}

fn draw_keys(painter: &Painter, keys: &[(u8, Rect, bool)], pressed: Option<u8>, held: &[u8]) {
    let is_down = |m: u8| pressed == Some(m) || held.contains(&m);
    for (midi, r, black) in keys.iter().filter(|k| !k.2) {
        let down = is_down(*midi);
        let (top, bot) = if down { (mix3(TEAL, [1.0, 1.0, 1.0], 0.35), TEAL) } else { ([0.93, 0.94, 0.98], [0.70, 0.72, 0.80]) };
        let rr = r.shrink2(vec2(0.75, 0.0));
        painter.rect_filled_gradient(rr, c32(top, 1.0), c32(top, 1.0), c32(bot, 1.0), c32(bot, 1.0));
        painter.rect_stroke(rr, 2u8, Stroke::new(1.0, Color32::from_rgb(20, 22, 40)), StrokeKind::Middle);
        if midi % 12 == 0 {
            text(painter, pos2(rr.center().x, rr.max.y - 4.0), Align2::CENTER_BOTTOM, format!("C{}", *midi as i32 / 12 - 1), 9.0, Color32::from_rgb(70, 76, 100));
        }
    }
    for (midi, r, _) in keys.iter().filter(|k| k.2) {
        debug_assert!(is_black_key(*midi));
        let down = is_down(*midi);
        let (top, bot) = if down { (mix3(VIOLET, [1.0, 1.0, 1.0], 0.25), VIOLET) } else { ([0.12, 0.13, 0.20], [0.03, 0.03, 0.07]) };
        painter.rect_filled_gradient(*r, c32(top, 1.0), c32(top, 1.0), c32(bot, 1.0), c32(bot, 1.0));
        painter.rect_stroke(*r, 2u8, Stroke::new(1.0, Color32::from_rgb(4, 4, 10)), StrokeKind::Middle);
    }
}

// ------------------------------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pixel_on_a_cell_picks_that_cell() {
        let mut table = Wavetable::new(16);
        let mut s = Stamp::new(BrushTool::Raise, 8.0, 0.4);
        s.amount = 0.6;
        s.radius = 0.3;
        table.stamp(&s);
        let rect = Rect::from_min_size(pos2(0.0, 0.0), vec2(900.0, 420.0));
        let proj = Projector::new(&Camera::default(), rect);
        for &(frame, phase) in &[(8.0f32, 0.4f32), (5.0, 0.7), (12.0, 0.2), (2.0, 0.55)] {
            let w = [Wavetable::world_x(phase), table.value_at(frame, phase) * HEIGHT_SCALE, table.world_z(frame)];
            let (px, _) = proj.project(w).expect("on screen");
            let (o, d) = proj.ray(px);
            let hit = pick_surface(&table, o, d).expect("the ray meets the surface");
            assert!((hit.phase - phase).abs() < 0.02, "phase {} vs {}", hit.phase, phase);
            assert!((hit.frame - frame).abs() < 0.6, "frame {} vs {}", hit.frame, frame);
        }
    }

    #[test]
    fn the_picture_fits_the_rect() {
        let rect = Rect::from_min_size(pos2(10.0, 20.0), vec2(700.0, 380.0));
        for cam in [Camera::default(), Camera::top_view(), Camera::front_view(), Camera { yaw: 1.2, pitch: 0.4, ..Camera::default() }] {
            let proj = Projector::new(&cam, rect);
            for &x in &[-1.0f32, 1.0] {
                for &z in &[-WORLD_DEPTH / 2.0, WORLD_DEPTH / 2.0] {
                    let (p, _) = proj.project([x, 0.0, z]).unwrap();
                    assert!(rect.contains(p), "corner {p:?} is outside {rect:?} for {cam:?}");
                }
            }
        }
    }

    #[test]
    fn a_leaning_pen_maps_onto_the_terrain_the_way_it_leans() {
        let proj = Projector::new(&Camera { yaw: 0.0, pitch: 0.6, ..Camera::default() }, Rect::from_min_size(pos2(0.0, 0.0), vec2(900.0, 420.0)));
        let (a0, _) = tilt_footprint(0.0, 0.0, &proj);
        assert_eq!(a0, 1.0);
        // Leaning right, seen from the front: the long axis lies along the phase axis.
        let (aspect, angle) = tilt_footprint(40.0, 0.0, &proj);
        assert!(aspect > 2.0 && angle.abs() < 0.05, "aspect {aspect}, angle {angle}");
        // Leaning toward the user: the long axis lies across the frames.
        let (_, angle) = tilt_footprint(0.0, 40.0, &proj);
        assert!((angle.abs() - PI / 2.0).abs() < 0.05, "angle {angle}");
    }

    #[test]
    fn stamps_share_the_moment_and_follow_the_path() {
        let t = Wavetable::new(16);
        let s = stroke_stamps(&t, BrushTool::Raise, (2.0, 0.2), (10.0, 0.8), 0.15, 1.0, 0.0, 0.3, 0.0);
        assert!(s.len() > 4);
        let total: f32 = s.iter().map(|x| x.amount).sum();
        assert!((total - 0.3).abs() < 1.0e-4);
        assert!((s.last().unwrap().frame - 10.0).abs() < 1.0e-4 && (s.last().unwrap().phase - 0.8).abs() < 1.0e-4);
    }

    #[test]
    fn harmonic_amplitudes_read_a_known_wave() {
        let n = TABLE_SIZE;
        let f: Vec<f32> = (0..n).map(|i| 0.5 * (2.0 * PI * 3.0 * i as f32 / n as f32).sin() + 0.25 * (2.0 * PI * 5.0 * i as f32 / n as f32).sin()).collect();
        let a = harmonic_amplitudes(&f, 8);
        assert!((a[2] - 0.5).abs() < 0.01 && (a[4] - 0.25).abs() < 0.01 && a[0] < 0.01, "{a:?}");
    }

    #[test]
    fn keys_lay_out_in_order_with_black_keys_on_top() {
        let keys = key_layout(48, 2, Rect::from_min_size(pos2(0.0, 0.0), vec2(750.0, 70.0)));
        assert_eq!(keys.iter().filter(|k| !k.2).count(), 15);
        assert_eq!(keys.iter().filter(|k| k.2).count(), 10);
        let (m, _) = key_at(&keys, pos2(keys.iter().find(|k| k.0 == 49).unwrap().1.center().x, 10.0)).unwrap();
        assert_eq!(m, 49, "a press near the top of a black key hits the black key");
        let (m, _) = key_at(&keys, pos2(keys.iter().find(|k| k.0 == 49).unwrap().1.center().x, 60.0)).unwrap();
        assert_ne!(m, 49, "below the black key it is a white key");
    }
}

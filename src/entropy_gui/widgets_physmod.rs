//! `PhysModView`: a physically modeled bowed string, drawn the same neon-terrain way
//! `WavetableView` draws a table - glowing ridges, an orbiting camera, no attempt at photorealism.
//! Unlike the wavetable there is nothing to sculpt here: the data is `audio::physmod::PhysModShared`,
//! read-only from the widget's side, published by whatever `PhysModVoice` is currently sounding.
//!
//! Up to four strings are drawn side by side (like a wavetable's frames), nut on the left, bridge on
//! the right. The one currently sounding (`PhysModOptions::active_string`) glows and shows its live
//! cycle shape; the others sit dim, for context. Dragging inside the bowing zone (the bridge half of
//! the active string, where a real bow actually contacts) moves the bow: how far along that zone the
//! drag lands sets `bow_position`, and how close it lands to the string sets `bow_force` - this is a
//! 2D projection of "dragging the bow in 3D", not real ray-triangle picking against a mesh, which is
//! a deliberate simplification for phase 1 (see `PHYS_MOD_SYNTH.md`). The right mouse button, Alt, or
//! a pen's barrel button orbit the camera instead, the same convention `WavetableView` uses.

use crate::audio::physmod::{PhysModShared, SHAPE_POINTS};
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::Ui;

// ------------------------------------------------------------------------------------------
// Palette (matches WavetableView's neon terrain, not the same table but the same feel)
// ------------------------------------------------------------------------------------------

const BG_TOP: [f32; 3] = [0.028, 0.032, 0.070];
const BG_BOTTOM: [f32; 3] = [0.060, 0.050, 0.120];
const AMBER: [f32; 3] = [1.0, 0.78, 0.36];
const TEAL: [f32; 3] = [0.28, 0.90, 0.84];
const VIOLET: [f32; 3] = [0.58, 0.45, 1.0];
const DIM: [f32; 3] = [0.34, 0.34, 0.46];

/// How far the drawn string's displacement is exaggerated over what the loop's shape snapshot
/// actually holds - purely for legibility, per the vision doc's explicit license to exaggerate.
pub const DISPLAY_GAIN: f32 = 0.22;
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

// ------------------------------------------------------------------------------------------
// A small fixed-target 3D camera (no picking against a mesh - see the module doc)
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

/// World span: x in -1 (nut) .. 1 (bridge); z spreads the (up to 4) strings front to back.
const STRING_DEPTH: f32 = 1.1;
const HEIGHT_SCALE: f32 = 0.34;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub yaw: f32,
    pub pitch: f32,
    pub dist: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self { yaw: 0.30, pitch: 0.55, dist: 4.6 }
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

impl Projector {
    fn new(cam: &Camera, rect: Rect) -> Self {
        let (sy, cy) = cam.yaw.sin_cos();
        let (sp, cp) = cam.pitch.sin_cos();
        let eye = [cam.dist * cp * sy, cam.dist * sp, cam.dist * cp * cy];
        let fwd = norm(scale(eye, -1.0));
        let right = norm(cross(fwd, [0.0, 1.0, 0.0]));
        let up = cross(right, fwd);
        let mut p = Projector { eye, right, up, fwd, focal: 1.0, shift: pos2(0.0, 0.0) };
        let bounds = |p: &Projector| {
            let mut lo = pos2(f32::MAX, f32::MAX);
            let mut hi = pos2(f32::MIN, f32::MIN);
            for &x in &[-1.0f32, 1.0] {
                for &y in &[-HEIGHT_SCALE, HEIGHT_SCALE] {
                    for &z in &[-STRING_DEPTH / 2.0, STRING_DEPTH / 2.0] {
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

/// World z of string `i` of `n` (0 nearest the front/camera).
fn string_z(i: usize, n: usize) -> f32 {
    if n <= 1 {
        return 0.0;
    }
    (0.5 - i as f32 / (n - 1) as f32) * STRING_DEPTH
}

/// World x for a bow position (0.02..0.5, fraction of the string's length from the bridge).
pub fn bow_position_to_x(bow_position: f32) -> f32 {
    1.0 - bow_position.clamp(0.02, 0.5) * 2.0
}

/// The inverse of `bow_position_to_x`, for turning a drag back into a bow position.
pub fn x_to_bow_position(x: f32) -> f32 {
    ((1.0 - x) / 2.0).clamp(0.02, 0.5)
}

// ------------------------------------------------------------------------------------------
// Public options / events / response
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct PhysModOptions {
    pub height: f32,
    pub width: Option<f32>,
    pub strings: usize,
    pub active_string: Option<usize>,
    pub bow_position: f32,
    pub bow_force: f32,
    pub body_size: f32,
    pub keyboard: bool,
    pub first_key: u8,
    pub key_octaves: u8,
    pub held: Vec<u8>,
}

impl Default for PhysModOptions {
    fn default() -> Self {
        Self {
            height: 360.0,
            width: None,
            strings: MAX_STRINGS,
            active_string: None,
            bow_position: 0.15,
            bow_force: 0.5,
            body_size: 0.0,
            keyboard: true,
            first_key: 48,
            key_octaves: 2,
            held: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum PhysModEvent {
    /// A drag inside the bowing zone: the new bow position (already mapped to the 0.02..0.5 range
    /// `PhysModParams::bow_position` expects) and force, both read off the drag directly.
    BowDrag { position: f32, force: f32 },
    KeyDown { midi: u8, velocity: f32 },
    KeyUp { midi: u8 },
}

pub struct PhysModResponse {
    pub events: Vec<PhysModEvent>,
}

#[derive(Clone, Copy)]
enum Drag {
    Orbit,
    Bow,
    Key { midi: u8 },
}

struct ViewState {
    camera: Camera,
    drag: Option<Drag>,
    last_pointer: Option<Pos2>,
}

impl Default for ViewState {
    fn default() -> Self {
        Self { camera: Camera::default(), drag: None, last_pointer: None }
    }
}

fn key_layout(first: u8, octaves: u8, rect: Rect) -> Vec<(u8, Rect, bool)> {
    crate::entropy_gui::widgets_wavetable::key_layout(first, octaves, rect)
}

fn key_at(keys: &[(u8, Rect, bool)], p: Pos2) -> Option<(u8, Rect)> {
    keys.iter().find(|(_, r, _)| r.contains(p)).map(|(m, r, _)| (*m, *r))
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
        let n = opts.strings.clamp(1, MAX_STRINGS);

        let (pointer, mods) = ctx.input(|i| (i.pointer, i.modifiers));
        let mut st: ViewState = ctx.memory_mut(|m| m.take_view_state(self.id));
        let mut events: Vec<PhysModEvent> = Vec::new();
        let pos = pointer.pos;

        let key_h = if opts.keyboard { 64.0 } else { 0.0 };
        let terrain = Rect::from_min_max(rect.min, pos2(rect.max.x, rect.max.y - key_h));
        let key_rect = Rect::from_min_max(pos2(rect.min.x, rect.max.y - key_h), rect.max);
        let key_rects = if opts.keyboard { key_layout(opts.first_key, opts.key_octaves, key_rect) } else { Vec::new() };

        let started_primary = pointer.primary_pressed;
        let started_secondary = pointer.secondary_pressed;
        let pen = pointer.pen;
        if st.drag.is_none() && (started_primary || started_secondary) {
            if let Some(p) = pos {
                let orbit = started_secondary || mods.alt || pen.is_some_and(|pn| pn.barrel);
                if orbit && terrain.contains(p) {
                    st.drag = Some(Drag::Orbit);
                } else if started_primary && bowing_zone(&st.camera, terrain, opts, n).is_some_and(|z| z.contains(p)) {
                    st.drag = Some(Drag::Bow);
                    if let Some((position, force)) = bow_drag_value(&st.camera, terrain, opts, n, p) {
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
                        if let Some((position, force)) = bow_drag_value(&st.camera, terrain, opts, n, p) {
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

        for y in 0..24 {
            let t0 = y as f32 / 24.0;
            let t1 = (y + 1) as f32 / 24.0;
            let band = Rect::from_min_max(pos2(rect.min.x, rect.min.y + t0 * rect.height()), pos2(rect.max.x, rect.min.y + t1 * rect.height()));
            painter.rect_filled(band, 0u8, c32(bg_at((t0 + t1) * 0.5), 1.0));
        }

        let proj = Projector::new(&st.camera, terrain);
        let activity = shared.activity();
        draw_body_glow(&painter, &proj, opts.body_size, activity.map(|(_, _, _, e)| e).unwrap_or(0.0));
        for i in 0..n {
            let is_active = opts.active_string == Some(i);
            draw_string(&painter, &proj, i, n, is_active, shared, ctx.time());
        }
        if let Some(i) = opts.active_string {
            draw_bow(&painter, &proj, i, n, opts.bow_position, opts.bow_force);
        }
        if opts.keyboard {
            let keys = key_layout(opts.first_key, opts.key_octaves, key_rect);
            draw_keys(&painter, &keys, opts.held.as_slice());
        }

        ctx.memory_mut(|m| m.put_view_state(self.id, st));
        PhysModResponse { events }
    }
}

/// The screen-space segment of the bowing zone on the active string (the bridge half, x in 0..1).
fn bowing_zone(cam: &Camera, rect: Rect, opts: &PhysModOptions, n: usize) -> Option<Rect> {
    let i = opts.active_string?;
    let proj = Projector::new(cam, rect);
    let z = string_z(i, n);
    let a = proj.project([0.0, 0.0, z])?;
    let b = proj.project([1.0, 0.0, z])?;
    let pad = 24.0;
    Some(Rect::from_min_max(pos2(a.x.min(b.x) - pad, a.y.min(b.y) - pad), pos2(a.x.max(b.x) + pad, a.y.max(b.y) + pad)))
}

/// Projects a screen point onto the active string's bridge-half segment: position along it (world x,
/// 0..1) and perpendicular pixel distance, turned into force (closer = harder). `None` outside the
/// zone or when there is no active string.
fn bow_drag_value(cam: &Camera, rect: Rect, opts: &PhysModOptions, n: usize, p: Pos2) -> Option<(f32, f32)> {
    let zone = bowing_zone(cam, rect, opts, n)?;
    if !zone.contains(p) {
        return None;
    }
    let i = opts.active_string?;
    let proj = Projector::new(cam, rect);
    let z = string_z(i, n);
    let a = proj.project([0.0, 0.0, z])?;
    let b = proj.project([1.0, 0.0, z])?;
    let ab = pos2(b.x - a.x, b.y - a.y);
    let len2 = (ab.x * ab.x + ab.y * ab.y).max(1.0);
    let ap = pos2(p.x - a.x, p.y - a.y);
    let t = ((ap.x * ab.x + ap.y * ab.y) / len2).clamp(0.0, 1.0);
    let along = pos2(a.x + ab.x * t, a.y + ab.y * t);
    let dist = ((p.x - along.x).powi(2) + (p.y - along.y).powi(2)).sqrt();
    let force = (1.0 - (dist / 40.0)).clamp(0.0, 1.0);
    let position = x_to_bow_position(t);
    Some((position, force))
}

fn draw_string(painter: &Painter, proj: &Projector, i: usize, n: usize, active: bool, shared: &PhysModShared, time: f32) {
    let z = string_z(i, n);
    let points = 80;
    let mut screen = Vec::with_capacity(points + 1);
    for k in 0..=points {
        let t = k as f32 / points as f32;
        let x = -1.0 + 2.0 * t;
        let y = if active {
            let shape_t = t.clamp(0.0, 0.999) * SHAPE_POINTS as f32;
            let i0 = shape_t.floor() as usize;
            let frac = shape_t - i0 as f32;
            let a = shared.shape_at(i0.min(SHAPE_POINTS - 1));
            let b = shared.shape_at((i0 + 1).min(SHAPE_POINTS - 1));
            (a + (b - a) * frac) * DISPLAY_GAIN
        } else {
            0.0
        };
        if let Some(p) = proj.project([x, y, z]) {
            screen.push(p);
        }
    }
    if screen.len() < 2 {
        return;
    }
    let energy = shared.activity().map(|(_, _, _, e)| e).unwrap_or(0.0);
    let glow = if active { (0.35 + energy * 5.0).min(1.0) } else { 0.10 };
    let colour = if active { mix3(TEAL, AMBER, 0.5 + 0.5 * (time * 0.6).sin()) } else { DIM };
    let (glow_w, core_w) = if active { (10.0, 2.6) } else { (3.0, 1.0) };
    for w in screen.windows(2) {
        painter.line_segment([w[0], w[1]], Stroke::new(glow_w, c32(colour, glow * 0.35)));
    }
    for w in screen.windows(2) {
        painter.line_segment([w[0], w[1]], Stroke::new(core_w, c32(mix3(colour, [1.0, 1.0, 1.0], 0.3), if active { 0.9 } else { 0.35 })));
    }
}

fn draw_bow(painter: &Painter, proj: &Projector, i: usize, n: usize, position: f32, force: f32) {
    let z = string_z(i, n);
    let x = bow_position_to_x(position);
    let half = 0.14;
    let Some(top) = proj.project([x, HEIGHT_SCALE * 0.9, z - half]) else { return };
    let Some(bottom) = proj.project([x, -HEIGHT_SCALE * 0.9, z + half]) else { return };
    let glow = (0.3 + force.clamp(0.0, 1.0) * 0.7).min(1.0);
    painter.line_segment([top, bottom], Stroke::new(9.0, c32(VIOLET, glow * 0.35)));
    painter.line_segment([top, bottom], Stroke::new(2.4, c32(mix3(VIOLET, [1.0, 1.0, 1.0], 0.5), 0.9)));
}

fn draw_body_glow(painter: &Painter, proj: &Projector, body_size: f32, energy: f32) {
    let Some(centre) = proj.project([1.05, -HEIGHT_SCALE * 0.4, 0.0]) else { return };
    // `energy` is the voice's raw output magnitude, not a normalised 0..1 level - a loud note can
    // exceed 1, so it has to be clamped before it scales a pixel radius or a note played at gain
    // above unity balloons the glow across the whole widget.
    let e = energy.clamp(0.0, 1.0);
    let r = 18.0 + body_size.clamp(0.0, 1.0) * 22.0 + e * 26.0;
    painter.circle_filled(centre, r, c32(mix3(AMBER, VIOLET, body_size.clamp(0.0, 1.0)), 0.10 + e * 0.35));
}

fn draw_keys(painter: &Painter, keys: &[(u8, Rect, bool)], held: &[u8]) {
    for (midi, r, is_black) in keys {
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
        for &p in &[0.02f32, 0.1, 0.25, 0.5] {
            let x = bow_position_to_x(p);
            let back = x_to_bow_position(x);
            assert!((back - p).abs() < 1.0e-4, "{p} -> {x} -> {back}");
        }
    }

    #[test]
    fn bow_position_to_x_spans_bridge_to_middle() {
        assert!((bow_position_to_x(0.02) - 0.96).abs() < 1.0e-4);
        assert!((bow_position_to_x(0.5) - 0.0).abs() < 1.0e-4);
    }

    #[test]
    fn string_depths_are_evenly_spread_and_symmetric() {
        let zs: Vec<f32> = (0..4).map(|i| string_z(i, 4)).collect();
        assert!(zs[0] > zs[1] && zs[1] > zs[2] && zs[2] > zs[3]);
        assert!((zs[0] + zs[3]).abs() < 1.0e-5);
        assert!((zs[1] + zs[2]).abs() < 1.0e-5);
    }

    #[test]
    fn a_drag_near_the_active_string_reports_a_plausible_bow_value() {
        let cam = Camera::default();
        let rect = Rect::from_min_max(pos2(0.0, 0.0), pos2(800.0, 400.0));
        let opts = PhysModOptions { active_string: Some(0), strings: 4, ..Default::default() };
        let proj = Projector::new(&cam, rect);
        let z = string_z(0, 4);
        // A point right on the string, near the bridge end (x close to 1).
        let on_string = proj.project([0.9, 0.0, z]).expect("on screen");
        let (pos, force) = bow_drag_value(&cam, rect, &opts, 4, on_string).expect("inside the bowing zone");
        assert!(pos < 0.15, "near the bridge should read a small bow_position, got {pos}");
        assert!(force > 0.7, "a point on the string itself should read close to full force, got {force}");
    }

    #[test]
    fn a_drag_far_from_any_string_reports_nothing() {
        let cam = Camera::default();
        let rect = Rect::from_min_max(pos2(0.0, 0.0), pos2(800.0, 400.0));
        let opts = PhysModOptions { active_string: Some(0), strings: 4, ..Default::default() };
        assert!(bow_drag_value(&cam, rect, &opts, 4, pos2(4.0, 4.0)).is_none());
    }
}

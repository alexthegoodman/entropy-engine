//! `Chart3dView`: live 3D charts generalized from `WavetableView`'s terrain renderer,
//! driven by a 2D data grid or cell range.
//!
//! Three chart modes:
//! * **Surface.** 3D elevation terrain across series and categories, drawn back to front with
//!   opaque curtains under each ridge (painter's-order hidden-line removal) and neon crest glow.
//! * **Bar.** 3D columns/bars with directional face shading and crisp edges, depth-sorted
//!   back to front.
//! * **Ribbon.** Parallel 3D ribbon strips with distinct width and skirts falling to the floor.
//!
//! Controls:
//! * Drag rotates the orbit camera (yaw and pitch).
//! * Wheel zooms in and out.
//! * Toolbar pills switch chart type (Surface, Bar, Ribbon) and camera presets (3D, Top, Front, Reset).
//! * Hovering highlights the active item and displays series name, category, and value in a floating readout.

use std::f32::consts::PI;

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
const TEAL: [f32; 3] = [0.28, 0.90, 0.84];
const VIOLET: [f32; 3] = [0.58, 0.45, 1.0];
const PINK: [f32; 3] = [1.0, 0.38, 0.66];
const AMBER: [f32; 3] = [1.0, 0.78, 0.36];
const SKY: [f32; 3] = [0.45, 0.62, 1.0];
const ROSE: [f32; 3] = [1.0, 0.36, 0.42];
const LIME: [f32; 3] = [0.65, 0.95, 0.35];
const CORAL: [f32; 3] = [1.0, 0.55, 0.35];
const LABEL: Color32 = Color32::from_rgb(140, 148, 178);
const LABEL_BRIGHT: Color32 = Color32::from_rgb(210, 218, 242);
const FLOOR_GRID: Color32 = Color32::from_rgba_unmultiplied(70, 78, 114, 55);

const PALETTE: [[f32; 3]; 8] = [TEAL, VIOLET, PINK, AMBER, SKY, ROSE, LIME, CORAL];

pub const HEIGHT_SCALE: f32 = 0.55;
pub const WORLD_WIDTH: f32 = 2.0;
pub const WORLD_DEPTH: f32 = 1.8;

fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn rgba(c: [f32; 3], a: f32) -> [f32; 4] {
    [c[0], c[1], c[2], a.clamp(0.0, 1.0)]
}

fn c32(c: [f32; 3], a: f32) -> Color32 {
    Color32::from_rgba_f32([c[0], c[1], c[2], a.clamp(0.0, 1.0)])
}

fn bg_at(y_frac: f32) -> [f32; 3] {
    mix3(BG_TOP, BG_BOTTOM, y_frac)
}

pub fn series_color(index: usize, count: usize) -> [f32; 3] {
    if count <= 1 {
        TEAL
    } else if index < PALETTE.len() {
        PALETTE[index]
    } else {
        let t = index as f32 / (count - 1).max(1) as f32;
        if t < 0.5 {
            mix3(TEAL, VIOLET, t * 2.0)
        } else {
            mix3(VIOLET, PINK, (t - 0.5) * 2.0)
        }
    }
}

// ------------------------------------------------------------------------------------------
// 3D Geometry and Camera
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

/// An orbit camera around the center of the 3D chart.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Chart3dCamera {
    /// Yaw angle around the Y axis, in radians.
    pub yaw: f32,
    /// Pitch angle above the floor, in radians.
    pub pitch: f32,
    /// Distance from the center in world units.
    pub dist: f32,
    /// Magnification factor.
    pub zoom: f32,
}

impl Default for Chart3dCamera {
    fn default() -> Self {
        Self { yaw: 0.45, pitch: 0.55, dist: 5.0, zoom: 1.0 }
    }
}

impl Chart3dCamera {
    pub const PITCH_MIN: f32 = 0.08;
    pub const PITCH_MAX: f32 = 1.50;

    pub fn orbit(&mut self, dx: f32, dy: f32) {
        self.yaw += dx * 0.008;
        self.pitch = (self.pitch + dy * 0.008).clamp(Self::PITCH_MIN, Self::PITCH_MAX);
    }

    pub fn top_view() -> Self {
        Self { yaw: 0.0, pitch: Self::PITCH_MAX, dist: 5.0, zoom: 1.0 }
    }

    pub fn front_view() -> Self {
        Self { yaw: 0.0, pitch: 0.12, dist: 5.0, zoom: 1.0 }
    }

    pub fn isometric_view() -> Self {
        Self::default()
    }

    pub fn reset_view() -> Self {
        Self::default()
    }
}

/// Projects world points to screen pixels and pixels to rays.
#[derive(Clone, Copy, Debug)]
pub struct Chart3dProjector {
    eye: V3,
    right: V3,
    up: V3,
    fwd: V3,
    focal: f32,
    shift: Pos2,
    pub rect: Rect,
}

impl Chart3dProjector {
    pub fn new(cam: &Chart3dCamera, rect: Rect) -> Self {
        let (sy, cy) = cam.yaw.sin_cos();
        let (sp, cp) = cam.pitch.sin_cos();
        let eye = [cam.dist * cp * sy, cam.dist * sp, cam.dist * cp * cy];
        let fwd = norm(scale(eye, -1.0));
        let right = norm(cross(fwd, [0.0, 1.0, 0.0]));
        let up = cross(right, fwd);

        let mut p = Chart3dProjector {
            eye,
            right,
            up,
            fwd,
            focal: 1.0,
            shift: pos2(0.0, 0.0),
            rect,
        };

        // Determine bounding box of the chart domain in raw camera space
        let hs = HEIGHT_SCALE;
        let mut lo = pos2(f32::MAX, f32::MAX);
        let mut hi = pos2(f32::MIN, f32::MIN);
        let hw = WORLD_WIDTH * 0.55;
        let hd = WORLD_DEPTH * 0.55;

        for &x in &[-hw, hw] {
            for &y in &[0.0f32, hs * 1.1] {
                for &z in &[-hd, hd] {
                    if let Some((q, _)) = p.project_raw([x, y, z]) {
                        lo = pos2(lo.x.min(q.x), lo.y.min(q.y));
                        hi = pos2(hi.x.max(q.x), hi.y.max(q.y));
                    }
                }
            }
        }

        let avail = Rect::from_min_max(
            pos2(rect.min.x + 24.0, rect.min.y + 44.0),
            pos2(rect.max.x - 24.0, rect.max.y - 28.0),
        );
        let bw = (hi.x - lo.x).max(1.0e-3);
        let bh = (hi.y - lo.y).max(1.0e-3);
        p.focal = (avail.width() / bw).min(avail.height() / bh) * cam.zoom.clamp(0.4, 3.0) * 0.95;
        p.shift = pos2(
            avail.center().x - (lo.x + hi.x) * 0.5 * p.focal,
            avail.center().y - (lo.y + hi.y) * 0.5 * p.focal,
        );
        p
    }

    fn project_raw(&self, w: V3) -> Option<(Pos2, f32)> {
        let v = sub(w, self.eye);
        let depth = dot(v, self.fwd);
        if depth < 0.05 {
            return None;
        }
        Some((
            pos2(
                dot(v, self.right) / depth * self.focal + self.shift.x,
                -dot(v, self.up) / depth * self.focal + self.shift.y,
            ),
            depth,
        ))
    }

    pub fn project(&self, w: V3) -> Option<(Pos2, f32)> {
        self.project_raw(w)
    }

    pub fn depth(&self, w: V3) -> f32 {
        dot(sub(w, self.eye), self.fwd)
    }

    pub fn ray(&self, p: Pos2) -> (V3, V3) {
        let xn = (p.x - self.shift.x) / self.focal;
        let yn = -(p.y - self.shift.y) / self.focal;
        let d = norm(add(self.fwd, add(scale(self.right, xn), scale(self.up, yn))));
        (self.eye, d)
    }
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

// ------------------------------------------------------------------------------------------
// Drawing primitives
// ------------------------------------------------------------------------------------------

fn ribbon(painter: &Painter, pts: &[Pos2], width: f32, color_at: impl Fn(usize) -> [f32; 4]) {
    let n = pts.len();
    if n < 2 {
        return;
    }
    let half = width * 0.5;
    let mut verts = Vec::with_capacity(n * 2);
    let mut idx = Vec::with_capacity((n - 1) * 6);
    let seg = |a: Pos2, b: Pos2| {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l = (dx * dx + dy * dy).sqrt().max(1.0e-4);
        (dx / l, dy / l)
    };
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

fn band(painter: &Painter, top: &[Pos2], bottom: &[Pos2], top_color: impl Fn(usize) -> [f32; 4], bottom_color: impl Fn(usize) -> [f32; 4]) {
    let n = top.len().min(bottom.len());
    if n < 2 {
        return;
    }
    let mut verts = Vec::with_capacity(n * 2);
    let mut idx = Vec::with_capacity((n - 1) * 6);
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

fn quad(painter: &Painter, pts: [Pos2; 4], color: [f32; 4]) {
    let verts = vec![
        Vertex::new(pts[0].x, pts[0].y, 0.0, color),
        Vertex::new(pts[1].x, pts[1].y, 0.0, color),
        Vertex::new(pts[2].x, pts[2].y, 0.0, color),
        Vertex::new(pts[3].x, pts[3].y, 0.0, color),
    ];
    let idx = vec![0, 1, 2, 0, 2, 3];
    painter.mesh(verts, idx);
}

// ------------------------------------------------------------------------------------------
// Types and Options
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Chart3dType {
    #[default]
    Surface,
    Bar,
    Ribbon,
}

impl Chart3dType {
    pub fn name(self) -> &'static str {
        match self {
            Chart3dType::Surface => "Surface",
            Chart3dType::Bar => "Bar",
            Chart3dType::Ribbon => "Ribbon",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name.to_lowercase().as_str() {
            "surface" => Some(Chart3dType::Surface),
            "bar" => Some(Chart3dType::Bar),
            "ribbon" => Some(Chart3dType::Ribbon),
            _ => None,
        }
    }
}

/// One series of data in the 3D chart.
#[derive(Clone, Debug, PartialEq)]
pub struct Chart3dSeries {
    pub name: String,
    pub color: Option<Color32>,
    pub values: Vec<f32>,
}

impl Chart3dSeries {
    pub fn new(name: impl Into<String>, values: Vec<f32>) -> Self {
        Self { name: name.into(), color: None, values }
    }

    pub fn with_color(mut self, color: Color32) -> Self {
        self.color = Some(color);
        self
    }
}

#[derive(Clone, Debug)]
pub struct Chart3dOptions {
    pub chart_type: Chart3dType,
    pub title: Option<String>,
    pub x_labels: Vec<String>,
    pub width: Option<f32>,
    pub height: f32,
    pub y_min: Option<f32>,
    pub y_max: Option<f32>,
    pub show_toolbar: bool,
}

impl Default for Chart3dOptions {
    fn default() -> Self {
        Self {
            chart_type: Chart3dType::Surface,
            title: None,
            x_labels: Vec::new(),
            width: None,
            height: 380.0,
            y_min: None,
            y_max: None,
            show_toolbar: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Chart3dEvent {
    ChartTypeChanged(Chart3dType),
    Hovered {
        series: usize,
        x_idx: usize,
        value: f32,
    },
}

#[derive(Clone, Debug)]
pub struct Chart3dHover {
    pub series_index: usize,
    pub x_index: usize,
    pub series_name: String,
    pub x_label: String,
    pub value: f32,
    pub pos: Pos2,
}

#[derive(Clone, Debug)]
pub struct Chart3dResponse {
    pub rect: Rect,
    pub camera: Chart3dCamera,
    pub hover: Option<Chart3dHover>,
    pub events: Vec<Chart3dEvent>,
}

// ------------------------------------------------------------------------------------------
// Widget View State
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Chart3dState {
    camera: Chart3dCamera,
    chart_type: Chart3dType,
    is_orbiting: bool,
    last_pointer: Option<Pos2>,
}

impl Default for Chart3dState {
    fn default() -> Self {
        Self {
            camera: Chart3dCamera::default(),
            chart_type: Chart3dType::Surface,
            is_orbiting: false,
            last_pointer: None,
        }
    }
}

// ------------------------------------------------------------------------------------------
// Chart3dView Widget
// ------------------------------------------------------------------------------------------

pub struct Chart3dView {
    id: Id,
    options: Chart3dOptions,
}

impl Chart3dView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self {
            id: Id::new("chart_3d").with(id_salt),
            options: Chart3dOptions::default(),
        }
    }

    pub fn options(mut self, options: Chart3dOptions) -> Self {
        self.options = options;
        self
    }

    pub fn show(self, ui: &mut Ui, series: &[Chart3dSeries]) -> Chart3dResponse {
        let ctx = ui.ctx().clone();
        let opts = self.options;
        let width = opts.width.unwrap_or_else(|| ui.available_size().x.max(280.0));
        let (resp, painter) = ui.allocate_painter(vec2(width, opts.height.max(220.0)), Sense::click_and_drag());
        let rect = resp.rect;

        let (pointer, scroll) = ctx.input(|i| (i.pointer, i.scroll_delta.y));
        let mut st: Chart3dState = ctx.memory_mut(|m| m.take_view_state(self.id));
        let mut events: Vec<Chart3dEvent> = Vec::new();
        let pos = pointer.pos;

        // Toolbar pill rects
        let pills = toolbar_pills(&ctx, rect, &opts, st.chart_type);
        let pill_under = pos.and_then(|p| pills.iter().find(|(_, r)| r.contains(p)).map(|(l, _)| l.clone()));

        // Wheel zoom over chart
        let over_chart = pos.is_some_and(|p| rect.contains(p));
        if over_chart && scroll.abs() > 0.0 && !st.is_orbiting {
            st.camera.zoom = (st.camera.zoom * (scroll * 0.0016).exp()).clamp(0.5, 3.0);
        }

        // Toolbar pill clicks
        if pointer.primary_pressed {
            if let Some(ref label) = pill_under {
                match label.as_str() {
                    "Surface" => {
                        st.chart_type = Chart3dType::Surface;
                        events.push(Chart3dEvent::ChartTypeChanged(Chart3dType::Surface));
                    }
                    "Bar" => {
                        st.chart_type = Chart3dType::Bar;
                        events.push(Chart3dEvent::ChartTypeChanged(Chart3dType::Bar));
                    }
                    "Ribbon" => {
                        st.chart_type = Chart3dType::Ribbon;
                        events.push(Chart3dEvent::ChartTypeChanged(Chart3dType::Ribbon));
                    }
                    "3D" => st.camera = Chart3dCamera::isometric_view(),
                    "Top" => st.camera = Chart3dCamera::top_view(),
                    "Front" => st.camera = Chart3dCamera::front_view(),
                    "Reset" => st.camera = Chart3dCamera::reset_view(),
                    _ => {}
                }
            } else if over_chart {
                st.is_orbiting = true;
            }
        }

        if st.is_orbiting {
            if pointer.primary_down {
                if let (Some(cur), Some(prev)) = (pos, st.last_pointer) {
                    st.camera.orbit(cur.x - prev.x, cur.y - prev.y);
                }
            } else {
                st.is_orbiting = false;
            }
        }
        st.last_pointer = pos;

        let proj = Chart3dProjector::new(&st.camera, rect);

        // Compute data range
        let num_series = series.len();
        let max_x_len = series.iter().map(|s| s.values.len()).max().unwrap_or(0);

        let (mut val_min, mut val_max) = series.iter().flat_map(|s| &s.values).fold(
            (f32::MAX, f32::MIN),
            |(a, b), &v| (a.min(v), b.max(v)),
        );
        if val_min > val_max {
            val_min = 0.0;
            val_max = 1.0;
        }
        let val_min = opts.y_min.unwrap_or_else(|| if val_min >= 0.0 { 0.0 } else { val_min * 1.1 });
        let val_max = opts.y_max.unwrap_or_else(|| if val_max <= 0.0 { 0.0 } else { val_max * 1.15 }).max(val_min + 1.0e-4);

        // Normalize value to 0..1
        let norm_val = |v: f32| ((v - val_min) / (val_max - val_min)).clamp(0.0, 1.0);

        // Draw background and bloom
        draw_chart_backdrop(&painter, rect);

        // Draw floor grid and axis labels
        draw_floor_grid(&painter, &proj, series, &opts.x_labels, max_x_len, num_series, val_min, val_max);

        // Hover picking
        let mut hover_info: Option<Chart3dHover> = None;
        if over_chart && !st.is_orbiting && pill_under.is_none() {
            if let Some(mouse_p) = pos {
                let (ray_o, ray_d) = proj.ray(mouse_p);
                hover_info = pick_chart_item(&proj, ray_o, ray_d, series, &opts.x_labels, st.chart_type, norm_val);
            }
        }

        if let Some(ref h) = hover_info {
            events.push(Chart3dEvent::Hovered {
                series: h.series_index,
                x_idx: h.x_index,
                value: h.value,
            });
        }

        // Draw the 3D data by chart type
        let active_type = st.chart_type;
        match active_type {
            Chart3dType::Surface => {
                draw_surface(&painter, &proj, rect, series, max_x_len, norm_val, hover_info.as_ref());
            }
            Chart3dType::Bar => {
                draw_bars(&painter, &proj, rect, series, max_x_len, norm_val, hover_info.as_ref());
            }
            Chart3dType::Ribbon => {
                draw_ribbons(&painter, &proj, rect, series, max_x_len, norm_val, hover_info.as_ref());
            }
        }

        // Draw hover tooltip badge
        if let Some(ref h) = hover_info {
            draw_tooltip(&painter, rect, h);
        }

        // Draw top toolbar
        if opts.show_toolbar {
            draw_toolbar(&painter, &pills, opts.title.as_deref(), active_type, pill_under.as_deref());
        }

        let camera = st.camera;
        ctx.memory_mut(|m| m.put_view_state(self.id, st));

        Chart3dResponse {
            rect,
            camera,
            hover: hover_info,
            events,
        }
    }
}

// ------------------------------------------------------------------------------------------
// Coordinate mapping
// ------------------------------------------------------------------------------------------

fn world_coords(series_idx: usize, num_series: usize, x_idx: usize, num_x: usize, norm_v: f32) -> V3 {
    let half_w = WORLD_WIDTH * 0.45;
    let half_d = WORLD_DEPTH * 0.45;

    let x = if num_x <= 1 {
        0.0
    } else {
        -half_w + (x_idx as f32 / (num_x - 1) as f32) * (half_w * 2.0)
    };

    let z = if num_series <= 1 {
        0.0
    } else {
        -half_d + (series_idx as f32 / (num_series - 1) as f32) * (half_d * 2.0)
    };

    let y = norm_v * HEIGHT_SCALE;
    [x, y, z]
}

// ------------------------------------------------------------------------------------------
// Backdrop & Floor
// ------------------------------------------------------------------------------------------

fn draw_chart_backdrop(painter: &Painter, rect: Rect) {
    let p = painter.with_clip_rect(rect);
    p.rect_filled_gradient(rect, c32(BG_TOP, 1.0), c32(BG_TOP, 1.0), c32(BG_BOTTOM, 1.0), c32(BG_BOTTOM, 1.0));
    p.rect_stroke(rect, 6u8, Stroke::new(1.0, Color32::from_white_alpha(30)), StrokeKind::Middle);

    // Subtle soft glow bloom in center
    let center = pos2(rect.center().x, rect.min.y + rect.height() * 0.45);
    for i in 0..7 {
        let t = i as f32 / 6.0;
        let r = rect.width() * (0.12 + 0.30 * t);
        p.circle_filled(center, r, c32(mix3(VIOLET, TEAL, 0.25), 0.008 * (1.0 - t * 0.6)));
    }
}

fn draw_floor_grid(
    painter: &Painter,
    proj: &Chart3dProjector,
    series: &[Chart3dSeries],
    x_labels: &[String],
    num_x: usize,
    num_series: usize,
    val_min: f32,
    val_max: f32,
) {
    let half_w = WORLD_WIDTH * 0.48;
    let half_d = WORLD_DEPTH * 0.48;

    // Floor outline
    let corners = [
        [-half_w, 0.0, -half_d],
        [half_w, 0.0, -half_d],
        [half_w, 0.0, half_d],
        [-half_w, 0.0, half_d],
    ];

    let mut sc = Vec::new();
    for c in &corners {
        if let Some((p, _)) = proj.project(*c) {
            sc.push(p);
        }
    }
    if sc.len() == 4 {
        for i in 0..4 {
            painter.line_segment([sc[i], sc[(i + 1) % 4]], Stroke::new(1.0, Color32::from_white_alpha(45)));
        }
    }

    // Grid lines for categories along X
    if num_x > 1 {
        for i in 0..num_x {
            let frac = i as f32 / (num_x - 1) as f32;
            let x = -half_w + frac * (half_w * 2.0);
            if let (Some((p0, _)), Some((p1, _))) = (proj.project([x, 0.0, -half_d]), proj.project([x, 0.0, half_d])) {
                painter.line_segment([p0, p1], Stroke::new(1.0, FLOOR_GRID));
            }
            // Category label along front edge
            if let Some(label) = x_labels.get(i) {
                if let Some((lp, _)) = proj.project([x, 0.0, half_d + 0.12]) {
                    painter.text(lp, Align2::CENTER_TOP, label, FontId::proportional(9.0), LABEL);
                }
            }
        }
    }

    // Grid lines for series along Z
    if num_series > 1 {
        for s in 0..num_series {
            let frac = s as f32 / (num_series - 1) as f32;
            let z = -half_d + frac * (half_d * 2.0);
            if let (Some((p0, _)), Some((p1, _))) = (proj.project([-half_w, 0.0, z]), proj.project([half_w, 0.0, z])) {
                painter.line_segment([p0, p1], Stroke::new(1.0, FLOOR_GRID));
            }
            // Series name label along left edge
            if let Some(ser) = series.get(s) {
                if let Some((lp, _)) = proj.project([-half_w - 0.12, 0.0, z]) {
                    painter.text(lp, Align2::RIGHT_CENTER, &ser.name, FontId::proportional(9.0), LABEL);
                }
            }
        }
    }

    // Vertical value ticks on left back corner
    let corner_x = -half_w;
    let corner_z = -half_d;
    let hs = HEIGHT_SCALE;

    if let (Some((b, _)), Some((t, _))) = (proj.project([corner_x, 0.0, corner_z]), proj.project([corner_x, hs, corner_z])) {
        painter.line_segment([b, t], Stroke::new(1.0, Color32::from_white_alpha(50)));
        // Label min and max
        painter.text(pos2(b.x - 6.0, b.y), Align2::RIGHT_CENTER, format!("{:.0}", val_min), FontId::proportional(8.5), LABEL);
        painter.text(pos2(t.x - 6.0, t.y), Align2::RIGHT_CENTER, format!("{:.0}", val_max), FontId::proportional(8.5), LABEL);
    }
}

// ------------------------------------------------------------------------------------------
// 3D Rendering Modes
// ------------------------------------------------------------------------------------------

struct SeriesRidge {
    series_idx: usize,
    depth: f32,
}

fn draw_surface(
    painter: &Painter,
    proj: &Chart3dProjector,
    rect: Rect,
    series: &[Chart3dSeries],
    num_x: usize,
    norm_val: impl Fn(f32) -> f32,
    hover: Option<&Chart3dHover>,
) {
    if series.is_empty() || num_x < 2 {
        return;
    }
    let p = painter.with_clip_rect(rect);
    let num_series = series.len();

    // Sort series back to front by camera depth
    let mut ridges: Vec<SeriesRidge> = (0..num_series)
        .map(|s| {
            let center_w = world_coords(s, num_series, num_x / 2, num_x, 0.0);
            SeriesRidge {
                series_idx: s,
                depth: proj.depth(center_w),
            }
        })
        .collect();
    ridges.sort_by(|a, b| b.depth.partial_cmp(&a.depth).unwrap_or(std::cmp::Ordering::Equal));

    let bg = |y: f32| bg_at(((y - rect.min.y) / rect.height()).clamp(0.0, 1.0));

    for ridge in &ridges {
        let s_idx = ridge.series_idx;
        let ser = &series[s_idx];
        let color = ser.color.map(|c| [c.r() as f32 / 255.0, c.g() as f32 / 255.0, c.b() as f32 / 255.0])
            .unwrap_or_else(|| series_color(s_idx, num_series));

        let is_hovered = hover.map(|h| h.series_index == s_idx).unwrap_or(false);

        let mut top = Vec::with_capacity(num_x);
        let mut base = Vec::with_capacity(num_x);

        for x in 0..num_x {
            let raw_v = ser.values.get(x).copied().unwrap_or(0.0);
            let nv = norm_val(raw_v);
            let w_top = world_coords(s_idx, num_series, x, num_x, nv);
            let w_base = world_coords(s_idx, num_series, x, num_x, 0.0);

            if let (Some((pt, _)), Some((pb, _))) = (proj.project(w_top), proj.project(w_base)) {
                top.push(pt);
                base.push(pb);
            }
        }

        if top.len() < 2 {
            continue;
        }

        // 1. Opaque curtain in background gradient color for painter's-order hidden-line removal
        band(&p, &top, &base, |i| rgba(bg(top[i].y), 1.0), |i| rgba(bg(base[i].y), 1.0));

        // 2. Tinted wash under crest
        band(
            &p,
            &top,
            &base,
            |_| rgba(color, if is_hovered { 0.35 } else { 0.18 }),
            |_| rgba(color, 0.02),
        );

        // 3. Neon glow ribbon
        let glow_w = if is_hovered { 10.0 } else { 5.5 };
        let glow_a = if is_hovered { 0.40 } else { 0.16 };
        ribbon(&p, &top, glow_w, |_| rgba(color, glow_a));

        // 4. Bright core ridge line
        let core_w = if is_hovered { 2.4 } else { 1.5 };
        ribbon(&p, &top, core_w, |_| rgba(mix3(color, [1.0, 1.0, 1.0], if is_hovered { 0.5 } else { 0.25 }), 0.95));

        // Highlight marker if point is hovered
        if let Some(h) = hover {
            if h.series_index == s_idx && h.x_index < top.len() {
                let hp = top[h.x_index];
                p.circle_filled(hp, 6.0, c32(color, 0.35));
                p.circle_filled(hp, 3.5, Color32::WHITE);
            }
        }
    }
}

struct Bar3dItem {
    series_idx: usize,
    x_idx: usize,
    value: f32,
    depth: f32,
    center_w: V3,
    half_size: V3,
    color: [f32; 3],
}

fn draw_bars(
    painter: &Painter,
    proj: &Chart3dProjector,
    rect: Rect,
    series: &[Chart3dSeries],
    num_x: usize,
    norm_val: impl Fn(f32) -> f32,
    hover: Option<&Chart3dHover>,
) {
    if series.is_empty() || num_x == 0 {
        return;
    }
    let p = painter.with_clip_rect(rect);
    let num_series = series.len();

    let bar_w = (WORLD_WIDTH * 0.70 / num_x.max(1) as f32).min(0.22);
    let bar_d = (WORLD_DEPTH * 0.70 / num_series.max(1) as f32).min(0.22);

    let mut bars = Vec::new();

    for (s_idx, ser) in series.iter().enumerate() {
        let color = ser.color.map(|c| [c.r() as f32 / 255.0, c.g() as f32 / 255.0, c.b() as f32 / 255.0])
            .unwrap_or_else(|| series_color(s_idx, num_series));

        for x in 0..num_x {
            let raw_v = ser.values.get(x).copied().unwrap_or(0.0);
            let nv = norm_val(raw_v);
            let h = nv * HEIGHT_SCALE;
            let center = world_coords(s_idx, num_series, x, num_x, nv * 0.5);

            let depth = proj.depth(center);
            bars.push(Bar3dItem {
                series_idx: s_idx,
                x_idx: x,
                value: raw_v,
                depth,
                center_w: center,
                half_size: [bar_w * 0.42, h * 0.5, bar_d * 0.42],
                color,
            });
        }
    }

    // Sort bars back to front
    bars.sort_by(|a, b| b.depth.partial_cmp(&a.depth).unwrap_or(std::cmp::Ordering::Equal));

    for bar in &bars {
        let is_hovered = hover.map(|h| h.series_index == bar.series_idx && h.x_index == bar.x_idx).unwrap_or(false);
        let c = bar.center_w;
        let hs = bar.half_size;
        let base_c = bar.color;

        // 8 vertices of the bar cuboid
        let v = [
            [c[0] - hs[0], c[1] - hs[1], c[2] - hs[2]], // 0: bottom-left-back
            [c[0] + hs[0], c[1] - hs[1], c[2] - hs[2]], // 1: bottom-right-back
            [c[0] + hs[0], c[1] - hs[1], c[2] + hs[2]], // 2: bottom-right-front
            [c[0] - hs[0], c[1] - hs[1], c[2] + hs[2]], // 3: bottom-left-front
            [c[0] - hs[0], c[1] + hs[1], c[2] - hs[2]], // 4: top-left-back
            [c[0] + hs[0], c[1] + hs[1], c[2] - hs[2]], // 5: top-right-back
            [c[0] + hs[0], c[1] + hs[1], c[2] + hs[2]], // 6: top-right-front
            [c[0] - hs[0], c[1] + hs[1], c[2] + hs[2]], // 7: top-left-front
        ];

        let mut pts = [Pos2::default(); 8];
        let mut visible = true;
        for i in 0..8 {
            if let Some((pt, _)) = proj.project(v[i]) {
                pts[i] = pt;
            } else {
                visible = false;
                break;
            }
        }
        if !visible {
            continue;
        }

        // Shading: light from top-front-right
        let top_color = rgba(mix3(base_c, [1.0, 1.0, 1.0], if is_hovered { 0.6 } else { 0.35 }), 0.95);
        let front_color = rgba(mix3(base_c, [1.0, 1.0, 1.0], if is_hovered { 0.4 } else { 0.15 }), 0.90);
        let side_color = rgba(mix3(base_c, [0.0, 0.0, 0.0], if is_hovered { 0.1 } else { 0.30 }), 0.85);

        // Faces: Front (3,2,6,7), Right (2,1,5,6), Top (4,5,6,7)
        // Draw sides first, then top
        quad(&p, [pts[3], pts[2], pts[6], pts[7]], front_color);
        quad(&p, [pts[2], pts[1], pts[5], pts[6]], side_color);
        quad(&p, [pts[4], pts[5], pts[6], pts[7]], top_color);

        // Highlight stroke
        let stroke_c = if is_hovered {
            Color32::WHITE
        } else {
            c32(mix3(base_c, [1.0, 1.0, 1.0], 0.2), 0.5)
        };
        let stroke_w = if is_hovered { 1.8 } else { 1.0 };

        // Top edges
        p.line_segment([pts[4], pts[5]], Stroke::new(stroke_w, stroke_c));
        p.line_segment([pts[5], pts[6]], Stroke::new(stroke_w, stroke_c));
        p.line_segment([pts[6], pts[7]], Stroke::new(stroke_w, stroke_c));
        p.line_segment([pts[7], pts[4]], Stroke::new(stroke_w, stroke_c));
        // Vertical front edges
        p.line_segment([pts[3], pts[7]], Stroke::new(stroke_w, stroke_c));
        p.line_segment([pts[2], pts[6]], Stroke::new(stroke_w, stroke_c));
    }
}

fn draw_ribbons(
    painter: &Painter,
    proj: &Chart3dProjector,
    rect: Rect,
    series: &[Chart3dSeries],
    num_x: usize,
    norm_val: impl Fn(f32) -> f32,
    hover: Option<&Chart3dHover>,
) {
    if series.is_empty() || num_x < 2 {
        return;
    }
    let p = painter.with_clip_rect(rect);
    let num_series = series.len();
    let ribbon_hw = (WORLD_DEPTH * 0.35 / num_series.max(1) as f32).clamp(0.03, 0.12);

    let mut ridges: Vec<SeriesRidge> = (0..num_series)
        .map(|s| {
            let center_w = world_coords(s, num_series, num_x / 2, num_x, 0.0);
            SeriesRidge {
                series_idx: s,
                depth: proj.depth(center_w),
            }
        })
        .collect();
    ridges.sort_by(|a, b| b.depth.partial_cmp(&a.depth).unwrap_or(std::cmp::Ordering::Equal));

    for ridge in &ridges {
        let s_idx = ridge.series_idx;
        let ser = &series[s_idx];
        let color = ser.color.map(|c| [c.r() as f32 / 255.0, c.g() as f32 / 255.0, c.b() as f32 / 255.0])
            .unwrap_or_else(|| series_color(s_idx, num_series));
        let is_hovered = hover.map(|h| h.series_index == s_idx).unwrap_or(false);

        let mut top_front = Vec::with_capacity(num_x);
        let mut top_back = Vec::with_capacity(num_x);
        let mut base_front = Vec::with_capacity(num_x);

        for x in 0..num_x {
            let raw_v = ser.values.get(x).copied().unwrap_or(0.0);
            let nv = norm_val(raw_v);
            let center = world_coords(s_idx, num_series, x, num_x, nv);

            let pt_front = [center[0], center[1], center[2] + ribbon_hw];
            let pt_back = [center[0], center[1], center[2] - ribbon_hw];
            let pb_front = [center[0], 0.0, center[2] + ribbon_hw];

            if let (Some((qf, _)), Some((qb, _)), Some((qbf, _))) = (
                proj.project(pt_front),
                proj.project(pt_back),
                proj.project(pb_front),
            ) {
                top_front.push(qf);
                top_back.push(qb);
                base_front.push(qbf);
            }
        }

        if top_front.len() < 2 {
            continue;
        }

        // Top ribbon surface
        band(
            &p,
            &top_front,
            &top_back,
            |_| rgba(mix3(color, [1.0, 1.0, 1.0], if is_hovered { 0.4 } else { 0.2 }), 0.90),
            |_| rgba(mix3(color, [0.0, 0.0, 0.0], 0.15), 0.85),
        );

        // Skirt falling to the floor
        band(
            &p,
            &top_front,
            &base_front,
            |_| rgba(color, if is_hovered { 0.35 } else { 0.20 }),
            |_| rgba(color, 0.02),
        );

        // Crest glowing line
        ribbon(&p, &top_front, if is_hovered { 2.4 } else { 1.5 }, |_| {
            rgba(mix3(color, [1.0, 1.0, 1.0], if is_hovered { 0.6 } else { 0.3 }), 0.95)
        });
    }
}

// ------------------------------------------------------------------------------------------
// Picking & Readout
// ------------------------------------------------------------------------------------------

fn pick_chart_item(
    proj: &Chart3dProjector,
    ray_o: V3,
    ray_d: V3,
    series: &[Chart3dSeries],
    x_labels: &[String],
    chart_type: Chart3dType,
    norm_val: impl Fn(f32) -> f32,
) -> Option<Chart3dHover> {
    let num_series = series.len();
    let num_x = series.iter().map(|s| s.values.len()).max().unwrap_or(0);
    if num_series == 0 || num_x == 0 {
        return None;
    }

    let mut closest_hit: Option<(f32, usize, usize, f32)> = None;

    match chart_type {
        Chart3dType::Bar => {
            let bar_w = (WORLD_WIDTH * 0.70 / num_x as f32).min(0.22);
            let bar_d = (WORLD_DEPTH * 0.70 / num_series as f32).min(0.22);
            let hs_x = bar_w * 0.42;
            let hs_z = bar_d * 0.42;

            for (s_idx, ser) in series.iter().enumerate() {
                for x in 0..num_x {
                    let v = ser.values.get(x).copied().unwrap_or(0.0);
                    let nv = norm_val(v);
                    let h = nv * HEIGHT_SCALE;
                    let c = world_coords(s_idx, num_series, x, num_x, 0.0);
                    let min = [c[0] - hs_x, 0.0, c[2] - hs_z];
                    let max = [c[0] + hs_x, h, c[2] + hs_z];

                    if let Some((t0, _)) = slab(ray_o, ray_d, min, max) {
                        if t0 > 0.0 && (closest_hit.is_none() || t0 < closest_hit.unwrap().0) {
                            closest_hit = Some((t0, s_idx, x, v));
                        }
                    }
                }
            }
        }
        Chart3dType::Surface | Chart3dType::Ribbon => {
            // Find closest 3D data point to the ray
            for (s_idx, ser) in series.iter().enumerate() {
                for x in 0..num_x {
                    let v = ser.values.get(x).copied().unwrap_or(0.0);
                    let nv = norm_val(v);
                    let pt = world_coords(s_idx, num_series, x, num_x, nv);

                    // Distance from point to ray
                    let v_to_p = sub(pt, ray_o);
                    let t = dot(v_to_p, ray_d);
                    if t > 0.0 {
                        let closest_pt_on_ray = add(ray_o, scale(ray_d, t));
                        let dist_sq = dot(sub(pt, closest_pt_on_ray), sub(pt, closest_pt_on_ray));
                        if dist_sq < 0.04 && (closest_hit.is_none() || t < closest_hit.unwrap().0) {
                            closest_hit = Some((t, s_idx, x, v));
                        }
                    }
                }
            }
        }
    }

    if let Some((_, s_idx, x_idx, val)) = closest_hit {
        let ser_name = series.get(s_idx).map(|s| s.name.clone()).unwrap_or_else(|| format!("Series {}", s_idx + 1));
        let x_name = x_labels.get(x_idx).cloned().unwrap_or_else(|| format!("Item {}", x_idx + 1));
        let nv = norm_val(val);
        let pt = world_coords(s_idx, num_series, x_idx, num_x, nv);
        let pos = proj.project(pt).map(|(p, _)| p).unwrap_or_default();

        Some(Chart3dHover {
            series_index: s_idx,
            x_index: x_idx,
            series_name: ser_name,
            x_label: x_name,
            value: val,
            pos,
        })
    } else {
        None
    }
}

fn draw_tooltip(painter: &Painter, chart_rect: Rect, hover: &Chart3dHover) {
    let text = format!("{}: {} = {:.2}", hover.series_name, hover.x_label, hover.value);
    let font = FontId::proportional(11.0);
    let size = Painter::measure_text(&painter.ctx, font, &text);

    let pad = 6.0;
    let mut tip_rect = Rect::from_min_size(
        pos2(hover.pos.x - size.x * 0.5 - pad, hover.pos.y - size.y - pad * 2.0 - 8.0),
        vec2(size.x + pad * 2.0, size.y + pad * 2.0),
    );

    // Keep tooltip inside chart bounds
    if tip_rect.min.x < chart_rect.min.x + 8.0 {
        tip_rect = tip_rect.translate(vec2(chart_rect.min.x + 8.0 - tip_rect.min.x, 0.0));
    }
    if tip_rect.max.x > chart_rect.max.x - 8.0 {
        tip_rect = tip_rect.translate(vec2(chart_rect.max.x - 8.0 - tip_rect.max.x, 0.0));
    }
    if tip_rect.min.y < chart_rect.min.y + 36.0 {
        tip_rect = Rect::from_min_size(
            pos2(hover.pos.x - size.x * 0.5 - pad, hover.pos.y + 14.0),
            vec2(size.x + pad * 2.0, size.y + pad * 2.0),
        );
    }

    painter.rect_filled(tip_rect, 6u8, Color32::from_rgba_unmultiplied(16, 20, 36, 235));
    painter.rect_stroke(tip_rect, 6u8, Stroke::new(1.0, Color32::from_white_alpha(70)), StrokeKind::Middle);
    painter.text(tip_rect.center(), Align2::CENTER, text, font, LABEL_BRIGHT);
}

// ------------------------------------------------------------------------------------------
// Toolbar
// ------------------------------------------------------------------------------------------

fn toolbar_pills(
    ctx: &crate::entropy_gui::context::Context,
    chart_rect: Rect,
    _opts: &Chart3dOptions,
    _active_type: Chart3dType,
) -> Vec<(String, Rect)> {
    let mut out = Vec::new();
    let top = chart_rect.min.y + 8.0;
    let h = 22.0;

    // Left pills: Chart Types
    let mut x = chart_rect.min.x + 10.0;
    for label in ["Surface", "Bar", "Ribbon"] {
        let w = Painter::measure_text(ctx, FontId::proportional(11.0), label).x + 16.0;
        out.push((label.to_string(), Rect::from_min_size(pos2(x, top), vec2(w, h))));
        x += w + 4.0;
    }

    // Right pills: Camera Presets
    let mut rx = chart_rect.max.x - 10.0;
    for label in ["Reset", "Front", "Top", "3D"] {
        let w = Painter::measure_text(ctx, FontId::proportional(11.0), label).x + 14.0;
        rx -= w;
        out.push((label.to_string(), Rect::from_min_size(pos2(rx, top), vec2(w, h))));
        rx -= 4.0;
    }

    out
}

fn draw_toolbar(
    painter: &Painter,
    pills: &[(String, Rect)],
    title: Option<&str>,
    active_type: Chart3dType,
    hovered: Option<&str>,
) {
    if let Some(t) = title {
        painter.text(
            pos2(painter.clip_rect().center().x, pills.first().map(|p| p.1.center().y).unwrap_or(20.0)),
            Align2::CENTER,
            t,
            FontId::proportional(11.5),
            LABEL_BRIGHT,
        );
    }

    for (label, r) in pills {
        let is_type_pill = ["Surface", "Bar", "Ribbon"].contains(&label.as_str());
        let active = is_type_pill && active_type.name() == label.as_str();
        let hot = hovered == Some(label.as_str());

        if active {
            painter.rect_filled(r.expand(2.0), 8u8, c32(TEAL, 0.18));
            painter.rect_filled(*r, 6u8, c32(mix3(TEAL, VIOLET, 0.20), 0.90));
        } else {
            painter.rect_filled(
                *r,
                6u8,
                Color32::from_rgba_unmultiplied(22, 26, 46, if hot { 240 } else { 190 }),
            );
            painter.rect_stroke(
                *r,
                6u8,
                Stroke::new(1.0, Color32::from_white_alpha(if hot { 75 } else { 35 })),
                StrokeKind::Middle,
            );
        }

        let col = if active {
            Color32::from_rgb(10, 14, 26)
        } else if hot {
            Color32::WHITE
        } else {
            LABEL_BRIGHT
        };
        painter.text(r.center(), Align2::CENTER, label, FontId::proportional(10.5), col);
    }
}

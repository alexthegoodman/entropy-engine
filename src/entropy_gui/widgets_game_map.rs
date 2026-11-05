//! `GameMap`: the Game World Planner's top-down orthographic map.
//!
//! - Terrain from a heightfield (`MapTerrain`), drawn as a per-vertex-colored mesh with
//!   hillshading in one of four styles: `relief` (hypsometric tints), `heatmap` (elevation
//!   heat scale), `slope` (steepness, for walkability), `flat` (no terrain fill).
//! - Contours traced from the heightfield with marching squares and chained into polylines:
//!   coastline, index contours (every fifth, labeled), intermediate and, zoomed in, half-interval
//!   lines. Traced once per terrain and cached.
//! - Regions (dashed borders for political ones), roads with casings, dashed trails, tapered
//!   rivers with flow chevrons, bridges, and spots with Phosphor icons and decluttered labels.
//! - Tools: select (click to select, drag spots), pan (or right-drag / Space-drag anywhere),
//!   place spot, draw path / region (points snap to grid and to nearby spots, live length and
//!   rubber-band preview), measure (live ruler from the anchor to the cursor).
//! - HUD: zoom/fit buttons, compass, scale bar, elevation legend, cursor readout (position,
//!   elevation, slope), a hint for the active tool, and a terrain mini-map you can click or drag.
//!
//! Every interaction is reported as a `GameMapEvent`; the widget never edits the world itself.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::core::vertex::Vertex;
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::Key;
use crate::entropy_gui::geometry::{pos2, vec2, Align, Align2, CursorIcon, FontId, Pos2, Rect, StrokeKind};
use crate::entropy_gui::icons::{glyph, IconStyle};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::shape::{self, Shape};
use crate::entropy_gui::ui::Ui;

// -------------------------------------------------------------------------------------------------
// Palette
// -------------------------------------------------------------------------------------------------

const BG_COLOR: Color32 = Color32::from_rgb(9, 12, 18);
const OFFWORLD_COLOR: Color32 = Color32::from_rgb(12, 17, 26);
const BORDER_COLOR: Color32 = Color32::from_rgba_unmultiplied(255, 255, 255, 38);
const TEXT_BRIGHT: Color32 = Color32::from_rgb(236, 241, 250);
const TEXT_DIM: Color32 = Color32::from_rgb(150, 160, 182);
const ACCENT_CYAN: Color32 = Color32::from_rgb(56, 189, 248);
const ACCENT_AMBER: Color32 = Color32::from_rgb(251, 191, 36);
const ACCENT_EMERALD: Color32 = Color32::from_rgb(52, 211, 153);
const HALO: Color32 = Color32::from_rgba_unmultiplied(8, 11, 17, 210);
const PANEL_BG: Color32 = Color32::from_rgba_unmultiplied(13, 17, 26, 228);
const INK: Color32 = Color32::from_rgb(14, 18, 27);

fn rgba(c: [f32; 4]) -> Color32 {
    Color32::from_rgba_unmultiplied(
        (c[0].clamp(0.0, 1.0) * 255.0) as u8,
        (c[1].clamp(0.0, 1.0) * 255.0) as u8,
        (c[2].clamp(0.0, 1.0) * 255.0) as u8,
        (c[3].clamp(0.0, 1.0) * 255.0) as u8,
    )
}

fn with_alpha(c: Color32, a: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)
}

fn lighten(c: Color32, f: f32) -> Color32 {
    let l = |v: u8| (v as f32 + (255.0 - v as f32) * f) as u8;
    Color32::from_rgba_unmultiplied(l(c.r()), l(c.g()), l(c.b()), c.a())
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn ramp(stops: &[(f32, [f32; 3])], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    for w in stops.windows(2) {
        if t <= w[1].0 {
            let f = (t - w[0].0) / (w[1].0 - w[0].0).max(1e-6);
            return lerp3(w[0].1, w[1].1, f);
        }
    }
    stops[stops.len() - 1].1
}

fn hex(v: u32) -> [f32; 3] {
    [((v >> 16) & 255) as f32 / 255.0, ((v >> 8) & 255) as f32 / 255.0, (v & 255) as f32 / 255.0]
}

/// Hypsometric land tints by relative height above sea level (0..1).
fn land_tint(palette: &str, t: f32) -> [f32; 3] {
    match palette {
        "arid" => ramp(
            &[
                (0.0, hex(0xd9c08f)),
                (0.08, hex(0xc99a5b)),
                (0.25, hex(0xb5743f)),
                (0.45, hex(0x9a5534)),
                (0.65, hex(0x7a3f2c)),
                (0.85, hex(0x6b4a3d)),
                (1.0, hex(0xe8d8c8)),
            ],
            t,
        ),
        "frozen" => ramp(
            &[
                (0.0, hex(0x9fb3a8)),
                (0.1, hex(0x7f9a8c)),
                (0.3, hex(0x8c9ba0)),
                (0.55, hex(0xb8c4cc)),
                (0.8, hex(0xdfe7ee)),
                (1.0, hex(0xffffff)),
            ],
            t,
        ),
        "neon" => ramp(
            &[
                (0.0, hex(0x2a3340)),
                (0.15, hex(0x2f3d4c)),
                (0.4, hex(0x3b4a5e)),
                (0.7, hex(0x55607a)),
                (1.0, hex(0x9aa6c4)),
            ],
            t,
        ),
        _ => ramp(
            &[
                (0.0, hex(0xd8cf9c)),
                (0.025, hex(0x7fae66)),
                (0.12, hex(0x5a9450)),
                (0.26, hex(0x3f7a43)),
                (0.42, hex(0x8f9a5a)),
                (0.58, hex(0xa48659)),
                (0.74, hex(0x8a6a50)),
                (0.88, hex(0x9a938e)),
                (1.0, hex(0xf4f6fa)),
            ],
            t,
        ),
    }
}

/// Water tints by relative depth (0 = shore, 1 = deepest).
fn water_tint(palette: &str, d: f32) -> [f32; 3] {
    match palette {
        "arid" => ramp(&[(0.0, hex(0x6fa3a0)), (0.25, hex(0x3d6f78)), (1.0, hex(0x1b3442))], d),
        "neon" => ramp(&[(0.0, hex(0x1d4a66)), (0.3, hex(0x13304a)), (1.0, hex(0x0a1626))], d),
        _ => ramp(&[(0.0, hex(0x8fd0e0)), (0.12, hex(0x4f9fc4)), (0.4, hex(0x2c6f9e)), (1.0, hex(0x123a64))], d),
    }
}

/// Perceptual heat scale (dark violet - blue - teal - green - yellow - orange - red - white).
fn heat_tint(t: f32) -> [f32; 3] {
    ramp(
        &[
            (0.0, hex(0x30123b)),
            (0.12, hex(0x4145ab)),
            (0.25, hex(0x4675ed)),
            (0.37, hex(0x1bcfd4)),
            (0.5, hex(0x61fc6c)),
            (0.62, hex(0xd1e834)),
            (0.75, hex(0xfeaa2e)),
            (0.87, hex(0xe4460a)),
            (0.96, hex(0x9a1a02)),
            (1.0, hex(0xfff3f0)),
        ],
        t,
    )
}

/// Steepness scale in degrees: easy ground green, impassable cliffs purple.
fn slope_tint(deg: f32) -> [f32; 3] {
    ramp(
        &[
            (0.0, hex(0x2e7d32)),
            (0.12, hex(0x8bc34a)),
            (0.25, hex(0xfff176)),
            (0.4, hex(0xffa726)),
            (0.6, hex(0xe53935)),
            (1.0, hex(0x6a1b9a)),
        ],
        deg / 55.0,
    )
}

// -------------------------------------------------------------------------------------------------
// Geometry helpers
// -------------------------------------------------------------------------------------------------

fn dist_to_segment(p: Pos2, a: Pos2, b: Pos2) -> f32 {
    let ab = vec2(b.x - a.x, b.y - a.y);
    let len_sq = ab.x * ab.x + ab.y * ab.y;
    if len_sq < 1e-6 {
        return (p.x - a.x).hypot(p.y - a.y);
    }
    let t = (((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len_sq).clamp(0.0, 1.0);
    (p.x - (a.x + t * ab.x)).hypot(p.y - (a.y + t * ab.y))
}

fn point_in_polygon(pt: Pos2, poly: &[Pos2]) -> bool {
    if poly.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (pi, pj) = (poly[i], poly[j]);
        if ((pi.y > pt.y) != (pj.y > pt.y)) && (pt.x < (pj.x - pi.x) * (pt.y - pi.y) / (pj.y - pi.y) + pi.x) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Area-weighted centroid (falls back to the vertex mean for degenerate polygons).
fn polygon_centroid(pts: &[Pos2]) -> Pos2 {
    let mut a = 0.0;
    let (mut cx, mut cy) = (0.0, 0.0);
    for i in 0..pts.len() {
        let p = pts[i];
        let q = pts[(i + 1) % pts.len()];
        let cross = p.x * q.y - q.x * p.y;
        a += cross;
        cx += (p.x + q.x) * cross;
        cy += (p.y + q.y) * cross;
    }
    if a.abs() < 1e-3 {
        let n = pts.len().max(1) as f32;
        return pos2(pts.iter().map(|p| p.x).sum::<f32>() / n, pts.iter().map(|p| p.y).sum::<f32>() / n);
    }
    pos2(cx / (3.0 * a), cy / (3.0 * a))
}

fn polyline(painter: &Painter, pts: &[Pos2], stroke: Stroke) {
    if pts.len() < 2 {
        return;
    }
    let (v, i) = shape::tessellate_line(pts, stroke);
    painter.mesh(v, i);
}

/// A dashed polyline, dash and gap measured in screen pixels and continuing across vertices.
fn dashed_polyline(painter: &Painter, pts: &[Pos2], stroke: Stroke, dash: f32, gap: f32) {
    let mut on = true;
    let mut left = dash;
    let mut cur: Vec<Pos2> = vec![];
    for w in pts.windows(2) {
        let (mut a, b) = (w[0], w[1]);
        let mut seg = (b.x - a.x).hypot(b.y - a.y);
        while seg > 1e-3 {
            let step = left.min(seg);
            let f = step / seg;
            let p = pos2(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
            if on {
                if cur.is_empty() {
                    cur.push(a);
                }
                cur.push(p);
            }
            seg -= step;
            left -= step;
            a = p;
            if left <= 1e-3 {
                if on && cur.len() >= 2 {
                    polyline(painter, &cur, stroke);
                }
                cur.clear();
                on = !on;
                left = if on { dash } else { gap };
            }
        }
    }
    if on && cur.len() >= 2 {
        polyline(painter, &cur, stroke);
    }
}

fn text_halo(painter: &Painter, pos: Pos2, align: Align2, text: &str, font: FontId, color: Color32, halo: Color32) -> Rect {
    for (dx, dy) in [(-1.0, 0.0), (1.0, 0.0), (0.0, -1.0), (0.0, 1.0)] {
        painter.text(pos2(pos.x + dx, pos.y + dy), align, text, font.clone(), halo);
    }
    painter.text(pos, align, text, font, color)
}

/// A label on a soft translucent pill: readable over any terrain without the smeared look of a halo.
fn text_pill(painter: &Painter, ctx: &crate::entropy_gui::context::Context, anchor: Pos2, align: Align2, text: &str, font: FontId, color: Color32, bg: Color32) -> Rect {
    let size = Painter::measure_text(ctx, font.clone(), text);
    let pad = vec2(5.0, 2.0);
    let w = size.x + pad.x * 2.0;
    let h = size.y.max(font.size) + pad.y * 2.0;
    let min_x = match align.0 { Align::Min => anchor.x, Align::Max => anchor.x - w, _ => anchor.x - w * 0.5 };
    let min_y = match align.1 { Align::Min => anchor.y, Align::Max => anchor.y - h, _ => anchor.y - h * 0.5 };
    let r = Rect::from_min_size(pos2(min_x, min_y), vec2(w, h));
    painter.rect_filled(r, 4u8, bg);
    painter.text(r.center(), Align2::CENTER_CENTER, text, font, color);
    r
}

fn nice_step(raw: f32, steps: &[f32]) -> f32 {
    for &s in steps {
        if s >= raw {
            return s;
        }
    }
    *steps.last().unwrap()
}

fn icon(name: &str) -> String {
    glyph(name, IconStyle::Fill).map(|c| c.to_string()).unwrap_or_else(|| "•".into())
}

fn spot_icon_name(spot_type: &str) -> &'static str {
    match spot_type {
        "capital" => "crown",
        "city" => "buildings",
        "town" => "house",
        "village" => "house-line",
        "fortress" => "castle-turret",
        "dungeon" => "skull",
        "ruin" => "columns",
        "port" => "anchor",
        "shrine" => "sparkle",
        "camp" => "tent",
        "mine" => "hammer",
        "boss" => "sword",
        "landmark" => "flag",
        _ => "map-pin",
    }
}

// -------------------------------------------------------------------------------------------------
// Data models
// -------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct MapSpot {
    pub id: String,
    pub name: String,
    pub spot_type: String,
    pub x: f32,
    pub y: f32,
    pub elevation: f32,
    pub color: [f32; 4],
    pub icon: String,
    pub tags: Vec<String>,
    pub is_major: bool,
}

impl Default for MapSpot {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "New Location".into(),
            spot_type: "town".into(),
            x: 0.0,
            y: 0.0,
            elevation: 100.0,
            color: [0.2, 0.8, 0.6, 1.0],
            icon: "house".into(),
            tags: Vec::new(),
            is_major: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MapPath {
    pub id: String,
    pub name: String,
    pub path_type: String, // "highway", "road", "trail", "river", "bridge"
    pub points: Vec<[f32; 2]>,
    pub width: f32,
    pub color: [f32; 4],
    pub is_major: bool,
    pub flow_speed: f32,
}

impl Default for MapPath {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "New Path".into(),
            path_type: "road".into(),
            points: Vec::new(),
            width: 3.0,
            color: [0.8, 0.7, 0.5, 1.0],
            is_major: false,
            flow_speed: 0.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MapRegion {
    pub id: String,
    pub name: String,
    pub region_type: String, // "kingdom", "province", "biome", "danger", "district"
    pub points: Vec<[f32; 2]>,
    pub fill_color: [f32; 4],
    pub border_color: [f32; 4],
    pub is_major: bool,
}

impl Default for MapRegion {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "New Region".into(),
            region_type: "kingdom".into(),
            points: Vec::new(),
            fill_color: [0.3, 0.5, 0.8, 0.25],
            border_color: [0.4, 0.6, 0.9, 0.8],
            is_major: true,
        }
    }
}

/// A hand-drawn contour line (used when the world has no heightfield).
#[derive(Clone, Debug, PartialEq)]
pub struct MapElevationBand {
    pub elevation: f32,
    pub points: Vec<[f32; 2]>,
    pub color: [f32; 4],
}

/// The world's heightfield: `cols` x `rows` elevations (meters), row-major, row 0 along the north
/// edge, spanning the whole world rectangle.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct MapTerrain {
    pub cols: usize,
    pub rows: usize,
    pub data: Vec<f32>,
    pub sea_level_m: f32,
}

impl MapTerrain {
    fn valid(&self) -> bool {
        self.cols >= 2 && self.rows >= 2 && self.data.len() == self.cols * self.rows
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MapMeasure {
    pub active: bool,
    pub p1: [f32; 2],
    pub p2: [f32; 2],
    pub distance_km: f32,
    pub travel_info: String,
}

// -------------------------------------------------------------------------------------------------
// Options & events
// -------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct GameMapOptions {
    pub world_width_km: f32,
    pub world_height_km: f32,
    pub grid_snap_m: f32,
    pub show_grid: bool,
    pub show_contours: bool,
    pub show_biomes: bool,
    pub show_minimap: bool,
    pub show_labels: bool,
    pub blocking_mode: bool,
    /// "select", "pan", "place_spot", "draw_path", "draw_region", "measure".
    pub active_tool: String,
    pub selected_id: Option<String>,
    pub highlighted_quest_id: Option<String>,
    pub pending_points: Vec<[f32; 2]>,
    pub pending_mode: Option<String>,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub initial_center: Option<[f32; 2]>,
    pub initial_zoom: Option<f32>,
    /// "relief" (default), "heatmap", "slope" or "flat".
    pub terrain_style: String,
    /// "temperate" (default), "arid", "frozen" or "neon".
    pub terrain_palette: String,
    /// Meters between contours; 0 picks a round interval from the relief.
    pub contour_interval_m: f32,
    /// The measure tool's first point while the second has not been placed: a live ruler runs from
    /// here to the cursor.
    pub measure_anchor: Option<[f32; 2]>,
    /// Bump to re-fit the view to the whole world.
    pub fit_request: u32,
}

impl Default for GameMapOptions {
    fn default() -> Self {
        Self {
            world_width_km: 25.0,
            world_height_km: 25.0,
            grid_snap_m: 0.0,
            show_grid: true,
            show_contours: true,
            show_biomes: true,
            show_minimap: true,
            show_labels: true,
            blocking_mode: false,
            active_tool: "select".into(),
            selected_id: None,
            highlighted_quest_id: None,
            pending_points: Vec::new(),
            pending_mode: None,
            width: None,
            height: None,
            initial_center: None,
            initial_zoom: None,
            terrain_style: "relief".into(),
            terrain_palette: "temperate".into(),
            contour_interval_m: 0.0,
            measure_anchor: None,
            fit_request: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum GameMapEvent {
    SpotSelected { id: String },
    /// A spot is being dragged; sent each time its (snapped) position changes.
    SpotMoved { id: String, x: f32, y: f32 },
    /// The drag that moved a spot ended at this position.
    SpotDragEnded { id: String, x: f32, y: f32 },
    PathSelected { id: String },
    RegionSelected { id: String },
    /// A press on the map (snapped to the grid, or to a nearby spot while drawing or measuring).
    MapClicked { x: f32, y: f32 },
    MapDoubleClicked { x: f32, y: f32 },
    PointAdded { x: f32, y: f32 },
    MeasureUpdated { x1: f32, y1: f32, x2: f32, y2: f32, distance_km: f32 },
    ViewportChanged { center_x: f32, center_y: f32, zoom: f32 },
    ToolChanged(String),
    BlockingModeToggled(bool),
}

pub struct GameMapResponse {
    pub events: Vec<GameMapEvent>,
}

// -------------------------------------------------------------------------------------------------
// State & caches
// -------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct GameMapState {
    pub center: Pos2,
    /// Screen pixels per world kilometer.
    pub zoom: f32,
    pub initialized: bool,
    pub world_dims: (f32, f32),
    pub fit_request: u32,
    pub is_panning: bool,
    pub pan_start_pointer: Option<Pos2>,
    pub pan_start_center: Pos2,
    pub minimap_dragging: bool,
    pub space_down: bool,
    pub dragging_spot_id: Option<String>,
    pub drag_press_pos: Option<Pos2>,
    pub drag_start_world: Option<Pos2>,
    pub drag_moved: bool,
    pub drag_last_world: Option<Pos2>,
    pub current_pointer_world: Option<Pos2>,
    pub last_click_pos: Option<Pos2>,
    pub last_click_time: f32,
}

impl Default for GameMapState {
    fn default() -> Self {
        Self {
            center: pos2(0.0, 0.0),
            zoom: 24.0,
            initialized: false,
            world_dims: (0.0, 0.0),
            fit_request: 0,
            is_panning: false,
            pan_start_pointer: None,
            pan_start_center: pos2(0.0, 0.0),
            minimap_dragging: false,
            space_down: false,
            dragging_spot_id: None,
            drag_press_pos: None,
            drag_start_world: None,
            drag_moved: false,
            drag_last_world: None,
            current_pointer_world: None,
            last_click_pos: None,
            last_click_time: 1.0,
        }
    }
}

/// 0 = half-interval, 1 = intermediate, 2 = index (every fifth), 3 = coastline.
#[derive(Clone, Debug)]
struct ContourPath {
    level: f32,
    kind: u8,
    points: Vec<[f32; 2]>,
    bbox: [f32; 4], // min x, min y, max x, max y (world km)
}

#[derive(Clone, Debug, Default)]
struct TerrainCache {
    key: u64,
    colors: Vec<[f32; 4]>,
    min_m: f32,
    max_m: f32,
    interval_m: f32,
    contours: Vec<ContourPath>,
}

fn terrain_key(t: &MapTerrain, style: &str, palette: &str, interval: f32, w: f32, h: f32) -> u64 {
    let mut hasher = DefaultHasher::new();
    t.cols.hash(&mut hasher);
    t.rows.hash(&mut hasher);
    t.sea_level_m.to_bits().hash(&mut hasher);
    for v in &t.data {
        v.to_bits().hash(&mut hasher);
    }
    style.hash(&mut hasher);
    palette.hash(&mut hasher);
    interval.to_bits().hash(&mut hasher);
    w.to_bits().hash(&mut hasher);
    h.to_bits().hash(&mut hasher);
    hasher.finish()
}

/// Isolines of `level` as chained polylines in world km (marching squares on the vertex grid).
fn trace_isolines(t: &MapTerrain, w_km: f32, h_km: f32, level: f32) -> Vec<Vec<[f32; 2]>> {
    let (cols, rows) = (t.cols, t.rows);
    let d = &t.data;
    let lv = level + 1e-3;
    let sx = w_km / (cols - 1) as f32;
    let sy = h_km / (rows - 1) as f32;
    let (hw, hh) = (w_km * 0.5, h_km * 0.5);
    let v_base = rows * cols;
    let edge_point = |e: usize| -> [f32; 2] {
        if e < v_base {
            let (r, c) = (e / cols, e % cols);
            let (a, b) = (d[r * cols + c], d[r * cols + c + 1]);
            let f = ((lv - a) / (b - a)).clamp(0.0, 1.0);
            [-hw + (c as f32 + f) * sx, hh - r as f32 * sy]
        } else {
            let k = e - v_base;
            let (r, c) = (k / cols, k % cols);
            let (a, b) = (d[r * cols + c], d[(r + 1) * cols + c]);
            let f = ((lv - a) / (b - a)).clamp(0.0, 1.0);
            [-hw + c as f32 * sx, hh - (r as f32 + f) * sy]
        }
    };
    let mut segs: Vec<(usize, usize)> = Vec::new();
    for r in 0..rows - 1 {
        for c in 0..cols - 1 {
            let tl = (d[r * cols + c] > lv) as u8;
            let tr = (d[r * cols + c + 1] > lv) as u8;
            let br = (d[(r + 1) * cols + c + 1] > lv) as u8;
            let bl = (d[(r + 1) * cols + c] > lv) as u8;
            let idx = (tl << 3) | (tr << 2) | (br << 1) | bl;
            if idx == 0 || idx == 15 {
                continue;
            }
            let top = r * cols + c;
            let bottom = (r + 1) * cols + c;
            let left = v_base + r * cols + c;
            let right = v_base + r * cols + c + 1;
            match idx {
                1 | 14 => segs.push((left, bottom)),
                2 | 13 => segs.push((bottom, right)),
                3 | 12 => segs.push((left, right)),
                4 | 11 => segs.push((top, right)),
                6 | 9 => segs.push((top, bottom)),
                7 | 8 => segs.push((left, top)),
                5 | 10 => {
                    let center = (d[r * cols + c] + d[r * cols + c + 1] + d[(r + 1) * cols + c] + d[(r + 1) * cols + c + 1]) * 0.25 > lv;
                    if (idx == 5) == center {
                        segs.push((left, top));
                        segs.push((bottom, right));
                    } else {
                        segs.push((left, bottom));
                        segs.push((top, right));
                    }
                }
                _ => {}
            }
        }
    }
    let mut by_edge: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::with_capacity(segs.len() * 2);
    for (i, &(a, b)) in segs.iter().enumerate() {
        by_edge.entry(a).or_default().push(i);
        by_edge.entry(b).or_default().push(i);
    }
    let mut used = vec![false; segs.len()];
    let mut lines = Vec::new();
    let next_seg = |e: usize, used: &Vec<bool>| -> Option<usize> { by_edge.get(&e).and_then(|l| l.iter().copied().find(|&s| !used[s])) };
    for s0 in 0..segs.len() {
        if used[s0] {
            continue;
        }
        used[s0] = true;
        let mut fwd = vec![segs[s0].0, segs[s0].1];
        while let Some(s) = next_seg(*fwd.last().unwrap(), &used) {
            used[s] = true;
            let tail = *fwd.last().unwrap();
            fwd.push(if segs[s].0 == tail { segs[s].1 } else { segs[s].0 });
        }
        let mut back = Vec::new();
        let mut head = fwd[0];
        while let Some(s) = next_seg(head, &used) {
            used[s] = true;
            head = if segs[s].0 == head { segs[s].1 } else { segs[s].0 };
            back.push(head);
        }
        back.reverse();
        back.extend(fwd);
        if back.len() >= 3 {
            lines.push(back.into_iter().map(edge_point).collect());
        }
    }
    lines
}

fn build_terrain_cache(t: &MapTerrain, opts: &GameMapOptions, key: u64) -> TerrainCache {
    let (cols, rows) = (t.cols, t.rows);
    let d = &t.data;
    let sea = t.sea_level_m;
    let (mut min_m, mut max_m) = (f32::MAX, f32::MIN);
    for &v in d {
        min_m = min_m.min(v);
        max_m = max_m.max(v);
    }
    let land_span = (max_m - sea).max(1.0);
    let sea_span = (sea - min_m).max(1.0);
    let dx_m = opts.world_width_km * 1000.0 / (cols - 1) as f32;
    let dy_m = opts.world_height_km * 1000.0 / (rows - 1) as f32;
    // Light from the north-west, 45 degrees up; screen y points south.
    let (lx, ly, lz) = (-0.5f32, -0.5f32, 0.7071f32);
    let flat = lz;
    let z_exag = 2.2;
    let style = opts.terrain_style.as_str();
    let palette = opts.terrain_palette.as_str();
    let mut colors = Vec::with_capacity(d.len());
    for r in 0..rows {
        for c in 0..cols {
            let e = d[r * cols + c];
            let cl = c.saturating_sub(1);
            let cr = (c + 1).min(cols - 1);
            let ru = r.saturating_sub(1);
            let rd = (r + 1).min(rows - 1);
            let gx = (d[r * cols + cr] - d[r * cols + cl]) / (dx_m * (cr - cl).max(1) as f32);
            let gy = (d[rd * cols + c] - d[ru * cols + c]) / (dy_m * (rd - ru).max(1) as f32);
            let (nx, ny, nz) = (-gx * z_exag, -gy * z_exag, 1.0);
            let nl = (nx * nx + ny * ny + nz * nz).sqrt();
            let shade = ((nx * lx + ny * ly + nz * lz) / nl / flat).max(0.0);
            let slope_deg = (gx * gx + gy * gy).sqrt().atan().to_degrees();
            let underwater = e <= sea;
            let (base, light) = match style {
                "heatmap" => {
                    if underwater {
                        (lerp3(hex(0x1f2a44), hex(0x0b1020), ((sea - e) / sea_span).sqrt()), 0.15)
                    } else {
                        (heat_tint(0.3 + 0.7 * (e - sea) / land_span), 0.45)
                    }
                }
                "slope" => {
                    if underwater {
                        (lerp3(hex(0x24344a), hex(0x101826), ((sea - e) / sea_span).sqrt()), 0.1)
                    } else {
                        (lerp3(slope_tint(slope_deg), hex(0x9aa3a8), 0.22), 0.55)
                    }
                }
                _ => {
                    if underwater {
                        (water_tint(palette, ((sea - e) / sea_span).powf(0.6)), 0.12)
                    } else {
                        (land_tint(palette, (e - sea) / land_span), 0.75)
                    }
                }
            };
            let f = (1.0 - light + light * shade).clamp(0.3, 1.35);
            // Shadows lean cool, lit slopes warm, so relief reads without washing the tints out.
            let warm = (shade - 1.0).max(0.0) * 0.06 * light;
            let cool = (1.0 - shade).max(0.0) * 0.05 * light;
            colors.push([
                (base[0] * f + warm - cool).clamp(0.0, 1.0),
                (base[1] * f + warm * 0.6 - cool * 0.3).clamp(0.0, 1.0),
                (base[2] * f + cool).clamp(0.0, 1.0),
                1.0,
            ]);
        }
    }

    // Contours at half the interval; each tagged with its rank.
    let interval = if opts.contour_interval_m > 0.0 {
        opts.contour_interval_m
    } else {
        nice_step(land_span / 14.0, &[5.0, 10.0, 20.0, 25.0, 50.0, 100.0, 200.0, 250.0, 500.0, 1000.0])
    };
    let mut contours = Vec::new();
    let mut push_level = |level: f32, kind: u8, contours: &mut Vec<ContourPath>| {
        for pts in trace_isolines(t, opts.world_width_km, opts.world_height_km, level) {
            let mut bbox = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
            for p in &pts {
                bbox[0] = bbox[0].min(p[0]);
                bbox[1] = bbox[1].min(p[1]);
                bbox[2] = bbox[2].max(p[0]);
                bbox[3] = bbox[3].max(p[1]);
            }
            contours.push(ContourPath { level, kind, points: pts, bbox });
        }
    };
    if min_m < sea && max_m > sea {
        push_level(sea, 3, &mut contours);
    }
    let half = interval * 0.5;
    let mut k = 1;
    loop {
        let level = sea + half * k as f32;
        if level >= max_m || k > 400 {
            break;
        }
        let kind = if k % 10 == 0 { 2 } else if k % 2 == 0 { 1 } else { 0 };
        push_level(level, kind, &mut contours);
        k += 1;
    }
    // Sparse bathymetry: every index interval below the surface.
    let mut depth = interval * 5.0;
    while sea - depth > min_m && depth < 20000.0 {
        push_level(sea - depth, 1, &mut contours);
        depth += interval * 5.0;
    }
    TerrainCache { key, colors, min_m, max_m, interval_m: interval, contours }
}

// -------------------------------------------------------------------------------------------------
// Widget
// -------------------------------------------------------------------------------------------------

pub struct GameMap {
    id: Id,
    options: GameMapOptions,
    spots: Vec<MapSpot>,
    paths: Vec<MapPath>,
    regions: Vec<MapRegion>,
    elevation_bands: Vec<MapElevationBand>,
    terrain: Option<MapTerrain>,
    measure: Option<MapMeasure>,
}

#[derive(Clone, Copy, PartialEq)]
enum Hover {
    None,
    Spot(usize),
    Path(usize),
    Region(usize),
}

impl GameMap {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self {
            id: Id::new("game_map_widget").with(id_salt),
            options: GameMapOptions::default(),
            spots: Vec::new(),
            paths: Vec::new(),
            regions: Vec::new(),
            elevation_bands: Vec::new(),
            terrain: None,
            measure: None,
        }
    }

    pub fn options(mut self, options: GameMapOptions) -> Self {
        self.options = options;
        self
    }
    pub fn spots(mut self, spots: Vec<MapSpot>) -> Self {
        self.spots = spots;
        self
    }
    pub fn paths(mut self, paths: Vec<MapPath>) -> Self {
        self.paths = paths;
        self
    }
    pub fn regions(mut self, regions: Vec<MapRegion>) -> Self {
        self.regions = regions;
        self
    }
    pub fn elevation_bands(mut self, elevation_bands: Vec<MapElevationBand>) -> Self {
        self.elevation_bands = elevation_bands;
        self
    }
    pub fn terrain(mut self, terrain: Option<MapTerrain>) -> Self {
        self.terrain = terrain.filter(|t| t.valid());
        self
    }
    pub fn measure(mut self, measure: Option<MapMeasure>) -> Self {
        self.measure = measure;
        self
    }
    pub fn pending_points(mut self, points: Vec<[f32; 2]>) -> Self {
        self.options.pending_points = points;
        self
    }
    pub fn pending_mode(mut self, mode: Option<String>) -> Self {
        self.options.pending_mode = mode;
        self
    }
    pub fn show_minimap(mut self, show: bool) -> Self {
        self.options.show_minimap = show;
        self
    }

    /// Bilinear terrain elevation at a world position.
    fn sample(&self, x: f32, y: f32) -> Option<f32> {
        let t = self.terrain.as_ref()?;
        let w = self.options.world_width_km;
        let h = self.options.world_height_km;
        let gc = ((x + w * 0.5) / w * (t.cols - 1) as f32).clamp(0.0, (t.cols - 1) as f32 - 1e-3);
        let gr = ((h * 0.5 - y) / h * (t.rows - 1) as f32).clamp(0.0, (t.rows - 1) as f32 - 1e-3);
        if x.abs() > w * 0.5 || y.abs() > h * 0.5 {
            return None;
        }
        let (c0, r0) = (gc.floor() as usize, gr.floor() as usize);
        let (fc, fr) = (gc - c0 as f32, gr - r0 as f32);
        let i = r0 * t.cols + c0;
        let d = &t.data;
        let top = d[i] + (d[i + 1] - d[i]) * fc;
        let bot = d[i + t.cols] + (d[i + t.cols + 1] - d[i + t.cols]) * fc;
        Some(top + (bot - top) * fr)
    }

    pub fn show(self, ui: &mut Ui) -> GameMapResponse {
        let ctx = ui.ctx().clone();
        let opts = self.options.clone();

        let avail = ui.available_size();
        let width = opts.width.unwrap_or_else(|| avail.x.max(300.0));
        let height = opts.height.unwrap_or_else(|| avail.y.max(300.0));
        let (resp, painter) = ui.allocate_painter(vec2(width, height), Sense::click_and_drag());
        let rect = resp.rect;
        let painter = painter.with_clip_rect(rect);

        let mut st: GameMapState = ctx.memory_mut(|m| m.take_view_state(self.id));
        let cache_id = self.id.with("terrain_cache");
        let mut cache: TerrainCache = ctx.memory_mut(|m| m.take_view_state(cache_id));

        let fit_zoom = (rect.width() / opts.world_width_km.max(0.01)).min(rect.height() / opts.world_height_km.max(0.01)) * 0.92;
        let dims = (opts.world_width_km, opts.world_height_km);
        if !st.initialized || st.world_dims != dims || st.fit_request != opts.fit_request {
            let first = !st.initialized;
            st.center = match (first, opts.initial_center) {
                (true, Some(c)) => pos2(c[0], c[1]),
                _ => pos2(0.0, 0.0),
            };
            st.zoom = match (first, opts.initial_zoom) {
                (true, Some(z)) if z > 0.1 => z,
                _ => fit_zoom,
            };
            st.initialized = true;
            st.world_dims = dims;
            st.fit_request = opts.fit_request;
        }
        let min_zoom = fit_zoom * 0.35;
        let max_zoom = 2500.0;

        let mut events: Vec<GameMapEvent> = Vec::new();
        let (dt, pointer, scroll_y, key_events) = ctx.input(|i| (i.dt, i.pointer, i.scroll_delta.y, i.key_events.clone()));
        st.last_click_time += dt;
        for k in &key_events {
            if k.key == Key::Space {
                st.space_down = k.pressed;
            }
        }
        let pointer_pos = pointer.pos;

        // HUD hit areas (screen space).
        let minimap_size = vec2(168.0, 168.0 * (opts.world_height_km / opts.world_width_km.max(0.01)).clamp(0.4, 1.6));
        let minimap_rect = Rect::from_min_size(pos2(rect.max.x - minimap_size.x - 14.0, rect.max.y - minimap_size.y - 34.0), minimap_size);
        let btn_size = 26.0;
        let btn_x = rect.max.x - 14.0 - btn_size;
        let zoom_btns = [
            ("plus", Rect::from_min_size(pos2(btn_x, rect.min.y + 62.0), vec2(btn_size, btn_size))),
            ("minus", Rect::from_min_size(pos2(btn_x, rect.min.y + 62.0 + btn_size + 4.0), vec2(btn_size, btn_size))),
            ("corners-out", Rect::from_min_size(pos2(btn_x, rect.min.y + 62.0 + (btn_size + 4.0) * 2.0), vec2(btn_size, btn_size))),
        ];
        let over_hud_btn = pointer_pos.and_then(|p| zoom_btns.iter().position(|(_, r)| r.contains(p)));
        let in_minimap = opts.show_minimap && pointer_pos.is_some_and(|p| minimap_rect.contains(p));
        let is_hovered = pointer_pos.is_some_and(|p| rect.contains(p)) && !in_minimap && over_hud_btn.is_none();

        let mut view_changed = false;

        // HUD buttons.
        if pointer.primary_pressed {
            if let Some(i) = over_hud_btn {
                match i {
                    0 => st.zoom = (st.zoom * 1.4).clamp(min_zoom, max_zoom),
                    1 => st.zoom = (st.zoom / 1.4).clamp(min_zoom, max_zoom),
                    _ => {
                        st.zoom = fit_zoom;
                        st.center = pos2(0.0, 0.0);
                    }
                }
                view_changed = true;
            }
        }

        // Mini-map: press or drag inside it to move the view there.
        if opts.show_minimap {
            if in_minimap && pointer.primary_pressed {
                st.minimap_dragging = true;
            }
            if st.minimap_dragging {
                if pointer.primary_down {
                    if let Some(sp) = pointer_pos {
                        let nx = ((sp.x - minimap_rect.min.x - 4.0) / (minimap_rect.width() - 8.0)).clamp(0.0, 1.0);
                        let ny = ((sp.y - minimap_rect.min.y - 4.0) / (minimap_rect.height() - 8.0)).clamp(0.0, 1.0);
                        st.center = pos2((nx - 0.5) * opts.world_width_km, (0.5 - ny) * opts.world_height_km);
                        view_changed = true;
                    }
                } else {
                    st.minimap_dragging = false;
                }
            }
        }

        // Wheel zoom about the pointer.
        if is_hovered && scroll_y.abs() > 0.01 {
            let factor = (1.0 + scroll_y.signum() * 0.15).max(0.5);
            let new_zoom = (st.zoom * factor).clamp(min_zoom, max_zoom);
            if let Some(sp) = pointer_pos {
                let sc = rect.center();
                let wx = st.center.x + (sp.x - sc.x) / st.zoom;
                let wy = st.center.y - (sp.y - sc.y) / st.zoom;
                st.zoom = new_zoom;
                st.center = pos2(wx - (sp.x - sc.x) / new_zoom, wy + (sp.y - sc.y) / new_zoom);
            }
            view_changed = true;
        }

        // Panning: right-drag anywhere, left-drag with the pan tool or while Space is held.
        let pan_start = is_hovered
            && !st.is_panning
            && st.dragging_spot_id.is_none()
            && (pointer.secondary_pressed || (pointer.primary_pressed && (opts.active_tool == "pan" || st.space_down)));
        if pan_start {
            st.is_panning = true;
            st.pan_start_pointer = pointer_pos;
            st.pan_start_center = st.center;
        }
        if st.is_panning {
            if pointer.primary_down || pointer.secondary_down {
                if let (Some(cur), Some(start)) = (pointer_pos, st.pan_start_pointer) {
                    st.center = pos2(st.pan_start_center.x - (cur.x - start.x) / st.zoom, st.pan_start_center.y + (cur.y - start.y) / st.zoom);
                    view_changed = true;
                }
            } else {
                st.is_panning = false;
                st.pan_start_pointer = None;
            }
        }
        // Keep at least part of the world on screen.
        st.center.x = st.center.x.clamp(-opts.world_width_km * 0.6, opts.world_width_km * 0.6);
        st.center.y = st.center.y.clamp(-opts.world_height_km * 0.6, opts.world_height_km * 0.6);
        if view_changed {
            events.push(GameMapEvent::ViewportChanged { center_x: st.center.x, center_y: st.center.y, zoom: st.zoom });
        }

        // Transforms (fixed for the rest of the frame).
        let sc = rect.center();
        let zoom = st.zoom;
        let center = st.center;
        let w2s = |wx: f32, wy: f32| -> Pos2 { pos2(sc.x + (wx - center.x) * zoom, sc.y - (wy - center.y) * zoom) };
        let s2w = |sp: Pos2| -> Pos2 { pos2(center.x + (sp.x - sc.x) / zoom, center.y - (sp.y - sc.y) / zoom) };
        let snap = |p: Pos2| -> Pos2 {
            if opts.grid_snap_m > 0.0 {
                let s = opts.grid_snap_m / 1000.0;
                pos2((p.x / s).round() * s, (p.y / s).round() * s)
            } else {
                p
            }
        };
        st.current_pointer_world = pointer_pos.filter(|_| is_hovered).map(s2w);
        let world_tl = s2w(rect.min);
        let world_br = s2w(rect.max);
        let (vis_min_x, vis_max_x, vis_min_y, vis_max_y) = (world_tl.x, world_br.x, world_br.y, world_tl.y);
        let half_w = opts.world_width_km * 0.5;
        let half_h = opts.world_height_km * 0.5;
        let world_rect = Rect::from_min_max(w2s(-half_w, half_h), w2s(half_w, -half_h));

        // -----------------------------------------------------------------------------------------
        // Hover pass: one target, spots over paths over regions.
        // -----------------------------------------------------------------------------------------
        let drawing = matches!(opts.active_tool.as_str(), "draw_path" | "draw_region" | "measure");
        let spot_radius = |s: &MapSpot| -> f32 {
            let base = if s.spot_type == "capital" { 12.0 } else if s.is_major { 9.5 } else { 7.5 };
            if zoom < fit_zoom * 0.8 && !s.is_major { base * 0.8 } else { base }
        };
        let visible_spot = |s: &MapSpot| !(opts.blocking_mode && !s.is_major);
        let mut hover = Hover::None;
        if let Some(p) = pointer_pos.filter(|_| is_hovered && !st.is_panning) {
            for (i, s) in self.spots.iter().enumerate().rev() {
                if !visible_spot(s) {
                    continue;
                }
                let sp = w2s(s.x, s.y);
                if (sp.x - p.x).hypot(sp.y - p.y) <= spot_radius(s) + 5.0 {
                    hover = Hover::Spot(i);
                    break;
                }
            }
            if hover == Hover::None && !drawing {
                'paths: for (i, path) in self.paths.iter().enumerate().rev() {
                    if opts.blocking_mode && !path.is_major {
                        continue;
                    }
                    for w in path.points.windows(2) {
                        if dist_to_segment(p, w2s(w[0][0], w[0][1]), w2s(w[1][0], w[1][1])) <= 7.0 {
                            hover = Hover::Path(i);
                            break 'paths;
                        }
                    }
                }
            }
            if hover == Hover::None && !drawing && opts.show_biomes {
                for (i, reg) in self.regions.iter().enumerate().rev() {
                    if (opts.blocking_mode && !reg.is_major) || reg.points.len() < 3 {
                        continue;
                    }
                    let pts: Vec<Pos2> = reg.points.iter().map(|q| w2s(q[0], q[1])).collect();
                    if point_in_polygon(p, &pts) {
                        hover = Hover::Region(i);
                        break;
                    }
                }
            }
        }
        // While drawing or measuring, a point near a spot lands on the spot.
        let magnet: Option<Pos2> = match hover {
            Hover::Spot(i) if drawing => Some(pos2(self.spots[i].x, self.spots[i].y)),
            _ => None,
        };
        let cursor_world: Option<Pos2> = st.current_pointer_world.map(|p| magnet.unwrap_or_else(|| snap(p)));

        // -----------------------------------------------------------------------------------------
        // Press handling (selection, tools, drag start).
        // -----------------------------------------------------------------------------------------
        if pointer.primary_pressed && is_hovered && !st.is_panning && !pan_start {
            let p = pointer_pos.unwrap();
            let is_double = st.last_click_pos.is_some_and(|lp| st.last_click_time < 0.35 && (p.x - lp.x).hypot(p.y - lp.y) < 12.0);
            if is_double {
                st.last_click_pos = None;
                st.last_click_time = 1.0;
            } else {
                st.last_click_pos = Some(p);
                st.last_click_time = 0.0;
            }
            let at = cursor_world.unwrap_or_else(|| snap(s2w(p)));
            match (opts.active_tool.as_str(), hover) {
                ("select", Hover::Spot(i)) | ("place_spot", Hover::Spot(i)) | ("pan", Hover::Spot(i)) => {
                    let s = &self.spots[i];
                    events.push(GameMapEvent::SpotSelected { id: s.id.clone() });
                    if opts.active_tool == "select" {
                        st.dragging_spot_id = Some(s.id.clone());
                        st.drag_press_pos = Some(p);
                        st.drag_start_world = Some(pos2(s.x, s.y));
                        st.drag_last_world = Some(pos2(s.x, s.y));
                        st.drag_moved = false;
                    }
                }
                ("select", Hover::Path(i)) => events.push(GameMapEvent::PathSelected { id: self.paths[i].id.clone() }),
                ("select", Hover::Region(i)) => events.push(GameMapEvent::RegionSelected { id: self.regions[i].id.clone() }),
                (_, _) if is_double && drawing => events.push(GameMapEvent::MapDoubleClicked { x: at.x, y: at.y }),
                (_, _) => events.push(GameMapEvent::MapClicked { x: at.x, y: at.y }),
            }
        }

        // Spot drag: starts after the pointer moves a few pixels, reports only real moves.
        let mut drag_preview: Option<(String, Pos2)> = None;
        if let Some(drag_id) = st.dragging_spot_id.clone() {
            if pointer.primary_down {
                if let (Some(p), Some(press)) = (pointer_pos, st.drag_press_pos) {
                    if !st.drag_moved && (p.x - press.x).hypot(p.y - press.y) > 4.0 {
                        st.drag_moved = true;
                    }
                    if st.drag_moved {
                        let start = st.drag_start_world.unwrap_or(pos2(0.0, 0.0));
                        let offset = s2w(press);
                        let raw = s2w(p);
                        let target = snap(pos2(start.x + raw.x - offset.x, start.y + raw.y - offset.y));
                        if st.drag_last_world.map_or(true, |l| (l.x - target.x).abs() > 1e-5 || (l.y - target.y).abs() > 1e-5) {
                            events.push(GameMapEvent::SpotMoved { id: drag_id.clone(), x: target.x, y: target.y });
                            st.drag_last_world = Some(target);
                        }
                        drag_preview = Some((drag_id.clone(), target));
                    }
                }
            } else {
                if st.drag_moved {
                    if let Some(l) = st.drag_last_world {
                        events.push(GameMapEvent::SpotDragEnded { id: drag_id.clone(), x: l.x, y: l.y });
                    }
                }
                st.dragging_spot_id = None;
                st.drag_press_pos = None;
                st.drag_moved = false;
            }
        }

        // Cursor.
        if is_hovered || over_hud_btn.is_some() || in_minimap {
            let cursor = if st.is_panning || st.drag_moved {
                CursorIcon::Grabbing
            } else if over_hud_btn.is_some() || in_minimap || (matches!(hover, Hover::Spot(_)) && opts.active_tool == "select") {
                CursorIcon::PointingHand
            } else if opts.active_tool == "pan" || st.space_down {
                CursorIcon::Grab
            } else {
                CursorIcon::Default
            };
            ctx.request_cursor_icon(cursor);
        }

        // -----------------------------------------------------------------------------------------
        // 1. Background, terrain
        // -----------------------------------------------------------------------------------------
        painter.rect_filled(rect, 4u8, BG_COLOR);
        painter.rect_filled(world_rect.intersect(rect), 0u8, OFFWORLD_COLOR);

        let terrain = self.terrain.as_ref();
        if let Some(t) = terrain {
            let key = terrain_key(t, &opts.terrain_style, &opts.terrain_palette, opts.contour_interval_m, opts.world_width_km, opts.world_height_km);
            if cache.key != key || cache.colors.len() != t.data.len() {
                cache = build_terrain_cache(t, &opts, key);
            }
            if opts.terrain_style != "flat" {
                let sx = opts.world_width_km / (t.cols - 1) as f32;
                let sy = opts.world_height_km / (t.rows - 1) as f32;
                let c0 = (((vis_min_x + half_w) / sx).floor() as i64 - 1).clamp(0, t.cols as i64 - 1) as usize;
                let c1 = (((vis_max_x + half_w) / sx).ceil() as i64 + 1).clamp(0, t.cols as i64 - 1) as usize;
                let r0 = (((half_h - vis_max_y) / sy).floor() as i64 - 1).clamp(0, t.rows as i64 - 1) as usize;
                let r1 = (((half_h - vis_min_y) / sy).ceil() as i64 + 1).clamp(0, t.rows as i64 - 1) as usize;
                if c1 > c0 && r1 > r0 {
                    // Cells smaller than ~2px are merged so a zoomed-out view stays cheap.
                    let step = ((2.0 / (sx * zoom)).floor() as usize).max(1);
                    let mut col_idx: Vec<usize> = (c0..=c1).step_by(step).collect();
                    if *col_idx.last().unwrap() != c1 {
                        col_idx.push(c1);
                    }
                    let mut row_idx: Vec<usize> = (r0..=r1).step_by(step).collect();
                    if *row_idx.last().unwrap() != r1 {
                        row_idx.push(r1);
                    }
                    let nc = col_idx.len();
                    let mut verts = Vec::with_capacity(nc * row_idx.len());
                    for &r in &row_idx {
                        let wy = half_h - r as f32 * sy;
                        for &c in &col_idx {
                            let p = w2s(-half_w + c as f32 * sx, wy);
                            verts.push(Vertex::new(p.x, p.y, 0.0, cache.colors[r * t.cols + c]));
                        }
                    }
                    let mut idx = Vec::with_capacity((nc - 1) * (row_idx.len() - 1) * 6);
                    for ri in 0..row_idx.len() - 1 {
                        for ci in 0..nc - 1 {
                            let a = (ri * nc + ci) as u32;
                            let b = a + 1;
                            let c = a + nc as u32;
                            let d = c + 1;
                            idx.extend_from_slice(&[a, b, d, a, d, c]);
                        }
                    }
                    painter.mesh(verts, idx);
                }
            }
        }

        // -----------------------------------------------------------------------------------------
        // 2. Contours (traced from the terrain, or the hand-drawn bands without one)
        // -----------------------------------------------------------------------------------------
        let on_dark = opts.terrain_style == "flat" || terrain.is_none();
        let mut contour_labels: Vec<Rect> = Vec::new();
        if terrain.is_some() {
            let interval_px = cache.interval_m / (cache.max_m - cache.min_m).max(1.0) * opts.world_width_km.min(opts.world_height_km) * zoom;
            let show_half = zoom > fit_zoom * 2.4 || interval_px > 600.0;
            let ink: Color32 = match opts.terrain_style.as_str() {
                "relief" => Color32::from_rgb(70, 48, 26),
                "flat" => Color32::from_rgb(140, 200, 170),
                _ => Color32::from_rgb(10, 12, 18),
            };
            for cp in &cache.contours {
                if cp.bbox[2] < vis_min_x || cp.bbox[0] > vis_max_x || cp.bbox[3] < vis_min_y || cp.bbox[1] > vis_max_y {
                    continue;
                }
                let pts: Vec<Pos2> = cp.points.iter().map(|q| w2s(q[0], q[1])).collect();
                match cp.kind {
                    3 => {
                        polyline(&painter, &pts, Stroke::new(4.0, Color32::from_rgba_unmultiplied(200, 235, 250, 40)));
                        polyline(&painter, &pts, Stroke::new(1.4, Color32::from_rgba_unmultiplied(235, 245, 250, if on_dark { 210 } else { 170 })));
                    }
                    2 if opts.show_contours => polyline(&painter, &pts, Stroke::new(1.3, with_alpha(ink, if on_dark { 200 } else { 150 }))),
                    1 if opts.show_contours => polyline(&painter, &pts, Stroke::new(0.85, with_alpha(ink, if on_dark { 120 } else { 90 }))),
                    0 if opts.show_contours && show_half => polyline(&painter, &pts, Stroke::new(0.6, with_alpha(ink, if on_dark { 70 } else { 38 }))),
                    _ => {}
                }
                // Index contour labels, spaced along the line, never overlapping each other.
                if cp.kind == 2 && opts.show_contours && zoom > fit_zoom * 1.3 {
                    let mut run = 140.0;
                    for w in pts.windows(2) {
                        run += (w[1].x - w[0].x).hypot(w[1].y - w[0].y);
                        if run < 320.0 || !rect.shrink(30.0).contains(w[1]) {
                            continue;
                        }
                        let label = format!("{:.0}", cp.level);
                        let r = Rect::from_center_size(w[1], vec2(label.len() as f32 * 6.0 + 6.0, 12.0));
                        if contour_labels.iter().any(|o| o.intersect(r).is_positive()) {
                            continue;
                        }
                        contour_labels.push(r);
                        let col = if on_dark { Color32::from_rgb(170, 220, 190) } else { with_alpha(ink, 230) };
                        let halo = if opts.terrain_style == "relief" { Color32::from_rgba_unmultiplied(235, 228, 205, 170) } else { HALO };
                        text_halo(&painter, w[1], Align2::CENTER_CENTER, &label, FontId::proportional(8.5), col, halo);
                        run = 0.0;
                    }
                }
            }
        } else if opts.show_contours {
            for band in &self.elevation_bands {
                let pts: Vec<Pos2> = band.points.iter().map(|p| w2s(p[0], p[1])).collect();
                let col = if band.color[3] > 0.05 { rgba([band.color[0], band.color[1], band.color[2], band.color[3].max(0.5)]) } else { ACCENT_EMERALD };
                polyline(&painter, &pts, Stroke::new(1.2, col));
                if zoom >= fit_zoom * 1.2 && pts.len() > 2 {
                    let mid = pts[pts.len() / 2];
                    text_halo(&painter, mid, Align2::CENTER_CENTER, &format!("{:.0}m", band.elevation), FontId::proportional(8.5), col, HALO);
                }
            }
        }

        // -----------------------------------------------------------------------------------------
        // 3. Grid
        // -----------------------------------------------------------------------------------------
        let grid_step = nice_step(70.0 / zoom, &[0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]);
        if opts.show_grid {
            let line_col = if on_dark { Color32::from_rgba_unmultiplied(255, 255, 255, 14) } else { Color32::from_rgba_unmultiplied(20, 24, 32, 30) };
            let major_col = if on_dark { Color32::from_rgba_unmultiplied(255, 255, 255, 30) } else { Color32::from_rgba_unmultiplied(20, 24, 32, 55) };
            let gx0 = (vis_min_x.max(-half_w) / grid_step).ceil() as i64;
            let gx1 = (vis_max_x.min(half_w) / grid_step).floor() as i64;
            let gy0 = (vis_min_y.max(-half_h) / grid_step).ceil() as i64;
            let gy1 = (vis_max_y.min(half_h) / grid_step).floor() as i64;
            let top = world_rect.min.y.max(rect.min.y);
            let bottom = world_rect.max.y.min(rect.max.y);
            let left = world_rect.min.x.max(rect.min.x);
            let right = world_rect.max.x.min(rect.max.x);
            for gi in gx0..=gx1 {
                let x = w2s(gi as f32 * grid_step, 0.0).x;
                let col = if gi % 5 == 0 { major_col } else { line_col };
                painter.line_segment([pos2(x, top), pos2(x, bottom)], Stroke::new(1.0, col));
            }
            for gi in gy0..=gy1 {
                let y = w2s(0.0, gi as f32 * grid_step).y;
                let col = if gi % 5 == 0 { major_col } else { line_col };
                painter.line_segment([pos2(left, y), pos2(right, y)], Stroke::new(1.0, col));
            }
            // Coordinate labels along the top and left edges, on the major lines.
            let fmt = |v: f32| if grid_step >= 1.0 { format!("{:.0} km", v) } else { format!("{:.0} m", v * 1000.0) };
            for gi in gx0..=gx1 {
                if gi % 5 != 0 {
                    continue;
                }
                let x = w2s(gi as f32 * grid_step, 0.0).x;
                text_halo(&painter, pos2(x + 3.0, rect.min.y + 34.0), Align2::LEFT_CENTER, &fmt(gi as f32 * grid_step), FontId::proportional(9.0), TEXT_DIM, HALO);
            }
            for gi in gy0..=gy1 {
                if gi % 5 != 0 || gi == 0 {
                    continue;
                }
                let y = w2s(0.0, gi as f32 * grid_step).y;
                text_halo(&painter, pos2(rect.min.x + 6.0, y - 7.0), Align2::LEFT_CENTER, &fmt(gi as f32 * grid_step), FontId::proportional(9.0), TEXT_DIM, HALO);
            }
        }
        painter.rect_stroke(world_rect, 0u8, Stroke::new(1.5, Color32::from_rgba_unmultiplied(255, 255, 255, 60)), StrokeKind::Middle);

        // -----------------------------------------------------------------------------------------
        // 4. Regions
        // -----------------------------------------------------------------------------------------
        let mut region_labels: Vec<(Pos2, String, Color32, bool)> = Vec::new();
        if opts.show_biomes {
            for (i, reg) in self.regions.iter().enumerate() {
                if (opts.blocking_mode && !reg.is_major) || reg.points.len() < 3 {
                    continue;
                }
                let pts: Vec<Pos2> = reg.points.iter().map(|p| w2s(p[0], p[1])).collect();
                let selected = opts.selected_id.as_deref() == Some(reg.id.as_str());
                let hovered = hover == Hover::Region(i);
                let base_alpha = if terrain.is_some() && opts.terrain_style != "flat" { reg.fill_color[3] * 0.7 } else { reg.fill_color[3] };
                let fill_alpha = if selected { (base_alpha + 0.16).min(0.6) } else if hovered { (base_alpha + 0.1).min(0.5) } else { base_alpha };
                let fill = rgba([reg.fill_color[0], reg.fill_color[1], reg.fill_color[2], fill_alpha]);
                painter.add(Shape::convex_polygon(pts.clone(), fill, Stroke::NONE));
                let border = if selected { ACCENT_CYAN } else if hovered { Color32::from_white_alpha(220) } else { rgba(reg.border_color) };
                let mut closed = pts.clone();
                closed.push(pts[0]);
                let political = matches!(reg.region_type.as_str(), "kingdom" | "province");
                let w = if selected { 2.6 } else if political { 2.0 } else { 1.5 };
                // A soft dark under-stroke keeps light borders readable on light terrain.
                polyline(&painter, &closed, Stroke::new(w + 2.0, Color32::from_rgba_unmultiplied(10, 12, 18, 70)));
                if political && !selected {
                    dashed_polyline(&painter, &closed, Stroke::new(w, border), 10.0, 6.0);
                } else if reg.region_type == "danger" && !selected {
                    dashed_polyline(&painter, &closed, Stroke::new(w, border), 4.0, 4.0);
                } else {
                    polyline(&painter, &closed, Stroke::new(w, border));
                }
                if selected {
                    for p in &pts {
                        painter.circle_filled(*p, 4.0, ACCENT_CYAN);
                        painter.circle_stroke(*p, 4.5, Stroke::new(1.0, INK));
                    }
                }
                region_labels.push((polygon_centroid(&pts), reg.name.to_uppercase(), lighten(rgba([reg.border_color[0], reg.border_color[1], reg.border_color[2], 1.0]), 0.55), selected));
            }
        }

        // -----------------------------------------------------------------------------------------
        // 5. Paths: casings first, then fills, so crossings merge; rivers under roads.
        // -----------------------------------------------------------------------------------------
        let zoom_scale = (zoom / fit_zoom.max(0.01)).powf(0.45).clamp(0.6, 2.6);
        let path_visible = |p: &MapPath| !(opts.blocking_mode && !p.is_major) && p.points.len() >= 2;
        let screen_pts = |p: &MapPath| -> Vec<Pos2> { p.points.iter().map(|q| w2s(q[0], q[1])).collect() };
        // Rivers.
        for (i, path) in self.paths.iter().enumerate() {
            if !path_visible(path) || path.path_type != "river" {
                continue;
            }
            let pts = screen_pts(path);
            let base = (path.width * 0.55 * zoom_scale).clamp(1.2, 14.0);
            let n = pts.len().max(2) as f32;
            let water = Color32::from_rgb(86, 168, 228);
            let bank = Color32::from_rgba_unmultiplied(18, 52, 96, 150);
            for pass in 0..2 {
                for (k, w) in pts.windows(2).enumerate() {
                    let taper = 0.35 + 0.65 * ((k as f32 + 1.0) / (n - 1.0)).min(1.0);
                    let wpx = base * taper;
                    let (col, width) = if pass == 0 { (bank, wpx + 2.0) } else { (water, wpx) };
                    painter.line_segment([w[0], w[1]], Stroke::new(width, col));
                    if width > 2.5 {
                        painter.circle_filled(w[1], width * 0.5, col);
                    }
                }
            }
            // Flow chevrons, pointing downstream.
            if path.flow_speed > 0.0 && zoom > fit_zoom * 1.5 {
                let mut run = 0.0;
                for w in pts.windows(2) {
                    let seg = (w[1].x - w[0].x).hypot(w[1].y - w[0].y);
                    run += seg;
                    if run > 110.0 && seg > 1.0 {
                        run = 0.0;
                        let dir = vec2((w[1].x - w[0].x) / seg, (w[1].y - w[0].y) / seg);
                        let m = pos2((w[0].x + w[1].x) * 0.5, (w[0].y + w[1].y) * 0.5);
                        let back = pos2(m.x - dir.x * 4.0, m.y - dir.y * 4.0);
                        let nrm = vec2(-dir.y, dir.x);
                        let tip = pos2(m.x + dir.x * 2.0, m.y + dir.y * 2.0);
                        let col = Color32::from_rgba_unmultiplied(230, 245, 255, 200);
                        painter.line_segment([pos2(back.x + nrm.x * 3.0, back.y + nrm.y * 3.0), tip], Stroke::new(1.2, col));
                        painter.line_segment([pos2(back.x - nrm.x * 3.0, back.y - nrm.y * 3.0), tip], Stroke::new(1.2, col));
                    }
                }
            }
            if opts.selected_id.as_deref() == Some(path.id.as_str()) || hover == Hover::Path(i) {
                let sel = opts.selected_id.as_deref() == Some(path.id.as_str());
                polyline(&painter, &pts, Stroke::new(base + 6.0, if sel { Color32::from_rgba_unmultiplied(56, 189, 248, 110) } else { Color32::from_white_alpha(70) }));
            }
        }
        // Roads: casing pass, then fill pass.
        let road_width = |p: &MapPath| -> f32 { (p.width * 0.6 * zoom_scale).clamp(1.2, 11.0) };
        for path in self.paths.iter().filter(|p| path_visible(p) && matches!(p.path_type.as_str(), "highway" | "road" | "bridge")) {
            let pts = screen_pts(path);
            let w = road_width(path);
            let casing = if path.path_type == "bridge" { Color32::from_rgb(40, 46, 58) } else { Color32::from_rgba_unmultiplied(28, 22, 16, 210) };
            polyline(&painter, &pts, Stroke::new(w + if path.path_type == "highway" { 3.2 } else { 2.2 }, casing));
        }
        for (i, path) in self.paths.iter().enumerate() {
            if !path_visible(path) || path.path_type == "river" {
                continue;
            }
            let pts = screen_pts(path);
            let w = road_width(path);
            match path.path_type.as_str() {
                "highway" => {
                    polyline(&painter, &pts, Stroke::new(w, rgba(path.color)));
                    if w > 4.0 {
                        dashed_polyline(&painter, &pts, Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 248, 220, 200)), 8.0, 7.0);
                    }
                }
                "bridge" => {
                    polyline(&painter, &pts, Stroke::new(w, Color32::from_rgb(205, 214, 226)));
                    dashed_polyline(&painter, &pts, Stroke::new(w * 0.9, Color32::from_rgb(150, 160, 175)), 1.5, 3.0);
                }
                "trail" => {
                    dashed_polyline(&painter, &pts, Stroke::new(w + 1.6, Color32::from_rgba_unmultiplied(28, 22, 16, 150)), 7.0, 5.0);
                    dashed_polyline(&painter, &pts, Stroke::new(w, lighten(rgba(path.color), 0.15)), 7.0, 5.0);
                }
                _ => polyline(&painter, &pts, Stroke::new(w, rgba(path.color))),
            }
            let selected = opts.selected_id.as_deref() == Some(path.id.as_str());
            if selected || hover == Hover::Path(i) {
                polyline(&painter, &pts, Stroke::new(w + 6.0, if selected { Color32::from_rgba_unmultiplied(56, 189, 248, 110) } else { Color32::from_white_alpha(70) }));
            }
            if selected {
                for p in &pts {
                    painter.circle_filled(*p, 3.5, ACCENT_CYAN);
                    painter.circle_stroke(*p, 4.5, Stroke::new(1.0, INK));
                }
            }
        }
        // River vertex handles when selected (drawn after roads).
        for path in self.paths.iter().filter(|p| p.path_type == "river" && opts.selected_id.as_deref() == Some(p.id.as_str())) {
            for p in screen_pts(path) {
                painter.circle_filled(p, 3.5, ACCENT_CYAN);
            }
        }

        // Region names go above roads, below spots.
        for (c, name, col, selected) in &region_labels {
            if rect.contains(*c) && opts.show_labels {
                let font = FontId::proportional(if zoom > fit_zoom * 1.5 { 12.5 } else { 11.0 });
                text_pill(&painter, &ctx, *c, Align2::CENTER_CENTER, name, font, if *selected { ACCENT_CYAN } else { *col }, Color32::from_rgba_unmultiplied(10, 14, 22, 150));
            }
        }

        // -----------------------------------------------------------------------------------------
        // 6. Spots (major first for label priority; drawn minor first so majors sit on top)
        // -----------------------------------------------------------------------------------------
        let mut order: Vec<usize> = (0..self.spots.len()).filter(|&i| visible_spot(&self.spots[i])).collect();
        order.sort_by_key(|&i| {
            let s = &self.spots[i];
            (s.spot_type == "capital", s.is_major)
        });
        let mut label_rects: Vec<Rect> = Vec::new();
        let mut labels: Vec<(Pos2, String, Color32, f32)> = Vec::new();
        // Labels claim space most-important-first.
        let mut label_order = order.clone();
        label_order.reverse();
        let spot_pos = |s: &MapSpot| -> Pos2 {
            match &drag_preview {
                Some((id, p)) if *id == s.id => w2s(p.x, p.y),
                _ => w2s(s.x, s.y),
            }
        };
        for &i in &label_order {
            let s = &self.spots[i];
            let sp = spot_pos(s);
            if !rect.expand(40.0).contains(sp) {
                continue;
            }
            let selected = opts.selected_id.as_deref() == Some(s.id.as_str());
            // Every label that fits is shown; collisions (checked below, most important first) declutter.
            let show = opts.show_labels && (s.is_major || selected || hover == Hover::Spot(i) || zoom > fit_zoom * 0.8);
            if !show {
                continue;
            }
            let r = spot_radius(s);
            let size = if s.spot_type == "capital" { 12.0 } else if s.is_major { 11.0 } else { 10.0 };
            let tw = Painter::measure_text(&ctx, FontId::proportional(size), &s.name).x;
            let lr = Rect::from_min_size(pos2(sp.x - tw * 0.5 - 2.0, sp.y + r + 3.0), vec2(tw + 4.0, size + 3.0));
            if !selected && hover != Hover::Spot(i) && label_rects.iter().any(|o| o.intersect(lr).is_positive()) {
                continue;
            }
            label_rects.push(lr);
            let col = if selected { ACCENT_CYAN } else if s.is_major { TEXT_BRIGHT } else { Color32::from_rgb(214, 222, 236) };
            labels.push((pos2(sp.x, sp.y + r + 4.0), s.name.clone(), col, size));
        }
        for &i in &order {
            let s = &self.spots[i];
            let sp = spot_pos(s);
            if !rect.expand(20.0).contains(sp) {
                continue;
            }
            let selected = opts.selected_id.as_deref() == Some(s.id.as_str());
            let hovered = hover == Hover::Spot(i);
            let r = spot_radius(s);
            if selected {
                painter.circle_filled(sp, r + 8.0, Color32::from_rgba_unmultiplied(56, 189, 248, 40));
                painter.circle_stroke(sp, r + 5.0, Stroke::new(2.0, ACCENT_CYAN));
            } else if hovered {
                painter.circle_stroke(sp, r + 4.0, Stroke::new(1.5, Color32::from_white_alpha(170)));
            }
            painter.circle_filled(pos2(sp.x + 1.0, sp.y + 2.0), r + 2.0, Color32::from_rgba_unmultiplied(0, 0, 0, 90));
            painter.circle_filled(sp, r + 2.0, if s.is_major { Color32::from_rgb(245, 240, 225) } else { INK });
            painter.circle_filled(sp, r, rgba(s.color));
            painter.text(sp, Align2::CENTER_CENTER, icon(spot_icon_name(&s.spot_type)), FontId::proportional(r * 1.15), INK);
        }
        for (p, name, col, size) in &labels {
            text_pill(&painter, &ctx, *p, Align2::CENTER_TOP, name, FontId::proportional(*size), *col, Color32::from_rgba_unmultiplied(10, 14, 22, 175));
        }
        // Drag tether.
        if let (Some((_, target)), Some(start)) = (&drag_preview, st.drag_start_world) {
            let a = w2s(start.x, start.y);
            let b = w2s(target.x, target.y);
            dashed_polyline(&painter, &[a, b], Stroke::new(1.5, ACCENT_AMBER), 5.0, 4.0);
            painter.circle_stroke(a, 4.0, Stroke::new(1.2, ACCENT_AMBER));
            let km = (target.x - start.x).hypot(target.y - start.y);
            let elev = self.sample(target.x, target.y).map(|e| format!("  ▲{:.0} m", e)).unwrap_or_default();
            text_halo(&painter, pos2(b.x + 14.0, b.y - 14.0), Align2::LEFT_CENTER, &format!("[{:.2}, {:.2}] km  Δ{:.2} km{}", target.x, target.y, km, elev), FontId::proportional(10.0), TEXT_BRIGHT, HALO);
        }

        // -----------------------------------------------------------------------------------------
        // 7. Pending path / region with rubber band and live length
        // -----------------------------------------------------------------------------------------
        if !opts.pending_points.is_empty() {
            let is_region = opts.pending_mode.as_deref() == Some("region") || opts.active_tool == "draw_region";
            let accent = if is_region { ACCENT_EMERALD } else { ACCENT_CYAN };
            let mut pts: Vec<Pos2> = opts.pending_points.iter().map(|p| w2s(p[0], p[1])).collect();
            let mut length_km: f32 = opts.pending_points.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum();
            let cursor = cursor_world.filter(|_| is_hovered);
            if let Some(cw) = cursor {
                let last = opts.pending_points.last().unwrap();
                length_km += (cw.x - last[0]).hypot(cw.y - last[1]);
                pts.push(w2s(cw.x, cw.y));
            }
            if is_region && pts.len() >= 3 {
                painter.add(Shape::convex_polygon(pts.clone(), with_alpha(accent, 40), Stroke::NONE));
                dashed_polyline(&painter, &[*pts.last().unwrap(), pts[0]], Stroke::new(1.2, with_alpha(accent, 170)), 5.0, 4.0);
            }
            let placed = opts.pending_points.len();
            polyline(&painter, &pts[..placed], Stroke::new(4.5, Color32::from_rgba_unmultiplied(8, 11, 17, 160)));
            polyline(&painter, &pts[..placed], Stroke::new(2.5, accent));
            if cursor.is_some() {
                dashed_polyline(&painter, &pts[placed - 1..], Stroke::new(1.8, accent), 6.0, 4.0);
            }
            for (k, p) in pts[..placed].iter().enumerate() {
                painter.circle_filled(*p, 6.5, INK);
                painter.circle_filled(*p, 5.0, accent);
                painter.text(*p, Align2::CENTER_CENTER, format!("{}", k + 1), FontId::proportional(8.0), INK);
            }
            if let Some(cw) = cursor {
                let cp = w2s(cw.x, cw.y);
                painter.circle_stroke(cp, 7.0, Stroke::new(1.5, accent));
                let what = if is_region { format!("{} vertices", placed + 1) } else { format!("{:.2} km", length_km) };
                text_halo(&painter, pos2(cp.x + 12.0, cp.y - 12.0), Align2::LEFT_CENTER, &what, FontId::proportional(10.5), TEXT_BRIGHT, HALO);
            }
        } else if matches!(opts.active_tool.as_str(), "draw_path" | "draw_region" | "place_spot") {
            if let Some(cw) = cursor_world.filter(|_| is_hovered) {
                let cp = w2s(cw.x, cw.y);
                let accent = if opts.active_tool == "place_spot" { ACCENT_AMBER } else { ACCENT_CYAN };
                painter.circle_stroke(cp, 7.0, Stroke::new(1.5, accent));
                painter.line_segment([pos2(cp.x - 11.0, cp.y), pos2(cp.x - 4.0, cp.y)], Stroke::new(1.2, accent));
                painter.line_segment([pos2(cp.x + 4.0, cp.y), pos2(cp.x + 11.0, cp.y)], Stroke::new(1.2, accent));
                painter.line_segment([pos2(cp.x, cp.y - 11.0), pos2(cp.x, cp.y - 4.0)], Stroke::new(1.2, accent));
                painter.line_segment([pos2(cp.x, cp.y + 4.0), pos2(cp.x, cp.y + 11.0)], Stroke::new(1.2, accent));
            }
        }

        // -----------------------------------------------------------------------------------------
        // 8. Measure: the finished ruler, or a live one from the anchor to the cursor
        // -----------------------------------------------------------------------------------------
        let draw_ruler = |a_w: Pos2, b_w: Pos2, label: String| {
            let a = w2s(a_w.x, a_w.y);
            let b = w2s(b_w.x, b_w.y);
            polyline(&painter, &[a, b], Stroke::new(5.0, Color32::from_rgba_unmultiplied(8, 11, 17, 170)));
            dashed_polyline(&painter, &[a, b], Stroke::new(2.4, ACCENT_AMBER), 10.0, 6.0);
            // A tick every kilometer (or every 100 m when close).
            let km = (b_w.x - a_w.x).hypot(b_w.y - a_w.y);
            let tick = if km * zoom / 1.0 > 40.0 * km.max(0.001) { 1.0 } else { 5.0 };
            let tick = if km < 2.0 { 0.1 } else { tick };
            let len = (b.x - a.x).hypot(b.y - a.y).max(1e-3);
            let nrm = vec2(-(b.y - a.y) / len, (b.x - a.x) / len);
            let n_ticks = ((km / tick).floor() as usize).min(200);
            for k in 1..=n_ticks {
                let f = k as f32 * tick / km.max(1e-6);
                let p = pos2(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
                painter.line_segment([pos2(p.x - nrm.x * 4.0, p.y - nrm.y * 4.0), pos2(p.x + nrm.x * 4.0, p.y + nrm.y * 4.0)], Stroke::new(1.2, ACCENT_AMBER));
            }
            for p in [a, b] {
                painter.circle_filled(p, 5.0, INK);
                painter.circle_filled(p, 3.8, ACCENT_AMBER);
            }
            let mid = pos2((a.x + b.x) * 0.5, (a.y + b.y) * 0.5 - 18.0);
            let tw = Painter::measure_text(&ctx, FontId::proportional(11.0), &label).x;
            let pill = Rect::from_center_size(mid, vec2(tw + 18.0, 22.0));
            painter.rect_filled(pill, 5u8, PANEL_BG);
            painter.rect_stroke(pill, 5u8, Stroke::new(1.2, ACCENT_AMBER), StrokeKind::Middle);
            painter.text(mid, Align2::CENTER_CENTER, label, FontId::proportional(11.0), TEXT_BRIGHT);
        };
        let climb = |a: Pos2, b: Pos2| -> String {
            match (self.sample(a.x, a.y), self.sample(b.x, b.y)) {
                (Some(ea), Some(eb)) => format!("  {}{:.0} m", if eb >= ea { "▲" } else { "▼" }, (eb - ea).abs()),
                _ => String::new(),
            }
        };
        if let Some(m) = self.measure.as_ref().filter(|m| m.active) {
            let (a, b) = (pos2(m.p1[0], m.p1[1]), pos2(m.p2[0], m.p2[1]));
            let label = if m.travel_info.is_empty() { format!("{:.2} km{}", m.distance_km, climb(a, b)) } else { format!("{:.2} km{}  |  {}", m.distance_km, climb(a, b), m.travel_info) };
            draw_ruler(a, b, label);
        } else if let (Some(anchor), Some(cw)) = (opts.measure_anchor, cursor_world.filter(|_| is_hovered)) {
            let a = pos2(anchor[0], anchor[1]);
            draw_ruler(a, cw, format!("{:.2} km{}  —  click to finish", (cw.x - a.x).hypot(cw.y - a.y), climb(a, cw)));
        } else if let Some(anchor) = opts.measure_anchor {
            let a = w2s(anchor[0], anchor[1]);
            painter.circle_filled(a, 5.0, INK);
            painter.circle_filled(a, 3.8, ACCENT_AMBER);
        }

        // -----------------------------------------------------------------------------------------
        // 9. Tooltip
        // -----------------------------------------------------------------------------------------
        if let (Some(p), false) = (pointer_pos, st.is_panning || st.drag_moved) {
            let lines: Vec<(String, Color32, f32)> = match hover {
                Hover::Spot(i) => {
                    let s = &self.spots[i];
                    let mut l = vec![
                        (format!("{}  ·  {}", s.name, s.spot_type), TEXT_BRIGHT, 11.5),
                        (format!("[{:.2}, {:.2}] km   ▲ {:.0} m", s.x, s.y, s.elevation), TEXT_DIM, 10.0),
                    ];
                    if !s.tags.is_empty() {
                        l.push((s.tags.join(", "), ACCENT_EMERALD, 9.5));
                    }
                    l
                }
                Hover::Path(i) => {
                    let path = &self.paths[i];
                    let km: f32 = path.points.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum();
                    vec![(format!("{}  ·  {}", path.name, path.path_type), TEXT_BRIGHT, 11.5), (format!("{:.2} km  ·  {} points", km, path.points.len()), TEXT_DIM, 10.0)]
                }
                Hover::Region(i) => {
                    let r = &self.regions[i];
                    vec![(format!("{}  ·  {}", r.name, r.region_type), TEXT_BRIGHT, 11.5), (format!("{} vertices", r.points.len()), TEXT_DIM, 10.0)]
                }
                Hover::None => vec![],
            };
            if !lines.is_empty() && !drawing {
                let w = lines.iter().map(|(t, _, s)| Painter::measure_text(&ctx, FontId::proportional(*s), t).x).fold(0.0, f32::max) + 20.0;
                let h = lines.len() as f32 * 15.0 + 10.0;
                let mut origin = pos2(p.x + 16.0, p.y + 16.0);
                if origin.x + w > rect.max.x - 8.0 {
                    origin.x = p.x - w - 12.0;
                }
                if origin.y + h > rect.max.y - 8.0 {
                    origin.y = p.y - h - 12.0;
                }
                let tip = Rect::from_min_size(origin, vec2(w, h));
                painter.rect_filled(tip, 5u8, PANEL_BG);
                painter.rect_stroke(tip, 5u8, Stroke::new(1.0, BORDER_COLOR), StrokeKind::Middle);
                for (k, (t, c, s)) in lines.iter().enumerate() {
                    painter.text(pos2(origin.x + 10.0, origin.y + 12.0 + k as f32 * 15.0), Align2::LEFT_CENTER, t, FontId::proportional(*s), *c);
                }
            }
        }

        // -----------------------------------------------------------------------------------------
        // 10. Mini-map
        // -----------------------------------------------------------------------------------------
        if opts.show_minimap {
            painter.rect_filled(minimap_rect.expand(1.0), 5u8, Color32::from_rgba_unmultiplied(0, 0, 0, 120));
            painter.rect_filled(minimap_rect, 5u8, PANEL_BG);
            let inner = minimap_rect.shrink(4.0);
            let mini = painter.with_clip_rect(inner);
            let w2m = |wx: f32, wy: f32| -> Pos2 {
                pos2(inner.min.x + ((wx / opts.world_width_km) + 0.5).clamp(0.0, 1.0) * inner.width(), inner.min.y + (0.5 - wy / opts.world_height_km).clamp(0.0, 1.0) * inner.height())
            };
            if let Some(t) = terrain.filter(|_| !cache.colors.is_empty()) {
                let step = ((t.cols as f32 / 48.0).ceil() as usize).max(1);
                let cols_i: Vec<usize> = (0..t.cols).step_by(step).chain(std::iter::once(t.cols - 1)).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
                let rows_i: Vec<usize> = (0..t.rows).step_by(step).chain(std::iter::once(t.rows - 1)).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
                let nc = cols_i.len();
                let mut verts = Vec::with_capacity(nc * rows_i.len());
                for &r in &rows_i {
                    for &c in &cols_i {
                        let x = inner.min.x + c as f32 / (t.cols - 1) as f32 * inner.width();
                        let y = inner.min.y + r as f32 / (t.rows - 1) as f32 * inner.height();
                        let mut col = cache.colors[r * t.cols + c];
                        col[3] = 0.9;
                        verts.push(Vertex::new(x, y, 0.0, col));
                    }
                }
                let mut idx = Vec::new();
                for ri in 0..rows_i.len() - 1 {
                    for ci in 0..nc - 1 {
                        let a = (ri * nc + ci) as u32;
                        idx.extend_from_slice(&[a, a + 1, a + 1 + nc as u32, a, a + 1 + nc as u32, a + nc as u32]);
                    }
                }
                mini.mesh(verts, idx);
            }
            for reg in &self.regions {
                if reg.points.len() >= 3 {
                    let pts: Vec<Pos2> = reg.points.iter().map(|p| w2m(p[0], p[1])).collect();
                    let mut closed = pts.clone();
                    closed.push(pts[0]);
                    polyline(&mini, &closed, Stroke::new(1.0, rgba([reg.border_color[0], reg.border_color[1], reg.border_color[2], 0.8])));
                }
            }
            for path in &self.paths {
                let pts: Vec<Pos2> = path.points.iter().map(|p| w2m(p[0], p[1])).collect();
                let col = if path.path_type == "river" { Color32::from_rgb(110, 185, 240) } else { rgba([path.color[0], path.color[1], path.color[2], 0.9]) };
                polyline(&mini, &pts, Stroke::new(1.0, col));
            }
            for s in &self.spots {
                let p = w2m(s.x, s.y);
                mini.circle_filled(p, if s.is_major { 2.8 } else { 1.8 }, INK);
                mini.circle_filled(p, if s.is_major { 2.0 } else { 1.2 }, rgba(s.color));
            }
            let a = w2m(world_tl.x, world_tl.y);
            let b = w2m(world_br.x, world_br.y);
            let frame = Rect::from_min_max(pos2(a.x.min(b.x), a.y.min(b.y)), pos2(a.x.max(b.x), a.y.max(b.y)));
            mini.rect_filled(frame, 0u8, Color32::from_rgba_unmultiplied(56, 189, 248, 30));
            mini.rect_stroke(frame, 0u8, Stroke::new(1.3, ACCENT_CYAN), StrokeKind::Middle);
            painter.rect_stroke(minimap_rect, 5u8, Stroke::new(1.0, BORDER_COLOR), StrokeKind::Middle);
        }

        // -----------------------------------------------------------------------------------------
        // 11. HUD: compass, zoom buttons, scale bar, legend, readout, tool hint, mode
        // -----------------------------------------------------------------------------------------
        let compass = pos2(rect.max.x - 27.0, rect.min.y + 30.0);
        painter.circle_filled(compass, 17.0, PANEL_BG);
        painter.circle_stroke(compass, 17.0, Stroke::new(1.0, BORDER_COLOR));
        let needle_n = [pos2(compass.x, compass.y - 12.0), pos2(compass.x + 4.5, compass.y), pos2(compass.x - 4.5, compass.y)];
        let needle_s = [pos2(compass.x, compass.y + 12.0), pos2(compass.x - 4.5, compass.y), pos2(compass.x + 4.5, compass.y)];
        painter.add(Shape::convex_polygon(needle_n.to_vec(), Color32::from_rgb(244, 63, 94), Stroke::NONE));
        painter.add(Shape::convex_polygon(needle_s.to_vec(), Color32::from_rgb(200, 208, 222), Stroke::NONE));
        painter.text(pos2(compass.x - 26.0, compass.y), Align2::CENTER_CENTER, "N", FontId::proportional(10.0), TEXT_BRIGHT);

        for (k, (name, r)) in zoom_btns.iter().enumerate() {
            let hovered = over_hud_btn == Some(k);
            painter.rect_filled(*r, 5u8, if hovered { Color32::from_rgba_unmultiplied(40, 52, 72, 240) } else { PANEL_BG });
            painter.rect_stroke(*r, 5u8, Stroke::new(1.0, if hovered { ACCENT_CYAN } else { BORDER_COLOR }), StrokeKind::Middle);
            painter.text(r.center(), Align2::CENTER_CENTER, glyph(name, IconStyle::Bold).map(|c| c.to_string()).unwrap_or_default(), FontId::proportional(13.0), TEXT_BRIGHT);
        }

        // Scale bar: a round distance about 120 px long.
        let scale_km = nice_step(120.0 / zoom, &[0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1.0, 2.0, 2.5, 5.0, 10.0, 20.0, 25.0, 50.0, 100.0]);
        let bar_len = scale_km * zoom;
        let bar_o = pos2(rect.min.x + 18.0, rect.max.y - 20.0);
        let bar_bg = Rect::from_min_max(pos2(bar_o.x - 8.0, bar_o.y - 22.0), pos2(bar_o.x + bar_len + 8.0, bar_o.y + 8.0));
        painter.rect_filled(bar_bg, 5u8, PANEL_BG);
        let half_len = bar_len * 0.5;
        painter.rect_filled(Rect::from_min_size(pos2(bar_o.x, bar_o.y - 3.0), vec2(half_len, 5.0)), 0u8, TEXT_BRIGHT);
        painter.rect_filled(Rect::from_min_size(pos2(bar_o.x + half_len, bar_o.y - 3.0), vec2(half_len, 5.0)), 0u8, Color32::from_rgb(70, 78, 96));
        painter.rect_stroke(Rect::from_min_size(pos2(bar_o.x, bar_o.y - 3.0), vec2(bar_len, 5.0)), 0u8, Stroke::new(1.0, TEXT_BRIGHT), StrokeKind::Middle);
        let scale_label = if scale_km >= 1.0 { format!("{} km", scale_km) } else { format!("{:.0} m", scale_km * 1000.0) };
        painter.text(pos2(bar_o.x + bar_len, bar_o.y - 8.0), Align2::RIGHT_BOTTOM, scale_label, FontId::proportional(9.5), TEXT_BRIGHT);
        painter.text(pos2(bar_o.x, bar_o.y - 8.0), Align2::LEFT_BOTTOM, "0", FontId::proportional(9.5), TEXT_DIM);

        // Legend: the color scale of the current terrain style.
        if terrain.is_some() && opts.terrain_style != "flat" {
            let lw = 190.0;
            let legend = Rect::from_min_size(pos2(rect.min.x + 10.0, rect.max.y - 104.0), vec2(lw + 20.0, 52.0));
            painter.rect_filled(legend, 5u8, PANEL_BG);
            painter.rect_stroke(legend, 5u8, Stroke::new(1.0, BORDER_COLOR), StrokeKind::Middle);
            let sea = terrain.map(|t| t.sea_level_m).unwrap_or(0.0);
            let (title, lo, hi) = match opts.terrain_style.as_str() {
                "slope" => ("SLOPE", "0°".to_string(), "55°+".to_string()),
                _ => ("ELEVATION", format!("{:.0} m", cache.min_m), format!("{:.0} m", cache.max_m)),
            };
            painter.text(pos2(legend.min.x + 10.0, legend.min.y + 10.0), Align2::LEFT_CENTER, title, FontId::proportional(8.5), TEXT_DIM);
            let bar = Rect::from_min_size(pos2(legend.min.x + 10.0, legend.min.y + 20.0), vec2(lw, 9.0));
            let n = 48;
            let span = (cache.max_m - cache.min_m).max(1.0);
            let sea_t = ((sea - cache.min_m) / span).clamp(0.0, 1.0);
            let color_at = |f: f32| -> Color32 {
                let c = match opts.terrain_style.as_str() {
                    "slope" => lerp3(slope_tint(f * 55.0), hex(0x9aa3a8), 0.22),
                    "heatmap" => {
                        let e = cache.min_m + f * span;
                        if e <= sea { lerp3(hex(0x1f2a44), hex(0x0b1020), ((sea - e) / (sea - cache.min_m).max(1.0)).sqrt()) } else { heat_tint(0.3 + 0.7 * (e - sea) / (cache.max_m - sea).max(1.0)) }
                    }
                    _ => {
                        let e = cache.min_m + f * span;
                        if e <= sea { water_tint(&opts.terrain_palette, ((sea - e) / (sea - cache.min_m).max(1.0)).powf(0.6)) } else { land_tint(&opts.terrain_palette, (e - sea) / (cache.max_m - sea).max(1.0)) }
                    }
                };
                rgba([c[0], c[1], c[2], 1.0])
            };
            for k in 0..n {
                let f0 = k as f32 / n as f32;
                let f1 = (k + 1) as f32 / n as f32;
                let r = Rect::from_min_max(pos2(bar.min.x + f0 * lw, bar.min.y), pos2(bar.min.x + f1 * lw, bar.max.y));
                let (c0, c1) = (color_at(f0), color_at(f1));
                painter.rect_filled_gradient(r, c0, c1, c0, c1);
            }
            painter.rect_stroke(bar, 0u8, Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 60)), StrokeKind::Middle);
            painter.text(pos2(bar.min.x, bar.max.y + 9.0), Align2::LEFT_CENTER, lo, FontId::proportional(8.5), TEXT_DIM);
            painter.text(pos2(bar.max.x, bar.max.y + 9.0), Align2::RIGHT_CENTER, hi, FontId::proportional(8.5), TEXT_DIM);
            if opts.terrain_style != "slope" && sea_t > 0.02 && sea_t < 0.98 {
                let x = bar.min.x + sea_t * lw;
                painter.line_segment([pos2(x, bar.min.y - 2.0), pos2(x, bar.max.y + 2.0)], Stroke::new(1.5, TEXT_BRIGHT));
                painter.text(pos2(x, bar.max.y + 9.0), Align2::CENTER_CENTER, "sea", FontId::proportional(8.5), TEXT_BRIGHT);
            }
            if opts.show_contours {
                painter.text(pos2(legend.max.x - 10.0, legend.min.y + 10.0), Align2::RIGHT_CENTER, format!("contours {:.0} m", cache.interval_m), FontId::proportional(8.5), TEXT_DIM);
            }
        }

        // Cursor readout: position, ground elevation and slope.
        let readout = if let Some(pw) = st.current_pointer_world {
            let p = snap(pw);
            let mut s = format!("{:+.2}, {:+.2} km", p.x, p.y);
            if let Some(e) = self.sample(p.x, p.y) {
                let d = 0.02 * opts.world_width_km.max(1.0) / 30.0;
                let gx = (self.sample(p.x + d, p.y).unwrap_or(e) - self.sample(p.x - d, p.y).unwrap_or(e)) / (2.0 * d * 1000.0);
                let gy = (self.sample(p.x, p.y + d).unwrap_or(e) - self.sample(p.x, p.y - d).unwrap_or(e)) / (2.0 * d * 1000.0);
                let slope = (gx * gx + gy * gy).sqrt().atan().to_degrees();
                let sea = terrain.map(|t| t.sea_level_m).unwrap_or(0.0);
                if e <= sea {
                    s.push_str(&format!("   ≈ {:.0} m deep", sea - e));
                } else {
                    s.push_str(&format!("   ▲ {:.0} m   slope {:.0}°", e, slope));
                }
            }
            if opts.grid_snap_m > 0.0 {
                s.push_str(&format!("   snap {:.0} m", opts.grid_snap_m));
            }
            s
        } else {
            format!("{:.0} × {:.0} km world   ·   {:.0} px/km", opts.world_width_km, opts.world_height_km, zoom)
        };
        let rw = Painter::measure_text(&ctx, FontId::proportional(10.0), &readout).x;
        let rr = Rect::from_min_size(pos2(rect.max.x - rw - 30.0, rect.max.y - 27.0), vec2(rw + 16.0, 20.0));
        painter.rect_filled(rr, 5u8, PANEL_BG);
        painter.text(rr.center(), Align2::CENTER_CENTER, readout, FontId::proportional(10.0), TEXT_BRIGHT);

        // Mode pill and tool hint, top-left.
        let (mode_label, mode_col) = if opts.blocking_mode { ("BLOCKING · macro layout", ACCENT_AMBER) } else { ("DETAILING · full map", ACCENT_EMERALD) };
        let hint = match opts.active_tool.as_str() {
            "pan" => "Drag to pan · wheel to zoom",
            "place_spot" => "Click to place a spot",
            "draw_path" if opts.pending_points.is_empty() => "Click to start a path · points snap to spots",
            "draw_path" => "Click to add points · double-click or Enter to finish · Esc cancels",
            "draw_region" if opts.pending_points.is_empty() => "Click to start a region outline",
            "draw_region" => "Click to add vertices · double-click or Enter to close · Esc cancels",
            "measure" if opts.measure_anchor.is_some() => "Click the destination",
            "measure" => "Click the start of the measurement",
            _ => "Click to select · drag spots to move · right-drag or Space-drag to pan",
        };
        let pill_font = FontId::proportional(9.5);
        let mw = Painter::measure_text(&ctx, pill_font.clone(), mode_label).x;
        let mode_rect = Rect::from_min_size(pos2(rect.min.x + 10.0, rect.min.y + 10.0), vec2(mw + 18.0, 19.0));
        painter.rect_filled(mode_rect, 5u8, PANEL_BG);
        painter.rect_stroke(mode_rect, 5u8, Stroke::new(1.0, mode_col), StrokeKind::Middle);
        painter.circle_filled(pos2(mode_rect.min.x + 8.0, mode_rect.center().y), 2.5, mode_col);
        painter.text(pos2(mode_rect.min.x + 14.0, mode_rect.center().y), Align2::LEFT_CENTER, mode_label, pill_font.clone(), mode_col);
        let hw = Painter::measure_text(&ctx, pill_font.clone(), hint).x;
        let hint_rect = Rect::from_min_size(pos2(mode_rect.max.x + 6.0, mode_rect.min.y), vec2(hw + 16.0, 19.0));
        painter.rect_filled(hint_rect, 5u8, PANEL_BG);
        painter.text(hint_rect.center(), Align2::CENTER_CENTER, hint, pill_font, TEXT_DIM);

        painter.rect_stroke(rect, 4u8, Stroke::new(1.0, BORDER_COLOR), StrokeKind::Middle);

        ctx.memory_mut(|m| {
            m.put_view_state(self.id, st);
            m.put_view_state(cache_id, cache);
        });
        GameMapResponse { events }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cone(n: usize) -> MapTerrain {
        let mut data = Vec::new();
        for r in 0..n {
            for c in 0..n {
                let dx = c as f32 - (n - 1) as f32 / 2.0;
                let dy = r as f32 - (n - 1) as f32 / 2.0;
                data.push(1000.0 - (dx * dx + dy * dy).sqrt() * 100.0);
            }
        }
        MapTerrain { cols: n, rows: n, data, sea_level_m: 0.0 }
    }

    #[test]
    fn isolines_of_a_cone_are_closed_rings_at_the_right_radius() {
        let t = cone(41);
        // 20 km world, 0.5 km per cell; 1000 - 100*cells = 500 at 5 cells = 2.5 km.
        let lines = trace_isolines(&t, 20.0, 20.0, 500.0);
        assert_eq!(lines.len(), 1, "one connected ring");
        let ring = &lines[0];
        assert!(ring.len() > 20);
        let first = ring[0];
        let last = ring[ring.len() - 1];
        assert!((first[0] - last[0]).abs() < 1e-4 && (first[1] - last[1]).abs() < 1e-4, "ring closes");
        for p in ring {
            let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
            assert!((r - 2.5).abs() < 0.2, "point at radius {r}");
        }
    }

    #[test]
    fn cache_traces_coastline_and_ranks_contours() {
        let t = cone(41);
        let opts = GameMapOptions { world_width_km: 20.0, world_height_km: 20.0, ..Default::default() };
        let cache = build_terrain_cache(&t, &opts, 1);
        assert_eq!(cache.colors.len(), 41 * 41);
        assert!(cache.contours.iter().any(|c| c.kind == 3), "a coastline at sea level");
        assert!(cache.contours.iter().any(|c| c.kind == 2), "index contours");
        assert!(cache.interval_m > 0.0);
        // Water is blue-ish, the summit is light.
        let corner = cache.colors[0];
        assert!(corner[2] > corner[0]);
    }
}

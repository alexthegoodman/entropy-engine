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

fn darken(c: Color32, f: f32) -> Color32 {
    let d = |v: u8| (v as f32 * (1.0 - f)) as u8;
    Color32::from_rgba_unmultiplied(d(c.r()), d(c.g()), d(c.b()), c.a())
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

/// A design intent sketched by the designer: a pin, an area outline or a route between two places,
/// with a live check of whether the world meets it.
#[derive(Clone, Debug, PartialEq)]
pub struct MapIntent {
    pub id: String,
    pub number: u32,
    /// "pin", "area" or "route".
    pub shape: String,
    /// "settle", "danger", "landmark", "connect", "pacing", "quest" or "freeform".
    pub kind: String,
    pub points: Vec<[f32; 2]>,
    pub title: String,
    /// One line: what the check found ("2 of 3 settlements").
    pub summary: String,
    /// "open", "claimed", "proposed", "done".
    pub status: String,
    /// `None` when nothing can be checked automatically.
    pub satisfied: Option<bool>,
    pub color: [f32; 4],
}

impl Default for MapIntent {
    fn default() -> Self {
        Self {
            id: String::new(),
            number: 0,
            shape: "pin".into(),
            kind: "freeform".into(),
            points: Vec::new(),
            title: String::new(),
            summary: String::new(),
            status: "open".into(),
            satisfied: None,
            color: [0.98, 0.78, 0.3, 1.0],
        }
    }
}

/// A change an agent proposed, previewed on the map until the designer accepts or rejects it.
#[derive(Clone, Debug, PartialEq)]
pub struct MapGhost {
    /// The change's id.
    pub id: String,
    /// "spot", "path", "region", "move" (a spot to a new place) or "remove".
    pub kind: String,
    pub points: Vec<[f32; 2]>,
    /// For a move: where the spot is now.
    pub from: Option<[f32; 2]>,
    pub label: String,
    pub spot_type: Option<String>,
    pub path_type: Option<String>,
}

impl Default for MapGhost {
    fn default() -> Self {
        Self { id: String::new(), kind: "spot".into(), points: Vec::new(), from: None, label: String::new(), spot_type: None, path_type: None }
    }
}

/// One painted planning layer: a density (0..1) per overlay cell, drawn as a tint plus symbols.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct MapOverlayLayer {
    pub key: String,
    pub label: String,
    pub color: [f32; 4],
    /// "tree", "grass", "dot", "hatch", "rock", "snow", "wave", "cross", "diamond", "square",
    /// "skull", "person" or "flag".
    pub glyph: String,
    pub data: Vec<f32>,
}

/// Painted planning marks (biomes, foliage, where enemies roam...) on a coarse grid of centered
/// cells over the whole world, row 0 along the north edge. Marks are symbols, not built content.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct MapOverlay {
    pub cols: usize,
    pub rows: usize,
    pub layers: Vec<MapOverlayLayer>,
}

impl MapOverlay {
    fn valid(&self) -> bool {
        self.cols >= 1 && self.rows >= 1 && self.layers.iter().all(|l| l.data.len() == self.cols * self.rows)
    }
}

/// A codex entry placed at one spot on the map: an NPC, an enemy camp, a faction outpost.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct MapMarker {
    pub id: String,
    pub label: String,
    /// A second tooltip line ("Enemy x4 · patrol").
    pub detail: String,
    pub x: f32,
    pub y: f32,
    pub color: [f32; 4],
    pub glyph: String,
    pub count: u32,
}

/// A quest's journey: giver, objectives, turn-in, drawn as a numbered dashed route.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct MapQuestRoute {
    pub id: String,
    pub title: String,
    pub points: Vec<[f32; 2]>,
    pub color: [f32; 4],
    pub highlighted: bool,
    /// Only the numbered stops, no connecting line: the quest has drawn quest paths of its own.
    pub markers_only: bool,
}

/// A planned building, wall, street or area (town planning), in world km. Footprints arrive as
/// convex `parts` to fill plus their `outline`; walls and streets as an open `outline` with a width
/// in meters; areas as a closed outline with triangle `parts`.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct MapStructure {
    pub id: String,
    pub kind: String,
    /// Drawn on the map once there is room (named structures); always in the tooltip.
    pub label: String,
    /// A second tooltip line ("House · 10 x 8 m · 2 floors").
    pub detail: String,
    pub parts: Vec<Vec<[f32; 2]>>,
    pub outline: Vec<[f32; 2]>,
    pub closed: bool,
    /// Walls and streets: width in meters; 0 for footprints and areas.
    pub line_width_m: f32,
    pub color: [f32; 4],
    /// The point a drag moves and a rotation turns about.
    pub anchor: [f32; 2],
    pub rotation_deg: f32,
    /// Footprints can be turned with a handle when selected.
    pub rotatable: bool,
}

/// What the Build tool will place, drawn under the cursor: shapes as km offsets from the cursor.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct MapBuildCursor {
    pub parts: Vec<Vec<[f32; 2]>>,
    pub outline: Vec<[f32; 2]>,
    pub color: [f32; 4],
}

/// The paint / sculpt brush under the cursor. With `paint`, a primary drag is reported as brush
/// strokes instead of clicks; without, the ring is only a size preview (clicks pass through).
#[derive(Clone, Debug, PartialEq)]
pub struct MapBrush {
    pub radius_km: f32,
    pub color: [f32; 4],
    pub paint: bool,
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
    pub show_intents: bool,
    pub show_proposals: bool,
    /// The proposed change (ghost) under review.
    pub selected_change_id: Option<String>,
    pub show_marks: bool,
    pub show_population: bool,
    pub show_quests: bool,
    pub brush: Option<MapBrush>,
    /// Bump to center the view on `focus_center` (zooming to `focus_zoom` px/km when given).
    pub focus_request: u32,
    pub focus_center: Option<[f32; 2]>,
    pub focus_zoom: Option<f32>,
    /// Surface detail when zoomed in past the heightfield's own resolution: 0 draws the grid as is
    /// (smooth, blurry up close); 1 (default) re-samples it bicubically on a fine screen-space mesh
    /// with per-vertex shading and subtle procedural micro-relief; up to 2 for stronger relief.
    pub terrain_detail: f32,
    pub show_structures: bool,
    pub build_cursor: Option<MapBuildCursor>,
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
            show_intents: true,
            show_proposals: true,
            selected_change_id: None,
            show_marks: true,
            show_population: true,
            show_quests: true,
            brush: None,
            focus_request: 0,
            focus_center: None,
            focus_zoom: None,
            terrain_detail: 1.0,
            show_structures: true,
            build_cursor: None,
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
    IntentSelected { id: String },
    /// A proposed change's preview was clicked.
    GhostSelected { id: String },
    /// Part of a brush stroke (world km points since the last report); `done` when the button is released.
    BrushStroke { points: Vec<[f32; 2]>, done: bool },
    MarkerSelected { id: String },
    /// A marker was dragged to a new place.
    MarkerMoved { id: String, x: f32, y: f32 },
    StructureSelected { id: String },
    /// A structure was dragged: its anchor's new place.
    StructureMoved { id: String, x: f32, y: f32 },
    /// A structure's rotation handle is being dragged (`done` on release).
    StructureRotated { id: String, deg: f32, done: bool },
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
    pub focus_request: u32,
    pub stroke_active: bool,
    pub stroke_last: Option<Pos2>,
    pub dragging_marker_id: Option<String>,
    pub dragging_structure_id: Option<String>,
    pub rotating_structure_id: Option<String>,
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
            focus_request: 0,
            stroke_active: false,
            stroke_last: None,
            dragging_marker_id: None,
            dragging_structure_id: None,
            rotating_structure_id: None,
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

/// How a terrain vertex is colored: the style's tint for its elevation, lit by its gradient.
struct TerrainShade<'a> {
    style: &'a str,
    palette: &'a str,
    sea: f32,
    sea_span: f32,
    land_span: f32,
}

impl TerrainShade<'_> {
    /// `gx`, `gy`: the ground's slope east and south (meters per meter; screen y points south).
    fn color(&self, e: f32, gx: f32, gy: f32) -> [f32; 4] {
        // Light from the north-west, 45 degrees up.
        let (lx, ly, lz) = (-0.5f32, -0.5f32, 0.7071f32);
        let z_exag = 2.2;
        let (nx, ny, nz) = (-gx * z_exag, -gy * z_exag, 1.0);
        let nl = (nx * nx + ny * ny + nz * nz).sqrt();
        let shade = ((nx * lx + ny * ly + nz * lz) / nl / lz).max(0.0);
        let slope_deg = (gx * gx + gy * gy).sqrt().atan().to_degrees();
        let (sea, sea_span, land_span) = (self.sea, self.sea_span, self.land_span);
        let underwater = e <= sea;
        let (base, light) = match self.style {
            "heatmap" => {
                if underwater {
                    (lerp3(hex(0x1f2a44), hex(0x0b1020), ((sea - e) / sea_span).clamp(0.0, 1.0).sqrt()), 0.15)
                } else {
                    (heat_tint(0.3 + 0.7 * ((e - sea) / land_span).clamp(0.0, 1.0)), 0.45)
                }
            }
            "slope" => {
                if underwater {
                    (lerp3(hex(0x24344a), hex(0x101826), ((sea - e) / sea_span).clamp(0.0, 1.0).sqrt()), 0.1)
                } else {
                    (lerp3(slope_tint(slope_deg), hex(0x9aa3a8), 0.22), 0.55)
                }
            }
            _ => {
                if underwater {
                    (water_tint(self.palette, ((sea - e) / sea_span).clamp(0.0, 1.0).powf(0.6)), 0.12)
                } else {
                    (land_tint(self.palette, ((e - sea) / land_span).clamp(0.0, 1.0)), 0.75)
                }
            }
        };
        let f = (1.0 - light + light * shade).clamp(0.3, 1.35);
        // Shadows lean cool, lit slopes warm, so relief reads without washing the tints out.
        let warm = (shade - 1.0).max(0.0) * 0.06 * light;
        let cool = (1.0 - shade).max(0.0) * 0.05 * light;
        [
            (base[0] * f + warm - cool).clamp(0.0, 1.0),
            (base[1] * f + warm * 0.6 - cool * 0.3).clamp(0.0, 1.0),
            (base[2] * f + cool).clamp(0.0, 1.0),
            1.0,
        ]
    }
}

/// Catmull-Rom (bicubic) elevation at fractional grid coordinates: smooth between vertices, where
/// bilinear interpolation leaves visible creases up close.
fn bicubic(t: &MapTerrain, gx: f32, gy: f32) -> f32 {
    let (cols, rows) = (t.cols as i64, t.rows as i64);
    let c1 = gx.floor() as i64;
    let r1 = gy.floor() as i64;
    let fx = gx - c1 as f32;
    let fy = gy - r1 as f32;
    let at = |c: i64, r: i64| t.data[(r.clamp(0, rows - 1) * cols + c.clamp(0, cols - 1)) as usize];
    let cr = |p0: f32, p1: f32, p2: f32, p3: f32, f: f32| p1 + 0.5 * f * (p2 - p0 + f * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + f * (3.0 * (p1 - p2) + p3 - p0)));
    let row = |r: i64| cr(at(c1 - 1, r), at(c1, r), at(c1 + 1, r), at(c1 + 2, r), fx);
    cr(row(r1 - 1), row(r1), row(r1 + 1), row(r1 + 2), fy)
}

fn lattice_hash(ix: i32, iy: i32, octave: u32) -> f32 {
    let mut h = (ix as u32).wrapping_mul(0x8da6_b343) ^ (iy as u32).wrapping_mul(0xd816_3841) ^ octave.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1_e995);
    h ^= h >> 15;
    (h & 0xffff) as f32 / 32767.5 - 1.0
}

/// Smooth value noise in -1..1 (world-anchored, so it does not swim as the view moves).
fn value_noise(x: f32, y: f32, octave: u32) -> f32 {
    let (ix, iy) = (x.floor() as i32, y.floor() as i32);
    let (fx, fy) = (x - ix as f32, y - iy as f32);
    let (u, v) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let a = lattice_hash(ix, iy, octave);
    let b = lattice_hash(ix + 1, iy, octave);
    let c = lattice_hash(ix, iy + 1, octave);
    let d = lattice_hash(ix + 1, iy + 1, octave);
    a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/// Micro-relief below the heightfield's resolution, in meters: fractal noise whose largest
/// features are about a grid cell, scaled by `amp_m`, with only as many octaves as the screen can
/// show (`min_wave_m`). It is surface texture for reading the ground up close, not data: it never
/// turns land into water or water into land.
fn micro_relief(x_m: f32, y_m: f32, cell_m: f32, amp_m: f32, min_wave_m: f32) -> f32 {
    let mut sum = 0.0;
    let mut wave = cell_m * 0.9;
    let mut amp = amp_m;
    let mut o = 0;
    while wave >= min_wave_m && o < 6 {
        // Ridged octaves read as rock and gullies rather than bumps.
        let n = value_noise(x_m / wave, y_m / wave, o);
        sum += (0.5 - n.abs()) * 2.0 * amp;
        wave *= 0.5;
        amp *= 0.5;
        o += 1;
    }
    sum
}

/// The fine terrain mesh for the current view, kept until the view or the terrain changes.
#[derive(Clone, Debug, Default)]
struct FineTerrain {
    key: u64,
    verts: Vec<Vertex>,
    idx: Vec<u32>,
}

/// The fine terrain mesh over `view` = [min x, max x, min y, max y] (world km): about 45k vertices
/// whatever the zoom, elevations re-sampled bicubically plus micro-relief, shaded per vertex.
fn build_fine_terrain(t: &MapTerrain, opts: &GameMapOptions, cache: &TerrainCache, view: [f32; 4], zoom: f32, detail: f32, w2s: &dyn Fn(f32, f32) -> Pos2, key: u64) -> FineTerrain {
    let [x0, x1, y0, y1] = view;
    let half_w = opts.world_width_km * 0.5;
    let half_h = opts.world_height_km * 0.5;
    let sx = opts.world_width_km / (t.cols - 1) as f32;
    let sy = opts.world_height_km / (t.rows - 1) as f32;
    let (w_px, h_px) = ((x1 - x0) * zoom, (y1 - y0) * zoom);
    let step_px = (w_px * h_px / 45000.0).sqrt().max(4.0);
    let nx = ((w_px / step_px).ceil() as usize + 1).clamp(2, 420);
    let ny = ((h_px / step_px).ceil() as usize + 1).clamp(2, 420);
    let dx_km = (x1 - x0) / (nx - 1) as f32;
    let dy_km = (y1 - y0) / (ny - 1) as f32;
    let sea = t.sea_level_m;
    let cell_m = sx.min(sy) * 1000.0;
    // The smallest feature worth drawing: a couple of mesh steps.
    let min_wave_m = step_px / zoom * 1000.0 * 2.2;
    // Base elevations first (they set how rough the ground is), then the micro-relief.
    let mut base = vec![0.0f32; nx * ny];
    for j in 0..ny {
        let y = y1 - j as f32 * dy_km;
        let gy = (half_h - y) / sy;
        for i in 0..nx {
            let x = x0 + i as f32 * dx_km;
            base[j * nx + i] = bicubic(t, (x + half_w) / sx, gy);
        }
    }
    let (dx_m, dy_m) = (dx_km * 1000.0, dy_km * 1000.0);
    let mut h = base.clone();
    if detail > 0.0 {
        for j in 0..ny {
            for i in 0..nx {
                let k = j * nx + i;
                let b = base[k];
                if b <= sea {
                    continue;
                }
                let (il, ir) = (i.saturating_sub(1), (i + 1).min(nx - 1));
                let (ju, jd) = (j.saturating_sub(1), (j + 1).min(ny - 1));
                let gx = (base[j * nx + ir] - base[j * nx + il]) / (dx_m * (ir - il).max(1) as f32);
                let gy = (base[jd * nx + i] - base[ju * nx + i]) / (dy_m * (jd - ju).max(1) as f32);
                // Steeper ground is rougher; flats stay calm, and the shore fades the texture out.
                let rough = 0.25 + ((gx * gx + gy * gy).sqrt() * 3.0).min(1.0);
                let shore = ((b - sea) / 6.0).clamp(0.0, 1.0);
                let amp = detail * cell_m * 0.03 * rough * shore;
                let x_m = (x0 + i as f32 * dx_km) * 1000.0;
                let y_m = (y1 - j as f32 * dy_km) * 1000.0;
                h[k] = (b + micro_relief(x_m, y_m, cell_m, amp, min_wave_m)).max(sea + 0.05);
            }
        }
    }
    let shade = TerrainShade {
        style: opts.terrain_style.as_str(),
        palette: opts.terrain_palette.as_str(),
        sea,
        sea_span: (sea - cache.min_m).max(1.0),
        land_span: (cache.max_m - sea).max(1.0),
    };
    let mut verts = Vec::with_capacity(nx * ny);
    for j in 0..ny {
        let y = y1 - j as f32 * dy_km;
        for i in 0..nx {
            let (il, ir) = (i.saturating_sub(1), (i + 1).min(nx - 1));
            let (ju, jd) = (j.saturating_sub(1), (j + 1).min(ny - 1));
            let gx = (h[j * nx + ir] - h[j * nx + il]) / (dx_m * (ir - il).max(1) as f32);
            let gy = (h[jd * nx + i] - h[ju * nx + i]) / (dy_m * (jd - ju).max(1) as f32);
            let p = w2s(x0 + i as f32 * dx_km, y);
            verts.push(Vertex::new(p.x, p.y, 0.0, shade.color(h[j * nx + i], gx, gy)));
        }
    }
    let mut idx = Vec::with_capacity((nx - 1) * (ny - 1) * 6);
    for j in 0..ny - 1 {
        for i in 0..nx - 1 {
            let a = (j * nx + i) as u32;
            let b = a + 1;
            let c = a + nx as u32;
            let d = c + 1;
            idx.extend_from_slice(&[a, b, d, a, d, c]);
        }
    }
    FineTerrain { key, verts, idx }
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
    let shade = TerrainShade { style: opts.terrain_style.as_str(), palette: opts.terrain_palette.as_str(), sea, sea_span, land_span };
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
            colors.push(shade.color(e, gx, gy));
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
    intents: Vec<MapIntent>,
    ghosts: Vec<MapGhost>,
    overlay: Option<MapOverlay>,
    markers: Vec<MapMarker>,
    quest_routes: Vec<MapQuestRoute>,
    structures: Vec<MapStructure>,
}

#[derive(Clone, Copy, PartialEq)]
enum Hover {
    None,
    Marker(usize),
    Structure(usize),
    Spot(usize),
    Path(usize),
    Region(usize),
    Intent(usize),
    Ghost(usize),
}

const GHOST_COLOR: Color32 = Color32::from_rgb(178, 150, 255);
const ROSE: Color32 = Color32::from_rgb(244, 63, 94);

/// Where an intent sits on screen this frame (shared by hit-testing and drawing).
struct IntentGeom {
    /// Area outline, route curve, or the pin's point.
    pts: Vec<Pos2>,
    /// The pin's head.
    head: Option<Pos2>,
    badge: Rect,
    title: String,
    show_summary: bool,
}

/// A gentle bow between two points, so a route reads as a journey rather than a ruler.
fn bowed(a: Pos2, b: Pos2) -> Vec<Pos2> {
    let mid = pos2((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
    let len = (b.x - a.x).hypot(b.y - a.y).max(1e-3);
    let n = vec2(-(b.y - a.y) / len, (b.x - a.x) / len);
    let c = pos2(mid.x + n.x * len * 0.16, mid.y + n.y * len * 0.16);
    (0..=24)
        .map(|k| {
            let t = k as f32 / 24.0;
            let u = 1.0 - t;
            pos2(u * u * a.x + 2.0 * u * t * c.x + t * t * b.x, u * u * a.y + 2.0 * u * t * c.y + t * t * b.y)
        })
        .collect()
}

fn near_polyline(p: Pos2, pts: &[Pos2], tol: f32) -> bool {
    pts.windows(2).any(|w| dist_to_segment(p, w[0], w[1]) <= tol)
}

/// A small map symbol for a planning mark or a placed codex entry, `s` px across-ish.
fn draw_glyph(painter: &Painter, glyph: &str, c: Pos2, s: f32, col: Color32) {
    let ink = Color32::from_rgba_unmultiplied(10, 14, 20, (col.a() as f32 * 0.75) as u8);
    let line = |a: Pos2, b: Pos2, w: f32| painter.line_segment([a, b], Stroke::new(w, col));
    match glyph {
        "tree" => {
            let pts = vec![pos2(c.x, c.y - s * 0.62), pos2(c.x + s * 0.42, c.y + s * 0.22), pos2(c.x - s * 0.42, c.y + s * 0.22)];
            painter.add(Shape::convex_polygon(pts, col, Stroke::new(0.6, ink)));
            line(pos2(c.x, c.y + s * 0.22), pos2(c.x, c.y + s * 0.55), (s * 0.14).max(1.0));
        }
        "grass" => {
            for dx in [-0.3f32, 0.0, 0.3] {
                line(pos2(c.x + dx * s, c.y + s * 0.35), pos2(c.x + dx * s * 1.6, c.y - s * 0.3), (s * 0.11).max(0.9));
            }
        }
        "dot" => {
            painter.circle_filled(pos2(c.x - s * 0.25, c.y), s * 0.13 + 0.5, col);
            painter.circle_filled(pos2(c.x + s * 0.22, c.y - s * 0.2), s * 0.11 + 0.5, col);
            painter.circle_filled(pos2(c.x + s * 0.1, c.y + s * 0.28), s * 0.12 + 0.5, col);
        }
        "hatch" => {
            for k in [-0.35f32, 0.0, 0.35] {
                line(pos2(c.x - s * 0.45 + k * s, c.y + s * 0.4), pos2(c.x + s * 0.05 + k * s, c.y - s * 0.4), (s * 0.1).max(0.9));
            }
        }
        "rock" => {
            let pts = vec![pos2(c.x - s * 0.45, c.y + s * 0.3), pos2(c.x - s * 0.15, c.y - s * 0.32), pos2(c.x + s * 0.25, c.y - s * 0.2), pos2(c.x + s * 0.45, c.y + s * 0.3)];
            painter.add(Shape::convex_polygon(pts, col, Stroke::new(0.6, ink)));
        }
        "snow" => {
            for k in 0..3 {
                let a = k as f32 * std::f32::consts::PI / 3.0;
                let (dx, dy) = (a.cos() * s * 0.42, a.sin() * s * 0.42);
                line(pos2(c.x - dx, c.y - dy), pos2(c.x + dx, c.y + dy), (s * 0.1).max(0.9));
            }
        }
        "wave" => {
            for row in [-0.2f32, 0.2] {
                let y = c.y + row * s;
                let pts: Vec<Pos2> = (0..=6).map(|k| pos2(c.x - s * 0.45 + k as f32 * s * 0.15, y + if k % 2 == 0 { -s * 0.08 } else { s * 0.08 })).collect();
                polyline(painter, &pts, Stroke::new((s * 0.1).max(0.9), col));
            }
        }
        "cross" => {
            line(pos2(c.x - s * 0.35, c.y - s * 0.35), pos2(c.x + s * 0.35, c.y + s * 0.35), (s * 0.13).max(1.0));
            line(pos2(c.x - s * 0.35, c.y + s * 0.35), pos2(c.x + s * 0.35, c.y - s * 0.35), (s * 0.13).max(1.0));
        }
        "square" => {
            painter.rect_filled(Rect::from_center_size(c, vec2(s * 0.6, s * 0.6)), 1u8, col);
        }
        "skull" => {
            painter.circle_filled(pos2(c.x, c.y - s * 0.08), s * 0.36, col);
            painter.rect_filled(Rect::from_center_size(pos2(c.x, c.y + s * 0.3), vec2(s * 0.42, s * 0.22)), 1u8, col);
            painter.circle_filled(pos2(c.x - s * 0.14, c.y - s * 0.08), s * 0.09 + 0.3, ink);
            painter.circle_filled(pos2(c.x + s * 0.14, c.y - s * 0.08), s * 0.09 + 0.3, ink);
        }
        "person" => {
            painter.circle_filled(pos2(c.x, c.y - s * 0.32), s * 0.2, col);
            let pts = vec![pos2(c.x, c.y - s * 0.1), pos2(c.x + s * 0.34, c.y + s * 0.48), pos2(c.x - s * 0.34, c.y + s * 0.48)];
            painter.add(Shape::convex_polygon(pts, col, Stroke::NONE));
        }
        "flag" => {
            line(pos2(c.x - s * 0.3, c.y + s * 0.5), pos2(c.x - s * 0.3, c.y - s * 0.5), (s * 0.12).max(1.0));
            let pts = vec![pos2(c.x - s * 0.3, c.y - s * 0.5), pos2(c.x + s * 0.4, c.y - s * 0.28), pos2(c.x - s * 0.3, c.y - s * 0.05)];
            painter.add(Shape::convex_polygon(pts, col, Stroke::NONE));
        }
        _ => {
            let pts = vec![pos2(c.x, c.y - s * 0.45), pos2(c.x + s * 0.35, c.y), pos2(c.x, c.y + s * 0.45), pos2(c.x - s * 0.35, c.y)];
            painter.add(Shape::convex_polygon(pts, col, Stroke::new(0.6, ink)));
        }
    }
}

/// Cheap deterministic jitter in 0..1 for a cell and a slot.
fn cell_hash(c: usize, r: usize, k: usize) -> f32 {
    let mut h = (c as u32).wrapping_mul(73856093) ^ (r as u32).wrapping_mul(19349663) ^ (k as u32).wrapping_mul(83492791);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1e995);
    h ^= h >> 15;
    (h & 0xffff) as f32 / 65535.0
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
            intents: Vec::new(),
            ghosts: Vec::new(),
            overlay: None,
            markers: Vec::new(),
            quest_routes: Vec::new(),
            structures: Vec::new(),
        }
    }

    pub fn overlay(mut self, overlay: Option<MapOverlay>) -> Self {
        self.overlay = overlay.filter(|o| o.valid());
        self
    }
    pub fn markers(mut self, markers: Vec<MapMarker>) -> Self {
        self.markers = markers;
        self
    }
    pub fn structures(mut self, structures: Vec<MapStructure>) -> Self {
        self.structures = structures;
        self
    }

    pub fn quest_routes(mut self, routes: Vec<MapQuestRoute>) -> Self {
        self.quest_routes = routes;
        self
    }

    pub fn intents(mut self, intents: Vec<MapIntent>) -> Self {
        self.intents = intents;
        self
    }
    pub fn ghosts(mut self, ghosts: Vec<MapGhost>) -> Self {
        self.ghosts = ghosts;
        self
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
        if st.focus_request != opts.focus_request {
            st.focus_request = opts.focus_request;
            if let Some(c) = opts.focus_center {
                st.center = pos2(c[0], c[1]);
                st.zoom = opts.focus_zoom.unwrap_or(st.zoom.max(fit_zoom * 2.2)).clamp(min_zoom, max_zoom);
            }
        }

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
        let build_drawing = matches!(opts.pending_mode.as_deref(), Some("build_line") | Some("build_area"));
        let drawing = matches!(opts.active_tool.as_str(), "draw_path" | "quest_path" | "draw_region" | "measure" | "intent" | "sculpt" | "paint" | "populate") || build_drawing;
        // Structures: screen geometry for hit-testing (and drawing below).
        let structure_screen: Vec<(Vec<Vec<Pos2>>, Vec<Pos2>, f32)> = self
            .structures
            .iter()
            .map(|st| {
                let parts = st.parts.iter().map(|part| part.iter().map(|q| w2s(q[0], q[1])).collect()).collect();
                let outline = st.outline.iter().map(|q| w2s(q[0], q[1])).collect();
                (parts, outline, (st.line_width_m / 1000.0 * zoom).max(1.2))
            })
            .collect();
        let selected_structure = self.structures.iter().position(|x| opts.selected_id.as_deref() == Some(x.id.as_str()));
        // The rotation handle of the selected footprint: behind it, past its far edge.
        let rotate_handle: Option<(usize, Pos2, Pos2)> = selected_structure.filter(|&i| self.structures[i].rotatable && opts.show_structures).map(|i| {
            let st = &self.structures[i];
            let c = w2s(st.anchor[0], st.anchor[1]);
            let r = structure_screen[i].1.iter().map(|p| (p.x - c.x).hypot(p.y - c.y)).fold(0.0, f32::max);
            let a = st.rotation_deg.to_radians();
            (i, c, pos2(c.x - a.sin() * (r + 18.0), c.y - a.cos() * (r + 18.0)))
        });
        let brush_paint = opts.brush.as_ref().is_some_and(|b| b.paint);

        // Intent geometry: outlines, route curves, pin heads and their badges.
        let badge_font = FontId::proportional(10.5);
        let intent_geoms: Vec<IntentGeom> = self
            .intents
            .iter()
            .map(|it| {
                let pts: Vec<Pos2> = it.points.iter().map(|q| w2s(q[0], q[1])).collect();
                let selected = opts.selected_id.as_deref() == Some(it.id.as_str());
                let mut title: String = it.title.chars().take(30).collect();
                if it.title.chars().count() > 30 {
                    title.push('…');
                }
                let title = format!("#{}  {}", it.number, title);
                let tw = Painter::measure_text(&ctx, badge_font.clone(), &title).x;
                let sw = if selected { Painter::measure_text(&ctx, FontId::proportional(9.5), &it.summary).x } else { 0.0 };
                let tag = if matches!(it.status.as_str(), "proposed" | "claimed") { 16.0 } else { 0.0 };
                let w = (tw + tag).max(sw) + 32.0;
                let h = if selected { 34.0 } else { 20.0 };
                match it.shape.as_str() {
                    "route" if pts.len() >= 2 => {
                        let curve = bowed(pts[0], pts[pts.len() - 1]);
                        let mid = curve[curve.len() / 2];
                        IntentGeom { badge: Rect::from_center_size(pos2(mid.x, mid.y - h * 0.5 - 6.0), vec2(w, h)), pts: curve, head: None, title, show_summary: selected }
                    }
                    "area" if pts.len() >= 3 => {
                        let top = pts.iter().copied().fold(pts[0], |a, b| if b.y < a.y { b } else { a });
                        IntentGeom { badge: Rect::from_min_size(pos2(top.x - w * 0.5, top.y - h - 8.0), vec2(w, h)), pts, head: None, title, show_summary: selected }
                    }
                    _ => {
                        let p = pts.first().copied().unwrap_or(pos2(-9999.0, -9999.0));
                        let head = pos2(p.x, p.y - 24.0);
                        IntentGeom { badge: Rect::from_min_size(pos2(head.x + 15.0, head.y - h * 0.5), vec2(w, h)), pts, head: Some(head), title, show_summary: selected }
                    }
                }
            })
            .collect();
        let ghost_pts = |g: &MapGhost| -> Vec<Pos2> { g.points.iter().map(|q| w2s(q[0], q[1])).collect() };
        let spot_radius = |s: &MapSpot| -> f32 {
            let base = if s.spot_type == "capital" { 12.0 } else if s.is_major { 9.5 } else { 7.5 };
            if zoom < fit_zoom * 0.8 && !s.is_major { base * 0.8 } else { base }
        };
        let visible_spot = |s: &MapSpot| !(opts.blocking_mode && !s.is_major);
        let mut hover = Hover::None;
        if let Some(p) = pointer_pos.filter(|_| is_hovered && !st.is_panning) {
            // Proposed changes first: they sit on top of everything while waiting for review.
            if opts.show_proposals && !drawing {
                for (i, g) in self.ghosts.iter().enumerate().rev() {
                    let pts = ghost_pts(g);
                    let hit = match g.kind.as_str() {
                        "spot" | "move" => pts.first().is_some_and(|q| (q.x - p.x).hypot(q.y - p.y) <= 14.0),
                        "path" => near_polyline(p, &pts, 7.0),
                        "region" => {
                            let mut closed = pts.clone();
                            if let Some(f) = pts.first() {
                                closed.push(*f);
                            }
                            near_polyline(p, &closed, 6.0) || (pts.len() >= 3 && (polygon_centroid(&pts).x - p.x).abs() < 50.0 && (polygon_centroid(&pts).y - p.y).abs() < 10.0)
                        }
                        _ => pts.first().is_some_and(|q| (q.x - p.x).hypot(q.y - p.y) <= 12.0) || near_polyline(p, &pts, 6.0),
                    };
                    if hit {
                        hover = Hover::Ghost(i);
                        break;
                    }
                }
            }
            if hover == Hover::None && opts.show_intents && !drawing {
                for (i, g) in intent_geoms.iter().enumerate().rev() {
                    let hit = g.badge.contains(p)
                        || g.head.is_some_and(|h| (h.x - p.x).hypot(h.y - p.y) <= 13.0)
                        || match self.intents[i].shape.as_str() {
                            "route" => near_polyline(p, &g.pts, 7.0),
                            "area" => {
                                let mut closed = g.pts.clone();
                                if let Some(f) = g.pts.first() {
                                    closed.push(*f);
                                }
                                near_polyline(p, &closed, 6.0)
                            }
                            _ => false,
                        };
                    if hit {
                        hover = Hover::Intent(i);
                        break;
                    }
                }
            }
            if hover == Hover::None && opts.show_population && !drawing {
                for (i, m) in self.markers.iter().enumerate().rev() {
                    let q = w2s(m.x, m.y);
                    if (q.x - p.x).hypot(q.y - p.y) <= 9.0 {
                        hover = Hover::Marker(i);
                        break;
                    }
                }
            }
            if hover == Hover::None && !brush_paint {
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
            }
            if hover == Hover::None && !drawing && opts.show_structures && matches!(opts.active_tool.as_str(), "select" | "pan" | "build") {
                if let Some((i, _, h)) = rotate_handle {
                    if (h.x - p.x).hypot(h.y - p.y) <= 9.0 {
                        hover = Hover::Structure(i);
                    }
                }
                if hover == Hover::None {
                    for (i, (parts, outline, lw)) in structure_screen.iter().enumerate().rev() {
                        let st = &self.structures[i];
                        let hit = if st.closed {
                            parts.iter().any(|part| part.len() >= 3 && point_in_polygon(p, part)) || (outline.len() >= 3 && point_in_polygon(p, outline))
                        } else {
                            near_polyline(p, outline, (lw * 0.5).max(4.0))
                        };
                        if hit {
                            hover = Hover::Structure(i);
                            break;
                        }
                    }
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
            if brush_paint {
                let w = s2w(p);
                st.stroke_active = true;
                st.stroke_last = Some(w);
                events.push(GameMapEvent::BrushStroke { points: vec![[w.x, w.y]], done: false });
            } else {
            match (opts.active_tool.as_str(), hover) {
                ("select" | "pan", Hover::Marker(i)) => {
                    let m = &self.markers[i];
                    events.push(GameMapEvent::MarkerSelected { id: m.id.clone() });
                    if opts.active_tool == "select" {
                        st.dragging_marker_id = Some(m.id.clone());
                        st.drag_press_pos = Some(p);
                        st.drag_start_world = Some(pos2(m.x, m.y));
                        st.drag_last_world = Some(pos2(m.x, m.y));
                        st.drag_moved = false;
                    }
                }
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
                ("select" | "pan" | "build", Hover::Structure(i)) => {
                    let sref = &self.structures[i];
                    let on_handle = rotate_handle.is_some_and(|(hi, _, h)| hi == i && (h.x - p.x).hypot(h.y - p.y) <= 9.0);
                    events.push(GameMapEvent::StructureSelected { id: sref.id.clone() });
                    if opts.active_tool != "pan" {
                        if on_handle {
                            st.rotating_structure_id = Some(sref.id.clone());
                        } else {
                            st.dragging_structure_id = Some(sref.id.clone());
                            st.drag_press_pos = Some(p);
                            st.drag_start_world = Some(pos2(sref.anchor[0], sref.anchor[1]));
                            st.drag_last_world = Some(pos2(sref.anchor[0], sref.anchor[1]));
                            st.drag_moved = false;
                        }
                    }
                }
                ("select" | "pan", Hover::Intent(i)) => events.push(GameMapEvent::IntentSelected { id: self.intents[i].id.clone() }),
                ("select" | "pan", Hover::Ghost(i)) => events.push(GameMapEvent::GhostSelected { id: self.ghosts[i].id.clone() }),
                ("select", Hover::Path(i)) => events.push(GameMapEvent::PathSelected { id: self.paths[i].id.clone() }),
                ("select", Hover::Region(i)) => events.push(GameMapEvent::RegionSelected { id: self.regions[i].id.clone() }),
                (_, _) if is_double && drawing => events.push(GameMapEvent::MapDoubleClicked { x: at.x, y: at.y }),
                (_, _) => events.push(GameMapEvent::MapClicked { x: at.x, y: at.y }),
            }
            }
        }

        // Brush strokes: report the pointer's path while the button is held, then the release.
        if st.stroke_active {
            let radius = opts.brush.as_ref().map_or(0.5, |b| b.radius_km);
            if pointer.primary_down && brush_paint && !st.is_panning {
                if let Some(p) = pointer_pos {
                    let w = s2w(p);
                    let moved = st.stroke_last.map_or(true, |l| (l.x - w.x).hypot(l.y - w.y) >= (radius * 0.2).max(3.0 / zoom));
                    if moved {
                        events.push(GameMapEvent::BrushStroke { points: vec![[w.x, w.y]], done: false });
                        st.stroke_last = Some(w);
                    }
                }
            } else {
                events.push(GameMapEvent::BrushStroke { points: Vec::new(), done: true });
                st.stroke_active = false;
                st.stroke_last = None;
            }
        }

        // Marker drag (same feel as a spot drag): one move event when it is let go.
        let mut marker_preview: Option<(String, Pos2)> = None;
        if let Some(drag_id) = st.dragging_marker_id.clone() {
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
                        st.drag_last_world = Some(target);
                        marker_preview = Some((drag_id.clone(), target));
                    }
                }
            } else {
                if st.drag_moved {
                    if let Some(l) = st.drag_last_world {
                        events.push(GameMapEvent::MarkerMoved { id: drag_id.clone(), x: l.x, y: l.y });
                    }
                }
                st.dragging_marker_id = None;
                st.drag_press_pos = None;
                st.drag_moved = false;
            }
        }

        // Structure drag (a preview while held, one move when let go) and rotation (live).
        let mut structure_preview: Option<(String, Pos2)> = None;
        if let Some(drag_id) = st.dragging_structure_id.clone() {
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
                        st.drag_last_world = Some(target);
                        structure_preview = Some((drag_id.clone(), target));
                    }
                }
            } else {
                if st.drag_moved {
                    if let Some(l) = st.drag_last_world {
                        events.push(GameMapEvent::StructureMoved { id: drag_id.clone(), x: l.x, y: l.y });
                    }
                }
                st.dragging_structure_id = None;
                st.drag_press_pos = None;
                st.drag_moved = false;
            }
        }
        if let Some(rot_id) = st.rotating_structure_id.clone() {
            let anchor = self.structures.iter().find(|x| x.id == rot_id).map(|x| pos2(x.anchor[0], x.anchor[1]));
            match (anchor, pointer_pos) {
                (Some(a), Some(p)) if pointer.primary_down => {
                    let w = s2w(p);
                    let (vx, vy) = (w.x - a.x, w.y - a.y);
                    if vx.hypot(vy) > 1e-6 {
                        // The handle sits behind the footprint (its local +y).
                        let mut deg = (-vx).atan2(vy).to_degrees();
                        let snapped = (deg / 15.0).round() * 15.0;
                        if (deg - snapped).abs() < 3.0 {
                            deg = snapped;
                        }
                        let deg = ((deg % 360.0) + 360.0) % 360.0;
                        events.push(GameMapEvent::StructureRotated { id: rot_id.clone(), deg: (deg * 10.0).round() / 10.0, done: false });
                    }
                }
                _ => {
                    events.push(GameMapEvent::StructureRotated { id: rot_id.clone(), deg: f32::NAN, done: true });
                    st.rotating_structure_id = None;
                }
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
            let cursor = if st.is_panning || st.drag_moved || st.rotating_structure_id.is_some() {
                CursorIcon::Grabbing
            } else if over_hud_btn.is_some() || in_minimap || (matches!(hover, Hover::Spot(_) | Hover::Intent(_) | Hover::Ghost(_) | Hover::Marker(_) | Hover::Structure(_)) && opts.active_tool == "select") {
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
            let sx = opts.world_width_km / (t.cols - 1) as f32;
            let sy = opts.world_height_km / (t.rows - 1) as f32;
            let detail = opts.terrain_detail.clamp(0.0, 2.0);
            let cell_px = sx.min(sy) * zoom;
            let (fx0, fx1) = (vis_min_x.max(-half_w), vis_max_x.min(half_w));
            let (fy0, fy1) = (vis_min_y.max(-half_h), vis_max_y.min(half_h));
            if opts.terrain_style != "flat" && detail > 0.0 && cell_px > 6.0 && fx1 > fx0 && fy1 > fy0 {
                // Zoomed in past the grid: a fine mesh over the visible part of the world, re-sampled
                // bicubically with per-vertex shading and micro-relief, rebuilt only when the view moves.
                let fine_id = self.id.with("fine_terrain");
                let mut fine: FineTerrain = ctx.memory_mut(|m| m.take_view_state(fine_id));
                let mut hasher = DefaultHasher::new();
                cache.key.hash(&mut hasher);
                for v in [fx0, fx1, fy0, fy1, zoom, detail, rect.min.x, rect.min.y, rect.max.x, rect.max.y] {
                    v.to_bits().hash(&mut hasher);
                }
                let fkey = hasher.finish();
                if fine.key != fkey || fine.verts.is_empty() {
                    fine = build_fine_terrain(t, &opts, &cache, [fx0, fx1, fy0, fy1], zoom, detail, &w2s, fkey);
                }
                painter.mesh(fine.verts.clone(), fine.idx.clone());
                ctx.memory_mut(|m| m.put_view_state(fine_id, fine));
            } else if opts.terrain_style != "flat" {
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
        // 4b. Painted planning marks: a soft tint per cell, and symbols once cells are big enough.
        // -----------------------------------------------------------------------------------------
        if let Some(ov) = self.overlay.as_ref().filter(|_| opts.show_marks) {
            let cw = opts.world_width_km / ov.cols as f32;
            let ch = opts.world_height_km / ov.rows as f32;
            let c0 = (((vis_min_x + half_w) / cw).floor() as i64).clamp(0, ov.cols as i64 - 1) as usize;
            let c1 = (((vis_max_x + half_w) / cw).ceil() as i64).clamp(0, ov.cols as i64 - 1) as usize;
            let r0 = (((half_h - vis_max_y) / ch).floor() as i64).clamp(0, ov.rows as i64 - 1) as usize;
            let r1 = (((half_h - vis_min_y) / ch).ceil() as i64).clamp(0, ov.rows as i64 - 1) as usize;
            let cell_px = cw * zoom;
            let mut glyph_budget: i32 = 7000;
            for layer in &ov.layers {
                let mut verts: Vec<Vertex> = Vec::new();
                let mut idx: Vec<u32> = Vec::new();
                for r in r0..=r1 {
                    for c in c0..=c1 {
                        let d = layer.data[r * ov.cols + c];
                        if d <= 0.02 {
                            continue;
                        }
                        let x0 = -half_w + c as f32 * cw;
                        let y0 = half_h - r as f32 * ch;
                        let a = w2s(x0, y0);
                        let b = w2s(x0 + cw, y0 - ch);
                        let col = [layer.color[0], layer.color[1], layer.color[2], (layer.color[3] * d * 0.38).min(0.5)];
                        let base = verts.len() as u32;
                        verts.push(Vertex::new(a.x, a.y, 0.0, col));
                        verts.push(Vertex::new(b.x, a.y, 0.0, col));
                        verts.push(Vertex::new(b.x, b.y, 0.0, col));
                        verts.push(Vertex::new(a.x, b.y, 0.0, col));
                        idx.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
                    }
                }
                if !idx.is_empty() {
                    painter.mesh(verts, idx);
                }
            }
            // Symbols: denser paint, more of them; on top of every tint.
            if cell_px >= 7.0 {
                let gsize = (cell_px * 0.42).clamp(4.0, 11.0);
                for (li, layer) in ov.layers.iter().enumerate() {
                    let gcol = lighten(rgba([layer.color[0], layer.color[1], layer.color[2], 1.0]), 0.1);
                    for r in r0..=r1 {
                        for c in c0..=c1 {
                            let d = layer.data[r * ov.cols + c];
                            if d <= 0.08 || glyph_budget <= 0 {
                                continue;
                            }
                            // Zoomed out: thin the symbols out so they read as a pattern.
                            let n = if cell_px < 14.0 { usize::from(cell_hash(c, r, li) < d * 0.8) } else { 1 + (d * 2.6) as usize };
                            for k in 0..n.min(3) {
                                let jx = cell_hash(c, r, k * 2 + li * 7);
                                let jy = cell_hash(r, c, k * 2 + 1 + li * 7);
                                let wx = -half_w + (c as f32 + 0.2 + jx * 0.6) * cw;
                                let wy = half_h - (r as f32 + 0.2 + jy * 0.6) * ch;
                                draw_glyph(&painter, &layer.glyph, w2s(wx, wy), gsize, with_alpha(gcol, (120.0 + d * 120.0) as u8));
                                glyph_budget -= 1;
                            }
                        }
                    }
                }
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
            if !path_visible(path) || path.path_type == "river" || path.path_type == "quest" {
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

        // -----------------------------------------------------------------------------------------
        // 5'. Town planning: areas, streets, walls, then building footprints. A building shows up
        //     once it is about a pixel across; names once there is room for them.
        // -----------------------------------------------------------------------------------------
        if opts.show_structures {
            let ink_soft = Color32::from_rgba_unmultiplied(20, 16, 12, 200);
            for (i, sref) in self.structures.iter().enumerate() {
                let (parts0, outline0, lw) = &structure_screen[i];
                let (parts, outline): (Vec<Vec<Pos2>>, Vec<Pos2>) = match structure_preview.as_ref().filter(|(id, _)| *id == sref.id) {
                    Some((_, target)) => {
                        let d = vec2((target.x - sref.anchor[0]) * zoom, -(target.y - sref.anchor[1]) * zoom);
                        (parts0.iter().map(|pt| pt.iter().map(|q| *q + d).collect()).collect(), outline0.iter().map(|q| *q + d).collect())
                    }
                    None => (parts0.clone(), outline0.clone()),
                };
                if outline.is_empty() {
                    continue;
                }
                let (mut bx0, mut by0, mut bx1, mut by1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
                for q in &outline {
                    bx0 = bx0.min(q.x);
                    by0 = by0.min(q.y);
                    bx1 = bx1.max(q.x);
                    by1 = by1.max(q.y);
                }
                if bx1 < rect.min.x - lw || bx0 > rect.max.x + lw || by1 < rect.min.y - lw || by0 > rect.max.y + lw {
                    continue;
                }
                let size = (bx1 - bx0).max(by1 - by0);
                let selected = selected_structure == Some(i);
                let hovered = hover == Hover::Structure(i);
                let col = rgba([sref.color[0], sref.color[1], sref.color[2], 1.0]);
                if !sref.closed {
                    // Walls: dark casing, stone fill; streets: soft casing, paved fill.
                    let wall = sref.kind == "wall";
                    let w = if wall { lw.max(1.6) } else { *lw };
                    polyline(&painter, &outline, Stroke::new(w + if wall { 2.0 } else { 1.4 }, if wall { Color32::from_rgba_unmultiplied(18, 20, 26, 230) } else { Color32::from_rgba_unmultiplied(40, 32, 24, 150) }));
                    polyline(&painter, &outline, Stroke::new(w, col));
                    if wall && w >= 4.0 {
                        // Crenellation ticks along the wall top.
                        dashed_polyline(&painter, &outline, Stroke::new(w * 0.35, lighten(col, 0.25)), w * 0.8, w * 0.8);
                    }
                } else if sref.parts.is_empty() || size < 1.0 {
                    if size >= 0.6 {
                        painter.rect_filled(Rect::from_center_size(pos2((bx0 + bx1) * 0.5, (by0 + by1) * 0.5), vec2(1.4, 1.4)), 0u8, col);
                    }
                } else {
                    let area = matches!(sref.kind.as_str(), "plaza" | "market" | "garden" | "field");
                    // A small drop shadow lifts buildings off the ground once they are a few pixels.
                    if !area && size > 6.0 {
                        let off = vec2(1.2, 1.4) * (size / 40.0).clamp(0.6, 2.5);
                        for part in &parts {
                            painter.add(Shape::convex_polygon(part.iter().map(|q| *q + off).collect(), Color32::from_rgba_unmultiplied(0, 0, 0, 70), Stroke::NONE));
                        }
                    }
                    let fill = if area { with_alpha(col, if sref.kind == "field" { 95 } else { 150 }) } else { col };
                    for part in &parts {
                        painter.add(Shape::convex_polygon(part.clone(), fill, Stroke::NONE));
                    }
                    if area && sref.kind == "field" && size > 18.0 {
                        // Furrows.
                        let n = ((size / 6.0) as usize).clamp(2, 40);
                        let (a, b, c) = (outline[0], outline.get(1).copied().unwrap_or(outline[0]), outline.get(3).copied().unwrap_or(outline[0]));
                        for k in 1..n {
                            let f = k as f32 / n as f32;
                            let p0 = pos2(a.x + (c.x - a.x) * f, a.y + (c.y - a.y) * f);
                            let p1 = pos2(p0.x + (b.x - a.x), p0.y + (b.y - a.y));
                            painter.line_segment([p0, p1], Stroke::new(0.7, Color32::from_rgba_unmultiplied(70, 80, 30, 110)));
                        }
                    }
                    if size > 3.0 {
                        let mut closed = outline.clone();
                        closed.push(outline[0]);
                        let edge = if area { with_alpha(darken(col, 0.35), 200) } else { ink_soft };
                        polyline(&painter, &closed, Stroke::new(if size > 30.0 { 1.2 } else { 0.8 }, edge));
                    }
                }
                if selected || hovered {
                    let mut closed = outline.clone();
                    if sref.closed {
                        closed.push(outline[0]);
                    }
                    let c = if selected { ACCENT_CYAN } else { Color32::from_white_alpha(200) };
                    let w = if sref.closed { 1.8 } else { lw + 3.0 };
                    if sref.closed {
                        polyline(&painter, &closed, Stroke::new(w, c));
                    } else {
                        polyline(&painter, &closed, Stroke::new(w, with_alpha(c, 110)));
                    }
                    if size < 6.0 {
                        painter.circle_stroke(pos2((bx0 + bx1) * 0.5, (by0 + by1) * 0.5), 6.0, Stroke::new(1.4, c));
                    }
                }
                if !sref.label.is_empty() && opts.show_labels && (size > 46.0 || selected) {
                    let c = if sref.closed { polygon_centroid(&outline) } else { outline[outline.len() / 2] };
                    text_pill(&painter, &ctx, c, Align2::CENTER_CENTER, &sref.label, FontId::proportional(9.5), TEXT_BRIGHT, Color32::from_rgba_unmultiplied(10, 14, 22, 170));
                }
            }
            // The rotation handle of the selected footprint.
            if let Some((_, c, h)) = rotate_handle.filter(|_| structure_preview.is_none()) {
                painter.line_segment([c, h], Stroke::new(1.2, with_alpha(ACCENT_CYAN, 180)));
                painter.circle_filled(h, 6.5, INK);
                painter.circle_filled(h, 5.0, ACCENT_CYAN);
                painter.text(h, Align2::CENTER_CENTER, icon("arrow-clockwise"), FontId::proportional(8.0), INK);
            }
        }

        // -----------------------------------------------------------------------------------------
        // 5''. Quest paths: the routes quests send the player along, in the quest's color, dashed
        //      with direction chevrons, from a "!" at the start to a flag at the end.
        // -----------------------------------------------------------------------------------------
        for (i, path) in self.paths.iter().enumerate() {
            let selected = opts.selected_id.as_deref() == Some(path.id.as_str());
            if path.path_type != "quest" || path.points.len() < 2 || !(opts.show_quests || selected) {
                continue;
            }
            let pts = screen_pts(path);
            let hovered = hover == Hover::Path(i);
            let base = rgba([path.color[0], path.color[1], path.color[2], 1.0]);
            let w = if selected { 3.4 } else if hovered { 3.0 } else { 2.4 };
            polyline(&painter, &pts, Stroke::new(w + 3.0, Color32::from_rgba_unmultiplied(8, 11, 17, 150)));
            if selected || hovered {
                polyline(&painter, &pts, Stroke::new(w + 7.0, if selected { Color32::from_rgba_unmultiplied(56, 189, 248, 90) } else { Color32::from_white_alpha(60) }));
            }
            dashed_polyline(&painter, &pts, Stroke::new(w, base), 9.0, 5.0);
            let mut run = 40.0;
            for wnd in pts.windows(2) {
                let len = (wnd[1].x - wnd[0].x).hypot(wnd[1].y - wnd[0].y);
                run += len;
                if run < 90.0 || len < 14.0 {
                    continue;
                }
                run = 0.0;
                let dir = vec2((wnd[1].x - wnd[0].x) / len, (wnd[1].y - wnd[0].y) / len);
                let m = pos2((wnd[0].x + wnd[1].x) * 0.5, (wnd[0].y + wnd[1].y) * 0.5);
                let nrm = vec2(-dir.y, dir.x);
                let tip = pos2(m.x + dir.x * 4.0, m.y + dir.y * 4.0);
                let back = pos2(m.x - dir.x * 4.0, m.y - dir.y * 4.0);
                painter.add(Shape::convex_polygon(vec![tip, pos2(back.x + nrm.x * 4.5, back.y + nrm.y * 4.5), pos2(back.x - nrm.x * 4.5, back.y - nrm.y * 4.5)], base, Stroke::new(1.0, INK)));
            }
            let (first, last) = (pts[0], pts[pts.len() - 1]);
            painter.circle_filled(first, 7.0, INK);
            painter.circle_filled(first, 5.6, base);
            painter.text(first, Align2::CENTER_CENTER, "!", FontId::proportional(9.0), INK);
            painter.circle_filled(last, 7.0, INK);
            painter.circle_filled(last, 5.6, base);
            painter.text(last, Align2::CENTER_CENTER, icon("flag"), FontId::proportional(8.0), INK);
            if selected {
                for p in &pts[1..pts.len() - 1] {
                    painter.circle_filled(*p, 3.2, ACCENT_CYAN);
                }
            }
            if opts.show_labels && (selected || hovered || zoom > fit_zoom * 1.6) {
                let mid = pts[pts.len() / 2];
                text_pill(&painter, &ctx, pos2(mid.x, mid.y - 12.0), Align2::CENTER_CENTER, &path.name, FontId::proportional(9.5), base, Color32::from_rgba_unmultiplied(10, 14, 22, 190));
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
        // 5a. Quest journeys: giver → objectives → turn-in, numbered; the highlighted one on top.
        // -----------------------------------------------------------------------------------------
        if opts.show_quests {
            let mut routes: Vec<&MapQuestRoute> = self.quest_routes.iter().filter(|q| q.points.len() >= 2).collect();
            routes.sort_by_key(|q| q.highlighted);
            for q in routes {
                let pts: Vec<Pos2> = q.points.iter().map(|p| w2s(p[0], p[1])).collect();
                let base = rgba([q.color[0], q.color[1], q.color[2], 1.0]);
                let (w, a) = if q.highlighted { (2.8, 255u8) } else { (1.6, 110u8) };
                if !q.markers_only {
                    polyline(&painter, &pts, Stroke::new(w + 2.5, Color32::from_rgba_unmultiplied(8, 11, 17, if q.highlighted { 150 } else { 60 })));
                    dashed_polyline(&painter, &pts, Stroke::new(w, with_alpha(base, a)), 6.0, 5.0);
                }
                // Chevrons on each leg toward the next stop.
                for wnd in pts.windows(if q.markers_only { usize::MAX } else { 2 }) {
                    let len = (wnd[1].x - wnd[0].x).hypot(wnd[1].y - wnd[0].y);
                    if len < 30.0 {
                        continue;
                    }
                    let dir = vec2((wnd[1].x - wnd[0].x) / len, (wnd[1].y - wnd[0].y) / len);
                    let m = pos2((wnd[0].x + wnd[1].x) * 0.5, (wnd[0].y + wnd[1].y) * 0.5);
                    let nrm = vec2(-dir.y, dir.x);
                    let back = pos2(m.x - dir.x * 6.0, m.y - dir.y * 6.0);
                    let tip = pos2(m.x + dir.x * 3.0, m.y + dir.y * 3.0);
                    painter.line_segment([pos2(back.x + nrm.x * 4.5, back.y + nrm.y * 4.5), tip], Stroke::new(w * 0.8, with_alpha(base, a)));
                    painter.line_segment([pos2(back.x - nrm.x * 4.5, back.y - nrm.y * 4.5), tip], Stroke::new(w * 0.8, with_alpha(base, a)));
                }
                if q.highlighted {
                    let last = pts.len() - 1;
                    for (k, p) in pts.iter().enumerate() {
                        // The giver is "!", the turn-in "?" (when it is not the giver), objectives numbered.
                        let label = if k == 0 { "!".to_string() } else if k == last { "?".to_string() } else { format!("{}", k) };
                        let off = pos2(p.x + 13.0, p.y - 13.0);
                        painter.circle_filled(off, 7.5, INK);
                        painter.circle_filled(off, 6.3, base);
                        painter.text(off, Align2::CENTER_CENTER, label, FontId::proportional(9.0), INK);
                    }
                    if let Some(first) = pts.first() {
                        text_pill(&painter, &ctx, pos2(first.x + 24.0, first.y - 13.0), Align2::LEFT_CENTER, &q.title, FontId::proportional(10.0), base, Color32::from_rgba_unmultiplied(10, 14, 22, 200));
                    }
                }
            }
        }

        // -----------------------------------------------------------------------------------------
        // 5b. Design intents: dashed outlines, journeys and pins in the kind's color, quieter once
        //     the world meets them, each with a numbered badge saying whether it does.
        // -----------------------------------------------------------------------------------------
        if opts.show_intents {
            for (i, (it, g)) in self.intents.iter().zip(intent_geoms.iter()).enumerate() {
                let selected = opts.selected_id.as_deref() == Some(it.id.as_str());
                let hovered = hover == Hover::Intent(i);
                let met = it.satisfied == Some(true);
                let base = rgba([it.color[0], it.color[1], it.color[2], 1.0]);
                let col = if selected { ACCENT_CYAN } else if met { ACCENT_EMERALD } else { base };
                let a_line: u8 = if selected || hovered { 255 } else if met { 150 } else { 230 };
                let under = Color32::from_rgba_unmultiplied(8, 11, 17, if met { 70 } else { 140 });
                match it.shape.as_str() {
                    "area" if g.pts.len() >= 3 => {
                        painter.add(Shape::convex_polygon(g.pts.clone(), with_alpha(col, if selected { 46 } else if met { 14 } else { 26 }), Stroke::NONE));
                        let mut closed = g.pts.clone();
                        closed.push(g.pts[0]);
                        polyline(&painter, &closed, Stroke::new(if selected { 4.5 } else { 3.6 }, under));
                        dashed_polyline(&painter, &closed, Stroke::new(if selected { 2.6 } else { 1.9 }, with_alpha(col, a_line)), 9.0, 5.0);
                        if selected {
                            for p in &g.pts {
                                painter.circle_filled(*p, 3.5, ACCENT_CYAN);
                            }
                        }
                    }
                    "route" if g.pts.len() >= 2 => {
                        polyline(&painter, &g.pts, Stroke::new(if selected { 5.0 } else { 4.2 }, under));
                        dashed_polyline(&painter, &g.pts, Stroke::new(if selected { 2.8 } else { 2.2 }, with_alpha(col, a_line)), 8.0, 5.0);
                        // Arrowhead at the destination.
                        let n = g.pts.len();
                        let (tip, prev) = (g.pts[n - 1], g.pts[n - 3]);
                        let len = (tip.x - prev.x).hypot(tip.y - prev.y).max(1e-3);
                        let d = vec2((tip.x - prev.x) / len, (tip.y - prev.y) / len);
                        let nrm = vec2(-d.y, d.x);
                        let back = pos2(tip.x - d.x * 11.0, tip.y - d.y * 11.0);
                        painter.add(Shape::convex_polygon(vec![tip, pos2(back.x + nrm.x * 5.5, back.y + nrm.y * 5.5), pos2(back.x - nrm.x * 5.5, back.y - nrm.y * 5.5)], with_alpha(col, a_line), Stroke::new(1.0, under)));
                        painter.circle_filled(g.pts[0], 5.0, INK);
                        painter.circle_filled(g.pts[0], 3.5, with_alpha(col, a_line));
                    }
                    _ => {
                        if let (Some(p), Some(h)) = (g.pts.first(), g.head) {
                            painter.line_segment([*p, pos2(h.x, h.y + 8.0)], Stroke::new(3.0, under));
                            painter.line_segment([*p, pos2(h.x, h.y + 8.0)], Stroke::new(1.6, with_alpha(col, a_line)));
                            painter.circle_filled(*p, 3.2, INK);
                            painter.circle_filled(*p, 2.2, col);
                            painter.circle_filled(pos2(h.x + 1.0, h.y + 2.0), 12.0, Color32::from_rgba_unmultiplied(0, 0, 0, 90));
                            painter.circle_filled(h, 11.5, INK);
                            painter.circle_filled(h, 10.0, with_alpha(col, if met { 200 } else { 255 }));
                            painter.text(h, Align2::CENTER_CENTER, format!("{}", it.number), FontId::proportional(10.5), INK);
                            if selected || hovered {
                                painter.circle_stroke(h, 14.0, Stroke::new(1.5, if selected { ACCENT_CYAN } else { Color32::from_white_alpha(170) }));
                            }
                        }
                    }
                }
                // The badge: status glyph, number and title; the check's verdict when selected.
                if g.badge.intersect(rect).is_positive() && (opts.show_labels || selected || hovered) {
                    let (glyph_name, glyph_col) = match it.satisfied {
                        Some(true) => ("check-circle", ACCENT_EMERALD),
                        Some(false) => ("x-circle", if it.status == "proposed" { GHOST_COLOR } else { base }),
                        None => ("circle-dashed", TEXT_DIM),
                    };
                    painter.rect_filled(g.badge, 6u8, Color32::from_rgba_unmultiplied(12, 16, 25, if met && !selected { 190 } else { 236 }));
                    painter.rect_stroke(g.badge, 6u8, Stroke::new(if selected { 1.6 } else { 1.0 }, if selected { ACCENT_CYAN } else { with_alpha(col, if met { 120 } else { 200 }) }), StrokeKind::Middle);
                    let row = g.badge.min.y + 10.0;
                    painter.text(pos2(g.badge.min.x + 12.0, row), Align2::CENTER_CENTER, icon(glyph_name), FontId::proportional(12.0), glyph_col);
                    painter.text(pos2(g.badge.min.x + 22.0, row), Align2::LEFT_CENTER, &g.title, badge_font.clone(), if met && !selected { TEXT_DIM } else { TEXT_BRIGHT });
                    if it.status == "proposed" || it.status == "claimed" {
                        let tag = if it.status == "proposed" { icon("robot") } else { icon("hourglass") };
                        painter.text(pos2(g.badge.max.x - 9.0, row), Align2::CENTER_CENTER, tag, FontId::proportional(11.0), GHOST_COLOR);
                    }
                    if g.show_summary {
                        painter.text(pos2(g.badge.min.x + 22.0, row + 14.0), Align2::LEFT_CENTER, &it.summary, FontId::proportional(9.5), if met { ACCENT_EMERALD } else { TEXT_DIM });
                    }
                }
            }
        }

        // -----------------------------------------------------------------------------------------
        // 5c. Proposed regions and paths (violet, dashed): what an agent would build.
        // -----------------------------------------------------------------------------------------
        let ghost_style = |i: usize, g: &MapGhost| -> (Color32, f32) {
            let selected = opts.selected_change_id.as_deref() == Some(g.id.as_str());
            if selected {
                (ACCENT_CYAN, 1.35)
            } else if hover == Hover::Ghost(i) {
                (Color32::from_rgb(220, 205, 255), 1.2)
            } else {
                (GHOST_COLOR, 1.0)
            }
        };
        if opts.show_proposals {
            for (i, g) in self.ghosts.iter().enumerate() {
                let pts = ghost_pts(g);
                let (col, k) = ghost_style(i, g);
                match g.kind.as_str() {
                    "region" if pts.len() >= 3 => {
                        painter.add(Shape::convex_polygon(pts.clone(), with_alpha(col, 30), Stroke::NONE));
                        let mut closed = pts.clone();
                        closed.push(pts[0]);
                        polyline(&painter, &closed, Stroke::new(4.0 * k, Color32::from_rgba_unmultiplied(20, 10, 40, 120)));
                        dashed_polyline(&painter, &closed, Stroke::new(2.0 * k, col), 6.0, 4.0);
                        let c = polygon_centroid(&pts);
                        text_pill(&painter, &ctx, c, Align2::CENTER_CENTER, &format!("+ {}", g.label), FontId::proportional(10.5), col, Color32::from_rgba_unmultiplied(20, 14, 38, 210));
                    }
                    "path" if pts.len() >= 2 => {
                        let w = match g.path_type.as_deref() {
                            Some("highway") => 4.2,
                            Some("trail") => 2.2,
                            _ => 3.2,
                        } * zoom_scale.min(1.6);
                        polyline(&painter, &pts, Stroke::new(w + 3.0 * k, Color32::from_rgba_unmultiplied(20, 10, 40, 150)));
                        dashed_polyline(&painter, &pts, Stroke::new(w * k, col), 7.0, 4.0);
                    }
                    "remove" if pts.len() >= 2 => {
                        dashed_polyline(&painter, &pts, Stroke::new(3.0 * k, ROSE), 5.0, 4.0);
                    }
                    _ => {}
                }
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
        // Proposed spots, moves and removals, on top of the real ones.
        if opts.show_proposals {
            for (i, g) in self.ghosts.iter().enumerate() {
                let pts = ghost_pts(g);
                let (col, k) = ghost_style(i, g);
                let Some(p) = pts.first().copied() else { continue };
                if !rect.expand(30.0).contains(p) && g.kind != "move" {
                    continue;
                }
                match g.kind.as_str() {
                    "spot" | "move" => {
                        if let (Some(from), "move") = (g.from, g.kind.as_str()) {
                            let a = w2s(from[0], from[1]);
                            polyline(&painter, &[a, p], Stroke::new(4.0, Color32::from_rgba_unmultiplied(20, 10, 40, 140)));
                            dashed_polyline(&painter, &[a, p], Stroke::new(2.0 * k, col), 6.0, 4.0);
                            let len = (p.x - a.x).hypot(p.y - a.y).max(1e-3);
                            let d = vec2((p.x - a.x) / len, (p.y - a.y) / len);
                            let nrm = vec2(-d.y, d.x);
                            let tip = pos2(p.x - d.x * 13.0, p.y - d.y * 13.0);
                            let back = pos2(tip.x - d.x * 9.0, tip.y - d.y * 9.0);
                            painter.add(Shape::convex_polygon(vec![tip, pos2(back.x + nrm.x * 5.0, back.y + nrm.y * 5.0), pos2(back.x - nrm.x * 5.0, back.y - nrm.y * 5.0)], col, Stroke::NONE));
                        }
                        let r = 9.5 * k;
                        painter.circle_filled(p, r + 5.0, with_alpha(col, 40));
                        painter.circle_filled(p, r, Color32::from_rgba_unmultiplied(26, 18, 48, 235));
                        // A dashed ring: eight arcs.
                        for seg in 0..8 {
                            let a0 = seg as f32 / 8.0 * std::f32::consts::TAU;
                            let arc: Vec<Pos2> = (0..=4).map(|q| {
                                let a = a0 + q as f32 / 4.0 * (std::f32::consts::TAU / 13.0);
                                pos2(p.x + a.cos() * (r + 2.5), p.y + a.sin() * (r + 2.5))
                            }).collect();
                            polyline(&painter, &arc, Stroke::new(1.8, col));
                        }
                        painter.text(p, Align2::CENTER_CENTER, icon(spot_icon_name(g.spot_type.as_deref().unwrap_or("landmark"))), FontId::proportional(r * 1.1), col);
                        let plus = pos2(p.x + r * 0.85, p.y - r * 0.85);
                        painter.circle_filled(plus, 6.0, col);
                        painter.text(plus, Align2::CENTER_CENTER, if g.kind == "move" { icon("arrow-right") } else { icon("plus") }, FontId::proportional(8.5), INK);
                        if opts.show_labels {
                            text_pill(&painter, &ctx, pos2(p.x, p.y + r + 6.0), Align2::CENTER_TOP, &g.label, FontId::proportional(10.0), col, Color32::from_rgba_unmultiplied(20, 14, 38, 215));
                        }
                    }
                    "remove" => {
                        painter.circle_stroke(p, 13.0, Stroke::new(2.0 * k, ROSE));
                        painter.line_segment([pos2(p.x - 8.0, p.y - 8.0), pos2(p.x + 8.0, p.y + 8.0)], Stroke::new(2.4, ROSE));
                        painter.line_segment([pos2(p.x - 8.0, p.y + 8.0), pos2(p.x + 8.0, p.y - 8.0)], Stroke::new(2.4, ROSE));
                    }
                    _ => {}
                }
            }
        }

        // -----------------------------------------------------------------------------------------
        // 6b. Codex placements: NPCs, enemy packs, faction outposts.
        // -----------------------------------------------------------------------------------------
        if opts.show_population {
            for (i, m) in self.markers.iter().enumerate() {
                let p = match &marker_preview {
                    Some((id, q)) if *id == m.id => w2s(q.x, q.y),
                    _ => w2s(m.x, m.y),
                };
                if !rect.expand(20.0).contains(p) {
                    continue;
                }
                let selected = opts.selected_id.as_deref() == Some(m.id.as_str());
                let hovered = hover == Hover::Marker(i);
                let col = rgba([m.color[0], m.color[1], m.color[2], 1.0]);
                if selected {
                    painter.circle_stroke(p, 11.5, Stroke::new(2.0, ACCENT_CYAN));
                }
                painter.circle_filled(p, 8.5, Color32::from_rgba_unmultiplied(8, 11, 17, 220));
                painter.circle_stroke(p, 7.5, Stroke::new(if hovered { 2.2 } else { 1.5 }, col));
                draw_glyph(&painter, &m.glyph, p, 9.0, col);
                if m.count > 1 {
                    let b = pos2(p.x + 8.0, p.y - 8.0);
                    let txt = format!("{}", m.count);
                    let tw = Painter::measure_text(&ctx, FontId::proportional(8.5), &txt).x;
                    let r = Rect::from_center_size(b, vec2(tw + 7.0, 12.0));
                    painter.rect_filled(r, 6u8, col);
                    painter.text(b, Align2::CENTER_CENTER, txt, FontId::proportional(8.5), INK);
                }
                if opts.show_labels && (selected || hovered || zoom > fit_zoom * 1.6) {
                    text_halo(&painter, pos2(p.x, p.y + 11.0), Align2::CENTER_TOP, &m.label, FontId::proportional(9.5), if selected { ACCENT_CYAN } else { lighten(col, 0.35) }, HALO);
                }
            }
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
            let intent_mode = opts.active_tool == "intent" || opts.active_tool == "sculpt";
            let is_region = matches!(opts.pending_mode.as_deref(), Some("region") | Some("intent_area") | Some("sculpt_area") | Some("build_area")) || opts.active_tool == "draw_region";
            let accent = if intent_mode || opts.active_tool == "quest_path" { ACCENT_AMBER } else if is_region { ACCENT_EMERALD } else { ACCENT_CYAN };
            // A line stroke's width, shown along the course.
            if let Some(b) = opts.brush.as_ref().filter(|_| opts.pending_mode.as_deref() == Some("sculpt_line")) {
                let mut course: Vec<Pos2> = opts.pending_points.iter().map(|p| w2s(p[0], p[1])).collect();
                if let Some(cw) = cursor_world.filter(|_| is_hovered) {
                    course.push(w2s(cw.x, cw.y));
                }
                polyline(&painter, &course, Stroke::new((b.radius_km * 2.0 * zoom).max(2.0), rgba([b.color[0], b.color[1], b.color[2], 0.18])));
            }
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
        }
        if let (Some(b), Some(cw)) = (opts.brush.as_ref(), st.current_pointer_world.filter(|_| is_hovered && !st.space_down)) {
            let cp = w2s(cw.x, cw.y);
            let col = rgba([b.color[0], b.color[1], b.color[2], 1.0]);
            let r = (b.radius_km * zoom).max(3.0);
            painter.circle_stroke(cp, r + 1.0, Stroke::new(3.0, Color32::from_rgba_unmultiplied(8, 11, 17, 120)));
            painter.circle_stroke(cp, r, Stroke::new(1.6, with_alpha(col, 230)));
            if st.stroke_active {
                painter.circle_filled(cp, r, with_alpha(col, 26));
            }
            painter.circle_filled(cp, 2.0, col);
        } else if let (Some(bc), Some(cw), true) = (
            opts.build_cursor.as_ref(),
            cursor_world.filter(|_| is_hovered && !st.space_down && st.dragging_structure_id.is_none() && st.rotating_structure_id.is_none()),
            opts.active_tool == "build" && opts.pending_points.is_empty() && !matches!(hover, Hover::Structure(_)),
        ) {
            // The building the next click places, where it will go.
            let col = rgba([bc.color[0], bc.color[1], bc.color[2], 1.0]);
            let to_s = |q: &[f32; 2]| w2s(cw.x + q[0], cw.y + q[1]);
            for part in &bc.parts {
                painter.add(Shape::convex_polygon(part.iter().map(to_s).collect(), with_alpha(col, 110), Stroke::NONE));
            }
            if bc.outline.len() >= 2 {
                let mut o: Vec<Pos2> = bc.outline.iter().map(to_s).collect();
                o.push(o[0]);
                polyline(&painter, &o, Stroke::new(1.4, with_alpha(ACCENT_CYAN, 230)));
            }
            let cp = w2s(cw.x, cw.y);
            painter.circle_filled(cp, 2.0, ACCENT_CYAN);
        } else if opts.pending_points.is_empty() && matches!(opts.active_tool.as_str(), "draw_path" | "quest_path" | "build" | "draw_region" | "place_spot" | "intent" | "sculpt" | "populate") {
            if let Some(cw) = cursor_world.filter(|_| is_hovered) {
                let cp = w2s(cw.x, cw.y);
                let accent = if matches!(opts.active_tool.as_str(), "place_spot" | "intent") { ACCENT_AMBER } else { ACCENT_CYAN };
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
                Hover::Intent(i) => {
                    let it = &self.intents[i];
                    let verdict = match it.satisfied {
                        Some(true) => ("met", ACCENT_EMERALD),
                        Some(false) => ("not met yet", rgba(it.color)),
                        None => ("checked by hand", TEXT_DIM),
                    };
                    let mut l = vec![
                        (format!("Intent #{}  ·  {}", it.number, it.kind), TEXT_BRIGHT, 11.5),
                        (it.summary.clone(), verdict.1, 10.0),
                    ];
                    if it.status == "proposed" {
                        l.push(("An agent proposed changes - review them on the map".into(), GHOST_COLOR, 9.5));
                    }
                    l
                }
                Hover::Marker(i) => {
                    let m = &self.markers[i];
                    vec![(m.label.clone(), rgba([m.color[0], m.color[1], m.color[2], 1.0]), 11.5), (m.detail.clone(), TEXT_DIM, 10.0)]
                }
                Hover::Structure(i) => {
                    let x = &self.structures[i];
                    let mut l = vec![(x.label.clone(), rgba([x.color[0], x.color[1], x.color[2], 1.0]), 11.5)];
                    if !x.detail.is_empty() {
                        l.push((x.detail.clone(), TEXT_DIM, 10.0));
                    }
                    if opts.selected_id.as_deref() == Some(x.id.as_str()) && x.rotatable {
                        l.push(("Drag to move · drag the handle to turn it".into(), TEXT_DIM, 9.5));
                    }
                    l
                }
                Hover::Ghost(i) => {
                    let g = &self.ghosts[i];
                    let what = match g.kind.as_str() {
                        "move" => "Proposed move",
                        "remove" => "Proposed removal",
                        _ => "Proposed",
                    };
                    vec![(format!("{}: {}", what, g.label), GHOST_COLOR, 11.5), ("Click to review - accept or reject in the inspector".into(), TEXT_DIM, 9.5)]
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

        // What is painted under the cursor, while painting.
        if let (Some(ov), Some(cw), true) = (self.overlay.as_ref(), st.current_pointer_world, matches!(opts.active_tool.as_str(), "paint" | "populate") && is_hovered && !st.is_panning) {
            let c = ((cw.x + half_w) / (opts.world_width_km / ov.cols as f32)).floor();
            let r = ((half_h - cw.y) / (opts.world_height_km / ov.rows as f32)).floor();
            if c >= 0.0 && r >= 0.0 && (c as usize) < ov.cols && (r as usize) < ov.rows {
                let k = r as usize * ov.cols + c as usize;
                let mut here: Vec<(f32, &MapOverlayLayer)> = ov.layers.iter().map(|l| (l.data[k], l)).filter(|(d, _)| *d > 0.02).collect();
                here.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
                if !here.is_empty() {
                    let text = here.iter().take(4).map(|(d, l)| format!("{} {:.0}%", l.label, d * 100.0)).collect::<Vec<_>>().join("  ·  ");
                    let p = w2s(cw.x, cw.y);
                    text_pill(&painter, &ctx, pos2(p.x + 16.0, p.y + 20.0), Align2::LEFT_CENTER, &text, FontId::proportional(10.0), TEXT_BRIGHT, PANEL_BG);
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
            if opts.show_population {
                for m in &self.markers {
                    mini.circle_filled(w2m(m.x, m.y), 1.6, rgba([m.color[0], m.color[1], m.color[2], 1.0]));
                }
            }
            if opts.show_intents {
                for it in &self.intents {
                    let pts: Vec<Pos2> = it.points.iter().map(|q| w2m(q[0], q[1])).collect();
                    let col = if it.satisfied == Some(true) { ACCENT_EMERALD } else { rgba(it.color) };
                    if it.shape == "area" && pts.len() >= 3 {
                        let mut closed = pts.clone();
                        closed.push(pts[0]);
                        dashed_polyline(&mini, &closed, Stroke::new(1.0, col), 3.0, 2.0);
                    } else if it.shape == "route" && pts.len() >= 2 {
                        dashed_polyline(&mini, &pts, Stroke::new(1.0, col), 3.0, 2.0);
                    } else if let Some(p) = pts.first() {
                        mini.circle_filled(*p, 2.6, col);
                    }
                }
            }
            if opts.show_proposals {
                for g in &self.ghosts {
                    if let Some(p) = g.points.first() {
                        mini.circle_filled(w2m(p[0], p[1]), 1.8, GHOST_COLOR);
                    }
                }
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
            "sculpt" => match (opts.pending_mode.as_deref(), opts.pending_points.len()) {
                (Some("sculpt_line"), 0) => "Click along the course · Enter applies · Esc cancels",
                (Some("sculpt_line"), _) => "Click to add points · Enter or double-click applies · Esc cancels",
                (Some("sculpt_area"), 0) => "Outline the area to level",
                (Some("sculpt_area"), _) => "Click to add vertices · Enter or double-click levels it",
                _ => "Drag to sculpt · [ ] brush size · right-drag pans",
            },
            "paint" => "Drag to paint planning marks · right-drag pans",
            "populate" => "Click to place · drag to paint where they roam",
            "intent" => match (opts.pending_mode.as_deref(), opts.pending_points.len()) {
                (Some("intent_area"), 0) => "Intent area: click to start outlining what you want here",
                (Some("intent_area"), _) => "Click to add vertices · Enter or double-click to close · Esc cancels",
                (Some("intent_route"), 0) => "Intent route: click where the journey starts (snaps to spots)",
                (Some("intent_route"), _) => "Click where the journey ends",
                _ => "Intent pin: click the place you have in mind",
            },
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
    fn overlays_must_cover_the_grid_and_jitter_stays_in_the_cell() {
        let layer = |n: usize| MapOverlayLayer { key: "forest".into(), label: "Forest".into(), color: [0.2, 0.6, 0.3, 0.9], glyph: "tree".into(), data: vec![0.5; n] };
        assert!(MapOverlay { cols: 4, rows: 3, layers: vec![layer(12)] }.valid());
        assert!(!MapOverlay { cols: 4, rows: 3, layers: vec![layer(11)] }.valid());
        // A malformed overlay is dropped rather than indexed out of bounds.
        assert!(GameMap::new("t").overlay(Some(MapOverlay { cols: 4, rows: 3, layers: vec![layer(5)] })).overlay.is_none());
        for c in 0..20 {
            for r in 0..20 {
                let h = cell_hash(c, r, 3);
                assert!((0.0..=1.0).contains(&h));
            }
        }
        assert_ne!(cell_hash(1, 2, 0), cell_hash(2, 1, 0));
    }

    #[test]
    fn a_route_bows_between_its_ends() {
        let (a, b) = (pos2(0.0, 0.0), pos2(100.0, 0.0));
        let curve = bowed(a, b);
        assert_eq!(curve.first().copied(), Some(a));
        assert!((curve.last().unwrap().x - 100.0).abs() < 1e-3 && curve.last().unwrap().y.abs() < 1e-3);
        // The middle sits off the straight line (by 8% of its length: half the 16% control offset).
        let mid = curve[curve.len() / 2];
        assert!((mid.x - 50.0).abs() < 0.5 && (mid.y.abs() - 8.0).abs() < 0.5, "{mid:?}");
        assert!(near_polyline(mid, &curve, 0.5));
        assert!(!near_polyline(pos2(50.0, 0.0), &curve, 3.0), "hit-testing follows the bow, not the chord");
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

    #[test]
    fn bicubic_passes_through_the_grid_and_stays_smooth_between() {
        let t = cone(17);
        for (c, r) in [(0usize, 0usize), (8, 8), (3, 11), (16, 5)] {
            assert!((bicubic(&t, c as f32, r as f32) - t.data[r * 17 + c]).abs() < 1e-3);
        }
        // Halfway between two samples on a slope: between them.
        let (a, b) = (t.data[8 * 17 + 4], t.data[8 * 17 + 5]);
        let mid = bicubic(&t, 4.5, 8.0);
        assert!(mid > a.min(b) - 1.0 && mid < a.max(b) + 1.0, "{a} {mid} {b}");
    }

    #[test]
    fn micro_relief_is_bounded_and_world_anchored() {
        let mut worst: f32 = 0.0;
        for k in 0..400 {
            let (x, y) = (k as f32 * 37.3, k as f32 * -11.9);
            let v = micro_relief(x, y, 200.0, 5.0, 4.0);
            worst = worst.max(v.abs());
            assert_eq!(v, micro_relief(x, y, 200.0, 5.0, 4.0));
        }
        // Octave amplitudes 5 + 2.5 + 1.25 + ... stay under twice the first.
        assert!(worst <= 10.0 && worst > 0.5, "{worst}");
        // No octave finer than the screen can show: nothing at all when the cell is already small.
        assert_eq!(micro_relief(10.0, 10.0, 200.0, 5.0, 500.0), 0.0);
    }

    #[test]
    fn fine_mesh_covers_the_view_with_valid_triangles() {
        let t = cone(17);
        let opts = GameMapOptions { world_width_km: 10.0, world_height_km: 10.0, ..Default::default() };
        let cache = build_terrain_cache(&t, &opts, 1);
        let w2s = |x: f32, y: f32| pos2(x * 100.0, -y * 100.0);
        let fine = build_fine_terrain(&t, &opts, &cache, [-2.0, 2.0, -1.0, 1.0], 100.0, 2.0, &w2s, 7);
        assert!(fine.verts.len() > 1000 && fine.verts.len() <= 420 * 420);
        assert_eq!(fine.idx.len() % 6, 0);
        assert!(fine.idx.iter().all(|&i| (i as usize) < fine.verts.len()));
        assert_eq!(fine.key, 7);
    }
}

//! Earth's cities: OpenStreetMap buildings and roads (osm.rs) placed on the real ground, streamed
//! in zoom-14 tiles (~2.4 km) around the viewer.
//!
//! Each tile, once its map data and the elevation under it are in, becomes:
//! - **Placements**: every building's footprint fitted with a rectangle (the minimum-area
//!   oriented rectangle around it), the ground under it (lowest and highest point, from the same
//!   height function the terrain is drawn from), its height and color, and a seed from its
//!   position, so it is the same building on every visit. Buildings that fit the house rule (a
//!   size range the addon passes, matching its house model) are `house`s, turned to face the
//!   nearest street; the addon draws those itself, close up, as full models (quadplanet's
//!   qp_city.ts: Mesha houses with interiors).
//! - **One mesh**, in the addon's pipeline: a box per building (level of detail 2, what you see
//!   from a few hundred meters out to the edge of the city radius), and the roads as ribbons
//!   draped on the ground. Each box vertex carries the offset to its building's anchor (uv and
//!   alpha, see `box_vertex`), so the shader can fold away the boxes of houses near the camera:
//!   the addon sets that radius to wherever its models have taken over.
//!
//! Everything above runs on worker threads: fetching (or reading the cached) tile, decoding it,
//! sampling the ground, building the mesh. A tile whose ground needs elevation tiles still
//! downloading waits for them (like a terrain chunk) and is retried, so placements never depend
//! on what happened to be loaded.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::elevation::{Access, ElevationSource, Lookup, TileId};
use super::math::*;
use super::osm::{self, LoadError, OsmLoader, OsmTile, RoadClass, CITY_ZOOM};
use super::planet::earth_surface;

/// Material ids (uv.x's integer part) the QuadPlanet shader knows (qp_shader.ts).
pub const MATERIAL_BUILDING_BOX: f32 = 8.0;
pub const MATERIAL_ROAD: f32 = 10.0;
const WORKERS: usize = 2;
/// Box bottoms reach this far below the lowest ground under them, so slopes don't show a gap.
const FOUNDATION_DEPTH: f64 = 1.0;
/// Roads float this far above the ground.
const ROAD_LIFT: f64 = 0.12;
/// Road center lines are resampled at least this often (meters) to follow the ground.
const ROAD_STEP: f64 = 6.0;

fn yes() -> bool { true }

/// The size range of the addon's house model; footprints in it become `house` placements.
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HouseRule {
    pub min_width: f64,
    pub max_width: f64,
    pub min_depth: f64,
    pub max_depth: f64,
    /// Taller buildings (OSM render_height, meters) are not houses.
    pub max_height: f64,
    /// Smaller footprints (sheds, garages; square meters) are not houses.
    pub min_area: f64,
    /// A footprint this far outside the range (a share: 0.08 is 8%) still fits; the house is
    /// clamped to the range.
    pub tolerance: f64,
}

impl Default for HouseRule {
    fn default() -> Self {
        Self { min_width: 7.8, max_width: 18.0, min_depth: 6.0, max_depth: 16.0, max_height: 13.5, min_area: 40.0, tolerance: 0.08 }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CityConfig {
    #[serde(default = "yes")]
    pub enabled: bool,
    /// A TileJSON URL or `{z}/{x}/{y}` template of OpenMapTiles-schema vector tiles (default
    /// OpenFreeMap).
    #[serde(default)]
    pub tile_url: Option<String>,
    /// Tiles within this many meters of the viewer are loaded (default 3000).
    #[serde(default)]
    pub radius: Option<f64>,
    /// No city above this altitude (meters above sea level; default 8000).
    #[serde(default)]
    pub max_altitude: Option<f64>,
    #[serde(default)]
    pub house: Option<HouseRule>,
}

/// One building, as the addon sees it (see the module docs).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    /// Stable id: a hash of the footprint's position and size.
    pub key: String,
    pub seed: u32,
    /// "house" (the addon's model fits) or "box".
    pub kind: &'static str,
    /// World position of the footprint's center at the lowest ground under it.
    pub anchor: V3,
    /// World unit vectors: across the front, up (the planet's radial), and out of the front
    /// (toward the street for a house). A model with +Y up and its front toward +Z maps its X, Y,
    /// Z onto these.
    pub right: V3,
    pub up: V3,
    pub forward: V3,
    /// Along `right` and `forward` (a house's are clamped to the house rule).
    pub width: f64,
    pub depth: f64,
    /// OSM render height and min height (meters above the ground).
    pub height: f64,
    pub min_height: f64,
    /// Lowest and highest ground under the footprint, meters above sea level.
    pub ground_min: f64,
    pub ground_max: f64,
    /// Footprint area (m²) and how much of its rectangle it fills (1: a rectangle).
    pub area: f64,
    pub fill: f64,
    pub colour: Option<[f32; 3]>,
    pub lat: f64,
    pub lon: f64,
}

/// What a worker made of one tile.
pub struct BuiltTile {
    pub id: TileId,
    /// World position of the tile's frame origin and its axes (east, up, south).
    pub origin: V3,
    pub basis: [V3; 3],
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    pub placements: Vec<Placement>,
    pub buildings: usize,
    pub roads: usize,
}

/// The planet facts the workers need (they don't hold the planet itself).
#[derive(Clone)]
pub struct CityEnv {
    pub center: V3,
    pub radius: f64,
    pub has_sea: bool,
    /// The finest terrain spacing: where the walker's feet meet the ground.
    pub spacing: f64,
    pub elevation: Arc<ElevationSource>,
    pub rule: HouseRule,
}

impl CityEnv {
    /// Drawn ground height (meters above sea level) along a planet-relative direction.
    pub fn ground(&self, d: V3, lk: &mut Lookup) -> f64 {
        let (lat, lon) = dir_to_lat_lon(d);
        earth_surface(self.elevation.sample(lat, lon, self.spacing, lk).height, self.has_sea).surface
    }
}

// --- Geometry helpers ------------------------------------------------------------------------

type P2 = [f64; 2];

fn convex_hull(points: &[P2]) -> Vec<P2> {
    let mut pts = points.to_vec();
    pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap().then(a[1].partial_cmp(&b[1]).unwrap()));
    pts.dedup();
    if pts.len() < 3 { return pts; }
    let cross = |o: P2, a: P2, b: P2| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut lower: Vec<P2> = Vec::new();
    for &p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 { lower.pop(); }
        lower.push(p);
    }
    let mut upper: Vec<P2> = Vec::new();
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 { upper.pop(); }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// The minimum-area rectangle around `points`: center, unit axis `u` (v is u turned +90°), and
/// half extents along u and v.
#[derive(Clone, Copy, Debug)]
pub struct Rect { pub center: P2, pub u: P2, pub half_u: f64, pub half_v: f64 }

pub fn min_area_rect(points: &[P2]) -> Option<Rect> {
    let hull = convex_hull(points);
    if hull.len() < 3 { return None; }
    let mut best: Option<(f64, Rect)> = None;
    for i in 0..hull.len() {
        let (a, b) = (hull[i], hull[(i + 1) % hull.len()]);
        let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
        if len < 1e-9 { continue; }
        let u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        let (mut lo_u, mut hi_u, mut lo_v, mut hi_v) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for p in &hull {
            let s = p[0] * u[0] + p[1] * u[1];
            let t = -p[0] * u[1] + p[1] * u[0];
            lo_u = lo_u.min(s); hi_u = hi_u.max(s); lo_v = lo_v.min(t); hi_v = hi_v.max(t);
        }
        let area = (hi_u - lo_u) * (hi_v - lo_v);
        if best.as_ref().map_or(true, |(a, _)| area < *a - 1e-9) {
            let (cs, ct) = ((lo_u + hi_u) / 2.0, (lo_v + hi_v) / 2.0);
            let center = [cs * u[0] - ct * u[1], cs * u[1] + ct * u[0]];
            best = Some((area, Rect { center, u, half_u: (hi_u - lo_u) / 2.0, half_v: (hi_v - lo_v) / 2.0 }));
        }
    }
    best.map(|(_, r)| r)
}

fn polygon_area(points: &[P2]) -> f64 {
    let mut a = 0.0;
    for i in 0..points.len() {
        let (p, q) = (points[i], points[(i + 1) % points.len()]);
        a += p[0] * q[1] - q[0] * p[1];
    }
    (a / 2.0).abs()
}

/// A house's width (across the front) and depth for a front facing `front` (2D unit), or None.
fn house_fit(rule: &HouseRule, width: f64, depth: f64) -> Option<(f64, f64)> {
    let t = rule.tolerance.max(0.0);
    let ok = |x: f64, lo: f64, hi: f64| x >= lo * (1.0 - t) && x <= hi * (1.0 + t);
    if ok(width, rule.min_width, rule.max_width) && ok(depth, rule.min_depth, rule.max_depth) {
        Some((width.clamp(rule.min_width, rule.max_width), depth.clamp(rule.min_depth, rule.max_depth)))
    } else { None }
}

/// Street points of a tile in a grid, for "which way does this house face".
struct StreetIndex { cell: f64, cells: HashMap<(i64, i64), Vec<P2>> }

impl StreetIndex {
    fn new(cell: f64) -> Self { Self { cell, cells: HashMap::new() } }
    fn add(&mut self, p: P2) {
        self.cells.entry(((p[0] / self.cell).floor() as i64, (p[1] / self.cell).floor() as i64)).or_default().push(p);
    }
    fn nearest(&self, p: P2, max: f64) -> Option<P2> {
        let r = (max / self.cell).ceil() as i64;
        let (cx, cy) = ((p[0] / self.cell).floor() as i64, (p[1] / self.cell).floor() as i64);
        let mut best: Option<(f64, P2)> = None;
        for dx in -r..=r {
            for dy in -r..=r {
                for q in self.cells.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                    let d = (q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2);
                    if d <= max * max && best.map_or(true, |(b, _)| d < b) { best = Some((d, *q)); }
                }
            }
        }
        best.map(|(_, q)| q)
    }
}

/// Facades for buildings OSM gives no color: plaster, stone, brick and concrete (sRGB).
const FACADES: [[f32; 3]; 8] = [
    [0.86, 0.83, 0.76], [0.78, 0.74, 0.66], [0.72, 0.66, 0.58], [0.66, 0.42, 0.33],
    [0.82, 0.8, 0.78], [0.6, 0.6, 0.6], [0.9, 0.87, 0.8], [0.7, 0.62, 0.52],
];
const ROOF: [f32; 3] = [0.34, 0.33, 0.33];

pub fn building_key(lat: f64, lon: f64, area: f64) -> u64 {
    crate::helpers::mesh_cache::stable_hash(&format!("{lat:.6},{lon:.6},{:.0}", area))
}

// --- Building a tile -------------------------------------------------------------------------

/// The tile's frame: origin on the sea-level sphere under the tile's center, axes east, up,
/// south (right-handed, +Y up like a model). Planet-relative.
pub fn tile_frame(id: TileId, radius: f64) -> (V3, [V3; 3]) {
    let c = osm::tile_point_to_lat_lon(id, 1, 0.5, 0.5);
    let up = lat_lon_to_dir(c[0], c[1]);
    let east = normalize(cross([0.0, 1.0, 0.0], up));
    let south = cross(east, up);
    (scale(up, radius), [east, up, south])
}

struct MeshOut { v: Vec<f32>, i: Vec<u32> }

impl MeshOut {
    fn vertex(&mut self, p: V3, n: V3, uv: [f64; 2], c: [f32; 3], a: f64) -> u32 {
        let k = (self.v.len() / 12) as u32;
        self.v.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32, n[0] as f32, n[1] as f32, n[2] as f32, uv[0] as f32, uv[1] as f32, c[0], c[1], c[2], a as f32]);
        k
    }
}

/// Builds one tile. Returns None (and sets `lk.missing`) while elevation it needs is in flight.
pub fn build_tile(id: TileId, data: &OsmTile, env: &CityEnv, lk: &mut Lookup) -> Option<BuiltTile> {
    let (origin, basis) = tile_frame(id, env.radius);
    let [east, up_t, south] = basis;
    let north = scale(south, -1.0);
    let r = env.radius;
    // Planet-relative point of a tile-plane position (meters east/north of the origin), on the
    // sea-level sphere.
    let on_sphere = |x: f64, y: f64| -> V3 { normalize(add(origin, add(scale(east, x), scale(north, y)))) };
    let plane = |lat: f64, lon: f64| -> P2 {
        let p = sub(scale(lat_lon_to_dir(lat, lon), r), origin);
        [dot(p, east), dot(p, north)]
    };
    let to_local = |p: V3| -> V3 { let q = sub(p, origin); [dot(q, east), dot(q, up_t), dot(q, south)] };
    let dir_local = |d: V3| -> V3 { [dot(d, east), dot(d, up_t), dot(d, south)] };

    let mut mesh = MeshOut { v: Vec::new(), i: Vec::new() };

    // Streets, for house orientation.
    let mut streets = StreetIndex::new(20.0);
    let roads2d: Vec<(Vec<P2>, RoadClass)> = data.roads.iter().map(|rd| (rd.points.iter().map(|p| plane(p[0], p[1])).collect(), rd.class)).collect();
    for (pts, class) in &roads2d {
        if !class.is_street() { continue; }
        for w in pts.windows(2) {
            let len = ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt();
            let n = (len / 8.0).ceil().max(1.0) as usize;
            for k in 0..=n {
                let t = k as f64 / n as f64;
                streets.add([w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t]);
            }
        }
    }

    let mut placements = Vec::new();
    for b in &data.buildings {
        let pts: Vec<P2> = b.ring.iter().map(|p| plane(p[0], p[1])).collect();
        let Some(rect) = min_area_rect(&pts) else { continue };
        let area = polygon_area(&pts);
        let fill = (area / (4.0 * rect.half_u * rect.half_v).max(1e-9)).min(1.0);
        let up_b = on_sphere(rect.center[0], rect.center[1]);
        let lift = |v2: P2| -> V3 { normalize(sub(add(scale(east, v2[0]), scale(north, v2[1])), scale(up_b, dot(add(scale(east, v2[0]), scale(north, v2[1])), up_b)))) };
        let u3 = lift(rect.u);
        let v3 = cross(up_b, u3);
        let at = |s: f64, t: f64| -> V3 { normalize(add(scale(up_b, r), add(scale(u3, s), scale(v3, t)))) };

        // The ground under it: center, corners and edge midpoints.
        let (hu, hv) = (rect.half_u, rect.half_v);
        let (mut gmin, mut gmax) = (f64::MAX, f64::MIN);
        for (s, t) in [(0.0, 0.0), (-hu, -hv), (hu, -hv), (hu, hv), (-hu, hv), (0.0, -hv), (hu, 0.0), (0.0, hv), (-hu, 0.0)] {
            let g = env.ground(at(s, t), lk);
            gmin = gmin.min(g);
            gmax = gmax.max(g);
        }
        if lk.missing { return None; }

        let (lat, lon) = dir_to_lat_lon(up_b);
        let hash = building_key(lat, lon, area);
        let colour = b.colour.unwrap_or(FACADES[(hash % FACADES.len() as u64) as usize]);

        // A house? Pick the front that fits the house rule and faces the nearest street.
        let mut kind = "box";
        let (mut fwd2, mut half_w, mut half_d) = ([-rect.u[1], rect.u[0]], hu, hv);
        if b.min_height <= 0.0 && b.height <= env.rule.max_height && area >= env.rule.min_area {
            let street = streets.nearest(rect.center, 60.0);
            let toward = street.map(|q| { let d = [q[0] - rect.center[0], q[1] - rect.center[1]]; let l = (d[0] * d[0] + d[1] * d[1]).sqrt().max(1e-9); [d[0] / l, d[1] / l] });
            let v2 = [-rect.u[1], rect.u[0]];
            let candidates = [
                ([v2[0], v2[1]], 2.0 * hu, 2.0 * hv), ([-v2[0], -v2[1]], 2.0 * hu, 2.0 * hv),
                ([rect.u[0], rect.u[1]], 2.0 * hv, 2.0 * hu), ([-rect.u[0], -rect.u[1]], 2.0 * hv, 2.0 * hu),
            ];
            let mut best: Option<(f64, P2, f64, f64)> = None;
            for (k, (f, w, d)) in candidates.iter().enumerate() {
                let Some((w, d)) = house_fit(&env.rule, *w, *d) else { continue };
                // Toward the street if there is one; else the long side to the front, and a
                // fixed preference so the choice is stable.
                let score = match toward { Some(t) => f[0] * t[0] + f[1] * t[1], None => if w >= d { 1.0 } else { 0.0 } } - k as f64 * 1e-6;
                if best.map_or(true, |(s, ..)| score > s) { best = Some((score, *f, w, d)); }
            }
            if let Some((_, f, w, d)) = best {
                kind = "house";
                fwd2 = f;
                half_w = w / 2.0;
                half_d = d / 2.0;
            }
        }
        let forward = lift(fwd2);
        let right = cross(up_b, forward);
        let anchor_rel = scale(up_b, r + gmin);

        // The box: a house's own footprint (so the model replaces it in place), else the rectangle.
        let replaceable = kind == "house";
        let bottom = if b.min_height > 0.0 { gmax + b.min_height } else { gmin - FOUNDATION_DEPTH };
        let top = gmax + b.height;
        let anchor_l = to_local(anchor_rel);
        let corner = |sx: f64, sz: f64, h: f64| -> V3 {
            let d = normalize(add(scale(up_b, r), add(scale(right, sx * half_w), scale(forward, sz * half_d))));
            to_local(scale(d, r + h))
        };
        let box_vertex = |m: &mut MeshOut, p: V3, n: V3, c: [f32; 3]| -> u32 {
            // The anchor is p minus (uv-encoded x/z offsets, alpha-encoded height): see the shader.
            let dx = (p[0] - anchor_l[0]).clamp(-999.0, 999.0);
            let dz = (p[2] - anchor_l[2]).clamp(-999.0, 999.0);
            let uv = [MATERIAL_BUILDING_BOX as f64 + 0.5 + dx / 4000.0, if replaceable { 1.0 } else { 0.0 } + 0.5 + dz / 4000.0];
            m.vertex(p, n, uv, c, p[1] - anchor_l[1])
        };
        let ring = [(-1.0, 1.0), (1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)];
        let up_l = dir_local(up_b);
        for k in 0..4 {
            let (a, c) = (ring[k], ring[(k + 1) % 4]);
            let (a0, a1) = (corner(a.0, a.1, bottom), corner(a.0, a.1, top));
            let (c0, c1) = (corner(c.0, c.1, bottom), corner(c.0, c.1, top));
            let n = normalize(cross(sub(c0, a0), sub(a1, a0)));
            let i0 = box_vertex(&mut mesh, a0, n, colour);
            let i1 = box_vertex(&mut mesh, c0, n, colour);
            let i2 = box_vertex(&mut mesh, c1, n, colour);
            let i3 = box_vertex(&mut mesh, a1, n, colour);
            mesh.i.extend_from_slice(&[i0, i1, i2, i0, i2, i3]);
        }
        let tops: Vec<u32> = ring.iter().map(|&(sx, sz)| box_vertex(&mut mesh, corner(sx, sz, top), up_l, ROOF)).collect();
        mesh.i.extend_from_slice(&[tops[0], tops[1], tops[2], tops[0], tops[2], tops[3]]);

        placements.push(Placement {
            key: format!("{hash:016x}"),
            seed: (hash >> 32) as u32,
            kind,
            anchor: add(env.center, anchor_rel),
            right, up: up_b, forward,
            width: 2.0 * half_w,
            depth: 2.0 * half_d,
            height: b.height,
            min_height: b.min_height,
            ground_min: gmin,
            ground_max: gmax,
            area,
            fill,
            colour: b.colour,
            lat, lon,
        });
    }

    // Roads: ribbons following the ground, a little above it.
    let mut road_count = 0;
    for (pts, class) in &roads2d {
        // Resample so the ribbon follows the ground between map points.
        let mut line: Vec<P2> = Vec::new();
        for w in pts.windows(2) {
            let len = ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt();
            let n = (len / ROAD_STEP).ceil().max(1.0) as usize;
            for k in 0..n { let t = k as f64 / n as f64; line.push([w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t]); }
        }
        if let Some(last) = pts.last() { line.push(*last); }
        line.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6);
        if line.len() < 2 { continue; }
        let half = class.width() / 2.0;
        let color = class.color();
        let mut prev: Option<(u32, u32)> = None;
        for k in 0..line.len() {
            // Direction along the line here (averaged at interior points), and its left normal.
            let (a, b) = (line[k.saturating_sub(1)], line[(k + 1).min(line.len() - 1)]);
            let d = [b[0] - a[0], b[1] - a[1]];
            let l = (d[0] * d[0] + d[1] * d[1]).sqrt().max(1e-9);
            let side = [-d[1] / l, d[0] / l];
            let p = line[k];
            let mut ends = [0u32; 2];
            for (j, s) in [-1.0, 1.0].iter().enumerate() {
                let q = [p[0] + side[0] * half * s, p[1] + side[1] * half * s];
                let dir = on_sphere(q[0], q[1]);
                let g = env.ground(dir, lk);
                ends[j] = mesh.vertex(to_local(scale(dir, r + g + ROAD_LIFT)), dir_local(dir), [MATERIAL_ROAD as f64 + 0.5, 0.5], color, 0.0);
            }
            if let Some((l0, r0)) = prev {
                // Counter-clockwise from above (ends[0] is the right edge, ends[1] the left).
                mesh.i.extend_from_slice(&[l0, r0, ends[1], r0, ends[0], ends[1]]);
            }
            prev = Some((ends[1], ends[0]));
        }
        road_count += 1;
    }
    if lk.missing { return None; }

    Some(BuiltTile {
        id,
        origin: add(env.center, origin),
        basis,
        vertices: mesh.v,
        indices: mesh.i,
        buildings: placements.len(),
        placements,
        roads: road_count,
    })
}

// --- Streaming -------------------------------------------------------------------------------

struct Job {
    id: TileId,
    data: Option<OsmTile>,
    not_before: Instant,
    attempts: u32,
}

struct Shared {
    queue: Mutex<Vec<Job>>,
    wake: Condvar,
    closed: AtomicBool,
    done: Mutex<Vec<Result<BuiltTile, (TileId, String)>>>,
    /// Planet-relative viewer: workers take the nearest tile first.
    viewer: Mutex<V3>,
    busy: Mutex<HashSet<TileId>>,
    loader: OsmLoader,
    env: CityEnv,
}

/// A city tile that is drawn.
pub struct LiveTile {
    pub mesh_id: String,
    pub buffer_id: String,
    pub origin: V3,
    pub basis: [V3; 3],
    pub placements: Vec<Placement>,
    pub triangles: usize,
    pub roads: usize,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CityStats {
    pub enabled: bool,
    pub live: usize,
    pub wanted: usize,
    /// Tiles queued or being built.
    pub pending: usize,
    pub failed: usize,
    pub buildings: usize,
    pub houses: usize,
    pub roads: usize,
    pub triangles: usize,
}

pub struct CityLayer {
    pub planet: usize,
    pub radius: f64,
    pub max_altitude: f64,
    shared: Arc<Shared>,
    pub live: HashMap<TileId, LiveTile>,
    wanted: HashSet<TileId>,
    failed: HashSet<TileId>,
    pub last_errors: Vec<String>,
}

impl Drop for CityLayer {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.shared.wake.notify_all();
    }
}

/// What `update` asks the caller to do with engine meshes.
pub struct CityUpdate {
    pub created: Vec<(TileId, BuiltTile)>,
    pub destroyed: Vec<LiveTile>,
}

fn tile_center_dir(id: TileId) -> V3 {
    let c = osm::tile_point_to_lat_lon(id, 1, 0.5, 0.5);
    lat_lon_to_dir(c[0], c[1])
}

impl CityLayer {
    pub fn new(planet: usize, config: &CityConfig, env: CityEnv, cache_dir: Option<std::path::PathBuf>) -> Self {
        Self::with_loader(planet, config, env, OsmLoader::http(config.tile_url.clone(), cache_dir))
    }

    pub fn with_loader(planet: usize, config: &CityConfig, mut env: CityEnv, loader: OsmLoader) -> Self {
        if let Some(rule) = &config.house { env.rule = rule.clone(); }
        let shared = Arc::new(Shared {
            queue: Mutex::new(Vec::new()),
            wake: Condvar::new(),
            closed: AtomicBool::new(false),
            done: Mutex::new(Vec::new()),
            viewer: Mutex::new([0.0; 3]),
            busy: Mutex::new(HashSet::new()),
            loader,
            env,
        });
        for k in 0..WORKERS {
            let s = shared.clone();
            let _ = std::thread::Builder::new().name(format!("quadplanet-city-{k}")).spawn(move || worker(s));
        }
        Self {
            planet,
            radius: config.radius.unwrap_or(3000.0).clamp(200.0, 20_000.0),
            max_altitude: config.max_altitude.unwrap_or(8000.0),
            shared,
            live: HashMap::new(),
            wanted: HashSet::new(),
            failed: HashSet::new(),
            last_errors: Vec::new(),
        }
    }

    pub fn env(&self) -> &CityEnv { &self.shared.env }

    /// Tiles within `radius` of `viewer` (planet-relative), when low enough for a city.
    fn wanted_tiles(&self, viewer_rel: V3, radius: f64) -> HashSet<TileId> {
        let env = &self.shared.env;
        let mut out = HashSet::new();
        if length(viewer_rel) - env.radius > self.max_altitude { return out; }
        let d = normalize(viewer_rel);
        let (lat, lon) = dir_to_lat_lon(d);
        if lat.abs() > 84.0 { return out; }
        let here = osm::tile_of(lat, lon, CITY_ZOOM);
        let n = 1i64 << CITY_ZOOM;
        let tile_m = 2.0 * std::f64::consts::PI * env.radius * lat.to_radians().cos() / n as f64;
        let k = (radius / tile_m.max(1.0)).ceil() as i64 + 1;
        let half_diag = tile_m * std::f64::consts::FRAC_1_SQRT_2;
        for dy in -k..=k {
            let y = here.y as i64 + dy;
            if y < 0 || y >= n { continue; }
            for dx in -k..=k {
                let x = (here.x as i64 + dx).rem_euclid(n);
                let id = TileId { z: CITY_ZOOM, x: x as u32, y: y as u32 };
                let ang = dot(tile_center_dir(id), d).clamp(-1.0, 1.0).acos();
                if ang * env.radius - half_diag <= radius { out.insert(id); }
            }
        }
        out
    }

    /// Streams tiles around `viewer` (world). Created tiles come back for the caller to turn into
    /// engine meshes; destroyed ones for it to remove.
    pub fn update(&mut self, viewer: V3) -> CityUpdate {
        let env = &self.shared.env;
        let rel = sub(viewer, env.center);
        *self.shared.viewer.lock().unwrap() = rel;
        let wanted = self.wanted_tiles(rel, self.radius);
        // Keep what is drawn a little past the radius, so walking along the edge doesn't churn.
        let keep = self.wanted_tiles(rel, self.radius * 1.3);
        let mut out = CityUpdate { created: Vec::new(), destroyed: Vec::new() };
        let gone: Vec<TileId> = self.live.keys().filter(|id| !keep.contains(id)).copied().collect();
        for id in gone { if let Some(t) = self.live.remove(&id) { out.destroyed.push(t); } }
        // Collect finished tiles before queueing, and read `busy` under the same `done` lock a
        // worker holds while it reports a tile and leaves `busy` (see `finish`): every tile is then
        // seen finished, busy or neither, never neither while it is done - which built (and
        // handed out) some tiles twice.
        let mut finished: HashSet<TileId> = HashSet::new();
        let (results, busy) = {
            let mut done = self.shared.done.lock().unwrap();
            (std::mem::take(&mut *done), self.shared.busy.lock().unwrap().clone())
        };
        for r in results {
            match r {
                Ok(t) if keep.contains(&t.id) && !self.live.contains_key(&t.id) && finished.insert(t.id) => out.created.push((t.id, t)),
                Ok(_) => {}
                Err((id, e)) => {
                    self.failed.insert(id);
                    self.last_errors.push(format!("tile {}/{}/{}: {e}", id.z, id.x, id.y));
                    if self.last_errors.len() > 8 { self.last_errors.remove(0); }
                }
            }
        }
        {
            let mut q = self.shared.queue.lock().unwrap();
            q.retain(|j| keep.contains(&j.id));
            let queued: HashSet<TileId> = q.iter().map(|j| j.id).collect();
            for id in &wanted {
                if self.live.contains_key(id) || finished.contains(id) || queued.contains(id) || busy.contains(id) || self.failed.contains(id) { continue; }
                q.push(Job { id: *id, data: None, not_before: Instant::now(), attempts: 0 });
            }
        }
        self.shared.wake.notify_all();
        self.wanted = wanted;
        out
    }

    pub fn stats(&self) -> CityStats {
        let pending = self.shared.queue.lock().unwrap().len() + self.shared.busy.lock().unwrap().len();
        let mut s = CityStats { enabled: true, live: self.live.len(), wanted: self.wanted.len(), pending, failed: self.failed.len(), ..Default::default() };
        for t in self.live.values() {
            s.buildings += t.placements.len();
            s.houses += t.placements.iter().filter(|p| p.kind == "house").count();
            s.roads += t.roads;
            s.triangles += t.triangles;
        }
        s
    }

    /// True while anything wanted is still loading or building.
    pub fn busy(&self) -> bool {
        self.wanted.iter().any(|id| !self.live.contains_key(id) && !self.failed.contains(id))
    }

    /// Placements within `radius` of `point` (world), nearest first, at most `limit`.
    pub fn near(&self, point: V3, radius: f64, kind: Option<&str>, limit: usize) -> Vec<(f64, &Placement)> {
        let mut out: Vec<(f64, &Placement)> = self.live.values()
            .flat_map(|t| t.placements.iter())
            .filter(|p| kind.map_or(true, |k| p.kind == k))
            .map(|p| (distance(p.anchor, point), p))
            .filter(|(d, _)| *d <= radius)
            .collect();
        out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then_with(|| a.1.key.cmp(&b.1.key)));
        out.truncate(limit);
        out
    }

    /// Forget tiles that failed so they are tried again.
    pub fn retry_failed(&mut self) { self.failed.clear(); }
}

/// Reports a tile and takes it off `busy` in one step for `CityLayer::update`, which reads both
/// under the `done` lock.
fn finish(shared: &Shared, id: TileId, result: Result<BuiltTile, (TileId, String)>) {
    let mut done = shared.done.lock().unwrap();
    done.push(result);
    shared.busy.lock().unwrap().remove(&id);
}

fn worker(shared: Arc<Shared>) {
    loop {
        let job = {
            let mut q = shared.queue.lock().unwrap();
            loop {
                if shared.closed.load(Ordering::SeqCst) { return; }
                let now = Instant::now();
                let viewer = normalize(*shared.viewer.lock().unwrap());
                // The nearest ready job.
                let pick = q.iter().enumerate()
                    .filter(|(_, j)| j.not_before <= now)
                    .max_by(|a, b| dot(tile_center_dir(a.1.id), viewer).partial_cmp(&dot(tile_center_dir(b.1.id), viewer)).unwrap())
                    .map(|(i, _)| i);
                if let Some(i) = pick {
                    let j = q.swap_remove(i);
                    shared.busy.lock().unwrap().insert(j.id);
                    break j;
                }
                q = shared.wake.wait_timeout(q, Duration::from_millis(100)).unwrap().0;
            }
        };
        let id = job.id;
        let requeue = |mut j: Job, delay: Duration| {
            j.not_before = Instant::now() + delay;
            shared.queue.lock().unwrap().push(j);
            shared.busy.lock().unwrap().remove(&id);
        };
        let mut job = job;
        if job.data.is_none() {
            match shared.loader.load(id) {
                Ok(bytes) => match osm::parse_tile(id, &bytes, shared.env.radius) {
                    Ok(t) => job.data = Some(t),
                    Err(e) => {
                        finish(&shared, id, Err((id, format!("unreadable: {e}"))));
                        continue;
                    }
                },
                Err(LoadError::Missing) => job.data = Some(OsmTile::default()),
                Err(LoadError::Transient(e)) => {
                    job.attempts += 1;
                    if job.attempts >= 4 {
                        finish(&shared, id, Err((id, e)));
                    } else {
                        let backoff = Duration::from_millis(500 << job.attempts);
                        requeue(job, backoff);
                    }
                    continue;
                }
            }
        }
        let mut lk = Lookup::new(Access::Gate);
        let built = build_tile(id, job.data.as_ref().unwrap(), &shared.env, &mut lk);
        match built {
            Some(t) => {
                finish(&shared, id, Ok(t));
            }
            // Elevation under it is still downloading: try again shortly.
            None => requeue(job, Duration::from_millis(120)),
        }
    }
}

/// A tile's uniform: model matrix (its frame, relative to the render origin), white tint, and a
/// zero texture origin (the city materials texture from tile-local positions).
pub fn tile_uniform(origin: V3, basis: [V3; 3], render_origin: V3) -> [f32; super::ITEM_FLOATS] {
    let t = sub(origin, render_origin);
    let [e, u, s] = basis;
    [
        e[0] as f32, e[1] as f32, e[2] as f32, 0.0,
        u[0] as f32, u[1] as f32, u[2] as f32, 0.0,
        s[0] as f32, s[1] as f32, s[2] as f32, 0.0,
        t[0] as f32, t[1] as f32, t[2] as f32, 1.0,
        1.0, 1.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 0.0,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::elevation::{Loader, Tile, TILE};
    use super::super::osm::{OsmBuilding, OsmRoad};

    const R: f64 = 6_371_000.0;

    fn flat_env(height: f32) -> CityEnv {
        let loader = Loader::Custom(Arc::new(move |_| Some(Tile { heights: vec![height; TILE * TILE] })));
        CityEnv { center: [0.0; 3], radius: R, has_sea: true, spacing: 0.6, elevation: Arc::new(ElevationSource::new(loader, 13, R, None)), rule: HouseRule::default() }
    }

    /// A rectangle `w` x `d` meters (w along east before rotating by `deg`) centred `at` meters
    /// east/north of the tile frame's origin, as lat/lon.
    fn footprint(id: TileId, at: P2, w: f64, d: f64, deg: f64) -> Vec<[f64; 2]> {
        let (origin, [east, _, south]) = tile_frame(id, R);
        let north = scale(south, -1.0);
        let (s, c) = deg.to_radians().sin_cos();
        [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)].iter().map(|(x, y)| {
            let (px, py) = (x * w / 2.0, y * d / 2.0);
            let (rx, ry) = (px * c - py * s + at[0], px * s + py * c + at[1]);
            let (la, lo) = dir_to_lat_lon(normalize(add(origin, add(scale(east, rx), scale(north, ry)))));
            [la, lo]
        }).collect()
    }

    fn line(id: TileId, a: P2, b: P2) -> Vec<[f64; 2]> {
        let (origin, [east, _, south]) = tile_frame(id, R);
        let north = scale(south, -1.0);
        [a, b].iter().map(|p| { let (la, lo) = dir_to_lat_lon(normalize(add(origin, add(scale(east, p[0]), scale(north, p[1]))))); [la, lo] }).collect()
    }

    fn building(ring: Vec<[f64; 2]>, height: f64) -> OsmBuilding {
        OsmBuilding { ring, area: 0.0, height, min_height: 0.0, colour: None }
    }

    #[test]
    fn fits_rotated_rectangles() {
        let (s, c) = 30f64.to_radians().sin_cos();
        let pts: Vec<P2> = [(-6.0, -4.0), (6.0, -4.0), (6.0, 4.0), (-6.0, 4.0), (0.0, 4.0)].iter().map(|(x, y)| [x * c - y * s + 10.0, x * s + y * c - 5.0]).collect();
        let r = min_area_rect(&pts).unwrap();
        let (a, b) = (r.half_u.max(r.half_v), r.half_u.min(r.half_v));
        assert!((a - 6.0).abs() < 1e-9 && (b - 4.0).abs() < 1e-9, "{r:?}");
        assert!((r.center[0] - 10.0).abs() < 1e-9 && (r.center[1] + 5.0).abs() < 1e-9);
    }

    #[test]
    fn houses_face_the_street_and_sit_on_the_ground() {
        let id = osm::tile_of(46.02, 7.75, CITY_ZOOM);
        let env = flat_env(1600.0);
        let data = OsmTile {
            buildings: vec![
                // 12 x 9 m, long side along east; the street runs east-west 20 m to its south.
                building(footprint(id, [0.0, 0.0], 12.0, 9.0, 0.0), 7.0),
                // An office block: too big for a house.
                building(footprint(id, [200.0, 0.0], 40.0, 25.0, 15.0), 30.0),
                // A shed: too small.
                building(footprint(id, [0.0, 100.0], 4.0, 3.0, 0.0), 3.0),
            ],
            roads: vec![OsmRoad { points: line(id, [-100.0, -20.0], [100.0, -20.0]), class: RoadClass::Minor, bridge: false }],
        };
        let mut lk = Lookup::new(Access::Block);
        let t = build_tile(id, &data, &env, &mut lk).expect("built");
        assert_eq!(t.placements.len(), 3);
        let house = &t.placements[0];
        assert_eq!(house.kind, "house");
        assert!((house.width - 12.0).abs() < 0.05 && (house.depth - 9.0).abs() < 0.05, "{} x {}", house.width, house.depth);
        // Front toward the street (south); seen from the street, the house's +X runs east.
        let (_, [east, up, south]) = tile_frame(id, R);
        assert!(dot(house.forward, south) > 0.99, "faces south");
        assert!(dot(house.right, east) > 0.99);
        assert!(dot(house.up, up) > 0.9999);
        assert!((house.ground_min - 1600.0).abs() < 1e-6 && (house.ground_max - 1600.0).abs() < 1e-6);
        assert!((length(house.anchor) - (R + 1600.0)).abs() < 1e-3);
        assert_eq!(t.placements[1].kind, "box");
        assert_eq!(t.placements[2].kind, "box");
        // Deterministic: the same data makes the same keys.
        let again = build_tile(id, &data, &env, &mut Lookup::new(Access::Block)).unwrap();
        assert_eq!(again.placements.iter().map(|p| &p.key).collect::<Vec<_>>(), t.placements.iter().map(|p| &p.key).collect::<Vec<_>>());
        // 3 boxes of 5 faces, and a road.
        assert_eq!(t.roads, 1);
        assert!(t.indices.len() / 3 >= 30 + 2);
        assert_eq!(t.vertices.len() % 12, 0);
        // Every triangle faces the way its vertex normal says (the engine culls back faces):
        // roofs and roads up, walls out.
        let p = |i: u32| { let v = &t.vertices[i as usize * 12..]; ([v[0] as f64, v[1] as f64, v[2] as f64], [v[3] as f64, v[4] as f64, v[5] as f64]) };
        for tri in t.indices.chunks_exact(3) {
            let ((a, n), (b, _), (c, _)) = (p(tri[0]), p(tri[1]), p(tri[2]));
            let face = cross(sub(b, a), sub(c, a));
            assert!(dot(face, n) > 0.0, "a triangle faces away from its normal");
        }
    }

    #[test]
    fn box_vertices_encode_their_anchor() {
        let id = osm::tile_of(40.0, -74.0, CITY_ZOOM);
        let env = flat_env(12.0);
        let data = OsmTile { buildings: vec![building(footprint(id, [300.0, -150.0], 10.0, 8.0, 20.0), 6.0)], roads: vec![] };
        let t = build_tile(id, &data, &env, &mut Lookup::new(Access::Block)).unwrap();
        let p = &t.placements[0];
        let [e, u, s] = t.basis;
        let rel = sub(p.anchor, t.origin);
        let anchor_l = [dot(rel, e), dot(rel, u), dot(rel, s)];
        for v in t.vertices.chunks_exact(12) {
            assert_eq!(v[6].floor(), MATERIAL_BUILDING_BOX);
            assert_eq!(v[7].floor(), 1.0, "a house: replaceable");
            let dx = (v[6] - MATERIAL_BUILDING_BOX - 0.5) as f64 * 4000.0;
            let dz = (v[7] - 1.0 - 0.5) as f64 * 4000.0;
            let c = [v[0] as f64 - dx, v[1] as f64 - v[11] as f64, v[2] as f64 - dz];
            for k in 0..3 { assert!((c[k] - anchor_l[k]).abs() < 0.01, "{c:?} vs {anchor_l:?}"); }
        }
    }

    #[test]
    fn waits_for_elevation_in_flight() {
        let id = osm::tile_of(46.02, 7.75, CITY_ZOOM);
        let slow = Loader::Custom(Arc::new(|_| { std::thread::sleep(Duration::from_millis(50)); Some(Tile { heights: vec![5.0; TILE * TILE] }) }));
        let env = CityEnv { center: [0.0; 3], radius: R, has_sea: true, spacing: 0.6, elevation: Arc::new(ElevationSource::new(slow, 13, R, None)), rule: HouseRule::default() };
        let data = OsmTile { buildings: vec![building(footprint(id, [0.0, 0.0], 10.0, 8.0, 0.0), 6.0)], roads: vec![] };
        let mut lk = Lookup::new(Access::Gate);
        assert!(build_tile(id, &data, &env, &mut lk).is_none() && lk.missing);
        assert!(env.elevation.wait_idle(Duration::from_secs(5)));
        assert!(build_tile(id, &data, &env, &mut Lookup::new(Access::Gate)).is_some());
    }

    #[test]
    fn streams_tiles_around_the_viewer_and_answers_queries() {
        let id = osm::tile_of(46.02, 7.75, CITY_ZOOM);
        let center = osm::tile_point_to_lat_lon(id, 1, 0.5, 0.5);
        let ring = footprint(id, [0.0, 0.0], 11.0, 9.0, 0.0);
        let loader = OsmLoader::Custom(Box::new(move |t| {
            if t != id { return Some(Vec::new()); }
            // A real-looking tile: one house at the tile center.
            let to_tile = |ll: &[f64; 2]| {
                let n = (1u64 << 14) as f64;
                let la = ll[0].to_radians();
                let x = ((ll[1] + 180.0) / 360.0 * n - id.x as f64) * 4096.0;
                let y = ((1.0 - (la.tan() + 1.0 / la.cos()).ln() / std::f64::consts::PI) / 2.0 * n - id.y as f64) * 4096.0;
                [x.round() as i32, y.round() as i32]
            };
            let mut r: Vec<[i32; 2]> = ring.iter().map(to_tile).collect();
            if super::super::mvt::ring_area2(&r) < 0.0 { r.reverse(); }
            Some(super::super::mvt::tests::encode_layer("building", &[(3, vec![("render_height", super::super::mvt::Value::Int(7))], vec![r])]))
        }));
        let env = flat_env(100.0);
        let config = CityConfig { enabled: true, tile_url: None, radius: Some(1500.0), max_altitude: None, house: None };
        let mut city = CityLayer::with_loader(3, &config, env, loader);
        let viewer = scale(lat_lon_to_dir(center[0], center[1]), R + 102.0);
        let start = Instant::now();
        let mut created = 0;
        loop {
            let u = city.update(viewer);
            for (tid, t) in u.created {
                created += 1;
                city.live.insert(tid, LiveTile { mesh_id: String::new(), buffer_id: String::new(), origin: t.origin, basis: t.basis, triangles: t.indices.len() / 3, roads: t.roads, placements: t.placements });
            }
            if !city.busy() { break; }
            assert!(start.elapsed() < Duration::from_secs(20), "stuck: {:?}", city.stats());
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(created >= 4, "the tile and its neighbours within 1.5 km");
        let near = city.near(viewer, 200.0, Some("house"), 10);
        assert_eq!(near.len(), 1);
        assert!(near[0].0 < 5.0);
        assert_eq!(city.stats().houses, 1);
        // Far above: nothing wanted, everything goes.
        let u = city.update(scale(viewer, 1.01));
        assert_eq!(u.destroyed.len(), created);
    }
}

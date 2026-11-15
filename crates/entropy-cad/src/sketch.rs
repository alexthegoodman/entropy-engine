//! A sketch: points on a plane and the curves drawn between them. Curves share points by id, which
//! is how the kernel knows two of them meet; from that it finds the closed loops, nests them into
//! regions with holes, and hands those to the features that sweep them into bodies.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::math::{closest_on_segment, point_in_polygon, polygon_area, polygon_centroid, v2, v3, V2, V3};
use crate::nurbs::{NurbsCurve, Tolerance};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Sketch {
    pub points: Vec<Point>,
    pub entities: Vec<Entity>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point { pub id: String, pub x: f64, pub y: f64 }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entity {
    pub id: String,
    #[serde(flatten)]
    pub shape: Shape,
    /// Construction geometry guides drawing (an axis, a centerline) and never becomes a profile.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub construction: bool,
    /// Gives an open curve a body: a closed outline around it, as wide as you like on each side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<Stroke>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Shape {
    Line { a: String, b: String },
    /// The circular arc from `a` to `b` through `via`.
    Arc { a: String, b: String, via: String },
    Circle { center: String, radius: f64 },
    /// `rotation` in degrees, counter-clockwise from the sketch's x axis.
    Ellipse { center: String, rx: f64, ry: f64, #[serde(default)] rotation: f64 },
    Spline {
        points: Vec<String>,
        #[serde(default)]
        closed: bool,
        #[serde(default)]
        mode: SplineMode,
        /// Per point: tension in `through` mode, pull in `control` mode. Missing entries are 1.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        weights: Vec<f64>,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SplineMode {
    /// The curve passes through every point.
    #[default]
    Through,
    /// The points are a control polygon the curve is pulled toward.
    Control,
}

/// An outline around an open curve. `left` and `right` are the half widths either side of the
/// direction of travel, so a stroke need not be centered; `start`, `middle` and `end` scale the
/// width along the curve (a blade: 0, 1, 0).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Stroke {
    pub left: f64,
    pub right: f64,
    pub start: f64,
    pub middle: f64,
    pub end: f64,
    pub round: bool,
}

impl Default for Stroke { fn default() -> Self { Stroke { left: 1.0, right: 1.0, start: 1.0, middle: 1.0, end: 1.0, round: true } } }

/// A polyline on the sketch plane. Segment `i` runs from `pts[i]` to `pts[i + 1]` (wrapping when
/// closed) and came from entity `source[i]`; `corner[i]` marks a sharp vertex.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Path2 {
    pub pts: Vec<V2>,
    pub corner: Vec<bool>,
    pub source: Vec<u32>,
    pub closed: bool,
}

impl Path2 {
    /// A path with corners wherever it turns more than `sharp` radians.
    pub fn from_points(pts: Vec<V2>, closed: bool, source: u32, sharp: f64) -> Path2 {
        let mut pts = dedupe(pts, closed);
        if closed && pts.len() < 3 { pts.clear(); }
        let n = pts.len();
        let corner = (0..n).map(|i| {
            if !closed && (i == 0 || i == n - 1) { return true; }
            let (a, b, c) = (pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]);
            turn(b - a, c - b) > sharp
        }).collect();
        Path2 { source: vec![source; n], corner, pts, closed }
    }

    pub fn area(&self) -> f64 { polygon_area(&self.pts) }

    pub fn length(&self) -> f64 {
        let n = self.pts.len();
        let segs = if self.closed { n } else { n.saturating_sub(1) };
        (0..segs).map(|i| self.pts[i].dist(self.pts[(i + 1) % n])).sum()
    }

    /// The same path with no segment longer than `max_len`: surfaces that twist need the points.
    pub fn densified(&self, max_len: f64) -> Path2 {
        let n = self.pts.len();
        let mut out = Path2 { closed: self.closed, ..Path2::default() };
        for i in 0..n {
            out.pts.push(self.pts[i]);
            out.corner.push(self.corner[i]);
            out.source.push(self.source[i]);
            if !self.closed && i + 1 == n { break; }
            let (a, b) = (self.pts[i], self.pts[(i + 1) % n]);
            let k = (a.dist(b) / max_len.max(1e-9)).ceil().clamp(1.0, 4096.0) as usize;
            for j in 1..k {
                out.pts.push(a.lerp(b, j as f64 / k as f64));
                out.corner.push(false);
                out.source.push(self.source[i]);
            }
        }
        out
    }

    pub fn reversed(&self) -> Path2 {
        let n = self.pts.len();
        let pts: Vec<V2> = self.pts.iter().rev().copied().collect();
        let corner: Vec<bool> = self.corner.iter().rev().copied().collect();
        let source = (0..n).map(|i| {
            if self.closed { self.source[(2 * n - 2 - i) % n] } else { self.source[n.saturating_sub(2).saturating_sub(i).min(n - 1)] }
        }).collect();
        Path2 { pts, corner, source, closed: self.closed }
    }
}

fn dedupe(pts: Vec<V2>, closed: bool) -> Vec<V2> {
    let mut out: Vec<V2> = Vec::with_capacity(pts.len());
    for p in pts { if out.last().map_or(true, |q| q.dist(p) > 1e-9) { out.push(p); } }
    while closed && out.len() > 1 && out[0].dist(*out.last().unwrap()) <= 1e-9 { out.pop(); }
    out
}

fn turn(a: V2, b: V2) -> f64 {
    let (la, lb) = (a.len(), b.len());
    if la < 1e-12 || lb < 1e-12 { return 0.0; }
    (a.dot(b) / (la * lb)).clamp(-1.0, 1.0).acos()
}

/// One entity, evaluated.
#[derive(Clone, Debug)]
pub struct EntityGeom {
    pub id: String,
    pub curve: NurbsCurve,
    /// The curve flattened: (parameter, point).
    pub poly: Vec<(f64, V2)>,
    pub closed: bool,
    pub construction: bool,
}

/// A closed boundary. `key` names it across edits: the smallest id among the entities that form it.
#[derive(Clone, Debug)]
pub struct Loop { pub key: String, pub entities: Vec<String>, pub path: Path2 }

/// An area to sweep: an outer boundary (counter-clockwise) and the holes in it (clockwise).
#[derive(Clone, Debug)]
pub struct Region { pub key: String, pub outer: Path2, pub holes: Vec<Path2>, pub area: f64, pub centroid: V2 }

/// Curves joined end to end that do not close: a path to sweep along.
#[derive(Clone, Debug)]
pub struct Chain { pub entities: Vec<String>, pub path: Path2 }

#[derive(Clone, Debug, Default)]
pub struct SketchGeom {
    pub entities: Vec<EntityGeom>,
    pub loops: Vec<Loop>,
    pub regions: Vec<Region>,
    pub chains: Vec<Chain>,
    pub issues: Vec<String>,
}

const CORNER: f64 = 0.035; // 2 degrees: tangent-continuous joins (a line into its fillet) stay smooth

impl Sketch {
    pub fn point(&self, id: &str) -> Option<V2> { self.points.iter().find(|p| p.id == id).map(|p| v2(p.x, p.y)) }

    /// The exact curve of an entity, in sketch coordinates (z = 0).
    pub fn curve(&self, e: &Entity) -> Result<NurbsCurve, String> {
        let at = |id: &String| self.point(id).map(|p| v3(p.x, p.y, 0.0)).ok_or_else(|| format!("{} refers to a missing point {id}", e.id));
        Ok(match &e.shape {
            Shape::Line { a, b } => NurbsCurve::line(at(a)?, at(b)?),
            Shape::Arc { a, b, via } => NurbsCurve::arc_through(at(a)?, at(via)?, at(b)?),
            Shape::Circle { center, radius } => {
                if !(*radius > 1e-9) { return Err(format!("{} has no radius", e.id)); }
                NurbsCurve::circle(at(center)?, v3(*radius, 0.0, 0.0), v3(0.0, *radius, 0.0))
            }
            Shape::Ellipse { center, rx, ry, rotation } => {
                if !(*rx > 1e-9 && *ry > 1e-9) { return Err(format!("{} has no size", e.id)); }
                let (s, c) = rotation.to_radians().sin_cos();
                NurbsCurve::circle(at(center)?, v3(c * rx, s * rx, 0.0), v3(-s * ry, c * ry, 0.0))
            }
            Shape::Spline { points, closed, mode, weights } => {
                let pts = points.iter().map(at).collect::<Result<Vec<V3>, String>>()?;
                if pts.len() < 2 { return Err(format!("{} needs at least two points", e.id)); }
                match mode {
                    SplineMode::Through => NurbsCurve::through(&pts, *closed, weights),
                    SplineMode::Control => NurbsCurve::control(&pts, weights, *closed),
                }
            }
        })
    }

    /// Evaluates the sketch: curves, loops, regions and open chains.
    pub fn evaluate(&self, tol: Tolerance) -> SketchGeom {
        let mut g = SketchGeom::default();
        let mut seen = HashSet::new();
        for e in &self.entities {
            if !seen.insert(e.id.as_str()) { g.issues.push(format!("two entities are called {}", e.id)); continue; }
            match self.curve(e) {
                Err(msg) => g.issues.push(msg),
                Ok(curve) => {
                    let poly: Vec<(f64, V2)> = curve.tessellate(tol).into_iter().map(|(u, p)| (u, v2(p.x, p.y))).collect();
                    let closed = match &e.shape {
                        Shape::Circle { .. } | Shape::Ellipse { .. } => true,
                        Shape::Spline { closed, points, .. } => *closed && points.len() >= 3,
                        _ => false,
                    };
                    g.entities.push(EntityGeom { id: e.id.clone(), curve, poly, closed, construction: e.construction });
                }
            }
        }
        self.find_loops(&mut g);
        nest(&mut g);
        g
    }

    fn find_loops(&self, g: &mut SketchGeom) {
        let by_id: HashMap<&str, &Entity> = self.entities.iter().map(|e| (e.id.as_str(), e)).collect();
        // Entities that join others end to end: (index into g.entities, start point id, end point id).
        let mut open: Vec<(usize, &str, &str)> = Vec::new();
        for (i, eg) in g.entities.iter().enumerate() {
            if eg.construction { continue; }
            let e = by_id[eg.id.as_str()];
            let pts: Vec<V2> = eg.poly.iter().map(|p| p.1).collect();
            if let Some(s) = e.stroke {
                for (k, path) in stroke_outline(&pts, eg.closed, s, i as u32).into_iter().enumerate() {
                    if path.pts.len() >= 3 { g.loops.push(Loop { key: if k == 0 { eg.id.clone() } else { format!("{}#inner", eg.id) }, entities: vec![eg.id.clone()], path }); }
                }
            } else if eg.closed {
                // A closed curve is smooth all the way round: its flattening has no real corners.
                let path = Path2::from_points(pts, true, i as u32, f64::INFINITY);
                if path.pts.len() >= 3 { g.loops.push(Loop { key: eg.id.clone(), entities: vec![eg.id.clone()], path }); }
            } else {
                let ends = match &e.shape {
                    Shape::Line { a, b } | Shape::Arc { a, b, .. } => Some((a.as_str(), b.as_str())),
                    Shape::Spline { points, .. } => Some((points[0].as_str(), points[points.len() - 1].as_str())),
                    _ => None,
                };
                if let Some((a, b)) = ends { if a != b { open.push((i, a, b)); } }
            }
        }
        // Which entity ends meet at each point.
        let mut at: HashMap<&str, Vec<(usize, bool)>> = HashMap::new();
        for (k, (_, a, b)) in open.iter().enumerate() {
            at.entry(a).or_default().push((k, false));
            at.entry(b).or_default().push((k, true));
        }
        // Leaving entity `k` through its end (`fwd`) or start: the next entity and its direction,
        // if exactly one other curve continues from that point.
        let next = |k: usize, fwd: bool| -> Option<(usize, bool)> {
            let p = if fwd { open[k].2 } else { open[k].1 };
            let here = &at[p];
            if here.len() != 2 { return None; }
            let other = if here[0] == (k, fwd) { here[1] } else { here[0] };
            // Arriving at the other's start means travelling it forward.
            Some((other.0, !other.1))
        };
        let mut used = vec![false; open.len()];
        for start in 0..open.len() {
            if used[start] { continue; }
            let mut walk = vec![(start, true)];
            used[start] = true;
            let mut closed = false;
            let mut cur = (start, true);
            while let Some(n) = next(cur.0, cur.1) {
                if n.0 == start { closed = n.1; break; }
                if used[n.0] { break; }
                used[n.0] = true;
                walk.push(n);
                cur = n;
            }
            if !closed {
                // Grow backwards from the first entity's start too.
                let mut cur = (start, false);
                while let Some(n) = next(cur.0, cur.1) {
                    if used[n.0] { break; }
                    used[n.0] = true;
                    // Walking away from the start: the chain travels this one the other way.
                    walk.insert(0, (n.0, !n.1));
                    cur = (n.0, n.1);
                }
            }
            let path = join(g, &open, &walk, closed);
            let entities: Vec<String> = walk.iter().map(|w| g.entities[open[w.0].0].id.clone()).collect();
            if closed {
                if path.pts.len() >= 3 {
                    let key = entities.iter().min().unwrap().clone();
                    g.loops.push(Loop { key, entities, path });
                }
            } else if path.pts.len() >= 2 {
                g.chains.push(Chain { entities, path });
            }
        }
        // Closed curves are paths too (a ring to sweep around).
        for l in &mut g.loops {
            if l.path.area() < 0.0 { l.path = l.path.reversed(); }
        }
    }
}

/// Concatenates the walked entities' polylines, marking joins that are not tangent as corners.
fn join(g: &SketchGeom, open: &[(usize, &str, &str)], walk: &[(usize, bool)], closed: bool) -> Path2 {
    let mut path = Path2 { closed, ..Path2::default() };
    let tangents = |w: (usize, bool)| -> (V2, V2) {
        let c = &g.entities[open[w.0].0].curve;
        let (a, b) = (c.tangent(c.domain.0), c.tangent(c.domain.1));
        let (a, b) = (v2(a.x, a.y), v2(b.x, b.y));
        if w.1 { (a, b) } else { (-b, -a) }
    };
    for (k, &w) in walk.iter().enumerate() {
        let eg = &g.entities[open[w.0].0];
        let mut pts: Vec<V2> = eg.poly.iter().map(|p| p.1).collect();
        if !w.1 { pts.reverse(); }
        let last = pts.len() - 1;
        for (i, p) in pts.into_iter().enumerate() {
            // The end of each entity is the start of the next (or of the first, when closed).
            if i == last && (closed || k + 1 < walk.len()) { continue; }
            let corner = if i == 0 {
                if k == 0 && !closed { true } else {
                    let prev = walk[(k + walk.len() - 1) % walk.len()];
                    turn(tangents(prev).1, tangents(w).0) > CORNER
                }
            } else { i == last };
            path.pts.push(p);
            path.corner.push(corner);
            path.source.push(open[w.0].0 as u32);
        }
    }
    path
}

/// The closed outline(s) of a stroked curve: one loop around an open curve, two (outer, inner)
/// around a closed one.
fn stroke_outline(pts: &[V2], closed: bool, s: Stroke, source: u32) -> Vec<Path2> {
    let mut pts = dedupe(pts.to_vec(), closed);
    if pts.len() < 2 { return Vec::new(); }
    if !closed && (s.start != s.middle || s.middle != s.end) {
        // The width changes along the curve: a long straight run needs points to carry it.
        let step = (pts.windows(2).map(|w| w[0].dist(w[1])).sum::<f64>() / 48.0).max(1e-9);
        let mut fine = vec![pts[0]];
        for w in pts.windows(2) {
            let k = (w[0].dist(w[1]) / step).ceil().max(1.0) as usize;
            for i in 1..=k { fine.push(w[0].lerp(w[1], i as f64 / k as f64)); }
        }
        pts = fine;
    }
    let n = pts.len();
    let mut along = vec![0.0; n];
    for i in 1..n { along[i] = along[i - 1] + pts[i].dist(pts[i - 1]); }
    let total = along[n - 1] + if closed { pts[0].dist(pts[n - 1]) } else { 0.0 };
    // Width scale: the parabola through (0, start), (1/2, middle), (1, end).
    let scale = |t: f64| (s.start * (2.0 * t - 1.0) * (t - 1.0) + s.middle * 4.0 * t * (1.0 - t) + s.end * t * (2.0 * t - 1.0)).max(0.0);
    let tangent = |i: usize| -> V2 {
        let (a, b) = if closed { (pts[(i + n - 1) % n], pts[(i + 1) % n]) } else { (pts[i.saturating_sub(1)], pts[(i + 1).min(n - 1)]) };
        (b - a).norm()
    };
    let (mut left, mut right) = (Vec::with_capacity(n), Vec::with_capacity(n));
    for i in 0..n {
        let f = if closed { 1.0 } else { scale(along[i] / total.max(1e-12)) };
        let nrm = tangent(i).perp();
        left.push(pts[i] + nrm * (s.left.max(0.0) * f));
        right.push(pts[i] - nrm * (s.right.max(0.0) * f));
    }
    let sharp = 30f64.to_radians();
    if closed {
        return vec![Path2::from_points(left, true, source, sharp), Path2::from_points(right, true, source, sharp)];
    }
    // Half an ellipse around an end: from `side * from` round through `dir` to `-side * to`.
    let cap = |at: V2, dir: V2, side: V2, from: f64, to: f64, out: &mut Vec<V2>| {
        if !s.round || from + to <= 1e-9 { return; }
        const STEPS: usize = 12;
        for k in 1..STEPS {
            let a = std::f64::consts::PI * k as f64 / STEPS as f64;
            let w = from + (to - from) * k as f64 / STEPS as f64;
            out.push(at + side * (a.cos() * w) + dir * (a.sin() * 0.5 * (from + to)));
        }
    };
    let (wl, wr) = (s.left.max(0.0), s.right.max(0.0));
    let mut ring = left;
    let (t0, t1) = (tangent(0), tangent(n - 1));
    cap(pts[n - 1], t1, t1.perp(), wl * scale(1.0), wr * scale(1.0), &mut ring);
    ring.extend(right.iter().rev());
    cap(pts[0], -t0, -t0.perp(), wr * scale(0.0), wl * scale(0.0), &mut ring);
    vec![Path2::from_points(ring, true, source, sharp)]
}

/// Sorts loops into regions: a loop inside an even number of others is an outer boundary, and the
/// loops directly inside it are its holes.
fn nest(g: &mut SketchGeom) {
    let n = g.loops.len();
    let inside = |i: usize, j: usize| -> bool { i != j && point_in_polygon(g.loops[i].path.pts[0], &g.loops[j].path.pts) };
    let depth: Vec<usize> = (0..n).map(|i| (0..n).filter(|&j| inside(i, j)).count()).collect();
    for i in 0..n {
        if depth[i] % 2 != 0 { continue; }
        let outer = g.loops[i].path.clone();
        let holes: Vec<Path2> = (0..n).filter(|&j| depth[j] == depth[i] + 1 && inside(j, i)).map(|j| g.loops[j].path.reversed()).collect();
        let mut area = outer.area();
        let mut moment = polygon_centroid(&outer.pts) * area;
        for h in &holes {
            let a = h.area(); // negative: holes run clockwise
            area += a;
            moment += polygon_centroid(&h.pts) * a;
        }
        if area <= 1e-12 { continue; }
        g.regions.push(Region { key: g.loops[i].key.clone(), outer, holes, area, centroid: moment / area });
    }
}

/// What the pointer is over, nearest first: an existing point, a midpoint, or somewhere on a curve.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// "point", "midpoint", "center", "curve" or "none".
    pub kind: &'static str,
    pub point: Option<String>,
    pub entity: Option<String>,
    /// Where to snap to.
    pub at: [f64; 2],
    pub distance: f64,
}

impl Sketch {
    /// Hit test and snap in one: the closest thing within `radius` of `q`, points before curves.
    /// `skip` lists point ids to ignore (the ones being dragged).
    pub fn hit(&self, geom: &SketchGeom, q: V2, radius: f64, skip: &[String]) -> Hit {
        let mut best: Option<(f64, &Point)> = None;
        for p in &self.points {
            if skip.contains(&p.id) { continue; }
            let d = q.dist(v2(p.x, p.y));
            if d <= radius && best.map_or(true, |b| d < b.0) { best = Some((d, p)); }
        }
        if let Some((d, p)) = best {
            return Hit { kind: "point", point: Some(p.id.clone()), entity: None, at: [p.x, p.y], distance: d };
        }
        let mut curve: Option<(f64, &EntityGeom, V2)> = None;
        for eg in &geom.entities {
            let involved = self.entities.iter().find(|e| e.id == eg.id).map_or(false, |e| e.shape.points().iter().any(|p| skip.contains(p)));
            if involved { continue; }
            for w in eg.poly.windows(2) {
                let (_, c) = closest_on_segment(q, w[0].1, w[1].1);
                let d = q.dist(c);
                if d <= radius && curve.map_or(true, |b| d < b.0) { curve = Some((d, eg, c)); }
            }
        }
        let Some((_, eg, _)) = curve else { return Hit { kind: "none", point: None, entity: None, at: q.arr(), distance: f64::INFINITY } };
        // A line's midpoint attracts within the same radius.
        if eg.curve.degree == 1 {
            let m = eg.curve.point(0.5 * (eg.curve.domain.0 + eg.curve.domain.1));
            let m = v2(m.x, m.y);
            if q.dist(m) <= radius { return Hit { kind: "midpoint", point: None, entity: Some(eg.id.clone()), at: m.arr(), distance: q.dist(m) }; }
        }
        let (_, p) = eg.curve.closest(v3(q.x, q.y, 0.0));
        let p = v2(p.x, p.y);
        Hit { kind: "curve", point: None, entity: Some(eg.id.clone()), at: p.arr(), distance: q.dist(p) }
    }
}

impl Shape {
    /// Ids of the points this shape is defined by.
    pub fn points(&self) -> Vec<String> {
        match self {
            Shape::Line { a, b } => vec![a.clone(), b.clone()],
            Shape::Arc { a, b, via } => vec![a.clone(), via.clone(), b.clone()],
            Shape::Circle { center, .. } | Shape::Ellipse { center, .. } => vec![center.clone()],
            Shape::Spline { points, .. } => points.clone(),
        }
    }
}

/// A curvature comb: quills standing off the curve, as long as the curve is tightly bent there.
/// A smooth, even comb is a fair curve; a kink or a sudden jump in the comb is a flaw you would see
/// as a highlight breaking on the finished surface. Returns the quills and the line joining their tips.
pub fn curvature_comb(eg: &EntityGeom, scale: f64, quills: usize) -> (Vec<[V2; 2]>, Vec<V2>) {
    let (a, b) = eg.curve.domain;
    let mut lines = Vec::with_capacity(quills + 1);
    let mut tips = Vec::with_capacity(quills + 1);
    for i in 0..=quills {
        let u = a + (b - a) * i as f64 / quills.max(1) as f64;
        let d = eg.curve.derivs(u, 1);
        let t = v2(d[1].x, d[1].y).norm();
        let p = v2(d[0].x, d[0].y);
        // Quills point away from the center of curvature.
        let tip = p - t.perp() * (eg.curve.curvature(u) * scale);
        lines.push([p, tip]);
        tips.push(tip);
    }
    (lines, tips)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sketch(json: &str) -> Sketch { serde_json::from_str(json).unwrap() }

    fn rectangle() -> Sketch {
        sketch(r#"{"points":[{"id":"p1","x":0,"y":0},{"id":"p2","x":40,"y":0},{"id":"p3","x":40,"y":20},{"id":"p4","x":0,"y":20},{"id":"c","x":12,"y":10}],
            "entities":[{"id":"e1","type":"line","a":"p1","b":"p2"},{"id":"e3","type":"line","a":"p4","b":"p3"},{"id":"e2","type":"line","a":"p2","b":"p3"},
                        {"id":"e4","type":"line","a":"p4","b":"p1"},{"id":"hole","type":"circle","center":"c","radius":5}]}"#)
    }

    #[test]
    fn lines_drawn_in_any_order_and_direction_close_into_a_region_with_its_hole() {
        let g = rectangle().evaluate(Tolerance::default());
        assert!(g.issues.is_empty(), "{:?}", g.issues);
        assert_eq!(g.loops.len(), 2);
        assert_eq!(g.regions.len(), 1);
        let r = &g.regions[0];
        assert_eq!(r.key, "e1");
        assert_eq!(r.outer.pts.len(), 4);
        assert!(r.outer.corner.iter().all(|c| *c));
        assert!(r.outer.area() > 0.0 && r.holes[0].area() < 0.0);
        assert!((r.area - (800.0 - std::f64::consts::PI * 25.0)).abs() < 0.2, "{}", r.area);
        // The hole pulls the centroid away from it.
        assert!(r.centroid.x > 20.0 && (r.centroid.y - 10.0).abs() < 1e-6);
        // Each segment remembers the entity it came from.
        let names: HashSet<&str> = r.outer.source.iter().map(|s| g.entities[*s as usize].id.as_str()).collect();
        assert_eq!(names.len(), 4);
    }

    #[test]
    fn a_tangent_join_is_smooth_and_an_open_chain_is_a_path() {
        // A line running into a semicircle that leaves it tangentially, left open.
        let s = sketch(r#"{"points":[{"id":"a","x":0,"y":0},{"id":"b","x":10,"y":0},{"id":"m","x":15,"y":5},{"id":"c","x":10,"y":10}],
            "entities":[{"id":"l","type":"line","a":"a","b":"b"},{"id":"r","type":"arc","a":"b","b":"c","via":"m"}]}"#);
        let g = s.evaluate(Tolerance::default());
        assert!(g.regions.is_empty());
        assert_eq!(g.chains.len(), 1);
        let p = &g.chains[0].path;
        assert_eq!(g.chains[0].entities, ["l", "r"]);
        assert!(p.corner[0] && *p.corner.last().unwrap());
        assert_eq!(p.corner.iter().filter(|c| **c).count(), 2, "the tangent join must not be a corner");
        assert!(p.pts[0].dist(v2(0.0, 0.0)) < 1e-9 && p.pts.last().unwrap().dist(v2(10.0, 10.0)) < 1e-9);
    }

    #[test]
    fn a_chain_found_from_its_middle_still_runs_end_to_end() {
        let s = sketch(r#"{"points":[{"id":"a","x":0,"y":0},{"id":"b","x":10,"y":0},{"id":"c","x":10,"y":10},{"id":"d","x":20,"y":10}],
            "entities":[{"id":"mid","type":"line","a":"c","b":"b"},{"id":"first","type":"line","a":"a","b":"b"},{"id":"last","type":"line","a":"c","b":"d"}]}"#);
        let g = s.evaluate(Tolerance::default());
        assert_eq!(g.chains.len(), 1);
        let p = &g.chains[0].path;
        assert_eq!(p.pts.len(), 4);
        let ends = [p.pts[0], p.pts[3]];
        assert!(ends.contains(&v2(0.0, 0.0)) && ends.contains(&v2(20.0, 10.0)), "{ends:?}");
        assert!((p.length() - 30.0).abs() < 1e-9);
    }

    #[test]
    fn a_stroke_gives_an_open_curve_an_asymmetric_body() {
        let mut s = sketch(r#"{"points":[{"id":"a","x":0,"y":0},{"id":"b","x":100,"y":0}],"entities":[{"id":"spine","type":"line","a":"a","b":"b"}]}"#);
        s.entities[0].stroke = Some(Stroke { left: 6.0, right: 2.0, round: false, ..Stroke::default() });
        let g = s.evaluate(Tolerance::default());
        assert_eq!(g.regions.len(), 1);
        let r = &g.regions[0];
        assert!((r.area - 800.0).abs() < 1e-6, "{}", r.area);
        // Wider to the left of travel: the centroid sits above the spine.
        assert!((r.centroid.y - 2.0).abs() < 1e-6, "{:?}", r.centroid);
        // A blade: full in the middle, nothing at the ends.
        s.entities[0].stroke = Some(Stroke { left: 6.0, right: 6.0, start: 0.0, middle: 1.0, end: 0.0, round: true });
        let blade = s.evaluate(Tolerance::default());
        let b = &blade.regions[0];
        assert!((b.area - 800.0).abs() < 1.0, "{}", b.area); // 2/3 of the 1200 rectangle
        assert!(b.outer.pts.iter().all(|p| p.x > -1e-9 && p.x < 100.0 + 1e-9), "pointed ends have no cap");
    }

    #[test]
    fn construction_curves_never_become_profiles() {
        let mut s = rectangle();
        s.entities[4].construction = true;
        let g = s.evaluate(Tolerance::default());
        assert_eq!(g.regions.len(), 1);
        assert!(g.regions[0].holes.is_empty());
        assert_eq!(g.entities.len(), 5, "still drawn");
    }

    #[test]
    fn problems_are_reported_not_fatal() {
        let s = sketch(r#"{"points":[{"id":"a","x":0,"y":0}],"entities":[{"id":"bad","type":"line","a":"a","b":"gone"},{"id":"ok","type":"circle","center":"a","radius":3}]}"#);
        let g = s.evaluate(Tolerance::default());
        assert_eq!(g.issues.len(), 1);
        assert!(g.issues[0].contains("gone"));
        assert_eq!(g.regions.len(), 1);
    }

    #[test]
    fn hits_prefer_points_then_midpoints_then_curves() {
        let s = rectangle();
        let g = s.evaluate(Tolerance::default());
        let h = s.hit(&g, v2(39.0, 0.6), 2.0, &[]);
        assert_eq!((h.kind, h.point.as_deref()), ("point", Some("p2")));
        assert_eq!(h.at, [40.0, 0.0]);
        let h = s.hit(&g, v2(20.5, 0.4), 2.0, &[]);
        assert_eq!((h.kind, h.entity.as_deref(), h.at), ("midpoint", Some("e1"), [20.0, 0.0]));
        let h = s.hit(&g, v2(12.0, 15.5), 2.0, &[]);
        assert_eq!((h.kind, h.entity.as_deref()), ("curve", Some("hole")));
        assert!((h.at[1] - 15.0).abs() < 1e-9 && (h.distance - 0.5).abs() < 1e-9);
        assert_eq!(s.hit(&g, v2(30.0, 10.0), 2.0, &[]).kind, "none");
        // A dragged point doesn't snap to itself or to the curves hanging off it.
        assert_eq!(s.hit(&g, v2(39.0, 0.6), 2.0, &["p2".to_string()]).kind, "none");
    }

    #[test]
    fn the_comb_of_a_circle_is_even() {
        let s = rectangle();
        let g = s.evaluate(Tolerance::default());
        let (quills, tips) = curvature_comb(&g.entities[4], 50.0, 16);
        assert_eq!((quills.len(), tips.len()), (17, 17));
        for q in &quills { assert!((q[0].dist(q[1]) - 10.0).abs() < 1e-9); }
        for t in &tips { assert!((t.dist(v2(12.0, 10.0)) - 15.0).abs() < 1e-9, "quills point outward"); }
    }

    #[test]
    fn sketches_round_trip_through_json() {
        let mut s = rectangle();
        s.entities[0].stroke = Some(Stroke { left: 3.0, ..Stroke::default() });
        s.entities.push(Entity { id: "sp".into(), shape: Shape::Spline { points: vec!["p1".into(), "p3".into(), "c".into()], closed: true, mode: SplineMode::Control, weights: vec![1.0, 2.0, 1.0] }, construction: true, stroke: None });
        let text = serde_json::to_string(&s).unwrap();
        assert_eq!(serde_json::from_str::<Sketch>(&text).unwrap(), s);
        assert!(text.contains(r#""type":"spline""#) && text.contains(r#""mode":"control""#));
    }
}

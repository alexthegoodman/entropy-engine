//! The evaluated form of a body: triangles with smooth normals, each tagged with the face it
//! belongs to, plus the sharp edges worth drawing. Everything a feature builds goes through
//! `add_grid` (a swept surface) and `add_cap` (a flat end), so tessellation rules live in one place.

use std::collections::HashMap;

use serde::Serialize;

use crate::math::{polygon_area, v2, v3, Aabb, V2, V3};

/// Which feature made a face and which part of it this is ("side:<entity id>", "start", "end").
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FaceTag { pub feature: String, pub part: String }

#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub positions: Vec<V3>,
    pub normals: Vec<V3>,
    pub tris: Vec<[u32; 3]>,
    /// Per triangle: index into `faces`.
    pub face: Vec<u32>,
    pub faces: Vec<FaceTag>,
    /// Sharp edges and seams, as separate segments.
    pub edges: Vec<[V3; 2]>,
}

/// A surface swept through `rings`: ring `i`, column `j` is one point, and neighbouring rings and
/// columns are joined by quads. With counter-clockwise rings stacked along their normal the
/// surface faces outward.
pub struct Grid<'a> {
    pub rings: &'a [Vec<V3>],
    /// The columns wrap (a closed profile).
    pub closed_u: bool,
    /// The rings wrap (a full revolve, a closed sweep).
    pub closed_v: bool,
    /// Columns / rings where the surface has a sharp edge.
    pub col_crease: &'a [bool],
    pub row_crease: &'a [bool],
    /// Face index for the span starting at each column.
    pub col_face: &'a [u32],
}

impl Mesh {
    pub fn face_id(&mut self, feature: &str, part: impl Into<String>) -> u32 {
        let tag = FaceTag { feature: feature.to_string(), part: part.into() };
        if let Some(i) = self.faces.iter().position(|f| *f == tag) { return i as u32; }
        self.faces.push(tag);
        (self.faces.len() - 1) as u32
    }

    fn push_vertex(&mut self, p: V3, n: V3) -> u32 {
        self.positions.push(p);
        self.normals.push(n);
        (self.positions.len() - 1) as u32
    }

    fn push_tri(&mut self, a: u32, b: u32, c: u32, face: u32) {
        let (pa, pb, pc) = (self.positions[a as usize], self.positions[b as usize], self.positions[c as usize]);
        // Slivers with no area (a revolve touching its axis) carry no surface.
        let scale = pa.dist(pb).max(pb.dist(pc)).max(pc.dist(pa));
        if (pb - pa).cross(pc - pa).len() <= 1e-12 * scale * scale { return; }
        self.tris.push([a, b, c]);
        self.face.push(face);
    }

    pub fn add_grid(&mut self, g: &Grid) {
        let rows = g.rings.len();
        if rows < 2 { return; }
        let cols = g.rings[0].len();
        if cols < 2 || g.rings.iter().any(|r| r.len() != cols) { return; }
        let p = |i: usize, j: usize| g.rings[i][j];
        let ccrease = |j: usize| g.col_crease.get(j).copied().unwrap_or(false);
        let rcrease = |i: usize| g.row_crease.get(i).copied().unwrap_or(false);
        // Difference along one direction at index `k` of `n`: one-sided at creases and open ends.
        // `side` picks which neighbour a crease vertex belongs to (0 the span before, 1 the span after).
        let diff = |k: usize, n: usize, closed: bool, crease: bool, side: u8, at: &dyn Fn(usize) -> V3| -> V3 {
            let prev = if k > 0 { Some(k - 1) } else if closed { Some(n - 1) } else { None };
            let next = if k + 1 < n { Some(k + 1) } else if closed { Some(0) } else { None };
            match (prev, next) {
                (Some(a), Some(b)) if !crease => at(b) - at(a),
                (Some(a), Some(_)) if side == 0 => at(k) - at(a),
                (_, Some(b)) => at(b) - at(k),
                (Some(a), None) => at(k) - at(a),
                (None, None) => V3::default(),
            }
        };
        let mut index = vec![u32::MAX; rows * cols * 4];
        let mut vertex = |mesh: &mut Mesh, i: usize, j: usize, su: u8, sv: u8| -> u32 {
            let (su, sv) = (if ccrease(j) { su } else { 0 }, if rcrease(i) { sv } else { 0 });
            let slot = ((i * cols + j) * 2 + su as usize) * 2 + sv as usize;
            if index[slot] == u32::MAX {
                let du = diff(j, cols, g.closed_u, ccrease(j), su, &|k| p(i, k));
                let dv = diff(i, rows, g.closed_v, rcrease(i), sv, &|k| p(k, j));
                index[slot] = mesh.push_vertex(p(i, j), du.cross(dv).norm());
            }
            index[slot]
        };
        let first = self.tris.len();
        let (uspans, vspans) = (if g.closed_u { cols } else { cols - 1 }, if g.closed_v { rows } else { rows - 1 });
        for i in 0..vspans {
            let i1 = (i + 1) % rows;
            for j in 0..uspans {
                let j1 = (j + 1) % cols;
                let face = g.col_face.get(j).copied().unwrap_or(0);
                let (a, b) = (vertex(self, i, j, 1, 1), vertex(self, i, j1, 0, 1));
                let (c, d) = (vertex(self, i1, j1, 0, 0), vertex(self, i1, j, 1, 0));
                // Split along the shorter diagonal: twisted quads fold less.
                if self.positions[a as usize].dist(self.positions[c as usize]) <= self.positions[b as usize].dist(self.positions[d as usize]) {
                    self.push_tri(a, b, c, face);
                    self.push_tri(a, c, d, face);
                } else {
                    self.push_tri(a, b, d, face);
                    self.push_tri(b, c, d, face);
                }
            }
        }
        self.heal_normals(first);
        // Edges: creased columns run across the rings, creased and end rings run around.
        for j in 0..cols {
            if !ccrease(j) && (g.closed_u || (j != 0 && j != cols - 1)) { continue; }
            for i in 0..vspans { self.push_edge(p(i, j), p((i + 1) % rows, j)); }
        }
        for i in 0..rows {
            if !rcrease(i) && (g.closed_v || (i != 0 && i != rows - 1)) { continue; }
            for j in 0..uspans { self.push_edge(p(i, j), p(i, (j + 1) % cols)); }
        }
    }

    fn push_edge(&mut self, a: V3, b: V3) { if a.dist(b) > 1e-12 { self.edges.push([a, b]); } }

    /// Vertices whose grid normal collapsed (a pole) take the average of their triangles' normals.
    fn heal_normals(&mut self, first_tri: usize) {
        let mut fix: HashMap<u32, V3> = HashMap::new();
        for t in &self.tris[first_tri..] {
            if t.iter().all(|v| self.normals[*v as usize].len() > 0.5) { continue; }
            let n = (self.positions[t[1] as usize] - self.positions[t[0] as usize]).cross(self.positions[t[2] as usize] - self.positions[t[0] as usize]);
            for v in t { if self.normals[*v as usize].len() <= 0.5 { *fix.entry(*v).or_default() += n; } }
        }
        for (v, n) in fix { self.normals[v as usize] = n.norm(); }
    }

    /// A flat end: `outer` (counter-clockwise in `outer2`) and `holes` (clockwise) triangulated in
    /// the plane, placed at the given 3D points, all facing `normal`. `flip` reverses the winding
    /// for an end seen from behind.
    pub fn add_cap(&mut self, loops3: &[&[V3]], loops2: &[&[V2]], normal: V3, face: u32, flip: bool) {
        if loops3.is_empty() || loops3.len() != loops2.len() { return; }
        let holes: Vec<Vec<V2>> = loops2[1..].iter().map(|h| h.to_vec()).collect();
        let tris = triangulate(loops2[0], &holes);
        let base = self.positions.len() as u32;
        for l in loops3 { for p in l.iter() { self.push_vertex(*p, normal); } }
        for t in tris {
            let (a, b, c) = (base + t[0] as u32, base + t[1] as u32, base + t[2] as u32);
            if flip { self.push_tri(a, c, b, face); } else { self.push_tri(a, b, c, face); }
        }
    }

    pub fn append(&mut self, other: &Mesh) {
        let (vbase, fbase) = (self.positions.len() as u32, self.faces.len() as u32);
        self.positions.extend_from_slice(&other.positions);
        self.normals.extend_from_slice(&other.normals);
        self.tris.extend(other.tris.iter().map(|t| [t[0] + vbase, t[1] + vbase, t[2] + vbase]));
        self.face.extend(other.face.iter().map(|f| f + fbase));
        self.faces.extend_from_slice(&other.faces);
        self.edges.extend_from_slice(&other.edges);
    }

    pub fn is_empty(&self) -> bool { self.tris.is_empty() }
    pub fn bounds(&self) -> Aabb { Aabb::of(self.positions.iter().copied()) }
    pub fn tri(&self, t: usize) -> [V3; 3] { let i = self.tris[t]; [self.positions[i[0] as usize], self.positions[i[1] as usize], self.positions[i[2] as usize]] }

    /// Enclosed volume (meaningful for a closed, outward-facing mesh).
    pub fn volume(&self) -> f64 {
        (0..self.tris.len()).map(|t| { let [a, b, c] = self.tri(t); a.dot(b.cross(c)) }).sum::<f64>() / 6.0
    }

    pub fn area(&self) -> f64 {
        (0..self.tris.len()).map(|t| { let [a, b, c] = self.tri(t); (b - a).cross(c - a).len() }).sum::<f64>() * 0.5
    }

    /// Center of mass of the enclosed volume.
    pub fn centroid(&self) -> V3 {
        let (mut vol, mut c) = (0.0, V3::default());
        for t in 0..self.tris.len() {
            let [a, b, p] = self.tri(t);
            let v = a.dot(b.cross(p));
            vol += v;
            c += (a + b + p) * v;
        }
        if vol.abs() < 1e-12 { self.bounds().center() } else { c / (4.0 * vol) }
    }

    /// How many edges are not shared by exactly two triangles, matching vertices by position.
    /// Zero for a watertight body.
    pub fn open_edges(&self) -> usize {
        let scale = self.bounds().diagonal().max(1e-9) * 1e-7;
        let key = |p: V3| ((p.x / scale).round() as i64, (p.y / scale).round() as i64, (p.z / scale).round() as i64);
        let mut ids: HashMap<(i64, i64, i64), u32> = HashMap::new();
        let mut id = |p: V3| { let n = ids.len() as u32; *ids.entry(key(p)).or_insert(n) };
        let mut count: HashMap<(u32, u32), i32> = HashMap::new();
        for t in 0..self.tris.len() {
            let v = self.tri(t).map(&mut id);
            for k in 0..3 {
                let (a, b) = (v[k], v[(k + 1) % 3]);
                if a == b { continue; }
                // Directed: an edge and its twin cancel.
                if a < b { *count.entry((a, b)).or_default() += 1; } else { *count.entry((b, a)).or_default() -= 1; }
            }
        }
        count.values().filter(|c| **c != 0).count()
    }

    /// Splits every edge longer than `max_edge` (repeatedly), keeping neighbours matched, so a
    /// deformer has vertices to bend. Flat faces stay flat; this adds no detail of its own.
    pub fn refine(&mut self, max_edge: f64) {
        if !(max_edge > 0.0) { return; }
        for _ in 0..10 {
            let mut mid: HashMap<(u32, u32), u32> = HashMap::new();
            let mut tris = Vec::with_capacity(self.tris.len() * 2);
            let mut face = Vec::with_capacity(self.face.len() * 2);
            let mut any = false;
            for (t, f) in self.tris.clone().into_iter().zip(self.face.clone()) {
                let mut m = [u32::MAX; 3];
                for k in 0..3 {
                    let (a, b) = (t[k], t[(k + 1) % 3]);
                    if self.positions[a as usize].dist(self.positions[b as usize]) <= max_edge { continue; }
                    let key = (a.min(b), a.max(b));
                    m[k] = match mid.get(&key) {
                        Some(v) => *v,
                        None => {
                            let v = self.push_vertex((self.positions[a as usize] + self.positions[b as usize]) * 0.5, (self.normals[a as usize] + self.normals[b as usize]).norm());
                            mid.insert(key, v);
                            v
                        }
                    };
                }
                let mut emit = |a: u32, b: u32, c: u32| { tris.push([a, b, c]); face.push(f); };
                match m.iter().filter(|v| **v != u32::MAX).count() {
                    0 => emit(t[0], t[1], t[2]),
                    3 => { any = true; emit(t[0], m[0], m[2]); emit(m[0], t[1], m[1]); emit(m[2], m[1], t[2]); emit(m[0], m[1], m[2]); }
                    1 => {
                        any = true;
                        let k = m.iter().position(|v| *v != u32::MAX).unwrap();
                        let (a, b, c) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
                        emit(a, m[k], c); emit(m[k], b, c);
                    }
                    _ => {
                        any = true;
                        // The unsplit edge is a..b; c is opposite it.
                        let k = m.iter().position(|v| *v == u32::MAX).unwrap();
                        let (a, b, c) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
                        let (mb, mc) = (m[(k + 1) % 3], m[(k + 2) % 3]);
                        emit(c, mc, mb); emit(mc, a, b); emit(mc, b, mb);
                    }
                }
            }
            self.tris = tris;
            self.face = face;
            if !any { break; }
        }
        let mut edges = Vec::with_capacity(self.edges.len());
        for [a, b] in &self.edges {
            let k = (a.dist(*b) / max_edge).ceil().max(1.0) as usize;
            for i in 0..k { edges.push([a.lerp(*b, i as f64 / k as f64), a.lerp(*b, (i + 1) as f64 / k as f64)]); }
        }
        self.edges = edges;
    }

    /// The mesh pushed through a smooth map of space. Normals follow the map's local stretch, and a
    /// map that mirrors turns the triangles back to face outward.
    pub fn mapped(&self, f: impl Fn(V3) -> V3) -> Mesh {
        let h = self.bounds().diagonal().max(1e-6) * 1e-5;
        let mut out = self.clone();
        let mut mirrored = 0usize;
        for (i, p) in self.positions.iter().enumerate() {
            let q = f(*p);
            let jx = (f(*p + v3(h, 0.0, 0.0)) - q) / h;
            let jy = (f(*p + v3(0.0, h, 0.0)) - q) / h;
            let jz = (f(*p + v3(0.0, 0.0, h)) - q) / h;
            // cof(J) n: how an oriented normal transforms.
            let n = self.normals[i];
            let cof = jy.cross(jz) * n.x + jz.cross(jx) * n.y + jx.cross(jy) * n.z;
            let det = jx.dot(jy.cross(jz));
            if det < 0.0 { mirrored += 1; }
            out.positions[i] = q;
            out.normals[i] = if det < 0.0 { -cof.norm() } else { cof.norm() };
        }
        if mirrored * 2 > self.positions.len() { for t in &mut out.tris { t.swap(1, 2); } }
        for e in &mut out.edges { *e = [f(e[0]), f(e[1])]; }
        out
    }
}

// --- Polygon triangulation ---------------------------------------------------------------------

/// Triangulates a polygon with holes by ear clipping. Indices are into `outer` followed by each
/// hole in order. Orientation of the inputs does not matter; triangles come out counter-clockwise.
pub fn triangulate(outer: &[V2], holes: &[Vec<V2>]) -> Vec<[usize; 3]> {
    if outer.len() < 3 { return Vec::new(); }
    let mut pts: Vec<V2> = outer.to_vec();
    let mut ring: Vec<usize> = (0..outer.len()).collect();
    if polygon_area(outer) < 0.0 { ring.reverse(); }
    // Holes, rightmost first, each spliced into the ring through a bridge to a visible vertex.
    let mut hole_rings: Vec<Vec<usize>> = Vec::new();
    for h in holes {
        if h.len() < 3 { pts.extend_from_slice(h); continue; }
        let base = pts.len();
        pts.extend_from_slice(h);
        let mut r: Vec<usize> = (base..base + h.len()).collect();
        if polygon_area(h) > 0.0 { r.reverse(); }
        hole_rings.push(r);
    }
    let max_x = |r: &Vec<usize>| r.iter().map(|i| pts[*i].x).fold(f64::NEG_INFINITY, f64::max);
    hole_rings.sort_by(|a, b| max_x(b).total_cmp(&max_x(a)));
    for h in hole_rings {
        let start = (0..h.len()).max_by(|a, b| pts[h[*a]].x.total_cmp(&pts[h[*b]].x)).unwrap();
        let m = pts[h[start]];
        let Some(at) = bridge(&pts, &ring, m) else { continue };
        let mut spliced = Vec::with_capacity(ring.len() + h.len() + 2);
        spliced.extend_from_slice(&ring[..=at]);
        for k in 0..=h.len() { spliced.push(h[(start + k) % h.len()]); }
        spliced.extend_from_slice(&ring[at..]);
        ring = spliced;
    }
    clip_ears(&pts, ring)
}

/// Position in `ring` of a vertex the hole point `m` can see (Eberly's bridge search).
fn bridge(pts: &[V2], ring: &[usize], m: V2) -> Option<usize> {
    let n = ring.len();
    // Nearest crossing of the ray from m toward +x.
    let (mut best_x, mut best) = (f64::INFINITY, None);
    for k in 0..n {
        let (a, b) = (pts[ring[k]], pts[ring[(k + 1) % n]]);
        if (a.y > m.y) == (b.y > m.y) && !(a.y == m.y && b.y == m.y) { continue; }
        if a.y == b.y { continue; }
        let x = a.x + (m.y - a.y) / (b.y - a.y) * (b.x - a.x);
        if x >= m.x - 1e-12 && x < best_x {
            best_x = x;
            best = Some(if a.x > b.x { k } else { (k + 1) % n });
        }
    }
    let mut at = best?;
    let p = pts[ring[at]];
    // A reflex vertex inside the triangle (m, crossing, p) would block the view: take the one
    // closest in angle to the ray instead.
    let (tri_a, tri_b, tri_c) = (m, v2(best_x, m.y), p);
    let mut best_tan = f64::INFINITY;
    for k in 0..n {
        let q = pts[ring[k]];
        if q.x < m.x || (q.x == p.x && q.y == p.y) { continue; }
        let inside = if tri_c.y < m.y { in_triangle(q, tri_a, tri_c, tri_b) } else { in_triangle(q, tri_a, tri_b, tri_c) };
        if !inside { continue; }
        let tan = (q.y - m.y).abs() / (q.x - m.x).max(1e-300);
        if tan < best_tan && locally_inside(pts, ring, k, m) { best_tan = tan; at = k; }
    }
    // A vertex can sit in the ring more than once (earlier bridges): use the copy that faces m.
    if !locally_inside(pts, ring, at, m) {
        if let Some(k) = (0..n).find(|&k| ring[k] == ring[at] && locally_inside(pts, ring, k, m)) { at = k; }
    }
    Some(at)
}

/// Is `q` within the interior angle of the ring at position `k`?
fn locally_inside(pts: &[V2], ring: &[usize], k: usize, q: V2) -> bool {
    let n = ring.len();
    let (a, b, c) = (pts[ring[(k + n - 1) % n]], pts[ring[k]], pts[ring[(k + 1) % n]]);
    if (b - a).cross(c - b) >= 0.0 {
        (b - a).cross(q - a) >= 0.0 && (c - b).cross(q - b) >= 0.0
    } else {
        (b - a).cross(q - a) >= 0.0 || (c - b).cross(q - b) >= 0.0
    }
}

fn in_triangle(q: V2, a: V2, b: V2, c: V2) -> bool {
    (b - a).cross(q - a) >= 0.0 && (c - b).cross(q - b) >= 0.0 && (a - c).cross(q - c) >= 0.0
}

fn clip_ears(pts: &[V2], ring: Vec<usize>) -> Vec<[usize; 3]> {
    let n = ring.len();
    let mut out = Vec::with_capacity(n.saturating_sub(2));
    if n < 3 { return out; }
    let mut prev: Vec<usize> = (0..n).map(|i| (i + n - 1) % n).collect();
    let mut next: Vec<usize> = (0..n).map(|i| (i + 1) % n).collect();
    let at = |k: usize| pts[ring[k]];
    let mut left = n;
    let mut cur = 0;
    let mut stalled = 0;
    while left > 3 {
        let (p, q) = (prev[cur], next[cur]);
        let (a, b, c) = (at(p), at(cur), at(q));
        let area = (b - a).cross(c - b);
        // After a full fruitless lap, take any non-reflex corner: better a sliver than a hole.
        let force = stalled > left;
        let mut ear = if force { area >= 0.0 || stalled > 2 * left } else { area > 1e-14 };
        if ear && !force {
            let mut k = next[q];
            while k != p {
                let v = at(k);
                let same = |u: V2| u.x == v.x && u.y == v.y;
                if !same(a) && !same(b) && !same(c) && in_triangle(v, a, b, c) {
                    // Only a reflex (or straight) vertex can poke into an ear.
                    if (v - at(prev[k])).cross(at(next[k]) - v) <= 0.0 { ear = false; break; }
                }
                k = next[k];
            }
        }
        if ear {
            if area.abs() > 1e-14 { out.push([ring[p], ring[cur], ring[q]]); }
            next[p] = q;
            prev[q] = p;
            left -= 1;
            stalled = 0;
            cur = q;
        } else {
            stalled += 1;
            cur = q;
        }
    }
    let (p, q) = (prev[cur], next[cur]);
    if (at(cur) - at(p)).cross(at(q) - at(cur)).abs() > 1e-14 { out.push([ring[p], ring[cur], ring[q]]); }
    out
}

// --- Spatial queries ---------------------------------------------------------------------------

/// Bounding volume hierarchy over a mesh's triangles: ray casts and box queries in log time.
pub struct Bvh {
    nodes: Vec<Node>,
    order: Vec<u32>,
    boxes: Vec<Aabb>,
}

struct Node { bbox: Aabb, a: u32, b: u32, leaf: bool }

impl Bvh {
    pub fn build(mesh: &Mesh) -> Bvh {
        let n = mesh.tris.len();
        let boxes: Vec<Aabb> = (0..n).map(|t| Aabb::of(mesh.tri(t))).collect();
        let mut bvh = Bvh { nodes: Vec::with_capacity(n / 2 + 1), order: (0..n as u32).collect(), boxes: Vec::new() };
        if n > 0 { bvh.split(&boxes, 0, n); }
        bvh.boxes = boxes;
        bvh
    }

    fn split(&mut self, boxes: &[Aabb], start: usize, end: usize) -> u32 {
        let bbox = self.order[start..end].iter().fold(Aabb::EMPTY, |b, t| b.union(boxes[*t as usize]));
        let id = self.nodes.len() as u32;
        self.nodes.push(Node { bbox, a: start as u32, b: end as u32, leaf: true });
        if end - start > 4 {
            let size = bbox.size();
            let axis = if size.x >= size.y && size.x >= size.z { 0 } else if size.y >= size.z { 1 } else { 2 };
            let mid = (start + end) / 2;
            self.order[start..end].select_nth_unstable_by(mid - start, |p, q| boxes[*p as usize].center().get(axis).total_cmp(&boxes[*q as usize].center().get(axis)));
            let a = self.split(boxes, start, mid);
            let b = self.split(boxes, mid, end);
            self.nodes[id as usize] = Node { bbox, a, b, leaf: false };
        }
        id
    }

    /// Calls `visit(triangle, t)` for every triangle the ray `origin + t * dir` (0 < t < t_max) hits.
    pub fn ray(&self, mesh: &Mesh, origin: V3, dir: V3, t_max: f64, mut visit: impl FnMut(usize, f64)) {
        if self.nodes.is_empty() { return; }
        let inv = v3(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
        let mut stack = vec![0u32];
        while let Some(i) = stack.pop() {
            let node = &self.nodes[i as usize];
            if !node.bbox.hit_by(origin, inv, t_max) { continue; }
            if node.leaf {
                for t in &self.order[node.a as usize..node.b as usize] {
                    let [a, b, c] = mesh.tri(*t as usize);
                    if let Some(hit) = ray_triangle(origin, dir, a, b, c) { if hit < t_max { visit(*t as usize, hit); } }
                }
            } else { stack.push(node.a); stack.push(node.b); }
        }
    }

    /// The nearest triangle hit by a ray: (t, triangle).
    pub fn nearest(&self, mesh: &Mesh, origin: V3, dir: V3) -> Option<(f64, usize)> {
        let mut best: Option<(f64, usize)> = None;
        self.ray(mesh, origin, dir, f64::INFINITY, |t, d| if best.map_or(true, |b| d < b.0) { best = Some((d, t)); });
        best
    }

    /// Triangles whose boxes overlap `query`.
    pub fn overlapping(&self, query: &Aabb, out: &mut Vec<u32>) {
        if self.nodes.is_empty() { return; }
        let mut stack = vec![0u32];
        while let Some(i) = stack.pop() {
            let node = &self.nodes[i as usize];
            if !node.bbox.overlaps(query) { continue; }
            if node.leaf {
                out.extend(self.order[node.a as usize..node.b as usize].iter().filter(|t| self.boxes[**t as usize].overlaps(query)));
            } else { stack.push(node.a); stack.push(node.b); }
        }
    }

    /// Is `p` inside the closed mesh? Three rays vote, so one grazing an edge can't decide alone.
    pub fn contains(&self, mesh: &Mesh, p: V3) -> bool {
        const DIRS: [V3; 3] = [v3(0.577_215_66, 0.211_324_87, 0.788_675_13), v3(-0.431_157_9, 0.862_315_8, 0.265_327_9), v3(0.193_649_2, -0.561_552_8, -0.804_468_1)];
        let mut votes = 0;
        for d in DIRS {
            let mut crossings = 0usize;
            self.ray(mesh, p, d, f64::INFINITY, |_, _| crossings += 1);
            if crossings % 2 == 1 { votes += 1; }
        }
        votes >= 2
    }
}

/// Moeller-Trumbore: distance along the ray to the triangle, if it hits its front or back.
pub fn ray_triangle(origin: V3, dir: V3, a: V3, b: V3, c: V3) -> Option<f64> {
    let (e1, e2) = (b - a, c - a);
    let p = dir.cross(e2);
    let det = e1.dot(p);
    if det.abs() < 1e-300 { return None; }
    let inv = 1.0 / det;
    let s = origin - a;
    let u = s.dot(p) * inv;
    if !(0.0..=1.0).contains(&u) { return None; }
    let q = s.cross(e1);
    let v = dir.dot(q) * inv;
    if v < 0.0 || u + v > 1.0 { return None; }
    let t = e2.dot(q) * inv;
    if t > 1e-12 { Some(t) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(s: f64) -> Vec<V2> { vec![v2(0.0, 0.0), v2(s, 0.0), v2(s, s), v2(0.0, s)] }

    fn tri_area(pts: &[V2], tris: &[[usize; 3]]) -> f64 {
        tris.iter().map(|t| { let a = (pts[t[1]] - pts[t[0]]).cross(pts[t[2]] - pts[t[0]]) * 0.5; assert!(a > 0.0, "clockwise or empty triangle"); a }).sum()
    }

    #[test]
    fn triangulation_covers_a_concave_polygon_exactly() {
        // An L, with a collinear point on one edge.
        let l = vec![v2(0.0, 0.0), v2(10.0, 0.0), v2(20.0, 0.0), v2(20.0, 5.0), v2(5.0, 5.0), v2(5.0, 20.0), v2(0.0, 20.0)];
        let tris = triangulate(&l, &[]);
        assert_eq!(tris.len(), l.len() - 2);
        assert!((tri_area(&l, &tris) - 175.0).abs() < 1e-9);
        // Clockwise input gives the same.
        let rev: Vec<V2> = l.iter().rev().copied().collect();
        assert!((tri_area(&rev, &triangulate(&rev, &[])) - 175.0).abs() < 1e-9);
    }

    #[test]
    fn triangulation_bridges_many_holes() {
        let outer = square(100.0);
        let mut holes = Vec::new();
        for gy in 0..4 { for gx in 0..4 {
            let (cx, cy) = (12.5 + 25.0 * gx as f64, 12.5 + 25.0 * gy as f64);
            holes.push((0..12).map(|k| { let a = -(k as f64) * std::f64::consts::TAU / 12.0; v2(cx + 6.0 * a.cos(), cy + 6.0 * a.sin()) }).collect::<Vec<V2>>());
        } }
        let tris = triangulate(&outer, &holes);
        let mut pts = outer.clone();
        for h in &holes { pts.extend_from_slice(h); }
        let hole_area: f64 = holes.iter().map(|h| polygon_area(h).abs()).sum();
        assert!((tri_area(&pts, &tris) - (10000.0 - hole_area)).abs() < 1e-6);
        // Every vertex is used: nothing left dangling on a rim.
        let used: std::collections::HashSet<usize> = tris.iter().flatten().copied().collect();
        assert_eq!(used.len(), pts.len());
    }

    /// A box built the way features build bodies: a grid for the sides and two caps.
    pub(crate) fn prism(profile: &[V2], z0: f64, z1: f64) -> Mesh {
        let mut m = Mesh::default();
        let rings: Vec<Vec<V3>> = [z0, z1].iter().map(|z| profile.iter().map(|p| v3(p.x, p.y, *z)).collect()).collect();
        let n = profile.len();
        let face = m.face_id("box", "side");
        m.add_grid(&Grid { rings: &rings, closed_u: true, closed_v: false, col_crease: &vec![true; n], row_crease: &[true, true], col_face: &vec![face; n] });
        let (start, end) = (m.face_id("box", "start"), m.face_id("box", "end"));
        m.add_cap(&[&rings[0]], &[profile], v3(0.0, 0.0, -1.0), start, true);
        m.add_cap(&[&rings[1]], &[profile], v3(0.0, 0.0, 1.0), end, false);
        m
    }

    #[test]
    fn a_swept_box_is_closed_outward_and_measures_right() {
        let m = prism(&square(10.0), 0.0, 30.0);
        assert_eq!(m.open_edges(), 0);
        assert!((m.volume() - 3000.0).abs() < 1e-9, "{}", m.volume());
        assert!((m.area() - (200.0 + 1200.0)).abs() < 1e-9);
        assert!(m.centroid().dist(v3(5.0, 5.0, 15.0)) < 1e-9);
        // Creased corners: every side vertex normal is a pure axis direction.
        for (p, n) in m.positions.iter().zip(&m.normals) {
            assert!((n.len() - 1.0).abs() < 1e-12, "{p:?} {n:?}");
            assert!(n.x.abs().max(n.y.abs()).max(n.z.abs()) > 0.999, "{n:?} is not axis aligned");
        }
        // 4 uprights, 4 + 4 rim edges.
        assert_eq!(m.edges.len(), 12);
        assert_eq!(m.faces.len(), 3);
    }

    #[test]
    fn a_smooth_grid_shares_normals_and_has_no_edges_across_it() {
        let circle: Vec<V2> = (0..64).map(|k| { let a = k as f64 * std::f64::consts::TAU / 64.0; v2(5.0 * a.cos(), 5.0 * a.sin()) }).collect();
        let mut m = Mesh::default();
        let rings: Vec<Vec<V3>> = [0.0, 10.0].iter().map(|z| circle.iter().map(|p| v3(p.x, p.y, *z)).collect()).collect();
        m.add_grid(&Grid { rings: &rings, closed_u: true, closed_v: false, col_crease: &[], row_crease: &[], col_face: &[] });
        assert_eq!(m.positions.len(), 128);
        for (p, n) in m.positions.iter().zip(&m.normals) { assert!(n.dist(v3(p.x / 5.0, p.y / 5.0, 0.0)) < 1e-9, "radial normals"); }
        assert_eq!(m.edges.len(), 128, "only the two rims");
    }

    #[test]
    fn refining_keeps_the_body_closed_and_its_volume() {
        let mut m = prism(&square(10.0), 0.0, 30.0);
        let before = m.tris.len();
        m.refine(4.0);
        assert!(m.tris.len() > before * 8);
        assert_eq!(m.open_edges(), 0);
        assert!((m.volume() - 3000.0).abs() < 1e-9);
        for t in 0..m.tris.len() { let [a, b, c] = m.tri(t); assert!(a.dist(b).max(b.dist(c)).max(c.dist(a)) <= 4.0 + 1e-9); }
        assert!(m.edges.iter().all(|e| e[0].dist(e[1]) <= 4.0 + 1e-9));
    }

    #[test]
    fn mapping_through_a_mirror_keeps_the_body_facing_outward() {
        let m = prism(&square(10.0), 0.0, 30.0);
        let mirrored = m.mapped(|p| v3(-p.x * 2.0, p.y, p.z));
        assert!((mirrored.volume() - 6000.0).abs() < 1e-6, "{}", mirrored.volume());
        for t in 0..mirrored.tris.len() {
            let [a, b, c] = mirrored.tri(t);
            let n = mirrored.normals[mirrored.tris[t][0] as usize];
            assert!((b - a).cross(c - a).norm().dot(n) > 0.99);
        }
    }

    #[test]
    fn rays_find_the_surface_and_know_inside_from_outside() {
        let m = prism(&square(10.0), 0.0, 30.0);
        let bvh = Bvh::build(&m);
        let (t, tri) = bvh.nearest(&m, v3(5.0, 5.0, 100.0), v3(0.0, 0.0, -1.0)).unwrap();
        assert!((t - 70.0).abs() < 1e-9);
        assert_eq!(m.faces[m.face[tri] as usize].part, "end");
        assert!(bvh.nearest(&m, v3(50.0, 5.0, 100.0), v3(0.0, 0.0, -1.0)).is_none());
        assert!(bvh.contains(&m, v3(1.0, 9.0, 29.0)));
        assert!(!bvh.contains(&m, v3(1.0, 9.0, 31.0)));
        assert!(!bvh.contains(&m, v3(-0.001, 5.0, 5.0)));
        let mut near = Vec::new();
        bvh.overlapping(&Aabb { min: v3(-1.0, -1.0, 29.0), max: v3(11.0, 11.0, 31.0) }, &mut near);
        assert!(near.len() >= 2 && near.len() < m.tris.len());
    }
}

//! Joining, cutting and intersecting bodies.
//!
//! Each triangle of one body is split along the planes of the other body's triangles that reach
//! it, so no piece straddles the other surface; each piece is then kept or dropped by asking
//! whether it lies inside the other body. Two probes, a hair either side of the piece, also tell
//! apart faces that lie exactly on the other body's surface (a pocket cut flush with the top face),
//! which is the case naive mesh booleans get wrong. The cost is near linear: a hierarchy over each
//! body finds the few triangles that can touch.

use std::collections::HashMap;

use crate::math::{Aabb, V3};
use crate::mesh::{Bvh, Mesh};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoolOp { Union, Subtract, Intersect }

#[derive(Clone)]
struct Piece {
    pos: Vec<V3>,
    nrm: Vec<V3>,
    /// Per edge (vertex i to i + 1): the other body's triangle whose plane made this edge.
    cut: Vec<Option<u32>>,
}

impl Piece {
    fn bounds(&self) -> Aabb { Aabb::of(self.pos.iter().copied()) }
    fn centroid(&self) -> V3 { self.pos.iter().fold(V3::default(), |s, p| s + *p) / self.pos.len() as f64 }

    /// Splits by the plane `n . p = d` if the piece has vertices clearly on both sides.
    fn split(&self, n: V3, d: f64, eps: f64, by: u32) -> Option<(Piece, Piece)> {
        let dist: Vec<f64> = self.pos.iter().map(|p| n.dot(*p) - d).collect();
        if !(dist.iter().any(|x| *x > eps) && dist.iter().any(|x| *x < -eps)) { return None; }
        // (position, normal, on the plane, tag of the original edge this vertex starts)
        let mut sides: [Vec<(V3, V3, bool, Option<u32>)>; 2] = [Vec::new(), Vec::new()];
        let len = self.pos.len();
        for i in 0..len {
            let j = (i + 1) % len;
            let (di, dj) = (dist[i], dist[j]);
            let on = di.abs() <= eps;
            if di >= -eps { sides[0].push((self.pos[i], self.nrm[i], on, self.cut[i])); }
            if di <= eps { sides[1].push((self.pos[i], self.nrm[i], on, self.cut[i])); }
            if (di > eps && dj < -eps) || (di < -eps && dj > eps) {
                let t = di / (di - dj);
                let v = (self.pos[i].lerp(self.pos[j], t), self.nrm[i].lerp(self.nrm[j], t).norm(), true, self.cut[i]);
                sides[0].push(v);
                sides[1].push(v);
            }
        }
        let build = |s: &Vec<(V3, V3, bool, Option<u32>)>| -> Piece {
            let k = s.len();
            Piece {
                pos: s.iter().map(|v| v.0).collect(),
                nrm: s.iter().map(|v| v.1).collect(),
                // An edge between two on-plane vertices lies on the cutting plane.
                cut: (0..k).map(|i| if s[i].2 && s[(i + 1) % k].2 { Some(by) } else { s[i].3 }).collect(),
            }
        };
        let (front, back) = (build(&sides[0]), build(&sides[1]));
        if front.pos.len() < 3 || back.pos.len() < 3 { return None; }
        Some((front, back))
    }
}

/// Where a piece of one body lies relative to the other body.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Place { Outside, Inside, OnSame, OnOpposite }

struct Cutter<'a> {
    other: &'a Mesh,
    bvh: Bvh,
    bounds: Aabb,
    eps: f64,
    nudge: f64,
}

impl<'a> Cutter<'a> {
    fn new(other: &'a Mesh, scale: f64) -> Cutter<'a> {
        Cutter { other, bvh: Bvh::build(other), bounds: other.bounds(), eps: scale * 1e-9, nudge: scale * 1e-6 }
    }

    /// Triangle `t` of `mesh`, cut into pieces that the other body's surface does not cross.
    fn pieces(&self, mesh: &Mesh, t: usize, near: &mut Vec<u32>) -> (Vec<Piece>, V3) {
        let idx = mesh.tris[t];
        let pos: Vec<V3> = idx.iter().map(|i| mesh.positions[*i as usize]).collect();
        let normal = (pos[1] - pos[0]).cross(pos[2] - pos[0]).norm();
        let whole = Piece { nrm: idx.iter().map(|i| mesh.normals[*i as usize]).collect(), pos, cut: vec![None; 3] };
        let bbox = whole.bounds().grown(self.eps);
        if !bbox.overlaps(&self.bounds) { return (vec![whole], normal); }
        near.clear();
        self.bvh.overlapping(&bbox, near);
        let plane_d = normal.dot(whole.pos[0]);
        let mut pieces = vec![whole];
        for &o in near.iter() {
            let tri = self.other.tri(o as usize);
            // Does the other triangle reach this one's plane at all?
            let side = tri.map(|p| normal.dot(p) - plane_d);
            if side.iter().all(|s| *s > self.eps) || side.iter().all(|s| *s < -self.eps) || side.iter().all(|s| s.abs() <= self.eps) { continue; }
            let n = (tri[1] - tri[0]).cross(tri[2] - tri[0]).norm();
            if n.len() < 0.5 { continue; }
            let d = n.dot(tri[0]);
            let reach = Aabb::of(tri).grown(self.eps);
            let mut next = Vec::with_capacity(pieces.len() + 2);
            for p in pieces {
                match if p.bounds().overlaps(&reach) { p.split(n, d, self.eps, o) } else { None } {
                    Some((a, b)) => { next.push(a); next.push(b); }
                    None => next.push(p),
                }
            }
            pieces = next;
        }
        (pieces, normal)
    }

    fn place(&self, piece: &Piece, normal: V3, near: &mut Vec<u32>) -> Place {
        let c = piece.centroid();
        if !self.bounds.grown(self.nudge * 2.0).overlaps(&Aabb { min: c, max: c }) { return Place::Outside; }
        // Lying in the other body's surface means sharing a plane with one of its triangles there;
        // merely passing close to it at a shallow angle does not.
        near.clear();
        self.bvh.overlapping(&Aabb { min: c, max: c }.grown(self.nudge), near);
        for t in near.iter() {
            let [p, q, r] = self.other.tri(*t as usize);
            let n = (q - p).cross(r - p);
            let len = n.len();
            if len < 1e-300 { continue; }
            let n = n / len;
            if n.cross(normal).len() > 1e-6 || n.dot(c - p).abs() > self.nudge { continue; }
            let tol = -1e-6 * len;
            if (q - p).cross(c - p).dot(n) >= tol && (r - q).cross(c - q).dot(n) >= tol && (p - r).cross(c - r).dot(n) >= tol {
                return if n.dot(normal) > 0.0 { Place::OnSame } else { Place::OnOpposite };
            }
        }
        if self.bvh.contains(self.other, c) { Place::Inside } else { Place::Outside }
    }

    /// Does `p` lie on the other body's surface?
    fn on_surface(&self, p: V3, near: &mut Vec<u32>) -> bool {
        let reach = self.nudge;
        near.clear();
        self.bvh.overlapping(&Aabb { min: p, max: p }.grown(reach), near);
        near.iter().any(|t| {
            let [a, b, c] = self.other.tri(*t as usize);
            let n = (b - a).cross(c - a);
            let len = n.len();
            if len < 1e-300 || (n.dot(p - a) / len).abs() > reach { return false; }
            let tol = -1e-6 * len;
            (b - a).cross(p - a).dot(n) >= tol && (c - b).cross(p - b).dot(n) >= tol && (a - c).cross(p - c).dot(n) >= tol
        })
    }

    /// The parts of segment `a..b` that are inside (or outside) the other body.
    fn clip_edge(&self, a: V3, b: V3, keep_inside: bool, out: &mut Vec<[V3; 2]>) {
        let d = b - a;
        let len = d.len();
        if len < self.eps { return; }
        let mid_box = Aabb::of([a, b]);
        if !mid_box.overlaps(&self.bounds) { if !keep_inside { out.push([a, b]); } return; }
        let mut ts = vec![0.0, 1.0];
        self.bvh.ray(self.other, a, d, 1.0, |_, t| ts.push(t));
        ts.sort_by(|x, y| x.total_cmp(y));
        for w in ts.windows(2) {
            if w[1] - w[0] < 1e-9 { continue; }
            let m = a + d * (0.5 * (w[0] + w[1]));
            if self.bvh.contains(self.other, m) == keep_inside { out.push([a + d * w[0], a + d * w[1]]); }
        }
    }
}

struct Builder { mesh: Mesh, ids: HashMap<[i64; 6], u32>, q: f64 }

impl Builder {
    fn vertex(&mut self, p: V3, n: V3) -> u32 {
        let key = [(p.x / self.q).round() as i64, (p.y / self.q).round() as i64, (p.z / self.q).round() as i64, (n.x * 2048.0).round() as i64, (n.y * 2048.0).round() as i64, (n.z * 2048.0).round() as i64];
        if let Some(i) = self.ids.get(&key) { return *i; }
        let i = self.mesh.positions.len() as u32;
        self.mesh.positions.push(p);
        self.mesh.normals.push(n);
        self.ids.insert(key, i);
        i
    }

    fn piece(&mut self, piece: &Piece, face: u32, flip: bool) {
        let ids: Vec<u32> = (0..piece.pos.len()).map(|i| self.vertex(piece.pos[i], if flip { -piece.nrm[i] } else { piece.nrm[i] })).collect();
        for k in 1..ids.len() - 1 {
            let (a, b, c) = (ids[0], ids[k], ids[k + 1]);
            if a == b || b == c || a == c { continue; }
            self.mesh.tris.push(if flip { [a, c, b] } else { [a, b, c] });
            self.mesh.face.push(face);
        }
    }
}

/// `a` joined with, cut by, or intersected with `b`. Both should be closed bodies.
pub fn boolean(a: &Mesh, b: &Mesh, op: BoolOp) -> Mesh {
    if b.is_empty() { return if op == BoolOp::Intersect { Mesh::default() } else { a.clone() }; }
    if a.is_empty() { return if op == BoolOp::Union { b.clone() } else { Mesh::default() }; }
    let scale = a.bounds().union(b.bounds()).diagonal().max(1e-9);
    let (cut_by_b, cut_by_a) = (Cutter::new(b, scale), Cutter::new(a, scale));
    let mut out = Builder { mesh: Mesh::default(), ids: HashMap::new(), q: scale * 1e-8 };
    out.mesh.faces = a.faces.clone();
    out.mesh.faces.extend_from_slice(&b.faces);
    let mut near = Vec::new();
    let mut probe = Vec::new();

    // What survives of each body. A face lying on the other body's surface is kept once (from
    // `a`) where the two agree, and not at all where material meets material.
    let keep_a = |p: Place| match op {
        BoolOp::Union => matches!(p, Place::Outside | Place::OnSame),
        BoolOp::Subtract => matches!(p, Place::Outside | Place::OnOpposite),
        BoolOp::Intersect => matches!(p, Place::Inside | Place::OnSame),
    };
    let keep_b = |p: Place| match op {
        BoolOp::Union => p == Place::Outside,
        BoolOp::Subtract | BoolOp::Intersect => p == Place::Inside,
    };
    for t in 0..a.tris.len() {
        let (pieces, normal) = cut_by_b.pieces(a, t, &mut near);
        for piece in &pieces {
            if !keep_a(cut_by_b.place(piece, normal, &mut probe)) { continue; }
            out.piece(piece, a.face[t], false);
            // Edges made by the cut, where they really lie on the other surface, are the seam.
            for i in 0..piece.pos.len() {
                if piece.cut[i].is_none() { continue; }
                let (p, q) = (piece.pos[i], piece.pos[(i + 1) % piece.pos.len()]);
                if p.dist(q) > cut_by_b.eps && cut_by_b.on_surface((p + q) * 0.5, &mut near) { out.mesh.edges.push([p, q]); }
            }
        }
    }
    let face_base = a.faces.len() as u32;
    for t in 0..b.tris.len() {
        let (pieces, normal) = cut_by_a.pieces(b, t, &mut near);
        for piece in &pieces {
            if keep_b(cut_by_a.place(piece, normal, &mut probe)) { out.piece(piece, face_base + b.face[t], op == BoolOp::Subtract); }
        }
    }
    for e in &a.edges { cut_by_b.clip_edge(e[0], e[1], op == BoolOp::Intersect, &mut out.mesh.edges); }
    for e in &b.edges { cut_by_a.clip_edge(e[0], e[1], op != BoolOp::Union, &mut out.mesh.edges); }
    seal(&mut out.mesh, scale * 1e-8);
    out.mesh
}

/// Closes the hairline T-junctions a cut leaves behind: where one triangle's edge was split and
/// its neighbour's was not, the neighbour is split at the same points. `q` is the weld distance.
fn seal(mesh: &mut Mesh, q: f64) {
    let key = |p: V3| [(p.x / q).round() as i64, (p.y / q).round() as i64, (p.z / q).round() as i64];
    for _ in 0..8 {
        let mut ids: HashMap<[i64; 3], u32> = HashMap::new();
        let mut rep: Vec<V3> = Vec::new();
        let weld: Vec<u32> = mesh.positions.iter().map(|p| *ids.entry(key(*p)).or_insert_with(|| { rep.push(*p); (rep.len() - 1) as u32 })).collect();
        // Directed edges without a twin are the open ones.
        let mut half: HashMap<(u32, u32), (usize, usize)> = HashMap::new();
        for (t, tri) in mesh.tris.iter().enumerate() {
            for k in 0..3 { half.insert((weld[tri[k] as usize], weld[tri[(k + 1) % 3] as usize]), (t, k)); }
        }
        let open: Vec<((u32, u32), (usize, usize))> = half.iter().filter(|(e, _)| e.0 != e.1 && !half.contains_key(&(e.1, e.0))).map(|(e, at)| (*e, *at)).collect();
        if open.is_empty() { return; }
        // Welded vertices on open edges, bucketed on a coarse grid for the on-segment search.
        let mut loose: Vec<u32> = open.iter().flat_map(|(e, _)| [e.0, e.1]).collect();
        loose.sort_unstable();
        loose.dedup();
        let cell = (open.iter().map(|(e, _)| rep[e.0 as usize].dist(rep[e.1 as usize])).sum::<f64>() / open.len() as f64).max(q * 16.0);
        let bucket = |p: V3| [(p.x / cell).floor() as i64, (p.y / cell).floor() as i64, (p.z / cell).floor() as i64];
        let mut grid: HashMap<[i64; 3], Vec<u32>> = HashMap::new();
        for v in &loose { grid.entry(bucket(rep[*v as usize])).or_default().push(*v); }
        // Per triangle and edge: the extra vertices (welded id, parameter) found along it.
        let mut splits: HashMap<usize, [Vec<(f64, u32)>; 3]> = HashMap::new();
        for ((ea, eb), (t, k)) in &open {
            let (a, b) = (rep[*ea as usize], rep[*eb as usize]);
            let d = b - a;
            let l2 = d.dot(d);
            let (lo, hi) = (bucket(a.min(b)), bucket(a.max(b)));
            if (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 4096 { continue; }
            for x in lo[0]..=hi[0] { for y in lo[1]..=hi[1] { for z in lo[2]..=hi[2] {
                let Some(list) = grid.get(&[x, y, z]) else { continue };
                for v in list {
                    if v == ea || v == eb { continue; }
                    let p = rep[*v as usize];
                    let s = (p - a).dot(d) / l2;
                    if s <= 1e-9 || s >= 1.0 - 1e-9 || p.dist(a + d * s) > q * 4.0 { continue; }
                    splits.entry(*t).or_default()[*k].push((s, *v));
                }
            } } }
        }
        if splits.is_empty() { return; }
        let mut tris = Vec::with_capacity(mesh.tris.len() + splits.len() * 2);
        let mut face = Vec::with_capacity(tris.capacity());
        for (t, tri) in mesh.tris.clone().into_iter().enumerate() {
            let Some(extra) = splits.get_mut(&t) else { tris.push(tri); face.push(mesh.face[t]); continue };
            // The triangle's outline with the extra vertices in place, fanned without slivers.
            let mut ring: Vec<u32> = Vec::new();
            for k in 0..3 {
                ring.push(tri[k]);
                extra[k].sort_by(|x, y| x.0.total_cmp(&y.0));
                extra[k].dedup_by_key(|e| e.1);
                let (va, vb) = (tri[k] as usize, tri[(k + 1) % 3] as usize);
                for (s, v) in extra[k].iter() {
                    mesh.positions.push(rep[*v as usize]);
                    mesh.normals.push(mesh.normals[va].lerp(mesh.normals[vb], *s).norm());
                    ring.push((mesh.positions.len() - 1) as u32);
                }
            }
            fan_ring(mesh, &ring, mesh.face[t], &mut tris, &mut face);
        }
        mesh.tris = tris;
        mesh.face = face;
    }
}

/// Triangulates a triangle whose edges carry extra collinear vertices, by clipping ears that have
/// area and no other vertex on or in them (so every extra vertex ends up on a triangle's corner).
fn fan_ring(mesh: &Mesh, ring: &[u32], f: u32, tris: &mut Vec<[u32; 3]>, face: &mut Vec<u32>) {
    let mut ring = ring.to_vec();
    let at = |v: u32| mesh.positions[v as usize];
    let normal = (1..ring.len() - 1).fold(V3::default(), |s, k| s + (at(ring[k]) - at(ring[0])).cross(at(ring[k + 1]) - at(ring[0])));
    let tiny = normal.len() * 1e-12;
    let area = |a: u32, b: u32, c: u32| (at(b) - at(a)).cross(at(c) - at(a)).dot(normal);
    while ring.len() > 3 {
        let n = ring.len();
        let mut best: Option<(f64, usize)> = None;
        for i in 0..n {
            let (a, b, c) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
            let size = area(a, b, c);
            if size <= tiny || best.map_or(false, |x| size <= x.0) { continue; }
            let blocked = ring.iter().any(|v| *v != a && *v != b && *v != c && area(a, b, *v) >= -tiny && area(b, c, *v) >= -tiny && area(c, a, *v) >= -tiny);
            if !blocked { best = Some((size, i)); }
        }
        // No clean ear (points bunched within rounding of each other): close the rest with a
        // plain fan. Its slivers have no area, but they keep the surface sealed.
        let Some((_, i)) = best else {
            for k in 1..ring.len() - 1 { tris.push([ring[0], ring[k], ring[k + 1]]); face.push(f); }
            return;
        };
        tris.push([ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]]);
        face.push(f);
        ring.remove(i);
    }
    if ring.len() == 3 { tris.push([ring[0], ring[1], ring[2]]); face.push(f); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{v2, v3, V2};
    use crate::mesh::Grid;

    fn prism(profile: &[V2], z0: f64, z1: f64, name: &str) -> Mesh {
        let mut m = Mesh::default();
        let rings: Vec<Vec<V3>> = [z0, z1].iter().map(|z| profile.iter().map(|p| v3(p.x, p.y, *z)).collect()).collect();
        let n = profile.len();
        let smooth = n > 8;
        let face = m.face_id(name, "side");
        m.add_grid(&Grid { rings: &rings, closed_u: true, closed_v: false, col_crease: &vec![!smooth; n], row_crease: &[true, true], col_face: &vec![face; n] });
        let (start, end) = (m.face_id(name, "start"), m.face_id(name, "end"));
        m.add_cap(&[&rings[0]], &[profile], v3(0.0, 0.0, -1.0), start, true);
        m.add_cap(&[&rings[1]], &[profile], v3(0.0, 0.0, 1.0), end, false);
        m
    }
    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<V2> { vec![v2(x0, y0), v2(x1, y0), v2(x1, y1), v2(x0, y1)] }
    fn disc(cx: f64, cy: f64, r: f64, n: usize) -> Vec<V2> { (0..n).map(|k| { let a = k as f64 * std::f64::consts::TAU / n as f64; v2(cx + r * a.cos(), cy + r * a.sin()) }).collect() }

    fn outward(m: &Mesh) {
        for t in 0..m.tris.len() {
            let [a, b, c] = m.tri(t);
            let g = (b - a).cross(c - a).norm();
            for v in m.tris[t] { assert!(g.dot(m.normals[v as usize]) > 0.2, "triangle {t} faces away from its normals"); }
        }
    }

    #[test]
    fn overlapping_boxes_join_cut_and_intersect() {
        let a = prism(&rect(0.0, 0.0, 10.0, 10.0), 0.0, 10.0, "a");
        let b = prism(&rect(5.0, 5.0, 15.0, 15.0), 5.0, 15.0, "b");
        let (u, s, i) = (boolean(&a, &b, BoolOp::Union), boolean(&a, &b, BoolOp::Subtract), boolean(&a, &b, BoolOp::Intersect));
        assert!((u.volume() - 1875.0).abs() < 1e-6, "{}", u.volume());
        assert!((s.volume() - 875.0).abs() < 1e-6, "{}", s.volume());
        assert!((i.volume() - 125.0).abs() < 1e-6, "{}", i.volume());
        for m in [&u, &s, &i] { assert_eq!(m.open_edges(), 0); outward(m); }
        // The cut's inner faces belong to the tool.
        assert!(s.face.iter().any(|f| s.faces[*f as usize].feature == "b"));
        // The seam: three edges of the corner bitten out, each 5 long, on each of 3 faces.
        let seam: f64 = s.edges.iter().map(|e| e[0].dist(e[1])).sum();
        assert!(seam > 120.0 - 15.0 + 30.0 - 1e-6, "edges total {seam}");
    }

    #[test]
    fn a_pocket_flush_with_the_top_face_has_no_lid() {
        let body = prism(&rect(0.0, 0.0, 40.0, 30.0), 0.0, 10.0, "body");
        let tool = prism(&rect(10.0, 10.0, 20.0, 20.0), 6.0, 10.0, "pocket");
        let cut = boolean(&body, &tool, BoolOp::Subtract);
        assert!((cut.volume() - (12000.0 - 400.0)).abs() < 1e-6, "{}", cut.volume());
        assert_eq!(cut.open_edges(), 0);
        outward(&cut);
        // Nothing left over the pocket at the top.
        let bvh = Bvh::build(&cut);
        let (t, _) = bvh.nearest(&cut, v3(15.0, 15.0, 50.0), v3(0.0, 0.0, -1.0)).unwrap();
        assert!((t - 44.0).abs() < 1e-9, "the ray should land on the pocket floor, went {t}");
        // Joining a boss that sits exactly on the top face fuses it: no wall between them.
        let boss = prism(&rect(10.0, 10.0, 20.0, 20.0), 10.0, 14.0, "boss");
        let joined = boolean(&body, &boss, BoolOp::Union);
        assert!((joined.volume() - 12400.0).abs() < 1e-6);
        assert!((joined.area() - (2.0 * 1200.0 + 140.0 * 10.0 + 160.0)).abs() < 1e-6, "{}", joined.area());
        assert_eq!(joined.open_edges(), 0);
    }

    #[test]
    fn a_round_hole_through_a_plate() {
        let plate = prism(&rect(-20.0, -20.0, 20.0, 20.0), 0.0, 6.0, "plate");
        let drill = prism(&disc(3.0, -2.0, 8.0, 96), -5.0, 11.0, "drill");
        let holed = boolean(&plate, &drill, BoolOp::Subtract);
        let expect = 9600.0 - crate::math::polygon_area(&disc(0.0, 0.0, 8.0, 96)) * 6.0;
        assert!((holed.volume() - expect).abs() < 1e-5, "{} vs {expect}", holed.volume());
        assert_eq!(holed.open_edges(), 0);
        outward(&holed);
        // The bore keeps the drill's smooth normals, pointing into the hole.
        let bore: Vec<usize> = (0..holed.tris.len()).filter(|t| holed.faces[holed.face[*t] as usize] == crate::mesh::FaceTag { feature: "drill".into(), part: "side".into() }).collect();
        assert!(bore.len() >= 96);
        for t in bore { for v in holed.tris[t] {
            let (p, n) = (holed.positions[v as usize], holed.normals[v as usize]);
            assert!(n.dist(v3(3.0 - p.x, -2.0 - p.y, 0.0).norm()) < 1e-3, "{p:?} {n:?}");
        } }
        // Two circular seams.
        let seam: f64 = holed.edges.iter().filter(|e| (e[0].x - 3.0).hypot(e[0].y + 2.0) < 8.1 && (e[0].z - e[1].z).abs() < 1e-9).map(|e| e[0].dist(e[1])).sum();
        assert!((seam - 2.0 * 96.0 * 2.0 * 8.0 * (std::f64::consts::PI / 96.0).sin()).abs() < 1e-3, "{seam}");
    }

    #[test]
    fn apart_and_nested_bodies_take_the_easy_way_out() {
        let a = prism(&rect(0.0, 0.0, 10.0, 10.0), 0.0, 10.0, "a");
        let far = prism(&rect(50.0, 0.0, 60.0, 10.0), 0.0, 10.0, "far");
        assert!((boolean(&a, &far, BoolOp::Union).volume() - 2000.0).abs() < 1e-9);
        assert!((boolean(&a, &far, BoolOp::Subtract).volume() - 1000.0).abs() < 1e-9);
        assert!(boolean(&a, &far, BoolOp::Intersect).is_empty());
        let inner = prism(&rect(3.0, 3.0, 7.0, 7.0), 3.0, 7.0, "inner");
        let hollow = boolean(&a, &inner, BoolOp::Subtract);
        assert!((hollow.volume() - (1000.0 - 64.0)).abs() < 1e-9);
        assert_eq!(hollow.tris.len(), 24, "a void inside: both shells, uncut");
        assert!((boolean(&a, &inner, BoolOp::Intersect).volume() - 64.0).abs() < 1e-9);
        assert!((boolean(&a, &inner, BoolOp::Union).volume() - 1000.0).abs() < 1e-9);
    }

    #[test]
    fn two_cylinders_crossing_stay_fast_and_closed() {
        let a = prism(&disc(0.0, 0.0, 10.0, 256), -30.0, 30.0, "a");
        // The same cylinder lying along x.
        let b = a.mapped(|p| v3(p.z, p.y, -p.x));
        let started = std::time::Instant::now();
        let both = boolean(&a, &b, BoolOp::Intersect);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        // A Steinmetz solid: 16 r^3 / 3.
        assert!((both.volume() - 16000.0 / 3.0).abs() < 16000.0 / 3.0 * 2e-3, "{}", both.volume());
        assert_eq!(both.open_edges(), 0);
        assert!(ms < 2000.0, "took {ms} ms");
    }
}

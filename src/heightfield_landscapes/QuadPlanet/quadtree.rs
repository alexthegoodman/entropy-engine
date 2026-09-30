//! The QuadScape idea wrapped around a sphere.
//!
//! QuadScape (QuadTree.rs + QuadScape.rs) streams one flat heightfield: a static quadtree over
//! the map, a tile's LOD picked from its distance to the viewer (LOD_RINGS), and a per-frame diff
//! of the wanted tiles against the live ones.
//!
//! A planet is six of those quadtrees, one per face of a cube, with every grid point pushed out
//! onto the sphere (the "spherified cube" mapping keeps cells close to equal-area) and then out
//! again by the terrain height. Because the planet is huge compared to the walker, the tree isn't
//! a fixed depth: a node splits while the viewer is closer than `split_factor` times the node's
//! own size, so the rings of detail follow the viewer continuously from orbit down to boots on
//! the ground.
//!
//! Crack prevention. Neighbouring chunks must agree exactly on their shared border, but a chunk
//! one level coarser is twice as big, has half as many border vertices along a shared edge and,
//! since coarse chunks sample smoother (band-limited) terrain, different heights too. So:
//!
//!   1. The tree is kept 2:1 balanced: no chunk touches (by an edge or a corner) a chunk more
//!      than one level finer or coarser. `balance` splits chunks until that holds.
//!   2. Where a chunk borders a coarser neighbour, that edge is "stitched": the finer chunk uses
//!      only every other vertex on it - exactly the coarse chunk's vertices - and triangulates
//!      around the skipped ones.
//!   3. Every vertex on a chunk border is sampled at the band limit of the coarsest chunk
//!      touching that point, with a normal computed the same way, so neighbours agree on its
//!      position and shading. All grid coordinates are exact binary fractions, so "the same
//!      point" is the same floating-point number on both sides, even across cube faces.
//!
//! The stitch pattern is part of a chunk's key: when a neighbour changes level, the chunk is
//! rebuilt to match.

use std::collections::HashMap;

use super::elevation::{Access, Lookup};
use super::math::*;
use super::planet::Planet;

/// Cube faces: `n` is the face normal, `a`/`b` span the face so that a x b = n. A grid laid out
/// with a along columns and b along rows is therefore counter-clockwise seen from outside, which
/// is what the engine's back-face culling keeps.
pub struct Face { pub n: V3, pub a: V3, pub b: V3 }

pub const FACES: [Face; 6] = [
    Face { n: [1.0, 0.0, 0.0], a: [0.0, 0.0, -1.0], b: [0.0, 1.0, 0.0] },
    Face { n: [-1.0, 0.0, 0.0], a: [0.0, 0.0, 1.0], b: [0.0, 1.0, 0.0] },
    Face { n: [0.0, 1.0, 0.0], a: [1.0, 0.0, 0.0], b: [0.0, 0.0, -1.0] },
    Face { n: [0.0, -1.0, 0.0], a: [1.0, 0.0, 0.0], b: [0.0, 0.0, 1.0] },
    Face { n: [0.0, 0.0, 1.0], a: [1.0, 0.0, 0.0], b: [0.0, 1.0, 0.0] },
    Face { n: [0.0, 0.0, -1.0], a: [-1.0, 0.0, 0.0], b: [0.0, 1.0, 0.0] },
];

/// Edges of a chunk, in stitch-bit order.
pub const EDGE_B_MIN: u32 = 0;
pub const EDGE_B_MAX: u32 = 1;
pub const EDGE_A_MIN: u32 = 2;
pub const EDGE_A_MAX: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ChunkNode {
    pub planet: u32,
    pub face: u8,
    pub level: u32,
    /// Integer cell index along a / b at this level (0 .. 2^level - 1).
    pub ia: u32,
    pub ib: u32,
    /// Which borders meet a coarser chunk: bits 0-3 are the edges (EDGE_*), bits 4-7 the corners
    /// (a-min/b-min, a-max/b-min, a-min/b-max, a-max/b-max). Set by `assign_stitches`.
    pub stitch: u8,
}

impl ChunkNode {
    pub fn root(planet: u32, face: u8) -> Self { Self { planet, face, level: 0, ia: 0, ib: 0, stitch: 0 } }

    pub fn key(&self) -> String {
        format!("qp-{}-{}-{}-{}-{}-{}", self.planet, self.face, self.level, self.ia, self.ib, self.stitch)
    }

    pub fn children(&self) -> [ChunkNode; 4] {
        let c = |i: u32, j: u32| ChunkNode { planet: self.planet, face: self.face, level: self.level + 1, ia: self.ia * 2 + i, ib: self.ib * 2 + j, stitch: 0 };
        [c(0, 0), c(1, 0), c(0, 1), c(1, 1)]
    }

    /// Unit direction of the node's center.
    pub fn center_direction(&self) -> V3 {
        let size = node_param_size(self.level);
        face_direction(self.face as usize, -1.0 + (self.ia as f64 + 0.5) * size, -1.0 + (self.ib as f64 + 0.5) * size)
    }

    /// World-space center of the node's ground, band-limited to its level.
    pub fn ground_center(&self, p: &Planet, lk: &mut Lookup) -> V3 {
        let dir = self.center_direction();
        add_scaled(p.def.center, dir, p.def.radius + p.sample(dir, p.level_spacing(self.level), lk).surface)
    }
}

/// Size of the node in face parameter units (a root face spans [-1, 1], size 2).
pub fn node_param_size(level: u32) -> f64 { 2.0 / (1u64 << level) as f64 }

/// Maps a point on the cube's surface ([-1,1]^3, one coordinate +-1) to the unit sphere.
pub fn cube_to_sphere(p: V3) -> V3 {
    let [x, y, z] = p;
    let (x2, y2, z2) = (x * x, y * y, z * z);
    normalize([
        x * (1.0 - y2 / 2.0 - z2 / 2.0 + (y2 * z2) / 3.0).max(0.0).sqrt(),
        y * (1.0 - z2 / 2.0 - x2 / 2.0 + (z2 * x2) / 3.0).max(0.0).sqrt(),
        z * (1.0 - x2 / 2.0 - y2 / 2.0 + (x2 * y2) / 3.0).max(0.0).sqrt(),
    ])
}

fn cube_point(face: usize, a: f64, b: f64) -> V3 {
    let f = &FACES[face];
    [f.n[0] + f.a[0] * a + f.b[0] * b, f.n[1] + f.a[1] * a + f.b[1] * b, f.n[2] + f.a[2] * a + f.b[2] * b]
}

/// Unit direction for face parameters (a, b).
pub fn face_direction(face: usize, a: f64, b: f64) -> V3 { cube_to_sphere(cube_point(face, a, b)) }

/// Face parameters of a point given on `face` but possibly just past its border: such a point is
/// carried over the cube's edge onto the neighbouring face (for neighbour lookups).
pub fn wrap_face(face: usize, a: f64, b: f64) -> (usize, f64, f64) {
    if a.abs() <= 1.0 && b.abs() <= 1.0 { return (face, a, b); }
    let p = cube_point(face, a, b);
    let mut m = 0;
    for k in 1..3 { if p[k].abs() > p[m].abs() { m = k; } }
    let q = scale(p, 1.0 / p[m].abs());
    let sign = p[m].signum();
    let nf = FACES.iter().position(|f| f.n[m] == sign).unwrap();
    (nf, dot(q, FACES[nf].a), dot(q, FACES[nf].b))
}

/// True when the two nodes (same planet and face) cover overlapping ground.
pub fn nodes_overlap(a: &ChunkNode, b: &ChunkNode) -> bool {
    if a.planet != b.planet || a.face != b.face { return false; }
    let (hi, lo) = if a.level >= b.level { (a, b) } else { (b, a) };
    let shift = hi.level - lo.level;
    (hi.ia >> shift) == lo.ia && (hi.ib >> shift) == lo.ib
}

#[derive(Clone, Debug)]
pub struct LodSettings {
    /// A node splits while the viewer is closer than split_factor x its size.
    pub split_factor: f64,
    /// Never coarser than this (a whole face as one chunk looks faceted from orbit).
    pub min_level: u32,
}

impl Default for LodSettings {
    fn default() -> Self { Self { split_factor: 1.5, min_level: 1 } }
}

pub struct Selection {
    /// Leaves with their ground centers.
    pub leaves: Vec<(ChunkNode, V3)>,
    /// Nodes skipped because they are below the viewer's horizon.
    pub hidden: usize,
    /// Chunks split to keep the tree 2:1 balanced.
    pub balanced: usize,
}

// --- The leaf set --------------------------------------------------------------------------------

/// One planet's leaves, findable by any point on the cube.
pub struct LeafIndex {
    map: HashMap<u64, ChunkNode>,
    max_level: u32,
}

impl LeafIndex {
    pub fn new(max_level: u32) -> Self { Self { map: HashMap::new(), max_level } }

    fn id(face: u8, level: u32, ia: u32, ib: u32) -> u64 {
        // 2^21 cells a side covers every level MAX_CHUNK_LEVELS allows.
        (((level as u64 * 6 + face as u64) << 21 | ia as u64) << 21) | ib as u64
    }

    pub fn add(&mut self, n: ChunkNode) { self.map.insert(Self::id(n.face, n.level, n.ia, n.ib), n); }
    pub fn remove(&mut self, n: &ChunkNode) { self.map.remove(&Self::id(n.face, n.level, n.ia, n.ib)); }
    pub fn has(&self, n: &ChunkNode) -> bool { self.map.contains_key(&Self::id(n.face, n.level, n.ia, n.ib)) }
    pub fn len(&self) -> usize { self.map.len() }
    pub fn values(&self) -> Vec<ChunkNode> { self.map.values().copied().collect() }

    /// The leaf covering face point (a, b), which may lie just past the face's border.
    pub fn find(&self, face: usize, a: f64, b: f64) -> Option<ChunkNode> {
        let (f, u, v) = wrap_face(face, a, b);
        for level in 0..=self.max_level {
            let cells = (1u64 << level) as f64;
            let ia = (((u + 1.0) / 2.0) * cells).floor().clamp(0.0, cells - 1.0) as u32;
            let ib = (((v + 1.0) / 2.0) * cells).floor().clamp(0.0, cells - 1.0) as u32;
            if let Some(hit) = self.map.get(&Self::id(f as u8, level, ia, ib)) { return Some(*hit); }
        }
        None
    }
}

/// How far outside a node its neighbour probes land, as a fraction of its size.
const PROBE: f64 = 1e-4;

/// Points just outside the node: `per_edge` along each edge, plus the four diagonal corners.
fn probe_points(n: &ChunkNode, per_edge: usize) -> Vec<(f64, f64)> {
    let s = node_param_size(n.level);
    let (a0, b0, e) = (-1.0 + n.ia as f64 * s, -1.0 + n.ib as f64 * s, s * PROBE);
    let mut out = Vec::with_capacity(per_edge * 4 + 4);
    for k in 0..per_edge {
        let t = ((k as f64 + 0.5) / per_edge as f64) * s;
        out.extend([(a0 + t, b0 - e), (a0 + t, b0 + s + e), (a0 - e, b0 + t), (a0 + s + e, b0 + t)]);
    }
    out.extend([(a0 - e, b0 - e), (a0 + s + e, b0 - e), (a0 - e, b0 + s + e), (a0 + s + e, b0 + s + e)]);
    out
}

/// Splits leaves until none touches (along an edge or at a corner) a leaf two or more levels
/// finer. Returns how many splits that took.
pub fn balance(index: &mut LeafIndex) -> usize {
    let mut splits = 0;
    let mut queue = index.values();
    while let Some(n) = queue.pop() {
        if !index.has(&n) { continue; }
        // Four probes per edge sit in each of the cells two levels down along it, so a neighbour
        // that fine is always hit.
        let mut neighbours = Vec::new();
        let mut split = false;
        for (a, b) in probe_points(&n, 4) {
            let Some(m) = index.find(n.face as usize, a, b) else { continue };
            neighbours.push(m);
            if m.level >= n.level + 2 { split = true; }
        }
        if !split { continue; }
        index.remove(&n);
        for c in n.children() { index.add(c); queue.push(c); }
        // The new, finer children may now be too fine for a coarse neighbour: check those again.
        queue.extend(neighbours);
        splits += 1;
    }
    splits
}

/// Sets every leaf's stitch bits from the (balanced) leaf set.
pub fn assign_stitches(index: &mut LeafIndex) {
    let nodes = index.values();
    for mut n in nodes {
        let s = node_param_size(n.level);
        let (a0, b0, e) = (-1.0 + n.ia as f64 * s, -1.0 + n.ib as f64 * s, s * PROBE);
        let coarser = |a: f64, b: f64| index.find(n.face as usize, a, b).is_some_and(|m| m.level < n.level);
        let mut bits = 0u8;
        // Edges: the neighbour at the edge's middle (a coarser one covers the whole edge).
        if coarser(a0 + s / 2.0, b0 - e) { bits |= 1 << EDGE_B_MIN; }
        if coarser(a0 + s / 2.0, b0 + s + e) { bits |= 1 << EDGE_B_MAX; }
        if coarser(a0 - e, b0 + s / 2.0) { bits |= 1 << EDGE_A_MIN; }
        if coarser(a0 + s + e, b0 + s / 2.0) { bits |= 1 << EDGE_A_MAX; }
        // Corners: any of the other chunks meeting there.
        let corners = [(a0, b0, -1.0, -1.0), (a0 + s, b0, 1.0, -1.0), (a0, b0 + s, -1.0, 1.0), (a0 + s, b0 + s, 1.0, 1.0)];
        for (k, (ca, cb, da, db)) in corners.into_iter().enumerate() {
            if coarser(ca + da * e, cb - db * e) || coarser(ca - da * e, cb + db * e) || coarser(ca + da * e, cb + db * e) {
                bits |= 1 << (4 + k);
            }
        }
        n.stitch = bits;
        index.add(n);
    }
}

/// The chunks one planet should show for a viewer at `viewer`: a depth-first walk of the six face
/// quadtrees, splitting by distance and skipping whatever is hidden below the horizon (a point on
/// the far side can't be seen past the planet's bulge, even from the top of the highest
/// mountain), then balanced 2:1 and stitched so neighbours share their edges exactly.
pub fn select_chunks(p: &Planet, planet_index: u32, viewer: V3, lod: &LodSettings) -> Selection {
    let mut lk = Lookup::new(Access::Fallback);
    let mut hidden = 0;
    let max_level = p.max_level();
    let mut index = LeafIndex::new(max_level);
    let rel = sub(viewer, p.def.center);
    let rv = length(rel).max(p.def.radius + 0.5);
    let view_dir = normalize(rel);
    let relief = p.max_relief();
    // Angle past which the ground can't be seen: the viewer's horizon over the lowest ground that
    // can block the view, plus how far beyond it a peak of the maximum height still pokes up.
    let lowest = p.lowest_blocking_radius();
    let horizon = (lowest / rv).min(1.0).acos() + (lowest / (lowest + relief)).acos();
    let mut centers: HashMap<ChunkNode, V3> = HashMap::new();

    let mut stack: Vec<ChunkNode> = (0..6).map(|f| ChunkNode::root(planet_index, f)).collect();
    stack.reverse();
    while let Some(n) = stack.pop() {
        let dir = n.center_direction();
        let size = p.level_world_size(n.level);
        let angular_radius = (size * 0.75) / p.def.radius;
        let angle = dot(dir, view_dir).clamp(-1.0, 1.0).acos();
        if angle - angular_radius > horizon { hidden += 1; continue; }
        let center = n.ground_center(p, &mut lk);
        let d = (distance(viewer, center) - size * 0.7).max(0.0);
        if n.level < max_level && (n.level < lod.min_level || d < lod.split_factor * size) {
            let mut kids = n.children();
            kids.reverse();
            stack.extend(kids);
        } else {
            centers.insert(n, center);
            index.add(n);
        }
    }
    let balanced = balance(&mut index);
    assign_stitches(&mut index);
    let leaves = index.values().into_iter().map(|n| {
        let plain = ChunkNode { stitch: 0, ..n };
        let c = centers.get(&plain).copied().unwrap_or_else(|| n.ground_center(p, &mut lk));
        (n, c)
    }).collect();
    Selection { leaves, hidden, balanced }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_face_onto_the_unit_sphere() {
        for face in 0..6 {
            for (a, b) in [(-1.0, -1.0), (0.0, 0.0), (1.0, 0.3), (-0.7, 1.0)] {
                assert!((length(face_direction(face, a, b)) - 1.0).abs() < 1e-12);
            }
        }
        assert!(distance(cube_to_sphere([1.0, 1.0, 1.0]), normalize([1.0, 1.0, 1.0])) < 1e-15);
    }

    #[test]
    fn joins_neighbouring_faces_without_a_seam() {
        // Face 0 (+X) at a = 1 is the same cube edge as face 5 (-Z) at a = -1.
        for b in [-1.0, -0.5, 0.0, 0.8, 1.0] {
            assert!(distance(face_direction(0, 1.0, b), face_direction(5, -1.0, b)) < 1e-12);
        }
    }

    #[test]
    fn carries_neighbour_lookups_across_cube_edges() {
        let (f, a, b) = wrap_face(0, 1.001, 0.25);
        assert_eq!(f, 5);
        assert!((a - (-1.0 + 0.001)).abs() < 1e-2);
        assert!((b - 0.25).abs() < 1e-2);
    }
}

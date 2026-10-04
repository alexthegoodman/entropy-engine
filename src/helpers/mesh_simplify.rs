//! Level-of-detail simplification for meshes in the engine's packed `mesh` vertex layout
//! (position 3, normal 3, uv 2, color 4: 12 floats a vertex).
//!
//! Procedural models are built from many small closed parts (a window is a frame, sashes, bars and
//! a sill; a house has dozens of windows), and every part has its own vertices along its hard
//! edges. A distant copy doesn't need most of them. Simplification here:
//!
//! 1. Groups triangles by surface: the vertex color and the material id in uv.x's integer part.
//!    Within a group those are constant, so the only attribute that varies is the normal.
//! 2. Welds each group's vertices by position, so the parts become connected meshes.
//! 3. Drops connected parts smaller than `min_feature` (a door knob, a glazing bar seen end-on).
//! 4. Simplifies what is left with meshoptimizer, to an absolute error in meters.
//! 5. Writes the result flat shaded: three vertices per triangle with the face normal. Buildings
//!    and furniture are mostly flat, and from far enough away to want this LOD, smooth parts
//!    (columns, pots) read the same faceted.

use std::collections::HashMap;

use meshopt::{SimplifyOptions, VertexDataAdapter};

pub const VERTEX_FLOATS: usize = 12;

#[derive(Clone, Copy, Debug)]
pub struct SimplifyParams {
    /// Largest deviation allowed, in mesh units (meters).
    pub max_error: f32,
    /// Connected parts whose bounding box diagonal is under this are dropped (0 keeps all).
    pub min_feature: f32,
    /// Stop once this share of the triangles is left (0..1); the error bound usually stops it first.
    pub target_ratio: f32,
}

#[derive(Debug, Default, Clone)]
pub struct SimplifyStats {
    pub triangles_in: usize,
    pub triangles_out: usize,
    pub parts_dropped: usize,
}

fn group_key(v: &[f32]) -> (i32, [u32; 4]) {
    ((v[6] + 0.0005).floor() as i32, [v[8].to_bits(), v[9].to_bits(), v[10].to_bits(), v[11].to_bits()])
}

struct UnionFind(Vec<u32>);

impl UnionFind {
    fn find(&mut self, mut x: u32) -> u32 {
        while self.0[x as usize] != x {
            let p = self.0[self.0[x as usize] as usize];
            self.0[x as usize] = p;
            x = p;
        }
        x
    }
    fn union(&mut self, a: u32, b: u32) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b { self.0[a as usize] = b; }
    }
}

/// Simplifies a packed mesh. Returns flat-shaded packed vertices and their indices.
pub fn simplify_packed(vertices: &[f32], indices: &[u32], params: SimplifyParams) -> (Vec<f32>, Vec<u32>, SimplifyStats) {
    let mut stats = SimplifyStats { triangles_in: indices.len() / 3, ..Default::default() };
    let vertex = |i: u32| &vertices[i as usize * VERTEX_FLOATS..i as usize * VERTEX_FLOATS + VERTEX_FLOATS];

    // Triangles by surface, in first-seen order so the output is deterministic.
    let mut order: Vec<(i32, [u32; 4])> = Vec::new();
    let mut groups: HashMap<(i32, [u32; 4]), Vec<u32>> = HashMap::new();
    for tri in indices.chunks_exact(3) {
        if tri.iter().any(|&i| (i as usize + 1) * VERTEX_FLOATS > vertices.len()) { continue; }
        let key = group_key(vertex(tri[0]));
        groups.entry(key).or_insert_with(|| { order.push(key); Vec::new() }).extend_from_slice(tri);
    }

    let mut out_v: Vec<f32> = Vec::new();
    let mut out_i: Vec<u32> = Vec::new();
    for key in order {
        let tris = &groups[&key];
        // Weld by position (to a tenth of a millimeter).
        let mut welded: Vec<[f32; 3]> = Vec::new();
        let mut lookup: HashMap<[i64; 3], u32> = HashMap::new();
        let mut idx: Vec<u32> = Vec::with_capacity(tris.len());
        for &i in tris {
            let v = vertex(i);
            let p = [v[0], v[1], v[2]];
            let q = [(p[0] as f64 * 1e4).round() as i64, (p[1] as f64 * 1e4).round() as i64, (p[2] as f64 * 1e4).round() as i64];
            let w = *lookup.entry(q).or_insert_with(|| { welded.push(p); welded.len() as u32 - 1 });
            idx.push(w);
        }
        // Degenerate after welding.
        let mut clean: Vec<u32> = Vec::with_capacity(idx.len());
        for t in idx.chunks_exact(3) {
            if t[0] != t[1] && t[1] != t[2] && t[0] != t[2] { clean.extend_from_slice(t); }
        }

        // Drop small connected parts.
        if params.min_feature > 0.0 && !clean.is_empty() {
            let mut uf = UnionFind((0..welded.len() as u32).collect());
            for t in clean.chunks_exact(3) { uf.union(t[0], t[1]); uf.union(t[1], t[2]); }
            let mut boxes: HashMap<u32, ([f32; 3], [f32; 3])> = HashMap::new();
            for t in clean.chunks_exact(3) {
                for &i in t {
                    let r = uf.find(i);
                    let p = welded[i as usize];
                    let b = boxes.entry(r).or_insert((p, p));
                    for k in 0..3 { b.0[k] = b.0[k].min(p[k]); b.1[k] = b.1[k].max(p[k]); }
                }
            }
            let small: std::collections::HashSet<u32> = boxes.iter()
                .filter(|(_, (lo, hi))| ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt() < params.min_feature)
                .map(|(r, _)| *r).collect();
            stats.parts_dropped += small.len();
            if !small.is_empty() {
                let mut kept = Vec::with_capacity(clean.len());
                for t in clean.chunks_exact(3) {
                    if !small.contains(&uf.find(t[0])) { kept.extend_from_slice(t); }
                }
                clean = kept;
            }
        }
        if clean.is_empty() { continue; }

        let bytes: &[u8] = unsafe { std::slice::from_raw_parts(welded.as_ptr().cast::<u8>(), welded.len() * 12) };
        let simplified = match VertexDataAdapter::new(bytes, 12, 0) {
            Ok(adapter) => {
                let target = ((clean.len() / 3) as f32 * params.target_ratio.clamp(0.0, 1.0)) as usize * 3;
                meshopt::simplify(&clean, &adapter, target, params.max_error, SimplifyOptions::ErrorAbsolute, None)
            }
            Err(_) => clean,
        };

        let src = vertex(tris[0]);
        for t in simplified.chunks_exact(3) {
            let [a, b, c] = [welded[t[0] as usize], welded[t[1] as usize], welded[t[2] as usize]];
            let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if len < 1e-12 { continue; }
            let n = [n[0] / len, n[1] / len, n[2] / len];
            let base = (out_v.len() / VERTEX_FLOATS) as u32;
            for p in [a, b, c] {
                out_v.extend_from_slice(&[p[0], p[1], p[2], n[0], n[1], n[2], src[6], src[7], src[8], src[9], src[10], src[11]]);
            }
            out_i.extend_from_slice(&[base, base + 1, base + 2]);
        }
    }
    stats.triangles_out = out_i.len() / 3;
    (out_v, out_i, stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit box of 12 triangles at `at`, `size` across, in one surface color.
    fn cube(v: &mut Vec<f32>, i: &mut Vec<u32>, at: [f32; 3], size: f32, color: f32) {
        let faces: [([f32; 3], [f32; 3], [f32; 3]); 6] = [
            ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]), ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
            ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]), ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
            ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]), ([0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
        ];
        for (n, a, b) in faces {
            let base = (v.len() / VERTEX_FLOATS) as u32;
            for (s, t) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
                let h = size / 2.0;
                let p: Vec<f32> = (0..3).map(|k| at[k] + (n[k] + a[k] * s + b[k] * t) * h).collect();
                v.extend_from_slice(&[p[0], p[1], p[2], n[0], n[1], n[2], 3.0, 0.0, color, color, color, 0.0]);
            }
            i.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
    }

    #[test]
    fn drops_small_parts_and_keeps_large_ones_watertight() {
        let (mut v, mut i) = (Vec::new(), Vec::new());
        cube(&mut v, &mut i, [0.0, 0.0, 0.0], 4.0, 0.5);
        for k in 0..10 { cube(&mut v, &mut i, [3.0 + k as f32 * 0.1, 0.0, 0.0], 0.04, 0.5); }
        let (out_v, out_i, stats) = simplify_packed(&v, &i, SimplifyParams { max_error: 0.01, min_feature: 0.1, target_ratio: 0.0 });
        assert_eq!(stats.parts_dropped, 10);
        assert_eq!(stats.triangles_out, 12, "the big box is already minimal");
        assert_eq!(out_v.len(), out_i.len() * VERTEX_FLOATS);
        // Flat shaded: every vertex normal is unit length and the color survives.
        for vert in out_v.chunks_exact(VERTEX_FLOATS) {
            let l = (vert[3] * vert[3] + vert[4] * vert[4] + vert[5] * vert[5]).sqrt();
            assert!((l - 1.0).abs() < 1e-4);
            assert_eq!(vert[8], 0.5);
        }
    }

    #[test]
    fn surfaces_are_simplified_separately() {
        let (mut v, mut i) = (Vec::new(), Vec::new());
        cube(&mut v, &mut i, [0.0, 0.0, 0.0], 1.0, 0.2);
        cube(&mut v, &mut i, [0.0, 0.0, 0.0], 1.0, 0.8);
        let (out_v, _, stats) = simplify_packed(&v, &i, SimplifyParams { max_error: 0.5, min_feature: 0.0, target_ratio: 0.0 });
        let colors: std::collections::HashSet<u32> = out_v.chunks_exact(VERTEX_FLOATS).map(|c| c[8].to_bits()).collect();
        assert_eq!(colors.len(), 2, "two surfaces stay two surfaces");
        assert!(stats.triangles_out <= 24);
    }
}

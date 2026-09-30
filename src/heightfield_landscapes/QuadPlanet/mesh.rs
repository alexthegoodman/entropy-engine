//! Chunk meshes: a grid on the sphere displaced by the terrain, with biome vertex colors, in the
//! engine's `Vertex` layout. See quadtree.rs for the crack-prevention rules the borders follow.

use std::collections::HashMap;

use super::elevation::{Access, Lookup};
use super::math::*;
use super::planet::{Planet, SurfaceSample, CHUNK_SEGMENTS};
use super::quadtree::{face_direction, node_param_size, ChunkNode, EDGE_A_MAX, EDGE_A_MIN, EDGE_B_MAX, EDGE_B_MIN};

/// Floats per vertex: position(3) normal(3) uv(2) color(4) - the engine's `Vertex` layout.
pub const VERTEX_FLOATS: usize = 12;

/// Material ids carried in uv.x, read by the shader.
pub const MATERIAL_LAND: u32 = 0;
pub const MATERIAL_WATER: u32 = 1;
pub const MATERIAL_ICE: u32 = 2;

/// An integer id plus a [0, 1] fraction in one float: id + 0.001 + 0.99 x fraction. The shader
/// reads the id as floor(x + 0.0005), so exact integers (the models' materials) decode too.
pub fn pack_chunk_uv(id: u32, fraction: f64) -> f32 {
    (id as f64 + 0.001 + 0.99 * fraction.clamp(0.0, 1.0)) as f32
}

/// Positions are snapped to this grid (1/1024 m) before being made relative to a chunk's origin,
/// and origins (and the renderer's origin) lie on it too. Within 16 km of the origin every such
/// offset is exact in f32 and so is the GPU's sum `position + (origin - renderOrigin)`: two chunks
/// sharing a border vertex put it at bit-identical render positions.
pub const POSITION_QUANTUM: f64 = 1.0 / 1024.0;
pub fn quantize(x: f64) -> f64 { (x / POSITION_QUANTUM).round() * POSITION_QUANTUM }
pub fn quantize3(v: V3) -> V3 { [quantize(v[0]), quantize(v[1]), quantize(v[2])] }

pub struct ChunkMesh {
    /// Vertex positions are relative to `origin`.
    pub vertex_data: Vec<f32>,
    pub index_data: Vec<u32>,
    pub vertex_count: usize,
    pub triangles: usize,
    /// World-space center of the chunk's surface.
    pub center: V3,
    /// World-space anchor the vertex positions are relative to (on the position grid).
    pub origin: V3,
}

fn material(p: &Planet, s: &SurfaceSample) -> u32 {
    if s.sea { if p.def.frozen_sea { MATERIAL_ICE } else { MATERIAL_WATER } } else { MATERIAL_LAND }
}

fn push_vertex(out: &mut Vec<f32>, world: V3, origin: V3, normal: V3, u: f32, v: f32, c: [f64; 4]) {
    out.extend_from_slice(&[
        (quantize(world[0]) - origin[0]) as f32, (quantize(world[1]) - origin[1]) as f32, (quantize(world[2]) - origin[2]) as f32,
        normal[0] as f32, normal[1] as f32, normal[2] as f32,
        u, v,
        c[0] as f32, c[1] as f32, c[2] as f32, c[3] as f32,
    ]);
}

/// Builds one chunk. Interior vertices are sampled at the chunk's own band limit with normals
/// from their grid neighbours; border vertices at the coarsest band limit of the chunks meeting
/// there, with normals computed from the surface itself, so neighbours agree on them exactly.
/// Returns `None` when elevation data it needs is still loading (see elevation.rs, `Gate`).
pub fn build_chunk(p: &Planet, n: &ChunkNode) -> Option<ChunkMesh> {
    let mut lk = Lookup::new(Access::Gate);
    let vertices = p.chunk_vertices(n.level);
    let mesh = if vertices == CHUNK_SEGMENTS + 1 { build_uniform(p, n, CHUNK_SEGMENTS, &mut lk) } else { build_variable(p, n, CHUNK_SEGMENTS, vertices, &mut lk) };
    if lk.missing { None } else { Some(mesh) }
}

/// Band limit at a border vertex, shared by the uniform and variable grid builders.
fn border_band(i: u32, j: u32, n: u32, stitch: u8, spacing: f64) -> f64 {
    let bit = if i == 0 && j == 0 { 4 }
        else if i == n && j == 0 { 5 }
        else if i == 0 && j == n { 6 }
        else if i == n && j == n { 7 }
        else if j == 0 { EDGE_B_MIN }
        else if j == n { EDGE_B_MAX }
        else if i == 0 { EDGE_A_MIN }
        else if i == n { EDGE_A_MAX }
        else { return spacing };
    if (stitch >> bit) & 1 == 1 { spacing * 2.0 } else { spacing }
}

/// The mesh when interior and border resolutions match: an (N+1)^2 grid.
fn build_uniform(p: &Planet, n: &ChunkNode, segments: u32, lk: &mut Lookup) -> ChunkMesh {
    let nn = segments;
    let v = (nn + 1) as usize;
    let size = node_param_size(n.level);
    let a0 = -1.0 + n.ia as f64 * size;
    let b0 = -1.0 + n.ib as f64 * size;
    let step = size / nn as f64;
    let stitch = n.stitch;
    let bit = |k: u32| (stitch >> k) & 1 == 1;
    // This chunk's grid spacing in world units: the terrain is sampled band-limited to it.
    let spacing = p.level_spacing(n.level);
    // An odd vertex on a stitched edge isn't part of the mesh: the coarse neighbour has none there.
    let skipped = |i: u32, j: u32| -> bool {
        (j == 0 && i % 2 == 1 && bit(EDGE_B_MIN)) || (j == nn && i % 2 == 1 && bit(EDGE_B_MAX))
            || (i == 0 && j % 2 == 1 && bit(EDGE_A_MIN)) || (i == nn && j % 2 == 1 && bit(EDGE_A_MAX))
    };
    let count = v * v;
    let mut pos: Vec<Option<V3>> = vec![None; count];
    let mut dirs: Vec<V3> = vec![[0.0; 3]; count];
    let mut bands = vec![0.0; count];
    let mut samples = vec![SurfaceSample::default(); count];
    for j in 0..=nn {
        for i in 0..=nn {
            let k = j as usize * v + i as usize;
            // Exact binary fractions: a shared point is the same number in every chunk.
            let d = face_direction(n.face as usize, a0 + i as f64 * step, b0 + j as f64 * step);
            dirs[k] = d;
            if skipped(i, j) { continue; }
            let band = border_band(i, j, nn, stitch, spacing);
            let s = p.sample(d, band, lk);
            bands[k] = band;
            samples[k] = s;
            pos[k] = Some(add_scaled(p.def.center, d, p.def.radius + s.surface));
        }
    }
    // Skipped vertices sit on the straight coarse edge (they only feed their neighbours' normals).
    for j in 0..=nn {
        for i in 0..=nn {
            let k = j as usize * v + i as usize;
            if pos[k].is_some() { continue; }
            let (ka, kb) = if j == 0 || j == nn { (k - 1, k + 1) } else { (k - v, k + v) };
            pos[k] = Some(scale(add(pos[ka].unwrap(), pos[kb].unwrap()), 0.5));
            samples[k] = samples[ka];
            bands[k] = bands[ka];
        }
    }
    let pos: Vec<V3> = pos.into_iter().map(Option::unwrap).collect();

    let mut vertex_data = Vec::with_capacity(count * VERTEX_FLOATS);
    let mid = (v / 2) * v + v / 2;
    let origin = quantize3(pos[mid]);
    for j in 0..=nn {
        for i in 0..=nn {
            let k = j as usize * v + i as usize;
            let d = dirs[k];
            let s = samples[k];
            let border = i == 0 || j == 0 || i == nn || j == nn;
            let normal = if s.sea { d } // the sea is flat: shade it with the sphere's normal
                else if border { p.surface_normal(d, bands[k], bands[k], lk) }
                else {
                    let m = normalize(cross(sub(pos[k + 1], pos[k - 1]), sub(pos[k + v], pos[k - v])));
                    if dot(m, d) < 0.0 { scale(m, -1.0) } else { m }
                };
            let c = p.color(&s, dot(normal, d), d, bands[k]);
            // uv carries (material + u, level + v): the integer parts are the material id and the
            // quadtree level, the fractions the chunk-local grid position (for the LOD debug view).
            push_vertex(&mut vertex_data, pos[k], origin, normal,
                pack_chunk_uv(material(p, &s), i as f64 / nn as f64), pack_chunk_uv(n.level, j as f64 / nn as f64), c);
        }
    }

    // Triangulate each 2x2 block of quads as a fan around its (odd, odd) center vertex, walking
    // the block's rim counter-clockwise (seen from outside). A rim midpoint on a stitched edge is
    // left out, so that side becomes one triangle spanning exactly the coarse neighbour's edge.
    let mut index_data = Vec::new();
    const RIM: [(i32, i32); 8] = [(-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0)];
    let mut ring = Vec::with_capacity(8);
    for cj in (1..nn).step_by(2) {
        for ci in (1..nn).step_by(2) {
            ring.clear();
            for (di, dj) in RIM {
                let (i, j) = ((ci as i32 + di) as u32, (cj as i32 + dj) as u32);
                if skipped(i, j) { continue; }
                ring.push((j as usize * v + i as usize) as u32);
            }
            let c = (cj as usize * v + ci as usize) as u32;
            for r in 0..ring.len() { index_data.extend_from_slice(&[c, ring[r], ring[(r + 1) % ring.len()]]); }
        }
    }
    let triangles = index_data.len() / 3;
    ChunkMesh { vertex_data, index_data, vertex_count: count, triangles, center: pos[mid], origin }
}

/// Builds only the configured interior and the used border vertices, joined by four triangle
/// strips.
fn build_variable(p: &Planet, n: &ChunkNode, edge_segments: u32, vertices: u32, lk: &mut Lookup) -> ChunkMesh {
    let mut vertex_data: Vec<f32> = Vec::new();
    let mut index_data: Vec<u32> = Vec::new();
    let nn = vertices - 1;
    let inner_width = (vertices - 2) as usize;
    let size = node_param_size(n.level);
    let spacing = p.level_world_size(n.level) / nn as f64;
    let border_spacing = p.level_spacing(n.level);
    let a0 = -1.0 + n.ia as f64 * size;
    let b0 = -1.0 + n.ib as f64 * size;
    let center_dir = face_direction(n.face as usize, a0 + size / 2.0, b0 + size / 2.0);
    let center = add_scaled(p.def.center, center_dir, p.def.radius + p.sample(center_dir, border_spacing, lk).surface);
    let origin = quantize3(center);
    // The interior-resolution grid including its outer ring: the ring is never drawn (the border
    // vertices are), it only gives the outermost interior vertices neighbours, so every interior
    // normal comes from central differences on the grid.
    let v = (nn + 1) as usize;
    let mut grid_pos = vec![[0.0; 3]; v * v];
    let mut grid_dir = vec![[0.0; 3]; v * v];
    let mut grid_sample = vec![SurfaceSample::default(); v * v];
    for j in 0..v {
        for i in 0..v {
            let k = j * v + i;
            let d = face_direction(n.face as usize, -1.0 + (n.ia as f64 + i as f64 / nn as f64) * size, -1.0 + (n.ib as f64 + j as f64 / nn as f64) * size);
            let s = p.sample(d, spacing, lk);
            grid_dir[k] = d;
            grid_sample[k] = s;
            grid_pos[k] = add_scaled(p.def.center, d, p.def.radius + s.surface);
        }
    }
    let mut inner: Vec<Vec<u32>> = Vec::with_capacity(inner_width);
    for j in 1..nn as usize {
        let mut row = Vec::with_capacity(inner_width);
        for i in 1..nn as usize {
            let k = j * v + i;
            let (d, s) = (grid_dir[k], grid_sample[k]);
            let mut normal = d;
            if !s.sea {
                normal = normalize(cross(sub(grid_pos[k + 1], grid_pos[k - 1]), sub(grid_pos[k + v], grid_pos[k - v])));
                if dot(normal, d) < 0.0 { normal = scale(normal, -1.0); }
            }
            let c = p.color(&s, dot(normal, d), d, spacing);
            row.push((vertex_data.len() / VERTEX_FLOATS) as u32);
            push_vertex(&mut vertex_data, grid_pos[k], origin, normal,
                pack_chunk_uv(material(p, &s), i as f64 / nn as f64), pack_chunk_uv(n.level, j as f64 / nn as f64), c);
        }
        inner.push(row);
    }
    for j in 0..inner_width.saturating_sub(1) {
        for i in 0..inner_width - 1 {
            let (a, b, c, d) = (inner[j][i], inner[j][i + 1], inner[j + 1][i + 1], inner[j + 1][i]);
            index_data.extend_from_slice(&[a, b, c, a, c, d]);
        }
    }
    let edge_step = size / edge_segments as f64;
    let es = edge_segments;
    let mut border_ids: HashMap<u32, u32> = HashMap::new();
    let mut border_vertex = |i: u32, j: u32, vertex_data: &mut Vec<f32>, lk: &mut Lookup| -> u32 {
        let key = j * (es + 1) + i;
        if let Some(id) = border_ids.get(&key) { return *id; }
        // The same arithmetic and band limit as the uniform grid, so shared borders stay
        // bit-identical.
        let d = face_direction(n.face as usize, a0 + i as f64 * edge_step, b0 + j as f64 * edge_step);
        let band = border_band(i, j, es, n.stitch, border_spacing);
        let s = p.sample(d, band, lk);
        let pos = add_scaled(p.def.center, d, p.def.radius + s.surface);
        let normal = if s.sea { d } else { p.surface_normal(d, band, band, lk) };
        let c = p.color(&s, dot(normal, d), d, band);
        let id = (vertex_data.len() / VERTEX_FLOATS) as u32;
        push_vertex(vertex_data, pos, origin, normal, pack_chunk_uv(material(p, &s), i as f64 / es as f64), pack_chunk_uv(n.level, j as f64 / es as f64), c);
        border_ids.insert(key, id);
        id
    };
    let last = inner_width - 1;
    let sides: [(u32, Vec<u32>); 4] = [
        (EDGE_B_MIN, inner[0].clone()),
        (EDGE_A_MAX, inner.iter().map(|r| r[last]).collect()),
        (EDGE_B_MAX, inner[last].iter().rev().copied().collect()),
        (EDGE_A_MIN, inner.iter().map(|r| r[0]).rev().collect()),
    ];
    for (side, (bit, inner_side)) in sides.iter().enumerate() {
        let stride = if (n.stitch >> bit) & 1 == 1 { 2 } else { 1 };
        let outer: Vec<u32> = (0..=es / stride).map(|k| {
            let k = k * stride;
            let (i, j) = match side { 0 => (k, 0), 1 => (es, k), 2 => (es - k, es), _ => (0, es - k) };
            border_vertex(i, j, &mut vertex_data, lk)
        }).collect();
        let (mut a, mut b) = (0usize, 0usize);
        while a < outer.len() - 1 || b < inner_width - 1 {
            if a < outer.len() - 1 && (b == inner_width - 1 || ((a + 1) * stride as usize) as f64 / es as f64 <= (b + 2) as f64 / nn as f64) {
                index_data.extend_from_slice(&[outer[a], outer[a + 1], inner_side[b]]);
                a += 1;
            } else {
                index_data.extend_from_slice(&[outer[a], inner_side[b + 1], inner_side[b]]);
                b += 1;
            }
        }
    }
    let vertex_count = vertex_data.len() / VERTEX_FLOATS;
    let triangles = index_data.len() / 3;
    ChunkMesh { vertex_data, index_data, vertex_count, triangles, center, origin }
}

/// Rough triangle count of a chunk at a level (for the triangle budget).
pub fn estimated_triangles(p: &Planet, level: u32) -> usize {
    let v = p.chunk_vertices(level) as usize;
    if v == CHUNK_SEGMENTS as usize + 1 { 2 * (v - 1) * (v - 1) } else { 2 * (v - 3) * (v - 3) + 4 * (v + CHUNK_SEGMENTS as usize) }
}

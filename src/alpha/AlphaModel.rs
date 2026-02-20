use crate::alpha::{AlphaRenderer, Meshlet};
use crate::core::vertex::ModelVertex;
use nalgebra::Vector3;
use gltf::Glb;
use gltf::Gltf;
use std::collections::{HashMap, HashSet, VecDeque, BinaryHeap};
use std::cmp::Ordering;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum triangles per meshlet (hardware-friendly, fits in 64-entry LDS).
const MAX_MESHLET_TRIS: usize = 64;
/// Maximum unique vertices per meshlet (fits in 64-entry vertex cache).
const MAX_MESHLET_VERTS: usize = 64;

// ---------------------------------------------------------------------------
// Public model type
// ---------------------------------------------------------------------------

pub struct AlphaModel {
    pub meshlets: Vec<Meshlet>,
    pub mesh_index: u32,
}

impl AlphaModel {
    // -----------------------------------------------------------------------
    // GLB entry point
    // -----------------------------------------------------------------------

    pub fn from_glb(renderer: &mut AlphaRenderer, bytes: &[u8]) -> Self {
        let glb = Glb::from_slice(bytes).expect("Couldn't create GLB from slice");
        let gltf = Gltf::from_slice(&glb.json).expect("Failed to parse GLTF JSON");
        let buffer_data = glb
            .bin
            .as_ref()
            .expect("No binary data found in GLB file");

        let mut all_vertices: Vec<ModelVertex> = Vec::new();
        let mut all_indices: Vec<u32> = Vec::new();
        let mut meshlets: Vec<Meshlet> = Vec::new();

        // Global offsets into the renderer's buffers *before* this model.
        let global_v_offset =
            (renderer.current_vertex_offset / std::mem::size_of::<ModelVertex>() as u64) as u32;
        let global_i_offset = (renderer.current_index_offset / 4) as u32;

        for mesh in gltf.meshes() {
            for primitive in mesh.primitives() {
                let reader = primitive.reader(|_buffer| Some(buffer_data.as_ref()));

                // Collect positions first so we know v_count without consuming.
                let positions: Vec<[f32; 3]> =
                    reader.read_positions().unwrap().collect();
                let v_count = positions.len();

                let normals: Vec<[f32; 3]> = reader
                    .read_normals()
                    .map(|it| it.collect())
                    .unwrap_or_else(|| vec![[0.0, 0.0, 1.0]; v_count]);

                let tex_coords: Vec<[f32; 2]> = reader
                    .read_tex_coords(0)
                    .map(|it| it.into_f32().collect())
                    .unwrap_or_else(|| vec![[0.0, 0.0]; v_count]);

                let colors: Vec<[f32; 4]> = reader
                    .read_colors(0)
                    .map(|it| it.into_rgba_f32().collect())
                    .unwrap_or_else(|| vec![[1.0, 1.0, 1.0, 1.0]; v_count]);

                let prim_vertices: Vec<ModelVertex> = (0..v_count)
                    .map(|i| ModelVertex {
                        position: positions[i],
                        normal: normals[i],
                        tex_coords: tex_coords[i],
                        color: colors[i],
                        joint_indices: [0, 0, 0, 0],
                        joint_weights: [0.0, 0.0, 0.0, 0.0],
                    })
                    .collect();

                let prim_indices: Vec<u32> = reader
                    .read_indices()
                    .map(|it| it.into_u32().collect())
                    .unwrap_or_default();

                if prim_indices.is_empty() || prim_vertices.is_empty() {
                    continue;
                }

                // base_v_idx: where these primitive's vertices start in the
                // *combined* all_vertices buffer (local accumulation).
                let base_v_idx = all_vertices.len() as u32;

                let (prim_meshlets, prim_out_indices) = Self::partition_and_simplify(
                    &prim_vertices,
                    &prim_indices,
                    global_v_offset + base_v_idx,
                    global_i_offset + all_indices.len() as u32,
                );

                all_vertices.extend(prim_vertices);
                all_indices.extend(prim_out_indices);
                meshlets.extend(prim_meshlets);
            }
        }

        let mesh_index = renderer.upload_mesh(&all_vertices, &all_indices, &meshlets);
        AlphaModel { meshlets, mesh_index }
    }

    // -----------------------------------------------------------------------
    // Geometry entry point (unit tests / procedural geometry)
    // -----------------------------------------------------------------------

    pub fn from_geometry(
        renderer: &mut AlphaRenderer,
        vertices: &[ModelVertex],
        indices: &[u32],
    ) -> Self {
        let global_v_offset =
            (renderer.current_vertex_offset / std::mem::size_of::<ModelVertex>() as u64) as u32;
        let global_i_offset = (renderer.current_index_offset / 4) as u32;

        let (meshlets, out_indices) =
            Self::partition_and_simplify(vertices, indices, global_v_offset, global_i_offset);

        let mesh_index = renderer.upload_mesh(vertices, &out_indices, &meshlets);
        AlphaModel { meshlets, mesh_index }
    }

    // -----------------------------------------------------------------------
    // Core: partition → simplify → emit meshlets
    //
    // All index values written into out_indices and Meshlet::index_offset are
    // in *global* GPU buffer space.  The caller provides the two offsets that
    // convert from local (primitive-relative) space.
    // -----------------------------------------------------------------------

    fn partition_and_simplify(
        vertices: &[ModelVertex],
        indices: &[u32],
        global_v_offset: u32,   // add to every vertex index before writing
        global_i_start: u32,    // first index slot in the GPU index buffer
    ) -> (Vec<Meshlet>, Vec<u32>) {
        let tri_count = indices.len() / 3;
        if tri_count == 0 {
            return (Vec::new(), Vec::new());
        }

        // ------------------------------------------------------------------
        // Step 1 – Build adjacency: edge → triangles
        // ------------------------------------------------------------------
        let mut edge_to_tris: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
        for t in 0..tri_count {
            for j in 0..3 {
                let v0 = indices[t * 3 + j];
                let v1 = indices[t * 3 + (j + 1) % 3];
                let edge = edge_key(v0, v1);
                edge_to_tris.entry(edge).or_default().push(t);
            }
        }

        // ------------------------------------------------------------------
        // Step 2 – BFS meshlet partitioning
        //
        // Constraint: each meshlet stays within MAX_MESHLET_TRIS triangles
        // AND MAX_MESHLET_VERTS unique vertices (GPU amplification limit).
        // ------------------------------------------------------------------
        let mut tri_assigned = vec![false; tri_count];
        // meshlet_id that each triangle belongs to (for boundary detection).
        let mut tri_to_meshlet: Vec<usize> = vec![usize::MAX; tri_count];

        let mut meshlet_tri_groups: Vec<Vec<usize>> = Vec::new();

        for start_tri in 0..tri_count {
            if tri_assigned[start_tri] {
                continue;
            }

            let mut meshlet_tris: Vec<usize> = Vec::new();
            let mut meshlet_verts: HashSet<u32> = HashSet::new();
            let mut queue: VecDeque<usize> = VecDeque::new();

            tri_assigned[start_tri] = true;
            queue.push_back(start_tri);

            'bfs: while let Some(t) = queue.pop_front() {
                // Check vertex budget before committing this triangle.
                let new_verts: Vec<u32> = (0..3)
                    .map(|j| indices[t * 3 + j])
                    .filter(|v| !meshlet_verts.contains(v))
                    .collect();

                if meshlet_verts.len() + new_verts.len() > MAX_MESHLET_VERTS {
                    // Kick this triangle to a new meshlet — unmark so it
                    // becomes a seed later.
                    tri_assigned[t] = false;
                    continue 'bfs;
                }

                let mid = meshlet_tri_groups.len(); // index of current meshlet
                meshlet_tris.push(t);
                tri_to_meshlet[t] = mid;
                for v in &new_verts {
                    meshlet_verts.insert(*v);
                }

                if meshlet_tris.len() >= MAX_MESHLET_TRIS {
                    break 'bfs;
                }

                // Enqueue adjacent triangles (shared edge).
                for j in 0..3 {
                    let v0 = indices[t * 3 + j];
                    let v1 = indices[t * 3 + (j + 1) % 3];
                    if let Some(neighbors) = edge_to_tris.get(&edge_key(v0, v1)) {
                        for &nb in neighbors {
                            if !tri_assigned[nb] {
                                tri_assigned[nb] = true;
                                queue.push_back(nb);
                            }
                        }
                    }
                }
            }

            if !meshlet_tris.is_empty() {
                meshlet_tri_groups.push(meshlet_tris);
            }
        }

        // ------------------------------------------------------------------
        // Step 3 – Identify boundary vertices
        //
        // A vertex is a boundary vertex if it is shared by triangles that
        // belong to *different* meshlets.  These must never be collapsed —
        // they are the shared seam that prevents cracks.
        // ------------------------------------------------------------------
        let mut vertex_meshlets: HashMap<u32, usize> = HashMap::new(); // first meshlet seen
        let mut boundary_vertices: HashSet<u32> = HashSet::new();

        for (mid, tris) in meshlet_tri_groups.iter().enumerate() {
            for &t in tris {
                for j in 0..3 {
                    let v = indices[t * 3 + j];
                    match vertex_meshlets.get(&v) {
                        None => {
                            vertex_meshlets.insert(v, mid);
                        }
                        Some(&first_mid) if first_mid != mid => {
                            boundary_vertices.insert(v);
                        }
                        _ => {}
                    }
                }
            }
        }

        // Also lock any vertex that sits on a mesh boundary edge (edge
        // referenced by exactly one triangle — open boundary of the mesh).
        for (edge, tris) in &edge_to_tris {
            if tris.len() == 1 {
                boundary_vertices.insert(edge.0);
                boundary_vertices.insert(edge.1);
            }
        }

        // ------------------------------------------------------------------
        // Step 4 – Per-meshlet QEM simplification with locked boundaries,
        //           then emit Meshlet descriptors.
        // ------------------------------------------------------------------
        let mut out_meshlets: Vec<Meshlet> = Vec::new();
        let mut out_indices: Vec<u32> = Vec::new();

        for tris in meshlet_tri_groups {
            let local_indices: Vec<u32> = tris
                .iter()
                .flat_map(|&t| [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]])
                .collect();

            // Target: halve the triangle count, never touching boundaries.
            let simplified = qem_simplify(vertices, &local_indices, &boundary_vertices, 0.5);

            // Compute bounding sphere for GPU frustum/occlusion culling.
            let (center, radius) = compute_bounding_sphere(vertices, &simplified);

            // LOD error: max position delta introduced by simplification.
            let lod_error = compute_simplification_error(vertices, &local_indices, &simplified);

            // Remap indices into global GPU vertex buffer space.
            let global_simplified: Vec<u32> = simplified
                .iter()
                .map(|&v| v + global_v_offset)
                .collect();

            let meshlet = Meshlet {
                vertex_offset: global_v_offset as f32,
                index_offset: (global_i_start + out_indices.len() as u32) as f32,
                index_count: global_simplified.len() as f32,
                radius,
                center: [center.x, center.y, center.z],
                lod_error,
                parent_error: f32::MAX, // filled in by LOD hierarchy builder
                _padding: [0.0; 3],
            };

            out_meshlets.push(meshlet);
            out_indices.extend(global_simplified);
        }

        (out_meshlets, out_indices)
    }
}

// ---------------------------------------------------------------------------
// QEM (Quadric Error Metric) edge-collapse simplification
//
// Only non-boundary edges are considered for collapse.  Boundary vertex
// positions are never modified, which is the crack-sealing guarantee.
// ---------------------------------------------------------------------------

/// Symmetric 4×4 quadric stored as the 10 unique upper-triangle entries.
#[derive(Clone, Copy, Default)]
struct Quadric([f64; 10]);

impl Quadric {
    fn from_plane(a: f64, b: f64, c: f64, d: f64) -> Self {
        Quadric([
            a*a, a*b, a*c, a*d,
                 b*b, b*c, b*d,
                      c*c, c*d,
                           d*d,
        ])
    }

    fn add(&self, other: &Quadric) -> Quadric {
        let mut q = Quadric::default();
        for i in 0..10 { q.0[i] = self.0[i] + other.0[i]; }
        q
    }

    /// Evaluate Q(v) = vᵀ Q v  for homogeneous point [x,y,z,1].
    fn evaluate(&self, p: [f32; 3]) -> f64 {
        let (x, y, z) = (p[0] as f64, p[1] as f64, p[2] as f64);
        let q = &self.0;
        q[0]*x*x + 2.0*q[1]*x*y + 2.0*q[2]*x*z + 2.0*q[3]*x
                 +     q[4]*y*y + 2.0*q[5]*y*z + 2.0*q[6]*y
                                +     q[7]*z*z + 2.0*q[8]*z
                                               +     q[9]
    }

    /// Try to find the optimal contraction point by solving the 3×3 linear
    /// system.  Falls back to the edge midpoint on failure.
    fn optimal_point(&self, v0: [f32; 3], v1: [f32; 3]) -> [f32; 3] {
        let q = &self.0;
        // Top-left 3×3 of the quadric (the curvature part).
        let a = [
            [q[0], q[1], q[2]],
            [q[1], q[4], q[5]],
            [q[2], q[5], q[7]],
        ];
        let b = [-q[3], -q[6], -q[8]];

        if let Some(sol) = solve_3x3(a, b) {
            [sol[0] as f32, sol[1] as f32, sol[2] as f32]
        } else {
            // Degenerate: use midpoint.
            [
                (v0[0] + v1[0]) * 0.5,
                (v0[1] + v1[1]) * 0.5,
                (v0[2] + v1[2]) * 0.5,
            ]
        }
    }
}

/// Cramer's rule 3×3 solver.  Returns None if the matrix is singular.
fn solve_3x3(a: [[f64; 3]; 3], b: [f64; 3]) -> Option<[f64; 3]> {
    let det = a[0][0]*(a[1][1]*a[2][2] - a[1][2]*a[2][1])
            - a[0][1]*(a[1][0]*a[2][2] - a[1][2]*a[2][0])
            + a[0][2]*(a[1][0]*a[2][1] - a[1][1]*a[2][0]);
    if det.abs() < 1e-12 { return None; }
    let inv = 1.0 / det;

    let x = inv * (b[0]*(a[1][1]*a[2][2]-a[1][2]*a[2][1])
                 - a[0][1]*(b[1]*a[2][2]-a[1][2]*b[2])
                 + a[0][2]*(b[1]*a[2][1]-a[1][1]*b[2]));
    let y = inv * (a[0][0]*(b[1]*a[2][2]-a[1][2]*b[2])
                 - b[0]*(a[1][0]*a[2][2]-a[1][2]*a[2][0])
                 + a[0][2]*(a[1][0]*b[2]-b[1]*a[2][0]));
    let z = inv * (a[0][0]*(a[1][1]*b[2]-b[1]*a[2][1])
                 - a[0][1]*(a[1][0]*b[2]-b[1]*a[2][0])
                 + b[0]*(a[1][0]*a[2][1]-a[1][1]*a[2][0]));

    Some([x, y, z])
}

/// Candidate edge collapse, ordered by error (min-heap).
#[derive(PartialEq)]
struct CollapseCandidate {
    error: ordered_float::NotNan<f64>,
    v0: u32,
    v1: u32,
    target: [f32; 3],
}

impl Eq for CollapseCandidate {}
impl PartialOrd for CollapseCandidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) }
}
impl Ord for CollapseCandidate {
    // Reverse for min-heap (BinaryHeap is max by default).
    fn cmp(&self, other: &Self) -> Ordering {
        other.error.cmp(&self.error)
    }
}

/// QEM simplification that never moves boundary vertices.
/// `target_ratio` ∈ (0,1]: fraction of triangles to keep.
fn qem_simplify(
    vertices: &[ModelVertex],
    indices: &[u32],
    boundary: &HashSet<u32>,
    target_ratio: f32,
) -> Vec<u32> {
    if indices.len() < 6 {
        return indices.to_vec(); // Nothing to simplify.
    }

    let target_tris = ((indices.len() / 3) as f32 * target_ratio).ceil() as usize;

    // --- Build per-vertex quadric as sum of face planes ---
    let mut quadrics: HashMap<u32, Quadric> = HashMap::new();
    let tri_count = indices.len() / 3;
    for t in 0..tri_count {
        let [i0, i1, i2] = [indices[t*3], indices[t*3+1], indices[t*3+2]];
        let p0 = v3(vertices[i0 as usize].position);
        let p1 = v3(vertices[i1 as usize].position);
        let p2 = v3(vertices[i2 as usize].position);

        let n = (p1 - p0).cross(&(p2 - p0));
        let len = n.norm();
        if len < 1e-10 { continue; } // Degenerate triangle.
        let n = n / len;
        let d = -n.dot(&p0);
        let q = Quadric::from_plane(n.x as f64, n.y as f64, n.z as f64, d as f64);

        for &v in &[i0, i1, i2] {
            quadrics.entry(v).or_default().0.iter_mut()
                .zip(q.0.iter())
                .for_each(|(a, b)| *a += b);
        }
    }

    // --- Mutable index list and live/merged vertex tracking ---
    let mut current: Vec<[u32; 3]> = (0..tri_count)
        .map(|t| [indices[t*3], indices[t*3+1], indices[t*3+2]])
        .collect();

    // Union-find: collapsed vertices point to their replacement.
    let max_v = *indices.iter().max().unwrap_or(&0) as usize + 1;
    let mut remap: Vec<u32> = (0..max_v as u32).collect();
    let mut positions: Vec<[f32; 3]> = (0..max_v)
        .map(|i| {
            if i < vertices.len() { vertices[i].position }
            else { [0.0; 3] }
        })
        .collect();

    let find = |remap: &Vec<u32>, mut v: u32| -> u32 {
        while remap[v as usize] != v { v = remap[v as usize]; }
        v
    };

    // --- Build initial candidate heap ---
    let mut heap: BinaryHeap<CollapseCandidate> = BinaryHeap::new();

    let mut seen_edges: HashSet<(u32, u32)> = HashSet::new();
    for t in 0..tri_count {
        for j in 0..3 {
            let v0 = indices[t * 3 + j];
            let v1 = indices[t * 3 + (j + 1) % 3];
            let ek = edge_key(v0, v1);
            if seen_edges.insert(ek) {
                push_candidate(&quadrics, &positions, boundary, v0, v1, &mut heap);
            }
        }
    }

    // --- Greedy collapse loop ---
    let mut alive_tris = tri_count;

    while alive_tris > target_tris {
        let Some(cand) = heap.pop() else { break };

        let rv0 = find(&remap, cand.v0);
        let rv1 = find(&remap, cand.v1);
        if rv0 == rv1 { continue; } // Already merged.

        // Stale entry check: recompute expected error.
        let q_combined = quadrics.get(&rv0).copied().unwrap_or_default()
            .add(&quadrics.get(&rv1).copied().unwrap_or_default());
        let expected_err = q_combined.evaluate(cand.target);
        if (expected_err - *cand.error).abs() > 1e-6 * expected_err.abs().max(1.0) {
            // Stale — reinsert with correct error.
            push_candidate(&quadrics, &positions, boundary, rv0, rv1, &mut heap);
            continue;
        }

        // Collapse rv1 → rv0.
        remap[rv1 as usize] = rv0;
        positions[rv0 as usize] = cand.target;
        *quadrics.entry(rv0).or_default() = q_combined;
        quadrics.remove(&rv1);

        // Remove degenerate triangles and count collapses.
        for tri in current.iter_mut() {
            tri[0] = find(&remap, tri[0]);
            tri[1] = find(&remap, tri[1]);
            tri[2] = find(&remap, tri[2]);
        }
        let before = alive_tris;
        current.retain(|tri| tri[0] != tri[1] && tri[1] != tri[2] && tri[0] != tri[2]);
        alive_tris = current.len();
        if alive_tris == before {
            // Collapse didn't remove any tris — keep going but avoid infinite loop.
            alive_tris = alive_tris.saturating_sub(1);
        }

        // Push new candidates for edges adjacent to rv0.
        let neighbours: Vec<u32> = current
            .iter()
            .filter_map(|tri| {
                if tri[0] == rv0 || tri[1] == rv0 || tri[2] == rv0 {
                    Some(*tri)
                } else {
                    None
                }
            })
            .flat_map(|tri| tri.into_iter())
            .filter(|&v| v != rv0)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        for nb in neighbours {
            push_candidate(&quadrics, &positions, boundary, rv0, nb, &mut heap);
        }
    }

    // Emit flattened index buffer with updated positions respected.
    // Note: we keep the original vertex index space (rv = remapped id);
    // the actual position change is handled by the GPU or a final
    // vertex-buffer update step.  For now we output the remapped indices
    // so degenerate tris are gone.
    let result: Vec<u32> = current.iter().flat_map(|tri| tri.iter().copied()).collect();

    if result.is_empty() { indices.to_vec() } else { result }
}

/// Push a collapse candidate onto the heap if neither vertex is a boundary.
fn push_candidate(
    quadrics: &HashMap<u32, Quadric>,
    positions: &[[f32; 3]],
    boundary: &HashSet<u32>,
    v0: u32,
    v1: u32,
    heap: &mut BinaryHeap<CollapseCandidate>,
) {
    // Never collapse an edge that touches a boundary vertex.
    if boundary.contains(&v0) || boundary.contains(&v1) {
        return;
    }

    let q0 = quadrics.get(&v0).copied().unwrap_or_default();
    let q1 = quadrics.get(&v1).copied().unwrap_or_default();
    let combined = q0.add(&q1);
    let target = combined.optimal_point(positions[v0 as usize], positions[v1 as usize]);
    let error = combined.evaluate(target);

    if let Ok(nn_error) = ordered_float::NotNan::new(error) {
        heap.push(CollapseCandidate { error: nn_error, v0, v1, target });
    }
}

// ---------------------------------------------------------------------------
// Geometry utilities
// ---------------------------------------------------------------------------

/// Compute a tight bounding sphere via Ritter's algorithm.
fn compute_bounding_sphere(vertices: &[ModelVertex], indices: &[u32]) -> (Vector3<f32>, f32) {
    if indices.is_empty() {
        return (Vector3::zeros(), 0.0);
    }

    let pts: Vec<Vector3<f32>> = indices
        .iter()
        .map(|&i| v3(vertices[i as usize].position))
        .collect();

    // Pick a starting point and find the farthest from it.
    let p0 = pts[0];
    let p1 = *pts.iter().max_by(|a, b| {
        (*a - p0).norm_squared().partial_cmp(&(*b - p0).norm_squared()).unwrap()
    }).unwrap();
    let p2 = *pts.iter().max_by(|a, b| {
        (*a - p1).norm_squared().partial_cmp(&(*b - p1).norm_squared()).unwrap()
    }).unwrap();

    let mut center = (p1 + p2) * 0.5;
    let mut radius = (p2 - p1).norm() * 0.5;

    // Expand to cover all points.
    for p in &pts {
        let d = (p - center).norm();
        if d > radius {
            let excess = (d - radius) * 0.5;
            radius += excess;
            center += (p - center).normalize() * excess;
        }
    }

    (center, radius.max(1e-5))
}

/// Max distance between any vertex's old and new position after simplification.
/// Used as the meshlet's LOD geometric error bound.
fn compute_simplification_error(
    vertices: &[ModelVertex],
    original: &[u32],
    simplified: &[u32],
) -> f32 {
    // Build the simplified vertex set for O(1) lookup.
    let simplified_set: HashSet<u32> = simplified.iter().copied().collect();
    let original_set: HashSet<u32> = original.iter().copied().collect();

    // Vertices that were present in the original but not in the simplified
    // mesh have been collapsed.  Their "error" is the distance to the nearest
    // surviving vertex (a conservative bound).
    let mut max_err = 0.0_f32;
    for &ov in &original_set {
        if !simplified_set.contains(&ov) {
            let op = v3(vertices[ov as usize].position);
            let nearest = simplified_set
                .iter()
                .map(|&sv| (v3(vertices[sv as usize].position) - op).norm())
                .fold(f32::MAX, f32::min);
            max_err = max_err.max(nearest);
        }
    }
    max_err
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

#[inline]
fn edge_key(v0: u32, v1: u32) -> (u32, u32) {
    if v0 < v1 { (v0, v1) } else { (v1, v0) }
}

#[inline]
fn v3(p: [f32; 3]) -> Vector3<f32> {
    Vector3::new(p[0], p[1], p[2])
}
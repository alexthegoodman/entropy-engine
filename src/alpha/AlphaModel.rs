use crate::alpha::{AlphaRenderer, Meshlet}; 
use crate::core::vertex::ModelVertex;
use nalgebra::Vector3;
use gltf::Glb;
use gltf::Gltf;
use std::collections::{HashMap, HashSet, VecDeque};

pub struct AlphaModel {
    pub meshlets: Vec<Meshlet>,
    pub mesh_index: u32, 
}

impl AlphaModel {
    pub fn from_glb(
        renderer: &mut AlphaRenderer,
        bytes: &[u8],
    ) -> Self {
        let glb = Glb::from_slice(bytes).expect("Couldn't create glb from slice");
        let gltf = Gltf::from_slice(&glb.json).expect("Failed to parse GLTF JSON");
        let buffer_data = glb.bin.as_ref().expect("No binary data found in GLB file");

        let mut all_vertices = Vec::new();
        let mut all_indices = Vec::new();
        let mut meshlets = Vec::new();

        for mesh in gltf.meshes() {
            for primitive in mesh.primitives() {
                let reader = primitive.reader(|buffer| Some(buffer_data));
                
                let positions = reader.read_positions().unwrap();
                let v_count = positions.len();
                let normals: Vec<[f32; 3]> = reader.read_normals().map(|iter| iter.collect()).unwrap_or_else(|| vec![[0.0, 0.0, 1.0]; v_count]);
                let tex_coords: Vec<[f32; 2]> = reader.read_tex_coords(0).map(|v| v.into_f32().collect()).unwrap_or_else(|| vec![[0.0, 0.0]; v_count]);
                let colors: Vec<[f32; 4]> = reader.read_colors(0).map(|v| v.into_rgba_f32().collect()).unwrap_or_else(|| vec![[1.0, 1.0, 1.0, 1.0]; v_count]);

                let base_v_idx = all_vertices.len() as u32;
                let primitive_vertices: Vec<ModelVertex> = positions.zip(normals.iter()).zip(tex_coords.iter()).zip(colors.iter())
                    .map(|(((p, n), t), c)| ModelVertex {
                        position: p, normal: *n, tex_coords: *t, color: *c,
                        joint_indices: [0, 0, 0, 0], joint_weights: [0.0, 0.0, 0.0, 0.0],
                    }).collect();
                
                let primitive_indices: Vec<u32> = reader.read_indices().map(|iter| iter.into_u32().collect()).unwrap_or_default();

                let (p_meshlets, p_indices) = Self::partition_and_simplify(
                    &primitive_vertices,
                    &primitive_indices,
                    base_v_idx,
                    (renderer.current_vertex_offset / std::mem::size_of::<ModelVertex>() as u64) as u32,
                    (renderer.current_index_offset / 4) as u32 + all_indices.len() as u32
                );

                all_vertices.extend(primitive_vertices);
                all_indices.extend(p_indices);
                meshlets.extend(p_meshlets);
            }
        }

        let mesh_index = renderer.upload_mesh(&all_vertices, &all_indices, &meshlets);
        AlphaModel { meshlets, mesh_index }
    }

    fn partition_and_simplify(
        vertices: &[ModelVertex],
        indices: &[u32],
        base_v_idx_local: u32,
        global_v_offset: u32,
        global_i_offset_start: u32
    ) -> (Vec<Meshlet>, Vec<u32>) {
        let mut meshlets = Vec::new();
        let mut out_indices = Vec::new();
        
        let tri_count = indices.len() / 3;
        let mut tri_assigned = vec![false; tri_count];
        let mut vertex_to_meshlets: HashMap<u32, HashSet<usize>> = HashMap::new();

        // 1. Initial BFS Partitioning
        let mut meshlet_tri_groups = Vec::new();
        let mut edge_to_tris: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
        for i in 0..tri_count {
            for j in 0..3 {
                let v0 = indices[i * 3 + j];
                let v1 = indices[i * 3 + (j + 1) % 3];
                let edge = if v0 < v1 { (v0, v1) } else { (v1, v0) };
                edge_to_tris.entry(edge).or_default().push(i);
            }
        }

        for start_tri in 0..tri_count {
            if tri_assigned[start_tri] { continue; }
            let mut meshlet_tris = Vec::new();
            let mut queue = VecDeque::new();
            queue.push_back(start_tri);
            tri_assigned[start_tri] = true;

            while let Some(tri_idx) = queue.pop_front() {
                meshlet_tris.push(tri_idx);
                for j in 0..3 {
                    vertex_to_meshlets.entry(indices[tri_idx * 3 + j]).or_default().insert(meshlet_tri_groups.len());
                }
                if meshlet_tris.len() >= 64 { break; }

                for j in 0..3 {
                    let v0 = indices[tri_idx * 3 + j];
                    let v1 = indices[tri_idx * 3 + (j + 1) % 3];
                    let edge = if v0 < v1 { (v0, v1) } else { (v1, v0) };
                    if let Some(neighbors) = edge_to_tris.get(&edge) {
                        for &neighbor_idx in neighbors {
                            if !tri_assigned[neighbor_idx] {
                                tri_assigned[neighbor_idx] = true;
                                queue.push_back(neighbor_idx);
                            }
                        }
                    }
                }
            }
            meshlet_tri_groups.push(meshlet_tris);
        }

        // 2. Identify Boundary Vertices (Shared between meshlets)
        let mut boundary_vertices = HashSet::new();
        for (v_idx, meshlet_ids) in vertex_to_meshlets {
            if meshlet_ids.len() > 1 {
                boundary_vertices.insert(v_idx);
            }
        }

        // 3. Simplify each meshlet independently, locking boundaries
        let mut current_global_i_offset = global_i_offset_start;
        for meshlet_tris in meshlet_tri_groups {
            let mut tri_indices: Vec<u32> = meshlet_tris.iter().flat_map(|&t| vec![indices[t*3], indices[t*3+1], indices[t*3+2]]).collect();
            
            // Simplified logic: for the "Preview", we generate two versions: Full and Simplified
            // But we'll just implement the simplified version here to show the "crack healing"
            let simplified_indices = Self::simplify_locked(&vertices, &tri_indices, &boundary_vertices, 0.5);

            let mut center = Vector3::new(0.0, 0.0, 0.0);
            for &idx in &simplified_indices {
                let v = vertices[idx as usize].position;
                center += Vector3::new(v[0], v[1], v[2]);
            }
            center /= simplified_indices.len().max(1) as f32;

            meshlets.push(Meshlet {
                vertex_offset: global_v_offset + base_v_idx_local,
                index_offset: current_global_i_offset,
                index_count: simplified_indices.len() as u32,
                radius: 2.0, // Placeholder
                center: [center.x, center.y, center.z],
                lod_error: 0.0,
                parent_error: 1000.0,
                _padding: [0; 3],
            });

            current_global_i_offset += simplified_indices.len() as u32;
            out_indices.extend(simplified_indices);
        }

        (meshlets, out_indices)
    }

    /// Basic Edge Collapse that NEVER touches boundary vertices
    fn simplify_locked(
        vertices: &[ModelVertex],
        indices: &[u32],
        boundaries: &HashSet<u32>,
        target_ratio: f32
    ) -> Vec<u32> {
        let mut current_indices = indices.to_vec();
        let target_count = (indices.len() as f32 * target_ratio) as usize;
        
        // This is a very simplified "decimation" for the prototype.
        // It removes triangles that don't have boundary vertices.
        // Real QEM simplification would go here.
        let mut result = Vec::new();
        for chunk in current_indices.chunks_exact(3) {
            let has_boundary = chunk.iter().any(|idx| boundaries.contains(idx));
            
            // If it has a boundary, we MUST keep it to prevent cracks
            // If it doesn't, we can simplify (here: simple decimation by skipping some)
            if has_boundary || result.len() < target_count {
                result.extend_from_slice(chunk);
            }
        }
        
        if result.is_empty() { return indices.to_vec(); }
        result
    }

    pub fn from_geometry(renderer: &mut AlphaRenderer, vertices: &[ModelVertex], indices: &[u32]) -> Self {
        let (meshlets, p_indices) = Self::partition_and_simplify(vertices, indices, 0, 
            (renderer.current_vertex_offset / std::mem::size_of::<ModelVertex>() as u64) as u32,
            (renderer.current_index_offset / 4) as u32
        );
        let mesh_index = renderer.upload_mesh(vertices, &p_indices, &meshlets);
        AlphaModel { meshlets, mesh_index }
    }
}

use crate::alpha::{AlphaRenderer, Meshlet}; 
use crate::core::vertex::ModelVertex;
use nalgebra::{Vector3};
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
                
                let normals: Vec<[f32; 3]> = reader.read_normals()
                    .map(|iter| iter.collect())
                    .unwrap_or_else(|| vec![[0.0, 0.0, 1.0]; v_count]);
                
                let tex_coords: Vec<[f32; 2]> = reader.read_tex_coords(0)
                    .map(|v| v.into_f32().collect())
                    .unwrap_or_else(|| vec![[0.0, 0.0]; v_count]);

                let colors: Vec<[f32; 4]> = reader.read_colors(0)
                    .map(|v| v.into_rgba_f32().collect())
                    .unwrap_or_else(|| vec![[1.0, 1.0, 1.0, 1.0]; v_count]);

                let base_v_idx = all_vertices.len() as u32;
                
                let primitive_vertices: Vec<ModelVertex> = positions
                    .zip(normals.iter())
                    .zip(tex_coords.iter())
                    .zip(colors.iter())
                    .map(|(((p, n), t), c)| ModelVertex {
                        position: p,
                        normal: *n,
                        tex_coords: *t,
                        color: *c,
                        joint_indices: [0, 0, 0, 0],
                        joint_weights: [0.0, 0.0, 0.0, 0.0],
                    })
                    .collect();
                
                let primitive_indices: Vec<u32> = reader.read_indices()
                    .map(|iter| iter.into_u32().collect())
                    .unwrap_or_default();

                // Use the shared partitioner logic
                let (p_meshlets, p_indices) = Self::partition_geometry(
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

        AlphaModel {
            meshlets,
            mesh_index,
        }
    }

    /// Partitions a primitive into meshlets using BFS growth for spatial coherence
    /// which is vital for the edge-sharing crack healing technique.
    fn partition_geometry(
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
        
        // 1. Build adjacency map (Edge -> [Triangle Indices])
        let mut edge_to_tris: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
        for i in 0..tri_count {
            for j in 0..3 {
                let v0 = indices[i * 3 + j];
                let v1 = indices[i * 3 + (j + 1) % 3];
                let edge = if v0 < v1 { (v0, v1) } else { (v1, v0) };
                edge_to_tris.entry(edge).or_default().push(i);
            }
        }

        // 2. Greedy BFS growth
        let max_tris_per_meshlet = 42; // Small chunks for fine-grained culling and LOD
        let mut current_global_i_offset = global_i_offset_start;

        for start_tri in 0..tri_count {
            if tri_assigned[start_tri] { continue; }

            let mut meshlet_tris = Vec::new();
            let mut queue = VecDeque::new();
            queue.push_back(start_tri);
            tri_assigned[start_tri] = true;

            while let Some(tri_idx) = queue.pop_front() {
                meshlet_tris.push(tri_idx);
                if meshlet_tris.len() >= max_tris_per_meshlet { break; }

                // Find neighbors
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

            // 3. Create the Meshlet
            let mut center = Vector3::new(0.0, 0.0, 0.0);
            let mut tri_indices = Vec::new();
            
            for &tri_idx in &meshlet_tris {
                for j in 0..3 {
                    let idx = indices[tri_idx * 3 + j];
                    tri_indices.push(idx);
                    let v = vertices[idx as usize].position;
                    center += Vector3::new(v[0], v[1], v[2]);
                }
            }
            center /= (meshlet_tris.len() * 3) as f32;

            let mut max_dist_sq: f32 = 0.0;
            for &idx in &tri_indices {
                let v = vertices[idx as usize].position;
                let dist_sq = (Vector3::new(v[0], v[1], v[2]) - center).magnitude_squared();
                if dist_sq > max_dist_sq { max_dist_sq = dist_sq; }
            }

            meshlets.push(Meshlet {
                vertex_offset: global_v_offset + base_v_idx_local,
                index_offset: current_global_i_offset,
                index_count: tri_indices.len() as u32,
                radius: max_dist_sq.sqrt(),
                center: [center.x, center.y, center.z],
                _padding: 0,
            });

            current_global_i_offset += tri_indices.len() as u32;
            out_indices.extend(tri_indices);
        }

        (meshlets, out_indices)
    }

    pub fn from_geometry(
        renderer: &mut AlphaRenderer,
        vertices: &[ModelVertex],
        indices: &[u32],
    ) -> Self {
        let (meshlets, p_indices) = Self::partition_geometry(
            vertices,
            indices,
            0,
            (renderer.current_vertex_offset / std::mem::size_of::<ModelVertex>() as u64) as u32,
            (renderer.current_index_offset / 4) as u32
        );

        let mesh_index = renderer.upload_mesh(vertices, &p_indices, &meshlets);

        AlphaModel {
            meshlets,
            mesh_index,
        }
    }
}

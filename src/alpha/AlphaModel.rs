use crate::alpha::{AlphaRenderer, Meshlet, AlphaInstanceData}; 
use crate::core::vertex::ModelVertex;
use nalgebra::{Vector3, Matrix4, Isometry3, UnitQuaternion, Quaternion};
use gltf::Glb;
use gltf::Gltf;

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
                
                all_vertices.extend(primitive_vertices);

                let primitive_indices: Vec<u32> = reader.read_indices()
                    .map(|iter| iter.into_u32().collect())
                    .unwrap_or_default();

                // Generate meshlets for this primitive
                const MAX_INDICES_PER_MESHLET: usize = 126;
                let v_offset = (renderer.current_vertex_offset / std::mem::size_of::<ModelVertex>() as u64) as u32 + base_v_idx;
                let i_offset_base = (renderer.current_index_offset / 4) as u32 + all_indices.len() as u32;

                for chunk in primitive_indices.chunks(MAX_INDICES_PER_MESHLET) {
                    let mut center = Vector3::new(0.0, 0.0, 0.0);
                    for &idx in chunk {
                        let v = all_vertices[(base_v_idx + idx) as usize].position;
                        center += Vector3::new(v[0], v[1], v[2]);
                    }
                    center /= chunk.len() as f32;

                    let mut max_dist_sq: f32 = 0.0;
                    for &idx in chunk {
                        let v = all_vertices[(base_v_idx + idx) as usize].position;
                        let dist_sq = (Vector3::new(v[0], v[1], v[2]) - center).magnitude_squared();
                        if dist_sq > max_dist_sq {
                            max_dist_sq = dist_sq;
                        }
                    }

                    meshlets.push(Meshlet {
                        vertex_offset: v_offset,
                        index_offset: i_offset_base + (all_indices.len() as u32 - (i_offset_base - ((renderer.current_index_offset / 4) as u32))),
                        index_count: chunk.len() as u32,
                        radius: max_dist_sq.sqrt(),
                        center: [center.x, center.y, center.z],
                        _padding: 0,
                    });
                    
                    // Actually we need to fix the index_offset logic here...
                    // Let's just use a simple running counter.
                }
                
                // Redo index_offset logic for clarity
                let mut current_mesh_i_offset = i_offset_base;
                // Wait, meshlets are collected across all primitives. 
                // Let's just fix it at the end.

                all_indices.extend(primitive_indices);
            }
        }

        // Finalize meshlet offsets
        let v_offset_global = (renderer.current_vertex_offset / std::mem::size_of::<ModelVertex>() as u64) as u32;
        let mut i_offset_running = (renderer.current_index_offset / 4) as u32;
        for m in &mut meshlets {
            m.index_offset = i_offset_running;
            i_offset_running += m.index_count;
        }

        let mesh_index = renderer.upload_mesh(&all_vertices, &all_indices, &meshlets);

        AlphaModel {
            meshlets,
            mesh_index,
        }
    }

    pub fn from_geometry(
        renderer: &mut AlphaRenderer,
        vertices: &[ModelVertex],
        indices: &[u32],
    ) -> Self {
        let mut meshlets = Vec::new();
        const MAX_INDICES_PER_MESHLET: usize = 126;
        
        for chunk in indices.chunks(MAX_INDICES_PER_MESHLET) {
            let mut center = Vector3::new(0.0, 0.0, 0.0);
            for &idx in chunk {
                let v = vertices[idx as usize].position;
                center += Vector3::new(v[0], v[1], v[2]);
            }
            center /= chunk.len() as f32;

            let mut max_dist_sq: f32 = 0.0;
            for &idx in chunk {
                let v = vertices[idx as usize].position;
                let dist_sq = (Vector3::new(v[0], v[1], v[2]) - center).magnitude_squared();
                if dist_sq > max_dist_sq {
                    max_dist_sq = dist_sq;
                }
            }

            meshlets.push(Meshlet {
                vertex_offset: 0,
                index_offset: 0,
                index_count: chunk.len() as u32,
                radius: max_dist_sq.sqrt(),
                center: [center.x, center.y, center.z],
                _padding: 0,
            });
        }

        let v_offset = (renderer.current_vertex_offset / std::mem::size_of::<ModelVertex>() as u64) as u32;
        let mut i_offset = (renderer.current_index_offset / 4) as u32;

        for m in &mut meshlets {
            m.vertex_offset = v_offset;
            m.index_offset = i_offset;
            i_offset += m.index_count;
        }

        let mesh_index = renderer.upload_mesh(vertices, indices, &meshlets);

        AlphaModel {
            meshlets,
            mesh_index,
        }
    }
}

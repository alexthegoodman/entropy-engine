use crate::alpha::{AlphaRenderer, Meshlet, AlphaInstanceData}; 
use crate::core::vertex::ModelVertex;
use nalgebra::Vector3;

pub struct AlphaModel {
    pub meshlets: Vec<Meshlet>,
    pub mesh_index: u32, 
}

impl AlphaModel {
    pub fn from_geometry(
        renderer: &mut AlphaRenderer,
        vertices: &[ModelVertex],
        indices: &[u32],
    ) -> Self {
        let mut meshlets = Vec::new();
        
        // Simple partition: we group indices into chunks.
        // In a real Nanite-like system, we would group by proximity.
        const MAX_INDICES_PER_MESHLET: usize = 126; // Must be multiple of 3
        
        for chunk in indices.chunks(MAX_INDICES_PER_MESHLET) {
            // Calculate bounding sphere
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
                vertex_offset: 0, // In this simple version, all vertices are uploaded together
                index_offset: 0, // Will be set during upload if needed, or relative
                index_count: chunk.len() as u32,
                radius: max_dist_sq.sqrt(),
                center: [center.x, center.y, center.z],
                _padding: 0,
            });
        }

        // We need to store the global offsets in the meshlets before uploading
        let v_offset = (renderer.current_vertex_offset / std::mem::size_of::<ModelVertex>() as u64) as u32;
        let i_offset = (renderer.current_index_offset / 4) as u32;

        let mut current_chunk_i_offset = i_offset;
        for m in &mut meshlets {
            m.vertex_offset = v_offset;
            m.index_offset = current_chunk_i_offset;
            current_chunk_i_offset += m.index_count;
        }

        let mesh_index = renderer.upload_mesh(vertices, indices, &meshlets);

        AlphaModel {
            meshlets,
            mesh_index,
        }
    }
}

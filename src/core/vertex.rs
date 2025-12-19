use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct Vertex {
    pub position: [f32; 3],   // x, y, z coordinates
    pub normal: [f32; 3],
    pub tex_coords: [f32; 2], // u, v coordinates
    pub color: [f32; 4],
}

// Ensure Vertex is Pod and Zeroable
unsafe impl Pod for Vertex {}
unsafe impl Zeroable for Vertex {}

/// seems that -0.0001 is closer to surface than -0.0002 so layer provided needs
/// to be smaller without being negative to be on top
pub fn get_z_layer(layer: f32) -> f32 {
    // let z = (layer as f32 / 1000.0) - 2.5;
    let z = layer as f32 / 1000.0;
    z
}

impl Vertex {
    pub fn new(x: f32, y: f32, z: f32, color: [f32; 4]) -> Self {
        Vertex {
            position: [x, y, z],
            normal: [0.0, 0.0, 0.0],
            tex_coords: [0.0, 0.0], // Default UV coordinates
            color,
        }
    }

    const ATTRIBS: [wgpu::VertexAttribute; 4] =
        wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Float32x4];

    pub fn desc<'a>() -> wgpu::VertexBufferLayout<'a> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &Self::ATTRIBS,
        }
    }
}

// Model vertices
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct ModelVertex {
    pub position: [f32; 3],   // x, y, z coordinates
    pub normal: [f32; 3],
    pub tex_coords: [f32; 2], // u, v coordinates
    pub color: [f32; 4],
    pub joint_indices: [u16; 4],
    pub joint_weights: [f32; 4],
}

// Ensure Vertex is Pod and Zeroable
unsafe impl Pod for ModelVertex {}
unsafe impl Zeroable for ModelVertex {}

impl ModelVertex {
    pub fn new(x: f32, y: f32, z: f32, color: [f32; 4]) -> Self {
        ModelVertex {
            position: [x, y, z],
            normal: [0.0, 0.0, 0.0],
            tex_coords: [0.0, 0.0], // Default UV coordinates
            color,
            joint_indices: [0, 0, 0, 0],
            joint_weights: [0.0, 0.0, 0.0, 0.0],
        }
    }

    const ATTRIBS: [wgpu::VertexAttribute; 6] =
        wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Float32x4, 4 => Uint16x4, 5 => Float32x4];

    pub fn desc<'a>() -> wgpu::VertexBufferLayout<'a> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<ModelVertex>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &Self::ATTRIBS,
        }
    }
}

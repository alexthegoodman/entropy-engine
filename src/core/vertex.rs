use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct Vertex {
    pub position: [f32; 3],   // x, y, z coordinates
    pub normal: [f32; 3],
    pub tex_coords: [f32; 2], // u, v coordinates
    // color: [f32; 3],      // RGB color
    // pub color: wgpu::Color, // RGBA color
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

// pub fn get_z_layer(layer: f32) -> f32 {
//     // Adjust this value to control the depth range
//     const Z_SCALE: f32 = 0.01;

//     // Calculate Z based on layer, with higher layers having higher Z values
//     Z_SCALE * layer
// }

// #[repr(C)]
// #[derive(Copy, Clone, Debug)]
// pub struct Vertex {
//     pub position: [f32; 3],
//     pub normal: [f32; 3],
//     pub tex_coords: [f32; 2],
//     pub color: [f32; 3],
// }

// // Ensure Vertex is Pod and Zeroable
// unsafe impl Pod for Vertex {}
// unsafe impl Zeroable for Vertex {}

// impl Vertex {
//     const ATTRIBS: [wgpu::VertexAttribute; 4] =
//         wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Float32x3];

//     pub fn desc<'a>() -> wgpu::VertexBufferLayout<'a> {
//         wgpu::VertexBufferLayout {
//             array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
//             step_mode: wgpu::VertexStepMode::Vertex,
//             attributes: &Self::ATTRIBS,
//         }
//     }
// }

impl Vertex {
    pub fn new(x: f32, y: f32, z: f32, color: [f32; 4]) -> Self {
        // the lower the layer, the higher in stack
        // let z = -(layer as f32 / 1000.0); // provide layer as 1, 2, etc but adjust z position minutely
        Vertex {
            position: [x, y, z],
            normal: [0.0, 0.0, 0.0],
            tex_coords: [0.0, 0.0], // Default UV coordinates
            color,
        }
    }
}

impl Vertex {
    pub fn desc<'a>() -> wgpu::VertexBufferLayout<'a> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0, // Corresponds to layout(location = 0) in shader
                    format: wgpu::VertexFormat::Float32x3, // x3 for position
                },
                wgpu::VertexAttribute {
                    offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                    shader_location: 1, // Corresponds to layout(location = 1) in shader
                    format: wgpu::VertexFormat::Float32x2, // x2 for uv
                },
                wgpu::VertexAttribute {
                    offset: std::mem::size_of::<[f32; 6]>() as wgpu::BufferAddress,
                    shader_location: 2, // Corresponds to layout(location = 1) in shader
                    format: wgpu::VertexFormat::Float32x2, // x2 for uv
                },
                wgpu::VertexAttribute {
                    offset: std::mem::size_of::<[f32; 8]>() as wgpu::BufferAddress,
                    shader_location: 3, // Corresponds to layout(location = 2) in shader
                    format: wgpu::VertexFormat::Float32x4, // x4 for color
                },
            ],
        }
    }
}

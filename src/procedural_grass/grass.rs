// use wgpu::util::DeviceExt;
// use crate::core::{SimpleCamera::SimpleCamera, vertex::Vertex};
// use crate::heightfield_landscapes::Landscape::Landscape;
// use nalgebra::{Matrix4, Vector3, Point3};

// // #[repr(C)]
// // #[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
// // pub struct GrassUniforms {
// //     time: f32,
// //     _padding: u32, // WGPU requires 16-byte alignment for struct members
// //     player_pos: [f32; 3],
// // }

// #[repr(C)]
// #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
// struct GrassUniforms {
//     time: f32,
//     _padding: [f32; 3],
//     player_pos: [f32; 4],  // x, y, z, and unused w
// }

// // The data for a single instance of a grass blade
// #[repr(C)]
// #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
// pub struct InstanceRaw {
//    pub model: [[f32; 4]; 4],
// }

// impl InstanceRaw {
//     pub fn desc<'a>() -> wgpu::VertexBufferLayout<'a> {
//         use std::mem;
//         wgpu::VertexBufferLayout {
//             array_stride: mem::size_of::<InstanceRaw>() as wgpu::BufferAddress,
//             // We need to switch from using a step mode of Vertex to Instance
//             // This means that our shaders will only change to use the next
//             // instance when the shader starts processing a new instance
//             step_mode: wgpu::VertexStepMode::Instance,
//             attributes: &[
//                 // A mat4 takes up 4 vertex slots as it is technically 4 vec4s. We need to define a slot
//                 // for each vec4. We'll have to reassemble the mat4 in the shader.
//                 wgpu::VertexAttribute {
//                     offset: 0,
//                     // While our vertex shader only uses locations 0, and 1 now, in later tutorials we'll
//                     // be using 2, 3, and 4, for Vertex. We'll start at slot 5 not to conflict with them later
//                     shader_location: 5,
//                     format: wgpu::VertexFormat::Float32x4,
//                 },
//                 wgpu::VertexAttribute {
//                     offset: mem::size_of::<[f32; 4]>() as wgpu::BufferAddress,
//                     shader_location: 6,
//                     format: wgpu::VertexFormat::Float32x4,
//                 },
//                 wgpu::VertexAttribute {
//                     offset: mem::size_of::<[f32; 8]>() as wgpu::BufferAddress,
//                     shader_location: 7,
//                     format: wgpu::VertexFormat::Float32x4,
//                 },
//                 wgpu::VertexAttribute {
//                     offset: mem::size_of::<[f32; 12]>() as wgpu::BufferAddress,
//                     shader_location: 8,
//                     format: wgpu::VertexFormat::Float32x4,
//                 },
//             ],
//         }
//     }
// }


// // A single blade of grass mesh
// pub struct GrassBlade {
//     pub vertex_buffer: wgpu::Buffer,
//     pub index_buffer: wgpu::Buffer,
//     pub index_count: u32,
// }

// impl GrassBlade {
//     pub fn new(device: &wgpu::Device) -> Self {
//         // A simple quad for a grass blade
//         let vertices: &[Vertex] = &[
//             Vertex { position: [-0.1, 0.0, 0.0], tex_coords: [0.0, 1.0], normal: [0.0, 1.0, 0.0], color: [1.0,1.0,1.0,1.0] }, // Bottom left
//             Vertex { position: [ 0.1, 0.0, 0.0], tex_coords: [1.0, 1.0], normal: [0.0, 1.0, 0.0], color: [1.0,1.0,1.0,1.0] }, // Bottom right
//             Vertex { position: [ 0.1, 2.5, 0.0], tex_coords: [1.0, 0.0], normal: [0.0, 1.0, 0.0], color: [1.0,1.0,1.0,1.0] }, // Top right
//             Vertex { position: [-0.1, 2.5, 0.0], tex_coords: [0.0, 0.0], normal: [0.0, 1.0, 0.0], color: [1.0,1.0,1.0,1.0] }, // Top left
//         ];

//         let indices: &[u16] = &[
//             0, 1, 2,
//             0, 2, 3,
//         ];

//         let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
//             label: Some("Grass Blade Vertex Buffer"),
//             contents: bytemuck::cast_slice(vertices),
//             usage: wgpu::BufferUsages::VERTEX,
//         });

//         let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
//             label: Some("Grass Blade Index Buffer"),
//             contents: bytemuck::cast_slice(indices),
//             usage: wgpu::BufferUsages::INDEX,
//         });

//         Self {
//             vertex_buffer,
//             index_buffer,
//             index_count: indices.len() as u32,
//         }
//     }
// }


// // Represents a patch of grass
// pub struct Grass {
//     pub blade: GrassBlade,
//     pub instance_buffer: wgpu::Buffer,
//     pub instance_count: u32,
//     pub render_pipeline: wgpu::RenderPipeline,
//     pub uniform_buffer: wgpu::Buffer,
//     pub uniform_bind_group: wgpu::BindGroup,
// }

// impl Grass {
//     pub fn new(
//         device: &wgpu::Device,
//         camera_bind_group_layout: &wgpu::BindGroupLayout,
//         landscape: &Landscape,
//         count: u32
//     ) -> Self {

//         let blade = GrassBlade::new(device);

//         // -- Uniforms --
//         let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
//             label: Some("Grass Uniform Buffer"),
//             size: std::mem::size_of::<GrassUniforms>() as wgpu::BufferAddress,
//             usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
//             mapped_at_creation: false,
//         });

//         let uniform_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
//             entries: &[wgpu::BindGroupLayoutEntry {
//                 binding: 0,
//                 visibility: wgpu::ShaderStages::VERTEX,
//                 ty: wgpu::BindingType::Buffer {
//                     ty: wgpu::BufferBindingType::Uniform,
//                     has_dynamic_offset: false,
//                     min_binding_size: None,
//                 },
//                 count: None,
//             }],
//             label: Some("grass_uniform_bind_group_layout"),
//         });

//         let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
//             layout: &uniform_bind_group_layout,
//             entries: &[wgpu::BindGroupEntry {
//                 binding: 0,
//                 resource: uniform_buffer.as_entire_binding(),
//             }],
//             label: Some("grass_uniform_bind_group"),
//         });
//         // -- End Uniforms --

//         // Placeholder instance data
//         let instances = (0..count).map(|_| {
//             let position = Vector3::new(0.0, 0.0, 0.0);
//             let rotation = Matrix4::identity();
//             let model_matrix = Matrix4::new_translation(&position) * rotation;
//             InstanceRaw {
//                 model: model_matrix.into()
//             }
//         }).collect::<Vec<_>>();

//         let instance_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
//             label: Some("Grass Instance Buffer"),
//             contents: bytemuck::cast_slice(&instances),
//             usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
//         });
        
//         // Shaders
//         let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
//             label: Some("Grass Shader"),
//             source: wgpu::ShaderSource::Wgsl(include_str!("grass.wgsl").into()),
//         });

//         // Render Pipeline
//         let render_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
//             label: Some("Grass Render Pipeline Layout"),
//             bind_group_layouts: &[
//                 camera_bind_group_layout,
//                 &uniform_bind_group_layout, // new bind group for grass uniforms
//             ],
//             push_constant_ranges: &[],
//         });

//         let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
//             label: Some("Grass Render Pipeline"),
//             layout: Some(&render_pipeline_layout),
//             vertex: wgpu::VertexState {
//                 module: &shader,
//                 entry_point: Some("vs_main"),
//                 buffers: &[Vertex::desc(), InstanceRaw::desc()], // crucial step for instancing
//                 compilation_options: Default::default(),
//             },
//             fragment: Some(wgpu::FragmentState {
//                 module: &shader,
//                 entry_point: Some("fs_main"),
//                 targets: &[Some(wgpu::ColorTargetState {
//                     format: wgpu::TextureFormat::Rgba8Unorm, // This should match your surface/target format
//                     blend: Some(wgpu::BlendState::ALPHA_BLENDING),
//                     write_mask: wgpu::ColorWrites::ALL,
//                 })],
//                 compilation_options: Default::default(),
//             }),
//             primitive: wgpu::PrimitiveState {
//                 topology: wgpu::PrimitiveTopology::TriangleList,
//                 strip_index_format: None,
//                 front_face: wgpu::FrontFace::Ccw,
//                 cull_mode: None, // No backface culling for grass
//                 ..Default::default()
//             },
//             depth_stencil: Some(wgpu::DepthStencilState {
//                 format: wgpu::TextureFormat::Depth24Plus,
//                 depth_write_enabled: true,
//                 depth_compare: wgpu::CompareFunction::Less,
//                 stencil: wgpu::StencilState::default(),
//                 bias: wgpu::DepthBiasState::default(),
//             }),
//             multisample: wgpu::MultisampleState::default(),
//             multiview: None,
//             cache: None,
//         });

//         Self {
//             blade,
//             instance_buffer,
//             instance_count: instances.len() as u32,
//             render_pipeline,
//             uniform_buffer,
//             uniform_bind_group,
//         }
//     }

//     pub fn update_uniforms(&self, queue: &wgpu::Queue, time: f32, player_pos: Point3<f32>) {
//         let uniforms = GrassUniforms {
//             time,
//             _padding: [0.0,0.0,0.0],
//             player_pos: [player_pos.x, player_pos.y, player_pos.z, 0.0],
//         };
//         queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[uniforms]));
//     }
// }

use wgpu::util::DeviceExt;
use crate::core::{SimpleCamera::SimpleCamera, vertex::Vertex};
use crate::heightfield_landscapes::Landscape::Landscape;
use nalgebra::{Matrix4, Vector3, Point3};

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct GrassUniforms {
    time: f32,
    grid_size: f32,
    render_distance: f32,
    wind_strength: f32,
    
    player_pos: [f32; 4], // x, y, z, and unused w (16-byte aligned)
    
    wind_speed: f32,
    blade_height: f32,
    blade_width: f32,
    brownian_strength: f32,
    blade_density: f32, // NEW
    _pad0: [f32; 3],   // <---- Add padding to reach 64 bytes total
}

// Instead of per-blade instances, we'll use a simple grid vertex buffer
// The shader will generate blade positions procedurally
pub struct GrassBlade {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
}

impl GrassBlade {
    pub fn new(device: &wgpu::Device) -> Self {
        // A single blade mesh with more segments for better bending
        let segments = 5;
        let mut vertices = Vec::new();
        let mut indices = Vec::new();
        
        for i in 0..=segments {
            let y = (i as f32) / (segments as f32);
            let left_x = -0.5;
            let right_x = 0.5;
            
            vertices.push(Vertex {
                position: [left_x, y, 0.0],
                tex_coords: [0.0, 1.0 - y],
                normal: [0.0, 0.0, 1.0],
                color: [1.0, 1.0, 1.0, 1.0],
            });
            
            vertices.push(Vertex {
                position: [right_x, y, 0.0],
                tex_coords: [1.0, 1.0 - y],
                normal: [0.0, 0.0, 1.0],
                color: [1.0, 1.0, 1.0, 1.0],
            });
        }
        
        for i in 0..segments {
            let base = (i * 2) as u16;
            indices.extend_from_slice(&[
                base, base + 1, base + 2,
                base + 1, base + 3, base + 2,
            ]);
        }

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Grass Blade Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Grass Blade Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        Self {
            vertex_buffer,
            index_buffer,
            index_count: indices.len() as u32,
        }
    }
}

pub struct Grass {
    pub blade: GrassBlade,
    pub render_pipeline: wgpu::RenderPipeline,
    pub uniform_buffer: wgpu::Buffer,
    pub uniform_bind_group: wgpu::BindGroup,
    pub landscape_bind_group: wgpu::BindGroup,
    pub grid_size: f32,
    pub render_distance: f32,
    pub blade_density: u32, // Blades per grid cell
}

impl Grass {
    pub fn new(
        device: &wgpu::Device,
        camera_bind_group_layout: &wgpu::BindGroupLayout,
        landscape: &mut Landscape,
    ) -> Self {
        let blade = GrassBlade::new(device);
        let grid_size = 2.0; // Each grid cell is 2x2 units
        let render_distance = 50.0;
        let blade_density = 25; // 25 blades per grid cell

        // -- Uniforms --
        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Grass Uniform Buffer"),
            size: std::mem::size_of::<GrassUniforms>() as wgpu::BufferAddress,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let uniform_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
            label: Some("grass_uniform_bind_group_layout"),
        });

        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &uniform_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: Some("grass_uniform_bind_group"),
        });

        // Create landscape bind group for height sampling
        landscape.create_layout_for_particles(device);
        let landscape_bind_group = landscape.create_particle_bind_group(device);

        // Shaders
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Grass Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("grass.wgsl").into()),
        });

        // Render Pipeline
        let render_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Grass Render Pipeline Layout"),
            bind_group_layouts: &[
                camera_bind_group_layout,
                &uniform_bind_group_layout,
                &landscape.particle_bind_group_layout.as_ref().expect("Couldn't get landscape layout"), // Add landscape bind group
            ],
            push_constant_ranges: &[],
        });

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Grass Render Pipeline"),
            layout: Some(&render_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[Vertex::desc()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24Plus,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            blade,
            render_pipeline,
            uniform_buffer,
            uniform_bind_group,
            landscape_bind_group,
            grid_size,
            render_distance,
            blade_density,
        }
    }

    pub fn update_uniforms(&self, queue: &wgpu::Queue, time: f32, player_pos: Point3<f32>) {
        let uniforms = GrassUniforms {
            time,
            grid_size: self.grid_size,
            render_distance: self.render_distance,
            wind_strength: 0.3,
            player_pos: [player_pos.x, player_pos.y, player_pos.z, 0.0],
            wind_speed: 0.02, // slow
            blade_height: 2.5,
            blade_width: 0.03, // thin
            brownian_strength: 0.02,
            blade_density: self.blade_density as f32,
            _pad0: [0.0; 3],

        };
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[uniforms]));
    }

    pub fn render<'a>(&'a self, render_pass: &mut wgpu::RenderPass<'a>, camera_bind_group: &'a wgpu::BindGroup) {
        render_pass.set_pipeline(&self.render_pipeline);
        render_pass.set_bind_group(0, camera_bind_group, &[]);
        render_pass.set_bind_group(1, &self.uniform_bind_group, &[]);
        render_pass.set_bind_group(2, &self.landscape_bind_group, &[]);
        render_pass.set_vertex_buffer(0, self.blade.vertex_buffer.slice(..));
        render_pass.set_index_buffer(self.blade.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
        
        // Draw with instancing - the shader will handle culling and positioning
        let grid_cells = ((self.render_distance * 2.0) / self.grid_size).ceil() as u32;
        let total_instances = grid_cells * grid_cells * self.blade_density;
        
        render_pass.draw_indexed(0..self.blade.index_count, 0, 0..total_instances);
    }
}
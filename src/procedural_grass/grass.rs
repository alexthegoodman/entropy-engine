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
        // let blade_density = 25; // 25 blades per grid cell
        let blade_density = 50; // 25 blades per grid cell

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
                targets: &[
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm, // New target for PBR material
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                ],
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
            wind_strength: 0.1,
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
}